// H1 independent cross-boundary challenge (base d8feba4). One test per confirmed real gap,
// smallest repro, no source-text assertions. Navigation duplicates A's separate fix are omitted.
// Each test asserts the durable/security invariant, not the fix's shape, so A may reject, clamp,
// or merge as long as the wrong outcome cannot survive.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { isPrivateIp } from "../src/og.ts";
import { createGuardedLookup, type LookupFunction } from "../src/safe-fetch.ts";
import { conversationId, type AccountScope, type CompleteBatch, type Message, type QueueText } from "../client/model.ts";

// Dexie captures its IndexedDB globals at module-eval time; load it only after fake-indexeddb/auto.
const { ClientDatabase } = await import("../client/db.ts");

// ---------------------------------------------------------------------------
// SSRF classifier: non-global IPv6 ranges the current classifier misses.
// ---------------------------------------------------------------------------

test("local-use NAT64 64:ff9b:1::/48 is non-public", () => {
  // RFC 8215 reserves 64:ff9b:1::/48 for local-use translation. Its embedded IPv4 is not the
  // last 32 bits for every prefix length, so the current 64:ff9b::/96 rule neither classifies
  // the /48 as reserved nor finds the embedded address.
  expect(isPrivateIp("64:ff9b:1::5db8:d822")).toBe(true);
  expect(isPrivateIp("64:ff9b:1:a00:0:100:808:808")).toBe(true);
});

test("other reserved IPv6 ranges stay non-public", () => {
  expect(isPrivateIp("2001:2::1")).toBe(true); // 2001:2::/48 benchmarking, not globally routed
  expect(isPrivateIp("2001:10::1")).toBe(true); // 2001:10::/28 ORCHID
  expect(isPrivateIp("3fff::1")).toBe(true); // 3fff::/20 documentation
});

test("a mixed DNS answer with an unusable entry fails closed", async () => {
  // "Reject the whole answer when any entry is unusable" is the stated policy, but a non-address
  // entry is filtered out before the check, so a public record next to garbage still connects.
  const lookup = createGuardedLookup(async () => ["1.1.1.1", "not-an-ip"], (address) => !isPrivateIp(address));
  const result = await once(lookup, "mixed-invalid.test");
  expect(result.error?.message).toBe("blocked");
});

function once(lookup: LookupFunction, hostname: string) {
  return new Promise<{ error: Error | null; records?: { address: string; family: number }[] }>((resolve) => {
    lookup(hostname, { all: true }, (error, address) => {
      resolve({ error: error as Error | null, records: Array.isArray(address) ? address : undefined });
    });
  });
}

// ---------------------------------------------------------------------------
// Durable client database: own-echo correlation, checkpoints, tombstone ordering.
// ---------------------------------------------------------------------------

const dbs: ClientDatabase[] = [];
let seq = 0;

function scope(accountId: string): AccountScope {
  return { instance: "https://slirc.test", accountId, account: "alice" };
}

function open(s: AccountScope): ClientDatabase {
  const db = new ClientDatabase(s);
  dbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
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
    operation: { id: operationId, messageId: msg.id, conversationId, kind: "text", text: msg.text, state: "queued", createdAt: 1_700_000_000_000 },
    draftRevision: "rev-1",
  };
}

function batch(conversationId: string, events: CompleteBatch["events"], checkpoint?: CompleteBatch["checkpoint"]): CompleteBatch {
  return { conversationId, events, complete: true, checkpoint };
}

test("a clientId echo with different text must not confirm the queued content", async () => {
  const db = open(scope("acct-cid-text"));
  const room = conversationId("room", "#cid-text");
  const send = queuedSend(room); // text "hello"
  await db.queueText(send);

  // Same authenticated account and correlation id, but not the text we queued. clientId is a
  // correlation hint, never proof; merging must not confirm content we never persisted.
  const echo = message({ conversationId: room, id: "echo-row", state: "confirmed", serverId: "srv-cid", clientId: send.operation.id, text: "different" });
  try { await db.applyBatch(batch(room, [{ type: "message", message: echo }])); } catch { /* rejecting is an acceptable fix */ }

  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "queued" });
  expect(await db.messages.get(send.message.id)).toMatchObject({ text: "hello" });
});

test("a checkpoint cannot claim a record the batch did not apply", async () => {
  const db = open(scope("acct-checkpoint"));
  const room = conversationId("room", "#checkpoint");
  const applied = message({ conversationId: room, serverId: "srv-1", time: "2026-01-01T00:00:01Z" });

  try {
    await db.applyBatch(batch(room, [{ type: "message", message: applied }],
      { conversationId: room, serverId: "srv-999", time: "2030-01-01T00:00:00Z" }));
  } catch { /* rejecting an unapplied checkpoint is an acceptable fix */ }

  // Advancing past srv-999 would skip every record between it and the applied one on recovery.
  expect((await db.progress.get(room))?.serverId).not.toBe("srv-999");
});

test("a redaction before a pending send's echo still settles the operation and row", async () => {
  const db = open(scope("acct-tomb-echo"));
  const room = conversationId("room", "#tomb-echo");
  const send = queuedSend(room);
  await db.queueText(send);

  // The user redacts immediately: the tombstone lands before the server echo of our own send.
  await db.applyBatch(batch(room, [{ type: "redaction", conversationId: room, serverId: "srv-red" }]));
  const echo = message({ conversationId: room, id: "late-echo", state: "confirmed", serverId: "srv-red", clientId: send.operation.id });
  await db.applyBatch(batch(room, [{ type: "message", message: echo }]));

  // The send was accepted and then deleted; the operation must not stay queued (resent forever)
  // and the local row must reflect the redaction.
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "confirmed" });
  expect(await db.messages.get(send.message.id)).toMatchObject({ deleted: true });
});
