import "./fixture.ts";
import { createHash } from "node:crypto";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

// Channel list changes reach each affected person's other tabs as a `channels` event. IRC oper
// calls are stubbed; this proves who hears about what, not what Ergo does afterwards.
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({
  ...grants,
  createChannel: async () => {},
  renameChannel: async () => {},
  unregisterChannel: async () => {},
  purgeChannelHistory: async () => {},
  revokeChannelAccess: async () => {},
  grantChannelAccess: async () => {},
  kickChannelMember: async () => {},
}));
const accounts = await import("../src/accounts.ts");
mock.module("../src/accounts.ts", () => ({ ...accounts, ircChannelExists: async () => false }));

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { subscribe } = await import("../src/live.ts");

const token = "channel-live-session";
const auth = { Cookie: `slirc_session=${token}`, "Content-Type": "application/json" };
db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)")
  .run(createHash("sha256").update(token).digest("hex"), Date.now());

const heard: { nick: string; event: string; data: unknown }[] = [];
const stops = ["bitbonsai", "ada"].map((nick) => subscribe(nick, (event, data) => heard.push({ nick, event, data })));
const channelEvents = () => heard.filter((item) => item.event === "channels").map(({ nick, data }) => ({ nick, data }));

afterEach(() => {
  heard.length = 0;
  db.query("DELETE FROM channels WHERE channel LIKE '#live-%'").run();
  db.query("DELETE FROM channel_members WHERE channel LIKE '#live-%'").run();
});

function seed(channel: string, visibility: "workspace" | "secret", members: string[]) {
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, 'bitbonsai', ?, ?)").run(channel, visibility, Date.now());
  for (const nick of members) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?)").run(channel, nick);
}

test("creating a channel tells the creator's other tabs", async () => {
  const response = await app.request("/api/channels", { method: "POST", headers: auth, body: JSON.stringify({ name: "live-new", visibility: "secret" }) });
  expect(response.status).toBe(201);
  expect(channelEvents()).toEqual([{ nick: "bitbonsai", data: { channel: "#live-new", member: true } }]);
});

test("joining and leaving tell only the person who moved", async () => {
  seed("#live-open", "workspace", ["ada"]);
  expect((await app.request("/api/channels/live-open/join", { method: "POST", headers: auth })).status).toBe(200);
  expect((await app.request("/api/channels/live-open/membership", { method: "DELETE", headers: auth })).status).toBe(204);
  expect(channelEvents()).toEqual([
    { nick: "bitbonsai", data: { channel: "#live-open", member: true } },
    { nick: "bitbonsai", data: { channel: "#live-open", member: false } },
  ]);
});

test("rename and delete tell every member", async () => {
  seed("#live-old", "secret", ["bitbonsai", "ada"]);
  const renamed = await app.request("/api/channels/live-old", { method: "PATCH", headers: auth, body: JSON.stringify({ action: "rename", name: "live-renamed" }) });
  expect(renamed.status).toBe(200);
  expect((await app.request("/api/channels/live-renamed", { method: "DELETE", headers: auth })).status).toBe(204);
  const byNick = (nick: string) => channelEvents().filter((item) => item.nick === nick).map((item) => item.data);
  for (const nick of ["bitbonsai", "ada"]) expect(byNick(nick)).toEqual([{ channel: "#live-renamed", member: true }, { channel: "#live-renamed", member: false, deleted: true }]);
});

test("archive and unarchive tell every member, so open pages swap the composer for the read-only bar", async () => {
  seed("#live-arch", "secret", ["bitbonsai", "ada"]);
  for (const action of ["archive", "unarchive"]) {
    const response = await app.request("/api/channels/live-arch", { method: "PATCH", headers: auth, body: JSON.stringify({ action, source: "irc" }) });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { archived: boolean }).archived).toBe(action === "archive");
  }
  const byNick = (nick: string) => channelEvents().filter((item) => item.nick === nick).map((item) => item.data);
  for (const nick of ["bitbonsai", "ada"]) expect(byNick(nick)).toEqual([{ channel: "#live-arch", member: true }, { channel: "#live-arch", member: true }]);
});

test("a topic change sends no channel list event", async () => {
  seed("#live-topic", "secret", ["bitbonsai", "ada"]);
  const response = await app.request("/api/channels/live-topic", { method: "PATCH", headers: auth, body: JSON.stringify({ action: "topic", topic: "hi", source: "irc" }) });
  expect(response.status).toBe(200);
  expect(channelEvents()).toEqual([]);
});

afterAll(() => { for (const stop of stops) stop(); });
