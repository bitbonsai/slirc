import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeCodex } from "./fake-codex.ts";
import { writeArm } from "../../arm.ts";
import { boundMark, call, liveFile, readLive } from "./shared.ts";

// The Codex runtime as Codex runs it: hooks as one-shot commands with the event on stdin, the
// listener they start, and the stdio MCP server, against a fake Slirc session API and a fake
// `codex` that records what `codex queue` was given.
const runtime = resolve(import.meta.dir, "runtime.ts");
const fake = fakeCodex();
// Listeners run detached and wait dormant after the daemon goes; stop the ones this file started.
afterAll(() => {
  for (const thread of [THREAD, "01a1f2de-2cd9-75a0-a202-a71abf011fdb"]) { const live = readLive(env, thread); if (live) process.kill(live.pid); }
  fake.done();
});

const pause = (ms = 20) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => boolean, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await pause();
  expect(check()).toBe(true);
}

const enc = new TextEncoder();
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const log = { attaches: 0, detaches: 0, started: [] as string[], replies: [] as { id: string; text: string }[], fails: [] as { id: string; reason: string }[], harness: "", tickets: [] as (string | undefined)[] };
const server = Bun.serve({ port: 0, fetch: async (req) => {
  const url = new URL(req.url);
  const json = await req.json().catch(() => ({})) as any;
  const id = url.pathname.split("/").at(-2)!;
  if (url.pathname === "/api/agent/session/request") { log.harness = json.harness; log.tickets.push(json.ticket); return Response.json({ url: `http://${url.host}/agents#connect=x`, code: "K7QX-M2PD", expiresAt: Date.now() + 600_000 }); }
  if (url.pathname === "/api/agent/session/connect") return Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: "b-1", nick: "codex-3f2a", dm: "#dm", status: "ready" });
  if (url.pathname === "/api/agent/session/attach") { log.attaches++; return Response.json({ leaseId: `lease-${log.attaches}`, expiresAt: Date.now() + 45_000, connected: true }); }
  if (url.pathname === "/api/agent/session/heartbeat") return Response.json({ expiresAt: Date.now() + 45_000 });
  if (url.pathname === "/api/agent/session/detach") { log.detaches++; return new Response(null, { status: 204 }); }
  if (url.pathname === "/api/agent/session/events") {
    let mine: ReadableStreamDefaultController<Uint8Array>;
    return new Response(new ReadableStream<Uint8Array>({ start(c) { mine = c; streams.add(c); }, cancel() { streams.delete(mine); } }), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.pathname.endsWith("/accept")) return Response.json({ id, revision: json.revision, source: "#dm", destination: "#dm", author: "mauricio", text: `do ${id}`, context: [] });
  if (url.pathname.endsWith("/started")) { log.started.push(id); return Response.json({ status: "working" }); }
  if (url.pathname.endsWith("/reply")) { log.replies.push({ id, text: json.text }); return Response.json({ status: "replied" }); }
  if (url.pathname.endsWith("/fail")) { log.fails.push({ id, reason: json.reason }); return Response.json({ status: "failed" }); }
  return Response.json({ error: "missing route" }, { status: 404 });
} });
afterAll(() => server.stop(true));
const push = (id: string) => { for (const c of streams) c.enqueue(enc.encode(`event: requests\ndata: [{"id":"${id}","revision":1,"source_channel":"#dm","reply_channel":"#dm","text":"do ${id}"}]\n\n`)); };

// The Codex daemon stand-in: hooks and the listener watch this pid.
const daemon = spawn("sleep", ["120"], { stdio: "ignore" });
afterAll(() => daemon.kill());
const env = { ...process.env, ...fake.env, SLIRC_SOCKET_DIR: fake.root, SLIRC_RETRY_MS: "200", SLIRC_CODEX_DAEMON_PID: String(daemon.pid), SLIRC_CODEX_OWNER_POLL_MS: "200", SLIRC_CODEX_OFFLINE_MS: "600" };
const THREAD = "01a1ef73-22d7-7e61-90ef-5cf508a89f58";
const repo = join(fake.root, "repo");
mkdirSync(repo);

// A stand-in Codex TUI window: a process whose command is `codex ...`, sitting in the thread's folder.
mkdirSync(join(fake.root, "tui"));
symlinkSync(process.execPath, join(fake.root, "tui", "codex"));
const windows = new Set<ReturnType<typeof spawn>>();
afterAll(() => { for (const window of windows) window.kill(); });
function tui(args: string[]) {
  const window = spawn(join(fake.root, "tui", "codex"), ["-e", "setInterval(()=>{},1000)", ...args], { cwd: repo, stdio: "ignore" });
  windows.add(window);
  return window;
}

// Async, because the fake Slirc API runs in this process and must keep answering meanwhile.
async function hook(event: string, payload: Record<string, unknown>, extra: Record<string, string> = {}): Promise<any> {
  const child = spawn(process.execPath, [runtime, "hook", event], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout!.on("data", (chunk) => { out += chunk; });
  child.stdin!.end(JSON.stringify({ session_id: THREAD, cwd: repo, model: "gpt-5", ...payload }));
  await new Promise((done) => child.on("exit", done));
  return out ? JSON.parse(out) : {};
}

async function mcp(messages: any[]): Promise<any[]> {
  const child = spawn(process.execPath, [runtime, "mcp"], { env, stdio: ["pipe", "pipe", "inherit"] });
  const out: any[] = [];
  let buffer = "";
  child.stdout!.on("data", (chunk) => { buffer += chunk; for (let i; (i = buffer.indexOf("\n")) >= 0;) { out.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
  for (const message of messages) child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  await until(() => out.length === messages.filter((m) => m.id !== undefined).length, 20_000);
  child.stdin!.end();
  return out;
}
const reply = (thread: string | undefined, requestId: string, text: string) =>
  ({ id: 3, method: "tools/call", params: { name: "slirc_reply", arguments: { requestId, text }, ...(thread ? { _meta: { threadId: thread } } : {}) } });

test("a session Slirc never connected starts nothing and its tools refuse", async () => {
  expect(await hook("SessionStart", { source: "startup" })).toEqual({});
  expect(await hook("UserPromptSubmit", { prompt: "fix the bug", turn_id: "t0" })).toEqual({});
  expect(existsSync(liveFile(env, THREAD))).toBe(false);
  const [init, list, call] = await mcp([{ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, { id: 2, method: "tools/list" }, reply(THREAD, "r0", "hi")]);
  expect(init.result.serverInfo.name).toBe("slirc");
  expect(list.result.tools.map((tool: any) => tool.name)).toEqual(["slirc_reply", "slirc_send", "slirc_delete", "slirc_fail", "slirc_history", "slirc_owner_dms"]);
  expect(call.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("not connected") }] });
});

test("without the Codex daemon, typing slirc refuses and says how to start Codex", async () => {
  const out = await hook("UserPromptSubmit", { prompt: "slirc calango", turn_id: "t0" }, { SLIRC_CODEX_DAEMON_PID: "0" });
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("Start codex without those options");
});

test("typed slirc pairs, a request is queued, the reply posts, and an unanswered turn is failed", async () => {
  const out = await hook("UserPromptSubmit", { prompt: `slirc 127.0.0.1:${server.port}`, turn_id: "t1" });
  // The prompt is blocked before the model; the link shows as the reason, in the TUI only.
  expect(out.decision).toBe("block");
  expect(out.reason).toMatch(/Connected to 127\.0\.0\.1:\d+ as codex-3f2a|K7QX-M2PD/);
  expect(log.harness).toBe("codex");
  await until(() => existsSync(boundMark(env, THREAD)) && log.attaches === 1 && streams.size === 1);

  push("r1");
  await until(() => fake.queued().length === 1);
  const queued = fake.queued()[0];
  expect(queued.thread).toBe(THREAD);
  expect(queued.message).toContain("do r1");
  // The queued turn starts: its UserPromptSubmit carries the receipt.
  await hook("UserPromptSubmit", { prompt: queued.message, turn_id: "t2" });
  await until(() => log.started.includes("r1"));
  // The model's tool call names the thread in _meta; one without it, or for another thread, refuses.
  const [missing, other, sent] = await mcp([{ ...reply(undefined, "r1", "nope"), id: 1 }, { ...reply("someone-else", "r1", "nope"), id: 2 }, reply(THREAD, "r1", "done")]);
  expect(missing.result.isError).toBe(true);
  expect(other.result.isError).toBe(true);
  expect(sent.result.isError).toBeUndefined();
  expect(log.replies).toEqual([{ id: "r1", text: "done" }]);
  await hook("Stop", { turn_id: "t2" });
  expect(log.fails).toEqual([]);

  push("r2");
  await until(() => fake.queued().length === 2);
  await hook("UserPromptSubmit", { prompt: fake.queued()[1].message, turn_id: "t3" });
  await until(() => log.started.includes("r2"));
  await hook("Stop", { turn_id: "t3" });
  await until(() => log.fails.length === 1);
  expect(log.fails[0]).toEqual({ id: "r2", reason: "The Codex turn ended without a reply." });

  // Typing slirc again shows where the session stands, still without reaching the model.
  expect((await hook("UserPromptSubmit", { prompt: "slirc", turn_id: "t4" })).reason).toContain("as codex-3f2a");
}, 60_000);

test("the session goes offline when its Codex window closes, and comes back when the thread reopens", async () => {
  const window = tui([]);
  const watching = () => call(readLive(env, THREAD)!, "/watching");
  for (const end = Date.now() + 15_000; !(await watching()).seen && Date.now() < end;) await pause(100);
  expect((await watching()).seen).toBe(true);
  const [attached, detached] = [log.attaches, log.detaches];
  window.kill();
  await until(() => log.detaches === detached + 1);
  // The listener stays, dormant, for the thread to reopen.
  expect(readLive(env, THREAD)).toBeTruthy();
  push("r3");
  await pause(400);
  expect(fake.queued().length).toBe(2);
  // A new window in the same folder is another thread: still offline.
  const other = tui([]);
  await pause(1_500);
  expect(log.attaches).toBe(attached);
  other.kill();
  const reopened = tui(["resume", THREAD]);
  await until(() => log.attaches === attached + 1);
  reopened.kill();
  await until(() => log.detaches === detached + 2);
  // A prompt typed in the thread, from a window that doesn't name it, brings it back too.
  const picked = tui([]);
  await pause(1_000);
  await hook("UserPromptSubmit", { prompt: "local work", turn_id: "t5" });
  await until(() => log.attaches === attached + 2);
  picked.kill();
}, 60_000);

test("slirc-agent pasted by the person and run in the thread's shell pairs it when the turn ends", async () => {
  const host = `127.0.0.1:${server.port}`;
  const other = "01a1f2de-2cd9-75a0-a202-a71abf011fdb";
  // The person's prompts as Codex records them, with its own context block after the last one.
  const transcript = join(fake.root, "rollout.jsonl");
  const record = (...prompts: string[]) => writeFileSync(transcript, [...prompts, "<environment_context>cwd</environment_context>"].map((text) =>
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })).join("\n") + "\n");
  // The model ran it on its own: the arm is dropped and the person is told what to type.
  writeArm("codex", other, { host }, env, Date.now(), [process.pid, daemon.pid!]);
  record("set things up for me");
  expect((await hook("Stop", { session_id: other, turn_id: "a1", transcript_path: transcript })).systemMessage).toContain(`To connect, type slirc ${host}`);
  expect(readLive(env, other)).toBeUndefined();
  // The person's own prompt was the command: it pairs, with the connect code. No hook of ours saw
  // it typed, as when that same turn installed the plugin.
  record("set things up for me", `bunx slirc-agent@latest ${host} K7code1234`);
  writeArm("codex", other, { host, ticket: "K7code1234" }, env, Date.now(), [process.pid, daemon.pid!]);
  const out = await hook("Stop", { session_id: other, turn_id: "a2", transcript_path: transcript });
  expect(out.systemMessage).toMatch(/K7QX-M2PD|as codex-3f2a/);
  expect(log.tickets.at(-1)).toBe("K7code1234");
  await until(() => existsSync(boundMark(env, other)));
}, 60_000);

test("SessionEnd takes the session offline, and a resumed thread reconnects by itself", async () => {
  const live = readLive(env, THREAD)!;
  const [attached, detached] = [log.attaches, log.detaches];
  await hook("SessionEnd", { reason: "other" });
  await until(() => log.detaches === detached + 1);
  expect((await call(live, "/watching")).offline).toBe(true);
  await hook("SessionStart", { source: "resume" });
  await until(() => log.attaches === attached + 1);
  expect((await call(live, "/watching")).offline).toBe(false);
  expect(readLive(env, THREAD)!.pid).toBe(live.pid);
}, 30_000);

test("when the Codex daemon goes, the session goes offline and the listener waits for a reopen", async () => {
  const live = readLive(env, THREAD)!;
  daemon.kill();
  for (const end = Date.now() + 15_000; !(await call(live, "/watching")).offline && Date.now() < end;) await pause(100);
  expect((await call(live, "/watching")).offline).toBe(true);
  expect(readLive(env, THREAD)?.pid).toBe(live.pid);
  const reopened = tui(["resume", THREAD]);
  const attached = log.attaches;
  await until(() => log.attaches === attached + 1);
  reopened.kill();
}, 30_000);
