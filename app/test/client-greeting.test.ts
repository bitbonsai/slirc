// The per-person G'day setting on the client: Off hides the welcome helper's daily gif from the
// transcript and from unread counts. Other rows, including people's own /giphy lines, stay.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { conversationId, type Message } from "../client/model.ts";
import { isDailyGreeting } from "../shared/service-bots.ts";

const { ClientDatabase } = await import("../client/db.ts");
const { createUnreadProjection, EPOCH } = await import("../client/store.ts");
const { createTranscript } = await import("../client/transcript.ts");

const dbs: InstanceType<typeof ClientDatabase>[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.delete(); });

const ROOM = conversationId("room", "#open-chat");
const GDAY = "[Giphy: ship it] https://media.giphy.com/media/x/giphy.gif";
let seq = 0;
function row(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `g-${seq}`, conversationId: ROOM, serverId: `s-${seq}`, authorAccount: "bob", authorNick: "bob",
    text: "hi", time: new Date(Date.UTC(2026, 9, 8, 9, 0, seq)).toISOString(), state: "confirmed", ...overrides,
  };
}
const gday = () => row({ authorAccount: "welcome", authorNick: "welcome", text: GDAY });

test("Off hides only the daily greeting from the transcript", () => {
  const messages = [gday(), row({ authorAccount: "welcome", authorNick: "welcome", text: "Hi bob, welcome in." }), row({ text: GDAY }), row()];
  const core = { messages, threads: [], embeds: {}, currentConversationId: ROOM, greeting: true };
  const transcript = createTranscript({ core: core as never, nextTick: async () => {}, authorized: () => [], stopped: () => false, linkOpen: () => false, closeLink: () => {} });
  expect(transcript.displayedMessages()).toHaveLength(4);
  core.greeting = false;
  expect(transcript.displayedMessages().map((message) => message.id)).toEqual(messages.slice(1).map((message) => message.id));
});

test("Off leaves the daily greeting out of unread counts without touching the read marker", async () => {
  const db = new ClientDatabase({ instance: "https://greeting.test", accountId: "greeting-unread", account: "alice" });
  dbs.push(db);
  await db.messages.bulkAdd([gday(), row({ text: GDAY }), row()]);
  await db.advanceReadMarker(ROOM, EPOCH);
  let greeting = false;
  const unread = createUnreadProjection(db, (message) => greeting || !isDailyGreeting(message.authorAccount, message.text));
  try {
    for (let i = 0; i < 50 && unread.counts.get()[ROOM] !== 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unread.counts.get()).toEqual({ [ROOM]: 2 });
    expect((await db.readMarkers.get(ROOM))?.time).toBe(EPOCH);
  } finally { unread.dispose(); }
  greeting = true;
  const all = createUnreadProjection(db, () => greeting);
  try {
    for (let i = 0; i < 50 && all.counts.get()[ROOM] !== 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(all.counts.get()).toEqual({ [ROOM]: 3 });
  } finally { all.dispose(); }
});

const { createGreetingNote } = await import("../client/greeting-note.ts");

async function withFetch(run: (calls: { path: string; body: any }[], fail: { on: boolean }) => Promise<void>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const calls: { path: string; body: any }[] = [];
  const fail = { on: false };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return fail.on ? Response.json({ error: "Local fixture failure" }, { status: 503 }) : Response.json({});
  } });
  try { await run(calls, fail); } finally { if (saved) Object.defineProperty(globalThis, "fetch", saved); }
}

function note(core = { greeting: true, greetingNoteSeen: false }) {
  let key = "eve-id";
  const session = { scope: () => ({ instance: "https://greeting.test", account: "eve", accountId: "eve-id" }), key: () => key, stopped: () => false, signingOut: () => false };
  return { core, note: createGreetingNote((value) => value, { core, session }), switchAccount: () => { key = "other-id"; } };
}

test("the note shows once under the newest greeting and marks itself seen on the server", () => withFetch(async (calls) => {
  const { core, note: greetingNote } = note();
  const older = gday(), newer = gday(), mine = row({ text: GDAY });
  greetingNote.consider([row()]);
  expect(calls).toHaveLength(0);
  greetingNote.consider([older, mine, newer, row()]);
  expect(greetingNote.forMessage(newer.id)).toBe(true);
  expect(greetingNote.forMessage(older.id)).toBe(false);
  expect(greetingNote.forMessage(mine.id)).toBe(false);
  expect(greetingNote.text).toBe("Daily greeting from welcome.");
  expect(core.greetingNoteSeen).toBe(true);
  expect(calls).toEqual([{ path: "/profile", body: { accountId: "eve-id", greetingNoteSeen: true } }]);
}));

test("Turn off saves the setting, hides the greeting and moves the outcome to the end", () => withFetch(async (calls, fail) => {
  const { core, note: greetingNote } = note();
  const greeting = gday();
  greetingNote.consider([greeting]);
  fail.on = true;
  await greetingNote.turnOff();
  expect(core.greeting).toBe(true);
  expect(greetingNote.state).toBe("ask");
  expect(greetingNote.text).toBe("Couldn't turn it off. Try again.");
  fail.on = false;
  await greetingNote.turnOff();
  expect(calls.at(-1)).toEqual({ path: "/profile", body: { accountId: "eve-id", greeting: false, greetingNoteSeen: true } });
  expect(core.greeting).toBe(false);
  expect(greetingNote.forMessage(greeting.id)).toBe(false);
  expect(greetingNote.atEnd(ROOM)).toBe(true);
  expect(greetingNote.text).toBe("Turned off. Change it in Settings.");
  greetingNote.dismiss();
  expect(greetingNote.atEnd(ROOM)).toBe(false);
}));

test("Keep closes the note, and it never comes back on this or another device", () => withFetch(async (calls) => {
  const { core, note: greetingNote } = note();
  const greeting = gday();
  greetingNote.consider([greeting]);
  greetingNote.dismiss();
  expect(greetingNote.forMessage(greeting.id)).toBe(false);
  expect(core.greeting).toBe(true);
  greetingNote.consider([greeting, gday()]);
  expect(greetingNote.messageId).toBeNull();
  expect(calls).toHaveLength(1);
  // Another device reads greetingNoteSeen from /auth/me.
  const other = note({ greeting: true, greetingNoteSeen: true });
  other.note.consider([gday()]);
  expect(other.note.messageId).toBeNull();
  expect(calls).toHaveLength(1);
}));

test("the note is not offered when the greeting is already off, and drops on an account switch", () => withFetch(async () => {
  const off = note({ greeting: false, greetingNoteSeen: false });
  off.note.consider([gday()]);
  expect(off.note.messageId).toBeNull();
  const { note: greetingNote, switchAccount } = note();
  const greeting = gday();
  greetingNote.consider([greeting]);
  switchAccount();
  expect(greetingNote.forMessage(greeting.id)).toBe(false);
}));
