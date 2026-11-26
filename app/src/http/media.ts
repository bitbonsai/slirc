import { type Context } from "hono";
import { db } from "../db.ts";

// Headers for bytes a member or a remote site chose: never sniffed, never run as a document
// even when opened directly, and named with a fixed filename so nothing user-chosen lands there.
export function untrustedMediaHeaders(type: string, name: string): Record<string, string> {
  const ext = type.match(/^[a-z]+\/([a-z0-9]+)/i)?.[1]?.toLowerCase();
  return {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": `inline; filename="${ext ? `${name}.${ext}` : name}"`,
  };
}

// Read a JSON object with a hard byte cap, streaming so an absent or lying
// Content-Length cannot allocate an unbounded buffer before the check. The
// signal aborts a stalled read so an upload slot is never held forever.
type BoundedJson = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 408 | 413; error: string };

export async function readBoundedJson(c: Context, maxBytes: number, signal: AbortSignal): Promise<BoundedJson> {
  // An honest oversized header is rejected before reading; a lying one still hits
  // the streamed cap below because we never trust it to size the buffer.
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413, error: "file too large" };
  const body = c.req.raw.body;
  if (!body) return { ok: false, status: 400, error: "missing request body" };
  if (signal.aborted) return { ok: false, status: 408, error: "upload timed out" };
  const reader = body.getReader();
  let timedOut = false;
  const onAbort = () => { timedOut = true; void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return { ok: false, status: 408, error: "upload timed out" };
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: "file too large" };
      }
      chunks.push(value);
    }
  } catch {
    if (timedOut) return { ok: false, status: 408, error: "upload timed out" };
    return { ok: false, status: 400, error: "could not read request" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return { ok: false, status: 400, error: "invalid request" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "invalid request" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// The workspace icon replaces the letter tile in the sidebar, the Workspaces dialog and the Mac
// picker. Its renditions live in uploads under the scope "workspace-icon", which is not a channel:
// canReadUploadChannel refuses it, so /uploads/:id never serves them and room deletion never
// touches them. GET /api/workspace-icon is the only read path. The icon is public by design, even
// in a private workspace: another workspace's Workspaces dialog shows it to people who are not
// signed in here, the way a favicon shows. Only admins write it.
export const WORKSPACE_ICON_SCOPE = "workspace-icon";

// The icon's version, the time it was saved, or "" when there is none.
export function workspaceIconVersion(): string {
  const row = db.query("SELECT created_at FROM uploads WHERE channel = ? AND kind = 'icon-64'").get(WORKSPACE_ICON_SCOPE) as { created_at: number } | null;
  return row ? String(row.created_at) : "";
}
