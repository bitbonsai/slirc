import "./fixture.ts";
import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.env.SLIRC_CLIENT_V2 = "true";
const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { agentCanReadChannel, joinWorkspaceChannel } = await import("../src/rooms.ts");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const auth = (token = "agent-owner") => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });

beforeEach(() => {
  for (const table of ["agent_connect_requests", "sessions", "threads", "direct_conversations", "channel_members", "channels"]) db.exec(`DELETE FROM ${table}`);
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query("INSERT INTO accounts (nick, email, kind, owner, verified_at, created_at) VALUES ('pi-owner', 'pi@test.invalid', 'agent', 'bitbonsai', 1, 1), ('other', 'other@test.invalid', 'human', NULL, 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', 1), (?, 'other', 1)").run(hash("agent-owner"), hash("other-session"));
  db.exec(`INSERT INTO channels (channel, owner, visibility, created_at) VALUES
    ('#vault', 'bitbonsai', 'secret', 1), ('#garden', 'bitbonsai', 'workspace', 1),
    ('#dm-owner', 'bitbonsai', 'direct', 1), ('#t-vault', 'bitbonsai', 'secret', 1);
    INSERT INTO channel_members (channel, nick) VALUES
    ('#vault', 'bitbonsai'), ('#vault', 'other'), ('#garden', 'bitbonsai'),
    ('#vault', 'pi-owner'), ('#garden', 'pi-owner'), ('#dm-owner', 'pi-owner'),
    ('#t-vault', 'pi-owner'), ('#missing', 'pi-owner');
    INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity)
    VALUES ('#t-vault', '#vault', 'root', 'test', '/test', 'bitbonsai', 1, 1);`);
});

async function invite(channel: string, token = "agent-owner") {
  return app.request(`/api/channels/${channel}/members`, {
    method: "POST", headers: auth(token), body: JSON.stringify({ nick: "pi-owner", invite: "self" }),
  });
}

async function agentRooms() {
  const response = await app.request("/api/agent/rooms", {
    headers: { Authorization: `Basic ${Buffer.from("pi-owner:test-password").toString("base64")}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()).rooms as string[];
}

test("capabilities are authenticated, no-store and list the released harnesses", async () => {
  expect((await app.request("/api/agents/capabilities")).status).toBe(401);
  const response = await app.request("/api/agents/capabilities", { headers: auth() });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({
    enabled: true, reason: "", harnesses: [{ id: "pi", name: "Pi" }, { id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex", terminal: true }, { id: "opencode", name: "OpenCode" }],
    commands: { workspace: "app.example.test", npx: "npx slirc-agent@latest app.example.test", bunx: "bunx slirc-agent@latest app.example.test", session: { pi: "/slirc app.example.test", "claude": "/slirc app.example.test", codex: "slirc app.example.test", opencode: "/slirc app.example.test" } },
  });
});

test("the legacy connect route stays closed and hands out no credentials", async () => {
  const responses = await Promise.all(["session-one", "session-two"].map((sessionId) => app.request("/api/agent/connect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "123456", harness: "pi", sessionId }),
  })));
  expect(responses.map((response) => response.status)).toEqual([409, 409]);
  for (const response of responses) expect(JSON.stringify(await response.json())).not.toMatch(/password/i);
  expect(db.query("SELECT COUNT(*) AS count FROM agent_connect_requests").get()).toEqual({ count: 0 });
  expect(db.query("SELECT COUNT(*) AS count FROM accounts WHERE kind = 'agent'").get()).toEqual({ count: 1 });
});

test("agent list stays owner-scoped and never derives readiness from IRC", async () => {
  const response = await app.request("/api/agents", { headers: auth() });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual([{ nick: "pi-owner", machine: null, status: "unknown", agent: null, bindingId: null, lastSeen: null }]);
  expect(await (await app.request("/api/agents", { headers: auth("other-session") })).json()).toEqual([]);
});

test("agents attach to open and workspace channels only through an owner-only grant", async () => {
  const open = await invite("help");
  expect(open.status).toBe(200);
  expect(await open.json()).toMatchObject({ channel: "#help", nick: "pi-owner", added: true });
  expect(db.query("SELECT owner_only FROM channel_members WHERE channel = '#help' AND nick = 'pi-owner'").get()).toEqual({ owner_only: 1 });
  db.exec("DELETE FROM channel_members WHERE channel = '#garden' AND nick = 'pi-owner'");
  expect((await invite("garden")).status).toBe(200);
  expect(db.query("SELECT owner_only FROM channel_members WHERE channel = '#garden' AND nick = 'pi-owner'").get()).toEqual({ owner_only: 1 });
  // Another person still cannot attach someone else's agent anywhere.
  db.exec("DELETE FROM channel_members WHERE channel = '#help' AND nick = 'pi-owner'");
  expect((await invite("help", "other-session")).status).toBe(403);
});

test("secret-channel invitation requires the agent owner and channel membership", async () => {
  expect((await invite("vault", "other-session")).status).toBe(403);
  const existing = await invite("vault");
  expect(existing.status).toBe(200);
  expect(await existing.json()).toEqual({ channel: "#vault", nick: "pi-owner", added: false });
  db.exec("DELETE FROM channel_members WHERE channel = '#vault' AND nick = 'bitbonsai'");
  expect((await invite("vault")).status).toBe(403);
});

test("workspace join helper denies agents without changing human joins", () => {
  db.exec("DELETE FROM channel_members WHERE channel = '#garden' AND nick = 'pi-owner'");
  expect(joinWorkspaceChannel("pi-owner", "#garden")).toBe(false);
  expect(db.query("SELECT 1 FROM channel_members WHERE channel = '#garden' AND nick = 'pi-owner'").get()).toBeNull();
  expect(joinWorkspaceChannel("other", "#garden")).toBe(true);
});

test("agent room discovery allows only readable private rooms and threads", async () => {
  expect((await agentRooms()).sort()).toEqual(["#dm-owner", "#t-vault", "#vault"]);
  expect(agentCanReadChannel("pi-owner", "#missing")).toBe(false);
  db.exec("UPDATE channels SET visibility = 'workspace' WHERE channel = '#vault'");
  expect((await agentRooms()).sort()).toEqual(["#dm-owner"]);
});

test("a private child cannot survive revoked parent or child membership", () => {
  expect(agentCanReadChannel("pi-owner", "#t-vault")).toBe(true);
  db.exec("DELETE FROM channel_members WHERE channel = '#vault' AND nick = 'pi-owner'");
  expect(agentCanReadChannel("pi-owner", "#t-vault")).toBe(false);
  db.exec("INSERT INTO channel_members (channel, nick) VALUES ('#vault', 'pi-owner'); DELETE FROM channel_members WHERE channel = '#t-vault' AND nick = 'pi-owner'");
  expect(agentCanReadChannel("pi-owner", "#t-vault")).toBe(false);
});

test("corrupt thread cycles fail closed rather than hanging discovery", () => {
  db.exec("UPDATE threads SET parent = '#t-vault' WHERE channel = '#t-vault'");
  expect(agentCanReadChannel("pi-owner", "#t-vault")).toBe(false);
});
