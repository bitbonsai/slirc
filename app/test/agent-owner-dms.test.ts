import "./fixture.ts";
import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

// "Can read my DMs": an owner's agent reads the owner's DMs through the server, never by joining
// them. Every IRC connection is a local protocol mock; each one records what it sent, so the test
// can tell the relay's read session from the agent's own connection. SQLite and the routes are real.
process.env.ERGO_OPER_PASS = "test-oper-pass";
type Conn = { options: any; sent: string[]; waiters: ((m: any) => boolean)[] };
const conns: Conn[] = [];
const scripted = new Map<string, { nick: string; text: string; msgid: string }[]>();
const irc = await import("../src/irc.ts");
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline", "batch", "message-tags"]);
    conn: Conn;
    nick: string;
    constructor(options: any) { this.conn = { options, sent: [], waiters: [] }; this.nick = options.nick; conns.push(this.conn); }
    async connect() {}
    waitFor(match: (m: any) => boolean) { return new Promise<any>((resolve) => this.conn.waiters.push((m) => { if (!match(m)) return false; resolve(m); return true; })); }
    send(line: string) {
      this.conn.sent.push(line);
      const query = line.match(/^CHATHISTORY BEFORE (\S+) /);
      if (query) queueMicrotask(() => answer(this.conn, query[1]));
      return true;
    }
    quit() {}
    disconnect() {}
  },
}));
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }) }));

function deliver(conn: Conn, message: any) {
  conn.options.onMessage?.(message);
  conn.waiters = conn.waiters.filter((waiter) => !waiter(message));
}

let beforeAnswer: (() => void) | null = null;
function answer(conn: Conn, channel: string) {
  beforeAnswer?.();
  beforeAnswer = null;
  deliver(conn, { command: "BATCH", params: ["+h1", "chathistory", channel], tags: {} });
  let n = 0;
  for (const item of scripted.get(channel) || []) {
    deliver(conn, { command: "PRIVMSG", params: [channel, item.text], prefix: `${item.nick}!u@host`,
      tags: { batch: "h1", msgid: item.msgid, time: `2026-11-27T09:00:${String(++n).padStart(2, "0")}.000Z` } });
  }
  deliver(conn, { command: "BATCH", params: ["-h1"], tags: {} });
}

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { connectAgentTransport, validTarget } = await import("../src/agent-session-transport.ts");
const { directPair } = await import("../src/rooms.ts");
const { app } = await import("../src/server.ts");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = Date.now();
db.query("INSERT INTO accounts (nick, email, kind, verified_at, created_at) VALUES ('ada','ada@test.invalid','human',1,1),('ben','ben@test.invalid','human',1,1),('eve','eve@test.invalid','human',1,1)").run();
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?), (?, 'ben', ?)").run(hash("owner-session"), now, hash("ben-session"), now);
const owner = accountByNick("bitbonsai")!;

function dm(a: string, b: string): string {
  const [first, second] = directPair(a, b);
  const channel = `#dm-${first}-${second}`;
  db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick, provision_ready) VALUES (?, ?, ?, 1)").run(channel, first, second);
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, 'direct', ?)").run(channel, a, now);
  for (const nick of [a, b]) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?)").run(channel, nick);
  return channel;
}

function agentFor(ownerNick: string, sessionId: string) {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const { binding } = testBinding({ owner: ownerNick, harness: "pi", protocol: 1, sessionId, sessionFile: `/tmp/${sessionId}.jsonl`,
    secret, machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: (nick) => accountByNick(nick)?.id ?? null });
  db.query("INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)").run(binding.nick, `${binding.nick}@agents.invalid`, ownerNick, now);
  db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
  binding.dm = dm(ownerNick, binding.nick);
  db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
  return { binding, secret };
}

const bit = agentFor(owner.nick, "owner-dms-bit");
const benAgent = agentFor("ben", "owner-dms-ben");
const adaDm = dm(owner.nick, "ada");
const benEveDm = dm("ben", "eve");
scripted.set(adaDm, [
  { nick: "ada", text: "the deploy is waiting on the migration", msgid: "ada-1" },
  { nick: owner.nick, text: "ok, I'll look after lunch", msgid: "owner-1" },
]);
scripted.set(benEveDm, [{ nick: "eve", text: "not for bitbonsai", msgid: "eve-1" }]);

await connectAgentTransport(bit.binding);
const agentConn = conns.find((conn) => conn.options.saslUser === bit.binding.nick)!;
const lease = bindLease(bit.binding, "owner-dms-incarnation-00001")!.leaseId;
const benLease = bindLease(benAgent.binding, "owner-dms-incarnation-00002")!.leaseId;

const asAgent = (path: string, agent = bit, leaseId = lease) =>
  app.request(`/api/agent/session${path}`, { headers: { Authorization: `Bearer ${agent.secret}`, "X-Slirc-Agent-Lease": leaseId } });
const toggle = (nick: string, enabled: boolean, session = "owner-session") => app.request(`/api/agents/${nick}/read-dms`, {
  method: "POST", body: JSON.stringify({ enabled }),
  headers: { Cookie: `slirc_session=${session}`, "Content-Type": "application/json", Origin: "https://app.example.test", "X-Slirc-Agent": "1" },
});
const historyQueries = () => conns.flatMap((conn) => conn.sent.filter((line) => line.startsWith("CHATHISTORY")).map((line) => `${conn.options.saslUser} ${line}`));

test("with the setting off, the agent gets nothing and nothing is read", async () => {
  expect(db.query("SELECT read_owner_dms FROM agent_session_bindings WHERE id=?").get(bit.binding.id)).toEqual({ read_owner_dms: 0 });
  const list = await asAgent("/owner-dms");
  expect(list.status).toBe(403);
  expect((await list.json()).code).toBe("off");
  expect((await asAgent("/owner-dms/ada")).status).toBe(403);
  expect(historyQueries()).toEqual([]);
});

test("only the owner can turn it on, from the same origin", async () => {
  expect((await toggle(bit.binding.nick, true, "ben-session")).status).toBe(404);
  const crossSite = await app.request(`/api/agents/${bit.binding.nick}/read-dms`, {
    method: "POST", body: JSON.stringify({ enabled: true }), headers: { Cookie: "slirc_session=owner-session", "Content-Type": "application/json" },
  });
  expect(crossSite.status).toBe(403);
  expect((await asAgent("/owner-dms")).status).toBe(403);
  const on = await toggle(bit.binding.nick, true);
  expect(on.status).toBe(200);
  expect(await on.json()).toEqual({ readDms: true });
  const row = (await (await app.request("/api/agents", { headers: { Cookie: "slirc_session=owner-session" } })).json() as any[]).find((agent) => agent.nick === bit.binding.nick);
  expect(row.readDms).toBe(true);
});

test("with it on, the agent lists and reads the owner's DM with ada through the relay", async () => {
  const list = await asAgent("/owner-dms");
  expect(list.status).toBe(200);
  // Its own DM is read with slirc_history; ben and eve's DM is not the owner's.
  expect(await list.json()).toEqual({ owner: owner.nick, dms: [{ nick: "ada" }] });
  const read = await asAgent("/owner-dms/ada?limit=500");
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ nick: "ada", messages: [
    { messageId: "ada-1", nick: "ada", text: "the deploy is waiting on the migration", time: "2026-11-27T09:00:01.000Z" },
    { messageId: "owner-1", nick: owner.nick, text: "ok, I'll look after lunch", time: "2026-11-27T09:00:02.000Z" },
  ] });
  // The relay account asked Ergo, capped at 100; the agent's own connection asked nothing.
  expect(historyQueries()).toEqual([`slirc CHATHISTORY BEFORE ${adaDm} * 100`]);
});

test("the agent can't post, react, edit or delete in the owner's DM with ada", async () => {
  // Its IRC connection never joined the DM or wrote to it, and Ergo's +si with only the two +I
  // entries keeps it out. The write routes only target a request's room, and that DM never qualifies.
  expect(agentConn.sent.filter((line) => line.includes(adaDm))).toEqual([]);
  expect(validTarget(bit.binding, adaDm, adaDm)).toBe(false);
  expect(db.query("SELECT 1 FROM channel_members WHERE channel=? AND nick=?").get(adaDm, bit.binding.nick)).toBeNull();
  // Turning the setting on wrote no IRC access for the agent anywhere.
  expect(conns.flatMap((conn) => conn.sent).filter((line) => /^(SAMODE|INVITE|SAJOIN)\b/.test(line) && line.includes(bit.binding.nick))).toEqual([]);
  // A message from inside that DM is not a request this agent can take.
  agentConn.options.onMessage({ command: "PRIVMSG", params: [adaDm, `@${bit.binding.nick} reply to ada for me`], tags: { account: owner.nick, msgid: "inject-1" }, prefix: `${owner.nick}!u@host` });
  expect(db.query("SELECT 1 FROM agent_session_requests WHERE original_msgid='inject-1'").get()).toBeNull();
});

test("other accounts' DMs stay hidden, and another owner's agent reads none of this owner's", async () => {
  const before = historyQueries().length;
  expect((await asAgent("/owner-dms/eve")).status).toBe(404);
  expect((await asAgent("/owner-dms/ben")).status).toBe(404);
  // ben's agent, off by default, gets nothing; on, it sees only ben's DMs.
  expect((await asAgent("/owner-dms", benAgent, benLease)).status).toBe(403);
  expect((await toggle(benAgent.binding.nick, true, "ben-session")).status).toBe(200);
  expect(await (await asAgent("/owner-dms", benAgent, benLease)).json()).toEqual({ owner: "ben", dms: [{ nick: "eve" }] });
  expect((await asAgent("/owner-dms/ada", benAgent, benLease)).status).toBe(404);
  expect(historyQueries().length).toBe(before);
  expect((await asAgent("/owner-dms/eve", bit, "wrong-lease")).status).toBe(401);
  expect((await asAgent("/owner-dms/%23dm-ben-eve")).status).toBe(400);
});

test("turning it off revokes access at once, even mid-read", async () => {
  // Switched off while Ergo is answering: the page that arrives is dropped.
  beforeAnswer = () => { db.query("UPDATE agent_session_bindings SET read_owner_dms=0 WHERE id=?").run(bit.binding.id); };
  expect((await asAgent("/owner-dms/ada")).status).toBe(403);
  expect((await toggle(bit.binding.nick, true)).status).toBe(200);
  expect((await asAgent("/owner-dms/ada")).status).toBe(200);
  expect((await toggle(bit.binding.nick, false)).status).toBe(200);
  expect((await asAgent("/owner-dms")).status).toBe(403);
  expect((await asAgent("/owner-dms/ada")).status).toBe(403);
});
