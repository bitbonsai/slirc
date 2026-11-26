// Session agents read uploads with their binding secret as a Bearer token. Access follows the
// agent's own read rules (agentCanReadChannel), custom emoji keep their mode rules, and agent
// responses are never cached.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { testBinding } = await import("./agent-binding.ts");
const { app } = await import("../src/server.ts");

const owner = accountByNick("bitbonsai")!;
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "uploads-agent", sessionFile: "/tmp/uploads-agent.jsonl",
  secret, machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
db.query("UPDATE agent_session_bindings SET status='ready' WHERE id=?").run(binding.id);
db.query("INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)")
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);

const bearer = (token = secret) => ({ headers: { Authorization: `Bearer ${token}` } });
const defaultMode = process.env.SLIRC_MODE;

function upload(id: string, channel: string): void {
  db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES (?, 'bitbonsai', ?, 'image', 'image/webp', ?, ?)")
    .run(id, channel, new Uint8Array([1, 2, 3, 4]), Date.now());
}
function room(channel: string, visibility: string, members: string[]): void {
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, 'bitbonsai', ?, 1)").run(channel, visibility);
  for (const nick of members) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?)").run(channel, nick);
}

beforeEach(() => {
  process.env.SLIRC_MODE = defaultMode;
  for (const table of ["uploads", "custom_emoji", "threads", "channels", "channel_members", "sessions"]) db.query(`DELETE FROM ${table}`).run();
  db.query("UPDATE agent_session_bindings SET status='ready' WHERE id=?").run(binding.id);
  room("#agent-room", "secret", [owner.nick, binding.nick]);
  room("#other-room", "secret", [owner.nick]);
  room("#team", "workspace", [owner.nick, binding.nick]);
});
afterEach(() => { process.env.SLIRC_MODE = defaultMode; });

test("an agent reads uploads from a conversation it belongs to, never cached", async () => {
  upload("agent-upload", "#agent-room");
  const response = await app.request("/uploads/agent-upload", bearer());
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
});

test("an agent cannot read another conversation's upload, and removal takes effect on the next read", async () => {
  upload("other-upload", "#other-room");
  expect((await app.request("/uploads/other-upload", bearer())).status).toBe(403);
  upload("agent-upload", "#agent-room");
  db.query("DELETE FROM channel_members WHERE channel='#agent-room' AND nick=?").run(binding.nick);
  expect((await app.request("/uploads/agent-upload", bearer())).status).toBe(403);
});

test("agent rules are narrower than human ones: workspace rooms, Notes and secret threads under open rooms stay closed", async () => {
  upload("team-upload", "#team");
  expect((await app.request("/uploads/team-upload", bearer())).status).toBe(403);
  upload("notes-upload", `notes:${owner.id}`);
  expect((await app.request("/uploads/notes-upload", bearer())).status).toBe(403);
  room("#t-agent01", "secret", [binding.nick]);
  db.query("INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES ('#t-agent01', '#help', 'm', 'T', '', 'x', '', '', 'bitbonsai', 1, 1)").run();
  upload("thread-upload", "#t-agent01");
  expect((await app.request("/uploads/thread-upload", bearer())).status).toBe(403);
});

test("a secret thread under the agent's room needs the agent in both", async () => {
  room("#t-agent02", "secret", [owner.nick]);
  db.query("INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES ('#t-agent02', '#agent-room', 'm', 'T', '', 'x', '', '', 'bitbonsai', 1, 1)").run();
  upload("child-upload", "#t-agent02");
  expect((await app.request("/uploads/child-upload", bearer())).status).toBe(403);
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#t-agent02', ?)").run(binding.nick);
  expect((await app.request("/uploads/child-upload", bearer())).status).toBe(200);
});

test("a bad, malformed or revoked token is a guest", async () => {
  upload("agent-upload", "#agent-room");
  expect((await app.request("/uploads/agent-upload", bearer("x".repeat(43)))).status).toBe(401);
  expect((await app.request("/uploads/agent-upload", { headers: { Authorization: `Basic ${secret}` } })).status).toBe(401);
  expect((await app.request("/uploads/agent-upload", bearer(`${secret}.`))).status).toBe(401);
  db.query("UPDATE agent_session_bindings SET status='revoked' WHERE id=?").run(binding.id);
  expect((await app.request("/uploads/agent-upload", bearer())).status).toBe(401);
});

test("a signed-in browser keeps its own rules; a Bearer token does not widen them", async () => {
  upload("agent-upload", "#agent-room");
  db.query("INSERT OR IGNORE INTO accounts (nick, email, role, kind, owner, verified_at, created_at) VALUES ('mallory', 'mallory@example.test', 'member', 'human', NULL, 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'mallory', ?)").run(createHash("sha256").update("mallory-session").digest("hex"), Date.now());
  const response = await app.request("/uploads/agent-upload", { headers: { Cookie: "slirc_session=mallory-session", Authorization: `Bearer ${secret}` } });
  expect(response.status).toBe(403);
});

test("open-room uploads stay readable, but an agent's copy is not cached", async () => {
  upload("open-upload", "#help");
  const response = await app.request("/uploads/open-upload", bearer());
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

test("custom emoji keep the private workspace rule: an agent reads them, a guest does not", async () => {
  process.env.SLIRC_MODE = "private_workspace";
  upload("emoji-upload", "#other-room");
  db.query("INSERT INTO custom_emoji (name, upload_id, added_by, created_at) VALUES ('party', 'emoji-upload', 'bitbonsai', 1)").run();
  expect((await app.request("/uploads/emoji-upload")).status).toBe(401);
  expect((await app.request("/uploads/emoji-upload", bearer("x".repeat(43)))).status).toBe(401);
  const agent = await app.request("/uploads/emoji-upload", bearer());
  expect(agent.status).toBe(200);
  expect(agent.headers.get("Cache-Control")).toBe("private, no-store");
});
