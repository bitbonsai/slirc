import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { isPrivateIp } from "./og.ts";

// Outbound fetches for link previews and proxied images. The non-public address check
// runs inside the socket's DNS lookup, so the address that is validated is the address
// the connection is opened to. A public-only preflight followed by a second lookup would
// not survive a rebinding answer; this does because there is only ever one lookup, at
// connect time. Redirects are followed by hand and every hop goes through the same guard.

export type Resolver = (hostname: string) => Promise<string[]>;

export const resolveAddresses: Resolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true }); // Bun returns one record without all:true
  return records.map(({ address }) => address);
};

// Node's http/https call this with the connection's own hostname; the returned address is
// used directly, so returning a validated address here is what binds the check to the socket.
export type LookupFunction = (
  hostname: string,
  options: { family?: number; all?: boolean },
  callback: (error: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void,
) => void;

export function createGuardedLookup(resolve: Resolver, allowed: (address: string, hostname: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    // Some runtimes still call the lookup for a bracketed IPv6 literal, and a URL parser
    // normalizes hex/octal IPv4 literals to dotted form. Validate the literal here rather
    // than resolving it, so the address judged is the address connected to.
    const literal = hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal)) {
      if (!allowed(literal, literal)) return callback(blocked());
      const family = isIP(literal);
      const records = [{ address: literal, family }];
      if (options?.all) return callback(null, records);
      return callback(null, literal, family);
    }
    resolve(hostname)
      .then((addresses) => {
        const family = typeof options === "number" ? options : options?.family || 0;
        // Validate the whole answer before family selection; unusable records cannot hide
        // beside a public candidate or in the other address family.
        if (!addresses.length || addresses.some((address) => !isIP(address) || !allowed(address, hostname))) return callback(blocked());
        const candidates = addresses.filter((address) => family === 0 || isIP(address) === family);
        if (!candidates.length) return callback(blocked());
        const records = candidates.map((address) => ({ address, family: isIP(address) }));
        if (options?.all) return callback(null, records);
        return callback(null, records[0].address, records[0].family);
      })
      .catch(callback);
  };
}

function blocked(): NodeJS.ErrnoException {
  return Object.assign(new Error("blocked"), { code: "EBLOCKED" });
}

function assertSafeUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw blocked();
  if (url.username || url.password) throw blocked();
}

export interface FetchPublicOptions {
  accept?: string;
  maxHops?: number;
  // Local development serves the stack on loopback/LAN addresses the guard blocks by
  // design. This turns the check off for that stack only; production never sets it.
  allowPrivate?: boolean;
  // Test seam. Defaults to the non-public classifier; the hostname is passed so a test can
  // allow the first hop and keep guarding later ones.
  addressAllowed?: (address: string, hostname: string) => boolean;
  resolve?: Resolver;
  timeoutMs?: number;
  userAgent?: string;
}

export class ResponseTooLarge extends Error {
  constructor() {
    super("too large");
    this.name = "ResponseTooLarge";
  }
}

// Reads at most `limit` bytes. `text` truncates at the limit; `bytes` reports an
// oversized body instead of buffering all of it before the caller can refuse it.
export class SafeResponse {
  constructor(
    private readonly message: IncomingMessage,
    readonly status: number,
    readonly finalUrl: URL,
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  header(name: string): string | null {
    const value = this.message.headers[name.toLowerCase()];
    return Array.isArray(value) ? value.join(", ") : value ?? null;
  }

  close(): void {
    this.message.destroy();
  }

  async text(limit: number): Promise<string> {
    return new TextDecoder().decode(await this.read(limit, true));
  }

  async bytes(limit: number): Promise<Uint8Array> {
    return this.read(limit, false);
  }

  private read(limit: number, truncate: boolean): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      this.message.on("data", (chunk: Uint8Array) => {
        if (settled) return;
        // Exactly `limit` bytes is allowed; one more is not.
        if (size + chunk.length > limit) {
          const room = limit - size;
          if (room > 0) chunks.push(chunk.subarray(0, room));
          this.message.destroy();
          if (truncate) finish(() => resolve(Buffer.concat(chunks)));
          else finish(() => reject(new ResponseTooLarge()));
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      this.message.on("end", () => finish(() => resolve(Buffer.concat(chunks))));
      this.message.on("error", (error) => finish(() => reject(error)));
    });
  }
}

export async function fetchPublic(url: URL, options: FetchPublicOptions = {}): Promise<SafeResponse> {
  const {
    accept = "text/html,application/xhtml+xml",
    maxHops = 4,
    allowPrivate = false,
    addressAllowed,
    resolve = resolveAddresses,
    timeoutMs = 8_000,
    userAgent = "Slirc/1.0",
  } = options;
  const allowed = addressAllowed ?? (allowPrivate ? () => true : (address: string) => !isPrivateIp(address));
  const lookup = createGuardedLookup(resolve, allowed);
  let target = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    assertSafeUrl(target);
    // Node connects to an IP literal without calling the lookup, so guard that form here.
    const literal = target.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && !allowed(literal, literal)) throw blocked();
    const response = await requestOnce(target, { lookup, accept, timeoutMs, userAgent });
    if (response.status >= 300 && response.status < 400) {
      const location = response.header("location");
      response.close();
      if (!location) throw blocked();
      try {
        target = new URL(location, target);
      } catch {
        throw blocked();
      }
      continue;
    }
    return response;
  }
  throw blocked();
}

function requestOnce(
  url: URL,
  options: { lookup: LookupFunction; accept: string; timeoutMs: number; userAgent: string },
): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        headers: { "User-Agent": options.userAgent, Accept: options.accept },
        lookup: options.lookup as never,
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      (message) => resolve(new SafeResponse(message, message.statusCode ?? 0, url)),
    );
    req.on("error", reject);
    req.end();
  });
}
