// Public playground signup and signed-out peek, end to end through the routes. Only the mail
// provider and the oper IRC connection are faked; links, codes, limits and history parsing are real.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://app.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
delete process.env.MAGIC_LINK_LOG;
process.env.OPEN_CHANNELS = "#open-chat,#help";
process.env.SIGNUP_DOMAIN_LIMIT = "3";

import { beforeEach, expect, mock, test } from "bun:test";
import { parseLine, type ParsedMessage } from "../src/irc.ts";

const mail: { to: string; text: string }[] = [];
const sent: string[] = [];
const history: Record<string, string[]> = {
  "#open-chat": [
    "@msgid=a1;time=2026-11-18T10:00:00.000Z :ada!ada@slirc PRIVMSG #open-chat :hello there",
    "@msgid=h1;time=2026-11-18T10:00:01.000Z :HistServ!HistServ@localhost PRIVMSG #open-chat :ben joined the channel",
    "@msgid=a2;time=2026-11-18T10:00:02.000Z :ben!ben@slirc PRIVMSG #open-chat :\x01ACTION waves\x01",
    "@msgid=a3;time=2026-11-18T10:00:03.000Z;+draft/edit=a1 :ada!ada@slirc PRIVMSG #open-chat :hello everyone",
    "@msgid=a4;time=2026-11-18T10:00:04.000Z :ben!ben@slirc TAGMSG #open-chat",
  ],
};

// A stand-in for the oper connection: echoes its own JOIN and answers CHATHISTORY with one batch.
function fakeReader() {
  const waiters: { pred: (m: ParsedMessage) => boolean; resolve: () => void }[] = [];
  const emit = (line: string) => {
    const m = parseLine(line);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.pred(m)) { waiters[i]!.resolve(); waiters.splice(i, 1); }
  };
  const nick = "slirc-org-abc123";
  return {
    nick,
    waitFor: (pred: (m: ParsedMessage) => boolean) => new Promise<void>((resolve) => { waiters.push({ pred, resolve }); }),
    send(line: string) {
      sent.push(line);
      const join = line.match(/^JOIN (#\S+)$/);
      if (join) queueMicrotask(() => emit(`:${nick}!x@slirc JOIN ${join[1]}`));
      const query = line.match(/^CHATHISTORY BEFORE (#\S+) /);
      if (query) queueMicrotask(() => {
        emit(`BATCH +b1 chathistory ${query[1]}`);
        for (const row of history[query[1]!] || []) emit(`@batch=b1;${row.slice(1)}`);
        emit("BATCH -b1");
      });
      return true;
    },
    quit() {},
  };
}

const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, operClient: async () => fakeReader(), createDirectChannel: async () => {}, readDirectChannelReady: async () => false }));
mock.module("resend", () => ({ Resend: class { emails = { send: async (message: any) => { mail.push(message); return { data: { id: "test" }, error: null }; } }; } }));

const { db } = await import("../src/db.ts");
const { app, settleSignIns } = await import("../src/server.ts");
const { accountByEmail } = await import("../src/accounts.ts");
const { memberChannels, openChannels } = await import("../src/rooms.ts");
const { resetRateLimits } = await import("../src/request-security.ts");
const { mailLimitAt, mailDay } = await import("../src/mail-count.ts");

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
// /auth/request answers first and mails afterwards; wait for that work before looking at its effects.
const request = async (body: unknown) => { const response = await post("/auth/request", body); await settleSignIns(); return response; };
const mailedLink = (text: string) => new URL(text.match(/https:\/\/\S+\/auth\/verify\?[^\s)]+/)![0]);
const mailedCode = (text: string) => text.match(/\b(\d{3}) (\d{3})\b/)!.slice(1).join("");
const sessionCookie = (response: Response) => response.headers.get("set-cookie")?.match(/slirc_session=[^;]+/)?.[0] || "";

beforeEach(() => {
  mail.length = 0;
  sent.length = 0;
  resetRateLimits();
  for (const table of ["sessions", "magic_links", "used_magic_links", "mail_counts", "signup_counts"]) db.query(`DELETE FROM ${table}`).run();
  db.query("DELETE FROM accounts WHERE email LIKE '%new.test' OR email LIKE '%@gmail.com' OR email LIKE '%@googlemail.com' OR nick = 'mara'").run();
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('mara', 'mara@example.test', 'member', 1, 1)").run();
});

test("an unknown address gets a provisional account named as typed, the link verifies it, and it sees only open channels", async () => {
  const response = await request({ email: "Newbie@New.test", name: "Nina Newbie", next: "/open-chat" });
  expect(response.status).toBe(204);
  expect(sessionCookie(response)).toBe("");
  const pending = accountByEmail("newbie@new.test")!;
  // The nick comes from the typed name, never from the address.
  expect(pending.nick).toBe("ninanewbie");
  expect(pending.verifiedAt).toBeNull();
  expect(pending.provisionalExpiresAt! - Date.now()).toBeGreaterThan(60 * 60_000);
  expect(mail).toHaveLength(1);
  expect(mail[0]!.to).toBe("newbie@new.test");

  const verified = await app.request(mailedLink(mail[0]!.text).pathname + mailedLink(mail[0]!.text).search);
  const cookie = sessionCookie(verified);
  expect(cookie).toBeTruthy();
  expect(accountByEmail("newbie@new.test")!.verifiedAt).toBeTruthy();
  const me = await (await app.request("/auth/me", { headers: { Cookie: cookie } })).json();
  expect(me).toMatchObject({ authenticated: true, nick: pending.nick });
  // The open channels every account sees plus the help bot's onboarding DM, nothing else until an invitation.
  const help = `#dm-help-${pending.nick}`;
  expect(db.query("SELECT channel FROM channel_members WHERE nick = ?").all(pending.nick)).toEqual([{ channel: help }]);
  expect(memberChannels(pending.nick).sort()).toEqual([...openChannels, help].sort());
});

test("signed out, /auth/me tells the form to ask a newcomer's name", async () => {
  expect(await (await app.request("/auth/me")).json()).toMatchObject({ authenticated: false, signup: true });
});

test("the mailed code also verifies a new signup", async () => {
  expect((await request({ email: "coder@new.test", name: "Coder" })).status).toBe(204);
  const signedIn = await post("/auth/code", { email: "coder@new.test", code: mailedCode(mail[0]!.text) }, { Origin: "https://app.example.test", "X-Slirc-Sign-In": "1" });
  expect(signedIn.status).toBe(200);
  expect(accountByEmail("coder@new.test")!.verifiedAt).toBeTruthy();
});

test("known and unknown addresses get the same answer", async () => {
  const known = await request({ email: "mara@example.test" });
  const unknown = await request({ email: "stranger@new.test" });
  expect([known.status, await known.text()]).toEqual([unknown.status, await unknown.text()]);
  expect(known.status).toBe(204);
});

test("the answer comes before any account work, for known and unknown addresses alike", async () => {
  const unknown = await post("/auth/request", { email: "racer@new.test", name: "Racer" });
  const known = await post("/auth/request", { email: "mara@example.test" });
  expect([unknown.status, known.status]).toEqual([204, 204]);
  expect(db.query("SELECT 1 FROM accounts WHERE email = 'racer@new.test'").get()).toBeNull();
  expect(mail).toHaveLength(0);
  await settleSignIns();
  expect(accountByEmail("racer@new.test")).toBeTruthy();
  expect(mail.map((m) => m.to).sort()).toEqual(["mara@example.test", "racer@new.test"]);
});

test("per-mailbox and per-peer limits still hold, and +tags or Gmail dots share one mailbox", async () => {
  for (const email of ["flood@new.test", "flood+1@new.test", "Flood+x@New.test", "flood@new.test", "flood+2@new.test"]) expect((await request({ email })).status).toBe(204);
  expect((await request({ email: "flood+3@new.test" })).status).toBe(429);
  resetRateLimits();
  for (const email of ["a.b.c@gmail.com", "abc@googlemail.com", "a.bc+z@gmail.com", "ABC@gmail.com", "ab.c@gmail.com"]) expect((await request({ email })).status).toBe(204);
  expect((await request({ email: "abc+again@gmail.com" })).status).toBe(429);
  resetRateLimits();
  for (let i = 0; i < 10; i++) expect((await request({ email: `peer${i}@new.test` })).status).toBe(204);
  expect((await request({ email: "peer10@new.test" })).status).toBe(429);
  expect(accountByEmail("peer10@new.test")).toBeNull();
});

test("signups take a slot of the day's mail limit before the account exists", async () => {
  // Accepted mail plus reserved signups reach the limit: the next new address gets nothing.
  db.query("INSERT INTO mail_counts (day, kind, accepted, count) VALUES (?, 'sign-in', 1, ?)").run(mailDay(), mailLimitAt() - 3);
  // Each signup takes a slot, and its own mail counts again once accepted: one and two fit, three does not.
  for (const email of ["one@new.test", "two@new.test", "three@new.test"]) expect((await request({ email, name: "Someone" })).status).toBe(204);
  expect(accountByEmail("one@new.test")).toBeTruthy();
  expect(accountByEmail("two@new.test")).toBeTruthy();
  expect(accountByEmail("three@new.test")).toBeNull();
  // A known address still gets its sign-in mail on a full day.
  mail.length = 0;
  expect((await request({ email: "mara@example.test" })).status).toBe(204);
  expect(mail).toHaveLength(1);
});

test("one receiving domain gets a bounded number of new signups an hour, silently", async () => {
  for (let i = 0; i < 4; i++) expect((await request({ email: `user${i}@same.new.test`, name: `User ${i}` })).status).toBe(204);
  expect(accountByEmail("user2@same.new.test")).toBeTruthy();
  expect(accountByEmail("user3@same.new.test")).toBeNull();
  // A known address on that domain is not counted or refused.
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('olda', 'olda@same.new.test', 'member', 1, 1)").run();
  mail.length = 0;
  await request({ email: "olda@same.new.test" });
  expect(mail).toHaveLength(1);
});

test("a day at the mail limit creates no account and answers the same", async () => {
  db.query("INSERT INTO mail_counts (day, kind, accepted, count) VALUES (?, 'sign-in', 1, ?)").run(mailDay(), mailLimitAt());
  const response = await request({ email: "late@new.test", name: "Late" });
  expect(response.status).toBe(204);
  expect(db.query("SELECT 1 FROM accounts WHERE email = 'late@new.test'").get()).toBeNull();
  expect(mail).toHaveLength(0);
});

test("a staff or service name never becomes a new member's nick", async () => {
  for (const [i, name] of ["Admin", "NickServ", "help", "bitbonsai", "slirc-org"].entries()) await request({ email: `staff${i}@s${i}.new.test`, name });
  const nicks = (db.query("SELECT nick FROM accounts WHERE email LIKE 'staff%' ORDER BY email").all() as { nick: string }[]).map((row) => row.nick);
  expect(nicks).toHaveLength(5);
  for (const nick of nicks) expect(nick).toMatch(/^member\d*$/);
  // The display name falls back to the neutral nick too, so nobody starts out shown as "Admin".
  const names = db.query("SELECT a.nick, p.full_name FROM accounts a JOIN profiles p ON p.account = a.nick WHERE a.email LIKE 'staff%'").all() as { nick: string; full_name: string }[];
  expect(names).toHaveLength(5);
  for (const row of names) expect(row.full_name).toBe(row.nick);
});

test("a signup name gets the display name rules: cleaned when valid, the nick when not", async () => {
  await request({ email: "grace@g1.new.test", name: "  Grace   Hopper " });
  await request({ email: "hidden@g2.new.test", name: "Ada\u202eL" });
  await request({ email: "slircfan@g3.new.test", name: "Slirc Fan" });
  const name = (email: string) => db.query("SELECT a.nick, p.full_name FROM accounts a JOIN profiles p ON p.account = a.nick WHERE a.email = ?").get(email) as { nick: string; full_name: string };
  expect(name("grace@g1.new.test").full_name).toBe("Grace Hopper");
  for (const email of ["hidden@g2.new.test", "slircfan@g3.new.test"]) expect(name(email).full_name).toBe(name(email).nick);
});

test("a name is ignored for a known address, and a missing name never falls back to the address", async () => {
  const known = await request({ email: "mara@example.test", name: "Someone Else" });
  expect(known.status).toBe(204);
  expect(accountByEmail("mara@example.test")!.nick).toBe("mara");
  expect(mail).toHaveLength(1);
  await request({ email: "secret.handle@new.test" });
  expect(accountByEmail("secret.handle@new.test")!.nick).toMatch(/^member\d*$/);
});

test("an expired signup restarts under its old nick and Ergo account", async () => {
  await request({ email: "again@new.test", name: "Again" });
  const first = accountByEmail("again@new.test")!;
  db.query("UPDATE accounts SET provisional_expires_at = ? WHERE email = 'again@new.test'").run(Date.now() - 1);
  resetRateLimits();
  await request({ email: "again@new.test", name: "Different" });
  const second = accountByEmail("again@new.test")!;
  expect([second.nick, second.id, second.ircPassword]).toEqual([first.nick, first.id, first.ircPassword]);
  expect(second.verifiedAt).toBeNull();
});

test("an unverified signup expires and its old link no longer signs in", async () => {
  await request({ email: "slow@new.test", name: "Slow" });
  const link = mailedLink(mail[0]!.text);
  db.query("UPDATE accounts SET provisional_expires_at = ? WHERE email = 'slow@new.test'").run(Date.now() - 1);
  expect(accountByEmail("slow@new.test")).toBeNull();
  const late = await app.request(link.pathname + link.search);
  expect(sessionCookie(late)).toBe("");
});

test("signed out, peek returns #open-chat text only", async () => {
  const response = await app.request("/api/peek/open-chat");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.channel).toBe("#open-chat");
  expect(body.messages).toEqual([
    { id: "a1", time: "2026-11-18T10:00:00.000Z", nick: "ada", text: "hello everyone" },
    { id: "a2", time: "2026-11-18T10:00:02.000Z", nick: "ben", text: "waves", action: true },
  ]);
});

test("signed out, peek carries what the transcript draws and opens only its authors' avatars", async () => {
  const body = await (await app.request("/api/peek/open-chat")).json();
  expect(body.polls).toEqual({});
  expect(body.embeds).toEqual({});
  expect(body.avatars).toEqual({});
  const ada = await app.request("/avatars/ada");
  expect(ada.status).toBe(200);
  expect(ada.headers.get("content-type")).toContain("image/svg+xml");
  // Someone who has not posted in the room stays private, as before.
  expect((await app.request("/avatars/mara")).status).toBe(401);
});

test("#help, private channels, DMs, threads and unknown rooms are never readable through peek", async () => {
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#secret-room', 'bitbonsai', 'secret', 1) ON CONFLICT DO NOTHING").run();
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#team', 'bitbonsai', 'workspace', 1) ON CONFLICT DO NOTHING").run();
  history["#secret-room"] = ["@msgid=s1;time=2026-11-18T10:00:00.000Z :bitbonsai!x@slirc PRIVMSG #secret-room :private"];
  const owner = { Cookie: "slirc_session=owner-session" };
  for (const name of ["help", "secret-room", "team", "dm-bitbonsai-mara", "t-help-abc", "nowhere", "%23secret-room"]) {
    expect((await app.request(`/api/peek/${name}`)).status).toBe(404);
    expect((await app.request(`/api/peek/${name}`, { headers: owner })).status).toBe(404);
  }
  expect(sent.some((line) => /#help|secret-room|team|dm-|t-help/.test(line))).toBe(false);
});
