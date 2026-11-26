import "./fixture.ts";

process.env.APP_ORIGIN = "https://app.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
process.env.IRC_CHANNEL = "#lobby";
process.env.BULK_INVITE_GAP_MS = "0";
delete process.env.MAIL_DAILY_LIMIT;
delete process.env.MAGIC_LINK_LOG;

import { createHash, randomBytes } from "node:crypto";
import { beforeEach, expect, mock, test } from "bun:test";

const messages: any[] = [];
let failTo = "";
let throwTo = "";
const emailSend = mock(async (message: any) => {
  messages.push(message);
  if (message.to === throwTo) throw new Error("network down");
  return message.to === failTo ? { data: null, error: { message: "rejected" } } : { data: { id: "test" }, error: null };
});

mock.module("../src/grants.ts", () => {
  const noop = async () => {};
  return {
    grantChannelOps: noop,
    operClient: noop, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }), readDirectChannelReady: async () => false,
    serviceCommand: noop, setAlwaysOn: noop, transferChannel: noop, allowChannelAccess: noop,
    grantChannelAccess: noop, createChannel: noop,
    setChannelMode: noop, setChannelTopic: noop, revokeChannelAccess: noop, createDirectChannel: noop,
    createThreadChannel: noop, NotAuthorizedError: class NotAuthorizedError extends Error {}, redactMessage: noop,
    kickChannelMember: noop, makeChannelSecret: noop, makeThreadChannelsSecret: noop, removeFromThreadChannels: noop, makeChannelOpen: noop, clearChannelAccess: noop,
    unregisterChannel: noop, purgeChannelHistory: noop, renameChannel: noop, removeMemberFromIrc: async () => ({ suspended: true }),
  };
});
mock.module("resend", () => ({ Resend: class { emails = { send: emailSend }; } }));

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { mailDay } = await import("../src/mail-count.ts");
const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const addSession = (nick: string, token: string) => db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?,?,?)").run(sessionHash(token), nick, Date.now());
const headers = (token: string, key = true) => ({
  Cookie: `slirc_session=${token}`, "Content-Type": "application/json", Origin: "https://app.example.test", "X-Slirc-Invitation": "1",
  ...(key ? { "Idempotency-Key": randomBytes(12).toString("hex") } : {}),
});
const bulk = (body: unknown, token = "admin-session", key = true) =>
  app.request("/api/invites/bulk", { method: "POST", headers: headers(token, key), body: JSON.stringify(body) });

beforeEach(() => {
  failTo = "";
  throwTo = "";
  messages.length = 0;
  process.env.MAIL_DAILY_LIMIT = "100";
  for (const table of ["sessions", "invites", "conversation_operations", "email_invite_quota", "channel_members", "mail_counts"]) db.query(`DELETE FROM ${table}`).run();
  db.query("DELETE FROM channels WHERE channel IN ('#team', '#lobby', '#quiet')").run();
  db.query("DELETE FROM accounts WHERE nick != 'bitbonsai'").run();
  db.query("UPDATE accounts SET role = 'admin' WHERE nick = 'bitbonsai'").run();
  db.query("INSERT INTO accounts (nick,email,role,verified_at,created_at) VALUES ('igor','igor@example.com','member',1,1)").run();
  db.query("INSERT INTO accounts (nick,email,role,verified_at,created_at) VALUES ('ada','ada@example.com','member',1,1)").run();
  db.query("INSERT INTO accounts (nick,email,role,verified_at,created_at) VALUES ('ghost','ghost@example.com','member',NULL,1)").run();
  for (const channel of ["#team", "#lobby", "#quiet"]) db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, 'bitbonsai', 'secret', 1)").run(channel);
  for (const [channel, nick] of [["#team", "bitbonsai"], ["#lobby", "bitbonsai"], ["#team", "ada"]]) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?)").run(channel, nick);
  addSession("bitbonsai", "admin-session");
  addSession("igor", "member-session");
});

test("preview sorts every row without sending or writing anything", async () => {
  db.query(`INSERT INTO invites (token_hash, channel, created_by, created_at, email, destination_type, inviter_account_id, expires_at, invitation_id, delivery_state)
    SELECT 'h1', '#team', 'bitbonsai', 1, 'old@example.com', 'channel', account_id, ?, 'inv1', 'sent' FROM accounts WHERE nick = 'bitbonsai'`).run(Date.now() + 60_000);
  const response = await bulk({ preview: true, destination: { channel: "#team" }, emails: [
    "New@Example.com", "new@example.com", "not-an-email", "owner@example.com", "igor@example.com", "ada@example.com", "old@example.com", "ghost@example.com",
  ] }, "admin-session", false);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.channel).toBe("#team");
  expect(body.rows.map((row: any) => row.status)).toEqual(["new", "duplicate", "invalid", "self", "add", "existing", "pending", "new"]);
  expect(body.rows[4]).toEqual({ email: "igor@example.com", status: "add", nick: "igor" });
  // An unverified account looks exactly like a new address: no nick, same status.
  expect(body.rows[7]).toEqual({ email: "ghost@example.com", status: "new" });
  expect(body.mailRoom).toBe(75);
  expect(messages).toHaveLength(0);
  expect((db.query("SELECT COUNT(*) AS n FROM invites").get() as any).n).toBe(1);
});

test("send invites new addresses, adds members, and reports each row", async () => {
  failTo = "bad@example.com";
  const response = await bulk({ destination: { channel: "#team" }, emails: ["one@example.com", "igor@example.com", "ada@example.com", "bad@example.com", "one@example.com"] });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.rows.map((row: any) => [row.email, row.status])).toEqual([
    ["one@example.com", "invited"], ["igor@example.com", "added"], ["ada@example.com", "existing"], ["bad@example.com", "failed"], ["one@example.com", "duplicate"],
  ]);
  expect(messages.map((message) => message.to)).toEqual(["one@example.com", "bad@example.com"]);
  expect(db.query("SELECT 1 FROM channel_members WHERE channel = '#team' AND nick = 'igor'").get()).toBeTruthy();
  // A second run finds the pending invitation and sends nothing new.
  messages.length = 0;
  const again = await (await bulk({ destination: { channel: "#team" }, emails: ["one@example.com"] })).json();
  expect(again.rows[0].status).toBe("pending");
  expect(messages).toHaveLength(0);
});

test("workspace only invites to the default channel", async () => {
  const body = await (await bulk({ destination: { workspace: true }, emails: ["fresh@example.com"] })).json();
  expect(body.channel).toBe("#lobby");
  expect(db.query("SELECT channel, destination_type FROM invites WHERE email = 'fresh@example.com'").get()).toEqual({ channel: "#lobby", destination_type: "channel" });
});

test("new invites stop at 75% of the daily mail limit and the rest are held", async () => {
  process.env.MAIL_DAILY_LIMIT = "20";
  db.query("INSERT INTO mail_counts (day, kind, accepted, count) VALUES (?, 'sign-in', 1, 13)").run(mailDay());
  const body = await (await bulk({ destination: { channel: "#team" }, emails: ["a@example.com", "b@example.com", "igor@example.com", "c@example.com"] })).json();
  expect(body.rows.map((row: any) => row.status)).toEqual(["invited", "invited", "added", "held"]);
  expect(body.mailRoom).toBe(0);
  expect(db.query("SELECT 1 FROM invites WHERE email = 'c@example.com'").get()).toBeNull();
});

test("an unknown mail count holds every new address", async () => {
  db.exec("ALTER TABLE mail_counts RENAME TO mail_counts_away");
  try {
    const body = await (await bulk({ destination: { channel: "#team" }, emails: ["a@example.com", "igor@example.com"] })).json();
    expect(body.rows.map((row: any) => row.status)).toEqual(["held", "added"]);
    expect(body.mailRoom).toBe(0);
    expect(messages).toHaveLength(0);
  } finally { db.exec("ALTER TABLE mail_counts_away RENAME TO mail_counts"); }
});

test("a send that throws counts against the room and reads as uncertain", async () => {
  process.env.MAIL_DAILY_LIMIT = "4"; // room 3
  throwTo = "lost@example.com";
  const body = await (await bulk({ destination: { channel: "#team" }, emails: ["lost@example.com", "a@example.com", "b@example.com", "c@example.com"] })).json();
  expect(body.rows.map((row: any) => row.status)).toEqual(["uncertain", "invited", "invited", "held"]);
  expect(body.mailRoom).toBe(0);
});

test("concurrent batches share one room, and an address another batch invited reads as already invited", async () => {
  process.env.MAIL_DAILY_LIMIT = "4"; // room 3
  const [first, second] = await Promise.all([
    bulk({ destination: { channel: "#team" }, emails: ["a@example.com", "b@example.com", "same@example.com"] }).then((r) => r.json()),
    bulk({ destination: { channel: "#team" }, emails: ["same@example.com", "c@example.com"] }).then((r) => r.json()),
  ]);
  expect(first.rows.map((row: any) => row.status)).toEqual(["invited", "invited", "invited"]);
  // Queued behind the first batch: "same" is now pending and spends nothing, and the room is gone.
  expect(second.rows.map((row: any) => row.status)).toEqual(["pending", "held"]);
  expect(messages.map((message) => message.to).sort()).toEqual(["a@example.com", "b@example.com", "same@example.com"]);
});

test("bulk invites leave the admin's single-invite allowance alone", async () => {
  await bulk({ destination: { channel: "#team" }, emails: ["a@example.com"] });
  expect(db.query("SELECT sent, reserved FROM email_invite_quota").all()).toEqual([]);
});

test("replaying a batch key returns the first answer without sending again", async () => {
  const key = randomBytes(12).toString("hex");
  const send = () => app.request("/api/invites/bulk", { method: "POST", headers: { ...headers("admin-session", false), "Idempotency-Key": key },
    body: JSON.stringify({ destination: { channel: "#team" }, emails: ["once@example.com"] }) });
  const first = await (await send()).json();
  const second = await (await send()).json();
  expect(second).toEqual(first);
  expect(messages).toHaveLength(1);
});

test("only admins, only their channels, only same-origin, bounded batches", async () => {
  expect((await bulk({ preview: true, destination: { channel: "#team" }, emails: ["x@example.com"] }, "member-session", false)).status).toBe(403);
  expect((await bulk({ preview: true, destination: { channel: "#quiet" }, emails: ["x@example.com"] }, "admin-session", false)).status).toBe(403);
  const crossSite = await app.request("/api/invites/bulk", { method: "POST", headers: { ...headers("admin-session"), Origin: "https://evil.example" },
    body: JSON.stringify({ preview: true, destination: { channel: "#team" }, emails: ["x@example.com"] }) });
  expect(crossSite.status).toBe(403);
  const many = Array.from({ length: 26 }, (_, n) => `p${n}@example.com`);
  expect((await bulk({ destination: { channel: "#team" }, emails: many })).status).toBe(400);
  expect((await bulk({ preview: true, destination: { channel: "#team" }, emails: many }, "admin-session", false)).status).toBe(200);
  expect((await bulk({ destination: { channel: "#team" }, emails: ["y@example.com"] }, "admin-session", false)).status).toBe(400);
  expect(messages).toHaveLength(0);
});
