// /auth/me carries the authoritative configured open-channel list so the client can mark open
// channels before any room is selected, without inferring from a member fetch. One file per process.
import "./fixture.ts";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const ENV_KEYS = ["SLIRC_DEV_PROFILE", "SLIRC_IRC_LOCAL_DEV", "SLIRC_IRC_HOST", "SLIRC_IRC_PORT"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
async function ircMeta(headers: Record<string, string> = {}): Promise<unknown> {
  const response = await app.request("/auth/me", { headers: { Cookie: "slirc_session=owner-session", ...headers } });
  return (await response.json() as { irc: unknown }).irc;
}

beforeEach(() => {
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM channel_members").run();
  db.query("DELETE FROM channels").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(hash("owner-session"), Date.now());
});

test("/auth/me exposes configured open channels and never an unreadable secret one", async () => {
  // A secret room the caller belongs to, and one they cannot see at all.
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#vault', 'bitbonsai', 'secret', 1), ('#other-vault', 'someone', 'secret', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#vault', 'bitbonsai'), ('#other-vault', 'someone')").run();

  const response = await app.request("/auth/me", { headers: { Cookie: "slirc_session=owner-session" } });
  expect(response.status).toBe(200);
  const me = await response.json() as { openChannels: string[]; channels: string[]; channelDetails: { channel: string }[] };
  // OPEN_CHANNELS in the fixture is "#help, #support"; these have no SQLite channels row.
  expect(me.openChannels).toEqual(["#help", "#support"]);
  expect(me.openChannels).not.toContain("#vault");
  expect(me.openChannels).not.toContain("#other-vault");
  // The caller's own secret room stays reachable via channelDetails, never via the open list.
  expect(me.channels).toEqual(expect.arrayContaining(["#help", "#support", "#vault"]));
  expect(me.channelDetails.map((detail) => detail.channel)).toContain("#vault");
  expect(me.channelDetails.map((detail) => detail.channel)).not.toContain("#other-vault");
  expect((await (await app.request("/auth/me", { headers: { Cookie: "slirc_session=owner-session" } })).json() as { isFounder: boolean }).isFounder).toBe(true);
});

test("/auth/me account details carry each person's avatar version", async () => {
  db.query("INSERT INTO profiles (account, avatar_path, avatar_version) VALUES ('bitbonsai', '/tmp/none', 9) ON CONFLICT(account) DO UPDATE SET avatar_path = excluded.avatar_path, avatar_version = excluded.avatar_version").run();
  const me = await (await app.request("/auth/me", { headers: { Cookie: "slirc_session=owner-session" } })).json() as { accountDetails: { nick: string; avatarVersion: number }[]; profile: { avatarVersion: number; avatarUrl: string } };
  expect(me.accountDetails.find((entry) => entry.nick === "bitbonsai")?.avatarVersion).toBe(9);
  expect(me.profile).toMatchObject({ avatarVersion: 9, avatarUrl: "/avatars/bitbonsai?v=9" });
});

test("/auth/me marks an admin as founder only when its immutable account matches the owner", async () => {
  db.query("INSERT INTO accounts (nick,email,role,kind,verified_at,created_at) VALUES ('otheradmin','other@example.test','admin','human',1,1)").run();
  db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?, 'otheradmin', ?)").run(hash("other-admin-session"), Date.now());
  const response = await app.request("/auth/me", { headers: { Cookie: "slirc_session=other-admin-session" } });
  expect(response.status).toBe(200);
  expect((await response.json() as { isFounder: boolean }).isFounder).toBe(false);
  const denied = await app.request("/api/admissions", { headers: { Cookie: "slirc_session=other-admin-session" } });
  expect(denied.status).toBe(404);
});

test("/prelaunch serves the client shell for direct route loads", async () => {
  const response = await app.request("/prelaunch");
  expect(response.status).toBe(200);
  expect(await response.text()).toMatch(/src="\/client\.js\?v=[a-f0-9]{8}"/);
});

test("/auth/me advertises production verified TLS without any self-signed exception", async () => {
  setEnv({});
  expect(await ircMeta()).toEqual({ host: "", port: 6697, tls: true, allowSelfSigned: false, local: false });
});

test("/auth/me advertises the isolated loopback dev endpoint with a self-signed exception", async () => {
  setEnv({ SLIRC_DEV_PROFILE: "slirc2" });
  expect(await ircMeta()).toEqual({ host: "127.0.0.1", port: 6797, tls: true, allowSelfSigned: true, local: true });
});

test("a non-loopback dev host never gets the self-signed exception", async () => {
  setEnv({ SLIRC_DEV_PROFILE: "slirc2", SLIRC_IRC_HOST: "irc.example.com", SLIRC_IRC_PORT: "6697" });
  expect(await ircMeta()).toEqual({ host: "irc.example.com", port: 6697, tls: true, allowSelfSigned: false, local: false });
});

test("a plain-HTTP request origin never weakens advertised IRC trust", async () => {
  setEnv({ SLIRC_IRC_HOST: "irc.example.com", SLIRC_IRC_PORT: "6697" });
  expect(await ircMeta({ "X-Forwarded-Proto": "http" })).toEqual({ host: "irc.example.com", port: 6697, tls: true, allowSelfSigned: false, local: false });
});
