import "./fixture.ts";
import { expect, mock, test } from "bun:test";

// Long-poll events route: same auth, lease and event objects as the SSE stream, 204 when quiet,
// lease renewed per poll. Local IRC/grants mocks only; not live-Ergo or adapter evidence.
const irc = await import("../src/irc.ts");
let options: any;
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline"]);
    constructor(value: any) { options = value; }
    async connect() {}
    send(_line: string) { return true; }
    quit() {}
  },
}));
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }) }));

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease, renameBinding, LEASE_MS } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { connectAgentTransport, agentAttached, wakeAgent } = await import("../src/agent-session-transport.ts");
const { app } = await import("../src/server.ts");

const owner = accountByNick("bitbonsai")!;
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "poll-test", sessionFile: "poll-test",
  secret, machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-poll-test";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
db.query(`INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)`)
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
await connectAgentTransport(binding);
options.onMessage({ command: "JOIN", params: [binding.dm], tags: {}, prefix: `${binding.nick}!u@host` });
let lease = bindLease(binding, "poll-incarnation-00000000001")!.leaseId;

const poll = (wait: number | string, headers: Record<string, string> = { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": lease }) =>
  app.request(`/api/agent/session/events/poll?wait=${wait}`, { headers });
const say = (msgid: string, text: string) =>
  options.onMessage({ command: "PRIVMSG", params: [binding.dm, text], tags: { account: owner.nick, msgid }, prefix: `${owner.nick}!u@host` });
const leaseExpiry = () => (db.query("SELECT lease_expires_at FROM agent_session_bindings WHERE id=?").get(binding.id) as { lease_expires_at: number | null }).lease_expires_at;

test("polling needs the binding secret and its current lease", async () => {
  expect((await poll(0, {})).status).toBe(401);
  expect((await poll(0, { Authorization: `Bearer ${secret}` })).status).toBe(401);
  expect((await poll(0, { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": "not-the-lease" })).status).toBe(401);
  const wrong = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  expect((await poll(0, { Authorization: `Bearer ${wrong}`, "X-Slirc-Agent-Lease": lease })).status).toBe(401);
});

test("a quiet poll answers 204 after the wait, and wait is capped at 25 seconds", async () => {
  const started = Date.now();
  const response = await poll(0.3);
  expect(response.status).toBe(204);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  expect((await poll(0)).status).toBe(204);
  expect((await import("../src/server.ts")).AGENT_POLL_MAX_WAIT_S).toBe(25);
});

test("offered requests come back as the SSE requests event, at once for news and once per window after", async () => {
  say("poll-1", "run the tests");
  const first = await poll(5);
  expect(first.status).toBe(200);
  const { events } = await first.json();
  expect(events).toHaveLength(1);
  expect(events[0].event).toBe("requests");
  expect(events[0].data).toHaveLength(1);
  expect(Object.keys(events[0].data[0]).sort()).toEqual(["context", "current_msgid", "id", "reply_channel", "revision", "source_channel", "status", "text"]);
  expect(events[0].data[0]).toMatchObject({ source_channel: binding.dm, reply_channel: binding.dm, current_msgid: "poll-1", revision: 1, text: "run the tests", context: "[]", status: "offered" });

  // Already delivered to this lease: held until the window ends, then repeated once.
  const started = Date.now();
  const repeat = await poll(0.4);
  expect(Date.now() - started).toBeGreaterThanOrEqual(380);
  expect((await repeat.json()).events[0].data.map((row: any) => row.current_msgid)).toEqual(["poll-1"]);

  // A waiting poll wakes as soon as a new request arrives.
  const waiting = poll(10);
  await Bun.sleep(50);
  const woke = Date.now();
  say("poll-2", "and the linter");
  const fresh = await waiting;
  expect(Date.now() - woke).toBeLessThan(1_000);
  expect((await fresh.json()).events[0].data.map((row: any) => row.current_msgid)).toEqual(["poll-1", "poll-2"]);
  db.query("DELETE FROM agent_session_requests WHERE binding_id=?").run(binding.id);
});

test("an owner rename reaches a polling lease once", async () => {
  renameBinding(binding, "release prep");
  wakeAgent(binding.id);
  const response = await poll(5);
  expect(await response.json()).toEqual({ events: [{ event: "rename", data: { name: "release prep" } }] });
  expect((await poll(0)).status).toBe(204);
  // A new lease is a new runtime and gets the still-pending rename again.
  db.query("UPDATE agent_session_bindings SET lease_id=NULL,lease_nonce=NULL,lease_expires_at=NULL WHERE id=?").run(binding.id);
  lease = bindLease(binding, "poll-incarnation-00000000002")!.leaseId;
  expect((await (await poll(0)).json()).events).toEqual([{ event: "rename", data: { name: "release prep" } }]);
  db.query("UPDATE agent_session_bindings SET rename_pending=NULL WHERE id=?").run(binding.id);
});

test("each poll renews the lease, and presence goes offline once polls stop past the lease", async () => {
  db.query("UPDATE agent_session_bindings SET lease_expires_at=? WHERE id=?").run(Date.now() + 1_000, binding.id);
  const before = Date.now();
  expect((await poll(0)).status).toBe(204);
  expect(leaseExpiry()!).toBeGreaterThanOrEqual(before + LEASE_MS);
  expect(agentAttached(binding.nick)).toBe(true);
  // No poll or heartbeat for longer than the lease.
  db.query("UPDATE agent_session_bindings SET lease_expires_at=? WHERE id=?").run(Date.now() - 1, binding.id);
  expect(agentAttached(binding.nick)).toBe(false);
  expect((await poll(0)).status).toBe(401);
});

test("a poll whose lease is detached mid-wait ends with 401 and no content", async () => {
  db.query("UPDATE agent_session_bindings SET lease_id=NULL,lease_nonce=NULL,lease_expires_at=NULL WHERE id=?").run(binding.id);
  lease = bindLease(binding, "poll-incarnation-00000000003")!.leaseId;
  const waiting = poll(1);
  await Bun.sleep(50);
  await app.request("/api/agent/session/detach", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": lease } });
  say("poll-3", "after detach");
  const response = await waiting;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("after detach");
});
