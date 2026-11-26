import { accountByNick, markVerified } from "../accounts.ts";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../db.ts";
import { closeSessionSockets } from "../relay.ts";
import { enqueueWelcomeJob } from "../founder-welcome.ts";
import { setCookie } from "hono/cookie";
import { localDevLinks } from "../config.ts";
import { configuredAppOrigin } from "../request-security.ts";

// Browsers cap persistent cookies at 400 days. Refresh this on every PWA load.
const sessionMaxAge = 60 * 60 * 24 * 400;

const devNick = process.env.DEV_IRC_NICK;

export const devUser = devNick ? accountByNick(devNick) : null;

export const sessionCookie = {
  httpOnly: true,
  // Browsers drop Secure cookies on plain-http LAN origins; production APP_ORIGIN is https.
  secure: !(process.env.APP_ORIGIN || "https://").startsWith("http://"),
  sameSite: "Lax" as const,
  path: "/",
  maxAge: sessionMaxAge,
};

// Same shape as slirc_session, minus httpOnly, so script can read it. It never holds a secret,
// only the account nick. The old boot document used it to check a disk cache belonged to the
// signed-in account; no client code reads it now.
export const acctCookie = { ...sessionCookie, httpOnly: false };

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sessionByCookieToken(token: string) {
  const tokenHash = hash(token);
  const row = db.query("SELECT nick FROM sessions WHERE token_hash = ?").get(tokenHash) as { nick: string } | null;
  return row ? { nick: row.nick, token, tokenHash, kind: "cookie" as const } : undefined;
}

export const CLIENT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_CLIENT_TOKENS_PER_SESSION = 10;

function sessionByClientToken(token: string) {
  const tokenHash = hash(token);
  const row = db.query(
    "SELECT ct.nick, ct.session_hash FROM client_tokens ct JOIN sessions s ON s.token_hash = ct.session_hash WHERE ct.token_hash = ? AND (ct.expires_at IS NULL OR ct.expires_at > ?)",
  ).get(tokenHash, Date.now()) as { nick: string; session_hash: string } | null;
  return row ? { nick: row.nick, token, tokenHash, sessionHash: row.session_hash, kind: "bearer" as const } : undefined;
}

export function sessionByToken(token: string) {
  return sessionByCookieToken(token) ?? sessionByClientToken(token) ?? null;
}

export function cookieSession(c: { req: { header: (name: string) => string | undefined } }) {
  const cookie = c.req.header("Cookie")?.match(/(?:^|; )(?:slirc_session|untitled_session)=([^;]+)/)?.[1];
  return cookie ? sessionByCookieToken(cookie) : undefined;
}

export function clientBearerToken(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  return c.req.header("Authorization")?.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i)?.[1];
}

// Regular /api/* and /auth/* routes accept session cookies only. Bearer client tokens are
// restricted to GET /auth/me, POST /auth/logout, and /irc WebSocket upgrades.
export function session(c: { req: { header: (name: string) => string | undefined } }) {
  return cookieSession(c);
}

export function sessionOrBearer(c: { req: { header: (name: string) => string | undefined } }) {
  const fromCookie = cookieSession(c);
  if (fromCookie) return fromCookie;
  const bearer = clientBearerToken(c);
  return bearer ? sessionByClientToken(bearer) : undefined;
}

export function closeClientTokensForSession(sessionHash: string) {
  const rows = db.query("SELECT token_hash FROM client_tokens WHERE session_hash = ?").all(sessionHash) as { token_hash: string }[];
  for (const row of rows) closeSessionSockets(row.token_hash);
  db.query("DELETE FROM client_tokens WHERE session_hash = ?").run(sessionHash);
}

// Every DELETE FROM sessions site below calls this first so a revoked session's relay socket
// (relay.ts) closes in-process, instead of the browser only finding out on its next request.
function closeSessionsForNick(nick: string) {
  const rows = db.query("SELECT token_hash FROM sessions WHERE nick = ?").all(nick) as { token_hash: string }[];
  for (const row of rows) closeSessionSockets(row.token_hash);
  const tokens = db.query("SELECT token_hash FROM client_tokens WHERE nick = ? COLLATE NOCASE").all(nick) as { token_hash: string }[];
  for (const row of tokens) closeSessionSockets(row.token_hash);
  db.query("DELETE FROM client_tokens WHERE nick = ? COLLATE NOCASE").run(nick);
}

// Ends one browser session of an account, revokes any client tokens it issued, and closes its relay sockets.
export function revokeSession(tokenHash: string, nick: string): boolean {
  const deleted = db.query("DELETE FROM sessions WHERE token_hash = ? AND nick = ? COLLATE NOCASE").run(tokenHash, nick).changes;
  if (deleted) {
    closeSessionSockets(tokenHash);
    closeClientTokensForSession(tokenHash);
  }
  return deleted > 0;
}

export function currentUser(c: { req: { header: (name: string) => string | undefined } }) {
  if (devUser) return devUser.nick;
  const row = session(c);
  if (!row || !accountByNick(row.nick)) return;
  return row.nick;
}

export function verifiedHuman(c: { req: { header: (name: string) => string | undefined } }) {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  return account?.kind === "human" && account.verifiedAt ? account : null;
}

// Routes that create an account and start a session refuse cross-site requests: same Origin, a JSON
// body, and a custom header a plain form or no-cors fetch cannot send.
export function sameOriginJson(c: any, header: string): boolean {
  try {
    const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.toLowerCase();
    const expectedOrigin = appOrigin(c.req.header("Host"));
    return !!c.req.header("Origin") && c.req.header("Origin") === expectedOrigin &&
      c.req.header(header) === "1" && contentType === "application/json";
  } catch { return false; }
}

export const admissionCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Admission");

export const invitationCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Invitation");

export const signInCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Sign-In");

export function userAgentDetails(userAgent = "") {
  const browser = /Edg\//.test(userAgent) ? "Edge"
    : /(?:Chrome|CriOS)\//.test(userAgent) ? "Chrome"
    : /(?:Firefox|FxiOS)\//.test(userAgent) ? "Firefox"
    : /Safari\//.test(userAgent) ? "Safari"
    : "Browser";
  const os = /(?:iPhone|iPad|iPod)/.test(userAgent) ? "iOS"
    : /Macintosh|Mac OS X/.test(userAgent) ? "macOS"
    : /Android/.test(userAgent) ? "Android"
    : /Windows/.test(userAgent) ? "Windows"
    : /Linux/.test(userAgent) ? "Linux"
    : "Unknown OS";
  return { browser, os, device: `${browser} · ${os}` };
}

// First proof of the mailbox: mark the account verified, queue its welcome, and drop any session
// started before verification.
export function completeFirstVerification(nick: string) {
  markVerified(nick);
  enqueueWelcomeJob(nick);
  closeSessionsForNick(nick);
  db.query("DELETE FROM sessions WHERE nick = ?").run(nick);
}

export function startSession(c: any, nick: string) {
  if (!accountByNick(nick)?.verifiedAt) { closeSessionsForNick(nick); db.query("DELETE FROM sessions WHERE nick = ?").run(nick); }
  const token = randomBytes(32).toString("base64url");
  const { device } = userAgentDetails(c.req.header("User-Agent"));
  db.query("INSERT INTO sessions (token_hash, nick, created_at, device) VALUES (?, ?, ?, ?)").run(hash(token), nick, Date.now(), device);
  setCookie(c, "slirc_session", token, sessionCookie);
  setCookie(c, "slirc_acct", nick, acctCookie);
  return hash(token);
}

export const devLinks = localDevLinks();

// Plain-HTTP LAN links follow the request host. HTTPS always uses the configured origin.
const linkOrigin = (host?: string | null) => (devLinks && (process.env.APP_ORIGIN || "").startsWith("http://") && host ? `http://${host}` : undefined);

export const appOrigin = (host?: string | null) => linkOrigin(host) || configuredAppOrigin();
