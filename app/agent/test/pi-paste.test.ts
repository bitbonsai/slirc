import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import slirc from "../src/harnesses/pi/extension.ts";
import { pairTiming } from "../src/adapter-core.ts";
import { VERSION } from "../src/version.ts";
import { fakePi, type FakePi } from "./support/fake-pi.ts";

// The one path people take: paste the Agents page's command into a Pi session. Whatever the model
// does with it (runs it in the background and sleeps, runs it twice, or never runs it) the session
// ends with one code. The command runs as the built CLI against a fake Pi; the extension runs here
// against a fake Slirc.

const bin = resolve(import.meta.dir, "../dist/slirc-agent.js");
const root = mkdtempSync(join(tmpdir(), "slirc-pi-paste-"));
const asked: any[] = [];
// The owner hasn't pressed Allow yet, so /connect keeps answering owner_confirmation.
let hold = true;
// The owner pressed Deny.
let deny = false;
let server: ReturnType<typeof Bun.serve>;
let fake: FakePi;
const saved = { state: process.env.XDG_STATE_HOME, home: process.env.HOME, dir: process.env.PI_CODING_AGENT_DIR };

beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    const url = new URL(request.url);
    const json = await request.json().catch(() => ({})) as any;
    if (url.pathname === "/api/agent/version") return Response.json({ version: VERSION, enabled: true });
    // The code "onpagecode12" stands for one a signed-in page minted: Slirc shows that page the request.
    if (url.pathname === "/api/agent/session/request") { asked.push(json); return Response.json({ url: `http://${url.host}/agents#connect=t`, code: `CODE-${asked.length}`, expiresAt: Date.now() + 600_000, ...(json.ticket === "onpagecode12" ? { onPage: true } : {}), ...(json.ticket === "expiredcode1" ? { connectCode: "expired" } : {}) }); }
    if (url.pathname === "/api/agent/session/connect" && deny) return Response.json({ error: "Not connected. You pressed Deny in Slirc.", code: "denied" }, { status: 403 });
    if (url.pathname === "/api/agent/session/connect") return hold
      ? Response.json({ error: "Waiting for Allow in Slirc.", code: "owner_confirmation" }, { status: 409 })
      : Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: "b", nick: "pi-3f2a", dm: "#dm", status: "ready" });
    if (url.pathname === "/api/agent/session/attach") return Response.json({ leaseId: "lease", expiresAt: Date.now() + 45_000, connected: true });
    if (url.pathname === "/api/agent/session/heartbeat") return Response.json({ expiresAt: Date.now() + 45_000 });
    if (url.pathname === "/api/agent/session/detach") return new Response(null, { status: 204 });
    if (url.pathname === "/api/agent/session/events") return new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ error: "missing route" }, { status: 404 });
  } });
  fake = fakePi();
  // The CLI and this runtime share one state folder, as on a real computer.
  process.env.XDG_STATE_HOME = fake.env.XDG_STATE_HOME;
  process.env.HOME = fake.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi");
});
afterAll(() => {
  process.env.XDG_STATE_HOME = saved.state; process.env.HOME = saved.home; process.env.PI_CODING_AGENT_DIR = saved.dir;
  server.stop(true);
  fake.done();
  rmSync(root, { recursive: true, force: true });
});

const host = () => `127.0.0.1:${server.port}`;
const armFile = (sessionId: string, reload = false) => join(fake.env.XDG_STATE_HOME, "slirc-agent", "pi", "arm", `${sessionId}${reload ? ".reload" : ""}.json`);

function session(sessionId: string, branch: any[] = []) {
  const events = new Map<string, any>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  // What Pi keeps in the transcript, and how its registered renderers draw it (plain theme).
  const entries: { type: string; data: any }[] = [];
  const renderers = new Map<string, any>();
  const file = join(root, `${sessionId}.jsonl`);
  writeFileSync(file, "{}\n");
  slirc({ registerCommand: (name: string, options: any) => commands.set(name, options), registerTool() {}, on: (name: string, handler: any) => events.set(name, handler), sendUserMessage() {},
    appendEntry: (type: string, data: any) => entries.push({ type, data }), registerEntryRenderer: (type: string, renderer: any) => renderers.set(type, renderer) } as any);
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file, getSessionName: () => "", getBranch: () => branch }, ui: { notify: (text: string) => notices.push(text) } };
  const plain = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
  return {
    notices, ctx, entries,
    // The Slirc blocks' text, newest last.
    blocks: () => entries.filter((entry) => entry.type === "slirc").map((entry) => entry.data.lines.join("\n")),
    // Every entry as the TUI draws it at 80 columns.
    drawn: () => entries.map((entry) => renderers.get(entry.type)(entry, { expanded: false }, plain).render(80).map((line: string) => line.trim()).filter(Boolean).join("\n")),
    paste: (text: string) => events.get("input")({ source: "interactive", text }, ctx),
    bashEnded: () => events.get("tool_execution_end")({ toolName: "bash" }, ctx),
    started: (reason: string) => events.get("session_start")({ reason }, ctx),
    settled: () => commands.get("slirc").settled as Promise<void>,
  };
}

// What Haiku ran: `(nohup bunx slirc-agent ... > log 2>&1 &); sleep 20; cat log`. The subshell
// exits at once, so the CLI's parent is gone while it runs.
async function backgrounded(sessionId: string, args: string[]): Promise<void> {
  const log = join(root, `${sessionId}-${Date.now()}.log`);
  const line = `(${[process.execPath, bin, ...args].map((word) => `'${word}'`).join(" ")} > '${log}' 2>&1 &)`;
  const shell = Bun.spawn(["/bin/sh", "-c", line], { env: { ...fake.env, PI_CODING_AGENT: "true", PI_SESSION_ID: sessionId }, stdin: "ignore" });
  expect(await shell.exited).toBe(0);
  for (let i = 0; i < 300 && !(await Bun.file(log).text().catch(() => "")).match(/Tell the owner|to finish/); i++) await Bun.sleep(20);
}

async function until(check: () => boolean, ms = 4_000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) await Bun.sleep(10);
  expect(check()).toBe(true);
}

const codes = (blocks: string[]) => blocks.filter((text) => /CODE-\d+/.test(text));
const connected = "Connected as pi-3f2a\nMessage it in Slirc: Agents → pi-3f2a";

test("pasted and never run: the paste stays as the person's message and a Slirc block connects the session", async () => {
  fake.install(`npm:slirc-agent@${VERSION}`);
  hold = false;
  const pi = session("paste-never");
  const before = asked.length;
  const pasted = `bunx slirc-agent@latest ${host()} k7f2q9xdpa3m`;
  // The model never gets the message, so it has nothing to run, but the person still sees it.
  expect(await pi.paste(pasted)).toEqual({ action: "handled" });
  await pi.settled();
  expect(asked.slice(before)).toMatchObject([{ sessionId: "paste-never", ticket: "k7f2q9xdpa3m" }]);
  expect(pi.entries[0]).toEqual({ type: "slirc-prompt", data: { text: pasted } });
  expect(pi.drawn()[0]).toBe(pasted);
  expect(pi.blocks()).toEqual([
    `Connecting to ${host()}\nOpen Agents in Slirc and enter  CODE-${before + 1}`,
    connected,
  ]);
  expect(pi.drawn().at(-1)).toBe("✓ Slirc  Connected as pi-3f2a\nMessage it in Slirc: Agents → pi-3f2a");
  expect(pi.notices).toEqual([]);
  // Anything else the person types goes to the model as usual.
  expect(await pi.paste("tidy the README")).toBeUndefined();
});

test("backgrounded and repeated runs of the same command show the same code and ask Slirc once", async () => {
  hold = true;
  const pi = session("paste-twice");
  const before = asked.length;
  expect(await pi.paste(`bunx slirc-agent@latest ${host()} k7f2q9xdpa3m`)).toEqual({ action: "handled" });
  await until(() => codes(pi.blocks()).length === 1);
  // Even if the model got it anyway: two backgrounded runs, each picked up when a later bash call
  // ends, and the same message pasted again.
  for (let run = 0; run < 2; run++) {
    await backgrounded("paste-twice", [host(), "k7f2q9xdpa3m"]);
    expect(existsSync(armFile("paste-twice"))).toBe(true);
    pi.bashEnded();
    expect(existsSync(armFile("paste-twice"))).toBe(false);
  }
  await pi.paste(`bunx slirc-agent@latest ${host()} k7f2q9xdpa3m`);
  expect(asked.length).toBe(before + 1);
  expect(new Set(codes(pi.blocks()).map((text) => /CODE-\d+/.exec(text)![0])).size).toBe(1);
  expect([...pi.notices, ...pi.blocks()].some((text) => /something ran slirc-agent|expired|error/i.test(text))).toBe(false);
  hold = false;
  await until(() => pi.blocks().at(-1) === connected, 6_000);
});

test("when the Agents page shows the request, the block says to press Allow there, and says once that it still waits", async () => {
  hold = true;
  const saved = pairTiming.onPageMs;
  pairTiming.onPageMs = 300;
  try {
    const pi = session("paste-onpage");
    expect(await pi.paste(`bunx slirc-agent@latest ${host()} onpagecode12`)).toEqual({ action: "handled" });
    await until(() => pi.blocks().length === 1);
    const code = /CODE-\d+/.exec(pi.blocks()[0])![0];
    expect(pi.blocks()).toEqual([`Connecting to ${host()}\nGo back to Slirc and press Allow.\nCode  ${code}`]);
    expect(pi.drawn()[1]).toBe(`● Slirc  Connecting to ${host()}\nGo back to Slirc and press Allow.\nCode  ${code}`);
    await until(() => pi.blocks().length === 2, 3_000);
    expect(pi.blocks()[1]).toBe("Still waiting. Press Allow on the Agents page.");
    await Bun.sleep(400);
    expect(pi.blocks()).toHaveLength(2);
    hold = false;
    await until(() => pi.blocks().at(-1) === connected, 6_000);
    expect(pi.blocks().join("\n")).not.toContain("http");
  } finally { pairTiming.onPageMs = saved; hold = false; }
});

test("a code the page no longer knows says so, with one thing to do", async () => {
  hold = true;
  try {
    const pi = session("paste-expired");
    await pi.paste(`bunx slirc-agent@latest ${host()} expiredcode1`);
    await until(() => pi.blocks().length === 1);
    expect(pi.blocks()).toEqual(["That code expired.\nPress Copy on the Agents page again and paste it here."]);
  } finally { hold = false; }
});

test("after Deny the block says in one sentence what happened", async () => {
  deny = true;
  try {
    const pi = session("paste-deny");
    await pi.paste(`bunx slirc-agent@latest ${host()} onpagecode12`);
    await pi.settled();
    expect(pi.blocks().at(-1)).toBe("Not connected. You pressed Deny in Slirc.");
    expect(pi.entries.at(-1)!.data.level).toBe("error");
  } finally { deny = false; }
});

test("first install, run in the background: the reloaded extension connects with the pasted code", async () => {
  // A fresh computer: no extension loaded, so the model has to run the command, and it backgrounds it.
  const empty = fakePi();
  const real = fake;
  fake = empty;
  process.env.XDG_STATE_HOME = empty.env.XDG_STATE_HOME;
  try {
    hold = false;
    const pasted = `bunx slirc-agent@latest ${host()} k7f2q9xdpa3m`;
    await backgrounded("paste-first", [host(), "k7f2q9xdpa3m"]);
    expect(empty.installed()).toEqual([`npm:slirc-agent@${VERSION}`]);
    expect(existsSync(armFile("paste-first", true))).toBe(true);
    // The person types /reload. The new runtime saw no input and reads the pasted message.
    const before = asked.length;
    const pi = session("paste-first", [{ type: "message", message: { role: "user", content: [{ type: "text", text: pasted }] } }]);
    pi.started("reload");
    await until(() => asked.length === before + 1);
    expect(asked.at(-1)).toMatchObject({ sessionId: "paste-first", ticket: "k7f2q9xdpa3m" });
    await until(() => codes(pi.blocks()).length === 1);
  } finally {
    fake = real;
    process.env.XDG_STATE_HOME = real.env.XDG_STATE_HOME;
    empty.done();
  }
});
