#!/usr/bin/env node

// src/cli.ts
import { spawn as spawn2 } from "node:child_process";
import { createInterface } from "node:readline/promises";

// src/args.ts
var usage = `Connect a coding agent to Slirc.

Usage:
  slirc-agent [workspace] [code]
                              set up the agent if needed and connect it (the usual command)
  slirc-agent install         set up the agent without connecting
  slirc-agent uninstall       remove what install set up
  slirc-agent status          show what is set up on this computer
  slirc-agent --version

A workspace is the name on your Agents page: calango means calango.slirc.app. Give a full host,
such as chat.example.com, for a self-hosted Slirc. Leave it out for app.slirc.org. The connect
code comes with the command on your Agents page and lets that page show the Allow card by itself.

Run it in a terminal and it starts your agent ready to connect. Paste it into your agent and it
sets things up and connects that same session: the link shows there.

Options:
  --harness <id>    pick the agent when more than one is installed (pi, claude, codex or opencode)
  --dry-run         show what would change, change nothing
  -- <args>         pass the rest to the agent when it starts, e.g. -- --model sonnet
  -h, --help        this help; also slirc-agent <command> --help

Works with Pi, Claude Code, Codex and OpenCode today. Docs: https://app.slirc.org/docs/agents
Agents paired before 3.0: slirc-agent help legacy`;
var topics = {
  install: `Usage: slirc-agent install [--harness <id>] [--dry-run]

Adds the Slirc extension to your agent, or updates it to this version. Nothing else on the
computer changes. Each change is printed before it runs.`,
  uninstall: `Usage: slirc-agent uninstall [--harness <id>] [--dry-run]

Removes the Slirc extension from your agent. Agents already in Slirc stay there; remove them
under Agents in Slirc.`,
  status: `Usage: slirc-agent status

Lists the agents Slirc works with, whether each is installed, and whether its Slirc extension is
current. Changes nothing.`
};
function helpFor(topic) {
  return topic && topics[topic] || usage;
}
var validCode = (value) => /^[A-Za-z0-9_-]{8,64}$/.test(value);
var BAD_CODE = "That isn't a connect code from your Agents page. Copy the command there again.";
function parseFlags(input, allowWorkspace) {
  let harness;
  let ticket;
  let unreleased = false;
  let dryRun = false;
  let help = false;
  const positional = [];
  let extra = [];
  for (let index = 0;index < input.length; index++) {
    const arg = input[index];
    if (arg === "--") {
      extra = input.slice(index + 1);
      break;
    }
    if (arg === "-h" || arg === "--help")
      help = true;
    else if (arg === "--unreleased")
      unreleased = true;
    else if (arg === "--dry-run")
      dryRun = true;
    else if (arg === "--harness") {
      harness = input[++index];
      if (!harness || harness.startsWith("-"))
        throw new Error("--harness needs a value, such as --harness pi");
    } else if (arg.startsWith("--harness="))
      harness = arg.slice(10);
    else if (allowWorkspace && (arg === "--ticket" || arg.startsWith("--ticket="))) {
      ticket = arg === "--ticket" ? input[++index] : arg.slice(9);
      if (!ticket)
        throw new Error(BAD_CODE);
    } else if (arg.startsWith("-"))
      throw new Error(`Unknown option ${arg}. Run slirc-agent --help to see the options.`);
    else
      positional.push(arg);
  }
  if (positional.length > (allowWorkspace ? 2 : 0))
    throw new Error(allowWorkspace ? "Give a workspace name and, from your Agents page, a connect code: slirc-agent calango <code>." : "This command takes no workspace name.");
  if (positional[1] !== undefined) {
    if (ticket !== undefined)
      throw new Error(BAD_CODE);
    ticket = positional[1];
  }
  if (ticket !== undefined && !validCode(ticket))
    throw new Error(BAD_CODE);
  return { harness, ticket, unreleased, dryRun, help, workspace: positional[0] ?? "", extra };
}
function parseArgs(argv) {
  const [first, ...rest] = argv;
  if (first === "--version" || first === "-v")
    return { name: "version" };
  if (first === "help")
    return { name: "help", topic: rest[0] };
  if (first === "install" || first === "uninstall" || first === "status") {
    const flags = parseFlags(rest, false);
    if (flags.help)
      return { name: "help", topic: first };
    if (first === "status")
      return { name: "status", unreleased: flags.unreleased };
    return { name: first, unreleased: flags.unreleased, dryRun: flags.dryRun, ...flags.harness ? { harness: flags.harness } : {} };
  }
  const flags = parseFlags(first === "connect" ? rest : argv, true);
  if (flags.help)
    return { name: "help" };
  if (/^\d{6}$/.test(flags.workspace))
    throw new Error("Slirc no longer gives out six-digit codes. Run slirc-agent <workspace>, using the workspace name on your Agents page.");
  return { name: "connect", workspace: flags.workspace, unreleased: flags.unreleased, dryRun: flags.dryRun, extra: flags.extra, ...flags.harness ? { harness: flags.harness } : {}, ...flags.ticket ? { ticket: flags.ticket } : {} };
}

// src/credentials.ts
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

class NotPairedError extends Error {
}
function paths(env) {
  const home = env.HOME || homedir();
  return {
    credentials: join(home, ".config", "slirc", "credentials"),
    config: join(home, ".config", "slirc", "config")
  };
}
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new NotPairedError;
    throw new Error("Stored Slirc credentials are unreadable");
  }
}
var runSecurity = (args, input) => new Promise((resolve, reject) => {
  const child = execFile("security", args, { encoding: "utf8" }, (error, stdout) => {
    if (error)
      reject(new Error("macOS Keychain could not store or read Slirc credentials"));
    else
      resolve(stdout);
  });
  if (input !== undefined)
    child.stdin?.end(input);
});
function metadata(value) {
  if (typeof value.nick !== "string" || typeof value.host !== "string")
    throw new Error("Stored Slirc credentials are unreadable");
  return { nick: value.nick, host: value.host };
}
async function loadCredentials(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const path = paths(env);
  if (platform === "darwin") {
    const saved = metadata(await readJson(path.config));
    const password = (await (options.security || runSecurity)(["find-generic-password", "-s", "slirc", "-a", saved.nick, "-w"])).trimEnd();
    if (!password)
      throw new NotPairedError;
    return { ...saved, password };
  }
  const saved = await readJson(path.credentials);
  const info = metadata(saved);
  if (typeof saved.password !== "string" || !saved.password)
    throw new Error("Stored Slirc credentials are unreadable");
  return { ...info, password: saved.password };
}

// src/listen.ts
var quoteRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function isOwnerMention(message, agentNick, owner) {
  if (message.command !== "PRIVMSG" || message.tags.account?.toLowerCase() !== owner.toLowerCase())
    return false;
  const mention = new RegExp(`(?:^|[^a-z0-9_-])@?${quoteRegex(agentNick)}(?![a-z0-9_-])`, "i");
  return mention.test(message.params[1] || "");
}
function ownerFromAgentNick(nick) {
  const separator = nick.indexOf("-");
  if (separator < 1 || separator === nick.length - 1)
    throw new Error("paired agent nick does not contain an owner");
  return nick.slice(separator + 1);
}

// src/wait.ts
var CONTEXT_MAX_MESSAGES = 20;
var CONTEXT_MAX_CHARS = 4000;
var ROOM_BUFFER_MAX = 200;
var TRIGGER_SEEN_MAX = 2000;
var roomPattern = /^[#&][^\x00\x07\r\n ,:]{1,63}$/;
var nickPattern = /^[A-Za-z][A-Za-z0-9_\-\[\]\\^{}|`]{0,31}$/;
var nickOf = (prefix = "") => prefix.split("!", 1)[0];
function mentionFrom(message, nick, owner) {
  let room = message.params[0] || "";
  const direct = /^#dm-/i.test(room) || room.toLowerCase() === nick.toLowerCase();
  const fromOwner = message.command === "PRIVMSG" && message.tags.account?.toLowerCase() === owner.toLowerCase();
  if (!(direct ? fromOwner : isOwnerMention(message, nick, owner)))
    return;
  if (room.toLowerCase() === nick.toLowerCase())
    room = nickOf(message.prefix);
  if (!roomPattern.test(room) && !nickPattern.test(room))
    return;
  const msgid = message.tags.msgid;
  if (!msgid)
    return;
  const mention = { room, from: nickOf(message.prefix), text: message.params[1] || "", msgid };
  if (/^#t-/i.test(room))
    mention.thread = room;
  return mention;
}
function boundContext(entries, maxMessages = CONTEXT_MAX_MESSAGES, maxChars = CONTEXT_MAX_CHARS) {
  let truncated = entries.length > maxMessages;
  const tail = truncated ? entries.slice(-maxMessages) : entries;
  let total = 0;
  const kept = [];
  for (let i = tail.length - 1;i >= 0; i--) {
    total += tail[i].text.length;
    if (total > maxChars) {
      truncated = true;
      break;
    }
    kept.unshift(tail[i]);
  }
  return { context: kept, truncated };
}

class MentionWatcher {
  nick;
  owner;
  allow;
  multiline = new Map;
  contexts = new Map;
  triggers = new Set;
  constructor(nick, owner, allow = () => true) {
    this.nick = nick;
    this.owner = owner;
    this.allow = allow;
  }
  handle(message) {
    if (message.command === "BATCH") {
      const marker = message.params[0] || "";
      if (marker.startsWith("+") && message.params[1] === "draft/multiline") {
        this.multiline.set(marker.slice(1), { tags: message.tags, prefix: message.prefix, target: message.params[2] || "", text: "", lines: 0 });
        return;
      }
      if (marker.startsWith("-")) {
        const batch = this.multiline.get(marker.slice(1));
        if (!batch)
          return;
        this.multiline.delete(marker.slice(1));
        return this.receive({ tags: batch.tags, prefix: batch.prefix, command: "PRIVMSG", params: [batch.target, batch.text] });
      }
      return;
    }
    if (message.command !== "PRIVMSG")
      return;
    const batch = this.multiline.get(message.tags.batch);
    if (batch) {
      if (batch.lines && !("draft/multiline-concat" in message.tags))
        batch.text += `
`;
      batch.text += message.params[1] || "";
      batch.lines++;
      return;
    }
    return this.receive(message);
  }
  receive(message) {
    const target = message.params[0] || "";
    if (!this.allow(target))
      return;
    const text = message.params[1] || "";
    const room = target.toLowerCase() === this.nick.toLowerCase() ? nickOf(message.prefix) : target;
    const msgid = message.tags.msgid;
    if (msgid) {
      const entries = this.contexts.get(room.toLowerCase()) || [];
      if (!entries.some((entry) => entry.messageId === msgid)) {
        entries.push({ messageId: msgid, account: message.tags.account ?? null, author: nickOf(message.prefix), time: message.tags.time || "", text });
        this.contexts.set(room.toLowerCase(), entries.slice(-ROOM_BUFFER_MAX));
      }
    }
    const mention = mentionFrom(message, this.nick, this.owner);
    if (!mention)
      return;
    if (this.triggers.has(mention.msgid))
      return;
    this.triggers.add(mention.msgid);
    if (this.triggers.size > TRIGGER_SEEN_MAX)
      this.triggers.delete(this.triggers.values().next().value);
    const { context, truncated } = boundContext((this.contexts.get(room.toLowerCase()) || []).filter((entry) => entry.messageId !== mention.msgid));
    return { ...mention, context, contextTruncated: truncated };
  }
}

// src/client.ts
import { randomUUID } from "node:crypto";

// ../shared/irc.ts
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
function unescapeTag(value) {
  return value.replace(/\\(.?)/g, (_m, ch) => ({ ":": ";", s: " ", "\\": "\\", r: "\r", n: `
` })[ch] ?? ch);
}
function sanitizeLine(line) {
  return line.replace(/[\r\n]+/g, " ").replace(/\0/g, "");
}
function parseLine(line) {
  let rest = line;
  const tags = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    rest = rest.slice(sp + 1);
    for (const t of line.slice(1, sp).split(";")) {
      const i = t.indexOf("=");
      if (i === -1)
        tags[t] = "";
      else
        tags[t.slice(0, i)] = unescapeTag(t.slice(i + 1));
    }
  }
  let prefix;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const trailing = rest.indexOf(" :");
  let command, params;
  if (trailing === -1) {
    const parts = rest.split(" ");
    command = parts.shift() || "";
    params = parts;
  } else {
    const parts = rest.slice(0, trailing).split(" ");
    command = parts.shift() || "";
    params = parts.concat(rest.slice(trailing + 2));
  }
  return { tags, prefix, command, params };
}

class IrcClient {
  nick;
  enabledCapabilities = new Set;
  sock;
  closed = false;
  decoder = new TextDecoder("utf-8");
  buf = "";
  opts;
  waiters = [];
  constructor(opts) {
    this.opts = opts;
    this.nick = opts.nick;
  }
  async connect(timeoutMs) {
    const o = this.opts;
    let timer;
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        this.disconnect();
        reject(error);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => fail(new Error("IRC connection timed out")), Math.max(0, timeoutMs));
      }
      const close = () => {
        this.closed = true;
        this.waiters = [];
        reject(new Error("IRC connection closed"));
        this.opts.onClose?.();
      };
      if (typeof Bun === "undefined" || timeoutMs !== undefined) {
        const socket = o.tls ? tlsConnect({ host: o.host, port: o.port, servername: o.host, rejectUnauthorized: !o.tlsInsecure }) : netConnect({ host: o.host, port: o.port });
        this.sock = socket;
        socket.once(o.tls ? "secureConnect" : "connect", () => {
          if (this.closed) {
            socket.destroy();
            return;
          }
          this.send("CAP LS 302");
          this.send(`NICK ${o.nick}`);
          this.send(`USER ${o.user || o.nick} 0 * :${o.realname || o.nick}`);
          (async () => {
            try {
              const welcome = this.waitFor((m) => m.command === "001");
              if (o.saslUser && o.saslPass)
                await this.sasl(o.saslUser, o.saslPass, o.capabilities);
              else
                await this.requestCapabilities(o.capabilities);
              await welcome;
              resolve();
            } catch (e) {
              fail(e);
            }
          })();
        });
        socket.on("data", (data) => this.onData(data));
        socket.on("close", close);
        socket.on("error", fail);
        return;
      }
      Bun.connect({
        hostname: o.host,
        port: o.port,
        tls: o.tls ? o.tlsInsecure ? { rejectUnauthorized: false } : true : false,
        socket: {
          open: (s) => {
            if (this.closed) {
              s.terminate();
              return;
            }
            this.sock = s;
            this.send("CAP LS 302");
            this.send(`NICK ${o.nick}`);
            this.send(`USER ${o.user || o.nick} 0 * :${o.realname || o.nick}`);
            (async () => {
              try {
                const welcome = this.waitFor((m) => m.command === "001");
                if (o.saslUser && o.saslPass)
                  await this.sasl(o.saslUser, o.saslPass, o.capabilities);
                else
                  await this.requestCapabilities(o.capabilities);
                await welcome;
                resolve();
              } catch (e) {
                fail(e);
              }
            })();
          },
          data: (_s, d) => this.onData(d),
          close,
          error: (_s, err) => fail(err)
        }
      }).catch(fail);
    }).finally(() => clearTimeout(timer));
  }
  send(line) {
    if (!this.sock || this.closed)
      return false;
    const clean = sanitizeLine(line);
    if (!clean.trim())
      return false;
    this.sock.write(clean + `\r
`);
    return true;
  }
  quit() {
    try {
      this.send("QUIT :bye");
      this.sock?.end();
    } catch {}
  }
  disconnect() {
    this.closed = true;
    this.waiters = [];
    if (this.sock?.terminate)
      this.sock.terminate();
    else
      this.sock?.destroy();
  }
  async requestCapabilities(capabilities) {
    const offered = new Set;
    await this.waitFor((m) => {
      if (m.command !== "CAP" || m.params[1] !== "LS")
        return false;
      for (const capability of (m.params.at(-1) || "").split(" "))
        offered.add(capability.split("=", 1)[0]);
      return m.params[2] !== "*";
    });
    const requested = (capabilities || []).filter((capability) => offered.has(capability));
    if (requested.length) {
      this.send(`CAP REQ :${requested.join(" ")}`);
      let acknowledged = false;
      await this.waitFor((m) => {
        if (m.command !== "CAP" || !["ACK", "NAK"].includes(m.params[1]))
          return false;
        acknowledged = m.params[1] === "ACK";
        return true;
      });
      if (acknowledged)
        for (const capability of requested)
          this.enabledCapabilities.add(capability);
    }
    this.send("CAP END");
  }
  async sasl(user, pass, capabilities) {
    if (capabilities) {
      const offered = new Set;
      await this.waitFor((m) => {
        if (m.command !== "CAP" || m.params[1] !== "LS")
          return false;
        for (const capability of (m.params.at(-1) || "").split(" "))
          offered.add(capability.split("=", 1)[0]);
        return m.params[2] !== "*";
      });
      const requested = ["sasl", ...capabilities];
      const missing = requested.filter((capability) => !offered.has(capability));
      if (missing.length)
        throw new Error(`IRC server lacks required capabilities: ${missing.join(", ")}`);
      this.send(`CAP REQ :${requested.join(" ")}`);
      let acknowledged = false;
      await this.waitFor((m) => {
        if (m.command !== "CAP" || !["ACK", "NAK"].includes(m.params[1]))
          return false;
        acknowledged = m.params[1] === "ACK";
        return true;
      });
      if (!acknowledged)
        throw new Error("IRC server rejected required capabilities");
      for (const capability of requested)
        this.enabledCapabilities.add(capability);
    } else {
      await this.waitFor((m) => m.command === "CAP" && m.params[1] === "LS");
      this.send("CAP REQ :sasl");
      await this.waitFor((m) => m.command === "CAP" && m.params[1] === "ACK");
      this.enabledCapabilities.add("sasl");
    }
    this.send("AUTHENTICATE PLAIN");
    await this.waitFor((m) => m.command === "AUTHENTICATE");
    this.send("AUTHENTICATE " + Buffer.from(`\x00${user}\x00${pass}`).toString("base64"));
    let failure = "";
    await this.waitFor((m) => {
      if (m.command === "903")
        return true;
      if (["904", "905", "906", "907"].includes(m.command)) {
        failure = m.params.at(-1) || m.command;
        return true;
      }
      return false;
    });
    if (failure)
      throw new Error(`SASL login failed for ${user}: ${failure}`);
    this.send("CAP END");
  }
  onData(data) {
    if (this.closed)
      return;
    this.buf += this.decoder.decode(data, { stream: true });
    let i;
    while ((i = this.buf.indexOf(`\r
`)) !== -1) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const m = parseLine(line);
      if (m.command === "PING")
        this.send(`PONG :${m.params.at(-1) || ""}`);
      for (let w = this.waiters.length - 1;w >= 0; w--) {
        if (this.waiters[w].pred(m)) {
          this.waiters[w].resolve();
          this.waiters.splice(w, 1);
        }
      }
      this.opts.onMessage?.(m);
    }
  }
  waitFor(pred) {
    return new Promise((resolve) => {
      this.waiters.push({ pred, resolve });
    });
  }
}

// ../shared/reactions.ts
function escapeTag(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\:").replace(/ /g, "\\s").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}
function reactionLine(target, messageId, emoji, remove = false) {
  if (!target || /[\0\r\n ]/.test(target))
    throw new Error("invalid reaction target");
  const reply = escapeTag(messageId);
  const reaction = escapeTag(emoji);
  return `@+reply=${reply};+draft/reply=${reply};+draft/${remove ? "unreact" : "react"}=${reaction} TAGMSG ${target}`;
}

// src/host.ts
function isPrivateHost(host) {
  const name = host.replace(/:\d+$/, "");
  return /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/.test(name);
}

// src/client.ts
var capabilities = ["server-time", "message-tags", "account-tag", "batch", "draft/chathistory", "draft/multiline"];

class CliError extends Error {
  exitCode;
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function timeout(promise, message, ms = 1e4) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CliError(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}
function webOrigin(host) {
  return `${isPrivateHost(host) ? "http" : "https"}://${host}`;
}
function ircHost(host) {
  return new URL(webOrigin(host)).hostname;
}
function nickOf2(prefix = "") {
  return prefix.split("!", 1)[0];
}
function authHeader(credentials) {
  return `Basic ${Buffer.from(`${credentials.nick}:${credentials.password}`).toString("base64")}`;
}
async function connected(credentials, onMessage, onClose) {
  const loopback = /^(localhost|127\.0\.0\.1)(:|$)/.test(credentials.host);
  const client = new IrcClient({
    host: ircHost(credentials.host),
    port: loopback ? 6667 : 6697,
    tls: !loopback,
    tlsInsecure: process.env.SLIRC_TLS_INSECURE === "1" || !loopback && isPrivateHost(credentials.host),
    nick: credentials.nick,
    realname: "Slirc agent",
    saslUser: credentials.nick,
    saslPass: credentials.password,
    capabilities,
    onMessage,
    onClose
  });
  try {
    await timeout(client.connect(), "IRC connection timed out");
  } catch (error) {
    client.quit();
    if (error instanceof Error && error.message.startsWith("SASL login failed"))
      throw new CliError("Slirc authentication failed. Pair again.", 3);
    throw error;
  }
  return client;
}
async function join2(client, room, nick) {
  if (!/^[#&]/.test(room))
    return;
  let failure = "";
  const joined = client.waitFor((message) => {
    if (message.command === "JOIN" && nickOf2(message.prefix).toLowerCase() === nick.toLowerCase() && message.params.at(-1)?.toLowerCase() === room.toLowerCase())
      return true;
    if (["403", "405", "471", "473", "474", "475", "476", "477", "489"].includes(message.command) && message.params.includes(room)) {
      failure = message.params.at(-1) || message.command;
      return true;
    }
    return false;
  });
  client.send(`JOIN ${room}`);
  await timeout(joined, `Timed out joining ${room}`);
  if (failure)
    throw new CliError(`Could not join ${room}: ${failure}`);
}
function sendText(client, room, text) {
  const lines = text.split(`
`);
  if (lines.length === 1)
    return client.send(`PRIVMSG ${room} :${text}`);
  const batch = `m-${randomUUID().slice(0, 8)}`;
  if (!client.send(`BATCH +${batch} draft/multiline ${room}`))
    return false;
  for (const line of lines)
    if (!client.send(`@batch=${batch} PRIVMSG ${room} :${line}`))
      return false;
  return client.send(`BATCH -${batch}`);
}
function acknowledge(client, room, msgid) {
  return client.send(reactionLine(room, msgid, "\uD83D\uDC40"));
}
async function grantedRooms(credentials) {
  try {
    const response = await fetch(`${webOrigin(credentials.host)}/api/agent/rooms`, { headers: { Authorization: authHeader(credentials) }, signal: AbortSignal.timeout(1e4) });
    if (!response.ok)
      return [];
    const body = await response.json();
    return Array.isArray(body.rooms) ? body.rooms.filter((room) => typeof room === "string") : [];
  } catch {
    return [];
  }
}

// src/session.ts
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir as homedir2 } from "node:os";
import { join as joinPath } from "node:path";
var ROOMS_REFRESH_MS = 60000;
var EYES_DELAY_MS = 1000;
var QUEUED_REPLY = "Got it, I'll reply here shortly.";
function reactionDelay(serverTime, delayMs = EYES_DELAY_MS, now = Date.now()) {
  const postedAt = Date.parse(serverTime || "");
  return Number.isFinite(postedAt) ? Math.max(0, delayMs - Math.max(0, now - postedAt)) : delayMs;
}
function runPaths(nick, env = process.env) {
  const name = nick.toLowerCase();
  if (env.XDG_RUNTIME_DIR) {
    const dir = env.XDG_RUNTIME_DIR;
    return { dir, socket: joinPath(dir, `slirc-agent-${name}.sock`), pid: joinPath(dir, `slirc-agent-${name}.pid`), log: joinPath(dir, `slirc-agent-${name}.log`) };
  }
  const dir = joinPath(env.HOME || homedir2(), ".config", "slirc", "run");
  return { dir, socket: joinPath(dir, `${name}.sock`), pid: joinPath(dir, `${name}.pid`), log: joinPath(dir, `${name}.log`) };
}
function ask(socketPath, request, timeoutMs) {
  return new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const finish = (reply) => {
      if (done)
        return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const socket = createConnection(socketPath);
    const timer = timeoutMs ? setTimeout(() => finish({ ok: false, error: "session did not answer in time", exitCode: 1 }), timeoutMs) : undefined;
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}
`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf(`
`);
      if (end === -1)
        return;
      try {
        finish(JSON.parse(buffer.slice(0, end)));
      } catch {
        finish({ ok: false, error: "session sent an unreadable reply", exitCode: 1 });
      }
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        try {
          rmSync(socketPath, { force: true });
        } catch {}
      }
      finish(undefined);
    });
    socket.once("close", () => finish({ ok: false, error: "session closed the connection", exitCode: 1 }));
  });
}
function sessionPid(pidPath) {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class Session {
  credentials;
  paths;
  client;
  watcher;
  owner;
  queue = [];
  active;
  posted = new Set;
  posting = new Map;
  waiters = new Set;
  joined = new Set;
  rooms = [];
  stopping = false;
  since = new Date().toISOString();
  closeConnection;
  log;
  connect;
  fetchRooms;
  react;
  eyesDelayMs;
  constructor(credentials, paths, options = {}) {
    this.credentials = credentials;
    this.paths = paths;
    this.owner = ownerFromAgentNick(credentials.nick);
    this.watcher = new MentionWatcher(credentials.nick, this.owner, (target) => target.toLowerCase() === credentials.nick.toLowerCase() || /^#dm-/i.test(target) || this.joined.has(target.toLowerCase()));
    this.log = options.log ?? (() => {});
    this.connect = options.connect ?? connected;
    this.fetchRooms = options.rooms ?? grantedRooms;
    this.react = options.react ?? acknowledge;
    this.eyesDelayMs = options.eyesDelayMs ?? EYES_DELAY_MS;
  }
  status() {
    return {
      nick: this.credentials.nick,
      host: this.credentials.host,
      pid: process.pid,
      connected: Boolean(this.client),
      rooms: [...this.joined],
      queued: this.queue.length,
      waiting: this.waiters.size,
      since: this.since
    };
  }
  async run() {
    mkdirSync(this.paths.dir, { recursive: true, mode: 448 });
    rmSync(this.paths.socket, { force: true });
    const server = createServer((socket) => this.serve(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.paths.socket, () => resolve());
    });
    try {
      chmodSync(this.paths.socket, 384);
    } catch {}
    writeFileSync(this.paths.pid, `${process.pid}
`, { mode: 384 });
    this.log(`session up as ${this.credentials.nick}, socket ${this.paths.socket}`);
    const refresh = setInterval(() => {
      this.refreshRooms().catch(() => {});
    }, ROOMS_REFRESH_MS);
    let exitCode = 0;
    try {
      let retry = 1000;
      while (!this.stopping) {
        let closed;
        const disconnected = new Promise((resolve) => {
          closed = resolve;
        });
        this.closeConnection = closed;
        try {
          this.client = await this.connect(this.credentials, (message) => this.handle(message), closed);
          this.client.send(`MODE ${this.credentials.nick} +B`);
          this.joined.clear();
          await this.refreshRooms();
          this.log("connected");
          retry = 1000;
          await disconnected;
          this.log("connection closed");
        } catch (error) {
          if (this.stopping)
            break;
          if (error instanceof CliError && error.exitCode === 3) {
            const reply = { ok: false, error: `${this.credentials.nick} was connected from another place. Run connect here to take it back.`, exitCode: 3 };
            for (const waiter of this.waiters)
              this.finish(waiter, reply);
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
          retry = Math.min(retry * 2, 30000);
        }
      }
    } finally {
      clearInterval(refresh);
      for (const waiter of this.waiters)
        this.finish(waiter, { ok: false, error: "session stopped", exitCode: 1 });
      server.close();
      rmSync(this.paths.socket, { force: true });
      rmSync(this.paths.pid, { force: true });
      this.log("session down");
    }
    return exitCode;
  }
  stop() {
    this.stopping = true;
    this.client?.quit();
    this.closeConnection?.();
  }
  async refreshRooms() {
    const client = this.client;
    if (!client)
      return;
    this.rooms = await this.fetchRooms(this.credentials);
    for (const room of this.rooms) {
      if (this.joined.has(room.toLowerCase()))
        continue;
      client.send(`JOIN ${room}`);
    }
  }
  handle(message) {
    if (message.command === "JOIN" && message.prefix?.split("!", 1)[0].toLowerCase() === this.credentials.nick.toLowerCase()) {
      const room = message.params.at(-1);
      if (room)
        this.joined.add(room.toLowerCase());
    }
    if (message.command === "KICK" && message.params[1]?.toLowerCase() === this.credentials.nick.toLowerCase())
      this.joined.delete(message.params[0]?.toLowerCase() || "");
    if (message.command === "PART" && message.prefix?.split("!", 1)[0].toLowerCase() === this.credentials.nick.toLowerCase())
      this.joined.delete(message.params[0]?.toLowerCase() || "");
    const mention = this.watcher.handle(message);
    if (!mention)
      return;
    const postedAt = Date.parse(message.tags.time || "");
    const eyesIn = reactionDelay(message.tags.time, this.eyesDelayMs);
    this.log(`mention ${mention.msgid} in ${mention.room} from ${mention.from}; eyes in ${eyesIn}ms`);
    setTimeout(() => {
      const client = this.client;
      if (!client)
        return;
      Promise.resolve(this.react(client, mention.room, mention.msgid)).then((sent) => this.log(`eyes ${mention.msgid} ${sent ? "sent" : "missed"}${Number.isFinite(postedAt) ? ` ${Date.now() - postedAt}ms after post` : ""}`)).catch((error) => this.log(`eyes ${mention.msgid} failed: ${error instanceof Error ? error.message : String(error)}`));
    }, eyesIn);
    const waiter = this.waiters.values().next().value;
    if (waiter) {
      this.active = mention;
      this.finish(waiter, this.mentionReply(mention));
    } else {
      sendText(this.client, mention.thread || mention.room, QUEUED_REPLY);
      this.queue.push(mention);
    }
  }
  mentionReply(mention) {
    return { ok: true, mention, instance: this.credentials.host, owner: this.owner, attachment: `${this.credentials.nick}@${this.credentials.host}` };
  }
  finish(waiter, reply) {
    if (!this.waiters.delete(waiter))
      return;
    clearTimeout(waiter.timer);
    waiter.settle(reply);
  }
  serve(socket) {
    let buffer = "";
    let waiter;
    socket.setEncoding("utf8");
    const reply = (value) => {
      try {
        socket.end(`${JSON.stringify(value)}
`);
      } catch {}
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf(`
`);
      if (end === -1)
        return;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, end));
      } catch {
        return reply({ ok: false, error: "unreadable request", exitCode: 1 });
      }
      buffer = "";
      if (request.op === "status")
        return reply({ ok: true, status: this.status() });
      if (request.op === "stop") {
        reply({ ok: true });
        this.stop();
        return;
      }
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
        const entry = { settle: reply, timer: setTimeout(() => this.finish(entry, { ok: true, timeout: true }), request.timeoutMs) };
        waiter = entry;
        this.waiters.add(entry);
        return;
      }
      reply({ ok: false, error: "unknown request", exitCode: 1 });
    });
    socket.on("close", () => {
      if (waiter)
        this.finish(waiter, { ok: true, timeout: true });
    });
    socket.on("error", () => {});
  }
  postOnce(id, room, text) {
    if (this.posted.has(id))
      return Promise.resolve();
    const existing = this.posting.get(id);
    if (existing)
      return existing;
    const pending = this.post(room, text).then(() => {
      this.posted.add(id);
      if (this.posted.size > 1000)
        this.posted.delete(this.posted.values().next().value);
    }).finally(() => this.posting.delete(id));
    this.posting.set(id, pending);
    return pending;
  }
  async post(room, text) {
    const client = this.client;
    if (!client)
      throw new CliError("session is reconnecting to Slirc; try again in a moment");
    if (/^[#&]/.test(room) && !this.joined.has(room.toLowerCase())) {
      await join2(client, room, this.credentials.nick);
      this.joined.add(room.toLowerCase());
    }
    if (!sendText(client, room, text))
      throw new CliError("session is reconnecting to Slirc; try again in a moment");
  }
}
async function daemonise(credentials, paths) {
  mkdirSync(paths.dir, { recursive: true, mode: 448 });
  const out = openSync(paths.log, "a", 384);
  const child = spawn(process.execPath, [process.argv[1], "session", "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env
  });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (child.exitCode !== null) {
      const tail = readFileSync(paths.log, "utf8").trim().split(`
`).slice(-3).join(`
  `);
      throw new CliError(`session exited with code ${child.exitCode}; see ${paths.log}
  ${tail}`, child.exitCode || 1);
    }
    const reply = await ask(paths.socket, { op: "status" }, 2000);
    if (reply?.ok && reply.status)
      return reply.status;
  }
  throw new CliError(`session did not come up; see ${paths.log}`);
}
async function stopSession(paths) {
  const reply = await ask(paths.socket, { op: "stop" }, 3000);
  const pid = sessionPid(paths.pid);
  if (!reply?.ok && pid && alive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (!reply?.ok && !pid)
    return false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!pid || !alive(pid))
      return true;
    await sleep(100);
  }
  rmSync(paths.socket, { force: true });
  rmSync(paths.pid, { force: true });
  return true;
}

// src/legacy.ts
var LEGACY = ["wait", "read", "post", "session", "whoami"];
var legacyUsage = `Commands for agents paired before 3.0, with their own IRC credentials:
  slirc-agent wait [--timeout 25m]
  slirc-agent read <room> [n] [--json]
  slirc-agent post <room> <text...>
  slirc-agent session [start [--foreground]|stop|status]
  slirc-agent whoami`;
function room(value) {
  if (!value || !(/^[#&][^\x00\x07\r\n ,:]{1,63}$/.test(value) || /^[A-Za-z][A-Za-z0-9_\-\[\]\\^{}|`]{0,31}$/.test(value)))
    throw new CliError("room must be a #channel or a nick, with no spaces");
  return value;
}
function parseDuration(value) {
  const match = value.trim().match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!match)
    throw new CliError("--timeout must look like 25m, 90s, or 2h");
  const total = Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2] || "m"];
  if (total < 1000 || total > 24 * 3600000)
    throw new CliError("--timeout must be between 1s and 24h");
  return total;
}
async function runLegacy(argv) {
  const [name, ...input] = argv;
  try {
    if (name === "wait") {
      const flag = input.findIndex((arg) => arg === "--timeout" || arg.startsWith("--timeout="));
      const value = flag < 0 ? "25m" : input[flag].includes("=") ? input[flag].slice(10) : input[flag + 1];
      if (input.length > (flag < 0 ? 0 : input[flag].includes("=") ? 1 : 2))
        throw new CliError("wait accepts only --timeout <duration>");
      return await wait(parseDuration(value ?? ""));
    }
    if (name === "read") {
      const json = input.includes("--json");
      const args = input.filter((arg) => arg !== "--json");
      if (args.length < 1 || args.length > 2)
        throw new CliError("read needs room and optional count");
      const count = args[1] === undefined ? 30 : Number(args[1]);
      if (!Number.isInteger(count) || count < 1 || count > 1000)
        throw new CliError("history count must be between 1 and 1000");
      return await read(room(args[0]), count, json);
    }
    if (name === "post") {
      if (input.length < 2)
        throw new CliError("post needs room and text");
      const text = input.slice(1).join(" ").replace(/\r\n?/g, `
`);
      if (!text || text.includes("\x00"))
        throw new CliError("message is empty or invalid");
      return await post(room(input[0]), text);
    }
    if (name === "session") {
      const foreground = input.includes("--foreground");
      const args = input.filter((arg) => arg !== "--foreground");
      const action = args[0] ?? "start";
      if (args.length > 1 || !["start", "stop", "status"].includes(action))
        throw new CliError("session accepts start [--foreground], stop, or status");
      if (foreground && action !== "start")
        throw new CliError("--foreground only applies to session start");
      return await session(action, foreground);
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
async function wait(timeoutMs) {
  const credentials = await loadCredentials();
  const viaSession = await ask(runPaths(credentials.nick).socket, { op: "wait", timeoutMs }, timeoutMs + 5000);
  if (viaSession) {
    const reply = unwrap(viaSession);
    if (reply.timeout) {
      process.exitCode = 2;
      return;
    }
    if (reply.mention)
      console.log(JSON.stringify(reply.mention));
    return;
  }
  const owner = ownerFromAgentNick(credentials.nick);
  const watcher = new MentionWatcher(credentials.nick, owner);
  let settle;
  const outcome = new Promise((resolve) => {
    settle = resolve;
  });
  let client;
  try {
    client = await connected(credentials, (message) => {
      const mention = watcher.handle(message);
      if (mention)
        settle(mention);
    }, () => settle("closed"));
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 3)
      throw new CliError(`${credentials.nick} was connected from another place. Run the same command here to take it back.`, 3);
    throw error;
  }
  const timer = setTimeout(() => {
    process.exitCode = 2;
    client.quit();
  }, timeoutMs);
  const stop = () => {
    process.exitCode = 130;
    client.quit();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    client.send(`MODE ${credentials.nick} +B`);
    for (const room of await grantedRooms(credentials))
      client.send(`JOIN ${room}`);
    const result = await outcome;
    if (result === "closed") {
      if (process.exitCode === undefined)
        throw new CliError(`Connection closed before a mention arrived. If ${credentials.nick} was connected from another place, this session was displaced.`, 3);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
function historyCollector(room) {
  let historyId = "";
  let resolve;
  const messages = [];
  const multiline = new Map;
  const done = new Promise((next) => {
    resolve = next;
  });
  const add = (prefix, time, text) => {
    const nick = nickOf2(prefix);
    if (nick.toLowerCase() !== "histserv")
      messages.push({ time, nick, text });
  };
  return {
    done,
    onMessage(message) {
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
          if (batch.lines && !("draft/multiline-concat" in tags))
            batch.text += `
`;
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
          if (batch.history && batch.target.toLowerCase() === room.toLowerCase())
            add(batch.prefix, batch.time, batch.text);
          multiline.delete(id);
        }
        if (id === historyId)
          resolve(messages);
      }
    }
  };
}
function clock(iso) {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
async function read(room, count, json) {
  const credentials = await loadCredentials();
  const history = historyCollector(room);
  const client = await connected(credentials, history.onMessage);
  try {
    await join2(client, room, credentials.nick);
    client.send(`CHATHISTORY LATEST ${room} * ${Math.min(Math.max(count * 4, 20), 200)}`);
    for (const message of (await timeout(history.done, "History request timed out")).slice(-count)) {
      console.log(json ? JSON.stringify(message) : `${clock(message.time)} ${message.nick}  ${message.text}`);
    }
  } finally {
    client.quit();
  }
}
async function post(room, text) {
  const credentials = await loadCredentials();
  const viaSession = await ask(runPaths(credentials.nick).socket, { op: "post", room, text }, 15000);
  if (viaSession) {
    unwrap(viaSession);
    return;
  }
  await postAs(credentials, room, text);
}
async function postAs(credentials, room, text) {
  const client = await connected(credentials);
  try {
    await join2(client, room, credentials.nick);
    client.send(`MODE ${credentials.nick} +B`);
    sendText(client, room, text);
  } finally {
    client.quit();
  }
}
function unwrap(reply) {
  if (!reply.ok)
    throw new CliError(reply.error, reply.exitCode);
  return reply;
}
async function session(action, foreground) {
  const credentials = await loadCredentials();
  const paths = runPaths(credentials.nick);
  if (action === "status") {
    const reply = await ask(paths.socket, { op: "status" }, 3000);
    if (!reply)
      throw new CliError(`no session for ${credentials.nick}`, 2);
    const status = unwrap(reply).status;
    console.log(`${status.nick} ${status.connected ? "connected" : "reconnecting"} pid ${status.pid} rooms ${status.rooms.length} queued ${status.queued} waiting ${status.waiting} since ${status.since}`);
    return;
  }
  if (action === "stop") {
    if (!await stopSession(paths))
      throw new CliError(`no session for ${credentials.nick}`, 2);
    console.log(`session stopped for ${credentials.nick}`);
    return;
  }
  const running = await ask(paths.socket, { op: "status" }, 3000);
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

// ../shared/harnesses.ts
var slashCommand = (workspace) => workspace ? `/slirc ${workspace}` : "/slirc";
var harnessInfo = {
  pi: {
    id: "pi",
    name: "Pi",
    released: true,
    homepage: "https://pi.dev",
    sessionCommand: slashCommand,
    reloadHint: "/reload"
  },
  claude: {
    id: "claude",
    name: "Claude Code",
    released: true,
    homepage: "https://claude.com/claude-code",
    sessionCommand: slashCommand,
    reloadHint: "/reload-plugins",
    perFolder: true
  },
  codex: {
    id: "codex",
    name: "Codex",
    released: true,
    homepage: "https://developers.openai.com/codex/cli",
    terminalOnly: true,
    sessionCommand: (workspace) => workspace ? `slirc ${workspace}` : "slirc",
    reloadHint: "/new",
    reloadStartsNewSession: true
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    released: true,
    homepage: "https://opencode.ai",
    sessionCommand: slashCommand
  }
};
var harnessInfos = [harnessInfo.pi, harnessInfo.claude, harnessInfo.codex, harnessInfo.opencode];

// src/harnesses/pi/module.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync as readFileSync2, realpathSync, statSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { delimiter, join as join3, resolve } from "node:path";
var NPM_SOURCE = "npm:slirc-agent";
var source = (env) => env.SLIRC_PI_SOURCE || NPM_SOURCE;
var agentDir = (env) => env.PI_CODING_AGENT_DIR || join3(env.HOME || homedir3(), ".pi", "agent");
function onPath(env, bin) {
  return (env.PATH ?? "").split(delimiter).some((dir) => {
    try {
      return dir !== "" && statSync(join3(dir, bin)).isFile();
    } catch {
      return false;
    }
  });
}
function run(env, args) {
  const result = spawnSync("pi", args, { env, encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0)
    return result.stdout;
  const lines = `${result.stderr ?? ""}
${result.stdout ?? ""}`.split(`
`).map((line) => line.trim()).filter((line) => line && !line.startsWith("Warning:"));
  const detail = lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? result.error?.message;
  throw new Error(`pi ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
}
var probe = (env, args) => {
  try {
    return run(env, args);
  } catch {
    return;
  }
};
function installedFolder(env, listing = probe(env, ["list"]) ?? "") {
  const lines = listing.split(`
`).map((line) => line.trim());
  const wanted = source(env);
  const local = existsSync(wanted) ? realpathSync(wanted) : undefined;
  for (let index = 0;index < lines.length - 1; index++) {
    const folder = lines[index + 1];
    const named = lines[index] === wanted || lines[index].startsWith(`${wanted}@`);
    const same = local !== undefined && existsSync(folder) && realpathSync(folder) === local;
    if (named || same)
      return folder;
  }
  return;
}
function packageVersion(folder) {
  try {
    return JSON.parse(readFileSync2(join3(folder, "package.json"), "utf8")).version;
  } catch {
    return;
  }
}
function conflict(env) {
  const dir = join3(agentDir(env), "extensions");
  const found = ["slirc.ts", "slirc.js", "slirc"].map((name) => join3(dir, name)).find((path) => existsSync(path));
  return found ? `${found} is another Slirc extension. Move it out of ${dir}, then run this again.` : undefined;
}
var pi = {
  ...harnessInfo.pi,
  sessionKey: (env) => env.PI_CODING_AGENT === "true" && env.PI_SESSION_ID ? env.PI_SESSION_ID : undefined,
  detect(env) {
    const installed = onPath(env, "pi");
    const version = installed ? probe(env, ["--version"])?.trim().split(`
`).at(-1) : undefined;
    return { installed, inside: env.PI_CODING_AGENT === "true", ...version ? { version } : {} };
  },
  status(env, version) {
    const blocked = conflict(env);
    if (blocked)
      return { state: "conflict", detail: blocked };
    const folder = installedFolder(env);
    if (!folder)
      return { state: "missing" };
    const installed = packageVersion(folder);
    if (env.SLIRC_PI_SOURCE)
      return { state: "current", ...installed ? { version: installed } : {} };
    if (!installed || installed !== version)
      return { state: "outdated", ...installed ? { version: installed } : {} };
    return { state: "current", version: installed };
  },
  install(env, version) {
    const status = pi.status(env, version);
    if (status.state === "current" || status.state === "conflict")
      return [];
    const target = env.SLIRC_PI_SOURCE ? resolve(env.SLIRC_PI_SOURCE) : `${NPM_SOURCE}@${version}`;
    const steps = [];
    const folder = installedFolder(env);
    if (status.state === "outdated" && folder) {
      const listed = (probe(env, ["list"]) ?? "").split(`
`).map((line) => line.trim()).find((line) => line === NPM_SOURCE || line.startsWith(`${NPM_SOURCE}@`)) ?? NPM_SOURCE;
      steps.push({ doing: `pi remove ${listed}`, apply: () => {
        run(env, ["remove", listed]);
      } });
    }
    steps.push({ doing: `pi install ${target}`, apply: () => {
      run(env, ["install", target]);
    } });
    return steps;
  },
  uninstall(env) {
    const listed = (probe(env, ["list"]) ?? "").split(`
`).map((line) => line.trim()).find((line) => line === source(env) || line.startsWith(`${NPM_SOURCE}@`));
    return listed ? [{ doing: `pi remove ${listed}`, apply: () => {
      run(env, ["remove", listed]);
    } }] : [];
  },
  launch(host, env, extra) {
    return { bin: "pi", args: extra, env: { ...env, SLIRC_CONNECT: host } };
  }
};
var module_default = pi;

// src/harnesses/claude/module.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { cpSync, existsSync as existsSync2, readdirSync, readFileSync as readFileSync3, realpathSync as realpathSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname2, join as join4 } from "node:path";
import { fileURLToPath } from "node:url";
// package.json
var package_default = {
  name: "slirc-agent",
  version: "3.4.0",
  description: "Connect coding agents to Slirc rooms",
  keywords: [
    "slirc",
    "chat",
    "agent",
    "pi-package",
    "coding-agent",
    "cli"
  ],
  homepage: "https://app.slirc.org/docs/agents",
  repository: {
    type: "git",
    url: "git+https://github.com/bitbonsai/slirc.git",
    directory: "app/agent"
  },
  bugs: {
    url: "https://github.com/bitbonsai/slirc/issues"
  },
  license: "MIT",
  type: "module",
  bin: {
    "slirc-agent": "dist/slirc-agent.js"
  },
  pi: {
    extensions: [
      "./dist/pi-extension.js"
    ]
  },
  files: [
    "dist",
    "README.md",
    "HARNESSES.md",
    "LICENSE"
  ],
  scripts: {
    build: "bun build src/bin.ts --target=node --outfile=dist/slirc-agent.js && bun build src/harnesses/pi/extension.ts --target=node --external typebox --outfile=dist/pi-extension.js && bun scripts/build-claude.ts && bun src/harnesses/codex/build.ts && bun src/harnesses/opencode/build.ts",
    test: "bun test",
    prepack: "bun run build"
  },
  dependencies: {},
  engines: {
    node: ">=18"
  },
  peerDependencies: {
    typebox: "*"
  }
};

// src/version.ts
var VERSION = package_default.version;
var PACKAGE = package_default.name;
function compareVersions(a, b) {
  const parts = (value) => (value.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? ["0", "0", "0"]).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0;index < 3; index++)
    if (x[index] !== y[index])
      return x[index] - y[index];
  return 0;
}

// src/harnesses/claude/module.ts
var MARKETPLACE = "slirc-agent";
var PLUGIN = `slirc@${MARKETPLACE}`;
function bundled(env) {
  if (env.SLIRC_CLAUDE_SOURCE)
    return env.SLIRC_CLAUDE_SOURCE;
  const here = dirname2(fileURLToPath(import.meta.url));
  return [join4(here, "claude"), join4(here, "..", "..", "..", "dist", "claude")].find((path) => existsSync2(path)) ?? join4(here, "claude");
}
var home = (env) => env.HOME || homedir4();
var target = (env) => join4(env.XDG_DATA_HOME || join4(home(env), ".local", "share"), "slirc-agent", "claude-code");
var configDir = (env) => env.CLAUDE_CONFIG_DIR || join4(home(env), ".claude");
var folder = (env) => {
  const path = env.SLIRC_FOLDER || process.cwd();
  try {
    return realpathSync2(path);
  } catch {
    return path;
  }
};
function run2(env, args) {
  const result = spawnSync2("claude", args, { env, cwd: folder(env), encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0)
    return result.stdout;
  const detail = `${result.stderr ?? ""}
${result.stdout ?? ""}`.split(`
`).map((line) => line.trim()).filter(Boolean).at(-1) ?? result.error?.message;
  throw new Error(`claude ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
}
var probe2 = (env, args) => {
  try {
    return run2(env, args);
  } catch {
    return;
  }
};
function entries(env) {
  try {
    return JSON.parse(probe2(env, ["plugin", "list", "--json"]) ?? "[]").filter((plugin) => plugin.id === PLUGIN);
  } catch {
    return [];
  }
}
var here = (env, list = entries(env)) => list.find((entry) => entry.scope === "local" && entry.projectPath === folder(env));
var userWide = (env, list = entries(env)) => list.find((entry) => entry.scope === "user");
var marketplaceListed = (env) => {
  try {
    return JSON.parse(probe2(env, ["plugin", "marketplace", "list", "--json"]) ?? "[]").some((item) => item.name === MARKETPLACE);
  } catch {
    return false;
  }
};
var BLOCKERS = {
  allowManagedModsOnly: "allows only mods your organization manages",
  allowManagedHooksOnly: "allows only hooks your organization manages",
  disableAllHooks: "turns hooks off"
};
function managedFiles(env) {
  const dirs = env.SLIRC_CLAUDE_MANAGED_DIR ? [env.SLIRC_CLAUDE_MANAGED_DIR] : process.platform === "darwin" ? ["/Library/Application Support/ClaudeCode"] : ["/etc/claude-code"];
  const files = [join4(configDir(env), "remote-settings.json")];
  for (const dir of dirs) {
    files.push(join4(dir, "managed-settings.json"));
    try {
      for (const name of readdirSync(join4(dir, "managed-settings.d")).sort())
        if (name.endsWith(".json"))
          files.push(join4(dir, "managed-settings.d", name));
    } catch {}
  }
  return files;
}
function blockedBy(env) {
  for (const file of managedFiles(env)) {
    let settings;
    try {
      settings = JSON.parse(readFileSync3(file, "utf8"));
    } catch {
      continue;
    }
    const key = Object.keys(BLOCKERS).find((name) => settings[name] === true);
    if (key)
      return `Your organization's Claude Code settings (${key} in ${file}) ${BLOCKERS[key]}, so the Slirc plugin can't load. Ask your Claude Code admin to allow it, or use Pi with Slirc instead.`;
  }
  return;
}
var MIN_CLAUDE = "2.1.286";
function tooOld(env) {
  const found = probe2(env, ["--version"])?.trim().split(" ")[0];
  if (!found || !/^\d+\.\d+\.\d+/.test(found) || compareVersions(found, MIN_CLAUDE) >= 0)
    return;
  return `Slirc needs Claude Code ${MIN_CLAUDE} or newer, and this is ${found}. Run claude update, then run this again.`;
}
function conflict2(env) {
  const blocked = blockedBy(env) ?? tooOld(env);
  if (blocked)
    return blocked;
  const placed = join4(target(env), ".claude-plugin", "marketplace.json");
  if (existsSync2(target(env)) && !existsSync2(placed))
    return `${target(env)} exists but isn't the Slirc marketplace. Move it away, then run this again.`;
  return;
}
function place(env) {
  rmSync2(target(env), { recursive: true, force: true });
  cpSync(bundled(env), target(env), { recursive: true });
  writeFileSync2(join4(target(env), "slirc", "runtime.json"), `${JSON.stringify({ exec: env.SLIRC_CLAUDE_RUNTIME || process.execPath })}
`);
}
var claude = {
  ...harnessInfo.claude,
  localCommand(env, workspace) {
    const own = [join4(configDir(env), "skills", "slirc"), join4(configDir(env), "commands", "slirc.md")].some((path) => existsSync2(path));
    const name = own ? "/slirc-connect" : "/slirc";
    return workspace ? `${name} ${workspace}` : name;
  },
  sessionKey: (env) => env.CLAUDECODE === "1" && env.CLAUDE_CODE_SESSION_ID ? env.CLAUDE_CODE_SESSION_ID : undefined,
  detect(env) {
    const found = onPath(env, "claude");
    const version = found ? probe2(env, ["--version"])?.trim().split(" ")[0] : undefined;
    return { installed: found, inside: env.CLAUDECODE === "1", ...version ? { version } : {} };
  },
  status(env, version) {
    const blocked = conflict2(env);
    if (blocked)
      return { state: "conflict", detail: blocked };
    const list = entries(env);
    const listed = here(env, list);
    if (!listed)
      return { state: "missing" };
    const current = listed.version === version && listed.enabled !== false && !userWide(env, list);
    return { state: current ? "current" : "outdated", ...listed.version ? { version: listed.version } : {} };
  },
  install(env, version) {
    const status = claude.status(env, version);
    if (status.state === "current" || status.state === "conflict")
      return [];
    const list = entries(env);
    const listed = here(env, list);
    const steps = [];
    const placedVersion = (() => {
      try {
        return JSON.parse(readFileSync3(join4(target(env), "slirc", ".claude-plugin", "plugin.json"), "utf8")).version;
      } catch {
        return;
      }
    })();
    if (placedVersion !== version) {
      steps.push({ doing: `copy the Slirc plugin to ${target(env)}`, apply: () => place(env) });
      if (!marketplaceListed(env))
        steps.push({ doing: `claude plugin marketplace add ${target(env)}`, apply: () => {
          run2(env, ["plugin", "marketplace", "add", target(env)]);
        } });
      else
        steps.push({ doing: `claude plugin marketplace update ${MARKETPLACE}`, apply: () => {
          run2(env, ["plugin", "marketplace", "update", MARKETPLACE]);
        } });
    } else if (!marketplaceListed(env))
      steps.push({ doing: `claude plugin marketplace add ${target(env)}`, apply: () => {
        run2(env, ["plugin", "marketplace", "add", target(env)]);
      } });
    if (!listed)
      steps.push({ doing: `claude plugin install ${PLUGIN} --scope local (in ${folder(env)})`, apply: () => {
        run2(env, ["plugin", "install", PLUGIN, "--scope", "local"]);
      } });
    else {
      if (listed.version !== version)
        steps.push({ doing: `claude plugin update ${PLUGIN} --scope local`, apply: () => {
          run2(env, ["plugin", "update", PLUGIN, "--scope", "local"]);
        } });
      if (listed.enabled === false)
        steps.push({ doing: `claude plugin enable ${PLUGIN} --scope local`, apply: () => {
          run2(env, ["plugin", "enable", PLUGIN, "--scope", "local"]);
        } });
    }
    if (userWide(env, list))
      steps.push({ doing: `claude plugin uninstall ${PLUGIN} --scope user`, apply: () => {
        run2(env, ["plugin", "uninstall", PLUGIN, "--scope", "user"]);
      } });
    return steps;
  },
  uninstall(env) {
    const list = entries(env);
    const steps = [];
    const mine = list.filter((entry) => entry === here(env, list) || entry.scope === "user");
    for (const entry of mine)
      steps.push({ doing: `claude plugin uninstall ${PLUGIN} --scope ${entry.scope}`, apply: () => {
        run2(env, ["plugin", "uninstall", PLUGIN, "--scope", String(entry.scope)]);
      } });
    if (mine.length === list.length) {
      if (marketplaceListed(env))
        steps.push({ doing: `claude plugin marketplace remove ${MARKETPLACE}`, apply: () => {
          run2(env, ["plugin", "marketplace", "remove", MARKETPLACE]);
        } });
      if (existsSync2(join4(target(env), ".claude-plugin", "marketplace.json")))
        steps.push({ doing: `delete ${target(env)}`, apply: () => rmSync2(target(env), { recursive: true, force: true }) });
    }
    return steps;
  },
  launch(host, env, extra) {
    return { bin: "claude", args: extra, env: { ...env, SLIRC_CONNECT: host } };
  }
};
var module_default2 = claude;

// src/harnesses/codex/module.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { cpSync as cpSync2, existsSync as existsSync3, readFileSync as readFileSync5, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { dirname as dirname5, join as join7 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/adapter-core.ts
import { homedir as homedir6, tmpdir } from "node:os";
import { basename, dirname as dirname4, join as join6, resolve as resolve2 } from "node:path";

// ../shared/workspace.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { dirname as dirname3, join as join5 } from "node:path";
var DEFAULT_HOST = "app.slirc.org";
var HOSTED = ".slirc.app";
function expandWorkspace(input) {
  const value = (input ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!value)
    return DEFAULT_HOST;
  const host = /[.:]/.test(value) || value === "localhost" ? value : `${value}${HOSTED}`;
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(host))
    throw new Error(`"${input}" isn't a workspace name. Use the name on your Agents page, such as calango, or a host such as chat.example.com.`);
  return host;
}
function workspaceArg(host) {
  const value = host.toLowerCase();
  if (value === DEFAULT_HOST)
    return "";
  if (value.endsWith(HOSTED) && !value.slice(0, -HOSTED.length).includes("."))
    return value.slice(0, -HOSTED.length);
  return value;
}
function isPrivateHost2(host) {
  const name = host.replace(/:\d+$/, "");
  return /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/.test(name);
}
function originFor(workspace) {
  const host = expandWorkspace(workspace);
  return new URL(`${isPrivateHost2(host) ? "http" : "https"}://${host}`).origin;
}
function lastWorkspacePath(env = process.env) {
  return join5(env.XDG_STATE_HOME || join5(env.HOME || homedir5(), ".local", "state"), "slirc", "workspace");
}
function readLastWorkspace(env = process.env) {
  try {
    return readFileSync4(lastWorkspacePath(env), "utf8").trim() || undefined;
  } catch {
    return;
  }
}
function saveLastWorkspace(host, env = process.env) {
  try {
    mkdirSync2(dirname3(lastWorkspacePath(env)), { recursive: true });
    writeFileSync3(lastWorkspacePath(env), `${host}
`);
  } catch {}
}
// src/adapter-core.ts
var MAX_SSE_BUFFER = 128 * 1024;
var CONFIRM_WAIT_MS = 10 * 60000;
var stateDir = (harness, env = process.env) => join6(env.XDG_STATE_HOME || join6(env.HOME || homedir6(), ".local", "state"), "slirc-agent", harness);
var MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

// src/harnesses/codex/shared.ts
var MIN_CODEX = "0.169.0";
var BELOW_CODEX = "0.173.0";
var TESTED = "0.169 to 0.172";
var supported = (version) => compareVersions(version, MIN_CODEX) >= 0 && compareVersions(version, BELOW_CODEX) < 0;
function unsupported(version) {
  if (!version || !/^\d+\.\d+\.\d+/.test(version) || supported(version))
    return;
  return compareVersions(version, MIN_CODEX) < 0 ? `Slirc works with Codex ${TESTED}, and this is ${version}. Update Codex, then run this again.` : `Slirc is tested with Codex ${TESTED}, and this is ${version}. Run npx slirc-agent@latest to get a version that knows it.`;
}
var codexVersion = (text) => text?.match(/(\d+\.\d+\.\d+)/)?.[1];
var validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);

// src/harnesses/codex/module.ts
var MARKETPLACE2 = "slirc-agent";
var PLUGIN2 = `slirc@${MARKETPLACE2}`;
var EVENTS = { SessionStart: 5, UserPromptSubmit: 20, Stop: 5, SessionEnd: 3 };
function bundled2(env) {
  if (env.SLIRC_CODEX_SOURCE)
    return env.SLIRC_CODEX_SOURCE;
  const here = dirname5(fileURLToPath2(import.meta.url));
  return [join7(here, "codex"), join7(here, "..", "..", "..", "dist", "codex")].find((path) => existsSync3(path)) ?? join7(here, "codex");
}
var home2 = (env) => env.HOME || homedir7();
var target2 = (env) => join7(env.XDG_DATA_HOME || join7(home2(env), ".local", "share"), "slirc-agent", "codex");
var pluginDir = (env) => join7(target2(env), "slirc");
function run3(env, args) {
  const result = spawnSync3("codex", args, { env, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0)
    return result.stdout;
  const detail = `${result.stderr ?? ""}
${result.stdout ?? ""}`.split(`
`).map((line) => line.trim()).filter(Boolean).at(-1) ?? result.error?.message;
  throw new Error(`codex ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
}
var probe3 = (env, args) => {
  try {
    return run3(env, args);
  } catch {
    return;
  }
};
var json = (text) => {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return;
  }
};
var entry = (env) => json(probe3(env, ["plugin", "list", "--json"]))?.installed?.find((plugin) => plugin.pluginId === PLUGIN2 && plugin.installed !== false);
var marketplaceListed2 = (env) => (json(probe3(env, ["plugin", "marketplace", "list", "--json"]))?.marketplaces ?? []).some((item) => item.name === MARKETPLACE2);
var placedVersion = (env) => json(existsSync3(join7(pluginDir(env), ".codex-plugin", "plugin.json")) ? readFileSync5(join7(pluginDir(env), ".codex-plugin", "plugin.json"), "utf8") : "")?.version;
var ours = (env) => existsSync3(join7(target2(env), ".agents", "plugins", "marketplace.json"));
function oldServer(env) {
  const server = json(probe3(env, ["mcp", "get", "slirc", "--json"]));
  if (!server?.transport)
    return;
  const words = [server.transport.command, ...server.transport.args ?? []].map(String);
  if (words.includes(join7(pluginDir(env), "slirc-codex.js")))
    return;
  return words.some((word) => /(^|\/)slirc-agent(@|$)/.test(word)) ? "ours" : "foreign";
}
var quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
function place2(env) {
  rmSync3(target2(env), { recursive: true, force: true });
  cpSync2(bundled2(env), target2(env), { recursive: true });
  const exec = env.SLIRC_CODEX_RUNTIME || process.execPath;
  const script = join7(pluginDir(env), "slirc-codex.js");
  const hooks = Object.fromEntries(Object.entries(EVENTS).map(([event, timeout]) => [event, [{ hooks: [{ type: "command", command: `${quote(exec)} ${quote(script)} hook ${event}`, timeout }] }]]));
  writeFileSync4(join7(pluginDir(env), "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}
`);
  writeFileSync4(join7(pluginDir(env), ".mcp.json"), `${JSON.stringify({ mcpServers: { slirc: { command: exec, args: [script, "mcp"], env_vars: ["XDG_STATE_HOME"], default_tools_approval_mode: "approve" } } }, null, 2)}
`);
}
function conflict3(env) {
  const old = unsupported(codexVersion(probe3(env, ["--version"])));
  if (old)
    return old;
  if (existsSync3(target2(env)) && !ours(env))
    return `${target2(env)} exists but isn't the Slirc marketplace. Move it away, then run this again.`;
  if (oldServer(env) === "foreign")
    return "Your Codex config has an MCP server named slirc that Slirc didn't add, and it would hide Slirc's. Remove it with codex mcp remove slirc, or give it another name, then run this again.";
  return;
}
var codex = {
  ...harnessInfo.codex,
  sessionKey: (env) => validId(env.CODEX_THREAD_ID) ? env.CODEX_THREAD_ID : undefined,
  detect(env) {
    const found = onPath(env, "codex");
    const version = found ? codexVersion(probe3(env, ["--version"])) : undefined;
    return { installed: found, inside: !!env.CODEX_THREAD_ID, ...version ? { version } : {} };
  },
  status(env, version) {
    if (!onPath(env, "codex"))
      return { state: "missing" };
    const blocked = conflict3(env);
    if (blocked)
      return { state: "conflict", detail: blocked };
    const listed = entry(env);
    if (!listed)
      return { state: "missing" };
    const current = listed.version === version && listed.enabled !== false && placedVersion(env) === version && existsSync3(join7(pluginDir(env), "hooks.json")) && !oldServer(env);
    return { state: current ? "current" : "outdated", ...listed.version ? { version: listed.version } : {} };
  },
  install(env, version) {
    const status = codex.status(env, version);
    if (status.state === "current" || status.state === "conflict" || !onPath(env, "codex"))
      return [];
    const steps = [];
    if (oldServer(env) === "ours")
      steps.push({ doing: "codex mcp remove slirc (left by slirc-agent 2.x)", apply: () => {
        run3(env, ["mcp", "remove", "slirc"]);
      } });
    if (placedVersion(env) !== version || !existsSync3(join7(pluginDir(env), "hooks.json")))
      steps.push({ doing: `copy the Slirc plugin to ${target2(env)}`, apply: () => place2(env) });
    if (!marketplaceListed2(env))
      steps.push({ doing: `codex plugin marketplace add ${target2(env)}`, apply: () => {
        run3(env, ["plugin", "marketplace", "add", target2(env)]);
      } });
    const listed = entry(env);
    if (!listed || listed.version !== version || listed.enabled === false || placedVersion(env) !== version)
      steps.push({ doing: `codex plugin add ${PLUGIN2}`, apply: () => {
        run3(env, ["plugin", "add", PLUGIN2]);
      } });
    return steps;
  },
  uninstall(env) {
    const steps = [];
    if (oldServer(env) === "ours")
      steps.push({ doing: "codex mcp remove slirc (left by slirc-agent 2.x)", apply: () => {
        run3(env, ["mcp", "remove", "slirc"]);
      } });
    if (entry(env))
      steps.push({ doing: `codex plugin remove ${PLUGIN2}`, apply: () => {
        run3(env, ["plugin", "remove", PLUGIN2]);
      } });
    if (marketplaceListed2(env))
      steps.push({ doing: `codex plugin marketplace remove ${MARKETPLACE2}`, apply: () => {
        run3(env, ["plugin", "marketplace", "remove", MARKETPLACE2]);
      } });
    if (ours(env))
      steps.push({ doing: `delete ${target2(env)}`, apply: () => rmSync3(target2(env), { recursive: true, force: true }) });
    return steps;
  },
  launch(host, env, extra) {
    const ticket = env.SLIRC_CONNECT_TICKET;
    return { bin: "codex", args: [...extra, `slirc ${host}${ticket ? ` ${ticket}` : ""}`], env };
  }
};
var module_default3 = codex;

// src/harnesses/opencode/module.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import { cpSync as cpSync3, existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync6, rmSync as rmSync4 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { dirname as dirname6, join as join8 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/harnesses/opencode/shared.ts
var OPENCODE_RANGE = { min: "2.3.0", below: "2.4.0", label: "2.3" };
var parts = (value) => value.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
var older = (a, b) => {
  for (let i = 0;i < 3; i++)
    if (a[i] !== b[i])
      return a[i] < b[i];
  return false;
};
function unsupported2(version) {
  const found = parts(version ?? "");
  if (!found)
    return;
  const shown = found.join(".");
  if (found[0] < 2)
    return `Slirc needs OpenCode 2, and this is ${shown}. Install OpenCode 2 with npm install -g @opencode/cli, then run this again.`;
  if (older(found, parts(OPENCODE_RANGE.min)))
    return `Slirc needs OpenCode ${OPENCODE_RANGE.min} or newer, and this is ${shown}. Run opencode upgrade, then run this again.`;
  if (!older(found, parts(OPENCODE_RANGE.below)))
    return `This Slirc supports OpenCode ${OPENCODE_RANGE.label}, and this is ${shown}. Run npx slirc-agent@latest to get a newer Slirc. If it still says this, OpenCode ${shown} isn't supported yet.`;
  return;
}

// src/harnesses/opencode/module.ts
var PACKAGE2 = "slirc-agent-opencode";
function bundled3(env) {
  if (env.SLIRC_OPENCODE_SOURCE)
    return env.SLIRC_OPENCODE_SOURCE;
  const here = dirname6(fileURLToPath3(import.meta.url));
  return [join8(here, "opencode"), join8(here, "..", "..", "..", "dist", "opencode")].find((path) => existsSync4(path)) ?? join8(here, "opencode");
}
var configHome = (env) => env.XDG_CONFIG_HOME || join8(env.HOME || homedir8(), ".config");
var pluginFolder = (env) => join8(configHome(env), "opencode", "plugins", "slirc");
var manifest = (folder) => {
  try {
    return JSON.parse(readFileSync6(join8(folder, "package.json"), "utf8"));
  } catch {
    return;
  }
};
function version(env) {
  if (!onPath(env, "opencode"))
    return;
  const result = spawnSync4("opencode", ["--version"], { env, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0 ? result.stdout.trim().match(/v?(\d+\.\d+\.\d+\S*)/)?.[1] : undefined;
}
function legacy(folder) {
  if (existsSync4(join8(folder, "package.json")))
    return false;
  try {
    return readFileSync6(join8(folder, "index.js"), "utf8").includes("slirc-agent.opencode.v2");
  } catch {
    return false;
  }
}
function conflict4(env) {
  const refused = unsupported2(version(env));
  if (refused)
    return refused;
  const folder = pluginFolder(env);
  if (existsSync4(folder) && manifest(folder)?.name !== PACKAGE2 && !legacy(folder))
    return `${folder} is another plugin named slirc. Move it out of ${dirname6(folder)}, then run this again.`;
  return;
}
var opencode = {
  ...harnessInfo.opencode,
  sessionKey: (env) => env.OPENCODE === "1" && env.OPENCODE_SESSION_ID ? env.OPENCODE_SESSION_ID : undefined,
  detect(env) {
    const found = version(env);
    return { installed: onPath(env, "opencode"), inside: env.OPENCODE === "1", ...found ? { version: found } : {} };
  },
  status(env, wanted) {
    const blocked = conflict4(env);
    if (blocked)
      return { state: "conflict", detail: blocked };
    if (legacy(pluginFolder(env)))
      return { state: "outdated", version: "2.x" };
    const installed = manifest(pluginFolder(env))?.version;
    if (!installed)
      return { state: "missing" };
    return { state: installed === wanted ? "current" : "outdated", version: installed };
  },
  install(env, wanted) {
    const status = opencode.status(env, wanted);
    if (status.state === "current" || status.state === "conflict")
      return [];
    const folder = pluginFolder(env);
    return [{
      doing: `copy the Slirc plugin to ${folder}`,
      apply: () => {
        const source = bundled3(env);
        const found = manifest(source)?.version;
        if (manifest(source)?.name !== PACKAGE2)
          throw new Error(`The Slirc plugin for OpenCode is missing from ${source}. Reinstall slirc-agent, then run this again.`);
        if (found !== wanted && !env.SLIRC_OPENCODE_SOURCE)
          throw new Error(`The bundled OpenCode plugin is ${found}, not ${wanted}. Reinstall slirc-agent, then run this again.`);
        mkdirSync3(dirname6(folder), { recursive: true });
        rmSync4(folder, { recursive: true, force: true });
        cpSync3(source, folder, { recursive: true });
      }
    }, {
      doing: "reload OpenCode so it loads the plugin",
      apply: () => {
        const result = spawnSync4("opencode", ["reload"], { env, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
        if (result.status !== 0)
          throw new Error("opencode reload failed. Quit OpenCode and start it again, then type /slirc in a session.");
      }
    }];
  },
  uninstall(env) {
    const folder = pluginFolder(env);
    return manifest(folder)?.name === PACKAGE2 || legacy(folder) ? [{ doing: `delete ${folder}`, apply: () => rmSync4(folder, { recursive: true, force: true }) }] : [];
  },
  launch(host, env, extra) {
    return { bin: "opencode", args: extra, env: { ...env, SLIRC_CONNECT: host } };
  }
};
var module_default4 = opencode;

// src/harnesses/index.ts
var harnesses = [module_default, module_default2, module_default3, module_default4];

// src/arm.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync as mkdirSync4, openSync as openSync2, readFileSync as readFileSync7, renameSync, rmSync as rmSync5, writeSync } from "node:fs";
import { join as join9 } from "node:path";
var ARM_TTL_MS = 10 * 60000;
var KEY = /^[A-Za-z0-9_-]{1,128}$/;
var validTicket = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
var checksProcesses = process.platform !== "win32";
var armDir = (harness, env = process.env) => join9(stateDir(harness, env), "arm");
var armPath = (harness, key, env = process.env, reload = false) => {
  if (!KEY.test(key))
    throw new Error("bad session key");
  return join9(armDir(harness, env), `${key}${reload ? ".reload" : ""}.json`);
};
function ancestors(from = process.ppid) {
  if (!checksProcesses)
    return [];
  const listed = spawnSync5("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5000 });
  const parent = new Map;
  for (const line of (listed.stdout ?? "").split(`
`)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && ppid >= 0)
      parent.set(pid, ppid);
  }
  const chain = [];
  for (let pid = from;pid > 0 && chain.length < 64 && !chain.includes(pid); pid = parent.get(pid) ?? 0)
    chain.push(pid);
  return chain;
}
var alive2 = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
function parse(text, now) {
  try {
    const raw = JSON.parse(text);
    if (typeof raw.host !== "string" || typeof raw.at !== "number" || now - raw.at > ARM_TTL_MS || raw.at > now + 60000)
      return;
    const pids = Array.isArray(raw.pids) ? raw.pids.filter((pid) => Number.isInteger(pid) && pid > 0) : undefined;
    return { host: expandWorkspace(raw.host), at: raw.at, ...validTicket(raw.ticket) ? { ticket: raw.ticket } : {}, ...pids ? { pids } : {} };
  } catch {
    return;
  }
}
function writeArm(harness, key, arm, env = process.env, now = Date.now(), pids = ancestors()) {
  const path = armPath(harness, key, env, arm.reload);
  mkdirSync4(armDir(harness, env), { recursive: true, mode: 448 });
  let existing;
  try {
    existing = parse(readFileSync7(path, "utf8"), now);
  } catch {}
  const owner = existing?.pids?.find(alive2);
  if (owner !== undefined && !pids.includes(owner))
    throw new Error("another session already asked to connect under this session's id");
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync2(temp, "wx", 384);
  try {
    writeSync(fd, JSON.stringify({ host: arm.host, ...validTicket(arm.ticket) ? { ticket: arm.ticket } : {}, at: now, ...checksProcesses ? { pids } : {} }));
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  return path;
}

// src/cli.ts
class CliError2 extends Error {
  exitCode;
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
var defaultIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }
};
var offered = (unreleased) => harnesses.filter((harness) => harness.released || unreleased);
var names = (list) => list.map((harness) => harness.name).join(", ").replace(/, ([^,]*)$/, " and $1");
function chosen(id, unreleased) {
  const list = offered(unreleased);
  if (!id)
    return list;
  const harness = list.find((item) => item.id === id);
  if (!harness)
    throw new CliError2(`Slirc doesn't work with "${id}" yet. It works with ${names(list)} (--harness ${list.map((item) => item.id).join(" or ")}).`);
  return [harness];
}
async function checkWorkspace(host) {
  let response;
  try {
    response = await fetch(`${originFor(host)}/api/agent/version`, { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new CliError2(`Couldn't reach ${host}. Check the workspace name on your Agents page and your connection, then try again.`);
  }
  if (response.status === 404)
    throw new CliError2(`${host} runs an older Slirc that can't connect agents this way. Ask your Slirc admin to update it.`);
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.version !== "string")
    throw new CliError2(`${host} didn't answer like a Slirc workspace (HTTP ${response.status}). Check the workspace name on your Agents page.`);
  if (body.enabled === false)
    throw new CliError2(body.reason || `Agents are turned off on ${host}.`);
  const arg = workspaceArg(host);
  const again = (runner) => `${runner} slirc-agent@${body.version}${arg ? ` ${arg}` : ""}`;
  const sameMajor = VERSION.split(".")[0] === body.version.split(".")[0];
  if (!sameMajor || compareVersions(VERSION, body.version) < 0) {
    throw new CliError2(`${host} uses slirc-agent ${body.version} and this is ${VERSION}. Run ${again("npx")} (or ${again("bunx")}).`);
  }
}
async function pick(found, io) {
  if (found.length === 1)
    return found[0];
  if (!io.tty || !io.ask)
    throw new CliError2(`Found ${names(found)}. Pick one with --harness ${found.map((item) => item.id).join(" or ")}.`);
  io.out("Which agent should connect?");
  found.forEach((harness, index) => io.out(`  ${index + 1}. ${harness.name}`));
  const answer = Number((await io.ask(`Number [1-${found.length}]: `)).trim());
  if (!Number.isInteger(answer) || answer < 1 || answer > found.length)
    throw new CliError2("No agent picked. Nothing changed.");
  return found[answer - 1];
}
function setUp(harness, env, io, dryRun) {
  const status = harness.status(env, VERSION);
  if (status.state === "conflict")
    throw new CliError2(status.detail ?? `Something is in the way of the Slirc extension for ${harness.name}.`);
  const steps = harness.install(env, VERSION);
  if (!steps.length) {
    io.out(`${harness.name}: Slirc extension ${status.version ?? VERSION} is set up.`);
    return false;
  }
  io.out(`${harness.name}: ${status.state === "missing" ? "adding" : `updating from ${status.version ?? "an older version"} to ${VERSION}`} the Slirc extension.`);
  for (const step of steps) {
    io.out(`  ${step.doing}`);
    if (dryRun)
      continue;
    try {
      step.apply();
    } catch (error) {
      throw new CliError2(`${error instanceof Error ? error.message : String(error)}
Nothing else changed. Fix that, then run this again.`);
    }
  }
  if (dryRun) {
    io.out("Dry run: nothing changed.");
    return false;
  }
  return status.state === "missing" ? "installed" : "updated";
}
var commandFor = (harness, env, workspace) => harness.localCommand?.(env, workspace) ?? harness.sessionCommand(workspace);
function installedAmong(list, env) {
  const detected = list.map((harness) => ({ harness, ...harness.detect(env) }));
  return { inside: detected.find((item) => item.inside)?.harness, found: detected.filter((item) => item.installed).map((item) => item.harness) };
}
function missing(list) {
  const where = list.map((harness) => `${harness.name} from ${harness.homepage}`).join(", or ");
  return new CliError2(`Slirc works with ${names(list)} today, and none is installed here. Install ${where}, then run this again.`);
}
async function connect(command, env, io, launch) {
  let host;
  try {
    host = command.workspace ? expandWorkspace(command.workspace) : readLastWorkspace(env) ?? expandWorkspace("");
  } catch (error) {
    throw new CliError2(error instanceof Error ? error.message : String(error));
  }
  const list = chosen(command.harness, command.unreleased);
  const { inside, found } = installedAmong(list, env);
  const harness = inside ?? (found.length ? await pick(found, io) : undefined);
  if (!harness)
    throw missing(list);
  await checkWorkspace(host);
  const changed = setUp(harness, env, io, command.dryRun);
  if (command.dryRun)
    return 0;
  saveLastWorkspace(host, env);
  const typed = commandFor(harness, env, workspaceArg(host));
  if (inside === harness) {
    const key = changed && harness.reloadStartsNewSession ? undefined : harness.sessionKey?.(env);
    if (key) {
      try {
        writeArm(harness.id, key, { host, ...command.ticket ? { ticket: command.ticket } : {}, reload: !!changed }, env);
      } catch (error) {
        throw new CliError2(`Couldn't ask this ${harness.name} session to connect: ${error instanceof Error ? error.message : String(error)}. Type ${typed} in it instead.`);
      }
      io.out(changed && harness.reloadHint ? `Slirc is ${changed}. Type ${harness.reloadHint}, then a code shows in this session: enter it on the Agents page in Slirc.` : `${changed ? `Slirc is ${changed} and loaded, so there's nothing to reload. ` : ""}Connecting this ${harness.name} session to ${host}. A code shows in this session in a few seconds: enter it on the Agents page in Slirc, or open the link shown with it.`);
      io.out(`If no code shows${changed && harness.reloadHint ? ` after ${harness.reloadHint}` : ""}, type ${typed}. Tell the owner these lines as they are.`);
      return 0;
    }
    io.out(changed ? `Slirc is set up. In this ${harness.name} session, type ${harness.reloadHint ? `${harness.reloadHint}, then ` : ""}${typed}, and open the link it shows.` : `Slirc is set up. In this ${harness.name} session, type ${typed} and open the link it shows.`);
    io.out(`Tell the owner to type those themselves: connecting can't be done for them.`);
    return 0;
  }
  io.out(`Starting ${harness.name}. Open the link it shows, then press Allow in Slirc.`);
  io.out(`Later sessions: type ${typed} in ${harness.name}${harness.perFolder ? " sessions started in this folder" : ""}.`);
  const launched = harness.launch(host, command.ticket ? { ...env, SLIRC_CONNECT_TICKET: command.ticket } : env, command.extra);
  if (command.ticket)
    process.title = "slirc-agent";
  return launch(launched);
}
function start(launch) {
  return new Promise((done) => {
    const child = spawn2(launch.bin, launch.args, { env: launch.env, stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`Couldn't start ${launch.bin}: ${error.message}`);
      done(1);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}
function manage(command, env, io) {
  const list = chosen(command.harness, command.unreleased);
  const { found } = installedAmong(list, env);
  if (!found.length) {
    if (command.name === "uninstall") {
      io.out("Nothing to remove: no agent Slirc works with is installed here.");
      return 0;
    }
    throw missing(list);
  }
  for (const harness of found) {
    if (command.name === "install") {
      setUp(harness, env, io, command.dryRun);
      continue;
    }
    const steps = harness.uninstall(env);
    if (!steps.length) {
      io.out(`${harness.name}: no Slirc extension to remove.`);
      continue;
    }
    io.out(`${harness.name}: removing the Slirc extension.`);
    for (const step of steps) {
      io.out(`  ${step.doing}`);
      if (!command.dryRun)
        step.apply();
    }
  }
  if (command.name === "install" && !command.dryRun) {
    const last = readLastWorkspace(env);
    io.out(`Connect a session with ${found.map((harness) => commandFor(harness, env, last ? workspaceArg(last) : "<workspace>")).join(" or ")}.`);
  }
  return 0;
}
function status(unreleased, env, io) {
  io.out(`slirc-agent ${VERSION}`);
  const last = readLastWorkspace(env);
  io.out(`Workspace: ${last ?? "none yet (run slirc-agent <workspace>)"}`);
  for (const harness of offered(unreleased)) {
    const detected = harness.detect(env);
    if (!detected.installed) {
      io.out(`${harness.name}: not installed (${harness.homepage})`);
      continue;
    }
    const adapter = harness.status(env, VERSION);
    const text = { missing: "no Slirc extension (run slirc-agent install)", current: `Slirc extension ${adapter.version ?? VERSION}`, outdated: `Slirc extension ${adapter.version ?? "unknown"}, ${VERSION} available (run slirc-agent install)`, conflict: adapter.detail ?? "conflict" }[adapter.state];
    io.out(`${harness.name}${detected.version ? ` ${detected.version}` : ""}: ${text}`);
  }
  return 0;
}
async function run4(argv, env = process.env, io = defaultIo, launch = start) {
  if (LEGACY.includes(argv[0])) {
    await runLegacy(argv);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }
  try {
    const command = parseArgs(argv);
    if (command.name === "help") {
      io.out(command.topic === "legacy" ? legacyUsage : helpFor(command.topic));
      return 0;
    }
    if (command.name === "version") {
      io.out(VERSION);
      return 0;
    }
    if (command.name === "status")
      return status(command.unreleased, env, io);
    if (command.name === "install" || command.name === "uninstall")
      return manage(command, env, io);
    return await connect(command, env, io, launch);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return error instanceof CliError2 ? error.exitCode : 1;
  }
}

// src/bin.ts
process.exitCode = await run4(process.argv.slice(2));
