import "./fixture.ts";
import { createHash } from "node:crypto";
import { afterEach, expect, mock, test } from "bun:test";

// Authorization cascades between a channel, its DMs and its threads. IRC oper calls are recorded
// instead of sent, so this proves what the app asks Ergo to do and what SQLite allows afterwards.
const calls: { fn: string; args: unknown[] }[] = [];
const record = (fn: string) => async (...args: unknown[]) => { calls.push({ fn, args }); };
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({
  ...grants,
  createChannel: record("createChannel"),
  makeChannelOpen: record("makeChannelOpen"),
  makeChannelSecret: record("makeChannelSecret"),
  makeThreadChannelsSecret: record("makeThreadChannelsSecret"),
  setChannelMode: record("setChannelMode"),
  kickChannelMember: record("kickChannelMember"),
  revokeChannelAccess: record("revokeChannelAccess"),
  removeFromThreadChannels: record("removeFromThreadChannels"),
}));
const accounts = await import("../src/accounts.ts");
mock.module("../src/accounts.ts", () => ({ ...accounts, ircChannelExists: async () => false }));

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const rooms = await import("../src/rooms.ts");

function session(nick: string) {
  const token = `thread-authz-${nick}`;
  db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)")
    .run(createHash("sha256").update(token).digest("hex"), nick, Date.now());
  return { Cookie: `slirc_session=${token}`, "Content-Type": "application/json" };
}
for (const nick of ["bob", "eve"]) {
  db.query("INSERT OR IGNORE INTO accounts (nick, email, role, verified_at, created_at) VALUES (?, ?, 'member', 1, 1)").run(nick, `${nick}@example.com`);
}
const admin = session("bitbonsai");
const bob = session("bob");
const eve = session("eve");

function seed(channel: string, visibility: "workspace" | "secret" | "direct", members: string[], owner = "bitbonsai") {
  db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES (?, ?, ?, '', ?)").run(channel, owner, visibility, Date.now());
  for (const nick of members) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?)").run(channel, nick);
}
function thread(child: string, parent: string, visibility: "workspace" | "secret", members: string[]) {
  seed(child, visibility, members);
  db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES (?, ?, ?, 'T', '', 'bitbonsai', 1, 1)").run(child, parent, `root-${child}`);
}
const members = (channel: string) => (db.query("SELECT nick FROM channel_members WHERE channel = ? ORDER BY nick").all(channel) as { nick: string }[]).map((row) => row.nick);
const visibility = (channel: string) => (db.query("SELECT visibility FROM channels WHERE channel = ?").get(channel) as { visibility: string } | null)?.visibility;
const patch = (channel: string, action: string, headers = admin) =>
  app.request(`/api/channels/${channel.replace(/^#/, "")}`, { method: "PATCH", headers, body: JSON.stringify({ action }) });

afterEach(() => {
  calls.length = 0;
  for (const table of ["channels", "channel_members", "threads"]) db.query(`DELETE FROM ${table} WHERE channel LIKE '#az-%' OR channel LIKE '#t-az%' OR channel LIKE '#dm-az%'`).run();
  db.query("DELETE FROM direct_conversations WHERE channel LIKE '#dm-az%'").run();
});

test("nobody, admins included, can open, close or archive a DM", async () => {
  seed("#dm-az-bob", "direct", ["bitbonsai", "bob"]);
  db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick, provision_ready) VALUES ('#dm-az-bob', 'bitbonsai', 'bob', 1)").run();
  for (const action of ["open", "secret", "archive"]) {
    expect((await patch("#dm-az-bob", action)).status).toBe(403);
    expect((await patch("#dm-az-bob", action, bob)).status).toBe(403);
  }
  expect(calls).toEqual([]);
  expect(visibility("#dm-az-bob")).toBe("direct");
  expect(await app.request("/api/channels/dm-az-bob/join", { method: "POST", headers: eve }).then((r) => r.status)).toBe(404);
  expect(members("#dm-az-bob")).toEqual(["bitbonsai", "bob"]);
});

test("a thread cannot be opened or closed apart from its channel", async () => {
  seed("#az-room", "secret", ["bitbonsai", "bob"]);
  thread("#t-az0001", "#az-room", "secret", ["bitbonsai", "bob"]);
  for (const action of ["open", "secret"]) expect((await patch("#t-az0001", action)).status).toBe(403);
  expect(calls).toEqual([]);
  expect(visibility("#t-az0001")).toBe("secret");
});

test("kicking a member removes them from every thread of the channel", async () => {
  seed("#az-kick", "secret", ["bitbonsai", "bob"]);
  thread("#t-az0002", "#az-kick", "secret", ["bitbonsai", "bob"]);
  thread("#t-az0003", "#az-kick", "workspace", ["bitbonsai", "bob"]);
  const response = await app.request("/api/channels/az-kick/kick", { method: "POST", headers: admin, body: JSON.stringify({ nick: "bob", reason: "" }) });
  expect(response.status).toBe(204);
  expect(members("#t-az0002")).toEqual(["bitbonsai"]);
  expect(members("#t-az0003")).toEqual(["bitbonsai"]);
  const removed = calls.find((call) => call.fn === "removeFromThreadChannels");
  expect(removed?.args[0]).toBe("bob");
  expect(removed?.args[1]).toEqual(expect.arrayContaining([{ channel: "#t-az0002", revoke: true }, { channel: "#t-az0003", revoke: false }]));
  expect(rooms.threadsFor("bob").map((row) => row.channel)).toEqual([]);
});

test("leaving a channel leaves its threads too", async () => {
  seed("#az-leave", "secret", ["bitbonsai", "bob"]);
  thread("#t-az0004", "#az-leave", "secret", ["bitbonsai", "bob"]);
  expect((await app.request("/api/channels/az-leave/membership", { method: "DELETE", headers: bob })).status).toBe(204);
  expect(members("#t-az0004")).toEqual(["bitbonsai"]);
  expect(calls.find((call) => call.fn === "removeFromThreadChannels")?.args.slice(0, 2)).toEqual(["bob", [{ channel: "#t-az0004", revoke: true }]]);
});

test("a leftover thread row grants nothing without the parent", () => {
  seed("#az-stale", "secret", ["bitbonsai"]);
  thread("#t-az0005", "#az-stale", "secret", ["bitbonsai", "bob"]);
  expect(rooms.isMember("bob", "#t-az0005")).toBe(false);
  expect(rooms.isMember("bitbonsai", "#t-az0005")).toBe(true);
});

test("making a channel secret makes its public threads secret for parent members only", async () => {
  seed("#az-proj", "workspace", ["bitbonsai", "bob"]);
  thread("#t-az0006", "#az-proj", "workspace", ["bitbonsai", "eve"]);
  thread("#t-az0007", "#az-proj", "secret", ["bitbonsai"]);
  expect((await patch("#az-proj", "secret")).status).toBe(200);
  expect(visibility("#t-az0006")).toBe("secret");
  expect(members("#t-az0006")).toEqual(["bitbonsai", "bob"]);
  // An already private thread keeps its own narrower grants.
  expect(members("#t-az0007")).toEqual(["bitbonsai"]);
  expect(calls.find((call) => call.fn === "makeThreadChannelsSecret")?.args).toEqual([["#t-az0006"], ["bitbonsai", "bob"]]);
  expect((await app.request("/api/channels/t-az0006/join", { method: "POST", headers: eve })).status).toBe(404);
  expect(rooms.visibleChannels("eve").map((row) => row.channel).filter((name) => name.includes("az"))).toEqual([]);
});

test("a public thread is not joinable or listed on its own", async () => {
  seed("#az-pub", "workspace", ["bitbonsai"]);
  thread("#t-az0008", "#az-pub", "workspace", ["bitbonsai"]);
  expect((await app.request("/api/channels/t-az0008/join", { method: "POST", headers: eve })).status).toBe(404);
  expect(members("#t-az0008")).toEqual(["bitbonsai"]);
  expect(rooms.visibleChannels("eve").map((row) => row.channel)).not.toContain("#t-az0008");
  expect(rooms.visibleChannels("eve").map((row) => row.channel)).toContain("#az-pub");
});

test("plain channels cannot take thread, DM or group names", async () => {
  for (const name of ["t-az0009", "dm-az-x", "g-az"]) {
    expect((await app.request("/api/channels", { method: "POST", headers: admin, body: JSON.stringify({ name }) })).status).toBe(400);
  }
  expect(calls).toEqual([]);
});
