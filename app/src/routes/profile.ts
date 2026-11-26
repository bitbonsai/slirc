import { currentUser, devLinks } from "../http/session.ts";
import { knownAccount, cacheGravatar, profileJson, avatarDir } from "../http/profiles.ts";
import { accountByNick, cleanDisplayName, displayNameError } from "../accounts.ts";
import { asciiFold, discoverableHuman, isMember } from "../rooms.ts";
import { bodyLimit } from "hono/body-limit";
import { withUploadSlot, normalizeUploadImage, PhotoError } from "../photo.ts";
import { readBoundedJson, untrustedMediaHeaders } from "../http/media.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../db.ts";
import { normalizeProfileBadge } from "../../shared/profile-badges.ts";
import { peekAuthors } from "./peek.ts";
import { peekable } from "../peek.ts";
import { openRoom } from "../welcome.ts";
import { Hono } from "hono";

export const profile = new Hono();

profile.get("/profiles/:account", async (c) => {
  const requester = currentUser(c);
  if (!requester) return c.json({ error: "not signed in" }, 401);
  const account = knownAccount(c.req.param("account"));
  if (!account) return c.json(null);
  const channel = c.req.query("channel") || "";
  const target = accountByNick(account);
  const self = asciiFold(account) === asciiFold(requester);
  // Unknown, or not someone this requester may see: one null answer, before any gravatar or network
  // work. Other humans use the shared discovery policy; an implicit open-channel membership is not
  // proof. Personal agents are owner-scoped; admin-managed helpers keep the existing shared-channel check.
  if (!self && target) {
    if (target.kind === "human") {
      if (!discoverableHuman(requester, target.id)) return c.json(null);
    } else if (target.kind === "agent") {
      if (!target.owner || target.owner.toLowerCase() !== requester.toLowerCase()) return c.json(null);
    } else if (!channel.startsWith("#") || !isMember(requester, channel) || !isMember(account, channel)) {
      return c.json(null);
    }
  }
  await cacheGravatar(account);
  c.header("Cache-Control", "no-store");
  const admin = accountByNick(requester)?.role === "admin";
  return c.json(admin ? { ...profileJson(account), email: accountByNick(account)?.email || "" } : profileJson(account));
});

// The client sends a 640px still, about 100 KB. 4 MB of bytes is 5.4 MB as base64, plus JSON.
const MAX_AVATAR_REQUEST_BYTES = 6 * 1024 * 1024;

profile.use("/profile/avatar", bodyLimit({ maxSize: MAX_AVATAR_REQUEST_BYTES, onError: (c) => c.json({ error: "image must be under 4 MB" }, 413) }));

profile.post("/profile/avatar", async (c) => {
  const account = currentUser(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  // Same path as message photos: one upload slot, a bounded body, and a pixel cap checked from
  // the header before any decode, so a tiny decompression bomb cannot exhaust memory.
  return withUploadSlot(async (signal) => {
    const read = await readBoundedJson(c, MAX_AVATAR_REQUEST_BYTES, signal);
    if (!read.ok) return c.json({ error: read.error }, read.status);
    const { mime, data, accountId } = read.value as { mime?: unknown; data?: unknown; accountId?: unknown };
    // A photo may finish decoding after another tab changes the session cookie. Never write it to
    // that new account. Legacy clients omit this guard; the client sends its immutable account ID.
    if (accountId !== undefined && accountId !== accountByNick(account)?.id) return c.json({ error: "Account changed. Reload before uploading a photo." }, 409);
    if (typeof mime !== "string" || !/^image\/(jpeg|png|webp|gif)$/i.test(mime) || typeof data !== "string") return c.json({ error: "choose an image" }, 400);
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0)); } catch { return c.json({ error: "invalid image" }, 400); }
    if (bytes.byteLength > 4 * 1024 * 1024) return c.json({ error: "image must be under 4 MB" }, 413);
    let normalized: Awaited<ReturnType<typeof normalizeUploadImage>>;
    try {
      normalized = await normalizeUploadImage(bytes);
    } catch (error) {
      if (error instanceof PhotoError) return c.json({ error: error.message }, error.status);
      return c.json({ error: "could not process image" }, 400);
    }
    await mkdir(avatarDir, { recursive: true });
    const path = join(avatarDir, account.toLowerCase());
    await Bun.write(path, normalized.bytes);
    db.query("INSERT INTO profiles (account, avatar_path, avatar_mime, avatar_version) VALUES (?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET avatar_path = excluded.avatar_path, avatar_mime = excluded.avatar_mime, avatar_version = MAX(excluded.avatar_version, COALESCE(profiles.avatar_version, 0) + 1)")
      .run(account, path, normalized.mime, Date.now());
    return c.json(profileJson(account));
  }).catch((error) => {
    if (error instanceof PhotoError) return c.json({ error: error.message }, error.status);
    throw error;
  });
});

profile.patch("/profile", async (c) => {
  const account = currentUser(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid profile" }, 400);
  if (body.badge !== undefined && (typeof body.badge !== "string" || normalizeProfileBadge(body.badge) !== body.badge)) return c.json({ error: "invalid status badge" }, 400);
  if (body.accountId !== undefined && body.accountId !== accountByNick(account)?.id) return c.json({ error: "Your account changed. Reload and try again." }, 409);
  // Only a changed name is checked, so a name kept from before these rules never blocks saving the rest.
  const previous = profileJson(account);
  if (body.fullName !== undefined && typeof body.fullName !== "string") return c.json({ error: "invalid display name" }, 400);
  const fullName = body.fullName === undefined ? previous.fullName : cleanDisplayName(body.fullName);
  const nameError = fullName === previous.fullName ? null : displayNameError(fullName, account);
  if (nameError) return c.json({ error: nameError }, 400);
  if (body.theme !== undefined) {
    if (!["light", "dark", "system"].includes(body.theme)) return c.json({ error: "invalid theme" }, 400);
    const id = accountByNick(account)?.id;
    if (!id || body.accountId !== id) return c.json({ error: "Your account changed. Reload and try again." }, 409);
    db.query("UPDATE accounts SET theme = ? WHERE account_id = ?").run(body.theme, id);
  }
  if (body.greeting !== undefined || body.greetingNoteSeen !== undefined) {
    if ([body.greeting, body.greetingNoteSeen].some((value) => value !== undefined && typeof value !== "boolean")) return c.json({ error: "invalid greeting setting" }, 400);
    const id = accountByNick(account)?.id;
    if (!id || body.accountId !== id) return c.json({ error: "Your account changed. Reload and try again." }, 409);
    if (body.greeting !== undefined) db.query("UPDATE accounts SET hide_greeting = ? WHERE account_id = ?").run(body.greeting ? 0 : 1, id);
    if (body.greetingNoteSeen !== undefined) db.query("UPDATE accounts SET greeting_note_seen = ? WHERE account_id = ?").run(body.greetingNoteSeen ? 1 : 0, id);
  }
  // Badge autosave and legacy clients send different subsets; omitted fields stay unchanged.
  const badge = body.badge === undefined ? previous.badge : normalizeProfileBadge(body.badge);
  const about = body.about === undefined ? previous.about : typeof body.about === "string" ? body.about.trim().slice(0, 280) : "";
  const availability = body.availability === undefined ? previous.availability : typeof body.availability === "string" ? body.availability.trim().slice(0, 80) : "";
  db.query("INSERT INTO profiles (account, full_name, about, availability, badge) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET full_name = excluded.full_name, about = excluded.about, availability = excluded.availability, badge = excluded.badge")
    .run(account, fullName, about, availability, badge);
  return c.json(profileJson(account));
});

profile.get("/avatars/:account", async (c) => {
  const requested = c.req.param("account");
  if (!currentUser(c) && !(peekAuthors.has(requested.toLowerCase()) && peekable(openRoom()))) return c.body(null, 401);
  const account = knownAccount(requested) || requested.replace(/[^a-z0-9_-]/gi, "").slice(0, 32);
  if (!account) return c.body(null, 404);
  // A versioned URL names one photo, so it never needs revalidating. Bare URLs stay short-lived so
  // a new photo replaces the initial within minutes even for clients that do not know the version.
  const cache = c.req.query("v") ? "private, max-age=31536000, immutable" : "private, max-age=300";
  const row = db.query("SELECT avatar_path, avatar_mime FROM profiles WHERE account = ?").get(account) as { avatar_path: string | null; avatar_mime: string | null } | null;
  if (!row?.avatar_path) {
    // Same Catppuccin palette and hash as nick colors in the PWA, so a person's color matches everywhere.
    const colors = ["#f5c2e7", "#cba6f7", "#eba0ac", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb", "#74c7ec", "#89b4fa", "#b4befe"];
    const key = account.toLowerCase();
    const hashValue = [...key].reduce((value, char) => Math.imul(31, value) + char.charCodeAt(0) | 0, 0);
    const color = colors[(hashValue >>> 0) % colors.length];
    const initial = account.slice(0, 1).toUpperCase().replace(/[&<>\"']/g, "");
    for (const [name, value] of Object.entries(untrustedMediaHeaders("image/svg+xml", "avatar"))) c.header(name, value);
    c.header("Cache-Control", devLinks ? "no-store" : cache);
    return c.body(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="50" fill="${color}"/><text x="50" y="54" fill="#11111b" font-family="system-ui,sans-serif" font-size="48" font-weight="750" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`);
  }
  const file = Bun.file(row.avatar_path);
  if (!await file.exists()) return c.body(null, 404);
  for (const [name, value] of Object.entries(untrustedMediaHeaders(row.avatar_mime || "image/jpeg", "avatar"))) c.header(name, value);
  c.header("Cache-Control", cache);
  return c.body(file.stream());
});
