import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import slirc from "../src/harnesses/pi/extension.ts";

// Local protocol/mock harness only. It does not prove live Ergo, Pi, or provisioning behavior.
// Reattach after 200 ms instead of 5 s so retry and cancel cases finish quickly.
process.env.SLIRC_RETRY_MS = "200";
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) await pause(10);
  expect(check()).toBe(true);
}

type Hook = (info: any) => Response | Promise<Response>;

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "slirc-pi-lifecycle-"));
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  const enc = new TextEncoder();
  const state = {
    connected: [] as { secret: string; binding: any }[],
    attachCount: 0,
    detachCount: 0,
    detached: [] as string[],
    accepts: [] as { id: string; revision: number }[],
    replies: [] as { id: string; text: string; kind: string }[],
    statuses: [] as string[],
    streams: new Map<string, ReadableStreamDefaultController<Uint8Array>>(),
    singleLease: false,
    hooks: {} as { accept?: Hook; reply?: Hook; status?: Hook; attach?: Hook; connect?: Hook },
    leases: new Map<string, string>(),
    next: 0,
  };
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    const bearer = request.headers.get("Authorization")?.slice(7) || "";
    const lease = request.headers.get("X-Slirc-Agent-Lease") || "";
    const json = await request.json().catch(() => ({})) as any;
    if (url.pathname === "/api/agent/session/request") return Response.json({ url: `http://${url.host}/agents#connect=${"t".repeat(43)}`, code: "K7QX-M2PD", expiresAt: Date.now() + 600_000 });
    if (url.pathname === "/api/agent/session/connect") {
      const binding = { instanceId: "instance-1", ownerAccountId: "owner-account", bindingId: `binding-${++state.next}`, nick: `sa-${state.next}`, dm: `#dm-${state.next}`, status: "ready" };
      state.connected.push({ secret: bearer, binding });
      if (state.hooks.connect) return state.hooks.connect({ binding });
      return Response.json(binding);
    }
    if (url.pathname === "/api/agent/session/attach") {
      state.attachCount += 1;
      if (state.hooks.attach) return state.hooks.attach({ lease, nonce: json.nonce });
      if (state.leases.has(json.nonce)) return Response.json({ leaseId: state.leases.get(json.nonce), expiresAt: Date.now() + 45_000, connected: true });
      if (state.singleLease && state.leases.size > 0) return Response.json({ error: "session already attached" }, { status: 409 });
      const leaseId = `lease-${json.nonce}`;
      state.leases.set(json.nonce, leaseId);
      return Response.json({ leaseId, expiresAt: Date.now() + 45_000, connected: true });
    }
    if (url.pathname === "/api/agent/session/heartbeat") return Response.json({ expiresAt: Date.now() + 45_000 });
    if (url.pathname === "/api/agent/session/detach") { state.detachCount += 1; state.detached.push(lease); return new Response(null, { status: 204 }); }
    if (url.pathname === "/api/agent/session/events") {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { state.streams.set(bearer, controller); }, cancel() { state.streams.delete(bearer); } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/accept")) {
      const id = url.pathname.split("/").at(-2)!;
      state.accepts.push({ id, revision: json.revision });
      if (state.hooks.accept) return state.hooks.accept({ id, revision: json.revision, bearer });
      return Response.json({ id, revision: json.revision, source: "#private", destination: "#private", text: `work ${id}`, context: [] });
    }
    if (url.pathname.endsWith("/reply") || url.pathname.endsWith("/fail")) {
      const id = url.pathname.split("/").at(-2)!;
      const kind = url.pathname.endsWith("/fail") ? "fail" : "reply";
      state.replies.push({ id, text: kind === "fail" ? json.reason : json.text, kind });
      if (state.hooks.reply) return state.hooks.reply({ id, kind, text: json.text ?? json.reason });
      return Response.json({ status: kind === "fail" ? "failing" : "replying" });
    }
    if (url.pathname.startsWith("/api/agent/session/requests/")) {
      const id = url.pathname.split("/").at(-1)!;
      state.statuses.push(id);
      if (state.hooks.status) return state.hooks.status({ id });
      return Response.json({ id, revision: 1, status: "offered", reply_msgid: null, acceptedByLease: false });
    }
    return Response.json({ error: "missing route" }, { status: 404 });
  } });
  return { root, stateRoot, server, state, enc,
    push(secret: string, requests: unknown[]) {
      state.streams.get(secret)?.enqueue(enc.encode(`event: requests\ndata: ${JSON.stringify(requests)}\n\n`));
    },
    drop(secret: string) { state.streams.get(secret)?.close(); state.streams.delete(secret); } };
}

function makeSession(port: number, id: string, file: string) {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: string[] = [];
  const notifications: { message: string; type?: string }[] = [];
  slirc({
    registerCommand: (name, options) => commands.set(name, options),
    registerTool: (options) => tools.set(options.name, options),
    on: (name, handler) => events.set(name, handler),
    sendUserMessage: (text) => messages.push(text),
  } as any);
  let current = { id, file };
  const ctx = {
    cwd: dirname(file),
    sessionManager: { getSessionId: () => current.id, getSessionFile: () => current.file, getSessionName: () => current.id },
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
  };
  return {
    commands, tools, events, messages, notifications, ctx,
    setIdentity: (nextId: string, nextFile: string) => { current = { id: nextId, file: nextFile }; },
    fire: (name: string) => (events.get(name) as any)?.({}, ctx),
    connect: async (_code?: string) => { const command = commands.get("slirc"); await command.handler(`127.0.0.1:${port}`, ctx); await command.settled; },
    reply: async (ctxArg: any, id: string, text: string) => {
      const result = await tools.get("slirc_reply").execute("call", { requestId: id, text }, undefined, undefined, ctxArg);
      return result.content[0].text as string;
    },
  };
}

const previousConfig = process.env.PI_CODING_AGENT_DIR;
function useStateRoot(root: string) { process.env.PI_CODING_AGENT_DIR = root; }
function restoreConfig() { if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousConfig; }

test("a not-ready attach retries with the same incarnation and only then starts SSE", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-ready-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-ready", file);
  let calls = 0;
  h.state.hooks.attach = () => { calls += 1; return Response.json({ leaseId: "lease-ready", expiresAt: Date.now() + 45_000, connected: calls > 1 }); };
  try {
    await session.connect("111111");
    await until(() => h.state.attachCount === 1);
    await pause(30);
    expect(h.state.streams.size).toBe(0);
    expect(session.notifications.some((item) => item.message.includes("Waiting"))).toBe(true);
    await until(() => h.state.attachCount >= 2, 700);
    await until(() => h.state.streams.size === 1, 200);
    expect(session.notifications.some((item) => item.message.includes("connected"))).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
}, 15_000);

test("shutdown cancels a pending readiness retry", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-ready-cancel-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-ready-cancel", file);
  h.state.hooks.attach = () => Response.json({ leaseId: "lease-notready", expiresAt: Date.now() + 45_000, connected: false });
  try {
    await session.connect("111111");
    await until(() => h.state.attachCount === 1);
    session.fire("session_shutdown");
    await pause(600);
    expect(h.state.attachCount).toBe(1);
  } finally {
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
}, 15_000);

test("journal capacity retains uncertain receipts and stops new dispatch", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-journal-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-journal", file);
  h.state.hooks.accept = () => new Response("lost", { status: 500 });
  h.state.hooks.status = (info) => Response.json({ id: info.id, revision: 1, status: "accepted", reply_msgid: null, acceptedByLease: true });
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    const secret = h.state.connected[0].secret;
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `uncertain-${i}`, revision: 1, source_channel: "#private", reply_channel: "#private", text: `work ${i}` }));
    h.push(secret, many);
    await until(() => h.state.accepts.length === 200, 600);
    h.push(secret, [{ id: "blocked-new", revision: 1, source_channel: "#private", reply_channel: "#private", text: "blocked" }]);
    await until(() => session.notifications.some((item) => item.message.includes("recovery limit")), 200);
    await pause(40);
    expect(h.state.accepts.some((item) => item.id === "blocked-new")).toBe(false);
    expect(session.messages).toHaveLength(0);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
}, 20_000);

test("a new bootstrap during an earlier readState cannot activate the old identity", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-race-bootstrap-"));
  const fileA = join(root, "a.jsonl"), fileB = join(root, "b.jsonl");
  writeFileSync(fileA, "{}\n"); writeFileSync(fileB, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-a", fileA);
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    session.fire("session_shutdown");
    await pause(20);
    const attaches = h.state.attachCount;
    // Two bootstraps in the same tick: the first awaits readState, the second invalidates its epoch.
    session.setIdentity("saved-a", fileA);
    session.fire("session_start");
    session.setIdentity("saved-b", fileB);
    session.fire("session_start");
    await pause(80);
    expect(h.state.attachCount).toBe(attaches);
    expect(session.messages).toHaveLength(0);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("a switch during a held connect keeps the receipt on the old identity and never activates it", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-race-connect-"));
  const fileA = join(root, "a.jsonl"), fileB = join(root, "b.jsonl");
  writeFileSync(fileA, "{}\n"); writeFileSync(fileB, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-a", fileA);
  let release!: () => void;
  h.state.hooks.connect = async () => { await new Promise<void>((resolve) => { release = resolve; }); return Response.json({ instanceId: "instance-1", ownerAccountId: "owner-account", bindingId: "binding-held", nick: "sa-held", dm: "#dm-held", status: "ready" }); };
  try {
    const connecting = session.connect("111111");
    await until(() => h.state.connected.length === 1);
    session.setIdentity("saved-b", fileB);
    session.fire("session_before_switch");
    session.fire("session_start");
    await pause(20);
    release();
    await connecting;
    await pause(40);
    expect(h.state.attachCount).toBe(0);
    expect(h.state.streams.size).toBe(0);
    expect(session.messages).toHaveLength(0);
    const dir = join(h.stateRoot, "slirc");
    const saved = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    expect(saved.binding.bindingId).toBe("binding-held");
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("switch during a held attach never binds the stale incarnation", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-attach-"));
  const fileOne = join(root, "one.jsonl"), fileTwo = join(root, "two.jsonl");
  writeFileSync(fileOne, "{}\n"); writeFileSync(fileTwo, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-one", fileOne);
  let release!: () => void;
  h.state.hooks.attach = async () => { await new Promise<void>((resolve) => { release = resolve; }); return Response.json({ leaseId: "lease-late", expiresAt: Date.now() + 45_000, connected: true }); };
  try {
    const connecting = session.connect("111111");
    await until(() => h.state.attachCount === 1);
    session.setIdentity("saved-two", fileTwo);
    session.fire("session_before_switch");
    session.fire("session_start");
    await pause(20);
    release();
    await connecting;
    await pause(40);
    expect(h.state.streams.size).toBe(0);
    expect(session.messages).toHaveLength(0);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("switch during a held accept injects nothing into either session", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-switch-"));
  const fileOne = join(root, "one.jsonl"), fileTwo = join(root, "two.jsonl");
  writeFileSync(fileOne, "{}\n"); writeFileSync(fileTwo, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-one", fileOne);
  let release!: () => void;
  h.state.hooks.accept = async () => { await new Promise<void>((resolve) => { release = resolve; }); return Response.json({ id: "r1", revision: 1, source: "#private", destination: "#private", text: "held", context: [] }); };
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    h.push(h.state.connected[0].secret, [{ id: "r1", revision: 1, source_channel: "#private", reply_channel: "#private", text: "held" }]);
    await until(() => h.state.accepts.length === 1);
    // Switch to an unbound saved session while the accept response is outstanding.
    session.setIdentity("saved-two", fileTwo);
    session.fire("session_before_switch");
    session.fire("session_start");
    await pause(20);
    release();
    await pause(60);
    expect(session.messages).toHaveLength(0);
    expect(session.notifications.some((item) => item.message.includes("held"))).toBe(false);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("stale invocation context cannot reply; a fork during a held reply does not notify the new session", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-fork-"));
  const fileOne = join(root, "one.jsonl"), fileTwo = join(root, "two.jsonl");
  writeFileSync(fileOne, "{}\n"); writeFileSync(fileTwo, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-one", fileOne);
  let release!: () => void;
  h.state.hooks.reply = async () => { await new Promise<void>((resolve) => { release = resolve; }); return Response.json({ status: "replying" }); };
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    h.push(h.state.connected[0].secret, [{ id: "r1", revision: 1, source_channel: "#private", reply_channel: "#private", text: "do it" }]);
    await until(() => session.messages.length === 1);
    const oldCtx = session.ctx;
    const held = session.reply(oldCtx, "r1", "done");
    await until(() => h.state.replies.length === 1);
    session.setIdentity("saved-two", fileTwo);
    session.fire("session_before_fork");
    session.fire("session_start");
    await pause(20);
    release();
    expect(await held).toContain("session changed");
    expect(session.messages).toHaveLength(1);
    expect(session.notifications.some((item) => item.message.includes("accepted the reply"))).toBe(false);
    // The new context has no attachment, so the tool refuses.
    await expect(session.reply(session.ctx, "r1", "again")).rejects.toThrow("not attached");
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("accept intent is journaled before the HTTP call, including an offered retry", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-intent-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-intent", file);
  let mode = "busy";
  let release: (() => void) | undefined;
  h.state.hooks.accept = async (info) => {
    if (mode === "busy") return Response.json({ error: "another request is active", code: "busy" }, { status: 409 });
    await new Promise<void>((resolve) => { release = resolve; });
    return Response.json({ id: info.id, revision: info.revision, source: "#private", destination: "#private", text: "work r1", context: [] });
  };
  const journalStatus = () => {
    const dir = join(h.stateRoot, "slirc");
    const saved = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    return saved.requests.r1?.status as string | undefined;
  };
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    const secret = h.state.connected[0].secret;
    const frame = [{ id: "r1", revision: 1, source_channel: "#private", reply_channel: "#private", text: "first" }];
    h.push(secret, frame);
    await until(() => h.state.accepts.length === 1);
    await until(() => journalStatus() === "offered");
    mode = "hang";
    h.push(secret, frame);
    await until(() => journalStatus() === "accepting");
    // The journal says accepting before the request reaches the server; wait for the held hook.
    await until(() => release !== undefined);
    release!();
    await until(() => journalStatus() === "injected");
    expect(h.state.accepts.filter((item) => item.id === "r1")).toHaveLength(2);
    expect(session.messages).toHaveLength(1);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("a duplicate saved-session attach is a conflict, not a takeover", async () => {
  const h = makeHarness();
  h.state.singleLease = true;
  const root = mkdtempSync(join(tmpdir(), "slirc-dup-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const one = makeSession(h.server.port, "saved-dup", file);
  const two = makeSession(h.server.port, "saved-dup", file);
  try {
    await one.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    await two.connect("111111");
    await pause(30);
    expect(h.state.attachCount).toBe(2);
    expect(two.messages).toHaveLength(0);
    expect(two.notifications.some((item) => item.message.includes("already attached"))).toBe(true);
    h.push(h.state.connected[0].secret, [{ id: "r1", revision: 1, source_channel: "#private", reply_channel: "#private", text: "only one" }]);
    await until(() => one.messages.length === 1);
    expect(two.messages).toHaveLength(0);
  } finally {
    one.fire("session_shutdown"); two.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("replay and a lost accept response never execute twice", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-replay-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-replay", file);
  h.state.hooks.accept = (info) => info.id === "r2" ? new Response("lost", { status: 500 }) : Response.json({ id: info.id, revision: info.revision, source: "#private", destination: "#private", text: `work ${info.id}`, context: [] });
  h.state.hooks.status = (info) => Response.json({ id: info.id, revision: 1, status: "accepted", reply_msgid: null, acceptedByLease: true });
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    const secret = h.state.connected[0].secret;
    const frame = [{ id: "r1", revision: 1, source_channel: "#private", reply_channel: "#private", text: "once" }];
    h.push(secret, frame);
    await until(() => session.messages.length === 1);
    h.push(secret, frame); // replay
    await pause(40);
    expect(h.state.accepts.filter((item) => item.id === "r1")).toHaveLength(1);
    expect(session.messages).toHaveLength(1);
    // Lost accept response: resolved through status as uncertain, not injected, not re-accepted.
    const lost = [{ id: "r2", revision: 1, source_channel: "#private", reply_channel: "#private", text: "lost" }];
    h.push(secret, lost);
    await until(() => h.state.statuses.includes("r2"));
    await pause(30);
    expect(session.messages).toHaveLength(1);
    h.push(secret, lost);
    await pause(40);
    expect(h.state.accepts.filter((item) => item.id === "r2")).toHaveLength(1);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("a busy sibling stays eligible and is accepted after the active request finishes", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-busy-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-busy", file);
  let busy = false;
  h.state.hooks.accept = (info) => {
    if (info.id === "r1") return Response.json({ id: info.id, revision: info.revision, source: "#private", destination: "#private", text: "work r1", context: [] });
    if (busy) return Response.json({ error: "another request is active", code: "busy" }, { status: 409 });
    return Response.json({ id: info.id, revision: info.revision, source: "#private", destination: "#private", text: "work r2", context: [] });
  };
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    const secret = h.state.connected[0].secret;
    h.push(secret, [{ id: "r1", revision: 1, source_channel: "#private", reply_channel: "#private", text: "first" }]);
    await until(() => session.messages.some((message) => message.includes("work r1")));
    busy = true;
    h.push(secret, [{ id: "r2", revision: 1, source_channel: "#private", reply_channel: "#private", text: "second" }]);
    await until(() => h.state.accepts.some((item) => item.id === "r2"));
    await pause(30);
    expect(h.state.accepts.filter((item) => item.id === "r2")).toHaveLength(1);
    expect(session.messages.some((message) => message.includes("work r2"))).toBe(false);
    busy = false;
    h.push(secret, [{ id: "r2", revision: 1, source_channel: "#private", reply_channel: "#private", text: "second" }]);
    await until(() => session.messages.some((message) => message.includes("work r2")));
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("a lost reply response reconciles the same produced reply without rerunning the model", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-reply-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-reply", file);
  let replyAttempts = 0;
  h.state.hooks.reply = () => { replyAttempts += 1; return replyAttempts === 1 ? new Response("lost", { status: 500 }) : Response.json({ status: "replying" }); };
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    h.push(h.state.connected[0].secret, [{ id: "r1", revision: 1, source_channel: "#private", reply_channel: "#private", text: "do it" }]);
    await until(() => session.messages.length === 1);
    const first = await session.reply(session.ctx, "r1", "done");
    expect(first).toContain("did not confirm");
    const second = await session.reply(session.ctx, "r1", "done");
    expect(second).toContain("replying");
    expect(h.state.replies.map((item) => item.text)).toEqual(["done", "done"]);
    await expect(session.reply(session.ctx, "r1", "different")).rejects.toThrow("different outcome");
    expect(session.messages).toHaveLength(1);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("an uncertain reply is announced, keeps its text, and a repeated reply resends it under the same reply", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-uncertain-reply-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "uncertain-reply", file);
  let statusCalls = 0;
  h.state.hooks.status = () => Response.json({ id: "r1", revision: 1, status: ++statusCalls === 1 ? "uncertain" : "replied", reply_msgid: null, acceptedByLease: true });
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    h.push(h.state.connected[0].secret, [{ id: "r1", revision: 1, source_channel: "#private", reply_channel: "#private", text: "do it" }]);
    await until(() => session.messages.length === 1);
    expect(await session.reply(session.ctx, "r1", "done")).toContain("replying");
    // The poll reports uncertainty: the owner sees it in the session, not only in the tool result.
    await until(() => session.notifications.some((item) => item.message.includes("could not confirm the reply to request r1")), 400);
    expect(session.notifications.find((item) => item.message.includes("could not confirm"))?.type).toBe("warning");
    // No more "not active": the same reply resends the kept text.
    expect(await session.reply(session.ctx, "r1", "done")).toContain("replying");
    expect(h.state.replies.map((item) => item.text)).toEqual(["done", "done"]);
    await expect(session.reply(session.ctx, "r1", "different")).rejects.toThrow("different outcome");
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("an uncertain reply is resent automatically on reattach under the same reply text", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-uncertain-reattach-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "uncertain-reattach", file);
  let statusCalls = 0;
  h.state.hooks.status = () => Response.json({ id: "r1", revision: 1, status: ++statusCalls === 1 ? "uncertain" : "replied", reply_msgid: null, acceptedByLease: true });
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    h.push(h.state.connected[0].secret, [{ id: "r1", revision: 1, source_channel: "#private", reply_channel: "#private", text: "do it" }]);
    await until(() => session.messages.length === 1);
    expect(await session.reply(session.ctx, "r1", "done")).toContain("replying");
    await until(() => session.notifications.some((item) => item.message.includes("could not confirm")), 400);
    // The event stream drops; the reattach reconciles the uncertain reply with no agent call.
    h.drop(h.state.connected[0].secret);
    await until(() => h.state.replies.length === 2, 400);
    expect(h.state.replies.map((item) => item.text)).toEqual(["done", "done"]);
    expect(session.messages).toHaveLength(1);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});

test("shutdown cancels a scheduled reattach", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-shutdown-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-shutdown", file);
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    const attaches = h.state.attachCount;
    h.drop(h.state.connected[0].secret); // stream ends, schedules a reattach
    await pause(30);
    session.fire("session_shutdown");
    await pause(600);
    expect(h.state.attachCount).toBe(attaches);
    expect(h.state.detachCount).toBe(1);
  } finally {
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
}, 15_000);

test("an oversized SSE frame is rejected and reconnects instead of buffering forever", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-sse-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-sse", file);
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    const attaches = h.state.attachCount;
    h.state.streams.get(h.state.connected[0].secret)!.enqueue(h.enc.encode(`event: requests\ndata: [${"x".repeat(140 * 1024)}`));
    // The stream is dropped and reattached quietly; a short outage shows no notice.
    await until(() => h.state.attachCount > attaches, 700);
    expect(session.notifications.some((item) => item.message.includes("frame buffer"))).toBe(false);
    expect(session.messages).toHaveLength(0);
  } finally {
    session.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
}, 15_000);

test("a conflicting duplicate never detaches the original lease, and retries after it expires", async () => {
  const h = makeHarness();
  h.state.singleLease = true;
  const root = mkdtempSync(join(tmpdir(), "slirc-dup-lease-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const one = makeSession(h.server.port, "saved-dup-lease", file);
  try {
    await one.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    const original = [...h.state.leases.values()][0];
    // A second runtime on the same saved session loads the persisted file, lease included.
    const two = makeSession(h.server.port, "saved-dup-lease", file);
    await two.fire("session_start");
    await until(() => two.notifications.some((item) => item.message.includes("already attached")));
    await two.fire("session_shutdown");
    expect(h.state.detached).not.toContain(original);

    // A crashed incarnation stops heartbeating and its lease expires: a resumed runtime attaches.
    const three = makeSession(h.server.port, "saved-dup-lease", file);
    await three.fire("session_start");
    await until(() => three.notifications.some((item) => item.message.includes("already attached")));
    const attaches = h.state.attachCount;
    h.state.leases.clear();
    await until(() => h.state.attachCount > attaches && h.state.leases.size === 1, 700);
    expect(three.notifications.filter((item) => item.message.includes("already attached"))).toHaveLength(1);
    await three.fire("session_shutdown");
  } finally {
    await one.fire("session_shutdown");
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
}, 15_000);

test("shutdown finishes its own detach before Pi exits", async () => {
  const h = makeHarness();
  const root = mkdtempSync(join(tmpdir(), "slirc-shutdown-wait-"));
  const file = join(root, "saved.jsonl");
  writeFileSync(file, "{}\n");
  useStateRoot(h.stateRoot);
  const session = makeSession(h.server.port, "saved-shutdown-wait", file);
  try {
    await session.connect("111111");
    await until(() => h.state.streams.has(h.state.connected[0].secret));
    const lease = [...h.state.leases.values()][0];
    await session.fire("session_shutdown");
    expect(h.state.detached).toEqual([lease]);
  } finally {
    restoreConfig(); rmSync(root, { recursive: true, force: true }); await h.server.stop(true); rmSync(h.root, { recursive: true, force: true });
  }
});
