// Edits stay where the original was: live and history order, chains, an original older than the
// loaded window, a queued edit and folded reactions.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import type { AccountScope, CompleteBatch, Message, QueueText } from "@client/model.ts";

const { ClientDatabase } = await import("@client/db.ts");
const { CONFIRMED_LIMIT, createConversationProjection, countsAsUnread, foldEditedReactions } = await import("@client/store.ts");

const scope: AccountScope = { instance: "https://slirc.test", accountId: "acct-alice", account: "alice" };
const conversationId = JSON.stringify(["room", "#r"]);
const databases: InstanceType<typeof ClientDatabase>[] = [];
const projections: { dispose(): void }[] = [];
function open() {
  const db = new ClientDatabase(scope);
  databases.push(db);
  return db;
}
afterEach(async () => {
  for (const projection of projections.splice(0)) projection.dispose();
  for (const db of databases.splice(0)) await db.delete();
});

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
function msg(serverId: string, text: string, minute: number, options: { replaces?: string; account?: string } = {}): Message {
  const account = options.account ?? "alice";
  return {
    id: `srv-${serverId}`, conversationId, serverId, authorAccount: account, authorNick: account,
    text, time: at(minute), state: "confirmed", ...(options.replaces ? { replaces: options.replaces } : {}),
  };
}
const batch = (...messages: Message[]): CompleteBatch => ({ conversationId, complete: true, events: messages.map((message) => ({ type: "message" as const, message })) });

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function view(db: InstanceType<typeof ClientDatabase>, settle: (messages: Message[]) => boolean) {
  const projection = createConversationProjection(db);
  projections.push(projection);
  projection.select(conversationId);
  await waitFor(() => !projection.view.get().loading && settle(projection.view.get().messages));
  return projection.view.get();
}
const texts = (messages: Message[]) => messages.map((message) => message.text);

test("a live edit takes the original's place and time, marked edited", async () => {
  const db = open();
  await db.applyBatch(batch(msg("o", "first", 1), msg("x", "bob says", 2, { account: "bob" })));
  await db.applyBatch(batch(msg("n", "first, fixed", 3, { replaces: "o" })));
  const { messages } = await view(db, (rows) => rows.some((row) => row.text === "first, fixed"));
  expect(texts(messages)).toEqual(["first, fixed", "bob says"]);
  expect(messages[0]!.time).toBe(at(1));
  expect(messages[0]!.editedAt).toBe(at(3));
  expect(messages[1]!.editedAt).toBeUndefined();
});

test("history that replays the edit before its original still places it there", async () => {
  const db = open();
  await db.applyBatch(batch(msg("x", "bob says", 2, { account: "bob" }), msg("n", "first, fixed", 3, { replaces: "o" })));
  await db.applyBatch(batch(msg("o", "first", 1)));
  const { messages } = await view(db, (rows) => rows[0]?.text === "first, fixed");
  expect(texts(messages)).toEqual(["first, fixed", "bob says"]);
});

test("an edit of an edit stays in the first original's spot, in any arrival order", async () => {
  for (const order of [["o", "n1", "n2"], ["n2", "n1", "o"], ["n1", "n2", "o"]]) {
    const db = open();
    const rows: Record<string, Message> = {
      o: msg("o", "v1", 1), n1: msg("n1", "v2", 3, { replaces: "o" }), n2: msg("n2", "v3", 4, { replaces: "n1" }),
    };
    await db.applyBatch(batch(msg("x", "bob says", 2, { account: "bob" })));
    for (const id of order) await db.applyBatch(batch(rows[id]!));
    const { messages } = await view(db, (shown) => shown[0]?.text === "v3");
    expect(texts(messages)).toEqual(["v3", "bob says"]);
    expect(messages[0]!.time).toBe(at(1));
    expect(messages[0]!.chain).toEqual(["o", "n1"]);
    for (const projection of projections.splice(0)) projection.dispose();
    await databases.pop()!.delete();
  }
});

test("someone else's +draft/edit cannot move a message", async () => {
  const db = open();
  await db.applyBatch(batch(msg("o", "first", 1), msg("x", "bob says", 2, { account: "bob" })));
  await db.applyBatch(batch(msg("n", "spoof", 3, { replaces: "o", account: "mallory" })));
  const { messages } = await view(db, (rows) => rows.length === 3);
  expect(texts(messages)).toEqual(["first", "bob says", "spoof"]);
});

test("an edit whose original is older than the loaded window stays out of the bottom", async () => {
  const db = open();
  const newer = Array.from({ length: CONFIRMED_LIMIT }, (_, i) => msg(`m${i}`, `line ${i}`, 10 + i, { account: "bob" }));
  await db.applyBatch(batch(msg("o", "old", 1), ...newer));
  await db.applyBatch(batch(msg("n", "old, fixed", 10 + CONFIRMED_LIMIT, { replaces: "o" })));
  const { messages } = await view(db, (rows) => rows.length >= CONFIRMED_LIMIT - 1);
  expect(texts(messages)).not.toContain("old, fixed");
  expect(messages.at(-1)!.text).toBe(`line ${CONFIRMED_LIMIT - 1}`);
});

test("an edit whose original was never seen here falls back to its own time", async () => {
  const db = open();
  await db.applyBatch(batch(msg("x", "bob says", 2, { account: "bob" }), msg("n", "fixed", 3, { replaces: "gone" })));
  const { messages } = await view(db, (rows) => rows.length === 2);
  expect(texts(messages)).toEqual(["bob says", "fixed"]);
  expect(messages[1]!.editedAt).toBe(at(3));
});

test("a queued edit sits in the original's place while it sends", async () => {
  const db = open();
  await db.applyBatch(batch(msg("o", "first", 1), msg("x", "bob says", 2, { account: "bob" })));
  const send: QueueText = {
    message: { id: "q1", conversationId, authorAccount: "alice", authorNick: "alice", text: "first, fixed", time: at(5), state: "saving", clientId: "q1" },
    operation: { id: "q1", messageId: "q1", conversationId, kind: "text", text: "first, fixed", state: "queued", createdAt: Date.parse(at(5)), editOf: "o" },
    draftRevision: "r1",
    editOf: "o",
  };
  await db.queueText(send);
  const { messages } = await view(db, (rows) => rows.some((row) => row.text === "first, fixed"));
  expect(texts(messages)).toEqual(["first, fixed", "bob says"]);
});

test("an edit never counts as unread", () => {
  expect(countsAsUnread(msg("n", "fixed", 3, { replaces: "o", account: "bob" }), "alice")).toBe(false);
});

test("reactions given before an edit stay on the edited message, once per person", () => {
  const edited = { ...msg("n2", "v3", 4, { replaces: "n1" }), chain: ["o", "n1"] };
  const folded = foldEditedReactions({
    o: [{ emoji: "👍", count: 2, mine: true, accounts: ["alice", "bob"] }],
    n2: [{ emoji: "👍", count: 1, mine: false, accounts: ["Bob"] }, { emoji: "🔥", count: 1, mine: false, accounts: ["carol"] }],
  }, [edited]);
  expect(folded.n2).toEqual([
    { emoji: "👍", count: 2, mine: true, accounts: ["alice", "bob"] },
    { emoji: "🔥", count: 1, mine: false, accounts: ["carol"] },
  ]);
});

