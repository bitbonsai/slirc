import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import type { IrcClient, ParsedMessage } from "../../src/irc.ts";
import { acknowledge, CliError, connected, grantedRooms, join, sendText, sleep } from "./client.ts";
import type { Credentials } from "./credentials.ts";
import { ownerFromAgentNick } from "./listen.ts";
import { MentionWatcher, type Mention } from "./wait.ts";

// A resident process that holds the one IRC connection for this agent and serves wait/post over a unix
// socket. Mentions that land while nobody is waiting queue up, and the eyes go on each one a second after
// it arrives, so nothing is missed between harness turns.

export type Request =
  | { op: "wait"; timeoutMs: number }
  | { op: "post"; room: string; text: string; id?: string }
  | { op: "status" }
  | { op: "stop" };

export type Reply =
  | { ok: true; mention?: Mention; instance?: string; owner?: string; attachment?: string; timeout?: true; status?: Status }
  | { ok: false; error: string; exitCode: number };

export type Status = { nick: string; host: string; pid: number; connected: boolean; rooms: string[]; queued: number; waiting: number; since: string };

export const ROOMS_REFRESH_MS = 60_000;
export const EYES_DELAY_MS = 1_000;
// One warm line for both idle and busy: the session cannot tell whether the model is
// mid-task, and "Busy with another task" read as curt and often fired while idle.
export const QUEUED_REPLY = "Got it, I'll reply here shortly.";

export function reactionDelay(serverTime: string | undefined, delayMs = EYES_DELAY_MS, now = Date.now()): number {
  const postedAt = Date.parse(serverTime || "");
  return Number.isFinite(postedAt) ? Math.max(0, delayMs - Math.max(0, now - postedAt)) : delayMs;
}

export function runPaths(nick: string, env: NodeJS.ProcessEnv = process.env): { dir: string; socket: string; pid: string; log: string } {
  const name = nick.toLowerCase();
  if (env.XDG_RUNTIME_DIR) {
    const dir = env.XDG_RUNTIME_DIR;
    return { dir, socket: joinPath(dir, `slirc-agent-${name}.sock`), pid: joinPath(dir, `slirc-agent-${name}.pid`), log: joinPath(dir, `slirc-agent-${name}.log`) };
  }
  const dir = joinPath(env.HOME || homedir(), ".config", "slirc", "run");
  return { dir, socket: joinPath(dir, `${name}.sock`), pid: joinPath(dir, `${name}.pid`), log: joinPath(dir, `${name}.log`) };
}

// One request per connection: a JSON line in, a JSON line out. Resolves undefined when no session is
// listening, so callers can fall back to a one-shot connection.
export function ask(socketPath: string, request: Request, timeoutMs?: number): Promise<Reply | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const finish = (reply: Reply | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const socket: Socket = createConnection(socketPath);
    const timer = timeoutMs ? setTimeout(() => finish({ ok: false, error: "session did not answer in time", exitCode: 1 }), timeoutMs) : undefined;
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      try { finish(JSON.parse(buffer.slice(0, end))); } catch { finish({ ok: false, error: "session sent an unreadable reply", exitCode: 1 }); }
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        // Nobody is behind the socket: a session died without cleaning up.
        try { rmSync(socketPath, { force: true }); } catch {}
      }
      finish(undefined);
    });
    socket.once("close", () => finish({ ok: false, error: "session closed the connection", exitCode: 1 }));
  });
}

export function sessionPid(pidPath: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

type Waiter = { settle: (reply: Reply) => void; timer: ReturnType<typeof setTimeout> };

// Swappable for tests: how the session reaches IRC and the rooms endpoint.
export type SessionOptions = {
  log?: (line: string) => void;
  connect?: typeof connected;
  rooms?: (credentials: Credentials) => Promise<string[]>;
  react?: (client: IrcClient, room: string, msgid: string) => boolean | Promise<boolean>;
  eyesDelayMs?: number;
};

export class Session {
  private client?: IrcClient;
  private watcher: MentionWatcher;
  private owner: string;
  private queue: Mention[] = [];
  private active?: Mention;
  private posted = new Set<string>();
  private posting = new Map<string, Promise<void>>();
  private waiters = new Set<Waiter>();
  private joined = new Set<string>();
  private rooms: string[] = [];
  private stopping = false;
  private readonly since = new Date().toISOString();
  private closeConnection?: () => void;
  private log: (line: string) => void;
  private connect: typeof connected;
  private fetchRooms: (credentials: Credentials) => Promise<string[]>;
  private react: (client: IrcClient, room: string, msgid: string) => boolean | Promise<boolean>;
  private eyesDelayMs: number;

  constructor(private credentials: Credentials, private paths: ReturnType<typeof runPaths>, options: SessionOptions = {}) {
    this.owner = ownerFromAgentNick(credentials.nick);
    // The resident session stamps attachment identity and bounds context to rooms it has joined. DMs to the
    // agent nick are always allowed; a #t- thread channel only counts once joined.
    this.watcher = new MentionWatcher(credentials.nick, this.owner, (target) =>
      target.toLowerCase() === credentials.nick.toLowerCase() || /^#dm-/i.test(target) || this.joined.has(target.toLowerCase()));
    this.log = options.log ?? (() => {});
    this.connect = options.connect ?? connected;
    this.fetchRooms = options.rooms ?? grantedRooms;
    this.react = options.react ?? acknowledge;
    this.eyesDelayMs = options.eyesDelayMs ?? EYES_DELAY_MS;
  }

  status(): Status {
    return {
      nick: this.credentials.nick,
      host: this.credentials.host,
      pid: process.pid,
      connected: Boolean(this.client),
      rooms: [...this.joined],
      queued: this.queue.length,
      waiting: this.waiters.size,
      since: this.since,
    };
  }

  // Runs until stop(): serves the socket, keeps the IRC connection up with backoff, refreshes rooms.
  async run(): Promise<number> {
    mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 });
    rmSync(this.paths.socket, { force: true });
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.paths.socket, () => resolve());
    });
    try { chmodSync(this.paths.socket, 0o600); } catch {}
    writeFileSync(this.paths.pid, `${process.pid}\n`, { mode: 0o600 });
    this.log(`session up as ${this.credentials.nick}, socket ${this.paths.socket}`);

    const refresh = setInterval(() => { this.refreshRooms().catch(() => {}); }, ROOMS_REFRESH_MS);
    let exitCode = 0;
    try {
      let retry = 1_000;
      while (!this.stopping) {
        let closed!: () => void;
        const disconnected = new Promise<void>((resolve) => { closed = resolve; });
        this.closeConnection = closed;
        try {
          this.client = await this.connect(this.credentials, (message) => this.handle(message), closed);
          this.client.send(`MODE ${this.credentials.nick} +B`);
          this.joined.clear();
          await this.refreshRooms();
          this.log("connected");
          retry = 1_000;
          await disconnected;
          this.log("connection closed");
        } catch (error) {
          if (this.stopping) break;
          if (error instanceof CliError && error.exitCode === 3) {
            // Another connect took this name. Tell every waiter and stop; retrying cannot help.
            const reply: Reply = { ok: false, error: `${this.credentials.nick} was connected from another place. Run connect here to take it back.`, exitCode: 3 };
            for (const waiter of this.waiters) this.finish(waiter, reply);
            this.log(reply.error);
            exitCode = 3;
            break;
          }
          this.log(`reconnect: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.client?.quit();
          this.client = undefined;
        }
        if (!this.stopping) {
          await sleep(retry);
          retry = Math.min(retry * 2, 30_000);
        }
      }
    } finally {
      clearInterval(refresh);
      for (const waiter of this.waiters) this.finish(waiter, { ok: false, error: "session stopped", exitCode: 1 });
      server.close();
      rmSync(this.paths.socket, { force: true });
      rmSync(this.paths.pid, { force: true });
      this.log("session down");
    }
    return exitCode;
  }

  stop(): void {
    this.stopping = true;
    this.client?.quit();
    this.closeConnection?.();
  }

  private async refreshRooms(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.rooms = await this.fetchRooms(this.credentials);
    for (const room of this.rooms) {
      if (this.joined.has(room.toLowerCase())) continue;
      client.send(`JOIN ${room}`);
    }
  }

  private handle(message: ParsedMessage): void {
    if (message.command === "JOIN" && message.prefix?.split("!", 1)[0].toLowerCase() === this.credentials.nick.toLowerCase()) {
      const room = message.params.at(-1);
      if (room) this.joined.add(room.toLowerCase());
    }
    if (message.command === "KICK" && message.params[1]?.toLowerCase() === this.credentials.nick.toLowerCase()) this.joined.delete(message.params[0]?.toLowerCase() || "");
    if (message.command === "PART" && message.prefix?.split("!", 1)[0].toLowerCase() === this.credentials.nick.toLowerCase()) this.joined.delete(message.params[0]?.toLowerCase() || "");
    const mention = this.watcher.handle(message);
    if (!mention) return;
    const postedAt = Date.parse(message.tags.time || "");
    const eyesIn = reactionDelay(message.tags.time, this.eyesDelayMs);
    this.log(`mention ${mention.msgid} in ${mention.room} from ${mention.from}; eyes in ${eyesIn}ms`);
    // Land the eyes one second after server-time, or immediately when delivery already took longer.
    setTimeout(() => {
      const client = this.client;
      if (!client) return;
      Promise.resolve(this.react(client, mention.room, mention.msgid))
        .then((sent) => this.log(`eyes ${mention.msgid} ${sent ? "sent" : "missed"}${Number.isFinite(postedAt) ? ` ${Date.now() - postedAt}ms after post` : ""}`))
        .catch((error) => this.log(`eyes ${mention.msgid} failed: ${error instanceof Error ? error.message : String(error)}`));
    }, eyesIn);
    const waiter = this.waiters.values().next().value as Waiter | undefined;
    if (waiter) {
      this.active = mention;
      this.finish(waiter, this.mentionReply(mention));
    } else {
      sendText(this.client!, mention.thread || mention.room, QUEUED_REPLY);
      this.queue.push(mention);
    }
  }

  private mentionReply(mention: Mention): Extract<Reply, { ok: true }> {
    return { ok: true, mention, instance: this.credentials.host, owner: this.owner, attachment: `${this.credentials.nick}@${this.credentials.host}` };
  }

  private finish(waiter: Waiter, reply: Reply): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.settle(reply);
  }

  private serve(socket: Socket): void {
    let buffer = "";
    let waiter: Waiter | undefined;
    socket.setEncoding("utf8");
    const reply = (value: Reply) => {
      try { socket.end(`${JSON.stringify(value)}\n`); } catch {}
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      let request: Request;
      try { request = JSON.parse(buffer.slice(0, end)); } catch { return reply({ ok: false, error: "unreadable request", exitCode: 1 }); }
      buffer = "";
      if (request.op === "status") return reply({ ok: true, status: this.status() });
      if (request.op === "stop") { reply({ ok: true }); this.stop(); return; }
      if (request.op === "post") {
        const post = request.id ? this.postOnce(request.id, request.room, request.text) : this.post(request.room, request.text);
        post.then(() => reply({ ok: true })).catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error), exitCode: error instanceof CliError ? error.exitCode : 1 }));
        return;
      }
      if (request.op === "wait") {
        this.active = undefined;
        const queued = this.queue.shift();
        if (queued) {
          this.active = queued;
          return reply(this.mentionReply(queued));
        }
        const entry: Waiter = { settle: reply, timer: setTimeout(() => this.finish(entry, { ok: true, timeout: true }), request.timeoutMs) };
        waiter = entry;
        this.waiters.add(entry);
        return;
      }
      reply({ ok: false, error: "unknown request", exitCode: 1 });
    });
    socket.on("close", () => { if (waiter) this.finish(waiter, { ok: true, timeout: true }); });
    socket.on("error", () => {});
  }

  private postOnce(id: string, room: string, text: string): Promise<void> {
    if (this.posted.has(id)) return Promise.resolve();
    const existing = this.posting.get(id);
    if (existing) return existing;
    const pending = this.post(room, text).then(() => {
      this.posted.add(id);
      // ponytail: bound process-local idempotency history; persist only if restarts cause duplicate replies.
      if (this.posted.size > 1_000) this.posted.delete(this.posted.values().next().value!);
    }).finally(() => this.posting.delete(id));
    this.posting.set(id, pending);
    return pending;
  }

  private async post(room: string, text: string): Promise<void> {
    const client = this.client;
    if (!client) throw new CliError("session is reconnecting to Slirc; try again in a moment");
    if (/^[#&]/.test(room) && !this.joined.has(room.toLowerCase())) {
      await join(client, room, this.credentials.nick);
      this.joined.add(room.toLowerCase());
    }
    if (!sendText(client, room, text)) throw new CliError("session is reconnecting to Slirc; try again in a moment");
  }
}

// Starts the session in the background: same binary, same command, plus --foreground, detached with its
// output in the run directory. Resolves once the socket answers.
export async function daemonise(credentials: Credentials, paths: ReturnType<typeof runPaths>): Promise<Status> {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const out = openSync(paths.log, "a", 0o600);
  // Only the script path carries over. Reusing the caller's argv leaked "connect <code>" into the
  // child, whose parser then died on --foreground and connect reported "session exited with code 1".
  const child = spawn(process.execPath, [process.argv[1], "session", "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (child.exitCode !== null) {
      const tail = readFileSync(paths.log, "utf8").trim().split("\n").slice(-3).join("\n  ");
      throw new CliError(`session exited with code ${child.exitCode}; see ${paths.log}\n  ${tail}`, child.exitCode || 1);
    }
    const reply = await ask(paths.socket, { op: "status" }, 2_000);
    if (reply?.ok && reply.status) return reply.status;
  }
  throw new CliError(`session did not come up; see ${paths.log}`);
}

// Stops a running session over the socket, falling back to SIGTERM on the pidfile.
export async function stopSession(paths: ReturnType<typeof runPaths>): Promise<boolean> {
  const reply = await ask(paths.socket, { op: "stop" }, 3_000);
  const pid = sessionPid(paths.pid);
  if (!reply?.ok && pid && alive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  if (!reply?.ok && !pid) return false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!pid || !alive(pid)) return true;
    await sleep(100);
  }
  rmSync(paths.socket, { force: true });
  rmSync(paths.pid, { force: true });
  return true;
}
