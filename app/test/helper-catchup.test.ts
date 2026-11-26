import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";

// Inline Add for a helper: the lookup that decides whether to offer Add, the members route that
// queues the triggering message, and the helper-side catch-up that answers it exactly once.
const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { afterNick } = await import("../src/mention.ts");
const { CATCH_UP_WINDOW_MS, queueHelperCatchUp, reminderReply, runCatchUps } = await import("../src/helper-bot.ts");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const auth = (token = "catchup-owner") => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });

beforeEach(() => {
  for (const table of ["helper_catchups", "reminders", "sessions", "channel_members", "channels"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at) VALUES
    ('remind', 'remind@helpers.invalid', 'member', 'bot', NULL, 1, 1),
    ('poll', 'poll@helpers.invalid', 'member', 'bot', NULL, 1, 1),
    ('outsider', 'outsider@test.invalid', 'member', 'human', NULL, 1, 1),
    ('member1', 'member1@test.invalid', 'member', 'human', NULL, 1, 1),
    ('pi-other', 'pi@test.invalid', 'member', 'agent', 'outsider', 1, 1)`).run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', 1), (?, 'outsider', 1), (?, 'member1', 1)").run(hash("catchup-owner"), hash("outsider-session"), hash("member-session"));
  db.exec(`INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#vault', 'bitbonsai', 'secret', 1);
    INSERT INTO channel_members (channel, nick) VALUES ('#vault', 'bitbonsai'), ('#vault', 'member1'), ('#vault', 'poll');`);
});

const lookup = (path: string, token?: string) => app.request(`/api/channels/${path}`, { headers: auth(token) });
const add = (channel: string, body: Record<string, unknown>, token?: string) =>
  app.request(`/api/channels/${channel}/members`, { method: "POST", headers: auth(token), body: JSON.stringify(body) });
const rows = () => db.query("SELECT helper, channel, msgid, inviter, handled_at FROM helper_catchups ORDER BY id").all() as { helper: string; channel: string; msgid: string; inviter: string; handled_at: number | null }[];

test("lookup says whether a helper is here and hides what people search would hide", async () => {
  expect(await (await lookup("support/members/remind")).json()).toEqual({ channel: "#support", nick: "remind", kind: "bot", member: false });
  expect(await (await lookup("vault/members/poll")).json()).toEqual({ channel: "#vault", nick: "poll", kind: "bot", member: true });
  // Not discoverable to this member, unknown, and someone else's agent all look the same.
  for (const nick of ["outsider", "nobody", "pi-other"]) {
    const response = await lookup(`vault/members/${nick}`, "member-session");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "person not found" });
  }
});

test("lookup and Add refuse people who cannot add members here", async () => {
  const denied = await lookup("vault/members/remind", "outsider-session");
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: "channel membership required" });
  const refused = await add("vault", { nick: "remind", msgid: "msg-denied" }, "outsider-session");
  expect(refused.status).toBe(403);
  expect((await lookup("dm-someone/members/remind")).status).toBe(404);
  expect(rows()).toEqual([]);
  expect(db.query("SELECT 1 FROM channel_members WHERE channel = '#vault' AND nick = 'remind'").get()).toBeNull();
});

test("a fresh helper Add queues the triggering message once; a second Add or a member helper queues nothing", async () => {
  const first = await add("support", { nick: "remind", msgid: "msg-1" });
  expect(await first.json()).toEqual({ channel: "#support", nick: "remind", added: true });
  expect(rows()).toEqual([{ helper: "remind", channel: "#support", msgid: "msg-1", inviter: "bitbonsai", handled_at: null }]);

  const again = await add("support", { nick: "remind", msgid: "msg-2" });
  expect(await again.json()).toEqual({ channel: "#support", nick: "remind", added: false });
  const member = await add("vault", { nick: "poll", msgid: "msg-3" });
  expect(await member.json()).toEqual({ channel: "#vault", nick: "poll", added: false });
  expect(rows().map((row) => row.msgid)).toEqual(["msg-1"]);
});

test("only helpers with a well-formed msgid are queued, and a msgid is queued once", () => {
  expect(queueHelperCatchUp("outsider", "#support", "msg-x", "bitbonsai")).toBe(false);
  expect(queueHelperCatchUp("remind", "#support", "bad id;", "bitbonsai")).toBe(false);
  expect(queueHelperCatchUp("remind", "#support", "msg-x", "bitbonsai")).toBe(true);
  expect(queueHelperCatchUp("remind", "#support", "msg-x", "bitbonsai")).toBe(false);
});

const line = (msgid: string, text: string, from = "bitbonsai", sentAgo = 5_000, channel = "#support") => ({
  command: "PRIVMSG", prefix: `${from}!u@h`, params: [channel, text],
  tags: { msgid, account: from, time: new Date(Date.now() - sentAgo).toISOString() },
});

test("the helper answers the queued message once after joining, never again", async () => {
  queueHelperCatchUp("remind", "#support", "msg-1", "bitbonsai");
  const history = [line("msg-0", "earlier"), line("msg-1", "@remind in 1m stretch")];
  const answered: string[] = [];
  const answer = async (message: { params: string[] }) => {
    answered.push(message.params[1]!);
    reminderReply("remind", "bitbonsai", message.params[0]!, afterNick(message.params[1]!, "remind"));
  };
  // Not joined yet: the row waits.
  expect(await runCatchUps("remind", new Set(), async () => history, answer)).toBe(0);
  expect(rows()[0]!.handled_at).toBeNull();

  const joined = new Set(["#support"]);
  expect(await runCatchUps("remind", joined, async () => history, answer)).toBe(1);
  expect(await runCatchUps("remind", joined, async () => history, answer)).toBe(0);
  expect(answered).toEqual(["@remind in 1m stretch"]);
  expect(db.query("SELECT nick, channel, text FROM reminders").all()).toEqual([{ nick: "bitbonsai", channel: "#support", text: "stretch" }]);
});

test("two passes racing over the same row answer it once", async () => {
  queueHelperCatchUp("remind", "#support", "msg-race", "bitbonsai");
  let calls = 0;
  const joined = new Set(["#support"]);
  const page = async () => [line("msg-race", "@remind in 1m hi")];
  const results = await Promise.all([runCatchUps("remind", joined, page, async () => { calls++; }), runCatchUps("remind", joined, page, async () => { calls++; })]);
  expect(results.sort()).toEqual([0, 1]);
  expect(calls).toBe(1);
});

test("a missing, foreign or stale line is dropped and never retried", async () => {
  queueHelperCatchUp("remind", "#support", "msg-gone", "bitbonsai");
  queueHelperCatchUp("remind", "#support", "msg-foreign", "bitbonsai");
  queueHelperCatchUp("remind", "#support", "msg-old", "bitbonsai");
  const history = [line("msg-foreign", "@remind in 1m hi", "outsider"), line("msg-old", "@remind in 1m hi", "bitbonsai", CATCH_UP_WINDOW_MS + 60_000)];
  let calls = 0;
  const answer = async () => { calls++; };
  expect(await runCatchUps("remind", new Set(["#support"]), async () => history, answer)).toBe(0);
  expect(calls).toBe(0);
  expect(rows().every((row) => row.handled_at !== null)).toBe(true);
});

test("an expired request is ignored even once the helper joins", async () => {
  queueHelperCatchUp("remind", "#support", "msg-late", "bitbonsai", Date.now() - CATCH_UP_WINDOW_MS - 1);
  let pages = 0;
  expect(await runCatchUps("remind", new Set(["#support"]), async () => { pages++; return [line("msg-late", "@remind in 1m hi")]; }, async () => {})).toBe(0);
  expect(pages).toBe(0);
});
