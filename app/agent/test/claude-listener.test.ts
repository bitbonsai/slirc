import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeArm } from "../src/arm.ts";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The Claude Code listener as the Slirc mod runs it: a child process speaking JSON lines on stdout
// and serving the mod on a private Unix socket, against a fake Slirc session API.
const listener = resolve(import.meta.dir, "../src/harnesses/claude/listener.ts");
const root = mkdtempSync(join(tmpdir(), "slirc-cc-listener-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const pause = (ms = 20) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await pause();
  expect(check()).toBe(true);
}

const enc = new TextEncoder();
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
// `hold`: the owner hasn't pressed Allow yet, so /connect keeps answering owner_confirmation.
let hold = false;
const log = { tickets: [] as unknown[], sessionFiles: [] as string[], connects: 0, attaches: 0, detaches: 0, started: [] as string[], replies: [] as { id: string; text: string }[], fails: [] as { id: string; reason: string }[] };
const server = Bun.serve({ port: 0, fetch: async (req) => {
  const url = new URL(req.url);
  const json = await req.json().catch(() => ({})) as any;
  const id = url.pathname.split("/").at(-2)!;
  if (url.pathname === "/api/agent/session/request") log.tickets.push(json.ticket);
  if (url.pathname === "/api/agent/session/request") return Response.json({ url: `http://${url.host}/agents#connect=x`, code: "K7QX-M2PD", expiresAt: Date.now() + 600_000 });
  if (url.pathname === "/api/agent/session/connect" && hold) return Response.json({ error: "Waiting for Allow in Slirc.", code: "owner_confirmation" }, { status: 409 });
  if (url.pathname === "/api/agent/session/connect") { log.connects++; log.sessionFiles.push(json.sessionFile); return Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: "b-1", nick: "claude-3f2a", dm: "#dm", status: "ready" }); }
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

const env = { ...process.env, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), SLIRC_SOCKET_DIR: root, SLIRC_RETRY_MS: "200" };
type Run = { child: ChildProcess; lines: any[]; exit: Promise<number | null> };
function start(config: Record<string, unknown>): Run {
  const child = spawn(process.execPath, [listener, JSON.stringify(config)], { env, stdio: ["ignore", "pipe", "pipe"] });
  const lines: any[] = [];
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf("\n")) >= 0;) { lines.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
  });
  return { child, lines, exit: new Promise((done) => child.on("exit", (code) => done(code))) };
}
const line = (run: Run, type: string) => run.lines.find((item) => item.type === type);
function call(run: Run, route: string, body: unknown = {}, token = line(run, "ready").token): Promise<{ status: number; body: any }> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: line(run, "ready").socket, path: route, method: "POST", headers: { "x-slirc-token": token, "content-type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => done({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", fail);
    req.end(JSON.stringify(body));
  });
}

test("armed launch pairs, a request becomes one delivery, the reply posts, and an unanswered turn is failed", async () => {
  const run = start({ sessionId: "cc-session-one", cwd: "/tmp/repo", model: "claude-haiku", armed: `127.0.0.1:${server.port}` });
  try {
    await until(() => !!line(run, "connected"));
    expect(line(run, "link")).toMatchObject({ code: "K7QX-M2PD" });
    // The folder travels as the session file, for the away notice's resume command.
    expect(log.sessionFiles.at(-1)).toBe("/tmp/repo");
    expect(line(run, "connected").text).toContain("as claude-3f2a");
    // The allowed session leaves the mark the mod checks at start; others leave none.
    expect(line(run, "bound")).toBeTruthy();
    expect(existsSync(join(root, "state", "slirc-agent", "claude", "bound", "cc-session-one"))).toBe(true);
    expect((await call(run, "/reply", { requestId: "x", text: "y" }, "wrong")).status).toBe(403);

    push("request-one");
    await until(() => !!line(run, "deliver"));
    const delivery = line(run, "deliver");
    expect(delivery.id).toBe("request-one");
    expect(delivery.prompt).toContain("Slirc request request-one");
    expect(delivery.prompt).toContain(`Slirc delivery receipt: ${delivery.receipt}`);
    expect((await call(run, "/started", { receipt: "not-a-receipt" })).body).toEqual({ started: false });
    expect((await call(run, "/started", { receipt: delivery.receipt })).body).toEqual({ started: true, id: "request-one" });
    expect(log.started).toEqual(["request-one"]);
    expect((await call(run, "/reply", { requestId: "request-one", text: "Done." })).body.text).toContain("accepted the reply");
    expect(log.replies).toEqual([{ id: "request-one", text: "Done." }]);
    // The turn ending after a reply settles nothing.
    expect((await call(run, "/settle", { requestId: "request-one" })).body).toEqual({ settled: false });

    push("request-two");
    await until(() => run.lines.filter((item) => item.type === "deliver").length === 2);
    expect((await call(run, "/settle", { requestId: "request-two" })).body).toEqual({ settled: true });
    expect(log.fails).toEqual([{ id: "request-two", reason: "The Claude Code turn ended without a reply." }]);

    // A second listener for the same session stays out.
    const second = start({ sessionId: "cc-session-one", cwd: "/tmp/repo", model: "" });
    expect(await second.exit).toBe(3);
    expect(line(second, "busy")).toBeTruthy();
  } finally {
    run.child.kill("SIGTERM");
  }
  expect(await run.exit).toBe(0);
  expect(log.detaches).toBe(1);
  expect(existsSync(line(run, "ready").socket)).toBe(false);
});

test("a later start of the same session resumes without pairing again, and SIGTERM fails what is still open", async () => {
  const connects = log.connects;
  const run = start({ sessionId: "cc-session-one", cwd: "/tmp/repo", model: "" });
  try {
    await until(() => run.lines.some((item) => item.type === "notify" && item.message === "Slirc connected."));
    expect(line(run, "bound")).toBeTruthy();
    expect(log.connects).toBe(connects);
    expect(line(run, "link")).toBeUndefined();
    push("request-three");
    await until(() => !!line(run, "deliver"));
  } finally {
    run.child.kill("SIGTERM");
  }
  expect(await run.exit).toBe(0);
  expect(log.fails.at(-1)).toEqual({ id: "request-three", reason: "The Claude Code session closed before replying." });
});

test("/connect answers at once and an unpaired session's tools say how to connect", async () => {
  const run = start({ sessionId: "cc-session-two", cwd: "/tmp/repo", model: "" });
  try {
    await until(() => !!line(run, "ready"));
    expect(line(run, "bound")).toBeUndefined();
    expect(existsSync(join(root, "state", "slirc-agent", "claude", "bound", "cc-session-two"))).toBe(false);
    expect((await call(run, "/reply", { requestId: "r", text: "t" })).body.error).toContain("Type /slirc <workspace>");
    const asked = await call(run, "/connect", { workspace: `127.0.0.1:${server.port}` });
    expect(asked.body.text).toBe(`Open http://127.0.0.1:${server.port}/agents#connect=x to connect this session, or enter K7QX-M2PD under Agents in Slirc.`);
    await until(() => !!line(run, "connected"));
    expect((await call(run, "/connect", { workspace: "" })).body.text).toContain("Connected to");
  } finally {
    run.child.kill("SIGTERM");
  }
  expect(await run.exit).toBe(0);
});

test("a listener whose parent is killed with SIGKILL exits on its own", async () => {
  // A stand-in for Claude Code: starts the listener, prints its pid, then waits.
  const parent = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, [${JSON.stringify(listener)}, ${JSON.stringify(JSON.stringify({ sessionId: "cc-session-orphan", cwd: "/tmp", model: "" }))}], { stdio: ["ignore", "ignore", "ignore"] });
    console.log(child.pid); setInterval(() => {}, 1000);`], { env, stdio: ["ignore", "pipe", "ignore"] });
  const pid = await new Promise<number>((done) => parent.stdout!.once("data", (chunk) => done(Number(String(chunk).trim()))));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await pause(500);
  expect(alive()).toBe(true);
  parent.kill("SIGKILL");
  await until(() => !alive(), 8_000);
});

test("a session id that isn't a plain name is refused before anything is written", async () => {
  const run = start({ sessionId: "../escape", cwd: "/tmp", model: "" });
  expect(await run.exit).toBe(2);
  expect(existsSync(join(root, "state", "slirc-agent", "claude", "escape"))).toBe(false);
});

test("an arm file pairs only when the person's own prompt asked for it, and is taken once", async () => {
  const host = `127.0.0.1:${server.port}`;
  // The model ran slirc-agent on its own (a prompt that never named it): nothing pairs, the person
  // gets a notice, and a listener started only for this leaves.
  writeArm("claude", "cc-armed-refused", { host, ticket: "k7f2q9xdpa3m" }, env, Date.now(), [process.pid]);
  const refused = start({ sessionId: "cc-armed-refused", cwd: "/tmp/repo", model: "", arm: { prompt: "summarize README.md", command: "slirc" } });
  expect(await refused.exit).toBe(0);
  expect(line(refused, "notify")).toEqual({ type: "notify", message: `Something ran slirc-agent for ${host}. To connect, type /slirc ${host}.`, level: "warning" });
  expect(line(refused, "link")).toBeUndefined();
  expect(existsSync(join(env.XDG_STATE_HOME, "slirc-agent", "claude", "arm", "cc-armed-refused.json"))).toBe(false);

  // Armed from a shell outside this Claude Code (the listener's parent): dropped, nothing pairs.
  writeArm("claude", "cc-armed-elsewhere", { host }, env, Date.now(), [2 ** 22 + 7, 1]);
  const elsewhere = start({ sessionId: "cc-armed-elsewhere", cwd: "/tmp/repo", model: "", arm: { prompt: `npx slirc-agent ${host}`, command: "slirc" } });
  expect(await elsewhere.exit).toBe(0);
  expect(line(elsewhere, "link")).toBeUndefined();

  // The person pasted the command: the link shows and the ticket goes to Slirc.
  const before = log.tickets.length;
  writeArm("claude", "cc-armed", { host, ticket: "k7f2q9xdpa3m" }, env, Date.now(), [process.pid]);
  const run = start({ sessionId: "cc-armed", cwd: "/tmp/repo", model: "", arm: { prompt: `bunx slirc-agent@latest ${host} --ticket k7f2q9xdpa3m`, command: "slirc" } });
  try {
    await until(() => !!line(run, "connected"));
    expect(line(run, "link").code).toBe("K7QX-M2PD");
    expect(log.tickets.slice(before)).toEqual(["k7f2q9xdpa3m"]);
    // A second pickup finds nothing: the file was taken.
    expect((await call(run, "/arm", { prompt: `npx slirc-agent ${host}` })).status).toBe(200);
    await pause(100);
    expect(run.lines.filter((item) => item.type === "link")).toHaveLength(1);
    // Armed again while connected to the same workspace: said so, nothing new.
    writeArm("claude", "cc-armed", { host }, env, Date.now(), [process.pid]);
    await call(run, "/arm", { prompt: `npx slirc-agent ${host}` });
    await until(() => run.lines.some((item) => item.type === "notify" && item.message === "Already connected as claude-3f2a."));
  } finally {
    run.child.kill("SIGTERM");
    await run.exit;
  }
});

test("a fresh connect code pasted while the session waits for Allow asks again with it", async () => {
  // First install: the ticket expired while the owner reloaded, so the Agents page stopped waiting.
  // They copy the command again and paste it into the same session, still waiting for Allow.
  const host = `127.0.0.1:${server.port}`;
  hold = true;
  const before = log.tickets.length;
  writeArm("claude", "cc-armed-again", { host, ticket: "oldcode0001" }, env, Date.now(), [process.pid]);
  const run = start({ sessionId: "cc-armed-again", cwd: "/tmp/repo", model: "", arm: { prompt: `bunx slirc-agent@latest ${host} oldcode0001`, command: "slirc", starting: true } });
  try {
    await until(() => !!line(run, "link"));
    expect(log.tickets.slice(before)).toEqual(["oldcode0001"]);
    // The new code reaches Slirc, so the page that copied it gets its Allow card.
    writeArm("claude", "cc-armed-again", { host, ticket: "newcode0002" }, env, Date.now(), [process.pid]);
    await call(run, "/arm", { prompt: `bunx slirc-agent@latest ${host} newcode0002`, command: "slirc" });
    await until(() => log.tickets.length === before + 2);
    expect(log.tickets.slice(before)).toEqual(["oldcode0001", "newcode0002"]);
    await until(() => run.lines.filter((item) => item.type === "link").length === 2);
    expect(run.lines.some((item) => item.type === "notify" && /already waiting/.test(item.message))).toBe(false);
    // Pasted again without a code: no new request, the waiting link shows again.
    writeArm("claude", "cc-armed-again", { host }, env, Date.now(), [process.pid]);
    await call(run, "/arm", { prompt: `bunx slirc-agent@latest ${host}`, command: "slirc" });
    await until(() => run.lines.filter((item) => item.type === "link").length === 3);
    expect(log.tickets.length).toBe(before + 2);
    // Allow on the newest request connects once; the replaced attempt reports nothing.
    hold = false;
    await until(() => !!line(run, "connected"), 8_000);
    await pause(2_500);
    expect(run.lines.filter((item) => item.type === "connected")).toHaveLength(1);
    expect(run.lines.some((item) => item.type === "notify" && item.level === "error")).toBe(false);
  } finally {
    hold = false;
    run.child.kill("SIGTERM");
    await run.exit;
  }
});
