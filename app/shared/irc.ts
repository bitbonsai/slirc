import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

// Minimal IRC client (Bun TCP). Reused by create-accounts + slirc-bot.
export interface IrcOptions {
  host: string;
  port: number;
  nick: string;
  user?: string;
  realname?: string;
  saslUser?: string;
  saslPass?: string;
  capabilities?: string[];
  tls?: boolean;
  // Dev only: accept a self-signed certificate (local Ergo on 6697). Never set in production paths.
  tlsInsecure?: boolean;
  onMessage?: (m: ParsedMessage) => void;
  onClose?: () => void;
  onWelcome?: () => void;
}

export interface ParsedMessage {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

// IRCv3 message-tag value escapes: \: ; \s space \\ backslash \r \n. A trailing lone backslash is dropped.
function unescapeTag(value: string): string {
  return value.replace(/\\(.?)/g, (_m, ch: string) => ({ ":": ";", s: " ", "\\": "\\", r: "\r", n: "\n" } as Record<string, string>)[ch] ?? ch);
}

// One IRC message per socket write. A CR, LF, or NUL in an interpolated field (topic, kick reason,
// nickname, upload path) would otherwise end the line and start a second command on the oper
// connection. Fold line breaks to a space and drop NUL; do not trim, since a PRIVMSG body may
// legitimately end in spaces. Real control bytes are never valid IRC text: escaped tag values
// spell them as the two-character sequences \r and \n, which this leaves alone.
export function sanitizeLine(line: string): string {
  return line.replace(/[\r\n]+/g, " ").replace(/\0/g, "");
}

export function parseLine(line: string): ParsedMessage {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    rest = rest.slice(sp + 1);
    for (const t of line.slice(1, sp).split(";")) {
      const i = t.indexOf("=");
      if (i === -1) tags[t] = "";
      else tags[t.slice(0, i)] = unescapeTag(t.slice(i + 1));
    }
  }
  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const trailing = rest.indexOf(" :");
  let command: string, params: string[];
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

export class IrcClient {
  readonly nick: string;
  readonly enabledCapabilities = new Set<string>();
  private sock: any;
  private closed = false;
  // Per-connection decoder: a UTF-8 character split across two reads must not become U+FFFD.
  private decoder = new TextDecoder("utf-8");
  private buf = "";
  private opts: IrcOptions;
  private waiters: { pred: (m: ParsedMessage) => boolean; resolve: () => void }[] = [];

  constructor(opts: IrcOptions) {
    this.opts = opts;
    this.nick = opts.nick;
  }

  async connect(timeoutMs?: number): Promise<void> {
    const o = this.opts;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { this.disconnect(); reject(error); };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => fail(new Error("IRC connection timed out")), Math.max(0, timeoutMs));
      }
      const close = () => {
        this.closed = true;
        this.waiters = [];
        reject(new Error("IRC connection closed"));
        this.opts.onClose?.();
      };
      // Node's socket exists before TCP/TLS completes, so a deadline can cancel it.
      // Bun.connect only exposes its socket after connection establishment.
      if (typeof Bun === "undefined" || timeoutMs !== undefined) {
        const socket = o.tls
          ? tlsConnect({ host: o.host, port: o.port, servername: o.host, rejectUnauthorized: !o.tlsInsecure })
          : netConnect({ host: o.host, port: o.port });
        this.sock = socket;
        socket.once(o.tls ? "secureConnect" : "connect", () => {
          if (this.closed) { socket.destroy(); return; }
          this.send("CAP LS 302");
          this.send(`NICK ${o.nick}`);
          this.send(`USER ${o.user || o.nick} 0 * :${o.realname || o.nick}`);
          (async () => {
            try {
              const welcome = this.waitFor((m) => m.command === "001");
              if (o.saslUser && o.saslPass) await this.sasl(o.saslUser, o.saslPass, o.capabilities);
              else await this.requestCapabilities(o.capabilities);
              await welcome;
              resolve();
            } catch (e) {
              fail(e as Error);
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
        tls: o.tls ? (o.tlsInsecure ? { rejectUnauthorized: false } : true) : false,
        socket: {
          open: (s: any) => {
            // A TCP/TLS connection can finish after the caller's deadline.
            if (this.closed) { s.terminate(); return; }
            this.sock = s;
            this.send("CAP LS 302");
            this.send(`NICK ${o.nick}`);
            this.send(`USER ${o.user || o.nick} 0 * :${o.realname || o.nick}`);
            (async () => {
              try {
                const welcome = this.waitFor((m) => m.command === "001");
                if (o.saslUser && o.saslPass) await this.sasl(o.saslUser, o.saslPass, o.capabilities);
                else await this.requestCapabilities(o.capabilities);
                await welcome;
                resolve();
              } catch (e) {
                fail(e as Error);
              }
            })();
          },
          data: (_s: any, d: Buffer) => this.onData(d),
          close,
          error: (_s: any, err: Error) => fail(err),
        },
      }).catch(fail);
    }).finally(() => clearTimeout(timer));
  }

  // True when the line went to a live socket; false once the connection has closed or the line was empty.
  send(line: string): boolean {
    if (!this.sock || this.closed) return false;
    const clean = sanitizeLine(line);
    // Nothing but whitespace is not a command; sending it would only draw an error.
    if (!clean.trim()) return false;
    this.sock.write(clean + "\r\n");
    return true;
  }

  quit() {
    try {
      this.send("QUIT :bye");
      this.sock?.end();
    } catch {}
  }

  // Deadlines must close the socket even when the peer never completes its handshake.
  disconnect() {
    this.closed = true;
    this.waiters = [];
    if (this.sock?.terminate) this.sock.terminate();
    else this.sock?.destroy();
  }

  // Optional capabilities on a connection that does not authenticate. Ergo only includes the
  // `account` and `msgid` tags on messages when the client negotiated account-tag / message-tags.
  private async requestCapabilities(capabilities?: string[]) {
    const offered = new Set<string>();
    await this.waitFor((m) => {
      if (m.command !== "CAP" || m.params[1] !== "LS") return false;
      for (const capability of (m.params.at(-1) || "").split(" ")) offered.add(capability.split("=", 1)[0]);
      return m.params[2] !== "*";
    });
    const requested = (capabilities || []).filter((capability) => offered.has(capability));
    if (requested.length) {
      this.send(`CAP REQ :${requested.join(" ")}`);
      let acknowledged = false;
      await this.waitFor((m) => {
        if (m.command !== "CAP" || !["ACK", "NAK"].includes(m.params[1])) return false;
        acknowledged = m.params[1] === "ACK";
        return true;
      });
      if (acknowledged) for (const capability of requested) this.enabledCapabilities.add(capability);
    }
    this.send("CAP END");
  }

  private async sasl(user: string, pass: string, capabilities?: string[]) {
    if (capabilities) {
      const offered = new Set<string>();
      await this.waitFor((m) => {
        if (m.command !== "CAP" || m.params[1] !== "LS") return false;
        for (const capability of (m.params.at(-1) || "").split(" ")) offered.add(capability.split("=", 1)[0]);
        return m.params[2] !== "*";
      });
      const requested = ["sasl", ...capabilities];
      const missing = requested.filter((capability) => !offered.has(capability));
      if (missing.length) throw new Error(`IRC server lacks required capabilities: ${missing.join(", ")}`);
      this.send(`CAP REQ :${requested.join(" ")}`);
      let acknowledged = false;
      await this.waitFor((m) => {
        if (m.command !== "CAP" || !["ACK", "NAK"].includes(m.params[1])) return false;
        acknowledged = m.params[1] === "ACK";
        return true;
      });
      if (!acknowledged) throw new Error("IRC server rejected required capabilities");
      for (const capability of requested) this.enabledCapabilities.add(capability);
    } else {
      await this.waitFor((m) => m.command === "CAP" && m.params[1] === "LS");
      this.send("CAP REQ :sasl");
      await this.waitFor((m) => m.command === "CAP" && m.params[1] === "ACK");
      this.enabledCapabilities.add("sasl");
    }
    this.send("AUTHENTICATE PLAIN");
    await this.waitFor((m) => m.command === "AUTHENTICATE");
    this.send("AUTHENTICATE " + Buffer.from(`\0${user}\0${pass}`).toString("base64"));
    // 904-907 are SASL failures. Without this the promise never settles and the caller hangs forever.
    let failure = "";
    await this.waitFor((m) => {
      if (m.command === "903") return true;
      if (["904", "905", "906", "907"].includes(m.command)) { failure = m.params.at(-1) || m.command; return true; }
      return false;
    });
    if (failure) throw new Error(`SASL login failed for ${user}: ${failure}`);
    this.send("CAP END");
  }

  private onData(data: Buffer) {
    if (this.closed) return;
    this.buf += this.decoder.decode(data, { stream: true });
    let i: number;
    while ((i = this.buf.indexOf("\r\n")) !== -1) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const m = parseLine(line);
      if (m.command === "PING") this.send(`PONG :${m.params.at(-1) || ""}`);
      for (let w = this.waiters.length - 1; w >= 0; w--) {
        if (this.waiters[w].pred(m)) {
          this.waiters[w].resolve();
          this.waiters.splice(w, 1);
        }
      }
      this.opts.onMessage?.(m);
    }
  }

  waitFor(pred: (m: ParsedMessage) => boolean): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ pred, resolve });
    });
  }
}
