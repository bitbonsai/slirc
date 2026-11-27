import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeArm } from "../../arm.ts";
import plugin, { _registry } from "./plugin.ts";

// The server half against a fake OpenCode context and a fake Slirc. Real pieces: the plugin,
// SessionClient and its state files.

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await pause(10);
  expect(check()).toBe(true);
}

const enc = new TextEncoder();
const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
const log = { connected: [] as { secret: string; nick: string }[], attached: 0, detached: 0, started: [] as string[], replies: [] as { requestId: string; text: string }[], fails: [] as { requestId: string; reason: string }[], tickets: [] as string[] };
let bindings = 0;
let state: string;
let previous: string | undefined;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), "slirc-opencode-plugin-"));
  previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    const bearer = request.headers.get("Authorization")?.slice(7) || "";
    const json = await request.json().catch(() => ({})) as any;
    const path = url.pathname.replace("/api/agent/session", "");
    if (path === "/request") { if (json.ticket) log.tickets.push(json.ticket); } if (path === "/request") return Response.json({ url: `http://${url.host}/agents#connect=${"t".repeat(43)}`, code: "K7QX-M2PD", expiresAt: Date.now() + 600_000 });
    if (path === "/connect") {
      const nick = `opencode-${++bindings}`;
      log.connected.push({ secret: bearer, nick });
      return Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: `b-${bindings}`, nick, dm: `#dm-${bindings}`, status: "ready" });
    }
    if (path === "/attach") { log.attached++; return Response.json({ leaseId: `lease-${log.attached}`, expiresAt: Date.now() + 45_000, connected: true }); }
    if (path === "/heartbeat") return Response.json({ expiresAt: Date.now() + 45_000 });
    if (path === "/detach") { log.detached++; return new Response(null, { status: 204 }); }
    if (path === "/events") {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { streams.set(bearer, controller); }, cancel() { streams.delete(bearer); } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    const id = url.pathname.split("/").at(-2)!;
    if (path.endsWith("/accept")) return Response.json({ id, revision: json.revision, source: "#dm-1", destination: "#dm-1", text: "inspect this", context: [] });
    if (path.endsWith("/started")) { log.started.push(id); return Response.json({ status: "working" }); }
    if (path.endsWith("/reply")) { log.replies.push({ requestId: id, text: json.text }); return Response.json({ status: "replied" }); }
    if (path.endsWith("/fail")) { log.fails.push({ requestId: id, reason: json.reason }); return Response.json({ status: "failed" }); }
    return Response.json({ error: "missing route" }, { status: 404 });
  } });
});

afterAll(async () => {
  await server.stop(true);
  if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
  rmSync(state, { recursive: true, force: true });
});

// One plugin instance for one location, as OpenCode's service would load it.
async function instance(directory: string, version = "2.3.2") {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const prompts: { sessionID: string; text: string; delivery: string }[] = [];
  const notices: { sessionID: string; message: string; variant: string }[] = [];
  const hooks = new Map<string, (event: any) => void>();
  const queue: any[] = [];
  let wake: (() => void) | undefined;
  let rpc: any;
  const ctx = {
    app: { version },
    location: { directory },
    rpc: { register: async (_definition: any, handlers: any) => { rpc = handlers; return { events: { emit: async (_name: string, data: any) => { notices.push(data); } }, dispose() {} }; } },
    command: { transform: async (edit: any) => edit({ add: (definition: any) => commands.set(definition.name, definition) }) },
    tool: {
      transform: async (edit: any) => edit({ add: (definition: any) => tools.set(definition.name, definition) }),
      hook: async (name: string, handler: any) => { hooks.set(`tool.${name}`, handler); },
    },
    session: {
      get: async ({ sessionID }: any) => ({ id: sessionID, title: `title of ${sessionID}`, model: { id: "big-pickle", providerID: "opencode" }, location: { directory } }),
      context: async () => [{ type: "user", text: "an older prompt" }],
      prompt: async (input: any) => { prompts.push(input); return { id: `inbox-${prompts.length}-${input.sessionID}` }; },
      update: async () => {},
      hook: async (name: string, handler: any) => { hooks.set(`session.${name}`, handler); },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (queue.length) { yield queue.shift(); continue; }
            await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
          }
        },
      }),
    },
  };
  const cleanup = await plugin.setup(ctx);
  return {
    commands, tools, prompts, notices, cleanup,
    hook: (name: string, event: any) => hooks.get(name)!(event),
    rpc: () => rpc,
    event: (type: string, data: any) => { queue.push({ type, data }); wake?.(); },
    call: (name: string, input: any, sessionID: string) => tools.get(name).execute(input, { sessionID }),
  };
}

const host = () => `127.0.0.1:${server.port}`;
const offer = (secret: string, id: string) => streams.get(secret)!.enqueue(enc.encode(`event: requests\ndata: [{"id":"${id}","revision":1,"source_channel":"#dm-1","reply_channel":"#dm-1","text":"inspect this"}]\n\n`));

test("/slirc pairs that session with no model turn, and the link goes only to the TUI", async () => {
  const one = await instance("/work/one");
  try {
    expect([...one.tools.keys()].sort()).toEqual(["slirc_delete", "slirc_fail", "slirc_history", "slirc_owner_dms", "slirc_reply", "slirc_send"]);
    expect(one.tools.get("slirc_reply").options).toEqual({ codemode: false });
    await one.commands.get("slirc").execute({ sessionID: "ses_a", prompt: { text: host() }, delivery: "steer" });
    await until(() => one.notices.some((notice) => notice.message.startsWith("Connected")));
    expect(one.prompts).toEqual([]);
    expect(one.notices[0]).toMatchObject({ sessionID: "ses_a", variant: "info" });
    expect(one.notices[0].message).toContain("K7QX-M2PD");
    expect(log.connected.at(-1)!.nick).toBe("opencode-1");
    await until(() => streams.has(log.connected[0].secret));
  } finally { await one.cleanup(); }
});

test("a paired session is live only while a TUI shows it, and replies stay in that session", async () => {
  const one = await instance("/work/one");
  try {
    _registry.holds.clear(); _registry.tuis.clear();
    // The binding from the test above is stored; no TUI shows ses_a yet, so it stays offline.
    expect(_registry.live.has("ses_a")).toBe(false);
    await one.rpc().presence({ tui: "tui-1", sessions: ["ses_a", "ses_b"] });
    await until(() => streams.has(log.connected[0].secret) && _registry.live.get("ses_a")?.client.connected === true);
    expect(_registry.live.has("ses_b")).toBe(false); // open but never paired

    offer(log.connected[0].secret, "req-1");
    await until(() => one.prompts.length === 1);
    expect(one.prompts[0]).toMatchObject({ sessionID: "ses_a", delivery: "queue" });
    expect(one.prompts[0].text).toContain("Slirc request req-1");
    expect(log.started).toEqual([]);
    one.event("session.inbox.delivered", { sessionID: "ses_a", inboxID: "inbox-1-ses_a" });
    await until(() => log.started.length === 1);

    await expect(one.call("slirc_reply", { requestId: "req-1", text: "wrong" }, "ses_b")).rejects.toThrow("not attached");
    expect((await one.call("slirc_reply", { requestId: "req-1", text: "Done." }, "ses_a")).content).toContain("replied");
    expect(log.replies).toEqual([{ requestId: "req-1", text: "Done." }]);

    const detached = log.detached;
    await one.rpc().presence({ tui: "tui-1", sessions: [] });
    await until(() => log.detached === detached + 1);
    expect(_registry.live.has("ses_a")).toBe(false);
    await expect(one.call("slirc_history", {}, "ses_a")).rejects.toThrow("not attached");

    // Reopened: the same binding comes back without pairing again.
    const pairs = log.connected.length;
    await one.rpc().presence({ tui: "tui-2", sessions: ["ses_a"] });
    await until(() => _registry.live.get("ses_a")?.client.connected === true);
    expect(log.connected.length).toBe(pairs);
  } finally { await one.cleanup(); }
});

test("a TUI that stops reporting takes its sessions offline", async () => {
  const one = await instance("/work/one");
  try {
    _registry.holds.clear(); _registry.tuis.clear();
    await one.rpc().presence({ tui: "tui-3", sessions: ["ses_a"] });
    await until(() => _registry.live.get("ses_a")?.client.connected === true);
    _registry.tuis.get("tui-3")!.at -= 60_000;
    const detached = log.detached;
    await one.rpc().presence({ tui: "tui-4", sessions: [] });
    await until(() => log.detached === detached + 1);
  } finally { await one.cleanup(); }
});

test("only the instance for the folder a session was paired in runs it", async () => {
  const other = await instance("/work/other");
  try {
    _registry.holds.clear(); _registry.tuis.clear();
    await other.rpc().presence({ tui: "tui-5", sessions: ["ses_a"] });
    await pause(100);
    expect(_registry.live.has("ses_a")).toBe(false);
  } finally { await other.cleanup(); }
});

test("an unsupported OpenCode gets a notice for /slirc and no tools", async () => {
  const old = await instance("/work/new", "2.4.0");
  try {
    expect(old.tools.size).toBe(0);
    await old.commands.get("slirc").execute({ sessionID: "ses_c", prompt: { text: host() } });
    expect(old.notices.at(-1)).toMatchObject({ sessionID: "ses_c", variant: "error" });
    expect(old.notices.at(-1)!.message).toContain("supports OpenCode 2.3");
    expect(await old.rpc().presence({ tui: "tui-6", sessions: ["ses_c"] })).toEqual({ ok: false });
  } finally { await old.cleanup(); }
});

test("Esc on a turn that carried a Slirc request fails it with a plain message", async () => {
  const one = await instance("/work/one");
  try {
    _registry.holds.clear(); _registry.tuis.clear();
    await one.rpc().presence({ tui: "tui-7", sessions: ["ses_a"] });
    await until(() => _registry.live.get("ses_a")?.client.connected === true && streams.has(log.connected[0].secret));
    offer(log.connected[0].secret, "req-2");
    await until(() => one.prompts.length === 1);
    expect(one.prompts[0].text).toMatch(/Slirc delivery receipt: [0-9a-f-]{36}$/);
    one.event("session.inbox.delivered", { sessionID: "ses_a", inboxID: "inbox-1-ses_a" });
    await until(() => log.started.includes("req-2"));
    one.event("session.execution.interrupted", { sessionID: "ses_a", reason: "user" });
    await until(() => log.fails.length === 1);
    expect(log.fails[0]).toEqual({ requestId: "req-2", reason: "The agent was stopped before replying." });
    // A later interrupt with nothing running sends nothing.
    one.event("session.execution.interrupted", { sessionID: "ses_a", reason: "user" });
    await pause(100);
    expect(log.fails).toHaveLength(1);
  } finally { await one.cleanup(); }
});

test("an arm file pairs only after the person's own slirc-agent prompt", async () => {
  const one = await instance("/work/one");
  try {
    const arm = () => writeArm("opencode", "ses_d", { host: host(), ticket: "k7f2q9xdpa3m" }, process.env, Date.now(), [process.pid]);
    // The model ran it on its own: the latest prompt asked for something else.
    one.hook("session.prompt", { sessionID: "ses_d", prompt: { text: "fix the tests" } });
    arm();
    one.hook("tool.execute.after", { tool: "shell", sessionID: "ses_d" });
    await until(() => one.notices.some((notice) => notice.sessionID === "ses_d" && notice.variant === "warning"));
    const pairs = log.connected.length;
    // A Slirc delivery is never the person's prompt.
    one.hook("session.prompt", { sessionID: "ses_d", prompt: { text: `bunx slirc-agent@latest ${host()}\n\nSlirc delivery receipt: 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b` } });
    arm();
    one.hook("tool.execute.after", { tool: "shell", sessionID: "ses_d" });
    await pause(100);
    expect(log.connected.length).toBe(pairs);
    one.hook("session.prompt", { sessionID: "ses_d", prompt: { text: `bunx slirc-agent@latest ${host()}` } });
    arm();
    one.hook("tool.execute.after", { tool: "shell", sessionID: "ses_d" });
    await until(() => log.connected.length === pairs + 1);
    expect(log.tickets).toContain("k7f2q9xdpa3m");
  } finally { await one.cleanup(); }
});
