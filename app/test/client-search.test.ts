// Channel search (v1) tests: query parsing, matching, safe snippet segments, Dexie & Notes search,
// sync loadOlder (CHATHISTORY BEFORE), and shortcuts.
import { afterEach, expect, test } from "bun:test";
import "fake-indexeddb/auto";

import type { Message } from "../client/model.ts";
const { ClientDatabase } = await import("../client/db.ts");
const { conversationId } = await import("../client/model.ts");
const { createSyncEngine } = await import("../client/sync.ts");
const {
  SEARCH_RESULT_LIMIT,
  buildSnippetSegments,
  isChannelSearchShortcut,
  parseSearchQuery,
  searchConversation,
  searchMessages,
  searchNotes,
  shortenUrls,
} = await import("../client/search.ts");
const { threadOperationId } = await import("../client/threads.ts");

const dbs: InstanceType<typeof ClientDatabase>[] = [];

function openDb(accountId: string) {
  const db = new ClientDatabase({ instance: "https://slirc.test", accountId, account: "alice" });
  dbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});

function makeMessage(overrides: Partial<Message> & { id: string; conversationId: string; text: string; time: string }): Message {
  return {
    serverId: overrides.id,
    authorAccount: "alice",
    authorNick: "alice",
    state: "confirmed",
    ...overrides,
  };
}

test("parseSearchQuery extracts from:nick / from:@nick and case-insensitive multi-word terms", () => {
  expect(parseSearchQuery("")).toEqual({ from: null, terms: [] });
  expect(parseSearchQuery("   ")).toEqual({ from: null, terms: [] });
  expect(parseSearchQuery("Hello World")).toEqual({ from: null, terms: ["hello", "world"] });
  expect(parseSearchQuery("from:Alice deploy plan")).toEqual({ from: "alice", terms: ["deploy", "plan"] });
  expect(parseSearchQuery("deploy from:@Bob now")).toEqual({ from: "bob", terms: ["deploy", "now"] });
  expect(parseSearchQuery("from: from:@")).toEqual({ from: null, terms: [] });
});

test("buildSnippetSegments builds plain-text segments centered on first match with no HTML", () => {
  const segs = buildSnippetSegments("Check <script>alert(1)</script> deploy status", ["deploy"]);
  expect(segs).toEqual([
    { text: "Check <script>alert(1)</script> ", hit: false },
    { text: "deploy", hit: true },
    { text: " status", hit: false },
  ]);

  // Long message centers around the first match with ellipses.
  const prefix = "a ".repeat(60);
  const suffix = "b ".repeat(60);
  const centered = buildSnippetSegments(`${prefix}needle${suffix}`, ["needle"], 60);
  expect(centered.some((s) => s.hit && s.text === "needle")).toBe(true);
  expect(centered[0]!.text.startsWith("…")).toBe(true);
  expect(centered[centered.length - 1]!.text.endsWith("…")).toBe(true);

  // Overlapping terms merge cleanly.
  const merged = buildSnippetSegments("foobar baz", ["foo", "oobar"]);
  expect(merged).toEqual([
    { text: "foobar", hit: true },
    { text: " baz", hit: false },
  ]);

  // No terms (e.g. from:alice only) returns the full trimmed message.
  const noTerms = buildSnippetSegments("hello\n  world", []);
  expect(noTerms).toEqual([{ text: "hello\n  world", hit: false }]);
});

test("searchMessages filters deleted, hidden thread announcements, daily greetings, respects at ?? time and cap", () => {
  const room = conversationId("room", "#general");
  const base = Date.parse("2026-11-24T10:00:00.000Z");
  const ts = (offsetSec: number) => new Date(base + offsetSec * 1000).toISOString();

  const root = makeMessage({ id: "m-root", conversationId: room, serverId: "s-root", text: "deploy root", time: ts(10) });
  const announce = makeMessage({
    id: "m-ann",
    conversationId: room,
    serverId: "s-ann",
    clientId: threadOperationId("announce", "#t-1"),
    replyTo: "s-root",
    text: "Started a thread: deploy root",
    time: ts(11),
  });
  const deleted = makeMessage({ id: "m-del", conversationId: room, serverId: "s-del", text: "deploy deleted", time: ts(12), deleted: true });
  const greeting = makeMessage({
    id: "m-greet",
    conversationId: room,
    serverId: "s-greet",
    authorAccount: "welcome",
    authorNick: "welcome",
    text: "[Giphy: deploy gday] https://media.giphy.com/x.gif",
    time: ts(13),
  });
  // Edited later at ts(50), but original time `at` is ts(5), so it sorts older than root at ts(10).
  const edited = makeMessage({
    id: "m-edit",
    conversationId: room,
    serverId: "s-edit",
    authorAccount: "bob",
    authorNick: "bob",
    text: "deploy edited",
    time: ts(50),
    at: ts(5),
    replaces: "s-orig",
  });

  const threads = [{ conversationId: conversationId("thread", "#t-1"), channel: "#t-1", parent: "#general", parentLabel: "#general", root: "s-root", title: "deploy root" }];
  const conversations = [{ conversationId: room, wireTarget: "#general", kind: "room" as const }];
  const rows = [root, announce, deleted, greeting, edited];

  const off = searchMessages(rows, "deploy", { threads, conversations, greeting: false });
  expect(off.total).toBe(2);
  expect(off.hits.map((h) => h.focusId)).toEqual(["s-root", "s-edit"]);

  const on = searchMessages(rows, "deploy", { threads, conversations, greeting: true });
  expect(on.total).toBe(3);
  expect(on.hits.map((h) => h.focusId)).toEqual(["s-greet", "s-root", "s-edit"]);

  const fromBob = searchMessages(rows, "from:@bob deploy", { threads, conversations, greeting: false });
  expect(fromBob.total).toBe(1);
  expect(fromBob.hits[0]!.focusId).toBe("s-edit");

  // Result cap at SEARCH_RESULT_LIMIT (50) while total reports full count.
  const many = Array.from({ length: SEARCH_RESULT_LIMIT + 12 }, (_, i) =>
    makeMessage({ id: `m-${i}`, conversationId: room, serverId: `s-${i}`, text: `match item ${i}`, time: ts(i) }),
  );
  const capped = searchMessages(many, "match");
  expect(capped.total).toBe(SEARCH_RESULT_LIMIT + 12);
  expect(capped.hits).toHaveLength(SEARCH_RESULT_LIMIT);
  expect(capped.hits[0]!.focusId).toBe(`s-${SEARCH_RESULT_LIMIT + 11}`);
});

test("searchConversation reads from Dexie and searchNotes searches Notes", async () => {
  const db = openDb("acct-search");
  const room = conversationId("room", "#search");
  const other = conversationId("room", "#other");
  await db.messages.bulkPut([
    makeMessage({ id: "m1", conversationId: room, serverId: "s1", text: "alpha beta", time: "2026-11-24T10:00:00.000Z" }),
    makeMessage({ id: "m2", conversationId: room, serverId: "s2", text: "alpha gamma", time: "2026-11-24T10:01:00.000Z" }),
    makeMessage({ id: "m3", conversationId: other, serverId: "s3", text: "alpha beta", time: "2026-11-24T10:02:00.000Z" }),
  ]);

  const res = await searchConversation(db, room, "beta alpha");
  expect(res.total).toBe(1);
  expect(res.hits[0]!.focusId).toBe("s1");

  const notes = [
    { id: "n1", body: "buy coffee beans", createdAt: Date.parse("2026-11-24T09:00:00.000Z"), updatedAt: Date.parse("2026-11-24T09:00:00.000Z") },
    { id: "n2", body: "ship channel search", createdAt: Date.parse("2026-11-24T11:00:00.000Z"), updatedAt: Date.parse("2026-11-24T11:00:00.000Z") },
  ];
  const noteRes = searchNotes(notes, "alice", "alice", "coffee");
  expect(noteRes.total).toBe(1);
  expect(noteRes.hits[0]!.focusId).toBe("n1");
  expect(noteRes.hits[0]!.id).toBe("note-n1");
});

test("sync loadOlder pages CHATHISTORY BEFORE without regressing forward progress, serializes requests, and tracks exhausted", async () => {
  const db = openDb("acct-sync-older");
  const room = conversationId("room", "#history");
  const sent: string[] = [];
  const engine = createSyncEngine({
    db,
    send: (line) => { sent.push(line); return true; },
    pageLimit: 2,
    namesProbeMs: 0,
  });

  engine.recover([{ conversationId: room, wireTarget: "#history", kind: "room" }]);
  engine.push(":ergo 001 alice :welcome\r\n");
  engine.push(":alice!u@h JOIN #history\r\n");
  await engine.whenIdle();

  // Initial LATEST returns 2 messages (newest).
  engine.push(
    "BATCH +h1 chathistory #history\r\n" +
    "@batch=h1;msgid=m3;time=2026-11-24T10:03:00.000Z;account=alice :alice!u@h PRIVMSG #history :third\r\n" +
    "@batch=h1;msgid=m4;time=2026-11-24T10:04:00.000Z;account=alice :alice!u@h PRIVMSG #history :fourth\r\n" +
    "BATCH -h1\r\n",
  );
  await engine.whenIdle();
  // Full LATEST page triggers an AFTER page to verify caught up.
  engine.push("BATCH +h2 chathistory #history\r\nBATCH -h2\r\n");
  await engine.whenIdle();

  expect(engine.isReady(room)).toBe(true);
  expect(engine.isExhausted(room)).toBe(false);
  const progressBefore = await db.progress.get(room);
  expect(progressBefore?.serverId).toBe("m4");

  sent.length = 0;
  // Two concurrent loadOlder calls coalesce into one CHATHISTORY BEFORE request.
  const p1 = engine.loadOlder(room);
  const p2 = engine.loadOlder(room);
  await Bun.sleep(10);
  expect(sent).toEqual(["CHATHISTORY BEFORE #history timestamp=2026-11-24T10:03:00.000Z 2"]);

  // Reply with 2 older messages (full page -> hasMore: true).
  engine.push(
    "BATCH +b1 chathistory #history\r\n" +
    "@batch=b1;msgid=m1;time=2026-11-24T10:01:00.000Z;account=bob :bob!u@h PRIVMSG #history :first\r\n" +
    "@batch=b1;msgid=m2;time=2026-11-24T10:02:00.000Z;account=bob :bob!u@h PRIVMSG #history :second\r\n" +
    "BATCH -b1\r\n",
  );
  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1).toEqual({ loaded: 2, hasMore: true });
  expect(r2).toEqual({ loaded: 2, hasMore: true });
  expect(engine.isExhausted(room)).toBe(false);

  // Forward progress checkpoint is untouched and all 4 messages are in Dexie.
  const progressAfter = await db.progress.get(room);
  expect(progressAfter).toEqual(progressBefore);
  const all = await db.messages.where("conversationId").equals(room).toArray();
  expect(all.map((m) => m.serverId).sort()).toEqual(["m1", "m2", "m3", "m4"]);

  // Second loadOlder returns fewer than pageLimit (0 lines) -> marks exhausted.
  sent.length = 0;
  const p3 = engine.loadOlder(room);
  await Bun.sleep(10);
  expect(sent).toEqual(["CHATHISTORY BEFORE #history timestamp=2026-11-24T10:01:00.000Z 2"]);
  engine.push("BATCH +b2 chathistory #history\r\nBATCH -b2\r\n");
  expect(await p3).toEqual({ loaded: 0, hasMore: false });
  expect(engine.isExhausted(room)).toBe(true);

  // Further loadOlder calls short-circuit without sending wire commands.
  sent.length = 0;
  expect(await engine.loadOlder(room)).toEqual({ loaded: 0, hasMore: false });
  expect(sent).toEqual([]);
});

test("isChannelSearchShortcut matches Cmd+F on Apple and Ctrl+F elsewhere", () => {
  const base = { key: "f", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false };
  expect(isChannelSearchShortcut({ ...base, metaKey: true }, true)).toBe(true);
  expect(isChannelSearchShortcut({ ...base, key: "F", metaKey: true }, true)).toBe(true);
  expect(isChannelSearchShortcut({ ...base, ctrlKey: true }, true)).toBe(false);
  expect(isChannelSearchShortcut({ ...base, ctrlKey: true }, false)).toBe(true);
  expect(isChannelSearchShortcut({ ...base, metaKey: true }, false)).toBe(false);
  expect(isChannelSearchShortcut({ ...base, metaKey: true, shiftKey: true }, true)).toBe(false);
  expect(isChannelSearchShortcut({ ...base, metaKey: true, altKey: true }, true)).toBe(false);
  expect(isChannelSearchShortcut({ ...base, metaKey: true, isComposing: true }, true)).toBe(false);
  expect(isChannelSearchShortcut({ ...base, key: "k", metaKey: true }, true)).toBe(false);
});

test("search finds replies and skips legacy thread announcements", () => {
  const room = conversationId("room", "#search");
  const root = makeMessage({ id: "root", conversationId: room, text: "release plan", time: "2026-11-24T10:00:00.000Z" });
  const reply = makeMessage({ id: "reply", conversationId: room, text: "release is blocked", time: "2026-11-24T10:01:00.000Z", replyTo: "root" });
  const announce = makeMessage({ id: "ann", conversationId: room, text: "release thread", time: "2026-11-24T10:02:00.000Z", clientId: "thread-announce:x" });
  const res = searchMessages([root, reply, announce], "release");
  expect(res.hits.map((hit) => hit.focusId).sort()).toEqual(["reply", "root"]);
});

test("Images and Links filters narrow results, alone or with words", () => {
  const room = conversationId("room", "#search");
  const at = (n: number) => `2026-11-24T10:0${n}:00.000Z`;
  const upload = makeMessage({ id: "up", conversationId: room, text: "/uploads/abc123?type=image", time: at(1) });
  const photo = makeMessage({ id: "ph", conversationId: room, text: "look https://cdn.test/cat.png", time: at(2) });
  const link = makeMessage({ id: "ln", conversationId: room, text: "docs https://example.test/page", time: at(3) });
  const plain = makeMessage({ id: "pl", conversationId: room, text: "docs only", time: at(4) });
  const all = [upload, photo, link, plain];
  const origin = "https://slirc.test";
  expect(searchMessages(all, "", { kind: "images", origin }).hits.map((h) => h.id).sort()).toEqual(["ph", "up"]);
  expect(searchMessages(all, "", { kind: "links", origin }).hits.map((h) => h.id)).toEqual(["ln"]);
  expect(searchMessages(all, "docs", { kind: "links", origin }).hits.map((h) => h.id)).toEqual(["ln"]);
  expect(searchMessages(all, "", { origin }).hits).toEqual([]);
});

test("image hits carry a thumbnail and link hits a card with host and preview", () => {
  const room = conversationId("room", "#search");
  const at = (n: number) => `2026-11-24T10:0${n}:00.000Z`;
  const origin = "https://slirc.test";
  const upload = makeMessage({ id: "up", conversationId: room, text: "/uploads/abc123?type=image", time: at(1) });
  const card = makeMessage({ id: "ln", conversationId: room, text: "see https://example.test/page", time: at(2) });
  const bare = makeMessage({ id: "bare", conversationId: room, text: "see https://other.test/page", time: at(3) });
  const embeds = { "https://example.test/page": { image: "https://example.test/og.png" } };
  const links = Object.fromEntries(searchMessages([card, bare], "see", { origin, embeds }).hits.map((h) => [h.id, h.link]));
  expect(links.ln?.thumb).toContain("example.test");
  expect(links.ln?.host).toBe("example.test");
  expect(links.bare?.thumb).toBe("");
  expect(links.bare?.host).toBe("other.test");
  expect(searchMessages([upload], "", { kind: "images", origin }).hits[0]!.thumb).toBe("https://slirc.test/uploads/abc123?type=image");
});

test("a YouTube link gets its thumbnail and title without a preview fetch", () => {
  const room = conversationId("room", "#search");
  const video = makeMessage({ id: "yt", conversationId: room, text: "watch https://youtu.be/dQw4w9WgXcQ", time: "2026-11-24T10:00:00.000Z" });
  const hit = searchMessages([video], "", { kind: "links", origin: "https://slirc.test" }).hits[0]!;
  expect(hit.link?.title).toBe("YouTube");
  expect(hit.link?.thumb).toContain(encodeURIComponent("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"));
});

test("only replies are marked as in a thread", () => {
  const room = conversationId("room", "#search");
  const root = makeMessage({ id: "root", conversationId: room, serverId: "s-root", text: "thread topic", time: "2026-11-24T10:00:00.000Z" });
  const one = makeMessage({ id: "r1", conversationId: room, serverId: "s-r1", text: "topic reply", time: "2026-11-24T10:01:00.000Z", replyTo: "s-root" });
  const two = makeMessage({ id: "r2", conversationId: room, serverId: "s-r2", text: "topic again", time: "2026-11-24T10:02:00.000Z", replyTo: "s-root" });
  const plain = makeMessage({ id: "p", conversationId: room, serverId: "s-p", text: "topic alone", time: "2026-11-24T10:03:00.000Z" });
  const labels = Object.fromEntries(searchMessages([root, one, two, plain], "topic").hits.map((h) => [h.id, h.thread]));
  expect(labels).toEqual({ root: "", r1: "in thread", r2: "in thread", p: "" });
});

test("long addresses are shortened in hits unless a search word is inside them", () => {
  const url = "https://images.pexels.com/photos/1181671/pexels-photo-1181671.jpeg?auto=compress&cs=tinysrgb&w=1200";
  const short = shortenUrls(`pic ${url}`);
  expect(short.length).toBeLessThan(60);
  expect(short.endsWith("…")).toBe(true);
  expect(shortenUrls(`pic ${url}`, ["pexels-photo"])).toContain(url);
  expect(shortenUrls("see https://a.test/x")).toBe("see https://a.test/x");
});
