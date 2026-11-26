// A local Slirc for driving a real, interactive agent by hand: the app with SQLite in memory, the
// IRC protocol peer from agent-session-pi-proof.test.ts standing in for Ergo, and a control port
// that plays the owner (open and allow a link, DM the agent, read what it posted).
// Run: bun test ./test/support/live-slirc.ts --timeout 0   (bun's mock.module needs the test runner)
import "../fixture.ts";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// End-to-end proof for session-bound Pi agents. Real pieces: the app (routes, SQLite, transport
// IrcClient), real Pi RPC runtimes loading the shipped extension, a deterministic local
// OpenAI-compatible model, and a TCP IRC protocol peer standing in for Ergo. Only the oper
// management helpers (DM creation, always-on, private-mode probe) are replaced, backed by the
// peer's channel state. Skips when `pi` is not installed.

process.env.ERGO_HOST = "127.0.0.1";
process.env.ERGO_OPER_PASS = "oper-pass";

// ---- IRC protocol peer -----------------------------------------------------------------------
type Conn = { socket: any; buffer: string; nick: string; account: string; caps: Set<string>; authed: boolean };
type Channel = { modes: Set<string>; invited: Set<string>; joined: Set<Conn> };
const channels = new Map<string, Channel>();
const conns = new Set<Conn>();
const posts: { from: string; target: string; text: string; tags: Record<string, string> }[] = [];
const sasl: { user: string; ok: boolean }[] = [];
const joins: { nick: string; channel: string; ok: boolean }[] = [];
const dropEcho = new Set<string>();
let msgSeq = 0;
const msgid = () => `m${++msgSeq}`;
const lower = (value: string) => value.toLowerCase();
const tagString = (tags: Record<string, string>) => Object.entries(tags).map(([key, value]) => `${key}=${value}`).join(";");
const write = (conn: Conn, line: string) => conn.socket.write(`${line}\r\n`);
const channel = (name: string) => channels.get(lower(name));
const { db } = await import("../../src/db.ts");

const { accountIrcPassword } = await import("../../src/irc-key.ts");
function ircPassword(user: string): string | null {
  if (user === process.env.ERGO_OPER_USER) return "oper-pass";
  const row = db.query("SELECT account_id, irc_password_gen FROM accounts WHERE nick=? COLLATE NOCASE").get(user) as
    { account_id: string; irc_password_gen: number | null } | null;
  return row ? accountIrcPassword(row) : null;
}

function handle(conn: Conn, raw: string) {
  let line = raw;
  let tags: Record<string, string> = {};
  if (line.startsWith("@")) {
    const space = line.indexOf(" ");
    for (const part of line.slice(1, space).split(";")) { const [key, ...rest] = part.split("="); tags[key] = rest.join("="); }
    line = line.slice(space + 1);
  }
  const [head, ...trail] = line.split(" :");
  const params = head.split(" ");
  const command = params.shift()!.toUpperCase();
  if (trail.length) params.push(trail.join(" :"));
  const prefix = `${conn.nick}!u@peer`;
  if (process.env.LIVE_DEBUG && !["PING", "PRIVMSG"].includes(command)) console.log(`peer <- ${conn.nick}: ${command} ${params.join(" ")}`);
  if (command === "CAP" && params[0] === "LS") write(conn, ":peer CAP * LS :sasl account-tag server-time message-tags batch draft/multiline draft/message-redaction echo-message draft/chathistory draft/event-playback");
  else if (command === "CAP" && params[0] === "REQ") { for (const cap of params[1].split(" ")) conn.caps.add(cap); write(conn, `:peer CAP * ACK :${params[1]}`); }
  else if (command === "NICK") conn.nick = params[0];
  else if (command === "AUTHENTICATE" && params[0] === "PLAIN") write(conn, "AUTHENTICATE +");
  else if (command === "AUTHENTICATE") {
    const [, user, pass] = Buffer.from(params[0], "base64").toString().split("\0");
    const ok = !!user && ircPassword(user) === pass;
    sasl.push({ user, ok });
    if (ok) { conn.account = user; conn.authed = true; write(conn, `:peer 900 ${conn.nick} ${prefix} ${user} :Logged in`); write(conn, `:peer 903 ${conn.nick} :SASL successful`); }
    else write(conn, `:peer 904 ${conn.nick} :SASL authentication failed`);
  } else if (command === "CAP" && params[0] === "END") { if (conn.authed) write(conn, `:peer 001 ${conn.nick} :Welcome`); }
  else if (command === "NAMES") { const room = channel(params[0]); write(conn, `:peer 353 ${conn.nick} = ${params[0]} :${[...(room?.joined || [])].map((member) => member.nick).join(" ")}`); write(conn, `:peer 366 ${conn.nick} ${params[0]} :End of /NAMES list.`); }
  // Browsers need chathistory; this peer keeps none, so every query gets an empty batch.
  else if (command === "CHATHISTORY") { const id = `h${msgSeq++}`; write(conn, `:peer BATCH +${id} chathistory ${params[1] || "*"}`); write(conn, `:peer BATCH -${id}`); }
  else if (command === "PING") write(conn, `:peer PONG peer :${params[0] || ""}`);
  else if (command === "OPER") write(conn, `:peer 381 ${conn.nick} :You are now an IRC operator`);
  else if (command === "JOIN") {
    // A browser joins several rooms at once; open rooms it names are made on first join.
    for (const name of params[0].split(",")) {
      if (!channel(name) && !name.toLowerCase().startsWith("#dm-")) channels.set(lower(name), { modes: new Set(), invited: new Set(), joined: new Set() });
      const room = channel(name);
      // Ergo semantics: +i needs an invite exception; anything else (including +s alone) admits.
      const ok = !!room && (!room.modes.has("i") || room.invited.has(lower(conn.account)));
      joins.push({ nick: conn.nick, channel: lower(name), ok });
      if (!room || !ok) { write(conn, `:peer 473 ${conn.nick} ${name} :Cannot join channel (+i)`); continue; }
      room.joined.add(conn);
      for (const other of room.joined) write(other, `:${prefix} JOIN ${name}`);
      write(conn, `:peer 353 ${conn.nick} = ${name} :${[...room.joined].map((member) => member.nick).join(" ")}`);
      write(conn, `:peer 366 ${conn.nick} ${name} :End of /NAMES list.`);
    }
  } else if (command === "PART") { channel(params[0])?.joined.delete(conn); write(conn, `:${prefix} PART ${params[0]}`); }
  else if (command === "PRIVMSG") {
    const target = params[0];
    const id = msgid();
    const out = { ...Object.fromEntries(Object.entries(tags).filter(([key]) => key.startsWith("+") || key === "batch")), msgid: id, account: conn.account };
    posts.push({ from: conn.nick, target: lower(target), text: params[1] || "", tags });
    if (conn.caps.has("echo-message") && !dropEcho.has(lower(conn.nick))) write(conn, `@${tagString(out)} :${prefix} PRIVMSG ${target} :${params[1] || ""}`);
    for (const other of channel(target)?.joined || []) if (other !== conn) write(other, `@${tagString(out)} :${prefix} PRIVMSG ${target} :${params[1] || ""}`);
  } else if (command === "QUIT") conn.socket.end();
}

const peer = Bun.listen<Conn>({
  hostname: "127.0.0.1", port: 0,
  socket: {
    open(socket) { const conn: Conn = { socket, buffer: "", nick: "*", account: "", caps: new Set(), authed: false }; socket.data = conn; conns.add(conn); },
    data(socket, data) {
      const conn = socket.data;
      conn.buffer += data.toString();
      let end: number;
      while ((end = conn.buffer.indexOf("\r\n")) >= 0) { const line = conn.buffer.slice(0, end); conn.buffer = conn.buffer.slice(end + 2); if (line) handle(conn, line); }
    },
    close(socket) { conns.delete(socket.data); for (const room of channels.values()) room.joined.delete(socket.data); },
  },
});
process.env.ERGO_PORT = String(peer.port);

// Authoritative owner traffic: the peer stamps the server-verified account tag, like Ergo.
function say(from: string, target: string, text: string, extra: Record<string, string> = {}): string {
  const id = msgid();
  const tags = tagString({ ...extra, account: from, msgid: id, time: new Date().toISOString() });
  for (const conn of channel(target)?.joined || []) write(conn, `@${tags} :${from}!u@peer PRIVMSG ${target} :${text}`);
  return id;
}
function redact(from: string, target: string, id: string) {
  for (const conn of channel(target)?.joined || []) write(conn, `@account=${from} :${from}!u@peer REDACT ${target} ${id}`);
}
const connFor = (nick: string) => [...conns].find((conn) => lower(conn.nick) === lower(nick));

// Oper management helpers backed by the peer's channel state.
const grants = await import("../../src/grants.ts");
mock.module("../../src/grants.ts", () => ({
  ...grants,
  setAlwaysOn: async () => {},
  createDirectChannel: async (name: string, _owner: string, members: string[]) => {
    channels.set(lower(name), { modes: new Set(["s", "i"]), invited: new Set(members.map(lower)), joined: new Set() });
  },
  grantChannelAccess: async (name: string, nick: string) => { channel(name)?.invited.add(lower(nick)); },
  allowChannelAccess: async (name: string, nick: string) => { channel(name)?.invited.add(lower(nick)); },
  readPrivateChannelMode: async (name: string) => {
    const room = channel(name);
    return room ? { secret: room.modes.has("s"), inviteOnly: room.modes.has("i") } : null;
  },
}));

// ---- Deterministic model ---------------------------------------------------------------------

const { app, agentSessionCapabilities } = await import("../../src/server.ts");
Object.assign(agentSessionCapabilities, { enabled: true });
const { transportTimers, syncAgentPresence } = await import("../../src/agent-session-transport.ts");
// LIVE_AWAY_MS shortens the grace before an agent's offline notice, for checking it by hand.
Object.assign(transportTimers, { echoTimeoutMs: 2_000, reconnectMs: 500, awayGraceMs: Number(process.env.LIVE_AWAY_MS) || transportTimers.awayGraceMs });
// The app entrypoint runs this sweep; NODE_ENV=test leaves it to us.
setInterval(() => syncAgentPresence(), 2_000);
const port = Number(process.env.LIVE_SLIRC_PORT) || 9711;
// The browser's IRC goes over /irc, relayed to the IRC peer, as the app entrypoint wires it.
const { handleRelayUpgrade, relayWebsocketHandlers } = await import("../../src/relay.ts");
const { accountByNick } = await import("../../src/accounts.ts");
const { slircMode } = await import("../../src/config.ts");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const relayDeps = {
  sessionByToken: (token: string) => {
    const row = db.query("SELECT nick FROM sessions WHERE token_hash = ?").get(sha(token)) as { nick: string } | null;
    return row && { nick: row.nick, token, tokenHash: sha(token) };
  },
  ircPasswordFor: (nick: string) => accountByNick(nick)?.ircPassword,
  appOrigin: `http://127.0.0.1:${port}`,
  ergoHost: "127.0.0.1", ergoPort: peer.port, webircPass: undefined, mode: slircMode(),
};
const relay = relayWebsocketHandlers(relayDeps as any);
const server = Bun.serve({
  port, hostname: "127.0.0.1", idleTimeout: 0,
  fetch(request, srv) {
    if (new URL(request.url).pathname === "/irc") {
      return handleRelayUpgrade(request, "/irc", (r, options) => srv.upgrade(r, options), relayDeps as any, srv.requestIP(request)?.address || "127.0.0.1");
    }
    return app.fetch(request, srv);
  },
  websocket: { open(ws) { relay.open(ws as any); }, message(ws, raw) { relay.message(ws as any, raw); }, close(ws) { relay.close(ws as any); } },
});
const ownerToken = "owner-live-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sha(ownerToken), Date.now());
const json = { Cookie: `slirc_session=${ownerToken}`, "Content-Type": "application/json" };
const bindings = () => db.query("SELECT id, harness, session_id, nick, dm, status FROM agent_session_bindings ORDER BY created_at").all() as any[];
const requests = () => db.query("SELECT id, binding_id, status, original_msgid FROM agent_session_requests ORDER BY created_at").all() as any[];

const control = Bun.serve({ port: port + 1, hostname: "127.0.0.1", async fetch(request) {
  const url = new URL(request.url);
  const q = (name: string) => url.searchParams.get(name) ?? "";
  if (url.pathname === "/allow") {
    const opened = await app.request("/api/agents/requests/open", { method: "POST", headers: json, body: JSON.stringify({ token: q("token") }) });
    const card = await opened.json() as any;
    if (!opened.ok) return Response.json({ opened: opened.status, card });
    const decided = await app.request(`/api/agents/requests/${card.id}`, { method: "POST", headers: json, body: JSON.stringify({ allow: true }) });
    return Response.json({ card, allowed: decided.status });
  }
  if (url.pathname === "/dm") {
    const binding = bindings().find((row) => !q("nick") || lower(row.nick) === lower(q("nick")));
    if (!binding) return Response.json({ error: "no binding" }, { status: 404 });
    return Response.json({ msgid: say("bitbonsai", binding.dm, q("text")), dm: binding.dm });
  }
  if (url.pathname === "/state") return Response.json({ bindings: bindings(), requests: requests(), posts });
  return new Response("routes: /allow?token= /dm?text=&nick= /state", { status: 404 });
} });

console.log(`live slirc on http://127.0.0.1:${server.port}, control on http://127.0.0.1:${control.port}`);
test("live slirc stays up until stopped", async () => { await new Promise(() => {}); });
