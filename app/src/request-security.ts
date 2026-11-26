import { isIP } from "node:net";
import { getConnInfo } from "hono/bun";

// Request-boundary helpers: the configured app origin, stored thread-link validation, and the
// peer-address + in-memory rate limiters used by the sign-in routes. Kept out of server.ts so the
// rules can be exercised without booting the whole app.

// The one origin thread links may point at. Deliberately reads configuration, never the request
// Host header: Host is attacker-controlled, and a stored link validated against it could be
// poisoned onto a foreign origin. Same fallback chain as rooms.ts's invite URLs.
export function configuredAppOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.APP_ORIGIN?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Malformed APP_ORIGIN falls through to APP_HOST rather than trusting anything from the request.
    }
  }
  const host = env.APP_HOST?.trim();
  if (host) {
    try {
      return new URL(`https://${host}`).origin;
    } catch {
      // Malformed APP_HOST fails below.
    }
  }
  throw new Error("APP_ORIGIN or APP_HOST required");
}

const CONTROL = /[\u0000-\u001f\u007f]/;
// Browsers normalize a backslash to "/", so "/\evil.example" would become "//evil.example".
const BACKSLASH = /\\/;

// Keeps a stored thread link only when it is an origin-relative route or an absolute URL on the
// configured app origin. Rejects script/data schemes, credentials, protocol-relative paths,
// lookalike hosts, control characters, and backslashes. A legacy row is filtered when it is read
// (in /auth/me and the thread list) instead of being rewritten, so a bad old value never comes
// back out of an API response and no data is destroyed.
export function threadUrl(raw: unknown, origin = configuredAppOrigin()): string {
  if (typeof raw !== "string") return "";
  const value = raw.slice(0, 600);
  if (!value || CONTROL.test(value) || BACKSLASH.test(value)) return "";
  try {
    const url = new URL(value);
    if (url.username || url.password) return "";
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin === origin ? url.href : "";
  } catch {
    // Not an absolute URL; only a single-slash origin-relative route is acceptable below.
  }
  if (!value.startsWith("/") || value.startsWith("//")) return "";
  try {
    return new URL(value, origin).origin === origin ? value : "";
  } catch {
    return "";
  }
}

// Comma-separated exact peer addresses whose forwarded headers may be believed. Exact match only:
// a CIDR range would trust every address sharing a prefix. Unset (the default) trusts nothing,
// which is the safe posture for an app reachable without a proxy.
export function trustedProxies(value = process.env.SLIRC_TRUSTED_PROXIES): Set<string> {
  const set = new Set<string>();
  for (const entry of (value || "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed) set.add(trimmed);
  }
  return set;
}

type ConnContext = { env?: unknown; req: { header: (name: string) => string | undefined } };

// The socket address Bun reports, through Hono's adapter. `app.request` in tests has no socket and
// the adapter throws; that is "no peer", not an error.
function socketAddress(c: ConnContext): string | null {
  try {
    const remote = getConnInfo(c as Parameters<typeof getConnInfo>[0]).remote;
    return remote.address && remote.address.trim() ? remote.address.trim() : null;
  } catch {
    return null;
  }
}

// Rate-limit identity. An untrusted peer cannot influence it: unless the peer address is in the
// configured trusted set, forwarded headers are ignored entirely. A trusted peer contributes only
// the last syntactically valid X-Forwarded-For hop (the proxy appends the address it saw last), so
// an attacker-writable prefix cannot split the budget. No socket at all means one shared local
// bucket, which keeps `app.request` tests deterministic.
export function peerKey(c: ConnContext, trusted = trustedProxies()): string {
  // Bun reports IPv4 peers on a dual-stack listener as ::ffff:a.b.c.d, which never equals the
  // plain address in SLIRC_TRUSTED_PROXIES, so fold the mapped form before comparing.
  const raw = socketAddress(c);
  const peer = raw?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1") ?? null;
  if (!peer) return "local";
  if (!trusted.has(peer)) return addressBucket(peer);
  const last = c.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim();
  return addressBucket(last && isIP(last) ? last : peer);
}

// One IPv6 subscriber usually holds a whole /64, so rotating through it must not buy fresh budgets.
// IPv4 (and IPv4-mapped IPv6) stays per address.
export function addressBucket(address: string): string {
  if (isIP(address) !== 6) return address;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1]!;
  const [head = "", tail = ""] = address.toLowerCase().split("%", 1)[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export interface LimiterOptions {
  limit: number;
  windowMs?: number;
  // Hard cap on distinct keys. At the cap the oldest key is dropped to make room, so memory stays
  // bounded and a flood of rotating keys cannot lock every other visitor out.
  maxKeys?: number;
}

export interface Limiter {
  // true = allowed and this attempt was recorded; false = at/over the limit.
  check(key: string, now?: number): boolean;
  sweep(now?: number): void;
  reset(): void;
  size(): number;
}

const limiters = new Set<Limiter>();

export function createLimiter({ limit, windowMs = 60 * 60_000, maxKeys = 4096 }: LimiterOptions): Limiter {
  const buckets = new Map<string, number[]>();
  const prune = (key: string, now: number): number[] | undefined => {
    const times = buckets.get(key);
    if (!times) return undefined;
    const live = times.filter((time) => time > now - windowMs);
    if (live.length) {
      buckets.set(key, live);
      return live;
    }
    buckets.delete(key);
    return undefined;
  };
  const limiter: Limiter = {
    check(key, now = Date.now()) {
      const existing = prune(key, now);
      if (existing && existing.length >= limit) return false;
      if (!existing && buckets.size >= maxKeys) {
        // Reclaim expired keys first; if the map is still full, evict the oldest (Map keeps insertion order).
        limiter.sweep(now);
        while (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value!);
      }
      const times = existing ?? [];
      times.push(now);
      buckets.set(key, times);
      return true;
    },
    sweep(now = Date.now()) {
      for (const key of [...buckets.keys()]) prune(key, now);
    },
    reset() {
      buckets.clear();
    },
    size() {
      return buckets.size;
    },
  };
  limiters.add(limiter);
  return limiter;
}

// Test seam: module-level limiters otherwise keep running totals across the tests in one file.
export function resetRateLimits(): void {
  for (const limiter of limiters) limiter.reset();
}

// Origins allowed to connect cross-origin with a bearer token (never cookies).
// Accepts https://app.slirc.org, https://*.slirc.app (single subdomain label), any valid
// http(s) origin listed in SLIRC_ALLOWED_CLIENT_ORIGINS, and http://localhost:* in dev.
export function allowedClientOrigins(value = process.env.SLIRC_ALLOWED_CLIENT_ORIGINS): Set<string> {
  const set = new Set<string>();
  for (const entry of (value || "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.origin === trimmed) {
        set.add(url.origin);
      }
    } catch {
      // Ignore malformed configured entries rather than failing open.
    }
  }
  return set;
}

const SLIRC_APP_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.slirc\.app$/i;

export function isAllowedClientOrigin(
  origin: string | null | undefined,
  options: { env?: NodeJS.ProcessEnv; dev?: boolean } = {},
): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.username || url.password) return false;
  if (url.protocol === "https:" && !url.port) {
    const host = url.hostname.toLowerCase();
    if (host === "app.slirc.org" || SLIRC_APP_SUBDOMAIN.test(host)) return true;
  }
  const env = options.env ?? process.env;
  if (allowedClientOrigins(env.SLIRC_ALLOWED_CLIENT_ORIGINS).has(url.origin)) return true;
  const isDev = options.dev ?? (env.NODE_ENV === "development" || env.SLIRC_DEV_PROFILE === "slirc2" || env.MAGIC_LINK_LOG === "true");
  if (isDev && url.protocol === "http:" && url.hostname.toLowerCase() === "localhost") return true;
  return false;
}
