import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { errorText, repoName, SessionClient, statePath, type Adapter, type Identity, type Metadata, type PairLink } from "../../adapter-core.ts";
import { VERSION } from "../../version.ts";
import { expandWorkspace, originFor, readLastWorkspace, saveLastWorkspace } from "../../workspace.ts";
import { alive, boundMark, dir, liveFile, short } from "./shared.ts";
import { codexProcesses, owners } from "./owners.ts";

// The Slirc listener for one Codex thread. A Slirc hook starts it detached when the thread is
// bound or when the person types `slirc <workspace>`. It holds the Slirc connection, delivers each
// request with `codex queue`, and serves the hooks and the MCP server on a private Unix socket
// whose address and token sit in a 0600 file named after the thread. Codex runs hooks under its
// app-server daemon, and a thread can live there after its TUI closes.
//
// The session goes offline like any other agent when its TUI closes: the listener watches the TUI
// windows that own the thread (see owners.ts), the daemon and the thread's end (SessionEnd),
// detaches when any of them goes, and waits dormant for an hour before it exits. Reopening the
// thread (`codex resume <id>`, or a prompt typed in it) attaches it again.

export type Config = { sessionId: string; cwd: string; model: string; daemonPid: number; codex?: string };

// One listener per thread: an exclusive lock file holding our pid. A dead holder is taken over.
export function takeLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (pid && pid !== process.pid && alive(pid)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

async function body(req: IncomingMessage): Promise<any> {
  let text = "";
  for await (const chunk of req) { text += chunk; if (text.length > 64_000) throw new Error("request too large"); }
  return text ? JSON.parse(text) : {};
}

// Puts a prompt on the thread's queue in the Codex daemon. An idle thread starts a turn with it at
// once; a busy one runs it after the current turn.
export function queue(codex: string, sessionId: string, message: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(codex, ["queue", "--thread", sessionId, "--message", message], { env, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr!.on("data", (chunk) => { errors += chunk; });
    child.on("error", (error) => fail(new Error(`Couldn't run codex queue: ${error.message}`)));
    child.on("exit", (code) => code === 0 ? done() : fail(new Error(`codex queue failed: ${errors.trim().split("\n").at(-1) || `exit ${code}`}`)));
  });
}

export async function main(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = dir(env);
  mkdirSync(join(home, "live"), { recursive: true, mode: 0o700 });
  // `codex resume <id>` reopens a thread anywhere, so the id is its own session file.
  const identity: Identity = { sessionId: config.sessionId, sessionFile: `codex:${config.sessionId}` };
  const path = statePath(home, config.sessionId);
  const lock = join(home, "live", `${short(config.sessionId)}.lock`);
  if (!takeLock(lock)) process.exit(0);

  const socket = join(env.SLIRC_SOCKET_DIR || tmpdir(), `slirc-cx-${short(config.sessionId)}.sock`);
  const token = randomBytes(24).toString("hex");
  const metadata: Metadata = { name: "", repo: repoName(config.cwd), model: config.model, provider: "openai" };
  const codex = config.codex || "codex";
  // receipt -> request, then turn -> request once the turn that carries it starts.
  const receipts = new Map<string, string>();
  const turns = new Map<string, string>();
  // Notices wait here until the next hook in this thread shows them; Codex has no toast.
  const notices: string[] = [];
  const note = (message: string) => { notices.push(message.replace(/^Slirc: /, "")); if (notices.length > 5) notices.shift(); };
  const markBound = () => { mkdirSync(dirname(boundMark(env, config.sessionId)), { recursive: true, mode: 0o700 }); writeFileSync(boundMark(env, config.sessionId), ""); };

  let client: SessionClient | undefined;
  // Set while the session is offline because no TUI shows the thread.
  let offlineSince: number | undefined;
  let pairing = false;
  let pending: PairLink | undefined;
  let linked: ((text: string) => void) | undefined;
  const linkText = (link: PairLink) => `Open ${link.url} to connect this Codex session, or enter ${link.code} under Agents in Slirc.`;

  const adapter: Adapter = {
    harness: "codex",
    version: VERSION,
    noun: "Codex session",
    deliver: async (prompt, request) => {
      // A single-use receipt ties the turn the UserPromptSubmit hook sees to this delivery.
      const receipt = randomUUID();
      receipts.set(receipt, request.id);
      await queue(codex, config.sessionId, `${prompt}\n\nSlirc delivery receipt: ${receipt}`, env);
    },
    notify: (message) => note(message),
  };

  async function connect(host: string, ticket?: string): Promise<void> {
    pairing = true;
    const show = (link: PairLink) => { pending = link; linked?.(linkText(link)); };
    try {
      const paired = await SessionClient.pair(adapter, path, identity, originFor(host), metadata, hostname() || "unknown", show, () => true, ticket);
      if (!paired) return;
      saveLastWorkspace(host, env);
      client?.retire(true);
      client = paired.client;
      offlineSince = undefined;
      markBound();
      await client.attach();
      const text = `${paired.already ? "Already connected" : "Connected"} to ${host} as ${client.state.binding?.nick}.`;
      if (linked) linked(text); else note(text);
    } catch (error) {
      const text = `Slirc: ${errorText(error)}`;
      if (linked) linked(text); else note(text);
    } finally { pairing = false; pending = undefined; linked = undefined; }
  }

  const live = () => {
    if (!client?.active) throw new Error("Slirc is not connected to this Codex session. Type slirc <workspace> to connect it.");
    return client;
  };
  const open = (id: string) => ["accepted", "injected"].includes(client?.state.requests[id]?.status ?? "");

  const routes: Record<string, (args: any) => Promise<unknown>> = {
    // `slirc` or `slirc <workspace>`, typed by the person and caught by the UserPromptSubmit hook.
    // Answers within 5 seconds with the link, or says it is asking; the outcome comes as a notice.
    "/connect": async (args) => {
      const typed = String(args.workspace ?? "").trim();
      if (!typed && client?.active) return { text: `Connected to ${new URL(client.state.origin).host} as ${client.state.binding?.nick}.` };
      if (pairing) return { text: pending ? linkText(pending) : "Slirc is already asking to connect this session." };
      const host = typed ? expandWorkspace(typed) : readLastWorkspace(env) ?? "";
      if (!host) return { text: "Type slirc <workspace>, using the workspace name shown on your Agents page in Slirc." };
      const answer = new Promise<string>((done) => {
        linked = done;
        setTimeout(() => done(`Asking ${host} to connect this session.`), 5_000).unref();
      });
      void connect(host, typeof args.ticket === "string" ? args.ticket : undefined);
      return { text: await answer };
    },
    "/reply": async (args) => ({ text: await live().reply(String(args.requestId), String(args.text)) }),
    "/fail": async (args) => ({ text: await live().fail(String(args.requestId), String(args.reason)) }),
    "/send": async (args) => ({ text: await live().send(String(args.requestId), String(args.text)) }),
    "/delete": async (args) => ({ text: await live().remove(String(args.requestId), String(args.messageId)) }),
    "/history": async (args) => ({ text: JSON.stringify(await live().history(args)) }),
    "/started": async (args) => {
      const id = receipts.get(String(args.receipt));
      if (!id || !client?.active) return { started: false };
      receipts.delete(String(args.receipt));
      if (typeof args.turnId === "string") turns.set(args.turnId, id);
      if (typeof args.model === "string" && args.model) client.pushMetadata({ model: args.model });
      await client.started(id).catch(() => note("Slirc could not update the request status."));
      return { started: true, id };
    },
    // A turn ended. A request it carried that got no outcome is failed, so the next one isn't stuck.
    "/settle": async (args) => {
      const id = turns.get(String(args.turnId));
      if (!id) return { settled: false };
      turns.delete(String(args.turnId));
      if (!client?.active || !open(id)) return { settled: false };
      await client.fail(id, "The Codex turn ended without a reply.").catch(() => undefined);
      return { settled: true };
    },
    "/notices": async () => ({ notices: notices.splice(0) }),
  };

  rmSync(socket, { force: true });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.method !== "POST" || req.headers["x-slirc-token"] !== token) return reply(403, { error: "forbidden" });
    const route = routes[req.url ?? ""];
    if (!route) return reply(404, { error: "unknown" });
    try { reply(200, await route(await body(req))); }
    catch (error) { reply(200, { error: errorText(error) }); }
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(socket, () => done()); });
  chmodSync(socket, 0o600);
  const announce = liveFile(env, config.sessionId);
  writeFileSync(announce, JSON.stringify({ socket, token, pid: process.pid }), { mode: 0o600 });

  let stopping: Promise<void> | undefined;
  function shutdown(reason = "The Codex session ended before replying."): Promise<void> {
    stopping ??= (async () => {
      const current = client;
      client = undefined;
      if (current?.active) {
        for (const [id, entry] of Object.entries(current.state.requests)) {
          if (entry.status === "accepted" || entry.status === "injected") await current.fail(id, reason).catch(() => undefined);
        }
        await Promise.race([current.retire(true), new Promise((done) => setTimeout(done, 2_000).unref())]);
      }
      server.close();
      rmSync(socket, { force: true });
      try { if (JSON.parse(readFileSync(announce, "utf8")).pid === process.pid) rmSync(announce, { force: true }); } catch {}
      rmSync(lock, { force: true });
    })();
    return stopping;
  }
  const exit = (reason?: string) => { void shutdown(reason).finally(() => process.exit(0)); };

  // Online while a TUI shows the thread. `seen` stays false until one is found, so a client that
  // isn't a TUI process (or a ps that fails) never takes the session offline.
  // About ten seconds without a window before going offline, however often it looks.
  const poll = Number(env.SLIRC_CODEX_OWNER_POLL_MS || 5_000);
  let seen = false;
  let misses = 0;
  let switching: Promise<void> | undefined;
  async function offline(reason = "The Codex window closed before replying."): Promise<void> {
    const current = client;
    client = undefined;
    offlineSince = Date.now();
    if (!current?.active) return;
    for (const [id, entry] of Object.entries(current.state.requests)) {
      if (entry.status === "accepted" || entry.status === "injected") await current.fail(id, reason).catch(() => undefined);
    }
    await Promise.race([current.retire(true), new Promise((done) => setTimeout(done, 2_000).unref())]);
  }
  async function online(): Promise<void> {
    offlineSince = undefined;
    misses = 0;
    client = await SessionClient.resume(adapter, path, identity, metadata);
    if (client) await client.attach();
  }
  const watch = (owned: number[] | undefined) => {
    if (switching || pairing || !owned) return;
    if (offlineSince === undefined) {
      if (owned.length) { seen = true; misses = 0; }
      else if (seen && client?.active && ++misses * poll >= Number(env.SLIRC_CODEX_OFFLINE_MS || 10_000)) switching = offline().finally(() => { switching = undefined; });
    } else if (owned.length) { seen = true; switching = online().finally(() => { switching = undefined; }); }
    else if (Date.now() - offlineSince > Number(env.SLIRC_CODEX_DORMANT_MS || 3_600_000)) exit();
  };
  const look = async (byFolder: boolean) => { const procs = await codexProcesses(); return procs && owners(config.sessionId, config.cwd, procs, byFolder); };
  // Dormant, only a TUI that names the thread counts: a new `codex` in the same folder is another one.
  // One look at a time, so a slow ps never piles up.
  let looking = false;
  setInterval(() => {
    if (looking) return;
    looking = true;
    void look(offlineSince === undefined).then(watch, () => undefined).finally(() => { looking = false; });
  }, poll).unref();
  // A hook saw the person use this thread: it is open somewhere, so look by folder too.
  // A hook ran in this thread (resumed, or a prompt typed in it): it is open again.
  routes["/active"] = async (args) => {
    if (Number.isInteger(args.daemonPid) && args.daemonPid > 0) config.daemonPid = args.daemonPid;
    if (offlineSince !== undefined && !switching && !pairing) await (switching = online().finally(() => { switching = undefined; }));
    return {};
  };
  // The daemon shut the thread down (SessionEnd), as it does when the last window leaves an idle
  // thread. Offline and dormant, like a closed window: `codex resume <id>` reopens it.
  routes["/detach"] = async () => {
    if (offlineSince === undefined && !switching) await (switching = offline("The Codex session ended before replying.").finally(() => { switching = undefined; }));
    return {};
  };
  routes["/watching"] = async () => ({ seen, offline: offlineSince !== undefined });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => exit());
  // Closing a terminal can take the daemon down with its TUI. Then the thread is gone from memory
  // but not from disk: offline, dormant, until `codex resume <id>` brings it back in a new daemon.
  setInterval(() => {
    if (!config.daemonPid || alive(config.daemonPid) || switching) return;
    config.daemonPid = 0;
    if (offlineSince === undefined && client?.active) switching = offline("Codex stopped before replying.").finally(() => { switching = undefined; });
    else offlineSince ??= Date.now();
  }, 2_000).unref();

  client = await SessionClient.resume(adapter, path, identity, metadata);
  if (client) { markBound(); await client.attach(); }
  // The socket server keeps the process alive until a signal, a detach or the daemon leaving.
}
