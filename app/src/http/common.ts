import { type Context } from "hono";
import { peerKey } from "../request-security.ts";

// App failures answer 500, never 502: Cloudflare swaps an origin 502 for its own HTML page, so
// the client would lose the JSON message. The error is logged here because the reply may not say it all.
export function appError(c: Context, error: unknown, fallback: string, extra: Record<string, unknown> = {}) {
  console.error(`${c.req.method} ${c.req.path} failed:`, error);
  return c.json({ error: error instanceof Error ? error.message : fallback, ...extra }, 500);
}

export const pairingIp = peerKey;

export const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
