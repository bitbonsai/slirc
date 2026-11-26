import "./fixture.ts";
import { expect, mock, test } from "bun:test";

// Focused route tests for the adapter-facing accept/status contract. Local protocol mocks only.
const irc = await import("../src/irc.ts");
let options: any;
const sent: string[] = [];
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline"]);
    constructor(value: any) { options = value; }
    async connect() {}
    send(line: string) { sent.push(line); return true; }
    quit() {}
  },
}));
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }) }));

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { connectAgentTransport, ownerAgentRequestStates, syncAgentPresence } = await import("../src/agent-session-transport.ts");
const { subscribe } = await import("../src/live.ts");
const { app } = await import("../src/server.ts");

const owner = accountByNick("bitbonsai")!;
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "accept-route", sessionFile: "/tmp/accept-route.jsonl",
  secret, machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-accept-route";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
db.query(`INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)`)
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
await connectAgentTransport(binding);
const emit = (command: string, params: string[], tags: Record<string, string> = {}, prefix = `${owner.nick}!u@host`) =>
  options.onMessage({ command, params, tags, prefix });
emit("JOIN", [binding.dm], {}, `${binding.nick}!u@host`);
const lease = bindLease(binding, "accept-route-incarnation-01")!;
const auth = { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": lease.leaseId, "Content-Type": "application/json" };

test("accept reports busy versus stale, and status reports whether this lease accepted", async () => {
  emit("PRIVMSG", [binding.dm, "first work"], { account: owner.nick, msgid: "route-1" });
  const first = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='route-1'").get() as any;
  const states = () => ownerAgentRequestStates(owner.nick).requests;
  const updates: any[] = [];
  const unsubscribe = subscribe(owner.nick, (event, data) => { if (event === "agent-requests") updates.push(data); });
  const start = (id = first.id, headers = auth) => app.request(`/api/agent/session/requests/${id}/started`, { method: "POST", headers, body: "{}" });
  expect(states()).toEqual([{ channel: binding.dm, messageId: "route-1", state: "Queued" }]);
  expect(ownerAgentRequestStates("someone-else").requests).toEqual([]);
  expect((await start()).status).toBe(409); // Offered is not accepted by this lease yet.
  expect((await start(first.id, { ...auth, "X-Slirc-Agent-Lease": "wrong" })).status).toBe(401);
  expect((await start(first.id, {} as any)).status).toBe(401);
  // Wrong revision is a proven stale refusal.
  const stale = await app.request(`/api/agent/session/requests/${first.id}/accept`, { method: "POST", headers: auth, body: JSON.stringify({ revision: 99 }) });
  expect(stale.status).toBe(409);
  expect((await stale.json()).code).toBe("stale");
  const accepted = await app.request(`/api/agent/session/requests/${first.id}/accept`, { method: "POST", headers: auth, body: JSON.stringify({ revision: 1 }) });
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).destination).toBe(binding.dm);
  expect(states()[0].state).toBe("Queued");
  expect((await start(crypto.randomUUID())).status).toBe(409);
  expect((await start()).status).toBe(200);
  const startedAt = (db.query("SELECT started_at FROM agent_session_requests WHERE id=?").get(first.id) as any).started_at;
  expect(startedAt).toBeGreaterThan(0);
  expect((await start()).status).toBe(200);
  expect((db.query("SELECT started_at FROM agent_session_requests WHERE id=?").get(first.id) as any).started_at).toBe(startedAt);
  expect(states()[0].state).toBe("Working");
  expect(updates.at(-1)).toMatchObject({ accountId: owner.id, requests: [{ messageId: "route-1", state: "Working" }] });

  // A sibling gets a typed busy refusal, not an ambiguous error.
  emit("PRIVMSG", [binding.dm, "second work"], { account: owner.nick, msgid: "route-2" });
  const second = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='route-2'").get() as any;
  const busy = await app.request(`/api/agent/session/requests/${second.id}/accept`, { method: "POST", headers: auth, body: JSON.stringify({ revision: 1 }) });
  expect(busy.status).toBe(409);
  expect((await busy.json()).code).toBe("busy");
  expect(states().map((row) => [row.messageId, row.state])).toEqual([["route-1", "Working"], ["route-2", "Queued"]]);
  expect((await start(second.id)).status).toBe(409);

  const status = await app.request(`/api/agent/session/requests/${first.id}`, { headers: { ...auth, "Content-Type": undefined } as any });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ id: first.id, status: "accepted", acceptedByLease: true });
  expect((await app.request(`/api/agent/session/requests/${first.id}`)).status).toBe(401);

  // A reply over Ergo's 4,096-byte multiline limit would be refused whole by Ergo, so it is refused
  // here first and nothing is reserved. A larger JSON body is rejected by the body limit rather
  // than silently truncating. A reply that fits one IRC line is accepted.
  const overText = await app.request(`/api/agent/session/requests/${first.id}/reply`, { method: "POST", headers: auth, body: JSON.stringify({ text: "b".repeat(4_001) }) });
  expect(overText.status).toBe(409);
  expect((await overText.json() as any).error).toContain("too long");
  const exact = await app.request(`/api/agent/session/requests/${first.id}/reply`, { method: "POST", headers: auth, body: JSON.stringify({ text: "a".repeat(400) }) });
  expect(exact.status).toBe(200);
  const overBody = await app.request(`/api/agent/session/requests/${first.id}/reply`, { method: "POST", headers: auth, body: JSON.stringify({ text: "c".repeat(50_000) }) });
  expect(overBody.status).toBe(413);
  expect(states()[0].state).toBe("Working"); // A submitted reply is not a confirmed echo.
  const reply = db.query("SELECT reply_cid,reply_text FROM agent_session_requests WHERE id=?").get(first.id) as any;
  emit("PRIVMSG", [binding.dm, reply.reply_text], { "+slirc/cid": reply.reply_cid, msgid: "reply-1" }, `${binding.nick}!u@host`);
  expect(states()).toEqual([{ channel: binding.dm, messageId: "route-2", state: "Queued" }]);
  expect((await start()).status).toBe(409);
  expect(updates.at(-1).requests).toEqual(states());
  // An expired attachment clears the owner's labels without making the requests replayable.
  db.query("UPDATE agent_session_bindings SET lease_expires_at=? WHERE id=?").run(Date.now() - 1, binding.id);
  syncAgentPresence();
  expect(states()).toEqual([]);
  expect(updates.at(-1).requests).toEqual([]);
  expect((await start(second.id)).status).toBe(401);
  unsubscribe();
});
