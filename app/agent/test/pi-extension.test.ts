import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import slirc from "../src/harnesses/pi/extension.ts";

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await pause(10);
  expect(check()).toBe(true);
}

test("two saved same-cwd Pi sessions attach independently and only explicit request reply posts", async () => {
  const root = mkdtempSync(join(tmpdir(), "slirc-pi-live-adapter-"));
  const config = join(root, "pi-config");
  const cwd = join(root, "same-worktree");
  mkdirSync(config, { recursive: true }); mkdirSync(cwd, { recursive: true });
  const files = [join(root, "one.jsonl"), join(root, "two.jsonl")];
  files.forEach((file) => writeFileSync(file, "{}\n"));
  const stateRoot = join(root, "state");
  const listeners = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const connected: { secret: string; binding: any }[] = [];
  const accepted: { binding: string; requestId: string }[] = [];
  const started: string[] = [];
  const replies: { binding: string; requestId: string; text: string; destination: string }[] = [];
  const enc = new TextEncoder();
  let next = 0;
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    const bearer = request.headers.get("Authorization")?.slice(7) || "";
    const lease = request.headers.get("X-Slirc-Agent-Lease") || "";
    const json = await request.json().catch(() => ({})) as any;
    if (url.pathname === "/api/agent/session/request") return Response.json({ url: `http://${url.host}/agents#connect=${"t".repeat(43)}`, code: "K7QX-M2PD", expiresAt: Date.now() + 600_000 });
    if (url.pathname === "/api/agent/session/connect") {
      const binding = { instanceId: "instance-1", ownerAccountId: "owner-account", bindingId: `binding-${++next}`, nick: `sa-${next}`, dm: `#dm-${next}`, status: "ready" };
      connected.push({ secret: bearer, binding });
      return Response.json(binding);
    }
    if (url.pathname === "/api/agent/session/attach") return Response.json({ leaseId: `lease-${next}`, expiresAt: Date.now() + 45_000, connected: true });
    if (url.pathname === "/api/agent/session/heartbeat") return Response.json({ expiresAt: Date.now() + 45_000 });
    if (url.pathname === "/api/agent/session/detach") return new Response(null, { status: 204 });
    if (url.pathname === "/api/agent/session/events") {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { listeners.set(bearer, controller); }, cancel() { listeners.delete(bearer); } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/accept")) {
      accepted.push({ binding: connected.find((item) => item.secret === bearer)!.binding.bindingId, requestId: url.pathname.split("/").at(-2)! });
      return Response.json({ id: url.pathname.split("/").at(-2), revision: json.revision, source: "#private", destination: "#private", text: "inspect this", context: [] });
    }
    if (url.pathname.endsWith("/started")) {
      started.push(url.pathname.split("/").at(-2)!);
      return Response.json({ status: "working" });
    }
    if (url.pathname.endsWith("/reply")) {
      replies.push({ binding: connected.find((item) => item.secret === bearer)!.binding.bindingId, requestId: url.pathname.split("/").at(-2)!, text: json.text, destination: "#private" });
      return Response.json({ status: "replying" });
    }
    return Response.json({ error: "missing route" }, { status: 404 });
  } });

  function fakeSession(sessionId: string, sessionFile: string) {
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    const events = new Map<string, any>();
    const messages: string[] = [];
    slirc({
      registerCommand: (name, options) => commands.set(name, options),
      registerTool: (options) => tools.set(options.name, options),
      on: (name, handler) => events.set(name, handler),
      sendUserMessage: (text) => messages.push(text),
    } as any);
    return {
      commands, tools, events, messages,
      ctx: { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getSessionName: () => sessionId }, ui: { notify() {} } },
    };
  }

  const previousConfig = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = stateRoot;
  const one = fakeSession("saved-session-one", files[0]);
  const two = fakeSession("saved-session-two", files[1]);
  try {
    { const command = one.commands.get("slirc"); await command.handler(`127.0.0.1:${server.port}`, one.ctx); await command.settled; }
    { const command = two.commands.get("slirc"); await command.handler(`127.0.0.1:${server.port}`, two.ctx); await command.settled; }
    await until(() => connected.length === 2 && listeners.size === 2);
    expect(connected.map(({ binding }) => binding.nick)).toEqual(["sa-1", "sa-2"]);
    expect(new Set(connected.map(({ secret }) => secret)).size).toBe(2);
    expect(connected.map(({ binding }) => binding.dm)).toEqual(["#dm-1", "#dm-2"]);

    listeners.get(connected[0].secret)!.enqueue(enc.encode("event: requests\ndata: [{\"id\":\"request-one\",\"revision\":1,\"source_channel\":\"#private\",\"reply_channel\":\"#private\",\"text\":\"inspect this\"}]\n\n"));
    await until(() => one.messages.length === 1);
    expect(two.messages).toHaveLength(0);
    await until(() => accepted.length === 1);
    expect(accepted).toEqual([{ binding: "binding-1", requestId: "request-one" }]);

    expect(started).toEqual([]); // Accepted/injected is not native execution.
    const start = one.events.get("message_start");
    await start({ message: { role: "assistant", content: one.messages[0] } }, one.ctx);
    await start({ message: { role: "user", content: "Slirc request request-one" } }, one.ctx);
    await start({ message: { role: "user", content: one.messages[0].split("\n\nSlirc delivery receipt:")[0] } }, one.ctx);
    await two.events.get("message_start")({ message: { role: "user", content: one.messages[0] } }, two.ctx);
    expect(started).toEqual([]);
    await start({ message: { role: "user", content: [{ type: "text", text: one.messages[0] }] } }, one.ctx);
    await start({ message: { role: "user", content: one.messages[0] } }, one.ctx);
    expect(started).toEqual(["request-one"]);

    const reply = one.tools.get("slirc_reply");
    await reply.execute("call-1", { requestId: "request-one", text: "Done." });
    expect(replies).toEqual([{ binding: "binding-1", requestId: "request-one", text: "Done.", destination: "#private" }]);
    await expect(two.tools.get("slirc_reply").execute("call-2", { requestId: "request-one", text: "Wrong session." })).rejects.toThrow("not active");
    expect(replies).toHaveLength(1);
    // No assistant lifecycle listener exists, so ordinary local turns cannot trigger a reply.
    expect(one.events.has("agent_end")).toBe(false);
  } finally {
    one.events.get("session_shutdown")?.(); two.events.get("session_shutdown")?.();
    await server.stop(true);
    if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension refuses ephemeral sessions before sending connect request", async () => {
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  slirc({ registerCommand: (name, options) => commands.set(name, options), registerTool() {}, on() {}, sendUserMessage() {} } as any);
  await commands.get("slirc").handler("123456", { sessionManager: { getSessionId: () => "ephemeral", getSessionFile: () => undefined }, ui: { notify: (message: string) => notifications.push(message) } });
  expect(notifications.join(" ")).toContain("saved Pi session");
});

test("no tool can start pairing; /slirc needs a workspace the first time; /slirc-connect says what changed", async () => {
  const state = mkdtempSync(join(tmpdir(), "slirc-pi-commands-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  try {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    slirc({ registerCommand: (name: string, options: any) => commands.set(name, options), registerTool: (options: any) => tools.set(options.name, options), on() {}, sendUserMessage() {} } as any);
    expect([...tools.keys()].sort()).toEqual(["slirc_delete", "slirc_fail", "slirc_history", "slirc_reply", "slirc_send"]);
    const notices: string[] = [];
    const ctx = { sessionManager: { getSessionId: () => "s", getSessionFile: () => join(state, "s.jsonl") }, ui: { notify: (text: string) => notices.push(text) } };
    { const command = commands.get("slirc"); await command.handler("", ctx); await command.settled; }
    expect(notices.at(-1)).toBe("Type /slirc <workspace>, using the workspace name shown on your Agents page in Slirc.");
    { const command = commands.get("slirc"); await command.handler("bad!name", ctx); await command.settled; }
    expect(notices.at(-1)).toContain("isn't a workspace name");
    await commands.get("slirc-connect").handler("123456", ctx);
    expect(notices.at(-1)).toBe("Slirc no longer uses codes from the Agents page. Type /slirc <workspace> instead.");
    mkdirSync(join(state, "slirc"), { recursive: true });
    writeFileSync(join(state, "slirc", "workspace"), "calango.slirc.app\n");
    await commands.get("slirc-connect").handler("123456", ctx);
    expect(notices.at(-1)).toBe("Slirc no longer uses codes from the Agents page. Type /slirc calango instead.");
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  }
});

test("a Pi started by slirc-agent pairs on its own, once, and remembers the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "slirc-pi-armed-"));
  const config = join(root, "pi-config");
  mkdirSync(config, { recursive: true });
  let asked = 0;
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/agent/session/request") { asked += 1; return Response.json({ url: `http://${url.host}/agents#connect=${"t".repeat(43)}`, code: "K7QX-M2PD", expiresAt: Date.now() + 600_000 }); }
    if (url.pathname === "/api/agent/session/connect") return Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: "b", nick: "pi-3f2a", dm: "#dm", status: "ready" });
    if (url.pathname === "/api/agent/session/attach") return Response.json({ leaseId: "l", expiresAt: Date.now() + 45_000, connected: true });
    if (url.pathname === "/api/agent/session/events") return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    if (url.pathname.endsWith("/heartbeat")) return Response.json({ expiresAt: Date.now() + 45_000 });
    if (url.pathname.endsWith("/detach")) return new Response(null, { status: 204 });
    return Response.json({ error: "missing" }, { status: 404 });
  } });
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, xdg: process.env.XDG_STATE_HOME };
  process.env.PI_CODING_AGENT_DIR = config;
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.SLIRC_CONNECT = `127.0.0.1:${server.port}`;
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const notices: string[] = [];
  slirc({ registerCommand() {}, registerTool() {}, on: (name: string, handler: any) => handlers.set(name, handler), sendUserMessage() {} } as any);
  // A fresh session: Pi has not written its file yet.
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "fresh", getSessionFile: () => join(root, "fresh.jsonl") }, ui: { notify: (text: string) => notices.push(text) } };
  try {
    handlers.get("session_start")!({ reason: "startup" }, ctx);
    expect(process.env.SLIRC_CONNECT).toBeUndefined();
    await until(() => notices.includes(`Connected to 127.0.0.1:${server.port} as pi-3f2a.`));
    expect(notices[0]).toContain("enter K7QX-M2PD under Agents");
    expect(asked).toBe(1);
    expect(readFileSync(join(root, "state", "slirc", "workspace"), "utf8").trim()).toBe(`127.0.0.1:${server.port}`);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.dir], ["XDG_STATE_HOME", saved.xdg]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    delete process.env.SLIRC_CONNECT;
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter reports session name, repo folder and model on connect and attach, then pushes renames and model switches", async () => {
  const root = mkdtempSync(join(tmpdir(), "slirc-pi-metadata-"));
  const repo = join(root, "private", "slirc.agent-server");
  const cwd = join(repo, "app", "agent");
  mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(cwd, { recursive: true });
  const file = join(root, "session.jsonl");
  writeFileSync(file, "{}\n");
  const bodies: { path: string; body: any }[] = [];
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    const body = await request.json().catch(() => undefined);
    bodies.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/connect")) return Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: "b", nick: "pi-a143", dm: "#dm-x", status: "ready" });
    if (url.pathname.endsWith("/attach")) return Response.json({ leaseId: "lease-1", expiresAt: Date.now() + 45_000, connected: true });
    if (url.pathname.endsWith("/metadata")) return Response.json({ agent: {} });
    if (url.pathname.endsWith("/history")) return Response.json({ channel: url.searchParams.get("channel"), query: url.search, lease: request.headers.get("X-Slirc-Agent-Lease"), messages: [] });
    if (url.pathname.endsWith("/req-9/send")) return Response.json({ status: "sent", messageId: "m-9" });
    if (url.pathname.endsWith("/req-9/delete")) return Response.json({ status: "deleted" });
    if (url.pathname.endsWith("/events")) return new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/event-stream" } });
    return new Response(null, { status: 204 });
  } });
  const previousConfig = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "state");
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const tools = new Map<string, any>();
  let name = "fix login";
  slirc({
    registerCommand: (key: string, options: any) => commands.set(key, options), registerTool: (options: any) => tools.set(options.name, options),
    on: (key: string, handler: any) => events.set(key, handler), sendUserMessage() {}, getSessionName: () => name,
  } as any);
  const ctx = { cwd, model: { id: "gpt-5.6-sol", provider: "openai-codex" }, sessionManager: { getSessionId: () => "meta-session", getSessionFile: () => file, getSessionName: () => "stale" }, ui: { notify() {} } };
  try {
    { const command = commands.get("slirc"); await command.handler(`127.0.0.1:${server.port}`, ctx); await command.settled; }
    const connect = bodies.find((item) => item.path.endsWith("/request"))!.body;
    expect([connect.sessionName, connect.repo, connect.model, connect.provider]).toEqual(["fix login", "slirc.agent-server", "gpt-5.6-sol", "openai-codex"]);
    expect(bodies.find((item) => item.path.endsWith("/attach"))!.body.metadata).toEqual({ name: "fix login", repo: "slirc.agent-server", model: "gpt-5.6-sol", provider: "openai-codex" });
    // Only the pairing calls carry the session file, which identifies the session; nothing else does.
    expect(JSON.stringify(bodies.filter((item) => !item.path.endsWith("/connect") && !item.path.endsWith("/request")))).not.toContain(root);
    name = "review";
    events.get("session_info_changed")({ type: "session_info_changed", name: "review" }, ctx);
    events.get("model_select")({ type: "model_select", model: { id: "claude-opus-5-5", provider: "anthropic" } }, ctx);
    events.get("model_select")({ type: "model_select", model: { id: "claude-opus-5-5", provider: "anthropic" } }, ctx); // Same model: nothing to send.
    await until(() => bodies.filter((item) => item.path.endsWith("/metadata")).length === 2);
    await pause(30);
    expect(bodies.filter((item) => item.path.endsWith("/metadata")).map((item) => item.body)).toEqual([
      { name: "review", repo: "slirc.agent-server", model: "gpt-5.6-sol", provider: "openai-codex" },
      { name: "review", repo: "slirc.agent-server", model: "claude-opus-5-5", provider: "anthropic" },
    ]);
    // slirc_history reads through the authenticated lease-bound route; channel/limit/before pass through.
    const read = await tools.get("slirc_history").execute("call-h", { channel: "#room", limit: 20, before: "m1" }, undefined, undefined, ctx);
    expect(JSON.parse(read.content[0].text)).toEqual({ channel: "#room", query: "?channel=%23room&limit=20&before=m1", lease: "lease-1", messages: [] });
    // slirc_send and slirc_delete go to the request's own routes; the server picks the room.
    expect((await tools.get("slirc_send").execute("call-s", { requestId: "req-9", text: "part 2" }, undefined, undefined, ctx)).content[0].text).toContain("m-9");
    expect((await tools.get("slirc_delete").execute("call-d", { requestId: "req-9", messageId: "m-9" }, undefined, undefined, ctx)).content[0].text).toBe("Deleted.");
    expect(bodies.filter((item) => /\/req-9\//.test(item.path)).map((item) => [item.path.split("/").pop(), item.body])).toEqual([["send", { text: "part 2" }], ["delete", { messageId: "m-9" }]]);
  } finally {
    await events.get("session_shutdown")?.();
    server.stop(true);
    if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dropped event stream reconnects quietly; only a sustained outage warns, then one reconnected notice", async () => {
  const root = mkdtempSync(join(tmpdir(), "slirc-pi-reconnect-"));
  const file = join(root, "session.jsonl");
  writeFileSync(file, "{}\n");
  let streams = 0;
  let attachFails = false;
  let current: ReadableStreamDefaultController<Uint8Array> | undefined;
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/connect")) return Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: "b", nick: "pi-a143", dm: "#dm-x", status: "ready" });
    if (url.pathname.endsWith("/attach")) return attachFails ? Response.json({ error: "down" }, { status: 502 }) : Response.json({ leaseId: "lease-1", expiresAt: Date.now() + 45_000, connected: true });
    if (url.pathname.endsWith("/events")) {
      if (attachFails) return Response.json({ error: "down" }, { status: 502 });
      streams += 1;
      // Like the real route, an immediate comment flushes the headers so the stream counts as open.
      return new Response(new ReadableStream({ start(controller) { current = controller; controller.enqueue(new TextEncoder().encode(": keepalive\n\n")); } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(null, { status: 204 });
  } });
  const previous = { config: process.env.PI_CODING_AGENT_DIR, warn: process.env.SLIRC_LOST_WARNING_MS, retry: process.env.SLIRC_RETRY_MS };
  process.env.PI_CODING_AGENT_DIR = join(root, "state");
  // Scaled down from 5 s retry / 30 s warning; the warning still outlasts several reattaches.
  process.env.SLIRC_RETRY_MS = "200";
  process.env.SLIRC_LOST_WARNING_MS = "1200";
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const notices: string[] = [];
  slirc({ registerCommand: (key: string, options: any) => commands.set(key, options), registerTool() {}, on: (key: string, handler: any) => events.set(key, handler), sendUserMessage() {} } as any);
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "reconnect-session", getSessionFile: () => file, getSessionName: () => "" }, ui: { notify: (text: string) => notices.push(text) } };
  try {
    { const command = commands.get("slirc"); await command.handler(`127.0.0.1:${server.port}`, ctx); await command.settled; }
    await until(() => streams === 1);
    const settled = notices.length;
    // A transient drop (server restart, proxy timeout): back on the next reattach, nothing shown.
    current!.error(new Error("terminated"));
    for (let i = 0; i < 800 && streams < 2; i++) await pause(10);
    expect(streams).toBe(2);
    expect(notices.slice(settled)).toEqual([]);
    // A longer outage warns once, then says once that it is back.
    attachFails = true;
    current!.error(new Error("terminated"));
    for (let i = 0; i < 1200 && !notices.includes("Slirc connection lost, retrying…"); i++) await pause(10);
    expect(notices.slice(settled)).toEqual(["Slirc connection lost, retrying…"]);
    attachFails = false;
    for (let i = 0; i < 800 && !notices.includes("Slirc reconnected."); i++) await pause(10);
    expect(notices.slice(settled)).toEqual(["Slirc connection lost, retrying…", "Slirc reconnected."]);
  } finally {
    await events.get("session_shutdown")?.();
    server.stop(true);
    for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.config], ["SLIRC_LOST_WARNING_MS", previous.warn], ["SLIRC_RETRY_MS", previous.retry]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("a Slirc rename is acked, set in Pi, and its session_info_changed echo sends nothing back", async () => {
  const root = mkdtempSync(join(tmpdir(), "slirc-pi-rename-"));
  const file = join(root, "session.jsonl");
  writeFileSync(file, "{}\n");
  const posts: any[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/connect")) return Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: "b", nick: "pi-a143", dm: "#dm-x", status: "ready" });
    if (url.pathname.endsWith("/attach")) return Response.json({ leaseId: "lease-1", expiresAt: Date.now() + 45_000, connected: true });
    if (url.pathname.endsWith("/metadata")) { posts.push(await request.json()); return Response.json({ agent: {} }); }
    if (url.pathname.endsWith("/events")) return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(": keepalive\n\n")); } }), { headers: { "Content-Type": "text/event-stream" } });
    return new Response(null, { status: 204 });
  } });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "state");
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const named: string[] = [];
  let piName = "old name";
  slirc({
    registerCommand: (key: string, options: any) => commands.set(key, options), registerTool() {}, on: (key: string, handler: any) => events.set(key, handler), sendUserMessage() {},
    getSessionName: () => piName,
    // Pi fires session_info_changed when the name changes; the echo must not bounce back.
    setSessionName: (name: string) => { named.push(name); piName = name; events.get("session_info_changed")({ type: "session_info_changed", name }); },
  } as any);
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "rename-session", getSessionFile: () => file, getSessionName: () => piName }, ui: { notify() {} } };
  try {
    { const command = commands.get("slirc"); await command.handler(`127.0.0.1:${server.port}`, ctx); await command.settled; }
    await until(() => !!stream);
    stream!.enqueue(new TextEncoder().encode(`event: rename\ndata: {"name":"from slirc"}\n\n`));
    await until(() => named.length === 1);
    await pause(50);
    expect(named).toEqual(["from slirc"]);
    expect(posts.map((body) => body.name)).toEqual(["from slirc"]); // The ack only; no echo.
    events.get("session_info_changed")({ type: "session_info_changed", name: "renamed in pi" });
    await until(() => posts.length === 2);
    expect(posts[1].name).toBe("renamed in pi");
  } finally {
    await events.get("session_shutdown")?.();
    server.stop(true);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
