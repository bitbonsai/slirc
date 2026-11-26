import { afterEach, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import {
  conversationId,
  type AccountScope,
  type CompleteBatch,
  type Message,
  type Operation,
  type QueueText,
} from "../client/model.ts";

// Dexie grabs its IndexedDB globals when its module first evaluates; load the Dexie-backed
// modules only after fake-indexeddb/auto has installed them. outbox.ts type-imports the database
// so it can load statically, but the database itself must come in dynamically.
const { ClientDatabase } = await import("../client/db.ts");
const { createOutbox, SendRefusedError } = await import("../client/outbox.ts");
import type { Outbox, OutboxLockManager } from "../client/outbox.ts";

const databases: ClientDatabase[] = [];
const openBoxes: Outbox[] = [];
let seq = 0;

function scope(accountId: string): AccountScope {
  seq += 1;
  return { instance: "https://slirc.test", accountId, account: "alice" };
}

function openDatabase(s: AccountScope): ClientDatabase {
  const db = new ClientDatabase(s);
  databases.push(db);
  return db;
}

afterEach(async () => {
  for (const box of openBoxes.splice(0)) box.stop();
  for (const db of databases.splice(0)) await db.delete();
});

function message(overrides: Partial<Message> & Pick<Message, "conversationId">): Message {
  seq += 1;
  return {
    id: `m-${seq}-${Math.random().toString(36).slice(2)}`,
    conversationId: overrides.conversationId,
    authorAccount: "alice",
    authorNick: "Alice",
    text: "hello",
    time: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    state: "confirmed",
    ...overrides,
  };
}

function queuedSend(conversationId: string, overrides: Partial<Message> = {}): QueueText {
  seq += 1;
  const operationId = `op-${seq}`;
  const msg = message({ conversationId, state: "saving", clientId: operationId, ...overrides });
  return {
    message: msg,
    operation: {
      id: operationId,
      messageId: msg.id,
      conversationId,
      kind: "text",
      text: msg.text,
      state: "queued",
      createdAt: 1_700_000_000_000 + seq,
    },
    draftRevision: "rev-1",
  };
}

function batch(conversationId: string, events: CompleteBatch["events"]): CompleteBatch {
  return { conversationId, events, complete: true };
}

function recorder() {
  const sent: string[] = [];
  return {
    sent,
    async sendText(operation: Operation): Promise<void> {
      sent.push(operation.id);
    },
  };
}

// Minimal exclusive Web Locks: one holder, FIFO waiters. `request` resolves when the callback's
// returned promise resolves, which is exactly when outbox.stop() releases the lock.
function fakeLocks(): OutboxLockManager {
  let held = false;
  const waiters: Array<() => void> = [];
  return {
    request(_name, _options, callback) {
      return new Promise<void>((resolve) => {
        const run = () => {
          held = true;
          void Promise.resolve()
            .then(callback)
            .finally(() => {
              held = false;
              const next = waiters.shift();
              if (next) next();
              resolve();
            });
        };
        if (held) waiters.push(run);
        else run();
      });
    },
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

function makeOutbox(
  db: ClientDatabase,
  transport: { sent: string[]; sendText(operation: Operation): Promise<void> },
  isReady: (conversationId: string) => boolean = () => true,
  locks: OutboxLockManager | null = fakeLocks(),
  extra: { onStalled?: (conversationIds: string[]) => void; sweepMs?: number } = {},
): Outbox {
  const box = createOutbox({ db, transport, isReady, locks, BroadcastChannelImpl: null, ...extra });
  openBoxes.push(box);
  return box;
}

test("enqueueText commits through db.queueText and never clears a newer draft", async () => {
  const db = openDatabase(scope("acct-newer-draft"));
  const room = conversationId("room", "#draft");
  await db.drafts.put({ conversationId: room, revision: "rev-2", text: "newer", updatedAt: 2 });
  const transport = recorder();
  const box = makeOutbox(db, transport);

  const send = queuedSend(room); // built from rev-1
  await box.enqueueText(send);

  expect(await db.messages.get(send.message.id)).toMatchObject({ state: "queued", text: "hello" });
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "queued" });
  expect(await db.drafts.get(room)).toMatchObject({ revision: "rev-2", text: "newer" });
});

test("a failed queueText rejects with no network send and no accepted row", async () => {
  const db = openDatabase(scope("acct-abort"));
  const room = conversationId("room", "#abort");
  await db.messages.add(message({ conversationId: room, id: "existing", serverId: "srv-1" }));
  const transport = recorder();
  const box = makeOutbox(db, transport);
  await box.start();

  const send = queuedSend(room, { serverId: "srv-1" }); // collides with the existing serverId
  await expect(box.enqueueText(send)).rejects.toThrow();

  expect(transport.sent).toEqual([]);
  expect(await db.messages.get(send.message.id)).toBeUndefined();
  expect(await db.operations.get(send.operation.id)).toBeUndefined();
});

test("queued work only leaves when injected readiness allows its conversation", async () => {
  const db = openDatabase(scope("acct-gate"));
  const room = conversationId("room", "#gate");
  const transport = recorder();
  const ready = new Set<string>();
  const box = makeOutbox(db, transport, (id) => ready.has(id));
  await box.start();

  const send = queuedSend(room);
  await box.enqueueText(send);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(transport.sent).toEqual([]);
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "queued" });

  // Readiness for another conversation is not enough.
  ready.add(conversationId("room", "#other"));
  await box.notifyReady();
  expect(transport.sent).toEqual([]);

  ready.add(room);
  await box.notifyReady();
  expect(transport.sent).toEqual([send.operation.id]);
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "sending" });
});

test("disconnect before echo is uncertain and never auto-retries", async () => {
  const db = openDatabase(scope("acct-disconnect"));
  const room = conversationId("room", "#disconnect");
  const transport = recorder();
  let ready = true;
  const box = makeOutbox(db, transport, () => ready);
  await box.start();

  const send = queuedSend(room);
  await box.enqueueText(send);
  await box.flush();
  expect(transport.sent).toEqual([send.operation.id]);

  ready = false;
  await box.onDisconnected();
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "uncertain" });
  expect(await db.messages.get(send.message.id)).toMatchObject({ state: "uncertain" });

  ready = true;
  await box.notifyReady();
  expect(transport.sent).toEqual([send.operation.id]); // uncertain is never replayed
});

test("a persisted sending op on takeover becomes uncertain, not replayed", async () => {
  const db = openDatabase(scope("acct-takeover"));
  const room = conversationId("room", "#takeover");
  const send = queuedSend(room);
  await db.queueText(send);
  // Simulate a crash after the pre-network transition but before any echo.
  await db.transaction("rw", db.operations, db.messages, async () => {
    await db.operations.put({ ...send.operation, state: "sending" });
    await db.messages.put({ ...send.message, state: "sending", clientId: send.operation.id });
  });

  const transport = recorder();
  const box = makeOutbox(db, transport);
  await box.start();

  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "uncertain" });
  await box.notifyReady();
  expect(transport.sent).toEqual([]);
});

test("a duplicate own echo confirms once and does not resend", async () => {
  const db = openDatabase(scope("acct-echo"));
  const room = conversationId("room", "#echo");
  const transport = recorder();
  const box = makeOutbox(db, transport);
  await box.start();

  const send = queuedSend(room);
  await box.enqueueText(send);
  await box.flush();

  const echo = message({
    conversationId: room,
    id: "echo-row",
    serverId: "srv-echo",
    clientId: send.operation.id,
    state: "confirmed",
  });
  await db.applyBatch(batch(room, [{ type: "message", message: echo }]));
  await db.applyBatch(batch(room, [{ type: "message", message: { ...echo } }]));

  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "confirmed" });
  expect(await db.messages.where("conversationId").equals(room).count()).toBe(1);
  await box.flush();
  expect(transport.sent).toEqual([send.operation.id]);
});

test("equal text with distinct ids are two sends, never merged", async () => {
  const db = openDatabase(scope("acct-equal-text"));
  const room = conversationId("room", "#equal");
  const transport = recorder();
  const box = makeOutbox(db, transport);
  await box.start();

  const first = queuedSend(room, { text: "same" });
  const second = queuedSend(room, { text: "same" });
  await box.enqueueText(first);
  await box.enqueueText(second);
  await box.flush();

  expect(transport.sent).toHaveLength(2);
  expect(new Set(transport.sent).size).toBe(2);
  expect(await db.messages.where("conversationId").equals(room).count()).toBe(2);
});

test("a late confirmation is never downgraded to uncertain", async () => {
  const db = openDatabase(scope("acct-late-echo"));
  const room = conversationId("room", "#late");
  let rejectSend: (error: unknown) => void = () => {};
  const gate = new Promise<void>((_resolve, reject) => {
    rejectSend = reject;
  });
  const sent: string[] = [];
  const transport = {
    sent,
    async sendText(operation: Operation) {
      sent.push(operation.id);
      await gate;
    },
  };
  const box = makeOutbox(db, transport);
  await box.start();

  const send = queuedSend(room);
  await box.enqueueText(send);
  const inFlight = box.flush();
  await waitFor(async () => (await db.operations.get(send.operation.id))?.state === "sending");

  // The echo lands while the transport call is still pending.
  await db.applyBatch(batch(room, [{
    type: "message",
    message: message({
      conversationId: room,
      id: "late-echo",
      serverId: "srv-late",
      clientId: send.operation.id,
      state: "confirmed",
    }),
  }]));
  rejectSend(new Error("socket closed after a possible write"));
  await inFlight;

  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "confirmed" });
  expect(await db.messages.get(send.message.id)).toMatchObject({ state: "confirmed" });
});

test("a proven refusal is failed, an ambiguous throw is uncertain", async () => {
  const db = openDatabase(scope("acct-refusal"));
  const room = conversationId("room", "#refusal");
  const sent: string[] = [];
  const transport = {
    sent,
    async sendText(operation: Operation) {
      sent.push(operation.id);
      if (operation.text === "refused") throw new SendRefusedError("cannot send to channel");
      throw new Error("connection reset");
    },
  };
  const box = makeOutbox(db, transport);
  await box.start();

  const refused = queuedSend(room, { text: "refused" });
  const ambiguous = queuedSend(room, { text: "ambiguous" });
  await box.enqueueText(refused);
  await box.flush();
  expect(await db.operations.get(refused.operation.id)).toMatchObject({ state: "failed" });

  await box.enqueueText(ambiguous);
  await box.flush();
  expect(await db.operations.get(ambiguous.operation.id)).toMatchObject({ state: "uncertain" });
});

test("two lock contenders: only the holder sends, takeover re-reads the database", async () => {
  const db = openDatabase(scope("acct-locks"));
  const room = conversationId("room", "#locks");
  const locks = fakeLocks();
  const aTransport = recorder();
  const bTransport = recorder();
  const boxA = makeOutbox(db, aTransport, () => true, locks);
  const boxB = makeOutbox(db, bTransport, () => true, locks);

  await boxA.start();
  const bAcquire = boxB.start(); // queued behind boxA
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(boxB.status().owner).toBe(false);

  const first = queuedSend(room);
  await boxA.enqueueText(first);
  await boxA.flush();
  expect(aTransport.sent).toEqual([first.operation.id]);
  expect(bTransport.sent).toEqual([]);

  boxA.stop();
  await bAcquire;
  expect(boxB.status().owner).toBe(true);
  // The first op was `sending` when boxA stopped; takeover must mark it uncertain, not resend.
  expect(await db.operations.get(first.operation.id)).toMatchObject({ state: "uncertain" });
  expect(bTransport.sent).toEqual([]);

  await boxB.notifyReady();
  const second = queuedSend(room);
  await boxB.enqueueText(second);
  await boxB.flush();
  expect(bTransport.sent).toEqual([second.operation.id]);
  expect(aTransport.sent).toEqual([first.operation.id]);
});

test("resendUncertain needs readiness and duplicate-risk consent", async () => {
  const db = openDatabase(scope("acct-resend"));
  const room = conversationId("room", "#resend");
  const transport = recorder();
  let ready = true;
  const box = makeOutbox(db, transport, () => ready);
  await box.start();

  const send = queuedSend(room);
  await box.enqueueText(send);
  await box.flush();
  ready = false;
  await box.onDisconnected();
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "uncertain" });

  await expect(box.resendUncertain(send.operation.id, { duplicateRiskAccepted: false })).rejects.toThrow(
    /consent/,
  );
  await expect(box.resendUncertain(send.operation.id, { duplicateRiskAccepted: true })).rejects.toThrow(
    /recovery/,
  );

  ready = true;
  await box.notifyReady();
  await box.resendUncertain(send.operation.id, { duplicateRiskAccepted: true });
  expect(transport.sent).toEqual([send.operation.id, send.operation.id]);
});

test("cancel leaves the text in a failed row and sends nothing", async () => {
  const db = openDatabase(scope("acct-cancel"));
  const room = conversationId("room", "#cancel");
  const transport = recorder();
  let ready = false;
  const box = makeOutbox(db, transport, () => ready);
  await box.start();

  const send = queuedSend(room);
  await box.enqueueText(send);
  await box.cancel(send.operation.id);

  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "failed", text: "hello" });
  expect(await db.messages.get(send.message.id)).toMatchObject({ state: "failed", text: "hello" });
  ready = true;
  await box.notifyReady();
  expect(transport.sent).toEqual([]);
});

test("readiness lost during the durable claim prevents the wire write", async () => {
  const db = openDatabase(scope("acct-claim-race"));
  const transport = recorder();
  let reads = 0;
  const box = makeOutbox(db, transport, () => ++reads === 1);
  await box.start();
  const send = queuedSend(conversationId("room", "#race"));
  await box.enqueueText(send);
  await box.flush();
  expect(transport.sent).toEqual([]);
  expect((await db.operations.get(send.operation.id))?.state).toBe("uncertain");
});

test("follower disconnect cannot downgrade the holder's send; cancel cannot claim non-delivery", async () => {
  const db = openDatabase(scope("acct-follower"));
  const locks = fakeLocks();
  const box = makeOutbox(db, recorder(), () => true, locks);
  const follower = makeOutbox(db, recorder(), () => true, locks);
  await box.start();
  const waiting = follower.start();
  const send = queuedSend(conversationId("room", "#follower"));
  await box.enqueueText(send);
  await box.flush();
  await follower.onDisconnected();
  expect((await db.operations.get(send.operation.id))?.state).toBe("sending");
  await box.cancel(send.operation.id);
  expect((await db.operations.get(send.operation.id))?.state).toBe("uncertain");
  follower.stop();
  box.stop();
  await waiting;
});

test("a rejected lock request disables sending without hanging startup", async () => {
  const db = openDatabase(scope("acct-lock-error"));
  const box = makeOutbox(db, recorder(), () => true, { request: async () => { throw new Error("lock denied"); } });
  await box.start();
  expect(box.status()).toMatchObject({ owner: false, sendingEnabled: false, reason: "lock denied" });
});

test("a follower enqueue reaches the wire on the owner's sweep when no nudge arrives", async () => {
  const db = openDatabase(scope("acct-sweep"));
  const room = conversationId("room", "#sweep");
  const locks = fakeLocks();
  const ownerTransport = recorder();
  const followerTransport = recorder();
  // The follower has no BroadcastChannel, so the only path to the owner is its durable sweep.
  const owner = makeOutbox(db, ownerTransport, () => true, locks, { sweepMs: 10 });
  const follower = makeOutbox(db, followerTransport, () => true, locks);
  await owner.start();
  const waiting = follower.start();
  expect(owner.status().owner).toBe(true);
  expect(follower.status().owner).toBe(false);

  const send = queuedSend(room);
  await follower.enqueueText(send); // no nudge, no notifyReady: only the sweep can wake the owner
  await waitFor(() => ownerTransport.sent.includes(send.operation.id));
  expect(ownerTransport.sent).toEqual([send.operation.id]);
  expect(followerTransport.sent).toEqual([]);
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "sending" });
  follower.stop();
  owner.stop();
  await waiting;
});

test("a queued op for an unknown conversation signals recovery instead of sending", async () => {
  const db = openDatabase(scope("acct-stalled"));
  const room = conversationId("room", "#stalled");
  const transport = recorder();
  const stalled: string[][] = [];
  let ready = false;
  const box = makeOutbox(db, transport, () => ready, fakeLocks(), {
    sweepMs: 0,
    onStalled: (ids) => stalled.push(ids),
  });
  await box.start();

  const send = queuedSend(room);
  await box.enqueueText(send);
  await waitFor(() => stalled.length > 0);
  expect(stalled[0]).toEqual([room]);
  expect(transport.sent).toEqual([]);
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "queued" });

  // Once the page has discovered and joined the conversation, the same op sends exactly once.
  ready = true;
  await box.notifyReady();
  expect(transport.sent).toEqual([send.operation.id]);
});

test("without Web Locks sending is disabled with an explicit reason", async () => {
  const db = openDatabase(scope("acct-no-locks"));
  const room = conversationId("room", "#nolocks");
  const transport = recorder();
  const box = makeOutbox(db, transport, () => true, null);
  await box.start();

  expect(box.status()).toMatchObject({ owner: false, sendingEnabled: false });
  expect(box.status().reason).toMatch(/Web Locks/);

  await box.enqueueText(queuedSend(room));
  await box.notifyReady();
  await box.flush();
  expect(transport.sent).toEqual([]);
});

test("an IRC refusal fails the in-flight redact and leaves other operations alone", async () => {
  const db = openDatabase(scope("acct-redact-refused"));
  const room = conversationId("room", "#refused");
  const sent: string[] = [];
  let redacts = 0;
  const box = makeOutbox(db, {
    sent,
    async sendText() {},
    async sendRedact() { redacts += 1; },
  });
  await box.start();
  await box.enqueueRedact({ id: "redact-refused", messageId: "", conversationId: room, kind: "redact", text: "", redactId: "srv-9", reason: "deleted by admin", state: "queued", createdAt: 1 });
  await waitFor(() => redacts === 1);
  await box.rejectRedact("srv-other", "nope");
  expect((await db.operations.get("redact-refused"))?.state).toBe("sending");
  await box.rejectRedact("srv-9", "You are not authorized to delete this message");
  const operation = await db.operations.get("redact-refused");
  expect(operation?.state).toBe("failed");
  expect(operation?.error).toBe("You are not authorized to delete this message");
  box.stop();
});

test("a queued redact transmits via sendRedact and a live REDACT settles it, never the row", async () => {
  const db = openDatabase(scope("acct-redact"));
  const room = conversationId("room", "#redact");
  const sent: string[] = [];
  let redacts = 0;
  const box = makeOutbox(db, {
    sent,
    async sendText() {},
    async sendRedact(operation) { redacts += 1; sent.push(`R:${operation.redactId}`); },
  });
  await box.start();
  const operation: Operation = { id: "redact-1", messageId: "", conversationId: room, kind: "redact", text: "", redactId: "srv-1", reason: "deleted by author", state: "queued", createdAt: 1 };
  await box.enqueueRedact(operation);
  await waitFor(() => redacts === 1);
  // Transmitted but not confirmed: no echo yet, and the local row is untouched by the op.
  expect((await db.operations.get("redact-1"))?.state).toBe("sending");
  // The live REDACT is what settles the op and tombstones the target.
  await db.applyBatch({ conversationId: room, complete: true, events: [{ type: "redaction", conversationId: room, serverId: "srv-1" }] });
  expect((await db.operations.get("redact-1"))?.state).toBe("confirmed");
  const tombstone = await db.tombstones.get([room, "srv-1"]);
  expect(tombstone).toBeTruthy();
  box.stop();
});
