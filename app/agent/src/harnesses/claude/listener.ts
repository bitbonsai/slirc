import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { errorText, repoName, SessionClient, stateDir, statePath, type Adapter, type Identity, type Metadata, type PairLink } from "../../adapter-core.ts";
import { consents, takeArm } from "../../arm.ts";
import { VERSION } from "../../version.ts";
import { expandWorkspace, originFor, readLastWorkspace, saveLastWorkspace, workspaceArg } from "../../../../shared/workspace.ts";

// The Slirc listener for one Claude Code session. The Slirc mod spawns it with $.process.spawn at
// session start, so it lives exactly as long as the mod's module in that one Claude Code process.
// It speaks JSON lines to the mod on stdout (deliveries, notices, the pairing link) and serves the
// mod's tool calls on a private Unix socket. It never reads stdin: a spawned child gets none.

// `armed` and `ticket`: the launch `slirc-agent` did. `arm`: the mod found an arm file for this
// session; `prompt` is the person's latest prompt, `command` what they type to connect.
export type Config = { sessionId: string; cwd: string; model: string; armed?: string; ticket?: string; arm?: { prompt?: string; command?: string; starting?: boolean } };
type Out = { type: "ready"; socket: string; token: string } | { type: "deliver"; id: string; prompt: string; receipt: string }
  | { type: "notify"; message: string; level: string } | { type: "link"; url: string; code: string; expiresAt: number }
  | { type: "connected"; text: string } | { type: "rename"; name: string } | { type: "busy" } | { type: "bound" };

// Exit codes the mod reads: another listener already serves this session, so don't respawn.
export const EXIT_BUSY = 3;

const emit = (line: Out) => { process.stdout.write(`${JSON.stringify(line)}\n`); };
const short = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

// One listener per Claude Code session: an exclusive lock file holding our pid. A lock whose pid
// is gone (a crash, kill -9) is taken over.
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

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function body(req: IncomingMessage): Promise<any> {
  let text = "";
  for await (const chunk of req) { text += chunk; if (text.length > 64_000) throw new Error("request too large"); }
  return text ? JSON.parse(text) : {};
}

export async function main(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = stateDir("claude", env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Claude Code keys a session by its folder and id (`claude --resume <id>` runs in that folder),
  // so the folder is the session file Slirc keeps, and the away notice can name it.
  const identity: Identity = { sessionId: config.sessionId, ...(config.cwd.startsWith("/") ? { sessionFile: config.cwd } : {}) };
  const path = statePath(dir, config.sessionId);
  const lock = join(dir, `${short(config.sessionId)}.lock`);
  if (!takeLock(lock)) { emit({ type: "busy" }); process.exit(EXIT_BUSY); }

  const socket = join(env.SLIRC_SOCKET_DIR || tmpdir(), `slirc-cc-${short(config.sessionId)}.sock`);
  const token = randomBytes(24).toString("hex");
  const metadata: Metadata = { name: "", repo: repoName(config.cwd), model: config.model, provider: "anthropic" };
  const receipts = new Map<string, string>();
  // The mark the mod checks at session start: this session was allowed, so start its listener
  // and add the tools. Sessions without one start nothing.
  const markBound = () => {
    mkdirSync(join(dir, "bound"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "bound", config.sessionId), "");
    emit({ type: "bound" });
  };
  let client: SessionClient | undefined;
  let pairing = false;
  // The link waiting for Allow, so /slirc can show it again in full.
  let pending: PairLink | undefined;
  let linked: ((text: string) => void) | undefined;
  const linkText = (link: PairLink) => `Open ${link.url} to connect this session, or enter ${link.code} under Agents in Slirc.`;

  const adapter: Adapter = {
    harness: "claude",
    version: VERSION,
    noun: "Claude Code session",
    deliver: async (prompt, request) => {
      // A single-use receipt ties the turn the mod sees start to this delivery.
      const receipt = randomUUID();
      receipts.set(receipt, request.id);
      emit({ type: "deliver", id: request.id, prompt: `${prompt}\n\nSlirc delivery receipt: ${receipt}`, receipt });
    },
    notify: (message, level) => emit({ type: "notify", message, level }),
    rename: async (name) => emit({ type: "rename", name }),
  };

  // A pairing still waiting for Allow gives way to one that brings a connect code: the person
  // copied the command again, maybe after the first code expired, and their Agents page waits for
  // that one. Slirc replaces the session's earlier request, so only the newest link and code work.
  let attempt = 0;
  async function connect(host: string, ticket?: string): Promise<void> {
    if (pairing && !ticket) {
      if (pending) emit({ type: "link", ...pending });
      else emit({ type: "notify", message: "Slirc is already waiting for Allow for this session.", level: "info" });
      return;
    }
    const mine = ++attempt;
    const current = () => attempt === mine;
    pairing = true;
    const show = (link: PairLink) => { if (!current()) return; pending = link; emit({ type: "link", ...link }); linked?.(linkText(link)); };
    try {
      const paired = await SessionClient.pair(adapter, path, identity, originFor(host), metadata, hostname() || "unknown", show, current, ticket);
      if (!paired || !current()) return;
      saveLastWorkspace(host, env);
      client?.retire(true);
      client = paired.client;
      markBound();
      await client.attach();
      emit({ type: "connected", text: `${paired.already ? "Already connected" : "Connected"} to ${host} as ${client.state.binding?.nick}.` });
      linked?.(`Connected to ${host} as ${client.state.binding?.nick}.`);
    } catch (error) {
      if (!current()) return;
      emit({ type: "notify", message: `Slirc: ${errorText(error)}`, level: "error" });
      linked?.(`Slirc: ${errorText(error)}`);
    } finally { if (current()) { pairing = false; pending = undefined; linked = undefined; } }
  }

  // An arm file `slirc-agent` left for this session, taken once. It pairs only when the person's
  // own latest prompt asked for slirc-agent and this workspace.
  function fromArm(arm: NonNullable<Config["arm"]>): void {
    // The mod runs in Claude Code's own process, which spawned this listener and runs the Bash tool.
    const found = takeArm("claude", config.sessionId, env, Date.now(), process.ppid, arm.starting === true);
    if (!found) return;
    const typed = `/${arm.command === "slirc-connect" ? "slirc-connect" : "slirc"} ${workspaceArg(found.host)}`.trim();
    if (!consents(arm.prompt, found.host)) {
      emit({ type: "notify", message: `Something ran slirc-agent for ${found.host}. To connect, type ${typed}.`, level: "warning" });
      return;
    }
    if (client?.active && client.state.origin === originFor(found.host)) {
      emit({ type: "notify", message: `Already connected as ${client.state.binding?.nick}.`, level: "info" });
      return;
    }
    void connect(found.host, found.ticket);
  }

  const live = () => {
    if (!client?.active) throw new Error("Slirc is not attached to this Claude Code session. Type /slirc <workspace> to connect it.");
    return client;
  };

  // Requests this session holds that have no outcome yet.
  const open = () => Object.entries(client?.state.requests ?? {}).filter(([, entry]) => entry.status === "accepted" || entry.status === "injected").map(([id]) => id);

  const routes: Record<string, (args: any) => Promise<unknown>> = {
    "/connect": async (args) => {
      const typed = String(args.workspace ?? "").trim();
      if (!typed && client?.active) return { text: `Connected to ${new URL(client.state.origin).host} as ${client.state.binding?.nick}.` };
      if (!typed && pending) return { text: linkText(pending) };
      const host = typed ? expandWorkspace(typed.split(/\s+/)[0]) : readLastWorkspace(env) ?? "";
      if (!host) return { text: "Type /slirc <workspace>, using the workspace name shown on your Agents page in Slirc." };
      if (pairing) return { text: pending ? linkText(pending) : "Slirc is already asking for this session." };
      // Waiting for Allow can take minutes: answer with the link once Slirc gives one, and report
      // the outcome later as a notice.
      const answer = new Promise<string>((done) => {
        linked = done;
        setTimeout(() => done(`Asking ${host} to connect this session.`), 5_000).unref();
      });
      void connect(host);
      return { text: await answer };
    },
    "/arm": async (args) => {
      fromArm({ ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}), ...(typeof args.command === "string" ? { command: args.command } : {}), ...(args.starting === true ? { starting: true } : {}) });
      return {};
    },
    "/reply": async (args) => ({ text: await live().reply(String(args.requestId), String(args.text)) }),
    "/fail": async (args) => ({ text: await live().fail(String(args.requestId), String(args.reason)) }),
    "/send": async (args) => ({ text: await live().send(String(args.requestId), String(args.text)) }),
    "/delete": async (args) => ({ text: await live().remove(String(args.requestId), String(args.messageId)) }),
    "/history": async (args) => ({ text: JSON.stringify(await live().history(args)) }),
    "/owner-dms": async (args) => ({ text: JSON.stringify(await live().ownerDms(args)) }),
    "/started": async (args) => {
      const id = receipts.get(String(args.receipt));
      if (!id || !client?.active) return { started: false };
      receipts.delete(String(args.receipt));
      await client.started(id).catch(() => client?.notify("Slirc could not update the request status.", "warning"));
      return { started: true, id };
    },
    // A turn ended. A request it carried that got no outcome is failed, so the next one isn't stuck.
    "/settle": async (args) => {
      const id = String(args.requestId);
      if (!client?.active || !open().includes(id)) return { settled: false };
      await client.fail(id, "The Claude Code turn ended without a reply.").catch(() => undefined);
      return { settled: true };
    },
    "/metadata": async (args) => {
      if (typeof args.model === "string") metadata.model = args.model;
      client?.pushMetadata({ model: metadata.model });
      return {};
    },
    "/detach": async () => {
      await shutdown("The Claude Code session closed before replying.");
      setTimeout(() => process.exit(0), 50).unref();
      return {};
    },
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

  let stopping: Promise<void> | undefined;
  function shutdown(reason = "The Claude Code session closed before replying."): Promise<void> {
    stopping ??= (async () => {
      const current = client;
      client = undefined;
      if (current?.active) {
        for (const id of Object.entries(current.state.requests).filter(([, entry]) => entry.status === "accepted" || entry.status === "injected").map(([key]) => key)) {
          await current.fail(id, reason).catch(() => undefined);
        }
        await Promise.race([current.retire(true), new Promise((done) => setTimeout(done, 2_000).unref())]);
      }
      server.close();
      rmSync(socket, { force: true });
      rmSync(lock, { force: true });
    })();
    return stopping;
  }
  const exit = () => { void shutdown().finally(() => process.exit(0)); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, exit);
  // kill -9 on Claude Code leaves no one to signal us: notice the parent change and leave.
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) exit(); }, 2_000).unref();

  emit({ type: "ready", socket, token });
  client = await SessionClient.resume(adapter, path, identity, metadata);
  if (client) { markBound(); await client.attach(); }
  else if (config.armed) await connect(config.armed, config.ticket);
  if (config.arm) {
    fromArm(config.arm);
    // Started only for this arm file and nothing came of it: leave, so the session costs nothing.
    if (!client?.active && !pairing) { await shutdown(); await new Promise((done) => setTimeout(done, 100)); process.exit(0); }
  }
  // The socket server keeps the process alive until a signal, a detach or the parent leaving.
}

if (import.meta.main ?? process.argv[1]?.endsWith("listener.js")) {
  let config: Config;
  try { config = JSON.parse(process.argv[2] ?? ""); if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(config.sessionId))) throw new Error("bad session id"); }
  catch { console.error("slirc listener: expected one JSON argument with sessionId, cwd and model"); process.exit(2); }
  main(config).catch((error) => { emit({ type: "notify", message: `Slirc listener stopped: ${errorText(error)}`, level: "error" }); process.exit(1); });
}
