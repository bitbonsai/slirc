import { IMAGE_LIMITS, withUploadSlot, canReadUploadChannel, normalizeUploadImage, PhotoError, ANIMATED_EMOJI_LIMITS, sniffAnimatedEmoji, WORKSPACE_ICON_LIMITS, workspaceIconRenditions } from "../photo.ts";
import emojiRows from "../../public/vendor/emoji.json" with { type: "json" };
import { currentUser, verifiedHuman, sameOriginJson } from "../http/session.ts";
import { accountByNick } from "../accounts.ts";
import { readBoundedJson, WORKSPACE_ICON_SCOPE, untrustedMediaHeaders } from "../http/media.ts";
import { normalized, agentCanReadChannel } from "../rooms.ts";
import { randomBytes } from "node:crypto";
import { db } from "../db.ts";
import { slircMode, emojiBudgetBytes } from "../config.ts";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import { type Context, Hono } from "hono";
import { admin } from "./admin.ts";
import { bindingForRequest } from "../http/agent-support.ts";

export const uploads = new Hono();

// Media uploads: stills are normalized here, videos are stored as sent; SQLite holds them
// as blobs. Ids are random, so URLs are unlisted — access still follows the room.
const UPLOAD_LIMITS: Record<string, number> = { image: IMAGE_LIMITS.maxOriginalBytes, video: 30 * 1024 * 1024 };

const BUILTIN_EMOJI = new Set(emojiRows.map((row) => row[0]));

// The whole JSON envelope arrives before kind is known, so it must admit the legacy
// 30 MiB video as base64 (4/3) plus field overhead. Both the streamed read and the
// per-kind checks below bound what is actually retained.
const MAX_UPLOAD_REQUEST_BYTES = Math.ceil((UPLOAD_LIMITS.video * 4) / 3) + 512 * 1024;

uploads.post("/api/uploads", async (c) => {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  if (!account) return c.json({ error: "not signed in" }, 401);
  // A slot is taken before the body is buffered and held through normalize and
  // write, so concurrent uploads cannot stack request buffers or native decode
  // memory. withUploadSlot also bounds a stalled body read and releases in finally.
  return withUploadSlot(async (signal) => {
    const read = await readBoundedJson(c, MAX_UPLOAD_REQUEST_BYTES, signal);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    // Reject prototype-key payloads rather than letting them near object shape checks.
    for (const key of ["__proto__", "prototype", "constructor"]) {
      if (Object.prototype.hasOwnProperty.call(read.value, key)) return c.json({ error: "invalid request" }, 400);
    }
    const { channel, kind, mime, data, accountId } = read.value as { channel?: unknown; kind?: unknown; mime?: unknown; data?: unknown; accountId?: unknown };
    // New clients send the immutable account id so a session or account revoked
    // mid-flight cannot hand this photo to another identity. Legacy requests omit
    // it and stay compatible (the current PWA does not send it).
    if (accountId !== undefined && accountId !== account.id) {
      return c.json({ error: "Account changed. Reload before uploading a photo." }, 409);
    }
    // `channel: "notes"` stores the image under the uploader's own Notes, never a room.
    const scope = channel === "notes" ? `notes:${account.id}` : typeof channel === "string" ? channel.toLowerCase() : "";
    if (channel !== "notes" && (typeof channel !== "string" || !/^#[a-z0-9][a-z0-9_-]{0,63}$/i.test(channel) || !canReadUploadChannel(account.nick, channel))) {
      return c.json({ error: "not a member of that room" }, 403);
    }
    // Exact primitive enum before any lookup: UPLOAD_LIMITS is a plain object, so
    // `constructor`/`toString`/`__proto__` would otherwise be truthy inherited keys.
    if (kind !== "image" && kind !== "video") return c.json({ error: "invalid upload kind" }, 400);
    const allowed = UPLOAD_LIMITS[kind];
    // MIME family must match the kind, so kind:"video" cannot smuggle undecompressed
    // image bytes past the image normalizer.
    const mimeOk = typeof mime === "string" && (kind === "image"
      ? /^image\/(jpeg|png|webp|gif)$/i.test(mime)
      : /^video\/(mp4|webm|quicktime)$/i.test(mime));
    if (!mimeOk) return c.json({ error: "unsupported file type" }, 400);
    if (typeof data !== "string" || data.length === 0) return c.json({ error: "missing data" }, 400);
    // Bound the base64 string before atob allocates the decoded bytes.
    if (data.length > Math.ceil((allowed * 4) / 3) + 4) return c.json({ error: "file too large" }, 413);
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    } catch {
      return c.json({ error: "invalid data" }, 400);
    }
    if (bytes.byteLength > allowed) return c.json({ error: "file too large" }, 413);
    let storedMime = mime;
    let dimensions: { width: number; height: number } | null = null;
    if (kind === "image") {
      try {
        const normalized = await normalizeUploadImage(bytes);
        bytes = normalized.bytes;
        storedMime = normalized.mime;
        dimensions = { width: normalized.width, height: normalized.height };
      } catch (error) {
        if (error instanceof PhotoError) return c.json({ error: error.message }, error.status);
        return c.json({ error: "invalid image" }, 400);
      }
    } else {
      // A video keeps the size its uploader read from the clip: the server stores videos as sent
      // and never decodes them. It only reserves the frame, so an absurd value is dropped, not
      // refused, and the message still carries the video.
      const [width, height] = [read.value.width, read.value.height];
      if ([width, height].every((value) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 8_192)) {
        dimensions = { width: width as number, height: height as number };
      }
    }
    // A session or membership can be revoked while the image decodes; re-read
    // both before committing so a revoked upload is never written as readable.
    const stillNick = currentUser(c);
    const stillAccount = stillNick ? accountByNick(stillNick) : null;
    if (!stillAccount || stillAccount.id !== account.id || !canReadUploadChannel(stillAccount.nick, scope)) {
      return c.json({ error: "not a member of that room" }, 403);
    }
    const id = randomBytes(16).toString("base64url");
    db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, account.nick, scope, kind, storedMime, bytes, Date.now(), dimensions?.width ?? null, dimensions?.height ?? null);
    return c.json({ url: `/uploads/${id}?type=${kind}`, mime: storedMime, ...(dimensions ?? {}) });
  }).catch((error) => {
    if (error instanceof PhotoError) return c.json({ error: error.message }, error.status);
    throw error;
  });
});

uploads.get("/api/emoji", (c) => {
  c.header("Cache-Control", "no-store");
  // Emoji are tenant data in a private workspace: only a signed-in account may list them.
  if (slircMode() === "private_workspace" && !currentUser(c)) return c.json({ error: "not signed in" }, 401);
  const rows = db.query("SELECT name, upload_id, added_by FROM custom_emoji ORDER BY name").all() as { name: string; upload_id: string; added_by: string }[];
  return c.json(rows.map((row) => ({ name: row.name, url: `/uploads/${row.upload_id}?type=image`, addedBy: row.added_by })));
});

// No instance-wide cap: each member may add this many emoji per rolling 24 hours,
// counted from custom_emoji rows, so a deleted emoji frees its place.
const EMOJI_ADDS_PER_DAY = 50;

// The animated shape carries up to 128 KB as base64 (4/3) plus field overhead.
const MAX_EMOJI_REQUEST_BYTES = 200 * 1024;

// Animated emoji bytes are not tied to a room. "emoji" is not a channel, so
// canReadUploadChannel refuses it and the bytes stay readable only while the
// custom_emoji row points at them.
const EMOJI_UPLOAD_CHANNEL = "emoji";

uploads.post("/api/emoji", async (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, 401);
  return withUploadSlot(async (signal) => {
    const read = await readBoundedJson(c, MAX_EMOJI_REQUEST_BYTES, signal);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    const body = read.value;
    const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
    if (!/^[a-z0-9_+-]{2,32}$/.test(name)) return c.json({ error: "Use 2–32 lowercase letters, numbers, dashes, underscores, or plus signs." }, 400);
    if (BUILTIN_EMOJI.has(name)) return c.json({ error: `:${name}: is already a standard emoji.` }, 409);
    const recent = db.query("SELECT COUNT(*) AS count FROM custom_emoji WHERE added_by = ? COLLATE NOCASE AND created_at > ?")
      .get(account.nick, Date.now() - 24 * 60 * 60 * 1000) as { count: number };
    if (recent.count >= EMOJI_ADDS_PER_DAY) {
      return c.json({ error: `You can add ${EMOJI_ADDS_PER_DAY} custom emoji a day. Try again later.` }, 429);
    }
    // Two shapes: { name, uploadId } names a still already normalized by /api/uploads;
    // { name, mime, data } carries an animated file stored as sent. mime is ignored.
    let animated: { bytes: Uint8Array; mime: string } | null = null;
    let uploadId = "";
    if (typeof body.data === "string") {
      if (body.data.length > Math.ceil((ANIMATED_EMOJI_LIMITS.maxBytes * 4) / 3) + 4) return c.json({ error: "Animated emoji must be under 128 KB." }, 413);
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(body.data), (char) => char.charCodeAt(0));
      } catch {
        return c.json({ error: "invalid data" }, 400);
      }
      animated = { bytes, mime: sniffAnimatedEmoji(bytes).mime };
    } else {
      uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
      const upload = db.query("SELECT id FROM uploads WHERE id = ? AND nick = ? COLLATE NOCASE AND kind = 'image'").get(uploadId, account.nick) as { id: string } | null;
      if (!upload) return c.json({ error: "image upload not found" }, 404);
    }
    if (db.query("SELECT 1 FROM custom_emoji WHERE name = ?").get(name)) return c.json({ error: `:${name}: already exists.` }, 409);
    // The storage budget is checked in the same transaction as the insert, so two adds
    // cannot both fit under the line and land together over it.
    const budget = emojiBudgetBytes();
    const added = db.transaction(() => {
      const used = db.query("SELECT COALESCE(SUM(length(u.data)), 0) AS bytes FROM custom_emoji e JOIN uploads u ON u.id = e.upload_id").get() as { bytes: number };
      const size = animated
        ? animated.bytes.byteLength
        : (db.query("SELECT length(data) AS bytes FROM uploads WHERE id = ?").get(uploadId) as { bytes: number }).bytes;
      if (used.bytes + size > budget) return false;
      if (animated) {
        uploadId = randomBytes(16).toString("base64url");
        db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES (?, ?, ?, 'image', ?, ?, ?)")
          .run(uploadId, account.nick, EMOJI_UPLOAD_CHANNEL, animated.mime, animated.bytes, Date.now());
      }
      db.query("INSERT INTO custom_emoji (name, upload_id, added_by, created_at) VALUES (?, ?, ?, ?)").run(name, uploadId, account.nick, Date.now());
      return true;
    })();
    if (!added) return c.json({ error: "This Slirc has used its custom emoji storage. Remove some emoji to make room." }, 413);
    return c.json({ name, url: `/uploads/${uploadId}?type=image`, addedBy: account.nick }, 201);
  }).catch((error) => {
    if (error instanceof PhotoError) return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    throw error;
  });
});

uploads.delete("/api/emoji/:name", (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, 401);
  const name = c.req.param("name").toLowerCase();
  const row = db.query("SELECT upload_id, added_by FROM custom_emoji WHERE name = ?").get(name) as { upload_id: string; added_by: string } | null;
  if (!row) return c.json({ error: "emoji not found" }, 404);
  if (row.added_by.toLowerCase() !== account.nick.toLowerCase() && account.role !== "admin") return c.json({ error: "emoji owner required" }, 403);
  db.transaction(() => {
    db.query("DELETE FROM custom_emoji WHERE name = ?").run(name);
    db.query("DELETE FROM uploads WHERE id = ?").run(row.upload_id);
  })();
  return c.body(null, 204);
});

const MAX_WORKSPACE_ICON_REQUEST_BYTES = Math.ceil((WORKSPACE_ICON_LIMITS.maxBytes * 4) / 3) + 4096;

const iconCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Admin");

function workspaceIconAdmin(c: Context) {
  const admin = verifiedHuman(c);
  if (!admin) return { error: c.json({ error: "not signed in" }, currentUser(c) ? 403 : 401) };
  if (admin.role !== "admin") return { error: c.json({ error: "admin required" }, 403) };
  if (!iconCsrf(c)) return { error: c.json({ error: "cross-site request refused" }, 403) };
  return { admin };
}

uploads.get("/api/workspace-icon", (c) => {
  const size = c.req.query("size") === "256" ? 256 : 64;
  // Short and public: a new icon reaches other browsers within a minute, and the ETag makes the
  // recheck a 304. The page that saves an icon adds ?v= so its own tab shows it at once.
  c.header("Cache-Control", "public, max-age=60");
  // Other workspaces load this in an <img>, so it must be readable cross-origin.
  c.header("Cross-Origin-Resource-Policy", "cross-origin");
  const row = db.query("SELECT data, created_at FROM uploads WHERE channel = ? AND kind = ?").get(WORKSPACE_ICON_SCOPE, `icon-${size}`) as { data: Uint8Array; created_at: number } | null;
  if (!row) return c.body(null, 404);
  const etag = `"icon-${size}-${row.created_at}"`;
  c.header("ETag", etag);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  for (const [name, value] of Object.entries(untrustedMediaHeaders("image/webp", "workspace-icon"))) c.header(name, value);
  return c.body(row.data as Uint8Array);
});

uploads.post("/api/admin/workspace-icon", async (c) => {
  c.header("Cache-Control", "no-store");
  const check = workspaceIconAdmin(c);
  if (check.error) return check.error;
  return withUploadSlot(async (signal) => {
    const read = await readBoundedJson(c, MAX_WORKSPACE_ICON_REQUEST_BYTES, signal);
    if (!read.ok) return c.json({ error: read.status === 413 ? "The icon must be under 2 MB." : read.error }, read.status);
    const { mime, data } = read.value as { mime?: unknown; data?: unknown };
    if (typeof mime !== "string" || !/^image\/(png|jpeg|webp)$/i.test(mime)) return c.json({ error: "Use a PNG, JPEG or WebP image." }, 400);
    if (typeof data !== "string" || !data) return c.json({ error: "missing data" }, 400);
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    } catch {
      return c.json({ error: "invalid data" }, 400);
    }
    // The declared type is only a first filter; the renditions sniff the real format from the bytes.
    const renditions = await workspaceIconRenditions(bytes);
    // The admin's role can be taken away while the image decodes: check again before writing.
    const still = verifiedHuman(c);
    if (!still || still.id !== check.admin!.id || still.role !== "admin") return c.json({ error: "admin required" }, 403);
    const version = Date.now();
    db.transaction(() => {
      db.query("DELETE FROM uploads WHERE channel = ?").run(WORKSPACE_ICON_SCOPE);
      for (const item of renditions) {
        db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES (?, ?, ?, ?, 'image/webp', ?, ?)")
          .run(randomBytes(16).toString("base64url"), still.nick, WORKSPACE_ICON_SCOPE, `icon-${item.size}`, item.bytes, version);
      }
    })();
    return c.json({ version });
  }).catch((error) => {
    if (error instanceof PhotoError) return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    throw error;
  });
});

uploads.delete("/api/admin/workspace-icon", (c) => {
  c.header("Cache-Control", "no-store");
  const check = workspaceIconAdmin(c);
  if (check.error) return check.error;
  db.query("DELETE FROM uploads WHERE channel = ?").run(WORKSPACE_ICON_SCOPE);
  return c.body(null, 204);
});

// Pixel sizes of photos already stored, so a reader reserves each picture's box before its bytes
// arrive. The same membership rule as /uploads/:id; anything unreadable or unknown is left out.
uploads.get("/api/uploads/dims", (c) => {
  c.header("Cache-Control", "private, max-age=86400");
  const nick = currentUser(c);
  const ids = [...new Set((c.req.query("ids") || "").split(","))].filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, 100);
  const read = db.query("SELECT channel, width, height FROM uploads WHERE id = ? AND width IS NOT NULL AND height IS NOT NULL");
  const dims: Record<string, { width: number; height: number }> = {};
  for (const id of ids) {
    const row = read.get(id) as { channel: string; width: number; height: number } | null;
    if (row && canReadUploadChannel(nick ?? null, row.channel)) dims[id] = { width: row.width, height: row.height };
  }
  return c.json(dims);
});

uploads.get("/uploads/:id", (c) => {
  const id = c.req.param("id");
  // Never let a browser re-sniff a stored upload into an active type.
  c.header("X-Content-Type-Options", "nosniff");
  const row = db.query("SELECT channel, mime, data FROM uploads WHERE id = ?").get(id) as { channel: string; mime: string; data: Uint8Array } | null;
  if (!row) return c.body(null, 404);
  // Global custom emoji are public by design; everything else follows current
  // room/thread membership, so revocation and parent deletion fail closed.
  const customEmoji = !!db.query("SELECT 1 FROM custom_emoji WHERE upload_id = ?").get(id);
  const nick = currentUser(c);
  // A session agent has no cookie; it sends its binding secret as a Bearer token and may read
  // only media from conversations it could read through Slirc's agent rules.
  const binding = nick ? null : bindingForRequest(c);
  const allowed = customEmoji || canReadUploadChannel(nick, row.channel)
    || (!!binding && agentCanReadChannel(binding.nick, row.channel));
  if (!allowed) return c.body(null, nick || binding ? 403 : 401);
  // Emoji bytes are tenant data in a private workspace, never a public asset.
  const privateEmoji = customEmoji && slircMode() === "private_workspace";
  if (privateEmoji && !nick && !binding) return c.body(null, 401);
  // Public assets (open rooms, anonymous-readable threads, public-mode custom emoji) may be
  // cached briefly; private media revalidates because authorization can change between reads.
  // Agent reads are never cached.
  const publicRead = !binding && !privateEmoji && (customEmoji || canReadUploadChannel(null, row.channel));
  c.header("Cache-Control", publicRead ? "public, max-age=300" : "private, no-store");
  for (const [name, value] of Object.entries(untrustedMediaHeaders(row.mime, "upload"))) c.header(name, value);
  const total = row.data.byteLength;
  const range = c.req.header("Range");
  if (!range) {
    c.header("Content-Type", row.mime);
    return c.body(row.data as Uint8Array);
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return c.body(null, 416);
  const start = match[1] === "" ? Math.max(0, total - Number(match[2] || 0)) : Number(match[1]);
  const end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
  if (start > end || start >= total) return c.body(null, 416);
  c.status(206);
  c.header("Content-Type", row.mime);
  c.header("Content-Range", `bytes ${start}-${end}/${total}`);
  c.header("Accept-Ranges", "bytes");
  return c.body(row.data.subarray(start, end + 1) as Uint8Array);
});
