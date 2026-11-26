import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "hono/bun";
import { onboardingDestination } from "./onboarding.ts";
import { claimWelcomeJob, enqueueWelcomeJob, isFounder, markWelcomeDelivered, releaseWelcomeJob, setWelcomeEnabled, welcomeEnabled, welcomeJobs } from "./founder-welcome.ts";
import { reserveSignup } from "./mail-count.ts";
import { createPeek, peekable, type PeekMessage } from "./peek.ts";
import { openRoom } from "./welcome.ts";
import { joinLinksHomeOnce, linksChannelsFor, linksHome } from "./links-collect.ts";
import { linksEnabled } from "./links.ts";
import { db, vapidKeys } from "./db.ts";
import { assertDirectReadiness } from "./direct-readiness.ts";
import { normalizeProfileBadge } from "../shared/profile-badges.ts";
import { emojiBudgetBytes, enabledHelpers, ergoOperUser, inactiveHelper, slircMode } from "./config.ts";
import { openDirectConversation } from "./direct.ts";
import { ircKey } from "./irc-key.ts";
import { setUserTimeZone, validTimeZone } from "./reminders.ts";
import { pollById, pollView } from "./polls.ts";
import { asciiFold, channelInfo, defaultChannel, closeDirectConversation, directConversation, directConversations, discoverableHuman, isMember, isOpenChannel, isValidNext, memberChannels, normalized, openChannels, reopenDirectConversation, sharedContacts, visibleChannels } from "./rooms.ts";
import { canonicalMailbox, emailInviteByToken } from "./email-invites.ts";
import { accountByEmail, accountByNick, allAccounts, cleanDisplayName, displayNameError, ircChannelExists, markVerified, provisionAccount, validEmail } from "./accounts.ts";
import { helperSay, reminderOutcome, scheduleReminder } from "./helper-bot.ts";
import { opAdmins } from "./admin-ops.ts";
import { createChannel } from "./grants.ts";
import { sweepExpired } from "./pairing.ts";
import { instanceHost, offeredHarnesses } from "./agent-connect.ts";
import { type Binding } from "./agent-session.ts";
import { ownerAgentRequestStates, syncAgentPresence, connectAgentTransport, resetAgentSessionState } from "./agent-session-transport.ts";
import { channelsChanged, publish, subscribe } from "./live.ts";
import { observeReplyLine } from "./reply-threads.ts";
import { closeSessionSockets, handleRelayUpgrade, relayWebsocketHandlers } from "./relay.ts";
import { configuredAppOrigin, createLimiter, isAllowedClientOrigin, peerKey } from "./request-security.ts";
import { addNote, deleteNote, editNote, listNotes, noteBody } from "./notes.ts";
import { postNote } from "./update-notes.ts";
import { bindProject, channelCandidates, formatGithubEvent, parseRepo, projectBinding, projectBindings, repoLabel, verifyGithubSignature } from "./github-projects.ts";
import { testflightUrl } from "./testflight.ts";
import { normalizeUploadImage, PhotoError, withUploadSlot } from "./photo.ts";
import { escapeHtml } from "../shared/escape-html.ts";
import { devUser, sessionCookie, acctCookie, hash, CLIENT_TOKEN_TTL_MS, MAX_CLIENT_TOKENS_PER_SESSION, sessionByToken, cookieSession, clientBearerToken, session, sessionOrBearer, closeClientTokensForSession, revokeSession, currentUser, verifiedHuman, sameOriginJson, invitationCsrf, signInCsrf, completeFirstVerification, startSession, devLinks, appOrigin } from "./http/session.ts";
import { appError, pairingIp, text } from "./http/common.ts";
import { agentSessionCapabilities } from "./http/agent-support.ts";
import { pairing } from "./routes/pairing.ts";
import { agents } from "./routes/agents.ts";
import { links } from "./routes/links.ts";
import { codeHash, sendMagicLink, mailLimit } from "./http/mail.ts";
import { avatarDir, knownAccount, avatarVersion, cacheGravatar, profileJson, accountDetails } from "./http/profiles.ts";
import { ircResetNotice } from "./http/irc-devices.ts";
import { admin } from "./routes/admin.ts";
import { polls } from "./routes/polls.ts";
import { channels } from "./routes/channels.ts";
import { untrustedMediaHeaders, readBoundedJson, workspaceIconVersion } from "./http/media.ts";
import { uploads } from "./routes/uploads.ts";
import { sendOnboarding } from "./http/onboarding.ts";
import { invitations } from "./routes/invitations.ts";
import { buildClient, buildVideoEncode, versionShell, assetCacheControl } from "./http/assets.ts";
import { joinlinks } from "./routes/join-links.ts";
import { bots } from "./routes/bots.ts";
import { irc } from "./routes/irc.ts";
import { embeds } from "./routes/embeds.ts";
import { embedCache, PLAYER_HOSTS } from "./routes/embeds.ts";
export { clientVersion, buildClient, assetVersion, versionShell } from "./http/assets.ts";
export { untrustedMediaHeaders } from "./http/media.ts";
export { agentSessionCapabilities, AGENT_POLL_MAX_WAIT_S, AGENT_SSE_KEEPALIVE_MS } from "./http/agent-support.ts";
export { sessionByToken } from "./http/session.ts";

assertDirectReadiness(db);

const serviceNicks = () => ["slirc", ergoOperUser()];

const app = new Hono();

// Explicit CORS for cross-origin multi-instance clients, scoped strictly to /auth/me,
// /auth/logout, and /irc. Only allowed origins get reflected, and
// Access-Control-Allow-Credentials is always false (bearer-only, never cookies cross-origin).
const multiInstanceCors = async (c: any, next: () => Promise<void>) => {
  const origin = c.req.header("Origin");
  const isDevCors = devLinks || process.env.NODE_ENV === "development" || process.env.SLIRC_DEV_PROFILE === "slirc2";
  const allowed = !!origin && isAllowedClientOrigin(origin, { dev: isDevCors });
  if (c.req.method === "OPTIONS") {
    if (allowed) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      c.header("Access-Control-Allow-Credentials", "false");
      c.header("Access-Control-Max-Age", "600");
      c.header("Vary", "Origin");
    }
    return c.body(null, 204);
  }
  await next();
  if (!allowed) return;
  const headers = new Headers(c.res.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Allow-Credentials", "false");
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Origin");
  else if (!vary.split(",").some((part) => part.trim().toLowerCase() === "origin")) headers.set("Vary", `${vary}, Origin`);
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
};
app.use("/auth/me", multiInstanceCors);
app.use("/auth/logout", multiInstanceCors);
app.use("/irc", multiInstanceCors);

// LAN HTTP is test-only. Do not let Safari's PWA cache hide source changes from phone testing.
app.use("*", async (c, next) => {
  if (devLinks && c.req.method === "GET") {
    c.header("Cache-Control", "no-store");
    // Dev-only phone layout: it keys off (pointer: coarse), which a desktop browser never
    // reports, so the phone screens cannot be checked without a device. ?phone=1 sets the cookie.
    const phone = c.req.query("phone");
    if (phone !== undefined) setCookie(c, "slirc_phone", phone === "1" ? "1" : "", { path: "/", sameSite: "Lax" });
  }
  await next();
});
// The shell and its service worker must never come from a stale HTTP cache: Safari otherwise keeps
// an old index.html (and an old sw.js, so no new CACHE name is ever seen) long past a deploy.
app.use("*", async (c, next) => {
  await next();
  const isShell = c.req.path === "/sw.js" || (c.res.headers.get("content-type") || "").includes("text/html");
  if (!isShell || c.res.headers.has("Cache-Control")) return;
  const headers = new Headers(c.res.headers);
  headers.set("Cache-Control", "no-cache");
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

// Second line against injected markup: pages run only scripts served from this origin, never inline
// ones or event-handler attributes. The vendored standard Alpine build compiles its x-* expressions
// with new Function, hence 'unsafe-eval'; the CSP build cannot parse the shell's expressions. Inline
// <style> and style attributes stay allowed. Frames are limited to the player hosts the media dialog
// embeds. Responses that set their own policy (untrusted media) keep it.
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `frame-src ${[...PLAYER_HOSTS].map((host) => `https://${host}`).join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
app.use("*", async (c, next) => {
  await next();
  if (!(c.res.headers.get("content-type") || "").includes("text/html") || c.res.headers.has("Content-Security-Policy")) return;
  const headers = new Headers(c.res.headers);
  headers.set("Content-Security-Policy", contentSecurityPolicy());
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

// The app sets its own cache headers for the files a page loads, so nothing depends on what a
// proxy does by default with a .js or .css address.
app.use("*", async (c, next) => {
  await next();
  const path = c.req.path;
  if (c.req.method !== "GET" || path.startsWith("/api/") || path === "/sw.js" || c.res.status !== 200) return;
  if (!/\.(js|css|webmanifest|svg)$/.test(path) || c.res.headers.has("Cache-Control")) return;
  const headers = new Headers(c.res.headers);
  headers.set("Cache-Control", await assetCacheControl(path, c.req.query("v")));
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

app.get("/healthz", (c) => c.json({ status: "ok" }));
// Report the hash of the client bundle actually served.
app.get("/api/version", async (c) => {
  c.header("Cache-Control", "no-store");
  const build = await buildClient();
  return c.json({ version: build?.version || "" });
});

// Native app links for admitted members. The TestFlight link is public once known, so it stays out
// of the client bundle, HTML and docs: only signed-in, verified humans can read it here.
app.get("/api/apps", (c) => {
  c.header("Cache-Control", "no-store");
  if (!currentUser(c)) return c.json({ error: "not signed in" }, 401);
  if (!verifiedHuman(c)) return c.json({ error: "verified account required" }, 403);
  return c.json({ testflight: testflightUrl(process.env.TESTFLIGHT_URL) });
});

app.route("/", pairing);

// One stream per signed-in browser tab; pairing requests arrive here instead of waiting for a poll.
app.get("/api/events", (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  c.header("Cache-Control", "no-store");
  return streamSSE(c, async (stream) => {
    const queue: { event: string; data: unknown }[] = [];
    let wake: (() => void) | null = null;
    let open = true;
    const unsubscribe = subscribe(nick, (event, data) => {
      queue.push({ event, data });
      wake?.();
      wake = null;
    });
    stream.onAbort(() => {
      open = false;
      unsubscribe();
      wake?.();
      wake = null;
    });
    await stream.writeSSE({ event: "ready", data: "1" });
    await stream.writeSSE({ event: "agent-requests", data: JSON.stringify(ownerAgentRequestStates(nick)) });
    while (open) {
      if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
      while (open && queue.length) {
        const item = queue.shift() as { event: string; data: unknown };
        await stream.writeSSE({ event: item.event, data: JSON.stringify(item.data) });
      }
    }
  });
});

app.route("/", agents);

app.route("/", bots);

app.route("/", irc);

for (const account of allAccounts()) void cacheGravatar(account.nick);

app.get("/profiles/:account", async (c) => {
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
app.use("/profile/avatar", bodyLimit({ maxSize: MAX_AVATAR_REQUEST_BYTES, onError: (c) => c.json({ error: "image must be under 4 MB" }, 413) }));

app.post("/profile/avatar", async (c) => {
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

app.route("/", admin);

app.patch("/profile", async (c) => {
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

app.get("/avatars/:account", async (c) => {
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

// Best effort: an invite that cannot open the DM is still a joined channel.
async function ensureDirectConversation(nick: string, other: string): Promise<void> {
  try {
    await openDirectConversation(nick, other);
  } catch (error) {
    console.error(`direct channel failed for ${nick} and ${other}:`, error);
  }
}

// /remind from the app: set the reminder directly and answer with the confirmation, so it shows as a
// notice where the person typed instead of a message in the remind DM. The reminder still fires in
// that DM, the same as an @remind mention. A list is several lines, so remind posts it in the DM and
// `open` tells the app to go there instead of showing a notice.
const remindLimit = createLimiter({ limit: 20, windowMs: 60_000 });
app.use("/api/reminders", bodyLimit({ maxSize: 2_048 }));
app.post("/api/reminders", async (c) => {
  c.header("Cache-Control", "no-store");
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!sameOriginJson(c, "X-Slirc-Remind")) return c.json({ error: "same-origin request required" }, 403);
  if (!enabledHelpers().includes("remind")) return c.json({ error: "Reminders are off on this server." }, 503);
  const body = await c.req.json().catch(() => ({})) as { text?: unknown; fireAt?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 500) return c.json({ error: "When should I remind you? Try /remind in 20m stretch." }, 400);
  // Remind me → Custom… sends the picked time as epoch ms and the text is only what to remember. It
  // must be ahead of this server's clock, with no skew allowance: the client already refuses past
  // picks by its own clock, so a client clock running behind only bounces picks closer than the skew.
  // At most a year out.
  const now = Date.now();
  const fireAt = body.fireAt;
  if (fireAt !== undefined && (typeof fireAt !== "number" || !Number.isFinite(fireAt) || fireAt <= now)) return c.json({ error: "Pick a time in the future." }, 400);
  if (typeof fireAt === "number" && fireAt > now + 365 * 86_400_000) return c.json({ error: "Pick a time within a year." }, 400);
  if (!remindLimit.check(requester.nick)) return c.json({ error: "Too many reminders at once. Try again in a minute." }, 429);
  try {
    const direct = directConversation(requester.nick, "remind") ?? await openDirectConversation(requester.nick, "remind");
    if (typeof fireAt === "number") return c.json({ reply: scheduleReminder(requester.nick, direct.channel, Math.round(fireAt), text) });
    const answer = await reminderOutcome("remind", requester.nick, direct.channel, text);
    if (!answer.list) return c.json({ reply: answer.text });
    helperSay("remind", direct.channel, [answer.text]);
    return c.json({ reply: answer.text, open: "remind" });
  } catch (error) {
    console.error(`reminder failed for ${requester.nick}:`, error instanceof Error ? error.message : error);
    return c.json({ error: "Could not set the reminder. Try again." }, 500);
  }
});

app.route("/", polls);

app.post("/api/dms/:nick", async (c) => {
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const nick = requester.nick;
  const other = knownAccount(c.req.param("nick"));
  if (!other || other === nick || inactiveHelper(other)) return c.json({ error: "contact not found" }, 404);
  const otherAccount = accountByNick(other);
  // Same discovery gate as search and the accountId recipient path for humans; personal agents are
  // owner-scoped so a guessed nick cannot start a DM with someone else's. Admin-managed helper bots
  // keep their existing access. All checks run before any write.
  if (otherAccount?.kind === "human") {
    if (!discoverableHuman(nick, otherAccount.id)) return c.json({ error: "contact not found" }, 404);
  } else if (otherAccount?.kind === "agent") {
    if (!otherAccount.owner || otherAccount.owner.toLowerCase() !== nick.toLowerCase()) return c.json({ error: "contact not found" }, 404);
  }
  try {
    const direct = await openDirectConversation(nick, other);
    reopenDirectConversation(accountByNick(nick)!.id, direct.channel);
    return c.json(direct);
  } catch (error) {
    console.error(`direct channel failed for ${nick} and ${other}:`, error);
    return c.json({ error: directConversation(nick, other) ? "could not reopen direct message" : "could not start direct message" }, 500);
  }
});

// Old #t- threads are retired; reply threads need no channel.
app.post("/api/dms/:nick/threads", (c) => c.json({ error: "threads are now replies inside the conversation" }, 410));

app.delete("/api/dms/:nick", (c) => {
  const nick = currentUser(c);
  const other = c.req.param("nick").trim();
  const account = nick && accountByNick(nick);
  if (!account || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(other) || other.toLowerCase() === nick.toLowerCase()) return c.json({ error: "contact not found" }, 404);
  try {
    if (!closeDirectConversation(account.id, nick, other)) return c.json({ error: "direct message not found" }, 404);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not close direct message.");
  }
});

// Notes: the signed-in person's private scratchpad. App-only, never IRC. Every read and write is
// keyed by the session's own account id; another account's note id answers 404 like a missing one.
// Writes tell the owner's other tabs and devices over /api/events so they reload the list.
function notesOwner(c: any) {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  return account?.kind === "human" ? account : null;
}
const notesCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Notes");
app.use("/api/notes*", bodyLimit({ maxSize: 16_384 }));
app.use("/api/notes*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
app.get("/api/notes", (c) => {
  const account = notesOwner(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  return c.json({ notes: listNotes(account.id) });
});
app.post("/api/notes", async (c) => {
  const account = notesOwner(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (!notesCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const body = noteBody((await c.req.json().catch(() => ({})))?.body);
  if (!body) return c.json({ error: "Write something first, up to 4000 characters." }, 400);
  const note = addNote(account.id, body);
  publish(account.nick, "notes", {});
  return c.json({ note });
});
app.patch("/api/notes/:id", async (c) => {
  const account = notesOwner(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (!notesCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const body = noteBody((await c.req.json().catch(() => ({})))?.body);
  if (!body) return c.json({ error: "Write something first, up to 4000 characters." }, 400);
  const note = editNote(account.id, c.req.param("id"), body);
  if (!note) return c.json({ error: "note not found" }, 404);
  publish(account.nick, "notes", {});
  return c.json({ note });
});
app.delete("/api/notes/:id", (c) => {
  const account = notesOwner(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (!notesCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  if (!deleteNote(account.id, c.req.param("id"))) return c.json({ error: "note not found" }, 404);
  publish(account.nick, "notes", {});
  return c.body(null, 204);
});

app.get("/api/sessions", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  const active = session(c);
  if (!account || !active) return c.json({ error: "not signed in" }, 401);
  const currentHash = hash(active.token);
  const rows = db.query("SELECT token_hash, device, created_at FROM sessions WHERE nick = ? COLLATE NOCASE ORDER BY created_at DESC").all(account.nick) as { token_hash: string; device: string; created_at: number }[];
  return c.json(rows.map((row) => ({ id: row.token_hash, device: row.device, createdAt: row.created_at, current: row.token_hash === currentHash })));
});

app.delete("/api/sessions/:id", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  const active = session(c);
  if (!account || !active) return c.json({ error: "not signed in" }, 401);
  const id = c.req.param("id");
  if (!/^[a-f0-9]{64}$/.test(id)) return c.json({ error: "session not found" }, 404);
  if (c.req.query("other") === "1" && id === hash(active.token)) return c.json({ error: "This is your current session. Reload sessions and try again." }, 409);
  if (!revokeSession(id, account.nick)) return c.json({ error: "session not found" }, 404);
  if (id === hash(active.token)) { deleteCookie(c, "slirc_session", { path: "/" }); deleteCookie(c, "slirc_acct", { path: "/" }); }
  return c.body(null, 204);
});

const clientTokenLimit = createLimiter({ limit: 20, windowMs: 60_000 });

app.post("/auth/client-token", (c) => {
  c.header("Cache-Control", "no-store");
  if (!sameOriginJson(c, "X-Slirc-Client-Token")) return c.json({ error: "cross-origin token issuance is not allowed" }, 403);
  const active = cookieSession(c);
  if (!active) return c.json({ error: "not signed in" }, 401);
  const account = accountByNick(active.nick);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (!clientTokenLimit.check(active.tokenHash)) return c.json({ error: "Too many token requests. Try again later." }, 429);
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + CLIENT_TOKEN_TTL_MS;
  db.transaction(() => {
    db.query("DELETE FROM client_tokens WHERE session_hash = ? AND expires_at IS NOT NULL AND expires_at <= ?").run(active.tokenHash, now);
    const existing = db.query("SELECT token_hash FROM client_tokens WHERE session_hash = ? ORDER BY created_at ASC").all(active.tokenHash) as { token_hash: string }[];
    const excess = existing.length - (MAX_CLIENT_TOKENS_PER_SESSION - 1);
    for (let i = 0; i < excess; i++) {
      closeSessionSockets(existing[i]!.token_hash);
      db.query("DELETE FROM client_tokens WHERE token_hash = ?").run(existing[i]!.token_hash);
    }
    db.query("INSERT INTO client_tokens (token_hash, session_hash, nick, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hash(token), active.tokenHash, account.nick, now, expiresAt);
  })();
  return c.json({ token, nick: account.nick, accountId: account.id }, 201);
});

app.post("/auth/logout", (c) => {
  const cookie = getCookie(c, "slirc_session");
  if (cookie) {
    const sessionHash = hash(cookie);
    closeSessionSockets(sessionHash);
    closeClientTokensForSession(sessionHash);
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(sessionHash);
  }
  const bearer = clientBearerToken(c);
  if (bearer) {
    const bearerHash = hash(bearer);
    closeSessionSockets(bearerHash);
    db.query("DELETE FROM client_tokens WHERE token_hash = ?").run(bearerHash);
  }
  deleteCookie(c, "slirc_session", { path: "/" });
  deleteCookie(c, "slirc_acct", { path: "/" });
  return c.body(null, 204);
});

// Sign-in abuse limits. In-memory and single-process, which matches the single app container;
// move to shared storage if Slirc ever runs more than one app replica. Bounded and fail-closed.
const requestLimit = createLimiter({ limit: 10 });
const codeLimit = createLimiter({ limit: 20 });

app.route("/", invitations);

app.post("/auth/request", async (c) => {
  const { email: rawEmail, name, next } = await c.req.json().catch(() => ({}));
  // A pasted address keeps its outer whitespace on some clients; the address itself never has any.
  const email = typeof rawEmail === "string" ? rawEmail.trim() : rawEmail;
  // One peer gets ten sign-in mails an hour; one mailbox gets a smaller independent bound so many
  // peers cannot each send one and still flood that address. peerKey never reads a forwarded
  // header unless the socket peer is a configured trusted proxy. The mailbox key drops +tags (and
  // Gmail's dots), so spellings of one inbox share a bucket.
  if (!requestLimit.check(peerKey(c))) return c.json({ error: "Too many requests. Try again later." }, 429);
  const mailbox = typeof email === "string" ? canonicalMailbox(email) : "";
  if (mailbox && !mailLimit.check(mailbox)) return c.json({ error: "Too many requests. Try again later." }, 429);
  const valid = typeof email === "string" && validEmail(email);
  const host = c.req.header("Host");
  const run = () => valid ? signInMail(email, typeof name === "string" ? name : "", next, host, mailbox) : Promise.resolve(undefined);
  // Local stacks hand the link back in the body. Everywhere else the answer is 204 before any
  // account lookup, provisioning or mail (the work starts on a later tick), so a known and an
  // unknown address take the same time.
  if (devLinks) {
    const devLink = await run();
    if (devLink) return c.json({ devLink });
    return c.body(null, 204);
  }
  trackSignIn(new Promise((resolve) => setTimeout(resolve, 0)).then(run));
  return c.body(null, 204);
});

// Sign-in work started by /auth/request after it has answered. Tests wait on it with settleSignIns().
const signInsInFlight = new Set<Promise<unknown>>();
function trackSignIn(work: Promise<unknown>): void {
  const tracked = work.catch((error) => console.error("sign-in mail failed:", error instanceof Error ? error.message : error))
    .finally(() => signInsInFlight.delete(tracked));
  signInsInFlight.add(tracked);
}
export async function settleSignIns(): Promise<void> {
  while (signInsInFlight.size) await Promise.all([...signInsInFlight]);
}

// New-address signups per receiving domain per hour, so one domain cannot soak up the day's mail.
// Silent like every other signup refusal: the visitor still gets 204 and no mail.
const signupDomainLimit = createLimiter({ limit: Number(process.env.SIGNUP_DOMAIN_LIMIT) > 0 ? Number(process.env.SIGNUP_DOMAIN_LIMIT) : 30 });

async function signInMail(email: string, name: string, next: unknown, host: string | undefined, mailbox: string): Promise<string | undefined> {
  let account = accountByEmail(email);
  const publicSignup = slircMode() === "public_playground";
  if (!account) {
    const expired = db.query("SELECT nick FROM accounts WHERE email = ? COLLATE NOCASE").get(email.trim().toLowerCase()) as { nick: string } | null;
    // The public playground signs up an unknown address here: a provisional account that expires
    // unverified like any other, with no session until the mailed link or code proves the mailbox.
    // Its nick comes from the name typed beside the address, never from the address. It joins only
    // the open channels, which every account sees. Each new signup takes a slot of the day's mail
    // limit up front. An expired provisional account, in any mode, restarts under its old nick.
    // A private local stack (MAGIC_LINK_LOG=true) also creates one so its link still signs in.
    const allowed = !!expired || (publicSignup
      ? signupDomainLimit.check(mailbox.split("@")[1] || "") && reserveSignup()
      : devLinks);
    if (!allowed) return;
    const display = name.trim().slice(0, 80) || (publicSignup ? "member" : email.trim().split("@", 1)[0] || "member");
    account = await provisionAccount(expired?.nick ?? display, email).catch((error) => {
      console.error("signup failed:", error instanceof Error ? error.message : error);
      return null;
    });
    if (!account) return;
  }
  return sendMagicLink(account, typeof next === "string" ? next : "/", host);
}

// Typing the code finishes sign-in in the tab that asked for it; the link in the same
// email keeps working for people reading mail on the phone that owns the mailbox.
//
// The invitation page never learns the invited address, so it sends the invitation token instead
// and the server derives the account, as /auth/invitation/request does. That form carries the
// invitation CSRF check and only reaches the verified human account the invitation addresses.
// It shares the peer limit and the per-account miss counter with the email form, and mints
// nothing, so a token buys no extra guesses and no extra mail.
//
// Both forms start a session, so both refuse cross-site posts (a forged one would sign the visitor
// in as the attacker). An unknown address, no live code and a wrong code all get one answer, so
// the route never says whether an address has an account.
const CODE_REJECTED = "That code is wrong or expired. Try again, or request a new one.";
app.post("/auth/code", async (c) => {
  const { email: rawEmail, invitation, code, next } = await c.req.json().catch(() => ({}));
  const email = typeof rawEmail === "string" ? rawEmail.trim() : rawEmail;
  if (invitation !== undefined) c.header("Cache-Control", "no-store");
  if (!(invitation !== undefined ? invitationCsrf(c) : signInCsrf(c))) return c.json({ error: "invalid request" }, 403);
  if (!codeLimit.check(peerKey(c))) return c.json({ error: "Too many attempts. Try again later." }, 429);
  const digits = typeof code === "string" ? code.replace(/\D/g, "") : "";
  let account: ReturnType<typeof accountByEmail> | null = null;
  if (invitation !== undefined) {
    // Email and token together are refused rather than guessed at.
    const invite = email === undefined && typeof invitation === "string" && invitation.length >= 20 && invitation.length <= 100
      ? emailInviteByToken(invitation) : null;
    const invited = invite ? accountByEmail(invite.email) : null;
    if (invited && invited.kind === "human" && invited.verifiedAt &&
        (!invite!.recipientAccountId || invite!.recipientAccountId === invited.id)) account = invited;
  } else if (typeof email === "string" && validEmail(email)) {
    account = accountByEmail(email);
  }
  if (!account || digits.length !== 6) return c.json({ error: CODE_REJECTED }, 400);
  const now = Date.now();
  const live = db.query("SELECT token_hash, code_hash, attempts FROM magic_links WHERE nick = ? AND code_hash IS NOT NULL AND expires_at >= ?")
    .all(account.nick, now) as { token_hash: string; code_hash: string; attempts: number }[];
  if (!live.length) return c.json({ error: CODE_REJECTED }, 400);
  const match = live.find((row) => row.code_hash === codeHash(account.nick, digits));
  if (!match) {
    // Five misses burn the row, link included, so a guessed code never outlives the email.
    db.query("UPDATE magic_links SET attempts = attempts + 1 WHERE nick = ? AND code_hash IS NOT NULL").run(account.nick);
    db.query("DELETE FROM magic_links WHERE nick = ? AND attempts >= 5").run(account.nick);
    return c.json({ error: CODE_REJECTED }, 400);
  }
  db.query("DELETE FROM magic_links WHERE token_hash = ?").run(match.token_hash);
  db.query("INSERT INTO used_magic_links (token_hash, used_at) VALUES (?, ?) ON CONFLICT(token_hash) DO NOTHING").run(match.token_hash, now);
  const firstVerification = !account.verifiedAt;
  if (firstVerification) completeFirstVerification(account.nick);
  startSession(c, account.nick);
  const provisioned = await sendOnboarding(account.nick);
  return c.json({ next: onboardingDestination(isValidNext(next) ? next : "/", firstVerification, provisioned) });
});

app.get("/auth/link-status", (c) => {
  const tokenHash = hash(c.req.query("token") || "");
  const link = db.query("SELECT 1 FROM magic_links WHERE token_hash = ? AND expires_at >= ?").get(tokenHash, Date.now());
  const used = db.query("SELECT 1 FROM used_magic_links WHERE token_hash = ?").get(tokenHash);
  // gone: expired or burned by wrong codes, never signed in. The dev poller stops without claiming a sign-in.
  return c.json({ used: Boolean(used), gone: !used && !link });
});

app.get("/auth/verify", async (c) => {
  const token = c.req.query("token") || "";
  const next = isValidNext(c.req.query("next")) ? c.req.query("next") : "/";
  const tokenHash = hash(token);
  const link = db.query("SELECT nick, expires_at FROM magic_links WHERE token_hash = ?").get(tokenHash) as { nick: string; expires_at: number } | null;
  db.query("DELETE FROM magic_links WHERE token_hash = ?").run(tokenHash);
  const account = link && link.expires_at >= Date.now() ? accountByNick(link.nick) : null;
  if (!account) return c.redirect(next === "/" ? "/?login=invalid" : next, 302);
  db.query("INSERT INTO used_magic_links (token_hash, used_at) VALUES (?, ?) ON CONFLICT(token_hash) DO NOTHING").run(tokenHash, Date.now());
  const firstVerification = !account.verifiedAt;
  if (firstVerification) completeFirstVerification(account.nick);
  startSession(c, account.nick);
  const provisioned = await sendOnboarding(account.nick);
  if (isPublicRoomNext(next)) {
    c.header("Cache-Control", "no-store");
    return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>You're logged in · Slirc</title>
  <style>
    :root { color-scheme: dark; }
    body { display: grid; min-height: 100svh; margin: 0; place-items: center; background: #0f0f1a; color: #cdd6f4; font: 1rem/1.5 system-ui, sans-serif; }
    main { width: min(28rem, calc(100% - 2rem)); text-align: center; }
    img { width: 3.5rem; height: 3.5rem; margin-bottom: 1rem; }
    h1 { margin: 0 0 .5rem; font-size: 1.6rem; }
    p { margin: 0 0 1.25rem; color: #969db8; }
    a { color: #62f6a7; }
    .open { display: inline-block; width: 100%; padding: .8rem; border-radius: .6rem; background: #62f6a7; color: #0f0f1a; font: 700 1rem/1 system-ui, sans-serif; text-decoration: none; }
    /* A desktop already has the app open in another tab, so the button would only open a second one. */
    .on-desktop { display: none; }
    .app-link { margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid #262637; text-align: left; }
    .app-link p { margin-bottom: .75rem; font-size: .92rem; }
    .app-link form { display: flex; gap: .5rem; }
    .app-link input { flex: 1; min-width: 0; padding: .7rem .8rem; border: 1px solid #313244; border-radius: .6rem; background: #181825; color: #cdd6f4; font: 1.05rem/1 ui-monospace, monospace; letter-spacing: .1em; }
    .app-link button { padding: .7rem 1rem; border: 0; border-radius: .6rem; background: #313244; color: #cdd6f4; font: 600 .95rem/1 system-ui, sans-serif; }
    #pair-note { min-height: 1.4em; margin: .6rem 0 0; font-size: .85rem; }
    @media (not (pointer: coarse)) {
      .open, .on-phone { display: none; }
      .on-desktop { display: block; }
    }
  </style>
</head>
<body>
  <main>
    <img src="/logo.png" alt="Slirc">
    <h1>You're logged in.</h1>
    <p class="on-phone">You can close this window, or open the app.</p>
    <p class="on-desktop">You can close this window. Slirc is already open in your tab.</p>
    <a class="open" href="/">Open Slirc</a>
    <section class="on-phone app-link">
      <p>Using Slirc from your home screen? Open it, tap <strong>Link with your computer</strong>, and type the code it shows here.</p>
      <form id="pair-form"><input id="pair-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123 456" aria-label="Code from the app"><button type="submit">Approve</button></form>
      <p id="pair-note" role="status"></p>
    </section>
  </main>
  <script>
    try { localStorage.setItem("slirc-authenticated", ${JSON.stringify(next)}); } catch {}
    (() => {
      const form = document.getElementById("pair-form");
      const input = document.getElementById("pair-code");
      const note = document.getElementById("pair-note");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const code = input.value.replace(/\D/g, "");
        if (code.length !== 6) { note.textContent = "Codes have six digits."; return; }
        note.textContent = "Checking…";
        try {
          const response = await fetch("/api/pair/" + code + "/allow", { method: "POST" });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || "That code is not waiting for you. Check it has not expired.");
          note.textContent = "Done. The app is signing in.";
          input.value = "";
        } catch (error) { note.textContent = error.message; }
      });
    })();
  </script>
</body>
</html>`);
  }
  return c.redirect(onboardingDestination(next, firstVerification, provisioned), 302);
});

// Advertised IRC connection for generated client configs (no secrets). TLS is always on; the
// self-signed exception is offered only for a server-authorized loopback development endpoint, so
// a page protocol or client hostname can never weaken production trust.
function ircConnectionMeta(): { host: string; port: number; tls: true; allowSelfSigned: boolean; local: boolean } {
  const configuredHost = (process.env.SLIRC_IRC_HOST || "").trim();
  const configuredPort = Number(process.env.SLIRC_IRC_PORT);
  const devProfile = process.env.SLIRC_DEV_PROFILE === "slirc2" || process.env.SLIRC_IRC_LOCAL_DEV === "true";
  const host = configuredHost || (devProfile ? "127.0.0.1" : "");
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : (devProfile ? 6797 : 6697);
  const loopback = /^(127\.0\.0\.1|::1|localhost)$/i.test(host);
  return { host, port, tls: true, allowSelfSigned: devProfile && loopback, local: loopback };
}

app.get("/auth/me", (c) => {
  const auth = devUser ? { nick: devUser.nick, token: "", kind: "dev" as const } : sessionOrBearer(c);
  const row = auth ? db.query("SELECT nick, email, verified_at, provisional_expires_at, theme, hide_greeting, greeting_note_seen, irc_reset_notice FROM accounts WHERE nick = ? COLLATE NOCASE").get(auth.nick) : null;
  // Local dev can't click email links; treat any provisional account as verified so testing never hits
  // the expiry wall. Not on the public playground, where only the mailed link verifies an address.
  if (devLinks && slircMode() !== "public_playground" && row && !row.verified_at) { markVerified(row.nick); enqueueWelcomeJob(row.nick); }
  let account = auth && accountByNick(auth.nick);
  c.header("Cache-Control", "no-store");
  if (row && !account && row.provisional_expires_at <= Date.now()) {
    // Provisional window closed without verification: tell the client to prompt for a new link.
    return c.json({ authenticated: false, expired: true, email: row.email, serviceNicks: serviceNicks() });
  }
  // The public playground's sign-in form also asks a newcomer's name (it signs up new addresses).
  if (!account) return c.json({
    authenticated: false,
    serviceNicks: serviceNicks(),
    ...(slircMode() === "public_playground" ? { signup: true, openRoom: openRoom() } : {}),
  });
  if (!devUser && auth?.kind === "cookie") { setCookie(c, "slirc_session", auth.token, sessionCookie); setCookie(c, "slirc_acct", account.nick, acctCookie); }
  const directs = directConversations(account.nick);
  const directChannels = new Set(directs.map((item) => item.channel));
  // The links home channel joins each member's sidebar once.
  joinLinksHomeOnce(account);
  const joined = memberChannels(account.nick).filter((channel) => !directChannels.has(channel));
  const channelDetails = visibleChannels(account.nick);
  const contacts = sharedContacts(account.nick);
  return c.json({
    authenticated: true,
    serviceNicks: serviceNicks(),
    // Stable identity for cache scoping and DM peer keys; the nick is display data and can change.
    accountId: account.id,
    theme: row?.theme ?? "system",
    greeting: !row?.hide_greeting,
    // Helpers this instance runs (SLIRC_HELPERS), so the client offers only those.
    helpers: enabledHelpers(),
    // The links library: its home channel, and the channels of this member's that offer a Links view.
    linksHome: linksEnabled() ? linksHome() : null,
    linksChannels: linksChannelsFor(account.nick),
    greetingNoteSeen: !!row?.greeting_note_seen,
    // Set once by the derived-password migration; the client shows a note until it is cleared.
    ircReset: ircResetNotice(Number((row as { irc_reset_notice?: number } | null)?.irc_reset_notice) || 0),
    isFounder: isFounder(account),
    // Drives the sidebar's "Add your phone" shortcut. Device names come from userAgentDetails.
    hasPhone: !!db.query("SELECT 1 FROM sessions WHERE nick = ? COLLATE NOCASE AND (device LIKE '% · iOS' OR device LIKE '% · Android') LIMIT 1").get(account.nick),
    nick: account.nick,
    email: account.email,
    // The browser never holds the IRC password: the relay (relay.ts) logs it into Ergo on the
    // socket's behalf. Was `ircPassword: account.ircPassword` before the relay existed.
    channels: joined,
    // Configured open channels have no membership row, so their visibility is server metadata, not
    // a client-side guess. Only public names are listed; secret names the caller cannot read never are.
    openChannels,
    ...(slircMode() === "public_playground" ? { openRoom: openRoom() } : {}),
    // Where people land when the channel they had open is deleted.
    defaultChannel: defaultChannel() || null,
    irc: ircConnectionMeta(),
    directs,
    contacts,
    accountDetails: accountDetails([account.nick, ...contacts, ...directs.map((item) => item.nick)]),
    availableChannels: channelDetails.filter((item) => item.visibility === "workspace" && !item.archived && !joined.includes(item.channel)),
    // Old #t- thread channels are retired; reply threads travel inside their channel.
    threads: [],
    channelDetails,
    avatarUrl: profileJson(account.nick).avatarUrl,
    profile: { ...profileJson(account.nick), email: account.email },
    role: account.role,
  });
});

app.get("/api/contacts", (c) => {
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const nick = requester.nick;
  const contacts = sharedContacts(nick);
  return c.json({ contacts, accountDetails: accountDetails(contacts) });
});

// The browser reports its IANA zone so @remind reads "tomorrow 9:00" and words confirmations on the
// asker's clock. Same-origin JSON only; the zone is validated before it is stored.
app.put("/api/time-zone", async (c) => {
  c.header("Cache-Control", "no-store");
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  if (!account || account.kind !== "human") return c.json({ error: "sign in required" }, 401);
  if (!sameOriginJson(c, "X-Slirc-Time-Zone")) return c.json({ error: "same-origin request required" }, 403);
  const body = await c.req.json().catch(() => ({})) as { timeZone?: unknown };
  if (!validTimeZone(body.timeZone) || !setUserTimeZone(account.id, body.timeZone)) return c.json({ error: "valid time zone required" }, 400);
  return c.json({ timeZone: body.timeZone });
});

app.route("/", links);

// Founder-only welcome control and queue. Everyone else gets 404, so the setting and the queue
// are invisible and unusable to them; the opt-in is never inferred from role alone.
app.get("/api/welcome", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  return c.json({ enabled: welcomeEnabled(), pending: welcomeJobs(account!).length });
});

app.put("/api/welcome", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
  setWelcomeEnabled(account!, body.enabled);
  return c.json({ enabled: welcomeEnabled() });
});

app.get("/api/welcome/jobs", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  // `enabled` lets the founder's client ack an already-sent row while refusing to claim or send
  // once the switch is off.
  return c.json({ enabled: welcomeEnabled(), jobs: welcomeJobs(account!) });
});

app.post("/api/welcome/jobs/:id/claim", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  if (!welcomeEnabled()) return c.json({ error: "welcomes are off" }, 409);
  const claimId = claimWelcomeJob(account!, c.req.param("id"));
  if (!claimId) return c.json({ error: "already claimed" }, 409);
  return c.json({ claimId });
});

app.post("/api/welcome/jobs/:id/delivered", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { claimId?: unknown; msgid?: unknown };
  const claimId = typeof body.claimId === "string" ? body.claimId : "";
  const msgid = typeof body.msgid === "string" && body.msgid ? body.msgid : null;
  if (!claimId) return c.json({ error: "claimId required" }, 400);
  if (!markWelcomeDelivered(account!, c.req.param("id"), claimId, msgid)) return c.json({ error: "not the claim owner" }, 409);
  return c.json({ ok: true });
});

// Only a refused or never-enqueued delivery returns a job to pending. An uncertain send keeps its
// claim, so another device cannot silently re-send a message that may already exist.
app.post("/api/welcome/jobs/:id/release", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { claimId?: unknown };
  const claimId = typeof body.claimId === "string" ? body.claimId : "";
  if (!claimId) return c.json({ error: "claimId required" }, 400);
  if (!releaseWelcomeJob(account!, c.req.param("id"), claimId)) return c.json({ error: "not the claim owner" }, 409);
  return c.json({ ok: true });
});

// Signed-out preview of #open-chat on the public playground (peek.ts). Any other channel, and
// every channel on a private workspace, is not found, signed in or not.
const peekLimit = createLimiter({ limit: 120, windowMs: 10 * 60_000 });
const peek = createPeek();
// Folded nicks of the authors in the last peek answer: a signed-out visitor may load their avatars
// and nobody else's, so /avatars never becomes a directory of the instance.
let peekAuthors = new Set<string>();
const PEEK_URL = /https?:\/\/[^\s<>"]+/g;
// What the transcript needs beyond the text, read only from what the server already holds: the
// poll cards' counts (no voter names, no "mine"), link previews a member already fetched, and the
// photo version of each author who has one.
function peekExtras(channel: string, messages: PeekMessage[]) {
  const polls: Record<number, unknown> = {};
  if (enabledHelpers().includes("poll")) {
    for (const message of messages) {
      if (message.poll?.kind !== "card" || message.nick.toLowerCase() !== "poll") continue;
      const poll = pollById(message.poll.id);
      if (!poll || normalized(poll.channel) !== channel) continue;
      const view = pollView(poll, "", false);
      polls[poll.id] = { ...view, mine: [], options: view.options.map(({ label, count }) => ({ label, count })) };
    }
  }
  const embeds: Record<string, Record<string, string>> = {};
  for (const message of messages) {
    for (const found of message.text.match(PEEK_URL) ?? []) {
      for (const url of new Set([found, found.replace(/[).,!?:;'\]]+$/, "")])) {
        let href = url;
        try { href = new URL(url).href; } catch { continue; }
        const meta = embedCache.get(href) ?? embedCache.get(url);
        if (meta && Object.keys(embeds).length < 32) embeds[url] = meta;
      }
    }
  }
  const avatars: Record<string, number> = {};
  for (const nick of new Set(messages.map((message) => message.nick))) {
    const version = avatarVersion(db.query("SELECT avatar_path, avatar_version FROM profiles WHERE account = ?").get(knownAccount(nick) || nick) as { avatar_path: string | null; avatar_version: number | null } | null);
    if (version) avatars[nick.toLowerCase()] = version;
  }
  return { polls, embeds, avatars };
}
app.get("/api/peek/:channel", async (c) => {
  c.header("Cache-Control", "no-store");
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  if (!peekable(channel)) return c.json({ error: "channel not found" }, 404);
  if (!peekLimit.check(peerKey(c))) return c.json({ error: "Too many requests. Try again later." }, 429);
  try {
    const messages = (await peek(channel)) ?? [];
    peekAuthors = new Set(messages.map((message) => message.nick.toLowerCase()));
    return c.json({ channel, messages, ...peekExtras(channel, messages) });
  } catch (error) {
    console.error(`peek failed for ${channel}:`, error instanceof Error ? error.message : error);
    return c.json({ error: "Could not load messages." }, 503);
  }
});

app.get("/push/public-key", (c) => c.json({ publicKey: vapidKeys().publicKey }));

app.post("/push/subscribe", async (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => ({}));
  if (body.accountId !== undefined && body.accountId !== accountByNick(nick)?.id) return c.json({ error: "Account changed. Reload before updating notifications." }, 409);
  const sub = body.subscription;
  const preference = ["all", "mentions", "none"].includes(body.preference) ? body.preference : "all";
  if (typeof sub?.endpoint !== "string" || typeof sub?.keys?.p256dh !== "string" || typeof sub?.keys?.auth !== "string") {
    return c.json({ error: "invalid subscription" }, 400);
  }
  db.query(`INSERT INTO subscriptions (endpoint, nick, p256dh, auth, preference, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET nick=excluded.nick, p256dh=excluded.p256dh,
              auth=excluded.auth, preference=excluded.preference, updated_at=excluded.updated_at`)
    .run(sub.endpoint, nick, sub.keys.p256dh, sub.keys.auth, preference, Date.now());
  // The toggle is per person, not per device: one switch, every browser.
  db.query("INSERT INTO notification_prefs (nick, preference) VALUES (?, ?) ON CONFLICT(nick) DO UPDATE SET preference = excluded.preference")
    .run(nick, preference);
  return c.body(null, 204);
});

app.post("/push/preference", async (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || !["all", "mentions", "none"].includes(body.preference)) return c.json({ error: "invalid preference" }, 400);
  if (body.accountId !== account.id) return c.json({ error: "Account changed. Reload before updating notifications." }, 409);
  db.query("INSERT INTO notification_prefs (nick, preference) VALUES (?, ?) ON CONFLICT(nick) DO UPDATE SET preference = excluded.preference")
    .run(account.nick, body.preference);
  return c.body(null, 204);
});

app.get("/push/preference", (c) => {
  c.header("Cache-Control", "no-store");
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const row = db.query("SELECT preference FROM notification_prefs WHERE nick = ?").get(nick) as { preference: string } | null;
  const fingerprint = c.req.query("subscription");
  const subscribed = fingerprint ? (db.query("SELECT endpoint FROM subscriptions WHERE nick = ?").all(nick) as { endpoint: string }[]).some((row) => hash(row.endpoint) === fingerprint) : undefined;
  return c.json({ preference: row?.preference || "all", ...(fingerprint ? { subscribed } : {}) });
});

app.route("/", embeds);

app.route("/", uploads);

// Read once at start so a bad SLIRC_EMOJI_BUDGET_BYTES stops the app instead of the first add.
emojiBudgetBytes();

app.route("/", channels);

// OSS project channels: bind one GitHub repository to one Slirc channel. The creator becomes the
// maintainer, the channel is provisioned like any workspace channel, and the webhook secret is
// returned once here and never by the listing below.
const projectCreateLimit = createLimiter({ limit: 20, windowMs: 60_000 });
app.post("/api/projects", bodyLimit({ maxSize: 8_192 }), async (c) => {
  if (!sameOriginJson(c, "X-Slirc-Projects")) return c.json({ error: "same-origin request required" }, 403);
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!projectCreateLimit.check(account.id)) return c.json({ error: "Too many project bindings. Try again in a minute." }, 429);
  const body = await c.req.json().catch(() => ({}));
  const repo = parseRepo(body.repo);
  if (!repo) return c.json({ error: "Use a GitHub repository as owner/repo." }, 400);
  if (projectBinding(repo)) return c.json({ error: "That repository already has a channel." }, 409);

  const candidates = channelCandidates(repo).filter((candidate) => !/^#(?:t|dm|g)-/i.test(candidate) && !isOpenChannel(candidate));
  if (!candidates.length) return c.json({ error: "That repository cannot use a reserved or open channel name." }, 400);

  let channel = "";
  try {
    for (const candidate of candidates) {
      const info = channelInfo(candidate);
      // A room the caller already owns is adopted; anyone else's room is never taken over.
      if (info && info.owner === account.nick && info.visibility === "workspace") { channel = candidate; break; }
      if (info || await ircChannelExists(candidate)) continue;
      await createChannel(candidate, account.nick, "workspace");
      db.transaction(() => {
        db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, ?, ?)").run(candidate, account.nick, "workspace", Date.now());
        db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(candidate, account.nick);
      })();
      channelsChanged(candidate, [account.nick], true);
      void opAdmins(candidate);
      channel = candidate;
      break;
    }
    if (!channel) return c.json({ error: "No free channel name for that repository." }, 409);
    const binding = bindProject(channel, repo, account.nick);
    return c.json({
      channel,
      repo: repoLabel(repo),
      webhookUrl: `${appOrigin(c.req.header("Host"))}/api/webhooks/github/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      webhookSecret: binding.webhookSecret,
    }, 201);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error))) return c.json({ error: "That repository already has a channel." }, 409);
    return appError(c, error, "Could not create the project channel.");
  }
});

app.get("/api/projects", (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const visible = new Set([...memberChannels(account.nick), ...openChannels]);
  return c.json({
    projects: projectBindings()
      .filter((binding) => visible.has(binding.channel))
      .map(({ channel, repo, creatorNick, createdAt }) => ({ channel, repo, creatorNick, createdAt })),
  });
});

// GitHub deliveries are signed with the binding's secret, so this route needs no session. Raw bytes
// are read before any JSON parse: the signature covers the exact bytes, not a re-serialized payload.
const githubWebhookIpLimit = createLimiter({ limit: 60, windowMs: 60_000 });
const githubWebhookRepoLimit = createLimiter({ limit: 30, windowMs: 60_000 });
const MAX_GITHUB_DELIVERIES = 2_000;
const seenGithubDeliveries = new Set<string>();
function claimGithubDelivery(key: string): boolean {
  if (!key) return true;
  if (seenGithubDeliveries.has(key)) return false;
  seenGithubDeliveries.add(key);
  if (seenGithubDeliveries.size > MAX_GITHUB_DELIVERIES) {
    const oldest = seenGithubDeliveries.values().next().value;
    if (oldest !== undefined) seenGithubDeliveries.delete(oldest);
  }
  return true;
}

app.use("/api/webhooks/github/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
app.post("/api/webhooks/github/:owner/:repo", async (c) => {
  if (!githubWebhookIpLimit.check(pairingIp(c))) return c.json({ error: "Too many webhook deliveries." }, 429);
  const repo = parseRepo(`${c.req.param("owner")}/${c.req.param("repo")}`);
  const binding = repo ? projectBinding(repo) : null;
  if (!binding) return c.json({ error: "unknown repository" }, 404);
  if (!githubWebhookRepoLimit.check(binding.repo.toLowerCase())) return c.json({ error: "Too many webhook deliveries." }, 429);
  const rawBytes = Buffer.from(await c.req.arrayBuffer());
  if (!verifyGithubSignature(binding.webhookSecret, rawBytes, c.req.header("X-Hub-Signature-256") || "")) {
    return c.json({ error: "invalid signature" }, 401);
  }
  const deliveryId = (c.req.header("X-GitHub-Delivery") || "").trim();
  const deliveryKey = deliveryId ? `${binding.repo.toLowerCase()}:${deliveryId}` : "";
  if (deliveryKey && !claimGithubDelivery(deliveryKey)) {
    return c.json({ duplicate: true }, 200);
  }
  let payload: unknown = null;
  try { payload = JSON.parse(rawBytes.toString("utf8")); } catch {}
  const message = formatGithubEvent(c.req.header("X-GitHub-Event") || "", payload, binding.repo);
  if (!message) return c.json({ ignored: true }, 202);
  try {
    await postNote(binding.channel, message);
    return c.json({ posted: true, channel: binding.channel }, 202);
  } catch (error) {
    if (deliveryKey) seenGithubDeliveries.delete(deliveryKey);
    return appError(c, error, "Could not post the GitHub update.");
  }
});

app.route("/", joinlinks);

// The docs site is served by Caddy from app/public on its own host; see caddy/slirc.caddy.
// Client shell: the one index.html document is served directly at every canonical route, with
// head injection for the pieces the shared template cannot know about. No boot.html wrapper.
function injectCandidateHead(html: string): string {
  const head: string[] = [];
  if (!/rel="manifest"/.test(html)) head.push('<link rel="manifest" href="/manifest.webmanifest" />');
  if (!html.includes("sw-register.js")) head.push('<script src="/sw-register.js"></script>');
  return head.length ? html.replace("</head>", `${head.join("")}</head>`) : html;
}
// The shell says whether this workspace has an icon, and which one, so the client asks
// /api/workspace-icon only when there is one: a missing icon is a 404 the console reports.
function injectWorkspaceIcon(html: string): string {
  const version = workspaceIconVersion();
  return version ? html.replace("</head>", `<meta name="slirc-workspace-icon" content="${version}" /></head>`) : html;
}
async function clientShell(c: Context) {
  const html = await Bun.file("./public/index.html").text();
  c.header("Cache-Control", "no-cache");
  return c.html(await versionShell(injectWorkspaceIcon(injectCandidateHead(html))));
}
const serveShell = clientShell;

async function clientBundle(c: Context) {
  const build = await buildClient();
  if (!build) return c.text("Client build failed. Check app log.", 503);
  c.header("Cache-Control", await assetCacheControl("/client.js", c.req.query("v")));
  return c.body(build.body, 200, { "Content-Type": "text/javascript; charset=utf-8" });
}

// Phone tabs are routes (/ is Home, /dms, /more) so a reload lands where you were.
for (const tab of ["/", "/dms", "/more"]) {
  app.get(tab, clientShell);
}
// Public rooms route the app on their own paths; the HTML does not wait on IRC 001.
const PUBLIC_ROOM_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const publicRoomPaths = () => new Set(
  ["open-chat", "help", ...openChannels.map((channel) => channel.replace(/^#/, "")), openRoom().replace(/^#/, "")]
    .map((slug) => slug.toLowerCase())
    .filter((slug) => PUBLIC_ROOM_SLUG.test(slug)),
);
const isPublicRoomNext = (next: string) =>
  next.startsWith("/") && !next.slice(1).includes("/") && publicRoomPaths().has(next.slice(1).toLowerCase());
for (const pub of publicRoomPaths()) app.get(`/${pub}`, serveShell);
// Static docs site: /docs and /docs/<guide> serve directory index.html files.
for (const doc of ["", "about", "agents", "bots", "channels", "clients", "comparison", "getting-started", "messages", "notifications", "privacy", "threads"]) {
  const path = doc ? `/docs/${doc}` : "/docs";
  const file = doc ? `/docs/${doc}/index.html` : "/docs/index.html";
  app.get(path, serveStatic({ root: "./public", rewriteRequestPath: () => file }));
  app.get(`${path}/`, serveStatic({ root: "./public", rewriteRequestPath: () => file }));
}
// First steps for a new member, linked from the help DM. Public, no account data: the page names
// this instance and its IRC server, both from server config, never from the request Host.
app.get("/welcome", async (c) => {
  const irc = ircConnectionMeta();
  // Only released harnesses are named as working; the agent package's registry is the one list.
  const today = offeredHarnesses().map((harness) => harness.name);
  const named = today.length < 2 ? today.join("") : `${today.slice(0, -1).join(", ")} and ${today.at(-1)}`;
  const agentsToday = today.length ? `${named} ${today.length > 1 ? "work" : "works"} today.` : "";
  const fill: Record<string, string> = { host: instanceHost(), ircHost: irc.host, ircPort: String(irc.port), agentsToday };
  let html = await Bun.file("./public/welcome.html").text();
  // No advertised IRC server: drop the card rather than show a blank address.
  if (!irc.host || irc.local) html = html.replace(/<li data-irc>[\s\S]*?<\/li>/, "");
  // Agents off on this instance, or none shipped: no agent card.
  if (!agentSessionCapabilities.enabled || !today.length) html = html.replace(/<li data-agents>[\s\S]*?<\/li>/, "");
  html = html.replace(/\{\{(host|ircHost|ircPort|agentsToday)\}\}/g, (_, key: string) => escapeHtml(fill[key]));
  c.header("Cache-Control", "no-cache");
  return c.html(await versionShell(html));
});
// Universal Links. iOS opens these paths in the Slirc app instead of Safari when the app is
// installed and its entitlement names this host. Apple's CDN fetches the file from every such host
// and follows no redirects. The paths are the links people get by email, QR code or chat: the
// workspace root, where a message link keeps its room in the fragment, DMs, phone pairing, join and
// invitation links, sign-in links and admission links. Docs and every other page stay in the browser.
const APPLE_APPLINK_COMPONENTS = ["/", "/dm/*", "/pair", "/pair/*", "/j/*", "/join/*", "/auth/verify", "/admission"].map((path) => ({ "/": path }));

export function appleAppIds(raw = process.env.APPLE_APP_IDS): string[] {
  return (raw || "").split(",").map((id) => id.trim()).filter(Boolean);
}

app.get("/.well-known/apple-app-site-association", (c) => {
  const appIDs = appleAppIds();
  if (!appIDs.length) return c.notFound();
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ applinks: { details: [{ appIDs, components: APPLE_APPLINK_COMPONENTS }] } });
});
// llms.txt convention: agents look at the site root first.
app.get("/llms.txt", (c) => c.redirect("/docs/llms.txt", 302));
app.get("/join/:token", serveShell);
app.get("/admission", serveShell);
for (const route of ["/profile", "/settings", "/channels", "/invitations", "/prelaunch", "/clients", "/agents", "/admin"]) app.get(route, clientShell);
// A direct-message link is /dm/<nick>, a channel is /#<channel>.
// Your own nick is not a DM: /dm/<you> opens your Notes.
app.get("/dm/:nick", async (c) => {
  const nick = currentUser(c);
  if (nick && nick.toLowerCase() === c.req.param("nick").toLowerCase()) return c.redirect("/notes", 302);
  return serveShell(c);
});
app.get("/notes", serveShell);
// Phone pairing by QR lands here with the token in the fragment. This GET only serves the shell and
// never signs anyone in: page script POSTs the token, so previews and scanners cannot spend an offer.
app.get("/pair", serveShell);
// Pairing from the link lands on the root query the client reads, not a client path.
app.get("/pair/:code", (c) => c.redirect(`/?pair=${encodeURIComponent(c.req.param("code"))}`, 302));

app.get("/client.js", clientBundle);
app.get("/video-encode.js", async (c) => {
  const build = await buildVideoEncode();
  if (!build) return c.text("Video encoder build failed. Check app log.", 503);
  c.header("Cache-Control", await assetCacheControl("/video-encode.js", c.req.query("v")));
  return c.body(build.body, 200, { "Content-Type": "text/javascript; charset=utf-8" });
});
// Keep installed clients' bootstrap URL pointed at the current shell.
app.get("/index.html", clientShell);

// Old installed clients update through /sw.js. Retire shell caches without touching drafts or outbox.
app.get("/boot.html", (c) => c.redirect("/", 302));
app.get("/sw.js", async (c) => c.body(await Bun.file("./public/sw.js").text(), 200, { "Content-Type": "text/javascript; charset=utf-8" }));

// Dev-only: serve the stylesheet with the coarse-pointer queries widened, so ?phone=1 shows the phone
// layout in a desktop browser. Rewriting is what makes this work at all: the `not (pointer: coarse)`
// blocks have to be neutralised too, and a second stylesheet cannot un-apply them.
app.get("/style.css", async (c, next) => {
  const forced = devLinks && (c.req.header("Cookie") || "").includes("slirc_phone=1");
  if (!forced) return next();
  const css = await Bun.file("./public/style.css").text();
  const phone = css.replaceAll("(not (pointer: coarse))", "(not (min-width: 0))")
    .replaceAll("(pointer: coarse)", "(pointer: coarse), (min-width: 0)");
  c.header("Cache-Control", "no-store");
  return c.body(phone, 200, { "Content-Type": "text/css; charset=utf-8" });
});

app.get("*", serveStatic({ root: "./public" }));

export { app };

const port = Number(process.env.PORT || 8080);
// Bun closes idle keep-alive sockets after 10s by default. Safari reuses the dead
// socket for the next POST and surfaces "Load failed" instead of retrying. 255s is Bun's max.
// /irc is the authenticated IRC relay (relay.ts), mounted on the app's own origin in every
// environment.
const baseRelayDeps = {
  sessionByToken,
  ircPasswordFor: (nick: string) => accountByNick(nick)?.ircPassword,
  appOrigin: process.env.NODE_ENV === "test" && !process.env.APP_ORIGIN && !process.env.APP_HOST ? "" : configuredAppOrigin(),
  isAllowedClientOrigin: (origin: string | null | undefined) =>
    isAllowedClientOrigin(origin, { dev: devLinks || process.env.NODE_ENV === "development" || process.env.SLIRC_DEV_PROFILE === "slirc2" }),
  ergoHost: process.env.ERGO_HOST || "ergo",
  ergoPort: Number(process.env.ERGO_PORT || 6667),
  webircPass: process.env.ERGO_WEBIRC_PASS,
  mode: slircMode(),
  onLine: observeReplyLine,
};
const relayHandlers = relayWebsocketHandlers(baseRelayDeps);
if (process.env.NODE_ENV !== "test") {
  // One explicit continuity-gap reset owned by the app entrypoint (never an import side effect).
  resetAgentSessionState();
  for (const binding of db.query("SELECT * FROM agent_session_bindings WHERE status='ready'").all() as Binding[]) {
    void connectAgentTransport(binding).catch(() => console.error(`session transport unavailable for ${binding.id}`));
  }
}

// No IRC key, no start: every IRC password derives from it (irc-key.ts).
ircKey();
const server = process.env.NODE_ENV === "test" ? null : Bun.serve({
  port,
  idleTimeout: 255,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/irc") {
      return handleRelayUpgrade(
        req,
        "/irc",
        (r, options) => server.upgrade(r, options),
        { ...baseRelayDeps, appOrigin: appOrigin(req.headers.get("Host")) },
        server.requestIP(req)?.address || "127.0.0.1",
      );
    }
    return app.fetch(req, { server });
  },
  websocket: {
    open(ws) { relayHandlers.open(ws as any); },
    message(ws, raw) { relayHandlers.message(ws as any, raw); },
    close(ws) { relayHandlers.close(ws as any); },
  },
});
if (server) {
  const sweepTimer = setInterval(sweepExpired, 60_000);
  sweepTimer.unref();
  const agentPresenceTimer = setInterval(syncAgentPresence, 5_000);
  agentPresenceTimer.unref();
  const shutdown = async () => {
    await server.stop(true);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  console.log(`app listening on :${port}`);
}
