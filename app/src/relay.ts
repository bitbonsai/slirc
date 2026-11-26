import { isIP } from "node:net";
import type { SlircMode } from "./config.ts";
import { sanitizeLine } from "./irc.ts";

// Authenticated IRC relay: the PWA opens a WebSocket to the app at /irc (its own session cookie,
// no separate port), the app checks the session and Origin before ever touching Ergo, opens a raw
// TCP connection to Ergo, sends WEBIRC carrying the browser's real IP, and rewrites the client's
// placeholder SASL response to the real credentials for that session's account. Line content is
// never logged; only connect/disconnect/reject events may be, and only with nick, never text.
//
// Revoking a session (server.ts's `DELETE FROM sessions` call sites) closes the matching sockets
// in-process via closeSessionSockets, instead of the browser finding out on its next request.

export type RelaySocketData = {
  guest?: boolean;
  tokenHash: string;
  nick: string;
  ip: string;
  tcp?: Promise<{ write: (data: string) => void; end: () => void }>;
  // True right after the client sends bare `AUTHENTICATE PLAIN`: the next AUTHENTICATE line from
  // the client is a placeholder the relay must replace before it reaches Ergo.
  awaitingAuthenticate: boolean;
};

type MinimalSocket = { close: (code?: number, reason?: string) => void; data: RelaySocketData };

const socketsByToken = new Map<string, Set<MinimalSocket>>();

export function trackSocket(tokenHash: string, ws: MinimalSocket): void {
  let set = socketsByToken.get(tokenHash);
  if (!set) { set = new Set(); socketsByToken.set(tokenHash, set); }
  set.add(ws);
}

export function untrackSocket(tokenHash: string, ws: MinimalSocket): void {
  const set = socketsByToken.get(tokenHash);
  if (!set) return;
  set.delete(ws);
  if (!set.size) socketsByToken.delete(tokenHash);
}

// Called from every `DELETE FROM sessions` site in server.ts so a revoked session drops its
// live sockets immediately instead of the client learning about it on its next request.
export function closeSessionSockets(tokenHash: string): void {
  const set = socketsByToken.get(tokenHash);
  if (!set) return;
  for (const ws of set) { try { ws.close(1000, "session revoked"); } catch {} }
  socketsByToken.delete(tokenHash);
}

export function openSocketCount(): number {
  let count = 0;
  for (const set of socketsByToken.values()) count += set.size;
  return count;
}

export function originAllowed(origin: string | null | undefined, expected: string): boolean {
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(expected).origin; } catch { return false; }
}

// Caddy/the LAN proxy sets X-Forwarded-For; a direct connection falls back to the socket address.
// The header is client-supplied (a raw WebSocket handshake can set anything), and this value is
// spliced verbatim into the WEBIRC line sent to Ergo, so it must parse as a bare IP literal
// before we trust it. Anything else (a spoofed address, or a value with a space that would inject
// extra WEBIRC params) falls back to the real peer address instead.
export function clientIp(headers: Headers, fallback: string): string {
  // Caddy appends the peer address it saw as the LAST entry; anything before it came from the
  // client and is spoofable. Take the last hop, and only if it is a bare IP.
  const forwarded = headers.get("X-Forwarded-For")?.split(",").at(-1)?.trim();
  if (forwarded && isIP(forwarded)) return forwarded;
  return fallback || "127.0.0.1";
}

// Same shape the dev relay's direct-connect path would use if it spoke WEBIRC.
export function webircLine(pass: string, clientHost: string, clientIp: string): string {
  return `WEBIRC ${pass} slirc ${clientHost} ${clientIp}`;
}

// The client only ever sends two AUTHENTICATE lines: the bare `AUTHENTICATE PLAIN` request, then
// its response. This flags the response line so the caller knows to swap it.
export function marksAuthenticateRequest(line: string): boolean {
  return /^AUTHENTICATE\s+PLAIN\s*$/i.test(line);
}

export function isAuthenticateResponse(line: string): boolean {
  return /^AUTHENTICATE\s+\S+/i.test(line) && !marksAuthenticateRequest(line);
}

export function encodeSaslPlain(account: string, password: string): string {
  return Buffer.from(`\0${account}\0${password}`, "utf8").toString("base64");
}

// Rewrites the client's placeholder AUTHENTICATE response (its account is real, the trailing
// secret is not) to the real SASL PLAIN payload for that session's account. Returns the line
// unchanged if it isn't the response the relay is waiting for.
export function rewriteAuthenticateLine(line: string, data: RelaySocketData, passwordFor: (nick: string) => string | null | undefined): string {
  if (marksAuthenticateRequest(line)) { data.awaitingAuthenticate = true; return line; }
  if (!data.awaitingAuthenticate || !isAuthenticateResponse(line)) return line;
  data.awaitingAuthenticate = false;
  const password = passwordFor(data.nick);
  if (!password) return line;
  return `AUTHENTICATE ${encodeSaslPlain(data.nick, password)}`;
}

export type RelayDeps = {
  // Resolves a session cookie/bearer token to the account it belongs to, or null if invalid.
  sessionByToken: (token: string) => { nick: string; tokenHash: string } | null;
  ircPasswordFor: (nick: string) => string | null | undefined;
  appOrigin: string;
  // Cross-origin clients (e.g. multi-instance starred rooms) may upgrade only with an explicit
  // bearer/query/subprotocol token, never with a browser cookie.
  isAllowedClientOrigin?: (origin: string | null | undefined) => boolean;
  ergoHost: string;
  ergoPort: number;
  webircPass?: string;
  // A private workspace refuses an unauthenticated upgrade outright; the public playground still
  // admits guests (public #open-chat/#help).
  mode: SlircMode;
  // Sees each complete line forwarded to a signed-in browser (never logged here); used for the reply-thread index.
  onLine?: (line: string) => void;
  connectSocket?: (host: string, port: number, onData: (chunk: Buffer) => void, onEnd: () => void) => Promise<{ write: (data: string) => void; end: () => void }>;
};

const WS_TOKEN_PROTOCOL_PREFIX = "slirc-token.";

function nonCookieTokenFromRequest(req: Request): { token: string; protocol?: string } | null {
  const bearer = req.headers.get("Authorization")?.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i)?.[1];
  if (bearer) return { token: bearer };
  const protocols = req.headers.get("Sec-WebSocket-Protocol");
  if (protocols) {
    for (const part of protocols.split(",")) {
      const trimmed = part.trim();
      if (trimmed.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) {
        const candidate = trimmed.slice(WS_TOKEN_PROTOCOL_PREFIX.length);
        if (candidate && /^[A-Za-z0-9_-]+$/.test(candidate)) return { token: candidate, protocol: trimmed };
      }
    }
  }
  return null;
}

function tokenFromRequest(req: Request, allowCookie: boolean): { token: string; protocol?: string } | null {
  if (allowCookie) {
    const cookie = req.headers.get("Cookie")?.match(/(?:^|; )slirc_session=([^;]+)/)?.[1];
    if (cookie) return { token: cookie };
  }
  return nonCookieTokenFromRequest(req);
}

// Called from the app's Bun.serve `fetch`. Returns a rejection Response for a bad request, or
// undefined once server.upgrade() has taken over the connection (its own return contract).
export function handleRelayUpgrade(req: Request, path: string, upgrade: (req: Request, options: { data: RelaySocketData; headers?: Record<string, string> }) => boolean, deps: RelayDeps, fallbackIp: string): Response | undefined {
  if (new URL(req.url).pathname !== path) return undefined;
  const origin = req.headers.get("Origin");
  const sameOrigin = originAllowed(origin, deps.appOrigin);
  const allowedCrossOrigin = !sameOrigin && (deps.isAllowedClientOrigin?.(origin) ?? false);
  if (!sameOrigin && !allowedCrossOrigin) {
    // Rejections are logged (never line content) so a client stuck reconnecting is diagnosable.
    console.warn(`relay: rejected bad origin ${origin} (expected ${deps.appOrigin})`);
    return new Response("bad origin", { status: 403 });
  }
  // Cross-origin upgrades never trust cookies (CSWSH protection); they require a bearer/subprotocol token.
  const extracted = tokenFromRequest(req, sameOrigin);
  const token = extracted?.token ?? null;
  const ip = clientIp(req.headers, fallbackIp);
  const session = token ? deps.sessionByToken(token) : null;
  // Cross-origin upgrades must present a valid client token; never fall through to guest.
  if (allowedCrossOrigin && !session) {
    console.warn(token ? "relay: rejected invalid cross-origin token" : "relay: rejected unauthenticated cross-origin upgrade");
    return new Response("authentication required", { status: 401 });
  }
  // A private workspace has no guest path: no token, an unknown token, and a stale cookie all fail
  // here, before any Ergo connection is opened.
  if (!session && deps.mode === "private_workspace") {
    console.warn(token ? "relay: rejected stale session token" : "relay: rejected unauthenticated upgrade");
    return new Response("authentication required", { status: 401 });
  }
  // In the public playground, no session or a stale cookie left from an expired one is a guest
  // (public #open-chat/#help visitors): a plain connection with no credential swap, the same
  // access a direct public IRC connection gives them. Refusing the stale-cookie case left the
  // guest view reconnecting behind a spinner.
  if (!session) {
    if (token) console.warn("relay: stale session token, connecting as guest");
    const ok = upgrade(req, { data: { tokenHash: "", nick: "", ip, awaitingAuthenticate: false, guest: true } });
    return ok ? undefined : new Response("upgrade failed", { status: 400 });
  }
  const data: RelaySocketData = { tokenHash: session.tokenHash, nick: session.nick, ip, awaitingAuthenticate: false };
  const options: { data: RelaySocketData; headers?: Record<string, string> } = { data };
  if (extracted?.protocol) options.headers = { "Sec-WebSocket-Protocol": extracted.protocol };
  const ok = upgrade(req, options);
  return ok ? undefined : new Response("upgrade failed", { status: 400 });
}

async function defaultConnect(host: string, port: number, onData: (chunk: Buffer) => void, onEnd: () => void) {
  const sock = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_sock, chunk) { onData(Buffer.from(chunk)); },
      close() { onEnd(); },
      error() { onEnd(); },
    },
  });
  return { write: (line: string) => { try { sock.write(line); } catch {} }, end: () => { try { sock.end(); } catch {} } };
}

export function relayWebsocketHandlers(deps: RelayDeps) {
  const connect = deps.connectSocket || defaultConnect;
  return {
    open(ws: MinimalSocket & { send: (data: string) => void }) {
      if (!ws.data.guest) trackSocket(ws.data.tokenHash, ws);
      // Ergo's TCP stream is chunked at arbitrary byte boundaries, not line boundaries: a single
      // IRC line (especially with message-tags, or mid-CHATHISTORY-replay) can arrive split
      // across two `data` callbacks. Buffer here and forward only complete lines, holding the
      // trailing partial line for the next chunk, so the browser never sees a fragment. A
      // per-connection streaming decoder keeps a UTF-8 character split across reads intact.
      const decoder = new TextDecoder("utf-8");
      let pending = "";
      ws.data.tcp = connect(
        deps.ergoHost,
        deps.ergoPort,
        (chunk) => {
          pending += decoder.decode(chunk, { stream: true });
          // A CR at the very end may be the first half of a CRLF; hold it for the next read,
          // otherwise a CRLF split across reads emits a spurious empty line.
          const holdsCr = pending.endsWith("\r");
          const complete = holdsCr ? pending.slice(0, -1) : pending;
          const lines = complete.split(/\r\n|\r|\n/);
          pending = (lines.pop() ?? "") + (holdsCr ? "\r" : "");
          for (const line of lines) {
            try { ws.send(line + "\r\n"); } catch {}
            if (!ws.data.guest) { try { deps.onLine?.(line); } catch {} }
          }
        },
        () => { try { ws.close(); } catch {} },
      ).then((sock) => {
        if (deps.webircPass) sock.write(sanitizeLine(webircLine(deps.webircPass, ws.data.ip, ws.data.ip)) + "\r\n");
        return sock;
      }).catch((err) => {
        // Ergo unreachable (restart, DNS blip): close the browser socket right away instead of
        // leaving it open-but-dead until the client's 30s/60s keepalive notices.
        try { ws.close(1011, "ergo unreachable"); } catch {}
        throw err;
      });
    },
    message(ws: MinimalSocket, raw: string | Buffer) {
      const tcp = ws.data.tcp;
      if (!tcp) return;
      const all = String(raw).split(/\r?\n/).map(sanitizeLine).filter(Boolean);
      // A guest never gets credentials swapped in. A SASL attempt means a signed-in tab whose
      // session is gone: answer it as a failed login so the app shows that instead of waiting.
      if (ws.data.guest && all.some((line) => /^AUTHENTICATE\b/i.test(line))) {
        try { (ws as MinimalSocket & { send: (data: string) => void }).send(":slirc 904 * :SASL authentication failed\r\n"); } catch {}
      }
      const lines = ws.data.guest ? all.filter((line) => !/^AUTHENTICATE\b/i.test(line)) : all.map((line) => rewriteAuthenticateLine(line, ws.data, deps.ircPasswordFor));
      tcp.then((sock) => { for (const line of lines) sock.write(sanitizeLine(line) + "\r\n"); }).catch(() => {});
    },
    close(ws: MinimalSocket) {
      if (!ws.data.guest) untrackSocket(ws.data.tokenHash, ws);
      ws.data.tcp?.then((sock) => sock.end()).catch(() => {});
    },
  };
}
