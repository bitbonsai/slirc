import { IrcClient, type ParsedMessage } from "../../shared/irc.ts";
import { loadCredentials, NotPairedError, type Credentials } from "./credentials.ts";
import { ownerFromAgentNick } from "./listen.ts";
import { MentionWatcher, type Mention } from "./wait.ts";
import { acknowledge, CliError, connected, grantedRooms, join, nickOf, sendText, timeout } from "./client.ts";
import { ask, daemonise, runPaths, Session, stopSession, type Reply } from "./session.ts";

// Commands for agents paired before 3.0 that hold their own IRC credentials (the `slirc` skill
// uses them). Session-bound agents connected with `slirc-agent <workspace>` never need these.
export const LEGACY = ["wait", "read", "post", "session", "whoami"];

export const legacyUsage = `Commands for agents paired before 3.0, with their own IRC credentials:
  slirc-agent wait [--timeout 25m]
  slirc-agent read <room> [n] [--json]
  slirc-agent post <room> <text...>
  slirc-agent session [start [--foreground]|stop|status]
  slirc-agent whoami`;

function room(value: string | undefined): string {
  // A channel (#room) or a person (nick) for direct messages.
  if (!value || !(/^[#&][^\x00\x07\r\n ,:]{1,63}$/.test(value) || /^[A-Za-z][A-Za-z0-9_\-\[\]\\^{}|`]{0,31}$/.test(value))) throw new CliError("room must be a #channel or a nick, with no spaces");
  return value;
}

// "25m", "90s", "2h", or a bare number of minutes.
export function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!match) throw new CliError("--timeout must look like 25m, 90s, or 2h");
  const total = Number(match[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] || "m"]!;
  if (total < 1_000 || total > 24 * 3_600_000) throw new CliError("--timeout must be between 1s and 24h");
  return total;
}

export async function runLegacy(argv: string[]): Promise<void> {
  const [name, ...input] = argv;
  try {
    if (name === "wait") {
      const flag = input.findIndex((arg) => arg === "--timeout" || arg.startsWith("--timeout="));
      const value = flag < 0 ? "25m" : input[flag].includes("=") ? input[flag].slice(10) : input[flag + 1];
      if (input.length > (flag < 0 ? 0 : input[flag].includes("=") ? 1 : 2)) throw new CliError("wait accepts only --timeout <duration>");
      return await wait(parseDuration(value ?? ""));
    }
    if (name === "read") {
      const json = input.includes("--json");
      const args = input.filter((arg) => arg !== "--json");
      if (args.length < 1 || args.length > 2) throw new CliError("read needs room and optional count");
      const count = args[1] === undefined ? 30 : Number(args[1]);
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new CliError("history count must be between 1 and 1000");
      return await read(room(args[0]), count, json);
    }
    if (name === "post") {
      if (input.length < 2) throw new CliError("post needs room and text");
      const text = input.slice(1).join(" ").replace(/\r\n?/g, "\n");
      if (!text || text.includes("\0")) throw new CliError("message is empty or invalid");
      return await post(room(input[0]), text);
    }
    if (name === "session") {
      const foreground = input.includes("--foreground");
      const args = input.filter((arg) => arg !== "--foreground");
      const action = args[0] ?? "start";
      if (args.length > 1 || !["start", "stop", "status"].includes(action)) throw new CliError("session accepts start [--foreground], stop, or status");
      if (foreground && action !== "start") throw new CliError("--foreground only applies to session start");
      return await session(action as "start" | "stop" | "status", foreground);
    }
    const credentials = await loadCredentials();
    console.log(`${credentials.nick} ${credentials.host}`);
  } catch (error) {
    if (error instanceof NotPairedError) {
      console.error("This computer has no agent from before 3.0. To connect a Pi session, run slirc-agent <workspace> with the workspace name on your Agents page.");
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

// Blocks until the owner mentions this agent in any granted room or by direct message, then prints one JSON
// line. Exit 2 on timeout with nothing printed; exit 3 when another connect displaced this session.
async function wait(timeoutMs: number): Promise<void> {
  const credentials = await loadCredentials();
  const viaSession = await ask(runPaths(credentials.nick).socket, { op: "wait", timeoutMs }, timeoutMs + 5_000);
  if (viaSession) {
    const reply = unwrap(viaSession);
    if (reply.timeout) { process.exitCode = 2; return; }
    if (reply.mention) console.log(JSON.stringify(reply.mention));
    return;
  }
  const owner = ownerFromAgentNick(credentials.nick);
  const watcher = new MentionWatcher(credentials.nick, owner);
  let settle!: (outcome: Mention | "closed") => void;
  const outcome = new Promise<Mention | "closed">((resolve) => { settle = resolve; });
  let client: IrcClient;
  try {
    client = await connected(credentials, (message) => {
      const mention = watcher.handle(message);
      if (mention) settle(mention);
    }, () => settle("closed"));
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) throw new CliError(`${credentials.nick} was connected from another place. Run the same command here to take it back.`, 3);
    throw error;
  }
  const timer = setTimeout(() => { process.exitCode = 2; client.quit(); }, timeoutMs);
  const stop = () => { process.exitCode = 130; client.quit(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    client.send(`MODE ${credentials.nick} +B`);
    for (const room of await grantedRooms(credentials)) client.send(`JOIN ${room}`);
    const result = await outcome;
    if (result === "closed") {
      if (process.exitCode === undefined) throw new CliError(`Connection closed before a mention arrived. If ${credentials.nick} was connected from another place, this session was displaced.`, 3);
      return;
    }
    // A beat before the eyes, so it reads as noticed rather than automatic.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    acknowledge(client, result.room, result.msgid);
    console.log(JSON.stringify(result));
    process.exitCode = 0;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    client.quit();
  }
}

type HistoryMessage = { time: string; nick: string; text: string };

function historyCollector(room: string) {
  let historyId = "";
  let resolve!: (messages: HistoryMessage[]) => void;
  const messages: HistoryMessage[] = [];
  const multiline = new Map<string, { prefix?: string; time: string; target: string; text: string; lines: number; history: boolean }>();
  const done = new Promise<HistoryMessage[]>((next) => { resolve = next; });
  const add = (prefix: string | undefined, time: string, text: string) => {
    const nick = nickOf(prefix);
    if (nick.toLowerCase() !== "histserv") messages.push({ time, nick, text });
  };

  return {
    done,
    onMessage(message: ParsedMessage) {
      const { command, params, tags, prefix } = message;
      if (command === "BATCH" && params[0]?.startsWith("+") && params[1] === "chathistory" && params[2]?.toLowerCase() === room.toLowerCase()) {
        historyId = params[0].slice(1);
        return;
      }
      if (command === "BATCH" && params[0]?.startsWith("+") && params[1] === "draft/multiline") {
        multiline.set(params[0].slice(1), { prefix, time: tags.time || new Date().toISOString(), target: params[2], text: "", lines: 0, history: tags.batch === historyId });
        return;
      }
      if (command === "PRIVMSG") {
        const batch = multiline.get(tags.batch);
        if (batch) {
          if (batch.lines && !("draft/multiline-concat" in tags)) batch.text += "\n";
          batch.text += params[1] || "";
          batch.lines++;
        } else if (tags.batch === historyId && params[0]?.toLowerCase() === room.toLowerCase()) {
          add(prefix, tags.time || new Date().toISOString(), params[1] || "");
        }
        return;
      }
      if (command === "BATCH" && params[0]?.startsWith("-")) {
        const id = params[0].slice(1);
        const batch = multiline.get(id);
        if (batch) {
          if (batch.history && batch.target.toLowerCase() === room.toLowerCase()) add(batch.prefix, batch.time, batch.text);
          multiline.delete(id);
        }
        if (id === historyId) resolve(messages);
      }
    },
  };
}

function clock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

async function read(room: string, count: number, json: boolean): Promise<void> {
  const credentials = await loadCredentials();
  const history = historyCollector(room);
  const client = await connected(credentials, history.onMessage);
  try {
    await join(client, room, credentials.nick);
    // Join and quit notices share the history with messages and are filtered out below, so
    // ask for more than needed and keep the last `count` real messages.
    client.send(`CHATHISTORY LATEST ${room} * ${Math.min(Math.max(count * 4, 20), 200)}`);
    for (const message of (await timeout(history.done, "History request timed out")).slice(-count)) {
      console.log(json ? JSON.stringify(message) : `${clock(message.time)} ${message.nick}  ${message.text}`);
    }
  } finally {
    client.quit();
  }
}

async function post(room: string, text: string): Promise<void> {
  const credentials = await loadCredentials();
  const viaSession = await ask(runPaths(credentials.nick).socket, { op: "post", room, text }, 15_000);
  if (viaSession) { unwrap(viaSession); return; }
  await postAs(credentials, room, text);
}

async function postAs(credentials: Credentials, room: string, text: string): Promise<void> {
  const client = await connected(credentials);
  try {
    await join(client, room, credentials.nick);
    client.send(`MODE ${credentials.nick} +B`);
    sendText(client, room, text);
  } finally {
    client.quit();
  }
}

function unwrap(reply: Reply): Extract<Reply, { ok: true }> {
  if (!reply.ok) throw new CliError(reply.error, reply.exitCode);
  return reply;
}

// The resident connection. `start` forks into the background and returns once the socket answers;
// `--foreground` runs it in this terminal. wait and post use the socket whenever it is there.
async function session(action: "start" | "stop" | "status", foreground: boolean): Promise<void> {
  const credentials = await loadCredentials();
  const paths = runPaths(credentials.nick);
  if (action === "status") {
    const reply = await ask(paths.socket, { op: "status" }, 3_000);
    if (!reply) throw new CliError(`no session for ${credentials.nick}`, 2);
    const status = unwrap(reply).status!;
    console.log(`${status.nick} ${status.connected ? "connected" : "reconnecting"} pid ${status.pid} rooms ${status.rooms.length} queued ${status.queued} waiting ${status.waiting} since ${status.since}`);
    return;
  }
  if (action === "stop") {
    if (!(await stopSession(paths))) throw new CliError(`no session for ${credentials.nick}`, 2);
    console.log(`session stopped for ${credentials.nick}`);
    return;
  }
  const running = await ask(paths.socket, { op: "status" }, 3_000);
  if (running?.ok && running.status) {
    console.log(`session already running for ${credentials.nick} (pid ${running.status.pid})`);
    return;
  }
  if (!foreground) {
    const status = await daemonise(credentials, paths);
    console.log(`session running for ${status.nick} (pid ${status.pid}, log ${paths.log})`);
    return;
  }
  const stamp = () => new Date().toISOString().slice(11, 19);
  const resident = new Session(credentials, paths, { log: (line) => console.error(`${stamp()} ${line}`) });
  const stop = () => resident.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    process.exitCode = await resident.run();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
  }
}
