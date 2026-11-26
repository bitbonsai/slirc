// Unread counts: the Dexie projection over read markers, the pure mark-read gate, and the runtime's
// mute-aware dots. Browser APIs in the runtime case are shims; no real IRC or visible controls.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { conversationId, type Message } from "../client/model.ts";
import { installBrowserShims } from "./support/browser-shims.ts";

const { ClientDatabase } = await import("../client/db.ts");
const { EPOCH, badgeText, createUnreadProjection, newestServerTime, shouldMarkRead } = await import("../client/store.ts");

const dbs: InstanceType<typeof ClientDatabase>[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});

function open(accountId: string) {
  const db = new ClientDatabase({ instance: "https://unread.test", accountId, account: "alice" });
  dbs.push(db);
  return db;
}

const ROOM = conversationId("room", "#r");
let seq = 0;
function row(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `u-${seq}`, conversationId: ROOM, serverId: `s-${seq}`, authorAccount: "bob", authorNick: "bob",
    text: "hi", time: new Date(Date.UTC(2026, 9, 6, 10, 0, seq)).toISOString(), state: "confirmed", ...overrides,
  };
}

async function settled(projection: { counts: { get(): Record<string, number>; subscribe(cb: (value: Record<string, number>) => void): () => void } }, expected: Record<string, number>) {
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(projection.counts.get()) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(projection.counts.get()).toEqual(expected);
}

test("counts only confirmed foreign rows after the marker", async () => {
  const db = open("unread-filter");
  const marker = row({ authorAccount: "alice" });
  await db.messages.bulkAdd([
    marker,
    row(), // counts
    row({ authorAccount: "ALICE", authorNick: "Alice" }), // own, case-folded
    row({ authorAccount: "HistServ", authorNick: "HistServ" }),
    row({ deleted: true, text: "" }),
    row({ replaces: "s-2" }), // an edit replaces an existing row
    row({ state: "queued", serverId: undefined, authorAccount: "alice" }),
    row({ text: "line one\nline two" }), // multiline is one row
  ]);
  await db.reactions.put({ conversationId: ROOM, messageServerId: "s-2", account: "bob", emoji: "👍", active: true });
  const unread = createUnreadProjection(db);
  try {
    await settled(unread, {}); // no marker yet: nothing counts
    await db.advanceReadMarker(ROOM, marker.time);
    await settled(unread, { [ROOM]: 2 });
    await db.messages.add(row());
    await settled(unread, { [ROOM]: 3 });
    await db.advanceReadMarker(ROOM, (await newestServerTime(db, ROOM))!);
    await settled(unread, {});
  } finally {
    unread.dispose();
  }
});

test("an epoch marker counts every foreign row", async () => {
  const db = open("unread-epoch");
  await db.messages.bulkAdd([row(), row(), row({ authorAccount: "alice" })]);
  await db.advanceReadMarker(ROOM, EPOCH);
  const unread = createUnreadProjection(db);
  try {
    await settled(unread, { [ROOM]: 2 });
  } finally {
    unread.dispose();
  }
});

test("the newest server time ignores pending rows", async () => {
  const db = open("unread-newest");
  const confirmed = row();
  await db.messages.bulkAdd([confirmed, row({ state: "queued", serverId: undefined, time: "2030-01-01T00:00:00.000Z" })]);
  expect(await newestServerTime(db, ROOM)).toBe(confirmed.time);
  expect(await newestServerTime(db, conversationId("room", "#empty"))).toBeUndefined();
});

test("mark read needs a focused visible tab, the conversation on screen, synced, pinned and something newer", () => {
  const base = { visible: true, focused: true, onScreen: true, ready: true, pinned: true, newest: "2026-10-06T10:00:02.000Z", marker: "2026-10-06T10:00:01.000Z" };
  expect(shouldMarkRead(base)).toBe(true);
  expect(shouldMarkRead({ ...base, marker: undefined })).toBe(true);
  for (const key of ["visible", "focused", "onScreen", "ready", "pinned"] as const) {
    expect(shouldMarkRead({ ...base, [key]: false })).toBe(false);
  }
  expect(shouldMarkRead({ ...base, newest: undefined })).toBe(false);
  expect(shouldMarkRead({ ...base, marker: base.newest })).toBe(false);
  expect(shouldMarkRead({ ...base, marker: "2026-10-06T10:00:03.000Z" })).toBe(false);
  expect(badgeText(7)).toBe("7");
  expect(badgeText(99)).toBe("99");
  expect(badgeText(100)).toBe("99+");
});

function shims(origin: string): void {
  installBrowserShims({ origin, userAgent: "unread-runtime-test" });
}

test("muted channels, DMs and their threads show no count, dot or title count", async () => {
  const origin = "https://unread-runtime.test";
  shims(origin);
  const originalFetch = globalThis.fetch;
  const DM = { nick: "ada", channel: "#dm-ada-eve" };
  const thread = { channel: "#t-dev-1", parent: "#dev-test", parentLabel: "dev-test", title: "Plan", root: "r1", rootNick: "ada", rootText: "plan", rootTime: "", lastActivity: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/auth/me") return Response.json({
      authenticated: true, account: "eve", accountId: "eve-unread-id", nick: "eve",
      channels: ["#dev-test", "#open-chat"], directs: [DM], contacts: [],
      accountDetails: [{ nick: "eve", id: "eve-unread-id" }, { nick: "ada", id: "ada-id" }],
      profile: {}, role: "member", threads: [thread], channelDetails: [], openChannels: ["#open-chat"],
    });
    return Response.json({});
  }) as typeof fetch;
  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    const dev = conversationId("room", "#dev-test");
    const open = conversationId("room", "#open-chat");
    const dm = conversationId("dm", "ada-id");
    const threadId = client.ui.threads[0].conversationId;
    client.ui.unread = { [open]: 120, [dm]: 1, [threadId]: 2 };
    // #open-chat starts muted, so only the thread lights Home.
    expect(client.ui.unreadCount(open)).toBe(0);
    expect(client.ui.badgeText(threadId)).toBe("2");
    expect(client.ui.homeDot()).toBe(true);
    expect(client.ui.dmsDot()).toBe(true);
    client.ui.toggleMute("#dev-test");
    expect(client.ui.unreadCount(threadId)).toBe(0);
    expect(client.ui.homeDot()).toBe(false);
    expect(document.title).toBe("(1) Slirc");
    client.ui.toggleMute(`dm:${dm}`);
    expect(client.ui.dmsDot()).toBe(false);
    expect(document.title).toBe("Slirc");
    client.ui.toggleMute("#open-chat");
    expect(client.ui.badgeText(open)).toBe("99+");
    expect(client.ui.unreadCount(dev)).toBe(0);
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);
