// The sidebar THREADS group: titles from local history, unread from read markers, the "N more" cut.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { conversationId, type Message } from "../client/model.ts";

const { ClientDatabase } = await import("../client/db.ts");
const { createReplyThreadList, replyThreadMarkerId, replyThreadTitle, replyThreadUnread, visibleReplyThreads } = await import("../client/reply-thread-list.ts");

const dbs: InstanceType<typeof ClientDatabase>[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.delete(); });

const ROOM = conversationId("room", "#general");
function open(id: string) {
  const db = new ClientDatabase({ instance: "https://threads.test", accountId: id, account: "alice" });
  dbs.push(db);
  return db;
}
const root = (serverId: string, text: string): Message => ({
  id: "m-" + serverId, conversationId: ROOM, serverId, authorAccount: "alice", authorNick: "alice", text,
  time: "2026-11-24T09:00:00.000Z", state: "confirmed",
});
const row = (rootId: string, lastAt: string, others: string[], channel = "#general") => ({ rootId, channel, replies: others.length + 1, lastAt, lastBy: "bob", others });

function list(db: InstanceType<typeof ClientDatabase>, rows: unknown[], extra: { openRoot?: () => string; known?: (channel: string) => boolean } = {}) {
  const shown: unknown[] = [];
  const state = createReplyThreadList((value) => value, {
    db: () => db,
    conversationFor: (channel) => (extra.known ?? (() => true))(channel) ? { conversationId: ROOM, label: channel } : null,
    openRootId: extra.openRoot ?? (() => ""),
    show: (item) => { shown.push(item); },
    fetcher: (async () => new Response(JSON.stringify({ threads: rows }))) as unknown as typeof fetch,
  });
  return { state, shown };
}

test("unread counts replies from others after the read position", () => {
  const others = ["2026-11-24T10:00:00.000Z", "2026-11-24T11:00:00.000Z"];
  expect(replyThreadUnread(others, undefined)).toBe(2);
  expect(replyThreadUnread(others, "2026-11-24T10:00:00.000Z")).toBe(1);
  expect(replyThreadUnread(others, "2026-11-24T12:00:00.000Z")).toBe(0);
  expect(replyThreadUnread([], undefined)).toBe(0);
});

test("a title is the first line of the root, trimmed, with a fallback", () => {
  expect(replyThreadTitle("  Ship the\nbeta  ")).toBe("Ship the");
  expect(replyThreadTitle("x".repeat(120))).toHaveLength(80);
  // A root that is only a link shows the page title, or the host before the preview is known.
  expect(replyThreadTitle("https://www.example.com/a/b?c=1", (url) => url.includes("example") ? "  Example   page " : undefined)).toBe("Example page");
  expect(replyThreadTitle("https://www.example.com/a/b")).toBe("example.com");
  expect(replyThreadTitle("see https://example.com", () => "Ignored")).toBe("see https://example.com");
  expect(replyThreadTitle(undefined)).toBe("Thread");
});

test("shows the first few and counts the rest, until expanded", () => {
  const items = [1, 2, 3, 4, 5];
  expect(visibleReplyThreads(items, false)).toEqual({ shown: [1, 2, 3], more: 2 });
  expect(visibleReplyThreads(items, true)).toEqual({ shown: items, more: 0 });
  expect(visibleReplyThreads([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], more: 0 });
});

test("builds rows from the server index and local history, newest first as given, and hides unknown channels", async () => {
  const db = open("rows");
  await db.messages.put(root("r1", "Launch plan\nsecond line"));
  const { state } = list(db, [row("r1", "2026-11-24T11:00:00.000Z", ["2026-11-24T11:00:00.000Z"]), row("r2", "2026-11-24T10:00:00.000Z", [], "#gone")], { known: (channel) => channel === "#general" });
  await state.load();
  expect(state.items.map((item) => [item.rootId, item.title, item.label])).toEqual([["r1", "Launch plan", "#general"]]);
});

test("replies from before this device first listed threads stay read; later ones count", async () => {
  const db = open("seed");
  await db.messages.put(root("r1", "Old thread"));
  const rows = [row("r1", "2020-01-01T00:00:00.000Z", ["2020-01-01T00:00:00.000Z"])];
  const { state } = list(db, rows);
  await state.load();
  expect(state.items[0]!.unread).toBe(0);
  expect(state.unreadTotal()).toBe(0);
  const later = [row("r1", "2999-01-01T00:00:00.000Z", ["2020-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z"])];
  const next = list(db, later);
  await next.state.load();
  expect(next.state.items[0]!.unread).toBe(1);
  expect(next.state.badge(next.state.unreadTotal())).toBe("1");
});

test("opening a thread moves its read position and clears the count", async () => {
  const db = open("open");
  await db.messages.put(root("r1", "Thread"));
  const rows = [row("r1", "2999-01-01T00:00:00.000Z", ["2999-01-01T00:00:00.000Z"])];
  const { state, shown } = list(db, rows);
  await state.load();
  expect(state.items[0]!.unread).toBe(1);
  // Collapsing the group must not replace the open() method, and starts expanded.
  expect(state.listOpen).toBe(true);
  state.toggle();
  expect(state.listOpen).toBe(false);
  expect(typeof state.open).toBe("function");
  state.toggle();
  await state.open(state.items[0]!);
  expect(shown).toHaveLength(1);
  expect(state.items[0]!.unread).toBe(0);
  expect((await db.readMarkers.get(replyThreadMarkerId("r1")))?.time).toBe("2999-01-01T00:00:00.000Z");
});

test("a thread already open on screen counts as read as replies arrive", async () => {
  const db = open("onscreen");
  await db.messages.put(root("r1", "Thread"));
  const rows = [row("r1", "2999-01-01T00:00:00.000Z", ["2999-01-01T00:00:00.000Z"])];
  const { state } = list(db, rows, { openRoot: () => "r1" });
  await state.load();
  expect(state.items[0]!.unread).toBe(0);
});

test("reset empties the group", async () => {
  const db = open("reset");
  const { state } = list(db, [row("r1", "2026-11-24T11:00:00.000Z", [])]);
  await state.load();
  expect(state.items).toHaveLength(1);
  state.reset();
  expect(state.items).toHaveLength(0);
});
