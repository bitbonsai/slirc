// Help's welcome DM arrives before a new member's first load. The first read marker used to start
// at the newest message, so the welcome never showed as unread and nobody noticed it. When Ergo
// says no session has read help's DM, every line counts until the DM is opened. Everything else
// still starts at the newest message, so a new device does not light up with old history.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { conversationId, type Message } from "../client/model.ts";

const { ClientDatabase } = await import("../client/db.ts");
const { EPOCH, createUnreadProjection, firstReadMarker, newestServerTime } = await import("../client/store.ts");

const dbs: InstanceType<typeof ClientDatabase>[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.delete(); });

const HELP_DM = conversationId("dm", "#dm-help-newbie");
let seq = 0;
const line = (text: string): Message => {
  seq += 1;
  return { id: `w-${seq}`, conversationId: HELP_DM, serverId: `s-${seq}`, authorAccount: "help", authorNick: "help", text, time: new Date(Date.UTC(2026, 10, 11, 9, 0, seq)).toISOString(), state: "confirmed" };
};

test("only help's DM, unread on the server, starts counting from the beginning", () => {
  const newest = "2026-11-11T09:00:02.000Z";
  expect(firstReadMarker({ newest, peer: "help", serverSaidNone: true })).toEqual({ time: EPOCH, tellServer: false });
  // Another session already read it, or the server never answered: the usual quiet start.
  expect(firstReadMarker({ newest, peer: "help", serverSaidNone: false })).toEqual({ time: newest, tellServer: false });
  // Any other DM or a channel keeps starting at the newest message, and tells Ergo.
  expect(firstReadMarker({ newest, peer: "ada", serverSaidNone: true })).toEqual({ time: newest, tellServer: true });
  expect(firstReadMarker({ newest, serverSaidNone: true })).toEqual({ time: newest, tellServer: true });
  expect(firstReadMarker({ peer: "ada", serverSaidNone: true })).toEqual({ time: EPOCH, tellServer: false });
});

test("the welcome lines show as unread until the DM is read", async () => {
  const db = new ClientDatabase({ instance: "https://welcome.test", accountId: "newbie-id", account: "newbie" });
  dbs.push(db);
  await db.messages.bulkAdd([line("Hi newbie, I'm help. Ask me anything about Slirc, any time."), line("Your first steps, plus a few things worth trying: https://welcome.test/welcome")]);
  const newest = await newestServerTime(db, HELP_DM);
  await db.advanceReadMarker(HELP_DM, firstReadMarker({ newest, peer: "help", serverSaidNone: true }).time);
  const unread = createUnreadProjection(db);
  try {
    for (let i = 0; i < 50 && unread.counts.get()[HELP_DM] !== 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unread.counts.get()).toEqual({ [HELP_DM]: 2 });
    // Opening the DM moves the marker to the newest line, and the badge goes.
    await db.advanceReadMarker(HELP_DM, newest!);
    for (let i = 0; i < 50 && unread.counts.get()[HELP_DM]; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unread.counts.get()).toEqual({});
  } finally { unread.dispose(); }
});
