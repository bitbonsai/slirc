// Batch B client thread/reaction helpers: pure navigation and protocol rules, plus the read-only
// reaction projection. fake-indexeddb must load before the Dexie-backed modules.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { conversationId, reactionEventWins } from "@client/model.ts";

const { adminDeletesOverIrc, toggleCollapsedParent, threadAnnouncementDisplayText, threadForRoot, threadsUnderParent, nestedThreads, filterThreadPalette, clampThreadIndex, expandedThreadParent, threadTitleFromText, threadRootTextDiffers, threadGrantFromResponse, threadSourceUrl, threadAnnouncementText, threadRootContextText, threadOperationId, isHiddenThreadAnnouncement, enqueueThreadContext, isDuplicateQueueError } = await import("@client/threads.ts");
const { queuedTextFor } = await import("@client/drafts.ts");
const { displaySegments, textSegments } = await import("@client/render.ts");
const { messageLinkLabel } = await import("@client/navigation.ts");
const { serializeOperation, reactionTagMessage, validateMultiline, MAX_MULTILINE_BYTES } = await import("@client/protocol.ts");
const { reactionChips, reactionTooltip, DEFAULT_REACTIONS } = await import("@client/presentation.ts");
const { ClientDatabase } = await import("@client/db.ts");
const { createConversationProjection } = await import("@client/store.ts");

test("reaction tooltips list accounts, label self as you, and omit removed reactions", () => {
  const reactions = { m1: [{ emoji: "👍", count: 3, mine: true, accounts: ["Ada", "Ben", "ME"] }] };
  expect(reactionTooltip(reactions, "m1", "👍", "me")).toBe("👍 3 · Ada, Ben, and you");
  expect(reactionTooltip(reactions, "m1", "❤️", "me")).toBe("");
  expect(reactionTooltip(reactions, undefined, "👍", "me")).toBe("");
});

const dbs: InstanceType<typeof ClientDatabase>[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});

function open(accountId = "acct-actions") {
  const db = new ClientDatabase({ instance: "https://slirc.test", accountId, account: "alice" });
  dbs.push(db);
  return db;
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    channel: "#t-abc123",
    conversationId: conversationId("thread", "#t-abc123"),
    parent: "#dev-test",
    parentLabel: "dev-test",
    title: "A thread",
    root: "root-1",
    rootNick: "alice",
    rootText: "root text",
    rootTime: "2026-09-28T00:00:00.000Z",
    lastActivity: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reaction wire line: only a valid authorized target and a bounded emoji get through.
// ---------------------------------------------------------------------------

test("a reaction line carries both current and draft reply tags", () => {
  expect(reactionTagMessage("#dev-test", "m1", "👍", false)).toBe(
    "@+reply=m1;+draft/reply=m1;+draft/react=👍 TAGMSG #dev-test",
  );
  expect(reactionTagMessage("#dev-test", "m1", "👍", true)).toBe(
    "@+reply=m1;+draft/reply=m1;+draft/unreact=👍 TAGMSG #dev-test",
  );
  // Semicolons, spaces and backslashes are escaped, never emitted raw.
  expect(reactionTagMessage("#dev-test", "a;b\\c", "x y", false)).toBe(
    "@+reply=a\\:b\\\\c;+draft/reply=a\\:b\\\\c;+draft/react=x\\sy TAGMSG #dev-test",
  );
});

test("reaction injection and malformed values are refused", () => {
  expect(() => reactionTagMessage("#dev-test\r\nPRIVMSG #other", "m1", "👍", false)).toThrow("invalid reaction target");
  expect(() => reactionTagMessage("dev-test", "m1", "👍", false)).toThrow("invalid reaction target");
  expect(() => reactionTagMessage("#dev-test", "", "👍", false)).toThrow("invalid reaction message");
  expect(() => reactionTagMessage("#dev-test", "m 1", "👍", false)).toThrow("invalid reaction message");
  expect(() => reactionTagMessage("#dev-test", "m1", "", false)).toThrow("invalid reaction emoji");
  expect(() => reactionTagMessage("#dev-test", "m1", "ok\r\nPRIVMSG #other :hi", false)).toThrow("invalid reaction emoji");
  expect(DEFAULT_REACTIONS).toContain("👍");
});

test("reaction chips read committed summaries with the reader's own selection", () => {
  const reactions = { m1: [{ emoji: "👍", count: 2, mine: true, accounts: ["alice", "bob"] }] };
  expect(reactionChips(reactions, "m1")).toEqual([{ emoji: "👍", count: 2, mine: true }]);
  expect(reactionChips(reactions, "missing")).toEqual([]);
  expect(reactionChips(reactions, undefined)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Thread navigation: only the active parent expands, two rows then overflow.
// ---------------------------------------------------------------------------

test("threads group under a parent by activity, and the active parent is the only expander", () => {
  const threads = [grant({ channel: "#t-aaa111", lastActivity: 5 }), grant({ channel: "#t-ccc333", lastActivity: 9 }), grant({ channel: "#t-bbb222", lastActivity: 1 })];
  expect(threadsUnderParent(threads, "#DEV-TEST").map((thread) => thread.channel)).toEqual(["#t-ccc333", "#t-aaa111", "#t-bbb222"]);
  expect(threadsUnderParent(threads, "#other")).toEqual([]);

  expect(nestedThreads(threads, "#dev-test").shown.map((thread) => thread.channel)).toEqual(["#t-ccc333", "#t-aaa111"]);
  expect(nestedThreads(threads, "#dev-test").overflow).toBe(1);

  // A selected thread names its parent; a room is its own parent.
  expect(expandedThreadParent("#dev-test", "#dev-test")).toBe("#dev-test");
  expect(expandedThreadParent("#dev-test", "#t-ccc333")).toBe("#dev-test");
  expect(expandedThreadParent(undefined, "#dev-test")).toBe("#dev-test");
  expect(expandedThreadParent(undefined, undefined)).toBe("");
});

test("opening a message with an existing thread targets that thread", () => {
  const threads = [grant()];
  expect(threadForRoot(threads, "#dev-test", "root-1")?.channel).toBe("#t-abc123");
  expect(threadForRoot(threads, "#dev-test", "root-2")).toBeUndefined();
  expect(threadForRoot(threads, "#other", "root-1")).toBeUndefined();
  expect(threadForRoot(threads, "#dev-test", undefined)).toBeUndefined();
});

test("a thread title is one whitespace-collapsed line, clamped like the shipped client", () => {
  expect(threadTitleFromText("  hello   world  ")).toBe("hello world");
  expect(threadTitleFromText("x".repeat(120))).toHaveLength(60);
});

test("the intro root copy is hidden only when it duplicates the title after normalization", () => {
  expect(threadRootTextDiffers("hello world", "  hello\n  world ")).toBe(false);
  expect(threadRootTextDiffers("hello", "hello world")).toBe(true);
  expect(threadRootTextDiffers(undefined, "anything")).toBe(true);
  expect(threadRootTextDiffers("title", "")).toBe(true);
  // A truncated title keeps the full root context distinct.
  expect(threadRootTextDiffers("x".repeat(60), "x".repeat(200))).toBe(true);
});

test("a thread response is adopted only when it is well formed for the requested parent", () => {
  const body = { channel: "#t-abc123", parent: "#dev-test", root: "root-1", title: "T", rootNick: "alice", rootText: "text", rootTime: "2026-09-28T00:00:00.000Z", lastActivity: 7 };
  const adopted = threadGrantFromResponse(body, "#dev-test", "dev-test");
  expect(adopted?.channel).toBe("#t-abc123");
  expect(adopted?.parent).toBe("#dev-test");
  expect(adopted?.parentLabel).toBe("dev-test");
  expect(adopted?.lastActivity).toBe(7);
  // A fabricated or mismatched channel fails closed.
  expect(threadGrantFromResponse({ ...body, channel: "#not-a-thread" }, "#dev-test", "dev-test")).toBeNull();
  expect(threadGrantFromResponse({ ...body, channel: "#t-abc123", parent: "#other" }, "#dev-test", "dev-test")).toBeNull();
  expect(threadGrantFromResponse({ ...body, root: "" }, "#dev-test", "dev-test")).toBeNull();
  expect(threadGrantFromResponse(null, "#dev-test", "dev-test")).toBeNull();
});

// ---------------------------------------------------------------------------
// Reaction projection: committed rows only, counts and selection recomputed on read.
// ---------------------------------------------------------------------------

test("the projection renders committed reaction counts and only the reader's own selection", async () => {
  const db = open("acct-reaction-projection");
  const room = conversationId("room", "#reactions");
  await db.messages.put({ id: "row-1", conversationId: room, serverId: "m1", authorAccount: "bob", authorNick: "Bob", text: "hi", time: "2026-09-28T00:00:00.000Z", state: "confirmed" });
  await db.reactions.bulkPut([
    { conversationId: room, messageServerId: "m1", account: "alice", emoji: "👍" },
    { conversationId: room, messageServerId: "m1", account: "bob", emoji: "👍" },
    { conversationId: room, messageServerId: "m1", account: "bob", emoji: "🔥" },
    { conversationId: conversationId("room", "#other"), messageServerId: "m1", account: "alice", emoji: "👀" },
  ]);

  const projection = createConversationProjection(db);
  projection.select(room);
  const waitFor = async (check: () => boolean) => {
    const until = Date.now() + 2000;
    while (Date.now() < until) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
    throw new Error("timed out waiting for reactions");
  };
  await waitFor(() => !projection.view.get().loading && Object.keys(projection.view.get().reactions).length === 1);

  const chips = projection.view.get().reactions.m1!;
  expect(chips.find((chip) => chip.emoji === "👍")).toMatchObject({ count: 2, mine: true });
  expect(chips.find((chip) => chip.emoji === "🔥")).toMatchObject({ count: 1, mine: false });
  // Another conversation's reaction never leaks into this view.
  expect(projection.view.get().reactions.m1!.some((chip) => chip.emoji === "👀")).toBe(false);

  // A committed unreact updates the same projection; inactive rows are never counted.
  await db.applyBatch({
    conversationId: room,
    events: [{ type: "reaction", reaction: { conversationId: room, messageServerId: "m1", account: "alice", emoji: "👍", ordering: { source: "history", seq: 1, batch: "b1", time: "2026-09-29T00:00:00.000Z", eventId: "r1" } }, remove: true }],
    complete: true,
  });
  await waitFor(() => projection.view.get().reactions.m1!.find((chip) => chip.emoji === "👍")?.count === 1);
  expect(projection.view.get().reactions.m1!.find((chip) => chip.emoji === "👍")?.mine).toBe(false);
  projection.dispose();
});

test("equal-time history events in one batch obey batch order", () => {
  const time = "2026-09-28T00:00:00.000Z";
  const add = { source: "history" as const, seq: 0, batch: "b1", time, eventId: "e1" };
  const remove = { source: "history" as const, seq: 1, batch: "b1", time, eventId: "e2" };
  expect(reactionEventWins(remove, add)).toBe(true);
  expect(reactionEventWins(add, remove)).toBe(false);
});

test("equal-time live events obey arrival order and beat history", () => {
  const time = "2026-09-28T00:00:00.000Z";
  const live1 = { source: "live" as const, seq: 1, time, eventId: "l1" };
  const live2 = { source: "live" as const, seq: 2, time, eventId: "l2" };
  const history = { source: "history" as const, seq: 5, batch: "b1", time, eventId: "h1" };
  expect(reactionEventWins(live2, live1)).toBe(true);
  expect(reactionEventWins(live1, live2)).toBe(false);
  expect(reactionEventWins(live1, history)).toBe(true);
  expect(reactionEventWins(history, live1)).toBe(false);
});

// ---------------------------------------------------------------------------
// Thread source link and native context messages.
// ---------------------------------------------------------------------------

test("the thread source link is same-origin, keeps the msgid, and leaks no auth query", () => {
  const room = threadSourceUrl("room", "#dev-test", "", "m1");
  expect(room).toBe("/?room=%23dev-test&msg=m1");
  expect(room).not.toContain("pair");
  // A DM link names the DM's channel, the same for both people, never the copier's peer nick.
  const dm = threadSourceUrl("dm", "#dm-a-b", "eve", "m2");
  expect(dm).toBe("/?room=%23dm-a-b&msg=m2");
  expect(threadSourceUrl("dm", "#dm-a-b", "eve", "m2", true)).toBe("/?room=%23dm-a-b&msg=m2&thread=1");
  expect(dm).not.toContain("token");
});

test("thread context text matches the ordinary IRC shape", () => {
  expect(threadAnnouncementText("#t-abc123", "/?room=%23dev-test&msg=m1", "https://chat.example")).toBe("↳ thread #t-abc123 — https://chat.example/?room=%23dev-test&msg=m1");
  expect(threadAnnouncementText("#t-abc123", "/dm/eve?msg=m2", "https://chat.example")).toBe("↳ thread #t-abc123 — https://chat.example/dm/eve?msg=m2");
  expect(threadRootContextText("alice", "#dev-test", "root text")).toBe("↳ alice in #dev-test\nroot text");
  expect(threadRootContextText("alice", "@eve", "root text")).toBe("↳ alice in @eve\nroot text");
  expect(threadOperationId("announce", "#t-abc123")).toBe("thread-announce:#t-abc123");
  expect(threadOperationId("root", "#t-abc123")).toBe("thread-root:#t-abc123");
});

test("a thread grant keeps who created it", () => {
  const grant = threadGrantFromResponse({ channel: "#t-abc123", parent: "#dev-test", root: "m1", createdBy: "ahmed" }, "#dev-test", "dev-test");
  expect(grant?.createdBy).toBe("ahmed");
  expect(threadGrantFromResponse({ channel: "#t-abc123", parent: "#dev-test", root: "m1" }, "#dev-test", "dev-test")?.createdBy).toBe("");
});

test("an admin deletes over IRC in channels and their threads, and through the server elsewhere", () => {
  const threads = [
    { conversationId: "t-chan", parent: "#ai-guild" },
    { conversationId: "t-dm", parent: "#dm-ada-ben" },
    { conversationId: "t-group", parent: "#g-0123abcd" },
  ];
  expect(adminDeletesOverIrc({ conversationId: "r", wireTarget: "#ai-guild", kind: "room" }, threads)).toBe(true);
  expect(adminDeletesOverIrc({ conversationId: "t-chan", wireTarget: "#t-8b5084", kind: "thread" }, threads)).toBe(true);
  expect(adminDeletesOverIrc({ conversationId: "d", wireTarget: "#dm-ada-ben", kind: "dm" }, threads)).toBe(false);
  expect(adminDeletesOverIrc({ conversationId: "g", wireTarget: "#g-0123abcd", kind: "room" }, threads)).toBe(false);
  expect(adminDeletesOverIrc({ conversationId: "t-dm", wireTarget: "#t-aaaaaa", kind: "thread" }, threads)).toBe(false);
  expect(adminDeletesOverIrc({ conversationId: "t-group", wireTarget: "#t-bbbbbb", kind: "thread" }, threads)).toBe(false);
  // A thread this client cannot place, or no conversation at all, uses the server route.
  expect(adminDeletesOverIrc({ conversationId: "t-unknown", wireTarget: "#t-cccccc", kind: "thread" }, threads)).toBe(false);
  expect(adminDeletesOverIrc(undefined, threads)).toBe(false);
});

test("an announcement posted with a bare path shows as a link to the root message", () => {
  const origin = "https://chat.example";
  expect(threadAnnouncementDisplayText("↳ thread #t-abc123 — /?room=%23ai-guild&msg=zkc7n55mjx43iss4e6ss4umfas", origin)).toBe("↳ thread #t-abc123 — https://chat.example/?room=%23ai-guild&msg=zkc7n55mjx43iss4e6ss4umfas");
  expect(threadAnnouncementDisplayText("↳ thread #t-abc123 — /dm/eve?msg=m2", origin)).toBe("↳ thread #t-abc123 — https://chat.example/dm/eve?msg=m2");
  const segments = displaySegments(threadAnnouncementDisplayText("↳ thread #t-abc123 — /?room=%23ai-guild&msg=m1", origin), textSegments, (href) => messageLinkLabel(href, origin));
  expect(segments.find((segment) => segment.href)).toMatchObject({ href: "https://chat.example/?room=%23ai-guild&msg=m1", text: "View in #ai-guild", route: true });
  // Only message routes on this instance are rewritten; anything else stays as typed.
  for (const text of ["↳ thread #t-abc123 — //evil.example/x", "↳ thread #t-abc123 — /\\evil.example", "↳ thread #t-abc123 — /profile", "hello /?room=%23ai-guild&msg=m1", "↳ thread #t-abc123 — https://chat.example/?room=%23a&msg=m1"]) {
    expect(threadAnnouncementDisplayText(text, origin)).toBe(text);
  }
});

test("thread context is queued once per stable operation id, and failures are reported", async () => {
  const messages = new Map<string, unknown>();
  const operations = new Map<string, unknown>();
  const enqueued: string[] = [];
  const replies: (string | undefined)[] = [];
  const db = { messages: { get: async (id: string) => messages.get(id) }, operations: { get: async (id: string) => operations.get(id) } };
  const enqueue = async (send: { operation: { id: string } }) => {
    if (messages.has(send.operation.id)) throw Object.assign(new Error("Key already exists"), { name: "ConstraintError" });
    messages.set(send.operation.id, true);
    operations.set(send.operation.id, true);
    enqueued.push(send.operation.id);
    replies.push(send.operation.replyTo);
  };
  const common = { account: "alice", parentConversationId: "room-conv", parentDisplay: "#dev-test", channel: "#t-abc123", rootConversationId: "thread-conv", rootNick: "alice", rootText: "root text", rootServerId: "m1", sourceUrl: "/?room=%23dev-test&msg=m1", origin: "https://chat.example" };
  expect(await enqueueThreadContext({ db, enqueue, ...common })).toEqual({});
  expect(enqueued).toEqual(["thread-announce:#t-abc123", "thread-root:#t-abc123"]);
  expect(replies).toEqual(["m1", undefined]);
  // A repeated call after the rows exist enqueues nothing new.
  expect(await enqueueThreadContext({ db, enqueue, ...common })).toEqual({});
  expect(enqueued).toHaveLength(2);
  // A real enqueue failure is surfaced, not swallowed.
  const failing = await enqueueThreadContext({ db: { messages: { get: async () => undefined }, operations: { get: async () => undefined } }, enqueue: async () => { throw new Error("quota exceeded"); }, ...common });
  expect(failing.error).toContain("could not be queued");
  expect(isDuplicateQueueError(Object.assign(new Error("Key already exists"), { name: "ConstraintError" }))).toBe(true);
  expect(isDuplicateQueueError(new Error("quota exceeded"))).toBe(false);
});

test("thread announcement carries a persisted +reply tag alongside correlation", () => {
  const send = queuedTextFor("room-conv", "alice", { text: "thread announcement", revision: "r1" }, "thread-announce:#t-abc123", 1, undefined, undefined, "root-1");
  expect(send.message.replyTo).toBe("root-1");
  expect(send.operation.replyTo).toBe("root-1");
  expect(serializeOperation(send.operation, "#dev-test", false)).toEqual([
    "@+slirc/cid=thread-announce:#t-abc123;+reply=root-1 PRIVMSG #dev-test :thread announcement",
  ]);
  const multiline = { ...send.operation, text: "first\nsecond" };
  expect(serializeOperation(multiline, "#dev-test", true, () => "b1")[0]).toBe(
    "@+slirc/cid=thread-announce:#t-abc123;+reply=root-1 BATCH +b1 draft/multiline #dev-test",
  );
});

test("reply target survives outbox queue and own-message echo reconciliation", async () => {
  const db = open();
  const room = conversationId("room", "#dev-test");
  const send = queuedTextFor(room, "alice", { text: "announcement", revision: "r1" }, "thread-announce:#t-abc123", 1, undefined, undefined, "root-1");
  await db.queueText(send);
  expect((await db.messages.get(send.message.id))?.replyTo).toBe("root-1");
  await db.applyBatch({ conversationId: room, complete: true, events: [{ type: "message", message: { ...send.message, serverId: "announcement-1", state: "confirmed" } }] });
  expect((await db.messages.get(send.message.id))?.replyTo).toBe("root-1");
  expect((await db.operations.get(send.operation.id))?.replyTo).toBe("root-1");
  expect((await db.operations.get(send.operation.id))?.state).toBe("confirmed");
  db.close();
  dbs.splice(dbs.indexOf(db), 1);
  const reopened = new ClientDatabase({ instance: "https://slirc.test", accountId: "acct-actions", account: "alice" });
  dbs.push(reopened);
  expect((await reopened.messages.get(send.message.id))?.replyTo).toBe("root-1");
  expect((await reopened.operations.get(send.operation.id))?.replyTo).toBe("root-1");
});

test("hide only a matching authorized thread announcement with its loaded root", () => {
  const thread = grant({ root: "root-1" });
  const parent = { conversationId: "room-conv", wireTarget: "#dev-test", kind: "room" as const };
  const root = { id: "root-row", conversationId: "room-conv", serverId: "root-1", authorAccount: "alice", authorNick: "alice", text: "root", time: "2026-09-28T00:00:00.000Z", state: "confirmed" as const };
  const announcement = { ...root, id: "announcement", serverId: "announcement-1", clientId: threadOperationId("announce", thread.channel), text: "↳ thread", replyTo: "root-1" };
  expect(isHiddenThreadAnnouncement(announcement, [thread], [parent], [root, announcement])).toBe(true);
  expect(isHiddenThreadAnnouncement({ ...announcement, replyTo: "other" }, [thread], [parent], [root, announcement])).toBe(false);
  expect(isHiddenThreadAnnouncement({ ...announcement, clientId: undefined }, [thread], [parent], [root, announcement])).toBe(false);
  expect(isHiddenThreadAnnouncement(announcement, [], [parent], [root, announcement])).toBe(false);
  expect(isHiddenThreadAnnouncement(announcement, [thread], [parent], [announcement])).toBe(false);
  expect(isHiddenThreadAnnouncement({ ...announcement, state: "uncertain" }, [thread], [parent], [root, announcement])).toBe(false);
  expect(isHiddenThreadAnnouncement({ ...announcement, authorAccount: "bob" }, [thread], [parent], [root, announcement])).toBe(true);
});

test("multiline context lines are bounded and control-free", () => {
  expect(validateMultiline(["one", "two"]).ok).toBe(true);
  expect(validateMultiline(["one"]).ok).toBe(true);
  expect(validateMultiline([""]).ok).toBe(false);
  expect(validateMultiline(["bad\r"]).ok).toBe(false);
  expect(validateMultiline(["a".repeat(MAX_MULTILINE_BYTES + 1)]).ok).toBe(false);
});
test("a later timestamp wins regardless of origin", () => {
  const olderLive = { source: "live" as const, seq: 9, time: "2026-09-28T00:00:00.000Z", eventId: "a" };
  const newerHistory = { source: "history" as const, seq: 0, batch: "b1", time: "2026-09-28T00:00:01.000Z", eventId: "b" };
  expect(reactionEventWins(newerHistory, olderLive)).toBe(true);
  expect(reactionEventWins(olderLive, newerHistory)).toBe(false);
});

test("no ordering evidence cannot replace a known newer state; an exact replay is a no-op", () => {
  const known = { source: "live" as const, seq: 3, time: "2026-09-28T00:00:02.000Z", eventId: "k" };
  expect(reactionEventWins({ source: "history", seq: 0 }, known)).toBe(false);
  expect(reactionEventWins(undefined, known)).toBe(false);
  expect(reactionEventWins(undefined, undefined)).toBe(true);
  // The exact same event never changes state.
  expect(reactionEventWins({ ...known }, known)).toBe(false);
  // Two different history batches at the same time have no evidence to order them.
  const batchA = { source: "history" as const, seq: 1, batch: "a", time: "2026-09-28T00:00:02.000Z", eventId: "x" };
  const batchB = { source: "history" as const, seq: 1, batch: "b", time: "2026-09-28T00:00:02.000Z", eventId: "y" };
  expect(reactionEventWins(batchB, batchA)).toBe(false);
});

test("applyBatch applies equal-time add then remove in batch order and rejects a late replay", async () => {
  const db = open("acct-reaction-batch-order");
  const room = conversationId("room", "#ordertest");
  const time = "2026-09-28T00:00:00.000Z";
  const event = (eventId: string, remove: boolean, seq: number, at = time) => ({
    type: "reaction" as const,
    reaction: { conversationId: room, messageServerId: "m1", account: "alice", emoji: "👍", ordering: { source: "history" as const, seq, batch: "batchA", time: at, eventId } },
    remove,
  });
  await db.applyBatch({ conversationId: room, events: [event("e1", false, 0), event("e2", true, 1)], complete: true });
  let rows = await db.reactions.toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.active).toBe(false);
  // A replayed older event cannot resurrect the removed reaction.
  await db.applyBatch({ conversationId: room, events: [event("e0", false, 0)], complete: true });
  rows = await db.reactions.toArray();
  expect(rows[0]!.active).toBe(false);
  // A genuinely newer react applies again.
  await db.applyBatch({ conversationId: room, events: [event("e3", false, 0, "2026-09-28T00:00:01.000Z")], complete: true });
  rows = await db.reactions.toArray();
  expect(rows[0]!.active).toBe(true);
});

// ---------------------------------------------------------------------------
// Overflow thread palette: the list is the authorized rows of one parent, filtered by a
// case-insensitive query, and the highlight clamps instead of resetting on key navigation.
// ---------------------------------------------------------------------------

test("thread palette filters by title and channel and keeps the parent's authorized order", () => {
  const rows = [
    grant({ channel: "#t-aaa111", title: "Deploy notes", lastActivity: 3 }),
    grant({ channel: "#t-bbb222", title: "Lunch plans", lastActivity: 2 }),
    grant({ channel: "#t-ccc333", title: "Deploy rollback", lastActivity: 1 }),
    grant({ channel: "#t-other1", parent: "#elsewhere", title: "Deploy elsewhere" }),
  ];
  expect(filterThreadPalette(rows, "").map((row) => row.channel)).toEqual(["#t-aaa111", "#t-bbb222", "#t-ccc333", "#t-other1"]);
  expect(filterThreadPalette(rows, "deploy").map((row) => row.channel)).toEqual(["#t-aaa111", "#t-ccc333", "#t-other1"]);
  expect(filterThreadPalette(rows, "  DEPLOY  ").map((row) => row.channel)).toEqual(["#t-aaa111", "#t-ccc333", "#t-other1"]);
  expect(filterThreadPalette(rows, "#t-bbb222").map((row) => row.channel)).toEqual(["#t-bbb222"]);
  expect(filterThreadPalette(rows, "zzz")).toEqual([]);
});

test("thread palette selection clamps at both ends and only resets on a query change", () => {
  // Empty list stays at zero; a shorter list clamps down.
  expect(clampThreadIndex(0, 0)).toBe(0);
  expect(clampThreadIndex(5, 3)).toBe(2);
  expect(clampThreadIndex(-1, 3)).toBe(0);
  expect(clampThreadIndex(1, 3)).toBe(1);
});

test("a filtered thread list is a subset of threadsUnderParent, never another parent's rows", () => {
  const threads = [
    grant({ channel: "#t-aaa111", parent: "#dev-test" }),
    grant({ channel: "#t-bbb222", parent: "#dev-test" }),
    grant({ channel: "#t-ccc333", parent: "#dm-alice" }),
  ];
  const underParent = threadsUnderParent(threads, "#dev-test");
  const filtered = filterThreadPalette(underParent, "#t-aaa111");
  expect(filtered.map((row) => row.channel)).toEqual(["#t-aaa111"]);
  expect(filtered.every((row) => row.parent === "#dev-test")).toBe(true);
});

test("clicking the open channel again folds its threads, and again unfolds them", () => {
  const once = toggleCollapsedParent([], "#Dev-Test");
  expect(once).toEqual(["#dev-test"]);
  expect(toggleCollapsedParent(once, "#dev-test")).toEqual([]);
  expect(toggleCollapsedParent(["#other"], "#dev-test")).toEqual(["#other", "#dev-test"]);
});

test("a linked message older than the newest window loads with history before and after it", async () => {
  const db = open("acct-link-window");
  const room = conversationId("room", "#window");
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 0, minute)).toISOString();
  const row = (n: number) => ({ id: `row-${n}`, conversationId: room, serverId: `m${n}`, authorAccount: "bob", authorNick: "Bob", text: `message ${n}`, time: at(n), state: "confirmed" as const });
  await db.messages.bulkPut(Array.from({ length: 600 }, (_, n) => row(n)));

  const projection = createConversationProjection(db);
  projection.select(room, "m100");
  const until = Date.now() + 3000;
  while (projection.view.get().loading && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  const ids = new Set(projection.view.get().messages.map((message) => message.serverId));
  expect(ids.has("m100")).toBe(true);
  expect(ids.has("m99") && ids.has("m50")).toBe(true); // history before it
  expect(ids.has("m49")).toBe(false); // bounded
  expect(ids.has("m101") && ids.has("m299")).toBe(true); // a page after it
  expect(ids.has("m599")).toBe(true); // and the newest window
  projection.dispose();
});
