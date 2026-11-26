// /kick: an admin removes someone from one channel. IRC gets the KICK and, in a private channel,
// loses the invite exception; the app drops the membership row. Refused for non-admins (channel
// owners included), for admins as targets, and for yourself.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, expect, mock, test } from "bun:test";

const kicks: string[] = [];
const revokes: string[] = [];
mock.module("../src/grants.ts", () => {
  const noop = async () => {};
  return {
    operClient: noop, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }), readDirectChannelReady: async () => true,
    serviceCommand: noop, setAlwaysOn: noop, transferChannel: noop, allowChannelAccess: noop,
    grantChannelAccess: noop, createChannel: noop, setChannelMode: noop, setChannelTopic: noop,
    revokeChannelAccess: async (channel: string, nick: string) => { revokes.push(`${channel} ${nick}`); },
    createDirectChannel: noop, createThreadChannel: noop,
    NotAuthorizedError: class NotAuthorizedError extends Error {}, redactMessage: noop,
    kickChannelMember: async (channel: string, nick: string, reason: string) => { kicks.push(`${channel} ${nick} :${reason}`); },
    makeChannelSecret: noop, makeThreadChannelsSecret: noop, removeFromThreadChannels: noop, makeChannelOpen: noop, clearChannelAccess: noop,
    unregisterChannel: noop, purgeChannelHistory: noop, renameChannel: noop, grantChannelOps: noop,
    removeMemberFromIrc: async () => ({ suspended: true }),
  };
});

process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const headers = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json", Origin: process.env.APP_ORIGIN || "http://localhost" });
const kick = (token: string, channel: string, nick: string, reason = "") =>
  app.request(`/api/channels/${channel}/kick`, { method: "POST", headers: headers(token), body: JSON.stringify({ nick, reason }) });
const members = (channel: string) => (db.query("SELECT nick FROM channel_members WHERE channel = ? ORDER BY nick").all(channel) as { nick: string }[]).map((row) => row.nick);
const addHuman = (nick: string, role = "member") =>
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES (?, ?, ?, 1, 1)").run(nick, `${nick}@example.com`, role);
const addSession = (nick: string, token: string) => db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(sha(token), nick, Date.now());

beforeEach(() => {
  kicks.length = 0;
  revokes.length = 0;
  db.exec("DELETE FROM sessions; DELETE FROM channel_members; DELETE FROM channels");
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query("UPDATE accounts SET role = 'admin', verified_at = COALESCE(verified_at, 1), removed_at = NULL WHERE nick = 'bitbonsai'").run();
  addHuman("ada", "admin");
  addHuman("ben");
  addHuman("cy");
  // cy owns #vault but is not an admin.
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#vault', 'cy', 'secret', 1), ('#lounge', 'cy', 'workspace', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#vault', 'bitbonsai'), ('#vault', 'ada'), ('#vault', 'ben'), ('#vault', 'cy'), ('#lounge', 'ben'), ('#lounge', 'cy')").run();
  addSession("bitbonsai", "admin-token");
  addSession("ada", "ada-token");
  addSession("ben", "ben-token");
  addSession("cy", "cy-token");
});

test("an admin kicks a member: IRC KICK, invite exception dropped, membership gone", async () => {
  expect((await kick("admin-token", "vault", "ben", "spam")).status).toBe(204);
  expect(kicks).toEqual(["#vault ben :spam"]);
  expect(revokes).toEqual(["#vault ben"]);
  expect(members("#vault")).toEqual(["ada", "bitbonsai", "cy"]);
});

test("a kick without a reason says an admin removed them; a workspace channel has no invite list to drop", async () => {
  expect((await kick("ada-token", "lounge", "ben")).status).toBe(204);
  expect(kicks).toEqual(["#lounge ben :Removed by an admin"]);
  expect(revokes).toEqual([]);
  expect(members("#lounge")).toEqual(["cy"]);
});

test("admins can't kick other admins or themselves", async () => {
  const refused = await kick("admin-token", "vault", "ada");
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toBe("You can't kick an admin.");
  expect((await kick("ada-token", "vault", "bitbonsai")).status).toBe(403);
  expect((await kick("admin-token", "vault", "bitbonsai")).status).toBe(400);
  expect(kicks).toEqual([]);
  expect(members("#vault")).toEqual(["ada", "ben", "bitbonsai", "cy"]);
});

test("members and channel owners who are not admins can't kick", async () => {
  expect((await kick("ben-token", "vault", "cy")).status).toBe(403);
  expect((await kick("cy-token", "vault", "ben")).status).toBe(403);
  expect(kicks).toEqual([]);
  expect(members("#vault")).toEqual(["ada", "ben", "bitbonsai", "cy"]);
});

test("kicking someone who isn't in the channel is a 404", async () => {
  expect((await kick("admin-token", "lounge", "ada")).status).toBe(404);
  expect(kicks).toEqual([]);
});
