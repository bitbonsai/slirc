// Edit-feature regressions: own-author validation, the durable +draft/edit association across
// history order, the edit wire tags, and the redaction capability request.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import type { AccountScope, CompleteBatch, Message, Operation } from "@client/model.ts";

const { ClientDatabase } = await import("@client/db.ts");
const { canEditMessage, canDeleteMessage } = await import("@client/presentation.ts");
const { serializeOperation, OPTIONAL_CAPS, missingRequiredCaps, validateText, validateMultiline } = await import("@client/protocol.ts");
const { queuedTextFor } = await import("@client/drafts.ts");

const scope: AccountScope = { instance: "https://slirc.test", accountId: "acct-alice", account: "alice" };
const conversationId = JSON.stringify(["room", "#r"]);
const databases: ClientDatabase[] = [];
function open(): ClientDatabase {
  const db = new ClientDatabase(scope);
  databases.push(db);
  return db;
}
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });

function msg(serverId: string, text: string, options: { replaces?: string; account?: string; state?: Message["state"] } = {}): Message {
  const account = options.account ?? "alice";
  return {
    id: `local-${account}-${serverId}`, conversationId, serverId, authorAccount: account, authorNick: account,
    text, time: "2026-01-01T00:00:00.000Z", state: options.state ?? "confirmed",
    ...(options.replaces ? { replaces: options.replaces } : {}),
  };
}
function batch(...events: CompleteBatch["events"]): CompleteBatch {
  return { conversationId, complete: true, events };
}
async function row(db: ClientDatabase, serverId: string): Promise<Message | undefined> {
  return db.messages.where("[conversationId+serverId]").equals([conversationId, serverId]).first();
}

test("only the author's own confirmed message is editable", () => {
  expect(canEditMessage(msg("m1", "hi"), "alice")).toBe(true);
  expect(canEditMessage(msg("m1", "hi"), "bob")).toBe(false);
  expect(canEditMessage(msg("m1", "hi", { account: "bob" }), "alice")).toBe(false);
  expect(canEditMessage({ ...msg("m1", "hi"), serverId: undefined }, "alice")).toBe(false);
  expect(canEditMessage(msg("m1", "hi", { state: "queued" }), "alice")).toBe(false);
  expect(canEditMessage({ ...msg("m1", "hi"), deleted: true }, "alice")).toBe(false);
  expect(canEditMessage(null, "alice")).toBe(false);
});

test("the edit wire tags +draft/edit on the PRIVMSG or the multiline opener", () => {
  const operation = { id: "op1", messageId: "m1", conversationId, kind: "text", text: "edited", editOf: "old-msgid", state: "queued", createdAt: 1 } as unknown as Operation;
  expect(serializeOperation(operation, "#r", true)).toEqual([
    "@+slirc/cid=op1;+draft/edit=old-msgid PRIVMSG #r :edited",
  ]);
  const multiline = { ...operation, text: "one\ntwo" } as Operation;
  expect(serializeOperation(multiline, "#r", true, () => "B1")).toEqual([
    "@+slirc/cid=op1;+draft/edit=old-msgid BATCH +B1 draft/multiline #r",
    "@batch=B1 PRIVMSG #r :one",
    "@batch=B1 PRIVMSG #r :two",
    "BATCH -B1",
  ]);
  // A plain message carries no edit tag.
  expect(serializeOperation({ ...operation, editOf: undefined } as Operation, "#r", true)).toEqual(["@+slirc/cid=op1 PRIVMSG #r :edited"]);
});

test("draft/message-redaction is requested when offered, never required", () => {
  expect(OPTIONAL_CAPS).toContain("draft/message-redaction");
  expect(missingRequiredCaps([...OPTIONAL_CAPS])).not.toContain("draft/message-redaction");
  expect(missingRequiredCaps(["sasl"])).not.toContain("draft/message-redaction");
});

test("edit history hides original without confirming a pending delete", async () => {
  const db = open();
  await db.applyBatch(batch({ type: "message", message: msg("old", "original text") }));
  await db.queueRedact({ id: "r-pending", messageId: "", conversationId, kind: "redact", text: "", redactId: "old", state: "queued", createdAt: 1 });
  await db.applyBatch(batch({ type: "message", message: msg("new", "edited text", { replaces: "old" }) }));
  expect((await row(db, "old"))?.deleted).toBe(true);
  expect((await row(db, "new"))?.deleted).toBeFalsy();
  expect((await db.operations.get("r-pending"))?.state).toBe("queued");
});

test("a replacement that arrives before its original still hides it on replay", async () => {
  const db = open();
  await db.applyBatch(batch({ type: "message", message: msg("new", "edited text", { replaces: "old" }) }));
  await db.applyBatch(batch({ type: "message", message: msg("old", "original text") }));
  expect((await row(db, "old"))?.deleted).toBe(true);
  expect((await row(db, "new"))?.deleted).toBeFalsy();
});

test("a different author cannot tombstone someone else's message with +draft/edit", async () => {
  const db = open();
  await db.applyBatch(batch({ type: "message", message: msg("old", "alice original") }));
  await db.applyBatch(batch({ type: "message", message: msg("new", "bob claim", { replaces: "old", account: "bob" }) }));
  expect((await row(db, "old"))?.deleted).toBeFalsy();
});

test("delete is own-confirmed or server-declared admin, never inferred from a badge string", () => {
  const own = msg("m1", "hi");
  const foreign = msg("m2", "hi", { account: "bob" });
  expect(canDeleteMessage(own, "alice", false)).toBe(true);
  expect(canDeleteMessage(foreign, "alice", false)).toBe(false);
  expect(canDeleteMessage(foreign, "alice", true)).toBe(true);
  // An admin deletes a bot's post (updates, helpers) through the same moderation route as anyone's.
  expect(canDeleteMessage({ ...foreign, authorNick: "updates", authorAccount: "updates" }, "alice", true)).toBe(true);
  expect(canDeleteMessage({ ...foreign, state: "queued" }, "alice", true)).toBe(false);
  expect(canDeleteMessage({ ...foreign, serverId: undefined }, "alice", true)).toBe(false);
  expect(canDeleteMessage(null, "alice", true)).toBe(false);
});

test("a quote is multiline-valid and would fail single-line validation", () => {
  const quote = "> eve: hello world\nprior draft";
  expect(validateText(quote).ok).toBe(false);
  expect(validateMultiline(quote.split("\n")).ok).toBe(true);
});

test("a confirmed edit replacement atomically queues the original's redact", async () => {
  const db = open();
  await db.applyBatch(batch({ type: "message", message: msg("old", "original text") }));
  await db.queueText(queuedTextFor(conversationId, "alice", { text: "edited text", revision: "rev" }, "op-edit", 1, undefined, "old"));
  // The echo confirms our edit op, and the redact op must exist in the same commit.
  await db.applyBatch(batch({ type: "message", message: { ...msg("new", "edited text"), clientId: "op-edit", replaces: "old" } }));
  const redact = (await db.operations.toArray()).find((op) => op.kind === "redact" && op.redactId === "old");
  expect(redact?.state).toBe("queued");
  expect((await row(db, "old"))?.deleted).toBe(true);
  // A second confirmation must not enqueue a duplicate.
  await db.applyBatch(batch({ type: "message", message: { ...msg("new", "edited text"), clientId: "op-edit", replaces: "old" } }));
  expect((await db.operations.toArray()).filter((op) => op.kind === "redact" && op.redactId === "old")).toHaveLength(1);
});

test("a refused redact is marked failed once and never auto-retried", async () => {
  const db = open();
  const { createOutbox, SendRefusedError } = await import("@client/outbox.ts");
  const locks = { request: (_name: string, _opts: { mode: "exclusive" }, callback: () => Promise<void> | void) => Promise.resolve().then(callback) } as never;
  let attempts = 0;
  const box = createOutbox({
    db,
    transport: { async sendText() {}, async sendRedact() { attempts += 1; throw new SendRefusedError("message redaction not supported by this server"); } },
    isReady: () => true,
    locks,
    BroadcastChannelImpl: null,
    sweepMs: 0,
  });
  await box.start();
  await box.enqueueRedact({ id: "r-fail", messageId: "", conversationId, kind: "redact", text: "", redactId: "m1", reason: "deleted by author", state: "queued", createdAt: 1 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(attempts).toBe(1);
  expect((await db.operations.get("r-fail"))?.state).toBe("failed");
  // A later readiness nudge must not retry a failed redact.
  await box.notifyReady();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(attempts).toBe(1);
  box.stop();
});
