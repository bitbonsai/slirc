// Fired reminders raise a sticky toast: only for a live line from remind in the person's DM with it,
// not while that DM is on screen, never from history, once per message id. One file per process.
import { afterEach, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { type StickyNote } from "../client/reminder-notice.ts";

const { ClientDatabase } = await import("../client/db.ts");
const { parseIrcLine } = await import("../client/irc.ts");
const { createSyncEngine } = await import("../client/sync.ts");
const { conversationId } = await import("../client/model.ts");
const { createReminderNotice, reminderToast, remindResult } = await import("../client/reminder-notice.ts");

const T = "2026-10-08T10:00:00.000Z";
const ORIGIN = "https://slirc.test";
const DM = "#dm-alice-remind";
const dm = { conversationId: conversationId("dm", "acct-remind"), wireTarget: DM, kind: "dm" as const };
const room = { conversationId: conversationId("room", "#dev-open"), wireTarget: "#dev-open", kind: "room" as const };
const line = (msgid: string, text = "stretch", target = DM, account = "remind") =>
  parseIrcLine(`@msgid=${msgid};time=${T};account=${account};+slirc/cid=c-${msgid} :remind!u@h PRIVMSG ${target} :${text}`)!;

function make(onScreen: string | null = room.conversationId) {
  const core = { stickies: [] as StickyNote[], note: "" };
  const opened: string[] = [];
  const links: string[] = [];
  let screen = onScreen;
  const notice = createReminderNotice({ core, origin: ORIGIN, onScreen: (id) => id === screen, open: (nick) => opened.push(nick), openLink: (href) => links.push(href) });
  return { core, opened, links, notice, view: (id: string | null) => { screen = id; } };
}

test("a live remind DM line raises a sticky toast with Open when the DM is not on screen", () => {
  const { core, notice } = make();
  notice.observe(dm, line("m1"));
  expect(core.stickies).toEqual([{ id: "m1", text: "Reminder: stretch", action: "Open", conversationId: dm.conversationId }]);
  // A quick auto notice is separate state and leaves the sticky toast alone.
  core.note = "Link copied";
  core.note = "";
  expect(core.stickies[0]?.id).toBe("m1");
});

test("no toast while the remind DM is the conversation on screen", () => {
  const { core, notice } = make(dm.conversationId);
  notice.observe(dm, line("m1"));
  expect(core.stickies).toEqual([]);
});

test("one toast per message id, even after Dismiss", () => {
  const { core, notice } = make();
  notice.observe(dm, line("m1"));
  notice.dismiss("m1");
  expect(core.stickies).toEqual([]);
  notice.observe(dm, line("m1"));
  expect(core.stickies).toEqual([]);
  notice.observe(dm, line("m2", "tea"));
  expect(core.stickies[0]?.text).toBe("Reminder: tea");
});

test("other senders, channels and unauthenticated lines raise nothing", () => {
  const { core, notice } = make();
  notice.observe(room, line("m1", "stretch", "#dev-open"));
  notice.observe(dm, line("m2", "hi", DM, "alice"));
  notice.observe(dm, parseIrcLine(`@msgid=m3;time=${T} :remind!u@h PRIVMSG ${DM} :no account tag`)!);
  notice.observe(dm, parseIrcLine(`@time=${T};account=remind :remind!u@h PRIVMSG ${DM} :no msgid`)!);
  notice.observe(dm, parseIrcLine(`@msgid=m4;time=${T};account=remind :remind!u@h TAGMSG ${DM}`)!);
  expect(core.stickies).toEqual([]);
});

test("Open clears the toast and goes to the remind DM; opening the DM another way clears it too", () => {
  const { core, opened, notice } = make();
  notice.observe(dm, line("m1"));
  notice.open("m1");
  expect(core.stickies).toEqual([]);
  expect(opened).toEqual(["remind"]);
  notice.observe(dm, line("m2"));
  notice.viewed(room.conversationId);
  expect(core.stickies[0]?.id).toBe("m2");
  notice.viewed(dm.conversationId);
  expect(core.stickies).toEqual([]);
});

test("sign-out or account switch clears the toast and the seen ids", () => {
  const { core, notice } = make();
  notice.observe(dm, line("m1"));
  notice.reset();
  expect(core.stickies).toEqual([]);
  notice.observe(dm, line("m1"));
  expect(core.stickies[0]?.id).toBe("m1");
});

const dbs: InstanceType<typeof ClientDatabase>[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});

test("through the sync engine, a history page never raises the toast and a live line does", async () => {
  const db = new ClientDatabase({ instance: "https://slirc.test", accountId: "reminder-notice", account: "alice" });
  dbs.push(db);
  const { core, notice } = make();
  const engine = createSyncEngine({ db, send: () => true, hooks: { onLive: notice.observe }, namesProbeMs: 0 });
  engine.recover([dm]);
  engine.push(`:srv 001 alice :welcome\r\n:alice!u@h JOIN ${DM}\r\n`);
  await engine.whenIdle();
  // Backfill on boot or reconnect arrives as a chathistory page.
  engine.push(`BATCH +h chathistory ${DM}\r\n@batch=h;msgid=old;time=${T};account=remind :remind!u@h PRIVMSG ${DM} :old reminder\r\nBATCH -h\r\n`);
  await engine.whenIdle();
  expect(core.stickies).toEqual([]);
  engine.push(`@msgid=new;time=${T};account=remind :remind!u@h PRIVMSG ${DM} :stretch\r\n`);
  await engine.whenIdle();
  expect(core.stickies[0]?.text).toBe("Reminder: stretch");
});

test("several reminders stack newest first; Dismiss removes one, Open clears that DM", () => {
  const { core, opened, notice } = make();
  notice.observe(dm, line("m1", "stretch"));
  notice.observe(dm, line("m2", "tea"));
  notice.observe(dm, line("m3", "call"));
  expect(core.stickies.map((item) => item.text)).toEqual(["Reminder: call", "Reminder: tea", "Reminder: stretch"]);
  notice.dismiss("m2");
  expect(core.stickies.map((item) => item.id)).toEqual(["m3", "m1"]);
  notice.open("m1");
  expect(core.stickies).toEqual([]);
  expect(opened).toEqual(["remind"]);
  notice.observe(dm, line("m4"));
  notice.dismissAll();
  expect(core.stickies).toEqual([]);
});

test("toast copy: plain text reads as a reminder, a quote drops its marker for typographic quotes and clips", () => {
  expect(reminderToast("stretch", ORIGIN)).toEqual({ text: "Reminder: stretch", action: "Open" });
  expect(reminderToast("> Great, thanks.", ORIGIN)).toEqual({ text: "Reminder: “Great, thanks.”", action: "Open" });
  const long = reminderToast(`> ${"word ".repeat(30)}`, ORIGIN).text;
  expect(long.startsWith("Reminder: “word word")).toBe(true);
  expect(long.endsWith("…”")).toBe(true);
  expect(long.length).toBeLessThan(80);
});

test("toast copy: a message link here becomes the action label, other URLs shorten to their host", () => {
  expect(reminderToast(`> Great, thanks. ${ORIGIN}/dm/ada?msg=c5znzg9rfw54ifcbrx2ki68mkw`, ORIGIN))
    .toEqual({ text: "Reminder: “Great, thanks.”", action: "View in DM with ada", href: `${ORIGIN}/dm/ada?msg=c5znzg9rfw54ifcbrx2ki68mkw` });
  expect(reminderToast(`> ship it ${ORIGIN}/?room=%23design&msg=abc123`, ORIGIN).action).toBe("View in #design");
  expect(reminderToast(`> ship it ${ORIGIN}/?room=%23t-abc&msg=abc123`, ORIGIN).action).toBe("View in thread");
  // A room link without a message, or another instance, is not a message link here.
  expect(reminderToast(`check ${ORIGIN}/#design`, ORIGIN)).toEqual({ text: "Reminder: check slirc.test", action: "Open" });
  expect(reminderToast("see https://other.test/dm/ada?msg=abc123", ORIGIN)).toEqual({ text: "Reminder: see other.test", action: "Open" });
  expect(reminderToast("look at https://www.pexels.com/photo/123 today", ORIGIN)).toEqual({ text: "Reminder: look at pexels.com today", action: "Open" });
  expect(reminderToast(`> ${ORIGIN}/dm/ada?msg=abc123`, ORIGIN)).toEqual({ text: "Reminder", action: "View in DM with ada", href: `${ORIGIN}/dm/ada?msg=abc123` });
});

test("a reminder with a message link opens that message and clears only its own toast", () => {
  const { core, opened, links, notice } = make();
  notice.observe(dm, line("m1", "stretch"));
  notice.observe(dm, line("m2", `> Great, thanks. ${ORIGIN}/dm/ada?msg=abc123`));
  expect(core.stickies[0]).toEqual({ id: "m2", text: "Reminder: “Great, thanks.”", action: "View in DM with ada", href: `${ORIGIN}/dm/ada?msg=abc123`, conversationId: dm.conversationId });
  notice.open("m2");
  expect(links).toEqual([`${ORIGIN}/dm/ada?msg=abc123`]);
  expect(opened).toEqual([]);
  expect(core.stickies.map((item) => item.id)).toEqual(["m1"]);
});

test("a /remind list answer opens the remind DM instead of a toast; other answers stay a notice", () => {
  expect(remindResult({ reply: "Your reminders (1):\n1. Tomorrow at 9:00 · stretch", open: "remind" })).toEqual({ open: "remind" });
  expect(remindResult({ reply: "Reminder tomorrow at 9:00: stretch" })).toEqual({ note: "Reminder tomorrow at 9:00: stretch" });
  expect(remindResult({ open: "", reply: "Cancelled." })).toEqual({ note: "Cancelled." });
  expect(remindResult({})).toBeNull();
});
