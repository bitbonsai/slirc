import "./fixture.ts";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// End-to-end proof for session-bound Codex agents. Real pieces: the app (routes, SQLite, transport
// IrcClient), the real Codex TUI in a private tmux server with the Slirc plugin that slirc-agent
// installs, its app-server daemon, hooks and MCP server, a deterministic local Responses API
// model, and a TCP IRC protocol peer standing in for Ergo. Only the oper management helpers are
// replaced, as in the Pi proof. Everything Codex keeps lives in a temporary CODEX_HOME. Skips
// when `codex` or `tmux` is missing; SLIRC_REQUIRE_CODEX=true makes that a failure.
const codexBin = Bun.which("codex");
const tmuxBin = Bun.which("tmux");
if ((!codexBin || !tmuxBin) && process.env.SLIRC_REQUIRE_CODEX === "true") throw new Error("Codex and tmux are required for the Codex agent proof. Install them, then rerun.");
const run = codexBin && tmuxBin ? test : test.skip;
// SLIRC_CODEX_REAL=1: the real model this machine's Codex is logged in to, from its own CODEX_HOME.
// The plugin's marketplace copy and Slirc's state still go to the temporary folder, and the plugin
// is uninstalled at the end. Codex itself still records the folder and hook trust in that
// config.toml, so back it up first and restore it after.
const real = process.env.SLIRC_CODEX_REAL === "1";
const patience = real ? 180_000 : 60_000;
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
// A Responses API stand-in. A Slirc request gets one slirc_reply call; anything else a short answer.
const modelCalls: { kind: "local" | "request" | "after-tool" | "title"; requestId?: string; text: string }[] = [];
const userText = (item: any) => (item?.content || []).map((part: any) => part.text || "").join("");
const model = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(request) {
    if (request.method !== "POST") return Response.json({ data: [], models: [] });
    const body = await request.json() as any;
    const input = body.input || [];
    const last = input.at(-1);
    const text = userText([...input].reverse().find((item: any) => item.role === "user"));
    const id = `resp_${modelCalls.length}`;
    const sse = (item: any) => new Response([
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    const say = (words: string) => sse({ type: "message", role: "assistant", id: `msg_${id}`, content: [{ type: "output_text", text: words }] });
    if (!(body.tools || []).length) { modelCalls.push({ kind: "title", text }); return say("Proof"); }
    if (last?.type === "function_call_output") { modelCalls.push({ kind: "after-tool", text: JSON.stringify(last.output) }); return say("Replied on Slirc."); }
    const requestId = text.match(/Slirc request ([0-9a-f-]{36})/)?.[1];
    if (requestId) {
      modelCalls.push({ kind: "request", requestId, text });
      const quoted = text.split("Request:\n")[1]?.split("\n")[0] || "";
      return sse({ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, namespace: "mcp__slirc", name: "slirc_reply", arguments: JSON.stringify({ requestId, text: `codex answers: ${quoted}` }) });
    }
    modelCalls.push({ kind: "local", text });
    return say(`local answer to ${text.slice(0, 40)}`);
  },
});

// ---- App -------------------------------------------------------------------------------------
const { app, agentSessionCapabilities } = await import("../src/server.ts");
Object.assign(agentSessionCapabilities, { enabled: true });
const { transportTimers } = await import("../src/agent-session-transport.ts");
Object.assign(transportTimers, { echoTimeoutMs: 2_000, reconnectMs: 500 });
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request, srv) => app.fetch(request, srv) });
const host = `127.0.0.1:${server.port}`;
const ownerToken = "owner-codex-proof-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(createHash("sha256").update(ownerToken).digest("hex"), Date.now());
const json = { Cookie: `slirc_session=${ownerToken}`, "Content-Type": "application/json" };
const bindings = () => db.query("SELECT * FROM agent_session_bindings ORDER BY created_at").all() as any[];
const requests = () => db.query("SELECT * FROM agent_session_requests ORDER BY created_at").all() as any[];

// ---- Codex in tmux ---------------------------------------------------------------------------
const root = mkdtempSync("/tmp/slirc-codex-proof-");
const repo = join(root, "repo");
const codexHome = real ? process.env.CODEX_HOME || join(process.env.HOME!, ".codex") : join(root, "codex");
for (const dir of [repo, codexHome]) mkdirSync(dir, { recursive: true });
const daemonBefore = real && Bun.spawnSync(["test", "-S", join(codexHome, "app-server-control", "app-server-control.sock")]).exitCode === 0;
spawnSync("git", ["init", "-q", repo]);
const realRepo = spawnSync("pwd", ["-P"], { cwd: repo, encoding: "utf8" }).stdout.trim();
if (!real) writeFileSync(join(codexHome, "config.toml"), `check_for_update_on_startup = false
model = "fake-model"
model_provider = "fake"
approval_policy = "never"
sandbox_mode = "workspace-write"

[model_providers.fake]
name = "fake"
base_url = "http://127.0.0.1:${model.port}/v1"
wire_api = "responses"
requires_openai_auth = false

[projects."${realRepo}"]
trust_level = "trusted"
`);
const runtime = Bun.which("node") ?? process.execPath;
// No -c flags in the real run: any command-line override makes Codex skip its shared daemon.
const flags = "";
const codexEnv = { CODEX_HOME: codexHome, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), SLIRC_CODEX_OWNER_POLL_MS: "1000", SLIRC_CODEX_OFFLINE_MS: "3000" };
const envPrefix = `env ${Object.entries(codexEnv).map(([key, value]) => `${key}='${value}'`).join(" ")}`;
const socket = `slirc-codex-proof-${process.pid}`;
const tmux = (...args: string[]) => spawnSync(tmuxBin!, ["-L", socket, ...args], { encoding: "utf8" });
const screen = (name = "main") => tmux("capture-pane", "-p", "-J", "-S", "-300", "-t", name).stdout ?? "";
const keys = (name: string, text: string) => { tmux("send-keys", "-t", name, "-l", text); tmux("send-keys", "-t", name, "Enter"); };
function window(name: string, command: string) {
  // Variables of the agent this test may run under don't leak into Codex.
  tmux("new-session", "-d", "-s", name, "-x", "220", "-y", "60", "-c", repo, `${envPrefix.replace("env ", "env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID ")} ${command}; sleep 600`);
}
async function until<T>(check: () => T | undefined | false | null, label: string, ms = patience): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}\n${screen()}\n----\n${screen("again")}\n${JSON.stringify(modelCalls.slice(-4)).slice(0, 1500)}`);
}
// The first launch with new hooks asks to trust them once; the proof says yes, as a person would.
// The dialog can draw before it takes keys, so it presses again until Codex is past it.
// The TUI draws its composer before the dialog, so `done` says when the start is really over.
async function trustHooks(name: string, done: () => boolean) {
  const visible = () => tmux("capture-pane", "-p", "-J", "-t", name).stdout ?? "";
  const deadline = Date.now() + patience;
  while (Date.now() < deadline) {
    if (/Hooks need review/.test(visible())) tmux("send-keys", "-t", name, "2", "Enter");
    // The real run's own Codex may ask about the temporary folder first.
    else if (/Trust this folder\?/.test(visible())) tmux("send-keys", "-t", name, "1", "Enter");
    else if (/Update available/.test(visible()) && /Skip/.test(visible())) tmux("send-keys", "-t", name, "2", "Enter");
    else if (done()) return;
    await Bun.sleep(1_500);
  }
  const log = spawnSync("sh", ["-c", `cat '${join(root, "state")}'/slirc-agent/codex/listener.log 2>/dev/null; ps -xo pid=,command= | grep -i codex | grep -v grep`], { encoding: "utf8" }).stdout;
  throw new Error(`${name} never got past the hook review\n${visible()}\n${log}`);
}
// The owner, as the Agents page acts: the link the TUI shows is opened by its token and allowed.
// The card must show the same code the TUI showed.
async function allowShown(name: string) {
  const shown = await until(() => /#connect=([A-Za-z0-9_-]{43})/.exec(screen(name)), "link in the TUI");
  const opened = await app.request("/api/agents/requests/open", { method: "POST", headers: json, body: JSON.stringify({ token: shown[1] }) });
  expect(opened.status).toBe(200);
  const card = await opened.json();
  expect(card.harness).toBe("codex");
  expect(screen(name)).toContain(`enter ${card.code} under Agents`);
  expect((await app.request(`/api/agents/requests/${card.id}`, { method: "POST", headers: json, body: JSON.stringify({ allow: true }) })).status).toBe(200);
}
const online = () => !!bindings()[0]?.lease_id;

beforeAll(() => { if (!codexBin || !tmuxBin) console.warn("codex or tmux not installed; skipping live Codex proof"); });
// Processes still running from inside root: the daemon's pid helper and Slirc's dormant listener.
const leftovers = () => (spawnSync("ps", ["-xo", "pid=,command="], { encoding: "utf8" }).stdout ?? "").split("\n")
  .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((match) => match && match[2].includes(root) && Number(match[1]) !== process.pid)
  .map((match) => Number(match![1]));
afterAll(async () => {
  try {
    tmux("kill-server");
    if (real) spawnSync(runtime, [cli, "uninstall", "--harness", "codex"], { env: { ...process.env, ...codexEnv }, timeout: 60_000 });
    if (codexBin && !daemonBefore) spawnSync(codexBin, ["app-server", "daemon", "stop"], { env: { ...process.env, ...codexEnv }, timeout: 15_000 });
    for (const pid of leftovers()) try { process.kill(pid); } catch {}
    for (let tries = 0; tries < 50 && leftovers().length; tries++) await Bun.sleep(100);
    for (const pid of leftovers()) try { process.kill(pid, "SIGKILL"); } catch {}
    server.stop(true); model.stop(true); peer.stop(true);
  } finally {
    // Each run's folder holds about 540 MB (Codex, its plugin and node_modules), so it goes now.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 90_000);

let binding: any;

run("slirc-agent sets up Codex and starts it; the link pairs that session only; local turns post nothing", async () => {
  window("main", `${runtime} '${cli}' ${host} --harness codex${flags ? ` -- ${flags}` : ""}`);
  await trustHooks("main", () => /#connect=/.test(screen("main")));
  // The launch typed `slirc <host>` as the first prompt: blocked, with the link, before any model call.
  await allowShown("main");
  binding = await until(() => bindings()[0]?.lease_id && bindings()[0], "attached binding");
  expect(bindings()).toHaveLength(1);
  expect(binding.harness).toBe("codex");
  expect(binding.nick).toMatch(/^codex-[0-9a-f]{4}$/);
  if (!real) expect(modelCalls.filter((call) => call.kind !== "title")).toEqual([]);
  // Neither the pairing prompt nor the link is in the transcript Codex keeps for the model.
  const rollouts = spawnSync("grep", ["-rl", "#connect=", join(codexHome, "sessions")], { encoding: "utf8" }).stdout.trim();
  expect(rollouts).toBe("");
  if (real) expect(spawnSync("grep", ["-rl", binding.session_id, join(codexHome, "sessions")], { encoding: "utf8" }).stdout).toContain(binding.session_id);

  await until(() => posts.some((post) => post.text.startsWith("Connected to your")), "introduction");
  const before = posts.length;
  keys("main", real ? "Reply with the single word ok." : "local question");
  if (real) await until(() => /Worked for/.test(screen("main").split("Reply with the single word ok.").at(-1) ?? ""), "local turn");
  else await until(() => modelCalls.some((call) => call.kind === "local") || (keys("main", ""), false), "local turn");
  await Bun.sleep(1_000);
  expect(posts.length).toBe(before);
}, 600_000);

run("an owner DM becomes one queued turn, and only slirc_reply posts, to its DM", async () => {
  const before = posts.length;
  const id = say("bitbonsai", binding.dm, real ? "What is two plus two? Answer with the number only." : "what is two plus two");
  const request = await until(() => requests().find((row) => row.original_msgid === id && row.status === "replied"), "replied");
  expect(request.binding_id).toBe(binding.id);
  const replies = posts.slice(before);
  expect(replies).toHaveLength(1);
  expect(lower(replies[0].from)).toBe(lower(binding.nick));
  expect(replies[0].target).toBe(lower(binding.dm));
  if (real) { console.log(`real model replied: ${replies[0].text}`); expect(replies[0].text).toContain("4"); }
  else expect(replies[0].text).toBe("codex answers: what is two plus two");
}, 600_000);

run("closing the TUI takes the agent offline; codex resume brings it back and it answers again", async () => {
  tmux("kill-session", "-t", "main");
  await until(() => !online(), "offline after the TUI closed");
  window("again", `codex resume ${binding.session_id} ${flags}`);
  // A resumed thread reconnects by itself once its window names it; no prompt needed.
  await trustHooks("again", online);
  await until(online, "online after resume");
  const id = say("bitbonsai", binding.dm, real ? "And three plus three? Answer with the number only." : "and three plus three");
  await until(() => requests().find((row) => row.original_msgid === id && row.status === "replied"), "replied after resume");
  if (real) expect(posts.at(-1)?.text).toContain("6");
  else expect(posts.at(-1)?.text).toBe("codex answers: and three plus three");
}, 600_000);
