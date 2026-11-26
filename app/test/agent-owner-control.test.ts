// Owner control over personal agents (pairing and Allow are in agent-connect.test.ts): removal of an owner taking their agents with them, the admin agent list, agents leaving with
// their owner, and agents joining threads made after they attached.
// IRC-side helpers are replaced with recorders; SQLite and the routes are real.
import "./fixture.ts";
import { beforeEach, expect, mock, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

const calls = { join: [] as string[], evict: [] as string[], disconnect: [] as string[], revoke: [] as string[], removed: [] as string[] };

const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({
  ...grants,
  revokeChannelAccess: async (channel: string, nick: string) => { calls.revoke.push(`${nick} ${channel}`); },
  grantChannelAccess: async () => {}, allowChannelAccess: async () => {}, kickChannelMember: async () => {},
  removeMemberFromIrc: async () => {}, createThreadChannel: async () => {}, unregisterChannel: async () => {}, removeFromThreadChannels: async () => {},
  readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }),
}));
mock.module("../src/irc-certificates.ts", () => ({
  addCertificate: async () => {}, normalizeCertificateFingerprint: (value: string) => value,
  listCertificates: async () => [], removeCertificate: async () => {},
}));
const accounts = await import("../src/accounts.ts");
mock.module("../src/accounts.ts", () => ({ ...accounts, ircChannelExists: async () => false }));
const agentAccounts = await import("../src/agent-accounts.ts");
mock.module("../src/agent-accounts.ts", () => ({
  ...agentAccounts,
  removeAgentAccount: async (nick: string) => {
    calls.removed.push(nick);
    db.query("DELETE FROM channel_members WHERE nick = ?").run(nick);
    db.query("DELETE FROM accounts WHERE nick = ?").run(nick);
  },
}));
const transport = await import("../src/agent-session-transport.ts");
mock.module("../src/agent-session-transport.ts", () => ({
  ...transport,
  connectAgentTransport: async () => {},
  joinAgentRoomForNick: async (nick: string, channel: string) => { calls.join.push(`${nick} ${channel}`); },
  evictAgentRoomForNick: (nick: string, channel: string) => { calls.evict.push(`${nick} ${channel}`); },
  disconnectAgentTransport: (id: string) => { calls.disconnect.push(id); },
}));

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { authenticateBinding } = await import("../src/agent-session.ts");
const { resetConnectThrottleForTests } = await import("../src/agent-connect.ts");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const as = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });
const ada = as("ada-session");
const admin = as("admin-session");
const agentSecret = randomBytes(32).toString("base64url");
const members = (channel: string) => (db.query("SELECT nick FROM channel_members WHERE channel = ? ORDER BY nick").all(channel) as { nick: string }[]).map((row) => row.nick);
const bindingStatus = () => (db.query("SELECT status FROM agent_session_bindings WHERE nick = 'pi-ada'").get() as { status: string } | null)?.status;

beforeEach(() => {
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key].length = 0;
  resetConnectThrottleForTests();
  for (const table of ["agent_connect_requests", "agent_session_bindings", "sessions", "threads", "channel_members", "channels", "meta"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query("INSERT INTO accounts (nick, email, kind, owner, verified_at, created_at) VALUES ('ada', 'ada@test.invalid', 'human', NULL, 1, 1), ('pi-ada', 'pi-ada@agents.invalid', 'agent', 'ada', 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'ada', ?), (?, 'bitbonsai', ?)").run(hash("ada-session"), Date.now(), hash("admin-session"), Date.now());
  const ids = (nick: string) => (db.query("SELECT account_id FROM accounts WHERE nick = ?").get(nick) as { account_id: string }).account_id;
  db.query(`INSERT INTO agent_session_bindings (id, instance_id, owner_account_id, owner_nick, harness, session_id, session_file, secret_hash, nick, dm, agent_account_id, status, machine, session_name, created_at, confirmed_at)
    VALUES ('b-ada', 'i', ?, 'ada', 'pi', 's-ada', '/tmp/s-ada.jsonl', ?, 'pi-ada', '#dm-ada-pi', ?, 'ready', 'laptop', 'fixer', 1, 1)`).run(ids("ada"), hash(agentSecret), ids("pi-ada"));
  db.exec(`INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#vault', 'bitbonsai', 'secret', 1), ('#t-vault1', 'bitbonsai', 'secret', 1), ('#dm-ada-pi', 'ada', 'direct', 1), ('#lab', 'ada', 'secret', 1);
    INSERT INTO channel_members (channel, nick) VALUES ('#vault', 'bitbonsai'), ('#vault', 'ada'), ('#vault', 'pi-ada'),
      ('#t-vault1', 'bitbonsai'), ('#t-vault1', 'ada'), ('#t-vault1', 'pi-ada'), ('#dm-ada-pi', 'ada'), ('#dm-ada-pi', 'pi-ada'), ('#lab', 'ada');
    INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-vault1', '#vault', 'root-1', 'old thread', '/t', 'ada', 1, 1);`);
});

test("a removed owner's agents stop at once and are removed with them", async () => {
  expect(authenticateBinding(agentSecret)?.nick).toBe("pi-ada");
  const response = await app.request("/api/admin/accounts/ada", { method: "DELETE", headers: admin });
  expect(response.status).toBe(204);
  expect(authenticateBinding(agentSecret)).toBeNull();
  expect(bindingStatus()).toBe("revoked");
  expect(calls.disconnect).toEqual(["b-ada"]);
  expect(calls.removed).toEqual(["pi-ada"]);
});

test("a removed owner's binding fails authorization even before teardown", () => {
  db.query("UPDATE accounts SET removed_at = ? WHERE nick = 'ada'").run(Date.now());
  expect(authenticateBinding(agentSecret)).toBeNull();
});

test("admins list every agent with its owner and channels, and can remove any of them", async () => {
  expect((await app.request("/api/admin/agents", { headers: ada })).status).toBe(403);
  const list = await (await app.request("/api/admin/agents", { headers: admin })).json();
  expect(list).toEqual([{ nick: "pi-ada", owner: "ada", createdAt: 1, name: "fixer", harness: "pi", status: "offline", channels: ["#vault"] }]);
  expect((await app.request("/api/admin/agents/pi-ada", { method: "DELETE", headers: ada })).status).toBe(403);
  expect((await app.request("/api/admin/agents/pi-ada", { method: "DELETE", headers: admin })).status).toBe(204);
  expect(bindingStatus()).toBe("revoked");
  expect(calls.removed).toEqual(["pi-ada"]);
  expect((await app.request("/api/admin/agents/pi-ada", { method: "DELETE", headers: admin })).status).toBe(404);
});

test("when the owner leaves a channel, their agent leaves it and its threads", async () => {
  expect((await app.request("/api/channels/vault/membership", { method: "DELETE", headers: ada })).status).toBe(204);
  expect(members("#vault")).toEqual(["bitbonsai"]);
  // The owner leaves the channel's threads with it.
  expect(members("#t-vault1")).toEqual(["bitbonsai"]);
  expect(calls.evict.sort()).toEqual(["ada #t-vault1", "pi-ada #t-vault1", "pi-ada #vault"]);
  expect(calls.revoke).toEqual(expect.arrayContaining(["pi-ada #vault", "pi-ada #t-vault1"]));
  // The agent keeps its DM with the owner.
  expect(members("#dm-ada-pi")).toEqual(["ada", "pi-ada"]);
});

test("when an admin removes the owner from a channel, their agent goes too", async () => {
  const response = await app.request("/api/channels/vault/kick", { method: "POST", headers: admin, body: JSON.stringify({ nick: "ada", reason: "" }) });
  expect(response.status).toBe(204);
  expect(members("#vault")).toEqual(["bitbonsai"]);
  expect(members("#t-vault1")).not.toContain("pi-ada");
  expect(calls.evict).toEqual(expect.arrayContaining(["ada #vault", "pi-ada #vault", "pi-ada #t-vault1"]));
});

test("adding an agent to a private channel joins it there", async () => {
  const response = await app.request("/api/channels/lab/members", { method: "POST", headers: ada, body: JSON.stringify({ nick: "pi-ada" }) });
  expect(response.status).toBe(200);
  expect(members("#lab")).toContain("pi-ada");
  expect(calls.join).toContain("pi-ada #lab");
});
