import "./fixture.ts";
import { createHash } from "node:crypto";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

// Deleting a channel: admins only, never the default channel or a DM, and everything the channel
// owns goes with it. IRC oper calls are stubbed and recorded; this proves the app's side of the
// teardown and the order it asks Ergo for it, not what Ergo does afterwards.
const purged: string[] = [];
const unregistered: string[] = [];
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({
  ...grants,
  unregisterChannel: async (channel: string) => { unregistered.push(channel); },
  purgeChannelHistory: async (channel: string) => { purged.push(channel); },
}));

process.env.IRC_CHANNEL = "#lobby";
const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { subscribe } = await import("../src/live.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const headers = (token: string) => ({ Cookie: `slirc_session=${token}` });
const remove = (token: string, name: string) => app.request(`/api/channels/${name}`, { method: "DELETE", headers: headers(token) });
db.query("INSERT OR IGNORE INTO accounts (nick, email, role, verified_at, created_at) VALUES ('ada', 'ada@example.com', 'member', 1, 1)").run();
db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sha("admin-session"), Date.now());
db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, 'ada', ?)").run(sha("member-session"), Date.now());

const heard: { nick: string; data: unknown }[] = [];
const stops = ["bitbonsai", "ada"].map((nick) => subscribe(nick, (event, data) => { if (event === "channels") heard.push({ nick, data }); }));

function seed(channel: string, visibility: "workspace" | "secret" | "direct" = "secret", owner = "ada") {
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, ?, ?)").run(channel, owner, visibility, Date.now());
  for (const nick of ["ada", "bitbonsai"]) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?)").run(channel, nick);
}

const count = (table: string, channel: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE channel = ?`).get(channel) as { n: number }).n;

beforeEach(() => {
  purged.length = 0; unregistered.length = 0; heard.length = 0;
  db.exec("DELETE FROM channels; DELETE FROM channel_members; DELETE FROM threads; DELETE FROM invites; DELETE FROM uploads; DELETE FROM custom_emoji; DELETE FROM reminders; DELETE FROM polls; DELETE FROM poll_votes; DELETE FROM helper_catchups; DELETE FROM direct_conversations");
});

test("only admins can delete a channel, owners included", async () => {
  seed("#calango");
  const response = await remove("member-session", "calango");
  expect(response.status).toBe(403);
  expect(count("channels", "#calango")).toBe(1);
  expect(unregistered).toEqual([]);
});

test("the default channel and DMs are refused", async () => {
  seed("#lobby", "workspace", "bitbonsai");
  expect((await remove("admin-session", "lobby")).status).toBe(409);
  seed("#help", "workspace", "bitbonsai");
  expect((await remove("admin-session", "help")).status).toBe(409);
  seed("#dm-ada-bitbonsai", "direct");
  db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick, provision_ready) VALUES ('#dm-ada-bitbonsai', 'ada', 'bitbonsai', 1)").run();
  expect((await remove("admin-session", "dm-ada-bitbonsai")).status).toBe(400);
  db.query("INSERT INTO channels (channel, owner, visibility, created_at, is_group) VALUES ('#crew', 'ada', 'secret', 1, 1)").run();
  expect((await remove("admin-session", "crew")).status).toBe(400);
  for (const channel of ["#lobby", "#help", "#dm-ada-bitbonsai", "#crew"]) expect(count("channels", channel)).toBe(1);
  expect(unregistered).toEqual([]);
  expect(purged).toEqual([]);
});

test("deleting removes the channel, its threads and everything they own", async () => {
  seed("#calango");
  seed("#t-abc123");
  db.query("INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, last_activity, created_by, created_at) VALUES ('#t-abc123', '#calango', 'm1', 'Plans', '', 'ada', 'hi', 1, 1, 'ada', 1)").run();
  db.query("INSERT INTO invites (token_hash, channel, created_by, created_at) VALUES ('tok', '#calango', 'ada', 1)").run();
  const upload = db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES (?, 'ada', ?, 'image', 'image/png', x'00', 1)");
  upload.run("in-channel", "#calango");
  upload.run("in-thread", "#t-abc123");
  upload.run("emoji", "#calango");
  upload.run("elsewhere", "#lobby");
  db.query("INSERT INTO custom_emoji (name, upload_id, added_by, created_at) VALUES ('party', 'emoji', 'ada', 1)").run();
  db.query("INSERT INTO reminders (nick, channel, fire_at, text, created_at) VALUES ('ada', '#calango', 1, 'x', 1)").run();
  const poll = db.query("INSERT INTO polls (channel, creator, question, options, created_at) VALUES ('#calango', 'ada', 'q', '[]', 1) RETURNING id").get() as { id: number };
  db.query("INSERT INTO poll_votes (poll_id, nick, option, voted_at) VALUES (?, 'ada', 0, 1)").run(poll.id);
  db.query("INSERT INTO helper_catchups (helper, channel, msgid, inviter, requested_at) VALUES ('help', '#calango', 'm2', 'ada', 1)").run();

  const response = await remove("admin-session", "calango");
  expect(response.status).toBe(204);

  // Child thread first, history before unregister.
  expect(purged).toEqual(["#t-abc123", "#calango"]);
  expect(unregistered).toEqual(["#t-abc123", "#calango"]);
  for (const channel of ["#calango", "#t-abc123"]) {
    for (const table of ["channels", "channel_members", "threads", "reminders", "polls", "helper_catchups"]) expect(count(table, channel)).toBe(0);
  }
  expect(count("invites", "#calango")).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM poll_votes").get() as { n: number }).n).toBe(0);
  expect((db.query("SELECT id FROM uploads ORDER BY id").all() as { id: string }[]).map((row) => row.id)).toEqual(["elsewhere", "emoji"]);

  // Every member's tabs hear it is gone, so an open view can move to the default channel.
  expect(heard).toEqual([
    { nick: "ada", data: { channel: "#calango", member: false, deleted: true } },
    { nick: "bitbonsai", data: { channel: "#calango", member: false, deleted: true } },
  ]);
});

test("the default channel is listed in /auth/me", async () => {
  const me = await (await app.request("/auth/me", { headers: headers("member-session") })).json();
  expect(me.defaultChannel).toBe("#lobby");
});

afterAll(() => { for (const stop of stops) stop(); });
