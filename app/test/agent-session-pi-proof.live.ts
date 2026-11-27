import "./fixture.ts";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// End-to-end proof for session-bound Pi agents. Real pieces: the app (routes, SQLite, transport
// IrcClient), real Pi RPC runtimes loading the shipped extension, a deterministic local
// OpenAI-compatible model, and a TCP IRC protocol peer standing in for Ergo. Only the oper
// management helpers (DM creation, always-on, private-mode probe) are replaced, backed by the
// peer's channel state. Skips when `pi` is not installed.
const piBin = Bun.which("pi");
if (!piBin && process.env.SLIRC_REQUIRE_PI === "true") throw new Error("Pi is required for the agent end-to-end checks. Install Pi, then rerun bun run test:agent-e2e.");
const run = piBin ? test : test.skip;
const extension = resolve(import.meta.dir, "../agent/dist/pi-extension.js");
const cli = resolve(import.meta.dir, "../agent/dist/slirc-agent.js");

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
const { db } = await import("../src/db.ts");

const { accountIrcPassword } = await import("../src/irc-key.ts");
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
  if (command === "CAP" && params[0] === "LS") write(conn, ":peer CAP * LS :sasl account-tag server-time message-tags batch draft/multiline draft/message-redaction echo-message");
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
  else if (command === "PING") write(conn, `:peer PONG peer :${params[0] || ""}`);
  else if (command === "OPER") write(conn, `:peer 381 ${conn.nick} :You are now an IRC operator`);
  else if (command === "JOIN") {
    const room = channel(params[0]);
    // Ergo semantics: +i needs an invite exception; anything else (including +s alone) admits.
    const ok = !!room && (!room.modes.has("i") || room.invited.has(lower(conn.account)));
    joins.push({ nick: conn.nick, channel: lower(params[0]), ok });
    if (!room || !ok) { write(conn, `:peer 473 ${conn.nick} ${params[0]} :Cannot join channel (+i)`); return; }
    room.joined.add(conn);
    write(conn, `:${prefix} JOIN ${params[0]}`);
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
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({
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
// Each runtime gets its own model id so the log shows which live session saw each prompt.
const modelCalls: { model: string; kind: "local" | "request" | "after-tool"; requestId?: string; text: string }[] = [];
let releaseLocalModel: (() => void) | undefined;
const textOf = (message: any) => typeof message?.content === "string" ? message.content : (message?.content || []).map((part: any) => part.text || "").join("");
const model = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(request) {
    const body = await request.json() as any;
    const last = body.messages.at(-1);
    const encoder = new TextEncoder();
    const frames: any[] = [];
    const base = { id: "c", object: "chat.completion.chunk", created: 1, model: body.model };
    if (last.role === "tool") {
      modelCalls.push({ model: body.model, kind: "after-tool", text: textOf(last) });
      frames.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
    } else {
      const text = textOf(last);
      const id = text.match(/Slirc request ([0-9a-f-]{36})/)?.[1];
      if (id) {
        modelCalls.push({ model: body.model, kind: "request", requestId: id, text });
        const quoted = text.split("Request:\n")[1]?.split("\n")[0] || "";
        const args = JSON.stringify({ requestId: id, text: `${body.model} answers: ${quoted}` });
        frames.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${id.slice(0, 8)}`, type: "function", function: { name: "slirc_reply", arguments: args } }] }, finish_reason: null }] });
        frames.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        modelCalls.push({ model: body.model, kind: "local", text });
        // Hold an actual Pi turn until the test releases it, not for a guessed sleep duration.
        if (text === "hold local turn") await new Promise<void>((resolve) => { releaseLocalModel = resolve; });
        frames.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `local answer from ${body.model}` }, finish_reason: "stop" }] });
      }
    }
    const stream = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(encoder.encode(stream), { headers: { "Content-Type": "text/event-stream" } });
  },
});

// ---- App -------------------------------------------------------------------------------------
const { app, agentSessionCapabilities } = await import("../src/server.ts");
Object.assign(agentSessionCapabilities, { enabled: true, supportedHarnesses: ["pi"] });
// Echo timeout 2 s instead of 15 s and IRC reconnect 0.5 s instead of 5 s; local echoes take milliseconds.
const { transportTimers } = await import("../src/agent-session-transport.ts");
Object.assign(transportTimers, { echoTimeoutMs: 2_000, reconnectMs: 500 });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request, srv) => app.fetch(request, srv) });
const host = `127.0.0.1:${server.port}`;
const origin = `http://${host}`;
const ownerToken = "owner-proof-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(createHash("sha256").update(ownerToken).digest("hex"), Date.now());
const owner = { Cookie: `slirc_session=${ownerToken}` };
// The owner, as the Agents page acts: every link a Pi shows is opened by its token and allowed,
// unless that Pi is in `holding`. The card must show the same code the Pi showed.
const allowed = new Set<string>();
const holding = new Set<string>();
const json = { ...owner, "Content-Type": "application/json" };
async function allowLinks(): Promise<number> {
  let count = 0;
  for (const pi of runtimes) {
    if (holding.has(pi.name)) continue;
    for (const text of pi.notes) {
      const token = text.match(/#connect=([A-Za-z0-9_-]{43})/)?.[1];
      if (!token || allowed.has(token)) continue;
      allowed.add(token);
      const opened = await app.request("/api/agents/requests/open", { method: "POST", headers: json, body: JSON.stringify({ token }) });
      if (!opened.ok) continue;
      const card = await opened.json();
      expect(text).toContain(`enter ${card.code} under Agents`);
      expect((await app.request(`/api/agents/requests/${card.id}`, { method: "POST", headers: json, body: JSON.stringify({ allow: true }) })).status).toBe(200);
      count++;
    }
  }
  return count;
}
const allowing = setInterval(() => void allowLinks().catch(() => {}), 200);
const bindings = () => db.query("SELECT * FROM agent_session_bindings ORDER BY created_at").all() as any[];
const requests = () => db.query("SELECT * FROM agent_session_requests ORDER BY created_at").all() as any[];

// ---- Pi runtimes -----------------------------------------------------------------------------
const root = mkdtempSync("/tmp/slirc-pi-proof-");
const repo = join(root, "repo");
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
for (const dir of [repo, agentDir, sessionDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "fake-a" }, { id: "fake-b" }, { id: "fake-c" }] } } }));

type Pi = { name: string; proc: ReturnType<typeof Bun.spawn>; events: any[]; notes: string[]; send: (command: any) => void; exited: Promise<number> };
const runtimes: Pi[] = [];
// `launch` replaces the plain `pi -e extension` start, e.g. with slirc-agent starting Pi itself.
function spawnPi(name: string, modelId: string, extra: string[] = [], launch?: { argv: string[]; env: Record<string, string | undefined> }): Pi {
  const argv = launch?.argv ?? [piBin!, "--mode", "rpc", "--provider", "fake", "--model", modelId, "--session-dir", sessionDir, "--no-extensions", "-e", extension, ...extra];
  const proc = Bun.spawn(argv, {
    cwd: repo, env: launch?.env ?? { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: join(root, "state"), HOSTNAME: "proof" }, stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  const pi: Pi = {
    name, proc, events: [], notes: [], exited: proc.exited,
    send: (command) => { (proc.stdin as any).write(`${JSON.stringify(command)}\n`); (proc.stdin as any).flush(); },
  };
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const record = JSON.parse(line);
          if (record.type === "message_update") continue;
          pi.events.push(record);
          if (record.type === "extension_ui_request" && record.method === "notify") pi.notes.push(record.message);
        } catch {}
      }
    }
  })();
  runtimes.push(pi);
  return pi;
}
async function until<T>(check: () => T | undefined | false | null, label: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}
let rpcSeq = 0;
async function rpc(pi: Pi, command: any): Promise<any> {
  const id = `r${++rpcSeq}`;
  pi.send({ ...command, id });
  return until(() => pi.events.find((event) => event.type === "response" && event.id === id), `${pi.name} ${command.type}`);
}
async function prompt(pi: Pi, message: string): Promise<void> {
  const settled = pi.events.filter((event) => event.type === "agent_settled").length;
  const response = await rpc(pi, { type: "prompt", message });
  if (response.data?.disposition !== "handled") await until(() => pi.events.filter((event) => event.type === "agent_settled").length > settled, `${pi.name} settle`);
}
async function idle(pi: Pi): Promise<void> {
  await until(() => modelCalls.length && true, "model");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    const state = (await rpc(pi, { type: "get_state" })).data;
    if (!state.isStreaming && !state.pendingMessageCount) return;
  }
  throw new Error(`${pi.name} stayed busy`);
}
const note = (pi: Pi, pattern: RegExp, label: string, ms?: number) => until(() => pi.notes.find((text) => pattern.test(text)), `${pi.name} ${label}`, ms);
async function stop(pi: Pi) { (pi.proc.stdin as any).end(); await Promise.race([pi.exited, Bun.sleep(5_000)]); pi.proc.kill(); }
function stateFor(sessionId: string) {
  for (const file of readdirSync(join(agentDir, "slirc"))) {
    if (!file.endsWith(".json")) continue;
    const state = JSON.parse(readFileSync(join(agentDir, "slirc", file), "utf8"));
    if (state.sessionId === sessionId) return state;
  }
  throw new Error("no adapter state");
}
const bearer = (secret: string, lease?: string) => ({ Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...(lease ? { "X-Slirc-Agent-Lease": lease } : {}) });
const newSecret = () => randomBytes(32).toString("base64url");
const askBody = (sessionId: string, sessionFile = `/tmp/${sessionId}.jsonl`, harness = "pi") =>
  JSON.stringify({ harness, protocol: 1, sessionId, sessionFile, sessionName: "", machine: "proof" });

let A: Pi;
let B: Pi;
let stateA: { sessionId: string; sessionFile: string };
let stateB: { sessionId: string; sessionFile: string };
let bindingA: any;
let bindingB: any;

beforeAll(() => { if (!piBin) console.warn("pi not installed; skipping live Pi proof"); });
afterAll(async () => {
  clearInterval(allowing);
  for (const pi of runtimes) pi.proc.kill();
  server.stop(true); model.stop(true); peer.stop(true);
  rmSync(root, { recursive: true, force: true });
});

run("two Pi sessions in one cwd pair to distinct agents and DMs; terminal turns post nothing", async () => {
  A = spawnPi("A", "fake-a");
  B = spawnPi("B", "fake-b");
  // A local turn first: it saves each session and must never reach Slirc.
  await prompt(A, "local question A");
  await prompt(B, "local question B");
  stateA = (await rpc(A, { type: "get_state" })).data;
  stateB = (await rpc(B, { type: "get_state" })).data;
  expect(stateA.sessionId).not.toBe(stateB.sessionId);

  await prompt(A, `/slirc ${host}`);
  await note(A, new RegExp(`^Connected to ${host} as pi-[0-9a-f]{4}\\.`), "paired");
  await note(A, /^Slirc connected\./, "connected");
  await prompt(B, `/slirc ${host}`);
  await note(B, new RegExp(`^Connected to ${host} as pi-[0-9a-f]{4}\\.`), "paired");
  await note(B, /^Slirc connected\./, "connected");

  [bindingA, bindingB] = bindings();
  expect(bindings()).toHaveLength(2);
  expect(bindingA.session_id).toBe(stateA.sessionId);
  expect(bindingB.session_id).toBe(stateB.sessionId);
  expect(bindingA.nick).not.toBe(bindingB.nick);
  expect(bindingA.dm).not.toBe(bindingB.dm);
  const decided = db.query("SELECT binding_id FROM agent_connect_requests WHERE decision='allow' ORDER BY created_at").all() as { binding_id: string }[];
  expect(decided.map((row) => row.binding_id)).toEqual([bindingA.id, bindingB.id]);
  // One introduction per binding, into its own DM, after attachment.
  await until(() => bindings().every((row) => row.intro_state === "sent"), "introductions");
  for (const binding of [bindingA, bindingB]) {
    const intros = posts.filter((post) => post.text.startsWith("Connected to your Pi"));
    expect(intros.filter((post) => lower(post.from) === lower(binding.nick)).map((post) => post.target)).toEqual([lower(binding.dm)]);
  }
  // Only the introductions so far: local turns posted nothing.
  expect(posts.every((post) => post.text.startsWith("Connected to your Pi"))).toBe(true);
  expect(modelCalls.filter((call) => call.kind === "local").map((call) => call.model).sort()).toEqual(["fake-a", "fake-b"]);
}, 60_000);

run("one addressed request reaches exactly one runtime and only slirc_reply posts, to its fixed DM", async () => {
  const before = posts.length;
  const id = say("bitbonsai", bindingA.dm, "what is two plus two");
  const request = await until(() => requests().find((row) => row.original_msgid === id && row.status === "replied"), "replied", 20_000);
  expect(request.binding_id).toBe(bindingA.id);
  const seen = modelCalls.filter((call) => call.requestId === request.id);
  expect(seen.map((call) => call.model)).toEqual(["fake-a"]);
  // The prompt names who asked: the owner, in the agent's DM.
  expect(seen[0].text).toContain("from bitbonsai (DM).");
  const replies = posts.slice(before);
  expect(replies).toHaveLength(1);
  expect(lower(replies[0].from)).toBe(lower(bindingA.nick));
  expect(replies[0].target).toBe(lower(bindingA.dm));
  expect(replies[0].text).toBe("fake-a answers: what is two plus two");
  expect(replies[0].tags["+slirc/cid"]).toBe(request.reply_cid);
  // The model's closing text ("done") and a later local turn produce no post.
  await idle(A);
  await prompt(A, "another local question");
  await Bun.sleep(300);
  expect(posts.length).toBe(before + 1);
}, 60_000);

run("busy Pi queues owner DMs as follow-ups, then replies once each in order without leaking the local turn", async () => {
  await idle(A);
  const before = posts.length;
  const eventsBefore = A.events.length;
  const callsBefore = modelCalls.length;
  expect((await rpc(A, { type: "prompt", message: "hold local turn" })).success).toBe(true);
  await until(() => releaseLocalModel, "local model held");
  let first: any;
  let second: any;
  try {
    const id = say("bitbonsai", bindingA.dm, "first queued task");
    first = await until(() => requests().find((row) => row.original_msgid === id && row.status === "accepted"), "first accepted");
    const queued = await until(() => A.events.slice(eventsBefore).find((event) => event.type === "queue_update" && event.followUp?.length), "native follow-up queue");
    expect(JSON.stringify(queued.followUp)).toContain(first.id);
    expect(queued.steering).toHaveLength(0);
    const state = (await rpc(A, { type: "get_state" })).data;
    expect(state.isStreaming).toBe(true);
    expect(state.pendingMessageCount).toBe(1);
    expect(requests().find((row) => row.id === first.id)?.started_at).toBeNull();

    const next = say("bitbonsai", bindingA.dm, "second queued task");
    second = await until(() => requests().find((row) => row.original_msgid === next), "second offered");
    expect(second.status).toBe("offered");
    expect(modelCalls.slice(callsBefore).filter((call) => call.kind === "request")).toEqual([]);
    expect(posts).toHaveLength(before);
  } finally {
    releaseLocalModel?.();
    releaseLocalModel = undefined;
  }
  await until(() => [first, second].every((request) => requests().find((row) => row.id === request.id)?.status === "replied"), "both queued replies", 20_000);
  await idle(A);
  expect(requests().find((row) => row.id === first.id)?.started_at).toBeGreaterThan(0);
  expect(requests().find((row) => row.id === second.id)?.started_at).toBeGreaterThan(0);
  expect(modelCalls.slice(callsBefore).filter((call) => call.kind === "request").map((call) => [call.model, call.requestId])).toEqual([
    ["fake-a", first.id], ["fake-a", second.id],
  ]);
  expect(posts.slice(before).map((post) => [post.from.toLowerCase(), post.target, post.text])).toEqual([
    [bindingA.nick.toLowerCase(), bindingA.dm.toLowerCase(), "fake-a answers: first queued task"],
    [bindingA.nick.toLowerCase(), bindingA.dm.toLowerCase(), "fake-a answers: second queued task"],
  ]);
}, 60_000);

run("native Pi abort retains the queued DM; explicit local continuation runs it once", async () => {
  await idle(A);
  const eventsBefore = A.events.length;
  const before = posts.length;
  expect((await rpc(A, { type: "prompt", message: "hold local turn" })).success).toBe(true);
  await until(() => releaseLocalModel, "interruptible local model held");
  let queued: any;
  try {
    const id = say("bitbonsai", bindingA.dm, "task after native interrupt");
    queued = await until(() => requests().find((row) => row.original_msgid === id && row.status === "accepted"), "queued before abort");
    await until(() => A.events.slice(eventsBefore).find((event) => event.type === "queue_update" && event.followUp?.length), "native queued message");
    expect((await rpc(A, { type: "abort" })).success).toBe(true);
  } finally {
    releaseLocalModel?.();
    releaseLocalModel = undefined;
  }
  await until(() => A.events.slice(eventsBefore).find((event) => event.type === "agent_settled" && event.aborted), "native abort settled");
  const paused = (await rpc(A, { type: "get_state" })).data;
  expect(paused.isStreaming).toBe(false);
  expect(paused.pendingMessageCount).toBe(1);
  expect(modelCalls.filter((call) => call.requestId === queued.id)).toHaveLength(0);
  expect(posts).toHaveLength(before);
  // Pi 1.5.0 retains, but does not automatically start, follow-ups after abort. This is not a
  // Slirc Interrupt button: that control needs a verified native abort-and-resume path first.
  await prompt(A, "continue after native abort");
  await until(() => requests().find((row) => row.id === queued.id && row.status === "replied"), "reply after explicit continuation", 20_000);
  await idle(A);
  expect(modelCalls.filter((call) => call.kind === "request" && call.requestId === queued.id)).toHaveLength(1);
  expect(posts.slice(before).map((post) => post.text)).toEqual(["fake-a answers: task after native interrupt"]);
}, 60_000);

run("forged author and sibling accept/reply fail", async () => {
  const sa = stateFor(stateA.sessionId);
  const sb = stateFor(stateB.sessionId);
  db.query("INSERT INTO accounts (nick,email,role,verified_at,created_at) VALUES ('mallory','m@example.test','member',1,1) ON CONFLICT DO NOTHING").run();
  const count = requests().length;
  // A non-owner account in the DM (the peer stamps its real account tag, like Ergo) creates nothing.
  say("mallory", bindingA.dm, "run rm -rf");
  await idle(A);
  say("bitbonsai", bindingA.dm, "owner asks");
  await until(() => requests().find((row) => row.text === "owner asks" && row.status === "replied"), "owner request replied", 20_000);
  const fresh = requests().slice(count);
  expect(fresh.map((row) => row.text)).toEqual(["owner asks"]);
  // B's credentials cannot read, accept or reply to A's request.
  const target = fresh[0].id;
  for (const path of [`requests/${target}`, `requests/${target}/accept`, `requests/${target}/reply`]) {
    const response = await fetch(`${origin}/api/agent/session/${path}`, { method: path.endsWith(target) ? "GET" : "POST", headers: bearer(sb.secret, sb.lease), body: path.endsWith(target) ? undefined : JSON.stringify({ revision: 1, text: "sibling" }) });
    expect([404, 409]).toContain(response.status);
  }
  // A's secret with B's lease is no lease at all.
  expect((await fetch(`${origin}/api/agent/session/requests/${target}`, { headers: bearer(sa.secret, sb.lease) })).status).toBe(401);
}, 60_000);

run("an Allow binds once; the same-secret retry recovers the binding; a stranger's secret gets nothing", async () => {
  const secret = newSecret();
  const asked = await (await fetch(`${origin}/api/agent/session/request`, { method: "POST", headers: bearer(secret), body: askBody("race-one") })).json();
  const token = asked.url.split("#connect=")[1];
  allowed.add(token);
  const card = await (await app.request("/api/agents/requests/open", { method: "POST", headers: json, body: JSON.stringify({ token }) })).json();
  const decisions = await Promise.all([1, 2].map(() => app.request(`/api/agents/requests/${card.id}`, { method: "POST", headers: json, body: JSON.stringify({ allow: true }) })));
  expect(decisions.map((response) => response.status).sort()).toEqual([200, 404]);
  expect(bindings().filter((row) => row.session_id === "race-one")).toHaveLength(1);
  const poll = () => fetch(`${origin}/api/agent/session/connect`, { method: "POST", headers: bearer(secret), body: askBody("race-one") });
  const first = await poll();
  expect(first.status).toBe(200);
  const winner = await first.json();
  expect(JSON.stringify(winner)).not.toContain("irc_password");
  // Lost-response retry: same secret returns the same identity.
  const again = await (await poll()).json();
  expect([again.bindingId, again.nick, again.dm]).toEqual([winner.bindingId, winner.nick, winner.dm]);
  const stranger = await fetch(`${origin}/api/agent/session/connect`, { method: "POST", headers: bearer(newSecret()), body: askBody(stateA.sessionId, bindingA.session_file) });
  expect(stranger.status).toBe(404);
  expect((await fetch(`${origin}/api/agent/session/binding`, { headers: bearer(newSecret()) })).status).toBe(401);
}, 60_000);

run("unsupported harnesses are refused; a link nobody allows expires with a clear next step in Pi", async () => {
  const unsupported = await fetch(`${origin}/api/agent/session/request`, { method: "POST", headers: bearer(newSecret()), body: askBody("claude-session", "/tmp/claude.jsonl", "claude-desktop") });
  expect(unsupported.status).toBe(400);

  const count = bindings().length;
  const C = spawnPi("C", "fake-c");
  holding.add("C");
  await prompt(C, "local question C");
  C.send({ type: "prompt", message: `/slirc ${host}` });
  await note(C, /#connect=/, "link");
  db.query("UPDATE agent_connect_requests SET expires_at=? WHERE decision IS NULL").run(Date.now() - 1);
  await note(C, /Nobody pressed Allow in time\. Copy the command from your Agents page again to connect\./, "expired");
  expect(bindings()).toHaveLength(count);
  await stop(C);
}, 60_000);

run("duplicate live attach of the same saved session cannot displace it", async () => {
  const leaseBefore = bindings().find((row) => row.id === bindingA.id).lease_id;
  const D = spawnPi("A-duplicate", "fake-a", ["--session", stateA.sessionFile]);
  await note(D, /already attached in another runtime/, "conflict");
  expect(bindings().find((row) => row.id === bindingA.id).lease_id).toBe(leaseBefore);
  await stop(D);
  // A still serves requests.
  const id = say("bitbonsai", bindingA.dm, "still there");
  await until(() => requests().find((row) => row.original_msgid === id && row.status === "replied"), "A still replies", 20_000);
}, 60_000);

run("bearer secret cannot SASL to IRC and no route offers raw IRC or JOIN", async () => {
  const sa = stateFor(stateA.sessionId);
  const attempt = async (user: string, pass: string) => {
    const { IrcClient } = await import("../src/irc.ts");
    const client = new IrcClient({ host: "127.0.0.1", port: peer.port, nick: `probe${msgSeq}`, saslUser: user, saslPass: pass, capabilities: ["echo-message"] });
    try { await client.connect(3_000); return true; } catch { return false; } finally { client.quit(); }
  };
  expect(await attempt(bindingA.nick, sa.secret)).toBe(false);
  // Every agent JOIN the peer saw went to a private (+s +i) room the agent was invited to.
  const agentNicks = new Set(bindings().map((row) => lower(row.nick)));
  const agentJoins = joins.filter((entry) => agentNicks.has(lower(entry.nick)));
  expect(agentJoins.length).toBeGreaterThan(0);
  expect(agentJoins.every((entry) => entry.ok && channel(entry.channel)!.modes.has("s") && channel(entry.channel)!.modes.has("i"))).toBe(true);
  // No session route accepts arbitrary IRC lines, JOINs or destinations.
  const sessionPaths = [...new Set(app.routes.map((route: { path: string }) => route.path).filter((path: string) => path.startsWith("/api/agent/session/")))].sort();
  expect(sessionPaths).toEqual([
    "/api/agent/session/*", "/api/agent/session/attach", "/api/agent/session/binding", "/api/agent/session/connect",
    "/api/agent/session/detach", "/api/agent/session/events", "/api/agent/session/events/poll", "/api/agent/session/heartbeat",
    // Read-only room history behind the delivery checks, and display metadata.
    // Owner DMs are read-only and gated by the owner's per-agent switch.
    "/api/agent/session/history", "/api/agent/session/metadata", "/api/agent/session/owner-dms", "/api/agent/session/owner-dms/:nick",
    "/api/agent/session/request", "/api/agent/session/requests/:id",
    "/api/agent/session/requests/:id/accept", "/api/agent/session/requests/:id/confirm",
    // Extra messages and own-message deletes go only to the request's fixed room.
    "/api/agent/session/requests/:id/delete", "/api/agent/session/requests/:id/fail", "/api/agent/session/requests/:id/reply",
    "/api/agent/session/requests/:id/send", "/api/agent/session/requests/:id/started",
  ]);
  const reply = await fetch(`${origin}/api/agent/session/requests/nope/reply`, { method: "POST", headers: bearer(sa.secret, sa.lease), body: JSON.stringify({ text: "x", destination: "#help" }) });
  expect(reply.status).toBe(409);
}, 30_000);

run("offline requests wait for owner confirmation of the latest revision; deletes never run", async () => {
  await stop(A);
  await until(() => !bindings().find((row) => row.id === bindingA.id).lease_id, "A detached");
  const calls = modelCalls.length;
  const first = say("bitbonsai", bindingA.dm, "offline task v1");
  const pending = await until(() => requests().find((row) => row.original_msgid === first), "pending row");
  expect(pending.status).toBe("needs_confirmation");
  await until(() => posts.some((post) => post.text.includes(`Slirc request ${pending.id} is waiting`)), "offline notice");
  const edited = say("bitbonsai", bindingA.dm, "offline task v2", { "+draft/edit": first });
  await until(() => requests().find((row) => row.id === pending.id && row.revision === 2 && row.current_msgid === edited), "edit tracked");
  const doomed = say("bitbonsai", bindingA.dm, "offline task to delete");
  const doomedRow = await until(() => requests().find((row) => row.original_msgid === doomed), "doomed row");
  redact("bitbonsai", bindingA.dm, doomed);
  await until(() => requests().find((row) => row.id === doomedRow.id && row.status === "cancelled" && row.text === ""), "deleted cancelled");

  A = spawnPi("A-resumed", "fake-a", ["--session", stateA.sessionFile]);
  await note(A, /^Slirc connected\./, "reconnected");
  const resumed = bindings().filter((row) => row.session_id === stateA.sessionId);
  expect(resumed).toHaveLength(1);
  expect([resumed[0].id, resumed[0].nick, resumed[0].dm]).toEqual([bindingA.id, bindingA.nick, bindingA.dm]);
  // Reattach sends one review list naming the latest revision; the deleted request is not listed.
  const review = await until(() => posts.find((post) => post.text.includes("awaiting review") && post.text.includes(pending.id)), "review list");
  expect(review.text).toContain(`${pending.id} (rev 2): offline task v2`);
  expect(review.text).not.toContain(doomedRow.id);
  expect(posts.filter((post) => post.text.startsWith("Connected to your Pi") && lower(post.from) === lower(bindingA.nick))).toHaveLength(1);
  await Bun.sleep(500);
  expect(modelCalls.length).toBe(calls); // reattach replays nothing
  say("bitbonsai", bindingA.dm, `confirm ${pending.id} 1`); // stale revision
  say("bitbonsai", bindingA.dm, `confirm ${doomedRow.id} 1`); // deleted
  await Bun.sleep(500);
  expect(modelCalls.length).toBe(calls);
  say("bitbonsai", bindingA.dm, `confirm ${pending.id} 2`);
  await until(() => requests().find((row) => row.id === pending.id && row.status === "replied"), "confirmed reply", 20_000);
  const ran = modelCalls.filter((call) => call.requestId);
  expect(ran.filter((call) => call.requestId === pending.id).map((call) => call.text.includes("offline task v2"))).toEqual([true]);
  expect(ran.some((call) => call.requestId === doomedRow.id)).toBe(false);
}, 90_000);

run("an IRC continuity gap turns unaccepted work into content-free uncertainty", async () => {
  await stop(A);
  await until(() => !bindings().find((row) => row.id === bindingA.id).lease_id, "A detached");
  const id = say("bitbonsai", bindingA.dm, "before the gap");
  const row = await until(() => requests().find((entry) => entry.original_msgid === id), "gap row");
  const joined = joins.filter((entry) => lower(entry.nick) === lower(bindingA.nick)).length;
  connFor(bindingA.nick)!.socket.end();
  await until(() => requests().find((entry) => entry.id === row.id && entry.status === "uncertain" && entry.text === ""), "gap uncertain");
  // The transport reconnects, the runtime resumes; confirmation cannot revive it.
  await until(() => joins.filter((entry) => lower(entry.nick) === lower(bindingA.nick)).length > joined, "transport rejoined", 15_000);
  A = spawnPi("A-after-gap", "fake-a", ["--session", stateA.sessionFile]);
  await note(A, /^Slirc connected\./, "reconnected");
  const calls = modelCalls.length;
  say("bitbonsai", bindingA.dm, `confirm ${row.id} 1`);
  await Bun.sleep(500);
  expect(modelCalls.length).toBe(calls);
  expect(requests().find((entry) => entry.id === row.id).status).toBe("uncertain");
}, 60_000);

run("a lost reply echo becomes uncertain and is never resent", async () => {
  dropEcho.add(lower(bindingB.nick));
  const before = posts.length;
  const id = say("bitbonsai", bindingB.dm, "echo will vanish");
  const row = await until(() => requests().find((entry) => entry.original_msgid === id && entry.status === "replying"), "replying", 20_000);
  await until(() => requests().find((entry) => entry.id === row.id && entry.status === "uncertain"), "uncertain after echo timeout", 25_000);
  dropEcho.delete(lower(bindingB.nick));
  await Bun.sleep(2_500); // the adapter's 2 s status poll settles without resubmitting
  const sent = posts.slice(before).filter((post) => lower(post.from) === lower(bindingB.nick));
  expect(sent).toHaveLength(1);
  expect(modelCalls.filter((call) => call.requestId === row.id && call.kind === "request")).toHaveLength(1);
}, 60_000);

run("slirc-agent in a terminal sets up Pi, starts it, and that session pairs after Allow and answers a DM", async () => {
  // Its own Pi folder, so the installed package never loads next to the -e extension above.
  const cliAgentDir = join(root, "agent-cli");
  mkdirSync(cliAgentDir, { recursive: true });
  writeFileSync(join(cliAgentDir, "models.json"), readFileSync(join(agentDir, "models.json")));
  const env = { ...process.env, PI_CODING_AGENT_DIR: cliAgentDir, XDG_STATE_HOME: join(root, "state-cli"), SLIRC_PI_SOURCE: resolve(import.meta.dir, "../agent"), HOSTNAME: "proof" };
  delete (env as Record<string, string | undefined>).PI_CODING_AGENT;
  const count = bindings().length;
  const E = spawnPi("E", "fake-c", [], { argv: [process.execPath, cli, host, "--harness", "pi", "--", "--mode", "rpc", "--provider", "fake", "--model", "fake-c", "--session-dir", sessionDir], env });
  await note(E, /#connect=/, "link", 60_000);
  await note(E, new RegExp(`^Connected to ${host} as pi-[0-9a-f]{4}\\.`), "paired", 30_000);
  await note(E, /^Slirc connected\./, "connected");
  const binding = bindings().at(-1);
  expect(bindings()).toHaveLength(count + 1);
  expect([binding.harness, binding.machine]).toEqual(["pi", "proof"]);
  expect(readFileSync(join(root, "state-cli", "slirc", "workspace"), "utf8").trim()).toBe(host);
  const id = say("bitbonsai", binding.dm, "hello from the phone");
  await until(() => requests().find((row) => row.original_msgid === id && row.status === "replied"), "replied", 20_000);
  expect(posts.some((post) => lower(post.from) === lower(binding.nick) && lower(post.target) === lower(binding.dm) && post.text.includes("answers: hello from the phone"))).toBe(true);
  await stop(E);
}, 120_000);
