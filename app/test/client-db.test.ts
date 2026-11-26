import { afterEach, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { conversationId, foldIdentifier, scopeKey, type AccountScope, type CompleteBatch, type Message, type QueueText } from "../client/model.ts";

// Dexie captures its IndexedDB dependencies when its module is first evaluated. bun:test does not
// guarantee that the static fake-indexeddb/auto side effect runs first, so the Dexie-dependent
// modules load dynamically once the fake globals exist. model.ts has no such dependency.
const { ClientDatabase } = await import("../client/db.ts");
const { CONFIRMED_LIMIT, createConversationProjection } = await import("../client/store.ts");

const dbs: ClientDatabase[] = [];
let seq = 0;

// accountId is the opaque private-cache UUID; account is the IRC authenticated tag the DB folds.
function scope(accountId: string, instance = "https://slirc.test", account = "alice"): AccountScope {
  return { instance, accountId, account };
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
    operation: {
      id: operationId,
      messageId: msg.id,
      conversationId,
      kind: "text",
      text: msg.text,
      state: "queued",
      createdAt: 1_700_000_000_000,
    },
    draftRevision: "rev-1",
  };
}

function batch(conversationId: string, events: CompleteBatch["events"], checkpoint?: CompleteBatch["checkpoint"]): CompleteBatch {
  return { conversationId, events, complete: true, checkpoint };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for projection");
}

test("queueText commits message, operation, and the matching draft removal", async () => {
  const db = open(scope("acct-queue"));
  const room = conversationId("room", "#queue");
  await db.drafts.put({ conversationId: room, revision: "rev-1", text: "hello", updatedAt: 1 });
  const send = queuedSend(room);

  await db.queueText(send);

  expect(await db.messages.get(send.message.id)).toMatchObject({
    state: "queued",
    text: send.message.text,
    clientId: send.operation.id,
  });
  expect(await db.operations.get(send.operation.id)).toMatchObject({ messageId: send.message.id, state: "queued" });
  expect(await db.drafts.get(room)).toBeUndefined();
});

// Every queueText collision aborts the whole transaction and leaves existing rows untouched.
type Collision = {
  name: string;
  arrange: (db: ClientDatabase, room: string) => Promise<QueueText>;
  check: (db: ClientDatabase, room: string, send: QueueText) => Promise<void>;
};
const collisions: Collision[] = [
  {
    name: "an existing row identity is never overwritten",
    arrange: async (db, room) => {
      await db.messages.add(message({ conversationId: room, id: "local-1", state: "confirmed" }));
      return queuedSend(room, { id: "local-1" });
    },
    check: async (db, _room, send) => {
      expect(await db.messages.get("local-1")).toMatchObject({ state: "confirmed" });
      expect(await db.operations.get(send.operation.id)).toBeUndefined();
    },
  },
  {
    // A second row may not reuse an existing [conversationId+serverId], so Dexie aborts mid-write.
    name: "a reused serverId rolls back message, operation, and draft",
    arrange: async (db, room) => {
      await db.messages.put(message({ conversationId: room, id: "confirmed-1", serverId: "srv-1" }));
      await db.drafts.put({ conversationId: room, revision: "rev-1", text: "hello", updatedAt: 1 });
      return queuedSend(room, { serverId: "srv-1" });
    },
    check: async (db, room, send) => {
      expect(await db.messages.get(send.message.id)).toBeUndefined();
      expect(await db.operations.get(send.operation.id)).toBeUndefined();
      expect(await db.drafts.get(room)).toMatchObject({ revision: "rev-1" });
    },
  },
  {
    // Same operation id, unrelated message: the operation add must fail and roll the message back.
    name: "a pre-existing operation id rolls the message back",
    arrange: async (db, room) => {
      const send = queuedSend(room);
      await db.operations.add({ ...send.operation, messageId: "someone-else" });
      return send;
    },
    check: async (db, _room, send) => {
      expect(await db.messages.get(send.message.id)).toBeUndefined();
      expect(await db.operations.get(send.operation.id)).toMatchObject({ messageId: "someone-else" });
    },
  },
];

test.each(collisions)("queueText collision: $name", async ({ arrange, check }) => {
  const db = open(scope(`acct-collide-${++seq}`));
  const room = conversationId("room", "#collide");
  const send = await arrange(db, room);
  await expect(db.queueText(send)).rejects.toThrow();
  await check(db, room, send);
});

test("a confirmed own echo confirms the matching operation atomically", async () => {
  const db = open(scope("acct-merge"));
  const room = conversationId("room", "#merge");
  const send = queuedSend(room);
  await db.queueText(send);

  const echo = message({
    conversationId: room,
    id: "server-row",
    state: "confirmed",
    serverId: "srv-9",
    clientId: send.operation.id,
  });
  await db.applyBatch(batch(room, [{ type: "message", message: echo }]));

  const rows = await db.messages.where("conversationId").equals(room).toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(send.message.id); // local row identity survives the echo
  expect(rows[0]).toMatchObject({ serverId: "srv-9", state: "confirmed" });
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "confirmed" });
});

test("another account's correlation id cannot confirm the authenticated row", async () => {
  const db = open(scope("acct-cid"));
  const room = conversationId("room", "#cid");
  const send = queuedSend(room);
  await db.queueText(send);

  const spoof = message({
    conversationId: room,
    id: "spoof-row",
    state: "confirmed",
    serverId: "srv-spoof",
    authorAccount: "bob",
    authorNick: "Bob",
    clientId: send.operation.id,
  });
  await db.applyBatch(batch(room, [{ type: "message", message: spoof }]));

  expect(await db.messages.get("spoof-row")).toMatchObject({ state: "confirmed" });
  expect(await db.messages.get(send.message.id)).toMatchObject({ state: "queued" });
  expect(await db.operations.get(send.operation.id)).toMatchObject({ state: "queued" });
});

test("applyBatch dedupes other authors by serverId and never by equal text", async () => {
  const db = open(scope("acct-text"));
  const room = conversationId("room", "#text");
  const first = message({ conversationId: room, serverId: "srv-a", authorAccount: "bob", authorNick: "Bob", text: "same" });
  const duplicate = { ...first };
  const equalText = message({ conversationId: room, serverId: "srv-b", authorAccount: "bob", authorNick: "Bob", text: "same" });

  await db.applyBatch(batch(room, [
    { type: "message", message: first },
    { type: "message", message: duplicate },
    { type: "message", message: equalText },
  ]));

  const rows = await db.messages.where("conversationId").equals(room).toArray();
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.serverId).sort()).toEqual(["srv-a", "srv-b"]);
});

test("a failed batch leaves prior progress and no partial events", async () => {
  const db = open(scope("acct-batch"));
  const room = conversationId("room", "#batch");
  const first = message({ conversationId: room, serverId: "srv-1", authorAccount: "alice" });
  await db.applyBatch(batch(
    room,
    [{ type: "message", message: first }],
    { conversationId: room, serverId: first.serverId!, time: first.time },
  ));
  const applied = await db.progress.get(room);

  const good = message({ conversationId: room, serverId: "srv-2" });
  const conflictingAuthor = message({ conversationId: room, serverId: "srv-1", authorAccount: "bob", authorNick: "Bob" });
  await expect(db.applyBatch(batch(
    room,
    [{ type: "message", message: good }, { type: "message", message: conflictingAuthor }],
    { conversationId: room, serverId: good.serverId!, time: good.time },
  ))).rejects.toThrow();

  expect(await db.messages.get(good.id)).toBeUndefined();
  expect(await db.progress.get(room)).toEqual(applied);
});

test("applyBatch rejects incomplete batches and cross-conversation events", async () => {
  const db = open(scope("acct-reject"));
  const room = conversationId("room", "#reject");
  const other = conversationId("room", "#other");

  await expect(db.applyBatch({ conversationId: room, events: [], complete: false } as unknown as CompleteBatch)).rejects.toThrow();
  await expect(db.applyBatch(batch(
    room,
    [{ type: "message", message: message({ conversationId: other }) }],
  ))).rejects.toThrow();
  await expect(db.applyBatch(batch(room, [], { conversationId: room, serverId: "p", time: "2026-01-01T00:00:00Z" }))).rejects.toThrow();
});

test("an incoming id collision is refused, not overwritten", async () => {
  const db = open(scope("acct-collision"));
  const room = conversationId("room", "#collision");
  await db.messages.add(message({ conversationId: room, id: "shared-id", serverId: "srv-real", text: "original" }));

  const impostor = message({ conversationId: room, id: "shared-id", serverId: "srv-other", text: "impostor" });
  await expect(db.applyBatch(batch(room, [{ type: "message", message: impostor }]))).rejects.toThrow();

  expect(await db.messages.get("shared-id")).toMatchObject({ text: "original", serverId: "srv-real" });
});

test("an early redaction tombstone blocks delayed history resurrection", async () => {
  const db = open(scope("acct-tombstone"));
  const room = conversationId("room", "#tombstone");

  await db.applyBatch(batch(room, [{ type: "redaction", conversationId: room, serverId: "srv-gone" }]));
  expect(await db.tombstones.get([room, "srv-gone"])).toBeDefined();

  const delayed = message({ conversationId: room, serverId: "srv-gone" });
  await db.applyBatch(batch(room, [{ type: "message", message: delayed }]));

  expect(await db.messages.where("[conversationId+serverId]").equals([room, "srv-gone"]).count()).toBe(0);
  expect(await db.tombstones.get([room, "srv-gone"])).toBeDefined();
});

test("a redaction marks a present message deleted and keeps the tombstone", async () => {
  const db = open(scope("acct-deleted"));
  const room = conversationId("room", "#deleted");
  const live = message({ conversationId: room, serverId: "srv-del" });
  await db.applyBatch(batch(room, [{ type: "message", message: live }]));

  await db.applyBatch(batch(room, [{ type: "redaction", conversationId: room, serverId: "srv-del" }]));

  expect(await db.messages.get(live.id)).toMatchObject({ deleted: true });
  expect(await db.tombstones.get([room, "srv-del"])).toBeDefined();
});

// Deletion removes content from IndexedDB, not just from the render: the row keeps identity and a
// tombstone, the text/media reference is gone, a delayed history replay cannot restore it, and the
// projection never lists it.
test("a redaction removes content and a delayed replay cannot restore it", async () => {
  const db = open(scope("acct-content"));
  const room = conversationId("room", "#content");
  const live = message({ conversationId: room, serverId: "srv-media", text: "secret ![x](/uploads/abc123)" });
  await db.applyBatch(batch(room, [{ type: "message", message: live }]));

  const projection = createConversationProjection(db);
  projection.select(room);
  await waitFor(() => projection.view.get().messages.length === 1);

  await db.applyBatch(batch(room, [{ type: "redaction", conversationId: room, serverId: "srv-media" }]));
  const stored = await db.messages.get(live.id);
  expect(stored).toMatchObject({ deleted: true, text: "" });
  await waitFor(() => projection.view.get().messages.length === 0);

  // Ergo does not replay REDACT; a later history page with the same serverId must not resurrect it.
  await db.applyBatch(batch(room, [{ type: "message", message: { ...live, id: "late-copy" } }]));
  expect(await db.messages.get(live.id)).toMatchObject({ text: "", deleted: true });
  expect(projection.view.get().messages).toHaveLength(0);
  projection.dispose();
});

test("account comparison folds case with the scope mapping", async () => {
  const db = open(scope("acct-case", "https://slirc.test", "Alice"));
  const room = conversationId("room", "#case");
  expect(foldIdentifier("ALICE", "ascii")).toBe("alice");

  const send = queuedSend(room, { authorAccount: "alice" });
  await db.queueText(send); // queued as ALICE only because folded comparison accepts it
  expect(await db.messages.get(send.message.id)).toMatchObject({ authorAccount: "alice" });

  const upper = message({ conversationId: room, serverId: "srv-c", authorAccount: "BOB", authorNick: "Bob" });
  await db.applyBatch(batch(room, [
    { type: "message", message: upper },
    { type: "message", message: { ...upper, authorAccount: "bob", id: "second-row" } },
  ]));
  expect(await db.messages.where("conversationId").equals(room).count()).toBe(2); // queued + one deduped
});

test("account and instance origins never share a database", async () => {
  const room = conversationId("room", "#scope");
  const sameAccountOtherInstance = open(scope("acct-scope", "https://two.test"));
  const sameInstanceOtherAccount = open(scope("acct-other", "https://one.test"));
  const owner = open(scope("acct-scope", "https://one.test"));

  await owner.queueText(queuedSend(room));

  expect(await owner.messages.count()).toBe(1);
  expect(await sameAccountOtherInstance.messages.count()).toBe(0);
  expect(await sameInstanceOtherAccount.operations.count()).toBe(0);
});

test("a durable queued item survives closing and reopening the scope", async () => {
  const s = scope("acct-reopen");
  const room = conversationId("room", "#reopen");
  const first = open(s);
  const send = queuedSend(room);
  await first.queueText(send);
  await first.close();

  const second = open(s);
  const stored = await second.messages.get(send.message.id);
  expect(stored).toMatchObject({ state: "queued", text: send.message.text, conversationId: room });
  expect(await second.operations.get(send.operation.id)).toMatchObject({ messageId: send.message.id });
});

test("projection bounds confirmed history and keeps every pending row", async () => {
  const db = open(scope("acct-projection"));
  const room = conversationId("room", "#projection");
  const confirmed: Message[] = [];
  for (let i = 0; i < CONFIRMED_LIMIT + 5; i++) {
    confirmed.push(message({ conversationId: room, time: new Date(1_700_000_000_000 + i * 1000).toISOString() }));
  }
  await db.messages.bulkPut(confirmed);
  for (let i = 0; i < 3; i++) {
    const send = queuedSend(room);
    await db.messages.put({ ...send.message, state: i === 0 ? "uncertain" : "queued" });
  }

  const projection = createConversationProjection(db);
  projection.select(room);
  await waitFor(() => !projection.view.get().loading && projection.view.get().messages.length === CONFIRMED_LIMIT + 3);

  const view = projection.view.get();
  expect(view.conversationId).toBe(room);
  expect(view.messages.filter((m) => m.state === "confirmed")).toHaveLength(CONFIRMED_LIMIT);
  expect(view.messages.filter((m) => m.state !== "confirmed")).toHaveLength(3);
  projection.dispose();
});

test("focusing an old message adds a bounded window at that root and never resurrects a deleted one", async () => {
  const db = open(scope("acct-focus"));
  const room = conversationId("room", "#focus");
  const rows: Message[] = [];
  for (let i = 0; i < CONFIRMED_LIMIT + 10; i++) {
    rows.push(message({ conversationId: room, serverId: `srv-${i}`, time: new Date(1_700_000_000_000 + i * 1000).toISOString() }));
  }
  await db.messages.bulkPut(rows);

  const projection = createConversationProjection(db);
  projection.select(room, "srv-0");
  await waitFor(() => !projection.view.get().loading && projection.view.get().messages.some((m) => m.serverId === "srv-0"));
  const view = projection.view.get();
  // Both the newest window and the focused root are present, and the total stays bounded.
  expect(view.messages.some((m) => m.serverId === `srv-${CONFIRMED_LIMIT + 9}`)).toBe(true);
  expect(view.messages.filter((m) => m.state === "confirmed").length).toBeLessThanOrEqual(CONFIRMED_LIMIT * 2);

  // A redacted root is filtered, not re-fetched by serverId.
  await db.applyBatch(batch(room, [{ type: "redaction", conversationId: room, serverId: "srv-0" }]));
  await waitFor(() => !projection.view.get().messages.some((m) => m.serverId === "srv-0"));
  projection.dispose();
});

test("projection rereads committed records and drops a stale selection", async () => {
  const db = open(scope("acct-live"));
  const roomA = conversationId("room", "#a");
  const roomB = conversationId("room", "#b");
  await db.messages.bulkPut([
    message({ conversationId: roomA, text: "in a" }),
    message({ conversationId: roomB, text: "in b" }),
  ]);

  const projection = createConversationProjection(db);
  projection.select(roomA);
  projection.select(roomB); // abandoned before roomA's liveQuery could emit
  await waitFor(() => !projection.view.get().loading && projection.view.get().messages.length === 1);

  const later = message({ conversationId: roomB, text: "later" });
  await db.applyBatch(batch(roomB, [{ type: "message", message: later }]));
  await waitFor(() => projection.view.get().messages.length === 2);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const view = projection.view.get();
  expect(view.conversationId).toBe(roomB);
  expect(view.messages.every((m) => m.conversationId === roomB)).toBe(true);
  projection.dispose();
});

test("a read marker only moves forward", async () => {
  const db = open(scope("markers"));
  const room = conversationId("room", "#r");
  expect(await db.advanceReadMarker(room, "2026-09-27T10:00:05.000Z")).toBe(true);
  expect(await db.advanceReadMarker(room, "2026-09-27T10:00:01.000Z")).toBe(false);
  expect(await db.advanceReadMarker(room, "2026-09-27T10:00:05.000Z")).toBe(false);
  expect((await db.readMarkers.get(room))?.time).toBe("2026-09-27T10:00:05.000Z");
  expect(await db.advanceReadMarker(room, "2026-09-27T10:00:09.000Z")).toBe(true);
  expect((await db.readMarkers.get(room))?.time).toBe("2026-09-27T10:00:09.000Z");
  await expect(db.advanceReadMarker(room, "later")).rejects.toThrow();
});

test("version 3 opens an existing version 2 database with its rows intact", async () => {
  const { default: Dexie } = await import("dexie");
  const s = scope("upgrade-v2");
  const room = conversationId("room", "#r");
  const legacy = new Dexie(`slirc2-${scopeKey(s)}`);
  legacy.version(1).stores({
    conversations: "id, parentId",
    messages: "id, conversationId, [conversationId+time], &[conversationId+serverId], [conversationId+clientId]",
    operations: "id, messageId, conversationId",
    drafts: "conversationId",
    progress: "conversationId",
    reactions: "[conversationId+messageServerId+account+emoji]",
    tombstones: "[conversationId+serverId]",
  });
  legacy.version(2).stores({ mediaDrafts: "conversationId" });
  const row = message({ conversationId: room, serverId: "m1" });
  await legacy.table("messages").add(row);
  await legacy.table("drafts").put({ conversationId: room, revision: "r1", text: "kept", updatedAt: 1 });
  legacy.close();

  const db = open(s);
  expect(await db.messages.get(row.id)).toEqual(row);
  expect((await db.drafts.get(room))?.text).toBe("kept");
  expect(await db.readMarkers.count()).toBe(0);
  expect(await db.advanceReadMarker(room, row.time)).toBe(true);
});
