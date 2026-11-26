import { createHash, randomBytes, randomInt } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Hono, type Context, type Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "hono/bun";
import { needsOnboarding, onboardingDestination, queueOnboarding } from "./onboarding.ts";
import { claimWelcomeJob, enqueueWelcomeJob, founderAccount, isFounder, markWelcomeDelivered, releaseWelcomeJob, setWelcomeEnabled, welcomeEnabled, welcomeJobs } from "./founder-welcome.ts";
import { Resend } from "resend";
import { bulkMailRoom, countedMail, reserveSignup } from "./mail-count.ts";
import { createPeek, peekable, type PeekMessage } from "./peek.ts";
import { openRoom } from "./welcome.ts";
import { BULK_PREVIEW_MAX, BULK_SEND_MAX, bulkRowView, planBulkInvite } from "./bulk-invites.ts";
import { joinLinksHomeOnce, linksChannelsFor, linksHome } from "./links-collect.ts";
import { fetchFavicon } from "./links-fetch.ts";
import { hasCopy, imageKind, originalGone, storedCopy, storedImage, storedImageDims, storedPost } from "./links-images.ts";
import { canRemoveLink, linkFilterFacets, storedFavicon, storeFavicon, viewerHasSite, linkKey, visibleLinkByKey, deleteScopedLinks, renameLinksChannel, visibleLink, linkFacets, editLinkTopic, MAX_EDITED_TOPICS, linksEnabled, removeLink, searchLinks, SOURCES, type LinkQuery, type LinkRow } from "./links.ts";
import { OPEN_LINKS_PER_ADMIN, createJoinLink, joinLinkById, joinLinkByToken, joinLinkIdForInvite, joinLinkIdForInviteId, joinLinkState, joinLinkToken, listJoinLinks, markInviteFromLink, openJoinLinks, pendingLinkInvite, refundSend, releaseJoin, reserveJoin, reserveSend, revokeJoinLink } from "./join-links.ts";
import { db, vapidKeys } from "./db.ts";
import { assertDirectReadiness } from "./direct-readiness.ts";
import { normalizeProfileBadge } from "../shared/profile-badges.ts";
import { contactHelpers, emojiBudgetBytes, enabledHelpers, ergoOperUser, inactiveHelper, localDevLinks, slircMode, brandKind } from "./config.ts";
import { openDirectConversation } from "./direct.ts";
import { removeAgentAccount } from "./agent-accounts.ts";
import { accountIrcPassword, ircKey } from "./irc-key.ts";
import { BotError, botCount, botLimit, createBotAccount } from "./bot-accounts.ts";
import { BotEditError, editableBot, editBotMessage, validEditText } from "./bot-edit.ts";
import { directInviteEmail, inviteEmail, magicLinkEmail } from "./email.ts";
import { admissionEmail } from "./admissions-email.ts";
import { setUserTimeZone, validTimeZone } from "./reminders.ts";
import { admissionForToken, admissionList, approveApplication, beginRedemption, cancelAdmission, finalizeRedemption, recordAdmissionDelivery, redeemedAdmission, reissueAdmission, waitlistApplications, waitlistConfigured } from "./admissions.ts";
import { addCertificate, listCertificates, normalizeCertificateFingerprint, removeCertificate } from "./irc-certificates.ts";
import { announceLines, canClose as canClosePoll, checkPoll, closePoll, createPoll, isClosed as pollClosed, openPoll, pollById, pollView, setVotes, tallyLines, voteIn, votes, type Poll } from "./polls.ts";
import { agentCanReadChannel, asciiFold, channelInfo, defaultChannel, closeDirectConversation, deleteChannelTree, directConversation, directConversations, discoverableHuman, humanDiscovery, isMember, isOpenChannel, isValidNext, joinWorkspaceChannel, leaveChannel, memberChannels, normalized, openChannels, reopenDirectConversation, sharedContacts, threadChildren, visibleChannels } from "./rooms.ts";
import { canonicalMailbox, acceptEmailInvite, acceptEmailInviteById, beginConversationOperation, cancelEmailInvite, completeConversationOperation, createEmailInvite, emailInviteAllowance, emailInviteByToken, emailInviteLimit, inviteById, listEmailInvites, normalizeEmail, pendingEmailInvite, claimEmailInviteResend, finishEmailInviteResend, recordEmailInviteDelivery, reserveEmailInvites, settleEmailInvite } from "./email-invites.ts";
import { AdmissionAttemptStaleError, accountByEmail, accountByNick, allAccounts, rotateIrcPassword, cleanDisplayName, displayNameError, ergo, ircChannelExists, isRemovedEmail, markRemoved, markVerified, provisionAccount, provisionAdmissionIdentity, reserveAdmissionIdentity, validEmail, type Account } from "./accounts.ts";
import { helperSay, pollTag, queueHelperCatchUp, reminderOutcome, scheduleReminder, setPollChangeListener, tallyTag } from "./helper-bot.ts";
import { opAdmins } from "./admin-ops.ts";
import { createChannel, allowChannelAccess, grantChannelAccess, kickChannelMember, makeChannelOpen, makeChannelSecret, makeThreadChannelsSecret, removeFromThreadChannels, NotAuthorizedError, purgeChannelHistory, redactMessage, removeMemberFromIrc, revokeChannelAccess, setChannelMode, setChannelTopic, unregisterChannel, renameChannel } from "./grants.ts";
import { approve, createRequest, deliverOnce, deny, findByCode, PairingError, pendingForOwner, sweepExpired } from "./pairing.ts";
import { acceptedHarness, AGENT_VERSION, connectCommands, createConnectRequest, findOpenRequest, instanceHost, isBlocked, mintTicket, offeredHarnesses, openRequestById, recordDecision, recordFailure, redeemTicket, requestCard, requestForSecret, requestOwner, tieRequest } from "./agent-connect.ts";
import { agentAudience, agentMetadata, authenticateBinding, authorizedBindingById, bindLease, bindingMetadata, bindSession, hashAgentSecret, invalidateLease, provisionBinding, renameBinding, renewLease, updateBindingMetadata, validLease, type Binding } from "./agent-session.ts";
import { ownerAgentRequestStates, startRequest, acceptRefusal, acceptRequest, agentAttached, agentRuntimeConnected, forwardToAgent, syncAgentPresence, connectAgentTransport, disconnectAgentTransport, evictAgentRoomForNick, failRequest, introduceAgent, joinAgentRoomForNick, sendPendingReview, offeredRequests, readRoomHistory, replyToRequest, deleteOwnMessage, sendToRequest, resetAgentSessionState, subscribeAgent, wakeAgent } from "./agent-session-transport.ts";
import { cancelOffers, mintOffer, redeemOffer, redeemedSession } from "./pair-offers.ts";
import { channelsChanged, publish, publishWhere, subscribe } from "./live.ts";
import { observeReplyLine, replyThreadsFor } from "./reply-threads.ts";
import { closeSessionSockets, handleRelayUpgrade, relayWebsocketHandlers } from "./relay.ts";
import { directImageEmbed, parseOg } from "./og.ts";
import { fetchPublic, ResponseTooLarge } from "./safe-fetch.ts";
import { configuredAppOrigin, createLimiter, isAllowedClientOrigin, peerKey, trustedProxies } from "./request-security.ts";
import { addNote, deleteNote, editNote, listNotes, noteBody } from "./notes.ts";
import { postNote } from "./update-notes.ts";
import { bindProject, channelCandidates, formatGithubEvent, parseRepo, projectBinding, projectBindings, repoLabel, verifyGithubSignature } from "./github-projects.ts";
import { testflightUrl } from "./testflight.ts";
import { ANIMATED_EMOJI_LIMITS, canReadUploadChannel, IMAGE_LIMITS, normalizeUploadImage, PhotoError, sniffAnimatedEmoji, withUploadSlot, WORKSPACE_ICON_LIMITS, workspaceIconRenditions } from "./photo.ts";
import emojiRows from "../public/vendor/emoji.json" with { type: "json" };
import { escapeHtml } from "../shared/escape-html.ts";

assertDirectReadiness(db);

// Counted per day and kind (mail-count.ts) so the Resend free tier is not hit by surprise.
const resend = process.env.RESEND_API_KEY ? countedMail(new Resend(process.env.RESEND_API_KEY)) : null;
// Browsers cap persistent cookies at 400 days. Refresh this on every PWA load.
const sessionMaxAge = 60 * 60 * 24 * 400;
const serviceNicks = () => ["slirc", ergoOperUser()];
const devNick = process.env.DEV_IRC_NICK;
const devUser = devNick ? accountByNick(devNick) : null;
const sessionCookie = {
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
const acctCookie = { ...sessionCookie, httpOnly: false };

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const avatarDir = join(dirname(process.env.DB_PATH || "/data/chat.sqlite"), "avatars");

function knownAccount(value: string) {
  return accountByNick(value)?.nick;
}

// 0 means no photo (the generated initial). Photos stored before versions existed count as 1.
function avatarVersion(row: { avatar_path?: string | null; avatar_version?: number | null } | null | undefined) {
  return row?.avatar_path ? row.avatar_version || 1 : 0;
}

function versionedAvatarUrl(account: string, version: number) {
  return version ? `/avatars/${encodeURIComponent(account)}?v=${version}` : "";
}

async function cacheGravatar(account: string) {
  const record = accountByNick(account);
  const email = record?.email;
  if (!email || record.kind === "agent") return;
  const row = db.query("SELECT avatar_path, gravatar_checked_at FROM profiles WHERE account = ?").get(account) as { avatar_path: string | null; gravatar_checked_at: number | null } | null;
  if (row?.avatar_path || (row?.gravatar_checked_at && row.gravatar_checked_at > Date.now() - 7 * 86_400_000)) return;
  try {
    db.query("INSERT INTO profiles (account) VALUES (?) ON CONFLICT(account) DO NOTHING").run(account);
    const digest = createHash("md5").update(email).digest("hex");
    const response = await fetch(`https://www.gravatar.com/avatar/${digest}?d=404&s=320`, { signal: AbortSignal.timeout(5_000) });
    db.query("UPDATE profiles SET gravatar_checked_at = ? WHERE account = ?").run(Date.now(), account);
    const mime = response.headers.get("content-type")?.split(";", 1)[0] || "";
    if (!response.ok || !mime.startsWith("image/") || mime === "image/svg+xml") return;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2_000_000) return;
    await mkdir(avatarDir, { recursive: true });
    const path = join(avatarDir, account.toLowerCase());
    await Bun.write(path, bytes);
    db.query("UPDATE profiles SET avatar_path = ?, avatar_mime = ?, avatar_version = ? WHERE account = ?").run(path, mime, Date.now(), account);
  } catch (error) {
    console.error(`gravatar cache failed for ${account}:`, error instanceof Error ? error.message : error);
  }
}

function profileJson(account: string) {
  const row = db.query("SELECT full_name, about, availability, badge, avatar_path, avatar_version FROM profiles WHERE account = ?").get(account) as { full_name: string; about: string; availability: string; badge: string; avatar_path: string | null; avatar_version: number | null } | null;
  const member = db.query("SELECT MIN(created_at) AS created_at FROM sessions WHERE nick = ?").get(account) as { created_at: number | null } | null;
  const identity = accountByNick(account);
  return {
    account,
    fullName: row?.full_name || "",
    about: row?.about || "",
    availability: row?.availability || "",
    badge: normalizeProfileBadge(row?.badge),
    avatarUrl: versionedAvatarUrl(account, avatarVersion(row)),
    avatarVersion: avatarVersion(row),
    memberSince: member?.created_at || null,
    role: identity?.role || "member",
    kind: identity?.kind || "human",
    owner: identity?.owner || null,
    machine: identity?.machine || null,
  };
}

function accountDetails(nicks: string[]) {
  return [...new Set(nicks)].flatMap((nick) => {
    const account = accountByNick(nick);
    const profile = account ? db.query("SELECT availability, badge, avatar_path, avatar_version FROM profiles WHERE account = ?").get(account.nick) as { availability: string; badge: string; avatar_path: string | null; avatar_version: number | null } | null : null;
    return account ? [{ id: account.id, nick: account.nick, kind: account.kind, owner: account.owner, availability: profile?.availability || "", badge: normalizeProfileBadge(profile?.badge), avatarVersion: avatarVersion(profile), ...(account.kind === "agent" ? { attached: agentAttached(account.nick), agent: agentMetadata(account.nick) } : {}) }] : [];
  });
}

function sessionByCookieToken(token: string) {
  const tokenHash = hash(token);
  const row = db.query("SELECT nick FROM sessions WHERE token_hash = ?").get(tokenHash) as { nick: string } | null;
  return row ? { nick: row.nick, token, tokenHash, kind: "cookie" as const } : undefined;
}

const CLIENT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLIENT_TOKENS_PER_SESSION = 10;

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

function cookieSession(c: { req: { header: (name: string) => string | undefined } }) {
  const cookie = c.req.header("Cookie")?.match(/(?:^|; )(?:slirc_session|untitled_session)=([^;]+)/)?.[1];
  return cookie ? sessionByCookieToken(cookie) : undefined;
}

function clientBearerToken(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  return c.req.header("Authorization")?.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i)?.[1];
}

// Regular /api/* and /auth/* routes accept session cookies only. Bearer client tokens are
// restricted to GET /auth/me, POST /auth/logout, and /irc WebSocket upgrades.
function session(c: { req: { header: (name: string) => string | undefined } }) {
  return cookieSession(c);
}

function sessionOrBearer(c: { req: { header: (name: string) => string | undefined } }) {
  const fromCookie = cookieSession(c);
  if (fromCookie) return fromCookie;
  const bearer = clientBearerToken(c);
  return bearer ? sessionByClientToken(bearer) : undefined;
}

function closeClientTokensForSession(sessionHash: string) {
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
function revokeSession(tokenHash: string, nick: string): boolean {
  const deleted = db.query("DELETE FROM sessions WHERE token_hash = ? AND nick = ? COLLATE NOCASE").run(tokenHash, nick).changes;
  if (deleted) {
    closeSessionSockets(tokenHash);
    closeClientTokensForSession(tokenHash);
  }
  return deleted > 0;
}

function currentUser(c: { req: { header: (name: string) => string | undefined } }) {
  if (devUser) return devUser.nick;
  const row = session(c);
  if (!row || !accountByNick(row.nick)) return;
  return row.nick;
}

function verifiedHuman(c: { req: { header: (name: string) => string | undefined } }) {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  return account?.kind === "human" && account.verifiedAt ? account : null;
}

// Routes that create an account and start a session refuse cross-site requests: same Origin, a JSON
// body, and a custom header a plain form or no-cors fetch cannot send.
function sameOriginJson(c: any, header: string): boolean {
  try {
    const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.toLowerCase();
    const expectedOrigin = appOrigin(c.req.header("Host"));
    return !!c.req.header("Origin") && c.req.header("Origin") === expectedOrigin &&
      c.req.header(header) === "1" && contentType === "application/json";
  } catch { return false; }
}
const admissionCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Admission");
const invitationCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Invitation");
const signInCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Sign-In");

function admissionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name) ? name : null;
}

function userAgentDetails(userAgent = "") {
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
function completeFirstVerification(nick: string) {
  markVerified(nick);
  enqueueWelcomeJob(nick);
  closeSessionsForNick(nick);
  db.query("DELETE FROM sessions WHERE nick = ?").run(nick);
}

function startSession(c: any, nick: string) {
  if (!accountByNick(nick)?.verifiedAt) { closeSessionsForNick(nick); db.query("DELETE FROM sessions WHERE nick = ?").run(nick); }
  const token = randomBytes(32).toString("base64url");
  const { device } = userAgentDetails(c.req.header("User-Agent"));
  db.query("INSERT INTO sessions (token_hash, nick, created_at, device) VALUES (?, ?, ?, ?)").run(hash(token), nick, Date.now(), device);
  setCookie(c, "slirc_session", token, sessionCookie);
  setCookie(c, "slirc_acct", nick, acctCookie);
  return hash(token);
}

const devLinks = localDevLinks();

// One client bundle, built from source on first request and cached for the process lifetime. A
// deploy restarts the process, so the version hash tracks the served bytes; nothing is checked in.
// In devLinks mode the build runs per request: local edits to client/ are not necessarily Bun
// --watch module dependencies, so a per-process cache would serve stale code until a restart.
let clientBuild: Promise<{ version: string; body: string } | null> | undefined;
// The video encoder (WebCodecs plus Mediabunny's MP4 muxer) is its own minified bundle, loaded only
// when someone picks a video, so the chat client does not carry it.
let videoEncodeBuild: Promise<{ version: string; body: string } | null> | undefined;
// Short content hash of the served client bundle, the candidate's /api/version value.
export function clientVersion(bundle: string): string {
  return createHash("sha256").update(bundle).digest("hex").slice(0, 8);
}
function runClientBuild(entry = "./client/main.ts", minify = false) {
  return Bun.build({ entrypoints: [entry], target: "browser", minify })
    .then(async (build) => {
      if (!build.success || !build.outputs[0]) { console.error("client build failed", build.logs); return null; }
      const body = await build.outputs[0].text();
      return { version: clientVersion(body), body };
    })
    .catch(() => null);
}
export function buildClient() {
  // ponytail: build on request; a checked-in artifact can wait until build cost shows up.
  return devLinks ? runClientBuild() : (clientBuild ??= runClientBuild());
}
const buildVideoEncode = () => (devLinks ? runClientBuild("./client/video-encode.ts", true) : (videoEncodeBuild ??= runClientBuild("./client/video-encode.ts", true)));

// Every first-party file the shell loads is addressed with a short hash of its own bytes, so its
// address changes exactly when the file does. A browser or a proxy that kept the old file for
// hours then cannot pair it with new HTML: the new HTML asks for a different address.
const assetHashes = new Map<string, string>();
export async function assetVersion(path: string): Promise<string> {
  if (path === "/client.js") return (await buildClient())?.version || "";
  if (path === "/video-encode.js") return (await buildVideoEncode())?.version || "";
  // Local dev edits files under a running process, so nothing is remembered there.
  const known = devLinks ? undefined : assetHashes.get(path);
  if (known !== undefined) return known;
  if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.includes("..")) return "";
  const file = Bun.file(`./public${path}`);
  const hash = (await file.exists()) ? createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex").slice(0, 8) : "";
  assetHashes.set(path, hash);
  return hash;
}
const SHELL_ASSET = /\b(href|src)="(\/[A-Za-z0-9_./-]+\.(?:js|css|webmanifest|svg))(?:\?v=[^"#]*)?(#[^"]*)?"/g;
// Rewrites each script, stylesheet, manifest and SVG reference in a served page to carry the
// hash of the file as it is now. A `?v=` already in the markup is replaced, never trusted.
export async function versionShell(html: string): Promise<string> {
  const paths = [...new Set([...html.matchAll(SHELL_ASSET)].map((match) => match[2]!))];
  const versions = new Map<string, string>();
  for (const path of paths) versions.set(path, await assetVersion(path));
  const versioned = html.replace(SHELL_ASSET, (whole, attribute: string, path: string, fragment = "") => {
    const version = versions.get(path);
    return version ? `${attribute}="${path}?v=${version}${fragment}"` : whole;
  });
  // The client draws icons from the sprite by address; it reads the sprite's version from here.
  const sprite = await assetVersion("/icons/lucide/sprite.svg");
  // The same for the video encoder, which the client imports on demand.
  const video = await assetVersion("/video-encode.js");
  // The wordmark follows the instance; style.css swaps the lockup on data-brand and data-theme.
  const branded = versioned.replace(/<html\b/, `<html data-brand="${brandKind()}"`);
  const metas = (sprite ? `<meta name="slirc-sprite" content="${sprite}" />` : "") + (video ? `<meta name="slirc-video" content="${video}" />` : "");
  return metas ? branded.replace("</head>", `${metas}</head>`) : branded;
}
// A versioned address never changes its bytes, so it may be kept for a year. The same file asked
// for without its current version must be checked with the server every time.
const LONG_CACHE = "public, max-age=31536000, immutable";
async function assetCacheControl(path: string, version: string | undefined): Promise<string> {
  if (devLinks || !version) return "no-cache";
  return version === (await assetVersion(path)) ? LONG_CACHE : "no-cache";
}

// Plain-HTTP LAN links follow the request host. HTTPS always uses the configured origin.
const linkOrigin = (host?: string | null) => (devLinks && (process.env.APP_ORIGIN || "").startsWith("http://") && host ? `http://${host}` : undefined);

const appOrigin = (host?: string | null) => linkOrigin(host) || configuredAppOrigin();

// The code is hashed with the nick so equal digits for two people never share a row.
const codeHash = (nick: string, code: string) => hash(`${nick.toLowerCase()}:${code}`);

// Mints a sign-in link plus the 6-digit code mailed with it; sending lives in sendMagicLink.
// Both live on one magic_links row, so they expire together and using either burns both.
async function magicLinkUrl(account: NonNullable<ReturnType<typeof accountByNick>>, next = "/", host?: string | null): Promise<{ url: string; code: string } | undefined> {
  const now = Date.now();
  const recent = db.query("SELECT 1 FROM magic_links WHERE nick = ? AND created_at > ?").get(account.nick, now - 60_000);
  if (recent && !devLinks) return;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hash(token);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.query("DELETE FROM magic_links WHERE expires_at < ?").run(now);
  db.query("INSERT INTO magic_links (token_hash, nick, expires_at, created_at, code_hash) VALUES (?, ?, ?, ?, ?)")
    .run(tokenHash, account.nick, now + 15 * 60_000, now, codeHash(account.nick, code));
  const target = isValidNext(next) ? next : "/";
  const url = `${appOrigin(host)}/auth/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(target)}`;
  if (devLinks) console.log(`magic link for ${account.nick}: ${url} (code ${code})`);
  return { url, code };
}

async function sendMagicLink(account: NonNullable<ReturnType<typeof accountByNick>>, next = "/", host?: string | null): Promise<string | undefined> {
  const minted = await magicLinkUrl(account, next, host);
  if (!minted) return;
  const { url, code } = minted;
  if (devLinks) return url;
  if (!resend || !process.env.RESEND_FROM) return;
  const email = magicLinkEmail({ url, code, nick: account.nick, verified: !!account.verifiedAt, origin: appOrigin(host) });
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM,
    to: account.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
  }, { idempotencyKey: `magic-link/${hash(url)}` });
  if (error) console.error("magic link email failed:", error.message);
}

async function sendInvitationVerification(account: NonNullable<ReturnType<typeof accountByNick>>, token: string, host?: string | null) {
  const minted = await magicLinkUrl(account, `/join/${token}`, host);
  if (!minted) return { status: "limited" as const };
  if (devLinks) return { status: "sent" as const, devLink: minted.url };
  if (!resend || !process.env.RESEND_FROM) {
    db.query("DELETE FROM magic_links WHERE token_hash = ?").run(hash(new URL(minted.url).searchParams.get("token") || ""));
    return { status: "failed" as const };
  }
  const email = magicLinkEmail({ url: minted.url, code: minted.code, nick: account.nick, verified: !!account.verifiedAt, origin: appOrigin(host) });
  try {
    const { error } = await resend.emails.send({ from: process.env.RESEND_FROM, to: account.email,
      subject: email.subject, html: email.html, text: email.text }, { idempotencyKey: `invite-signup/${hash(token)}/${hash(minted.url)}` });
    if (error) {
      db.query("DELETE FROM magic_links WHERE token_hash = ?").run(hash(new URL(minted.url).searchParams.get("token") || ""));
      return { status: "failed" as const };
    }
    return { status: "sent" as const };
  } catch {
    return { status: "uncertain" as const };
  }
}

// Invitation emails name the sender by their profile name and verified address. The profile name is
// free text and lands in the subject header, so control characters (CR/LF) are flattened.
const inviterName = (nick: string) =>
  (db.query("SELECT full_name FROM profiles WHERE account = ?").get(nick) as { full_name: string | null } | null)?.full_name?.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim() || nick;

async function sendEmailInvite({ to, inviter, inviterEmail, destination, token, id, host }: {
  to: string; inviter: string; inviterEmail: string; destination: { type: "dm" | "channel" | "group"; channel: string | null };
  token: string; id: string; host?: string | null;
}): Promise<"sent" | "failed" | "uncertain"> {
  const url = `${appOrigin(host)}/join/${token}`;
  if (devLinks) {
    console.log(`invite link for ${to}: ${url}`);
    return "sent";
  }
  if (!resend || !process.env.RESEND_FROM) return "failed";
  const email = destination.type === "dm"
    ? directInviteEmail({ url, inviter, inviterEmail, origin: appOrigin(host) })
    : inviteEmail({ url, channel: destination.channel!, inviter, inviterEmail, origin: appOrigin(host) });
  try {
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM, to, subject: email.subject, html: email.html, text: email.text,
    }, { idempotencyKey: `invite/${id}/${hash(token)}` });
    if (error) {
      console.error("invite email failed:", error.message);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error("invite email outcome uncertain:", error instanceof Error ? error.message : error);
    return "uncertain";
  }
}

const app = new Hono();

// App failures answer 500, never 502: Cloudflare swaps an origin 502 for its own HTML page, so
// the client would lose the JSON message. The error is logged here because the reply may not say it all.
function appError(c: Context, error: unknown, fallback: string, extra: Record<string, unknown> = {}) {
  console.error(`${c.req.method} ${c.req.path} failed:`, error);
  return c.json({ error: error instanceof Error ? error.message : fallback, ...extra }, 500);
}

let ircDeviceChanges = Promise.resolve();
function serializeIrcDeviceChange<T>(work: () => Promise<T>): Promise<T> {
  // ponytail: one queue fits one app process; use a distributed lock if Slirc scales out.
  const change = ircDeviceChanges.then(work);
  ircDeviceChanges = change.then(() => {}, () => {});
  return change;
}

// The note people got from the derived-password migration (deploy A): their plain IRC
// clients, or the managed bots they own, need the new password. Bits of accounts.irc_reset_notice.
const IRC_RESET_CLIENTS = 1;
const IRC_RESET_BOTS = 2;
const ircResetNotice = (bits: number) => ({ clients: !!(bits & IRC_RESET_CLIENTS), bots: !!(bits & IRC_RESET_BOTS) });
function clearIrcResetNotice(nick: string, bit: number): void {
  db.query("UPDATE accounts SET irc_reset_notice = irc_reset_notice & ~? WHERE nick = ? COLLATE NOCASE").run(bit, nick);
}

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

// browser-session pairing
const pairPollLimit = createLimiter({ limit: 60, windowMs: 60_000 });
const pairApprovalLimit = createLimiter({ limit: 30, windowMs: 60_000 });
const pairingIp = peerKey;
app.use("/api/pair*", bodyLimit({ maxSize: 2_048 }));
app.use("/api/pair*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("Origin");
  if (c.req.method === "POST" && origin && origin !== appOrigin(c.req.header("Host"))) {
    return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  }
  return next();
});

// browser-session pairing
app.post("/api/pair", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid pairing request" }, 400);
  const ip = pairingIp(c);
  try {
    if (body.kind === "session") {
      const { browser, os } = userAgentDetails(c.req.header("User-Agent"));
      // The phone has the email typed by now; when it matches an account, only that account's
      // other browsers hear about the request, so nobody else gets asked to link a stranger.
      const known = typeof body.email === "string" && body.email ? accountByEmail(body.email) : null;
      const request = createRequest({ kind: "session", browser, os, ip, owner: known?.nick || "" });
      if (known) publish(known.nick, "pair-request", { code: request.code, browser, os, expiresAt: request.expiresAt });
      return c.json(request, 201);
    }
    // Agent pairing v1 (owner + machine + tool) is gone; agents redeem a connect code instead.
    return c.json({ error: "agent pairing moved to connect codes" }, 410);
  } catch (error) {
    if (error instanceof PairingError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// Phone pairing by QR (pair-offers.ts). A signed-in browser mints a one-time offer; the browser that
// redeems it is signed in as the same account with no confirmation, so these routes are strict:
// same Origin plus a header a form or no-cors fetch cannot send, and a limiter on each side.
const offerMintLimit = createLimiter({ limit: 60, windowMs: 60 * 60_000 });
// Every redeem attempt counts, failed or not, so guessing and replaying share one budget per peer.
const offerRedeemLimit = createLimiter({ limit: 20, windowMs: 10 * 60_000 });
const offerCsrf = (c: any) => {
  const origin = c.req.header("Origin");
  return !!origin && origin === appOrigin(c.req.header("Host")) && c.req.header("X-Slirc-Pair") === "1";
};

app.post("/api/pair/offer", (c) => {
  if (!offerCsrf(c)) return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  const account = verifiedHuman(c);
  const active = session(c);
  if (!account || !active) return c.json({ error: "not signed in" }, 401);
  if (!offerMintLimit.check(account.nick.toLowerCase())) return c.json({ error: "Too many codes. Try again later." }, 429);
  const offer = mintOffer(account.nick, active.tokenHash);
  // The token rides in the fragment, which browsers never send: it stays out of server, proxy and
  // CDN logs, and out of Referer.
  return c.json({ id: offer.id, url: `${appOrigin(c.req.header("Host"))}/pair#o=${offer.token}`, expiresAt: offer.expiresAt }, 201);
});

app.delete("/api/pair/offer", (c) => {
  if (!offerCsrf(c)) return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  const active = session(c);
  if (!active) return c.json({ error: "not signed in" }, 401);
  cancelOffers(active.tokenHash);
  return c.body(null, 204);
});

app.post("/api/pair/offer/redeem", async (c) => {
  if (!offerCsrf(c)) return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  if (!offerRedeemLimit.check(pairingIp(c))) return c.json({ error: "Too many attempts. Try again later." }, 429);
  // A browser that is already signed in keeps its session and the offer stays unspent. Otherwise a
  // pair link sent to someone could quietly switch their browser into the sender's account.
  if (currentUser(c)) return c.json({ signedIn: true, already: true });
  const body = await c.req.json().catch(() => null);
  const { browser, os } = userAgentDetails(c.req.header("User-Agent"));
  const redeemed = redeemOffer(body && typeof body === "object" ? (body as { token?: unknown }).token : null, { browser, os }, (nick) => startSession(c, nick));
  // browser and os come from a fixed vocabulary, never the raw User-Agent; the token is never logged.
  if (!redeemed) {
    console.log(`pair offer refused device=${browser}/${os}`);
    return c.json({ error: "That code is no longer valid. Show a new one and scan again." }, 400);
  }
  const account = accountByNick(redeemed.nick);
  console.log(`pair offer redeemed account=${redeemed.nick} device=${browser}/${os}`);
  publish(redeemed.nick, "pair-offer", { id: redeemed.id, browser, os });
  return c.json({ signedIn: true, accountId: account?.id, nick: redeemed.nick });
});

// "Not you? Sign it out" on the minting card: ends the one session that offer started.
app.delete("/api/pair/offer/:id/session", (c) => {
  if (!offerCsrf(c)) return c.json({ error: "cross-origin pairing is not allowed" }, 403);
  const account = verifiedHuman(c);
  const active = session(c);
  if (!account || !active) return c.json({ error: "not signed in" }, 401);
  const target = redeemedSession(c.req.param("id"), active.tokenHash);
  if (!target || target.nick.toLowerCase() !== account.nick.toLowerCase()) return c.json({ error: "session not found" }, 404);
  if (!revokeSession(target.sessionHash, account.nick)) return c.json({ error: "session not found" }, 404);
  return c.body(null, 204);
});

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

// browser-session pairing
app.get("/api/pair/pending", (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  // Codes are shown as "123 456"; a pasted one may keep the space.
  const code = (c.req.query("code") || "").replace(/\D/g, "");
  if (code && !pairApprovalLimit.check(nick)) return c.json({ error: "too many pairing attempts" }, 429);
  return c.json(pendingForOwner(nick, code));
});

// browser-session pairing
app.get("/api/pair/:code", (c) => {
  const ip = pairingIp(c);
  if (!pairPollLimit.check(ip)) return c.json({ error: "too many pairing checks" }, 429);
  const result = deliverOnce(c.req.param("code"), c.req.header("X-Pair-Secret") || "");
  return result ? c.json(result) : c.json({ error: "pairing request not found" }, 404);
});

app.get("/api/pair/:code/session", (c) => {
  const tokenHash = hash(c.req.query("token") || "");
  const request = db.query("SELECT owner FROM pair_requests WHERE code = ? AND kind = 'session' AND status = 'delivered' AND expires_at > ?")
    .get(c.req.param("code"), Date.now()) as { owner: string } | null;
  const link = request && db.query("SELECT nick, expires_at FROM magic_links WHERE token_hash = ?").get(tokenHash) as { nick: string; expires_at: number } | null;
  if (!request || !link || link.expires_at <= Date.now() || link.nick.toLowerCase() !== request.owner.toLowerCase()) return c.json({ error: "login token not found" }, 404);
  db.transaction(() => {
    db.query("DELETE FROM magic_links WHERE token_hash = ?").run(tokenHash);
    db.query("DELETE FROM pair_requests WHERE code = ?").run(c.req.param("code"));
    startSession(c, request.owner);
  })();
  // Both clients serve the app at the root, so a completed device link never lands on a client path.
  return c.redirect("/", 302);
});

// browser-session pairing
app.post("/api/pair/:code/allow", async (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  if (!pairApprovalLimit.check(owner)) return c.json({ error: "too many pairing attempts" }, 429);
  const request = findByCode(c.req.param("code").replace(/\s/g, ""));
  if (!request || request.status !== "pending") return c.json({ error: "pairing request not found" }, 404);
  if (request.kind !== "session") return c.json({ error: "agent pairing moved to connect codes" }, 410);
  if (!verifiedHuman(c)) return c.json({ error: "verified account required" }, 403);
  if (request.owner && request.owner.toLowerCase() !== owner.toLowerCase()) return c.json({ error: "pairing request belongs to another owner" }, 403);
  const loginToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  try {
    db.transaction(() => {
      db.query("INSERT INTO magic_links (token_hash, nick, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(hash(loginToken), owner, now + 5 * 60_000, now);
      if (!approve(request.code, owner, loginToken)) throw new Error("pairing request expired");
    })();
    return c.json({ nick: owner });
  } catch (error) {
    return appError(c, error, "Could not link browser.");
  }
});

// Session-bound pairing for the harnesses in the agent package's registry. Pi is proved end to end
// in test/agent-session-pi-proof.test.ts. The legacy connect protocol shares identities and exposes
// raw IRC credentials, so /api/agent/connect stays closed whatever this says.
// SLIRC_AGENTS_ENABLED=false turns pairing off for the instance: no requests are taken and the
// connect route refuses, so hiding the Agents page is not what enforces it.
const agentsEnabled = process.env.SLIRC_AGENTS_ENABLED !== "false";
export const agentSessionCapabilities = {
  enabled: agentsEnabled,
  reason: agentsEnabled ? "" : "Agents are off on this instance.",
};
export const AGENT_POLL_MAX_WAIT_S = 25;

export const AGENT_SSE_KEEPALIVE_MS = Number(process.env.AGENT_SSE_KEEPALIVE_MS) || 15_000;
const sessionConnectLimit = createLimiter({ limit: 10, windowMs: 60_000 });
const sessionProvisioning = new Map<string, Promise<Binding>>();
const bindingForRequest = (c: any) => authenticateBinding(c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1]);
const leaseForRequest = (c: any, binding: Binding) => {
  const lease = c.req.header("X-Slirc-Agent-Lease") || "";
  return validLease(binding, lease) ? lease : null;
};
const bindingJson = (binding: Binding) => ({
  instanceId: binding.instance_id, ownerAccountId: binding.owner_account_id, bindingId: binding.id,
  harness: binding.harness, sessionId: binding.session_id, sessionName: binding.session_name,
  nick: binding.nick, dm: binding.dm, status: binding.status,
});

async function provisionSessionBinding(binding: Binding): Promise<Binding> {
  const current = sessionProvisioning.get(binding.id);
  if (current) return current;
  const task = provisionBinding(binding).finally(() => sessionProvisioning.delete(binding.id));
  sessionProvisioning.set(binding.id, task);
  return task;
}

// Agent reply text is capped at 16,000 UTF-8 bytes; JSON escaping can roughly double it, so the
// body limit is set to accept any valid text while still bounding requests.
app.use("/api/agent/session/*", bodyLimit({ maxSize: 48_000 }));
app.use("/api/agent/session/*", async (c, next) => {
  if (!agentSessionCapabilities.enabled) {
    c.header("Cache-Control", "no-store");
    const status = c.req.path === "/api/agent/session/request" || c.req.path === "/api/agent/session/connect" ? 409 : 403;
    return c.json({ error: agentSessionCapabilities.reason, code: "disabled" }, status);
  }
  await next();
  // Session transport credentials and request contents must never enter HTTP caches.
  if (c.res.headers.has("Cache-Control")) return;
  const headers = new Headers(c.res.headers);
  headers.set("Cache-Control", "no-store");
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

const bearerSecret = (c: any) => c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] || "";
const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";

// Which slirc-agent this workspace expects. Public: the CLI asks before it changes anything.
app.get("/api/agent/version", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ version: AGENT_VERSION, enabled: agentSessionCapabilities.enabled, ...(agentSessionCapabilities.enabled ? {} : { reason: agentSessionCapabilities.reason }), harnesses: offeredHarnesses() });
});

// A session asks to be paired. It gets a link and a code to show its owner, and then polls
// /connect with the same secret until someone allows or denies it.
app.post("/api/agent/session/request", async (c) => {
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason, code: "disabled" }, 409);
  const secret = bearerSecret(c);
  const body = await c.req.json().catch(() => null);
  if (!secret || !body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid session connect request" }, 400);
  if (!acceptedHarness(body.harness) || body.protocol !== 1 || typeof body.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId) || typeof body.sessionFile !== "string" || !body.sessionFile || body.sessionFile.length > 2048) {
    return c.json({ error: "This agent can't connect to Slirc yet.", code: "unsupported" }, 400);
  }
  if (typeof body.version === "string" && body.version.split(".")[0] !== AGENT_VERSION.split(".")[0]) {
    const { npx } = connectCommands();
    return c.json({ error: `This Slirc extension is ${body.version} and ${instanceHost()} needs ${AGENT_VERSION}. Run ${npx} in a terminal to update it.`, code: "update" }, 426);
  }
  const ip = pairingIp(c);
  if (!sessionConnectLimit.check(ip)) return c.json({ error: "Too many connect attempts. Wait a minute, then type /slirc again.", code: "throttled" }, 429);
  const secretHash = hashAgentSecret(secret);
  if (authenticateBinding(secret) || requestForSecret(secretHash)?.decision === "allow") return c.json({ bound: true });
  const created = createConnectRequest(secretHash, {
    harness: body.harness, sessionId: body.sessionId, sessionFile: body.sessionFile,
    sessionName: text(body.sessionName, 120), repo: text(body.repo, 2048) || null, model: text(body.model, 200) || null,
    provider: text(body.provider, 200) || null, machine: text(body.machine, 120) || "unknown",
  });
  // A ticket (the connect code in the Agents page's command) names the person waiting there: their
  // page shows the Allow card at once. One that expired, another session holds, or Slirc doesn't
  // know is answered with connectCode: "expired" so the session can say so; the link and code
  // still work.
  const ticketOwner = redeemTicket(body.ticket, secretHash);
  if (ticketOwner) {
    tieRequest(created.id, ticketOwner, created.expiresAt);
    const open = openRequestById(created.id);
    if (open) publish(ticketOwner, "agent-connect-request", requestCard(open));
  }
  c.header("Cache-Control", "no-store");
  return c.json({ url: `${appOrigin(c.req.header("host"))}/agents#connect=${created.token}`, code: created.code, expiresAt: created.expiresAt,
    ...(body.ticket !== undefined && !ticketOwner ? { connectCode: "expired" } : {}) });
});

// The session polls here until its request is decided, then gets its binding.
app.post("/api/agent/session/connect", async (c) => {
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason, code: "disabled" }, 409);
  const secret = bearerSecret(c);
  const body = await c.req.json().catch(() => ({}));
  if (!secret) return c.json({ error: "invalid session connect request" }, 400);
  // slirc-agent 2.x sends the six-digit code Slirc used to show.
  if (typeof body?.code === "string") {
    const { npx } = connectCommands();
    return c.json({ error: `Slirc changed how agents connect. Run ${npx} in a terminal, then type /slirc in your session.`, code: "gone" }, 410);
  }
  const secretHash = hashAgentSecret(secret);
  const request = requestForSecret(secretHash);
  if (request?.decision === "deny") return c.json({ error: "Denied in Slirc. Type /slirc again if that was a mistake.", code: "denied" }, 403);
  let binding = db.query("SELECT * FROM agent_session_bindings WHERE secret_hash = ? AND status <> 'revoked'").get(secretHash) as Binding | null;
  if (!binding) {
    if (request) return c.json({ error: "Waiting for Allow in Slirc.", code: "owner_confirmation" }, 409);
    return c.json({ error: "The link expired before anyone allowed it. Type /slirc again for a new one.", code: "expired" }, 404);
  }
  try {
    if (binding.status !== "ready") binding = await provisionSessionBinding(binding);
    await connectAgentTransport(binding);
    c.header("Cache-Control", "no-store");
    return c.json(bindingJson(binding));
  } catch (error) {
    return appError(c, error, "agent provisioning failed", { bindingId: binding.id });
  }
});

app.get("/api/agent/session/binding", (c) => {
  const binding = bindingForRequest(c);
  if (!binding) return c.json({ error: "session binding required" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json(bindingJson(binding));
});

app.post("/api/agent/session/attach", async (c) => {
  const binding = bindingForRequest(c);
  if (!binding) return c.json({ error: "session binding required" }, 401);
  if (binding.status === "provisioning") return c.json({ error: "agent is still provisioning" }, 409);
  const body = await c.req.json().catch(() => null);
  const lease = body && typeof body.nonce === "string" ? bindLease(binding, body.nonce) : null;
  if (!lease) return c.json({ error: "session already attached or invalid nonce" }, 409);
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) updateBindingMetadata(binding, body.metadata);
  try {
    await connectAgentTransport(binding);
    const connected = agentRuntimeConnected(binding.id);
    if (connected) {
      introduceAgent(binding, lease.leaseId);
      sendPendingReview(binding, lease.leaseId);
    }
    return c.json({ ...lease, connected });
  } catch (error) {
    invalidateLease(binding.id, lease.leaseId);
    return appError(c, error, "agent IRC transport could not attach");
  } finally {
    syncAgentPresence();
  }
});

app.post("/api/agent/session/heartbeat", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && c.req.header("X-Slirc-Agent-Lease");
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const expiresAt = renewLease(binding, lease);
  return expiresAt ? c.json({ expiresAt }) : c.json({ error: "session lease expired" }, 409);
});

app.post("/api/agent/session/detach", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && c.req.header("X-Slirc-Agent-Lease");
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  invalidateLease(binding.id, lease);
  syncAgentPresence();
  return c.body(null, 204);
});

// Session name, repo folder and model as the adapter sees them now. Lease-bound, so only the live
// runtime of this binding can change what the owner and roommates are shown.
app.post("/api/agent/session/metadata", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "metadata object required" }, 400);
  return c.json({ agent: updateBindingMetadata(binding, body) });
});

// Read-only room history for the agent's own tool. Same access as delivery: its DM or a granted,
// live-verified secret room. Never a generic proxy: no other IRC command is reachable from here.
app.get("/api/agent/session/history", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const channel = c.req.query("channel") || binding.dm || "";
  const before = c.req.query("before") || "";
  if (!/^#[^\s,:]{1,200}$/.test(channel)) return c.json({ error: "invalid channel" }, 400);
  const cursor = !before ? "*" : /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(before) ? `timestamp=${before}` : /^[A-Za-z0-9_.:-]{1,128}$/.test(before) ? `msgid=${before}` : "";
  if (!cursor) return c.json({ error: "invalid before cursor" }, 400);
  const messages = await readRoomHistory(binding, lease, channel, cursor, Number(c.req.query("limit") || 50));
  if (!messages) return c.json({ error: "this agent cannot read that room" }, 403);
  return c.json({ channel: channel.toLowerCase(), messages });
});

app.get("/api/agent/session/events", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  return streamSSE(c, async (stream) => {
    let open = true;
    let wake: (() => void) | undefined;
    const unsubscribe = subscribeAgent(binding.id, () => { wake?.(); wake = undefined; });
    stream.onAbort(() => { open = false; wake?.(); wake = undefined; });
    // Proxies and fetch clients drop a stream that stays silent; a comment line keeps it open. The
    // first one goes out at once so the response headers flush and the adapter sees the stream open.
    let lastWrite = 0;
    let sentRename: string | null = null;
    try {
      while (open && validLease(binding, lease)) {
        // An owner rename goes to the live session once per stream; the adapter acks via metadata.
        const pending = (db.query("SELECT rename_pending FROM agent_session_bindings WHERE id=?").get(binding.id) as { rename_pending: string | null } | null)?.rename_pending ?? null;
        if (pending !== null && pending !== sentRename) {
          try { await stream.writeSSE({ event: "rename", data: JSON.stringify({ name: pending }) }); lastWrite = Date.now(); sentRename = pending; }
          catch { break; }
        }
        if (Date.now() - lastWrite >= AGENT_SSE_KEEPALIVE_MS) {
          try { await stream.write(": keepalive\n\n"); lastWrite = Date.now(); }
          catch { break; }
        }
        const requests = await offeredRequests(binding);
        // The privacy probes above are awaited; recheck the stream, lease and immutable binding
        // authorization before any content write. A correct accept gate never excuses disclosure.
        if (!open || !validLease(binding, lease) || !authorizedBindingById(binding.id)) break;
        if (requests.length) {
          try { await stream.writeSSE({ event: "requests", data: JSON.stringify(requests) }); lastWrite = Date.now(); }
          catch { break; }
        }
        await Promise.race([new Promise<void>((resolve) => { wake = resolve; }), new Promise<void>((resolve) => setTimeout(resolve, Math.min(5_000, AGENT_SSE_KEEPALIVE_MS)))]);
        wake = undefined;
      }
    } finally {
      open = false;
      unsubscribe();
    }
  });
});

// Requests and renames already handed to a polling lease, so a poll returns early only for news.
const polled = new Map<string, { lease: string; rename: string | null; requests: string }>();

// Long-poll twin of the events stream for adapters that cannot hold one open (Claude Code caps a
// fetch at 30 s). Same auth, lease and event objects. Each poll renews the lease, so a polling
// adapter stays attached while it polls and goes offline once polls stop for longer than the lease.
app.get("/api/agent/session/events/poll", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const asked = Number(c.req.query("wait") ?? AGENT_POLL_MAX_WAIT_S);
  const wait = Number.isFinite(asked) ? Math.max(0, Math.min(AGENT_POLL_MAX_WAIT_S, asked)) : AGENT_POLL_MAX_WAIT_S;
  const deadline = Date.now() + wait * 1000;
  const signal = c.req.raw.signal;
  const known = polled.get(binding.id);
  const seen = known?.lease === lease ? known : { lease, rename: null, requests: "" };
  let wake: (() => void) | undefined;
  const unsubscribe = subscribeAgent(binding.id, () => { wake?.(); wake = undefined; });
  const abort = () => { wake?.(); wake = undefined; };
  signal.addEventListener("abort", abort);
  renewLease(binding, lease);
  try {
    while (!signal.aborted && validLease(binding, lease)) {
      const events: { event: string; data: unknown }[] = [];
      const rename = (db.query("SELECT rename_pending FROM agent_session_bindings WHERE id=?").get(binding.id) as { rename_pending: string | null } | null)?.rename_pending ?? null;
      if (rename !== null && rename !== seen.rename) events.push({ event: "rename", data: { name: rename } });
      const requests = await offeredRequests(binding) as { id: string; revision: number }[];
      // Same recheck as the stream: the privacy probes are awaited, so no content after they lapse.
      if (signal.aborted || !validLease(binding, lease) || !authorizedBindingById(binding.id)) break;
      const key = JSON.stringify(requests.map((request) => [request.id, request.revision]));
      const last = Date.now() >= deadline;
      // New or changed requests return at once; ones this lease already has repeat once per window.
      if (requests.length && (key !== seen.requests || last)) events.push({ event: "requests", data: requests });
      if (events.length) {
        polled.set(binding.id, { lease, rename: rename ?? seen.rename, requests: key });
        renewLease(binding, lease);
        return c.json({ events });
      }
      seen.requests = key;
      if (last) break;
      await Promise.race([new Promise<void>((resolve) => { wake = resolve; }), new Promise<void>((resolve) => setTimeout(resolve, Math.min(5_000, Math.max(0, deadline - Date.now()))))]);
      wake = undefined;
    }
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", abort);
  }
  if (!validLease(binding, lease)) return c.json({ error: "session lease required" }, 401);
  renewLease(binding, lease);
  return c.body(null, 204);
});

app.get("/api/agent/session/requests/:id", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const request = db.query("SELECT id,revision,status,reply_msgid,lease_id FROM agent_session_requests WHERE id=? AND binding_id=?").get(c.req.param("id"), binding.id) as { id: string; revision: number; status: string; reply_msgid: string | null; lease_id: string | null } | undefined;
  return request ? c.json({ id: request.id, revision: request.revision, status: request.status, reply_msgid: request.reply_msgid, acceptedByLease: request.lease_id === lease }) : c.json({ error: "request not found" }, 404);
});

app.post("/api/agent/session/requests/:id/accept", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const revision = Number(body.revision);
  const result = await acceptRequest(binding, lease, c.req.param("id"), revision);
  if (result) return c.json(result);
  const reason = acceptRefusal(binding, c.req.param("id"), revision);
  return c.json({ error: reason === "busy" ? "another request is active" : "request is stale or no longer authorized", code: reason }, 409);
});

app.post("/api/agent/session/requests/:id/started", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  return startRequest(binding, lease, c.req.param("id"))
    ? c.json({ status: "working" }) : c.json({ error: "request is not active in this session" }, 409);
});

app.post("/api/agent/session/requests/:id/reply", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== "string") return c.json({ error: "reply text required" }, 400);
  try { return c.json({ status: await replyToRequest(binding, lease, c.req.param("id"), body.text) }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "reply failed" }, 409); }
});

// Another message to the request's room, before or after its reply. See sendToRequest.
app.post("/api/agent/session/requests/:id/send", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== "string") return c.json({ error: "message text required" }, 400);
  try { return c.json(await sendToRequest(binding, lease, c.req.param("id"), body.text)); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "message failed" }, 409); }
});

// Deletes one of the agent's own messages in the request's room. See deleteOwnMessage.
app.post("/api/agent/session/requests/:id/delete", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.messageId !== "string") return c.json({ error: "messageId required" }, 400);
  try { return c.json({ status: await deleteOwnMessage(binding, lease, c.req.param("id"), body.messageId) }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "delete failed" }, 409); }
});

app.post("/api/agent/session/requests/:id/fail", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  return c.req.json().catch(() => ({})).then(async (value: any) => {
    const reason = typeof value.reason === "string" ? value.reason.slice(0, 500) : "Agent could not complete this request.";
    try { return c.json({ status: await failRequest(binding, lease, c.req.param("id"), reason) }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "request failure could not be reported" }, 409); }
  });
});

app.post("/api/agent/session/requests/:id/confirm", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  return c.json({ error: "offline confirmation must come from the owner's authenticated DM" }, 403);
});

app.get("/api/agents/capabilities", (c) => {
  if (!currentUser(c)) return c.json({ error: "not signed in" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json({ ...agentSessionCapabilities, harnesses: offeredHarnesses(), commands: connectCommands() });
});

// A ticket for the command the Agents page copies. See mintTicket.
const ticketLimit = createLimiter({ limit: 20, windowMs: 10 * 60_000 });
app.post("/api/agents/connect-ticket", (c) => {
  if (!sameOriginJson(c, "X-Slirc-Connect")) return c.json({ error: "same-origin request required" }, 403);
  const person = verifiedHuman(c);
  if (!person) return c.json({ error: "Sign in to connect an agent." }, 401);
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason }, 409);
  if (!ticketLimit.check(`account:${person.nick.toLowerCase()}`)) return c.json({ error: "Too many tries. Wait a few minutes, then copy the command again." }, 429);
  c.header("Cache-Control", "no-store");
  return c.json(mintTicket(person.nick));
});

// The Allow card: a signed-in person opens a request by its link token or typed code. Wrong codes
// count against both the address and the account.
const requestOpenLimit = createLimiter({ limit: 30, windowMs: 60_000 });
app.post("/api/agents/requests/open", async (c) => {
  const person = verifiedHuman(c);
  if (!person) return c.json({ error: "Sign in to allow an agent." }, 401);
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason }, 409);
  const ip = pairingIp(c);
  const accountKey = `account:${person.nick.toLowerCase()}`;
  if (!requestOpenLimit.check(ip) || isBlocked(ip) || isBlocked(accountKey)) return c.json({ error: "Too many tries. Wait ten minutes, then try again." }, 429);
  const body = await c.req.json().catch(() => null);
  const found = findOpenRequest({ token: body?.token, code: body?.code });
  const tied = found && requestOwner(found.id);
  const request = tied && tied.toLowerCase() !== person.nick.toLowerCase() ? null : found;
  if (!request) {
    if (body?.token === undefined) { recordFailure(ip); recordFailure(accountKey); }
    return c.json({ error: body?.token === undefined ? "No session is waiting with that code. Check it against your terminal." : "This link has expired or was already used. Type /slirc in your session for a new one." }, 404);
  }
  c.header("Cache-Control", "no-store");
  return c.json(requestCard(request));
});

app.post("/api/agents/requests/:id", async (c) => {
  const person = verifiedHuman(c);
  if (!person?.id) return c.json({ error: "Sign in to allow an agent." }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.allow !== "boolean") return c.json({ error: "allow must be true or false" }, 400);
  const found = openRequestById(c.req.param("id"));
  const tied = found && requestOwner(found.id);
  const request = tied && tied.toLowerCase() !== person.nick.toLowerCase() ? null : found;
  if (!request) return c.json({ error: "This request has expired. Type /slirc in your session for a new one." }, 404);
  if (!body.allow) {
    recordDecision(request.id, "deny", null);
    return c.body(null, 204);
  }
  let binding: Binding;
  try {
    binding = db.transaction(() => {
      const made = bindSession({ owner: person.nick, ownerAccountId: person.id!, harness: request.harness, sessionId: request.sessionId, sessionFile: request.sessionFile,
        machine: request.machine, sessionName: request.sessionName, repo: request.repo, model: request.model, provider: request.provider, secretHash: request.secret_hash });
      if (!recordDecision(request.id, "allow", made.id)) throw new Error("This request was already decided.");
      return made;
    })();
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Could not allow this session." }, 409);
  }
  publish(person.nick, "agent-pending", { id: binding.id });
  // Provision now, so the session's next poll finds the agent ready.
  try { binding = await provisionSessionBinding(binding); } catch {}
  c.header("Cache-Control", "no-store");
  return c.json({ nick: binding.nick, dm: binding.dm, status: binding.status });
});

// Old clients must never mint a shared agent identity or receive IRC credentials.
app.post("/api/agent/connect", (c) => c.json({
  error: agentSessionCapabilities.enabled ? "This connect command is from an older Slirc. Open Agents in Slirc for the new one." : agentSessionCapabilities.reason,
}, 409));

// browser-session pairing
app.post("/api/pair/:code/deny", (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  if (!pairApprovalLimit.check(owner)) return c.json({ error: "too many pairing attempts" }, 429);
  const request = findByCode(c.req.param("code").replace(/\s/g, ""));
  if (!request || request.status !== "pending") return c.json({ error: "pairing request not found" }, 404);
  if (request.kind !== "session") return c.json({ error: "agent pairing moved to connect codes" }, 410);
  if (request.owner && request.owner.toLowerCase() !== owner.toLowerCase()) return c.json({ error: "pairing request belongs to another owner" }, 403);
  deny(request.code, owner);
  return c.body(null, 204);
});

// Agents have no web session. They prove who they are with their IRC password (checked against
// Ergo) and get the rooms they belong to, so a listener can join rooms granted while it was offline.
async function agentFromBasicAuth(c: any) {
  const header = c.req.header("Authorization") || "";
  const decoded = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8") : "";
  const split = decoded.indexOf(":");
  const nick = split > 0 ? decoded.slice(0, split) : "";
  const password = split > 0 ? decoded.slice(split + 1) : "";
  const account = nick ? accountByNick(nick) : null;
  if (!account || account.kind !== "agent" || !password) return null;
  const check = await ergo("/v1/check_auth", { accountName: account.nick, passphrase: password }).catch(() => ({ success: false }));
  return check.success ? account : null;
}

app.get("/api/agent/rooms", async (c) => {
  const account = await agentFromBasicAuth(c);
  if (!account) return c.json({ error: "agent credentials required" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json({ nick: account.nick, owner: account.owner, rooms: memberChannels(account.nick).filter((room) => agentCanReadChannel(account.nick, room)) });
});

app.get("/api/agents", async (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  c.header("Cache-Control", "no-store");
  const agents = db.query("SELECT nick, machine FROM accounts WHERE kind = 'agent' AND owner = ? COLLATE NOCASE ORDER BY nick").all(owner) as { nick: string; machine: string }[];
  const ownerId = accountByNick(owner)?.id;
  return c.json(await Promise.all(agents.map(async (agent) => {
    const details = await ergo("/v1/account_details", { accountName: agent.nick }).catch(() => null);
    const binding = ownerId ? db.query(`SELECT id,harness,session_name,session_id,status,lease_expires_at FROM agent_session_bindings
      WHERE nick=? COLLATE NOCASE AND owner_account_id=? AND status='ready'`).get(agent.nick, ownerId) as any : null;
    // Legacy IRC presence never proves a coding session is attached.
    const status = binding ? binding.lease_expires_at > Date.now() && agentRuntimeConnected(binding.id) ? "ready" : "offline" : "unknown";
    return { ...agent, status, agent: agentMetadata(agent.nick), bindingId: binding?.id ?? null, ...(binding ? { harness: binding.harness, sessionName: binding.session_name, sessionId: binding.session_id } : {}), lastSeen: details?.success ? details.lastSeen ?? null : null };
  })));
});

// Owner-only rename. The name shows in Slirc at once and reaches the session when it is attached.
app.post("/api/agents/:nick/name", async (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  const ownerId = accountByNick(owner)?.id;
  const binding = ownerId ? db.query("SELECT * FROM agent_session_bindings WHERE nick=? COLLATE NOCASE AND owner_account_id=? AND status='ready'")
    .get(c.req.param("nick"), ownerId) as Binding | null : null;
  if (!binding) return c.json({ error: "agent not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== "string" || body.name.length > 500) return c.json({ error: "name required" }, 400);
  const agent = renameBinding(binding, body.name);
  wakeAgent(binding.id);
  c.header("Cache-Control", "no-store");
  return c.json({ agent });
});

// Maintainer forward: hand one message from a channel you can read to your own attached agent with
// an optional note. The agent answers publicly in that channel. Only the binding's owner account
// may use it, and the agent must already be attached to the room.
const agentForwardLimit = createLimiter({ limit: 30, windowMs: 60_000 });
app.post("/api/agents/:bindingId/forward", bodyLimit({ maxSize: 8_192 }), async (c) => {
  if (!sameOriginJson(c, "X-Slirc-Agent")) return c.json({ error: "same-origin request required" }, 403);
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason }, 403);
  const person = verifiedHuman(c);
  if (!person?.id) return c.json({ error: "Sign in to forward a message." }, 401);
  if (!agentForwardLimit.check(person.id)) return c.json({ error: "Too many forwards. Try again in a minute." }, 429);
  const binding = db.query("SELECT * FROM agent_session_bindings WHERE id=? AND status='ready'")
    .get(c.req.param("bindingId")) as Binding | null;
  if (!binding) return c.json({ error: "agent not found" }, 404);
  if (binding.owner_account_id !== person.id) return c.json({ error: "only the owner can forward to this agent" }, 403);
  const body = await c.req.json().catch(() => ({})) as { channel?: unknown; messageId?: unknown; note?: unknown };
  if (typeof body.channel !== "string" || typeof body.messageId !== "string") return c.json({ error: "channel and messageId required" }, 400);
  const note = typeof body.note === "string" ? body.note.slice(0, 2_000) : "";
  const result = await forwardToAgent(binding, person.id, body.channel, body.messageId, note);
  if ("error" in result) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
  c.header("Cache-Control", "no-store");
  return c.json(result);
});

app.delete("/api/agents/:nick", async (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  const agent = db.query("SELECT nick FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'agent' AND owner = ? COLLATE NOCASE").get(c.req.param("nick"), owner) as { nick: string } | null;
  if (!agent) return c.json({ error: "agent not found" }, 404);
  try {
    await removeAgent(agent.nick);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not remove agent account.");
  }
});

// Revoke first, so the session stops at once even if the IRC teardown below fails and is retried.
function revokeAgentBindings(where: string, value: string): void {
  const rows = db.query(`SELECT id FROM agent_session_bindings WHERE ${where} AND status <> 'revoked'`).all(value) as { id: string }[];
  for (const binding of rows) {
    db.query("UPDATE agent_session_bindings SET status='revoked',lease_id=NULL,lease_nonce=NULL,lease_expires_at=NULL WHERE id=?").run(binding.id);
    disconnectAgentTransport(binding.id);
  }
}

// Owner Remove, admin Remove and removing the owner all end here: binding revoked, transport
// closed, Ergo account and DM gone.
async function removeAgent(nick: string): Promise<void> {
  const agent = db.query("SELECT nick, account_id, irc_password_gen, owner FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'agent'").get(nick) as
    { nick: string; account_id: string; irc_password_gen: number | null; owner: string | null } | null;
  if (!agent) return;
  // Taken before the account and its rooms go, so every open page that showed it drops it live.
  const audience = agentAudience(agent.nick, agent.owner ?? "");
  revokeAgentBindings("nick = ? COLLATE NOCASE", agent.nick);
  const channels = (db.query("SELECT channel FROM channel_members WHERE nick = ?").all(agent.nick) as { channel: string }[]).map((row) => row.channel);
  await removeAgentAccount(agent.nick, accountIrcPassword(agent), channels);
  for (const person of audience) publish(person, "agent-removed", { nick: agent.nick });
}

async function removeAgentsOwnedBy(owner: string, ownerAccountId: string | undefined): Promise<void> {
  if (ownerAccountId) revokeAgentBindings("owner_account_id = ?", ownerAccountId);
  const agents = db.query("SELECT nick FROM accounts WHERE kind = 'agent' AND owner = ? COLLATE NOCASE").all(owner) as { nick: string }[];
  for (const agent of agents) await removeAgent(agent.nick);
}

// The owner left or was removed from a channel: their agents leave it and its threads too. The
// agent's access depends on the owner's, so it never stays behind in a room the owner can't read.
async function removeOwnerAgentsFromChannel(owner: string, channel: string): Promise<void> {
  // A DM is between the owner and the agent; closing it is not leaving a channel.
  if (channelInfo(channel)?.visibility === "direct") return;
  const rooms = [channel, ...(db.query("SELECT channel FROM threads WHERE parent = ?").all(channel) as { channel: string }[]).map((row) => row.channel)];
  const agents = db.query("SELECT nick FROM accounts WHERE kind = 'agent' AND owner = ? COLLATE NOCASE").all(owner) as { nick: string }[];
  for (const { nick } of agents) {
    for (const room of rooms) {
      if (!db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ?").get(room, nick)) continue;
      db.query("DELETE FROM channel_members WHERE channel = ? AND nick = ?").run(room, nick);
      evictAgentRoomForNick(nick, room);
      channelsChanged(room, [nick], false);
      if (channelInfo(room)?.visibility === "secret") await revokeChannelAccess(room, nick).catch((error) => console.error(`agent revoke failed for ${nick} in ${room}:`, error));
    }
  }
}

// Someone leaving or removed from a channel leaves every thread under it as well: child membership
// rows, the private child's +I exception and their IRC join. `keepInvite` mirrors the parent rule
// that an owner keeps +I to come back through an invite link.
async function removeFromThreads(nick: string, parent: string, reason: string, keepInvite = false): Promise<void> {
  const children = threadChildren(parent);
  if (!children.length) return;
  db.query("DELETE FROM channel_members WHERE nick = ? AND channel IN (SELECT channel FROM threads WHERE parent = ?)").run(nick, parent);
  for (const child of children) { evictAgentRoomForNick(nick, child.channel); channelsChanged(child.channel, [nick], false); }
  await removeFromThreadChannels(nick, children.map((child) => ({ channel: child.channel, revoke: child.visibility !== "workspace" && !keepInvite })), reason);
}

// Agents in a new thread join it now; otherwise a mention there waits for the next reconnect.
function joinThreadAgents(channel: string): void {
  const agents = db.query("SELECT m.nick FROM channel_members m JOIN accounts a ON a.nick = m.nick COLLATE NOCASE WHERE m.channel = ? AND a.kind = 'agent'").all(channel) as { nick: string }[];
  for (const { nick } of agents) {
    void joinAgentRoomForNick(nick, channel).catch(() => {});
  }
}

// Bots are instance-managed IRC accounts: an admin mints the credentials, and
// talking to a bot happens over IRC like anyone else. Personal agents
// (`/api/agents`) are unaffected and remain owner-scoped.
// Writes mint or revoke a credential, so they refuse cross-site requests the way sign-in does:
// same Origin, a JSON body and a header a plain form cannot send. The admin check runs first.
const botsCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Bots");

app.get("/api/bots", async (c) => {
  c.header("Cache-Control", "no-store");
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  // Instance helpers (`owner IS NULL`) are not part of managed bots; list user-created bots only.
  const bots = db.query("SELECT nick, created_at FROM accounts WHERE kind = 'bot' AND owner IS NOT NULL ORDER BY nick").all() as { nick: string; created_at: number }[];
  return c.json({
    bots: await Promise.all(bots.map(async (bot) => {
      const details = await ergo("/v1/account_details", { accountName: bot.nick }).catch(() => null);
      return { nick: bot.nick, createdAt: bot.created_at, lastSeen: details?.success ? details.lastSeen ?? null : null };
    })),
    limit: botLimit(),
    // The list spans every admin's bots; the per-admin quota comes from botCount on the caller.
    used: botCount(admin.nick),
  });
});

app.post("/api/bots", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!botsCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const body = await c.req.json().catch(() => null) as { name?: unknown } | null;
  try {
    // Admin gate runs inside createBotAccount before any Ergo saregister or DB write.
    return c.json(await createBotAccount(admin.nick, typeof body?.name === "string" ? body.name : ""), 201);
  } catch (error) {
    if (error instanceof BotError) return c.json({ error: error.message }, error.status as 400);
    return appError(c, error, "Could not create bot account.");
  }
});

app.post("/api/bots/:nick/rotate", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!botsCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  // owner IS NOT NULL excludes instance helpers from the managed-bot APIs.
  const bot = db.query("SELECT nick FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'bot' AND owner IS NOT NULL").get(c.req.param("nick")) as { nick: string } | null;
  if (!bot) return c.json({ error: "bot not found" }, 404);
  try {
    const password = await rotateIrcPassword(bot.nick);
    clearIrcResetNotice(admin.nick, IRC_RESET_BOTS);
    return c.json({ nick: bot.nick, password });
  } catch (error) {
    return appError(c, error, "Could not rotate the bot password.");
  }
});

app.delete("/api/bots/:nick", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!botsCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const bot = db.query("SELECT nick, account_id, irc_password_gen FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'bot' AND owner IS NOT NULL").get(c.req.param("nick")) as
    { nick: string; account_id: string; irc_password_gen: number | null } | null;
  if (!bot) return c.json({ error: "bot not found" }, 404);
  const channels = (db.query("SELECT channel FROM channel_members WHERE nick = ?").all(bot.nick) as { channel: string }[]).map((row) => row.channel);
  try {
    await removeAgentAccount(bot.nick, accountIrcPassword(bot), channels);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not remove the bot account.");
  }
});

app.get("/api/irc/devices", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const rows = db.query("SELECT id, label, created_at FROM irc_devices WHERE account = ? COLLATE NOCASE ORDER BY created_at DESC").all(account.nick) as { id: string; label: string; created_at: number }[];
  return c.json(rows.map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at })));
});

app.post("/api/irc/devices", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 80 || /[\r\n]/.test(label)) return c.json({ error: "Enter a device name." }, 400);
  try {
    const result = await serializeIrcDeviceChange(async () => {
      const device = { id: randomBytes(12).toString("base64url"), label, createdAt: Date.now() };
      const password = await rotateIrcPassword(account.nick);
      db.query("INSERT INTO irc_devices (id, account, label, created_at) VALUES (?, ?, ?, ?)").run(device.id, account.nick, device.label, device.createdAt);
      clearIrcResetNotice(account.nick, IRC_RESET_CLIENTS);
      return { device, password };
    });
    return c.json(result, 201);
  } catch (error) {
    return appError(c, error, "Could not connect IRC client.");
  }
});

app.delete("/api/irc/devices/:id", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return c.json({ error: "device not found" }, 404);
  try {
    const password = await serializeIrcDeviceChange(async () => {
      const device = db.query("SELECT 1 FROM irc_devices WHERE id = ? AND account = ? COLLATE NOCASE").get(id, account.nick);
      if (!device) return null;
      const password = await rotateIrcPassword(account.nick);
      db.query("DELETE FROM irc_devices WHERE id = ? AND account = ? COLLATE NOCASE").run(id, account.nick);
      clearIrcResetNotice(account.nick, IRC_RESET_CLIENTS);
      return password;
    });
    return password ? c.json({ password }) : c.json({ error: "device not found" }, 404);
  } catch (error) {
    return appError(c, error, "Could not remove IRC client.");
  }
});

// New password: the same rotation as adding a client, without adding one. Shown once, like every
// password on this page; the old one stops working for every password client at once.
app.post("/api/irc/password", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  try {
    const password = await serializeIrcDeviceChange(async () => {
      const password = await rotateIrcPassword(account.nick);
      clearIrcResetNotice(account.nick, IRC_RESET_CLIENTS);
      return password;
    });
    return c.json({ password });
  } catch (error) {
    return appError(c, error, "Could not make a new IRC password.");
  }
});

// Dismissing the "your IRC password changed" note. kind is "clients" or "bots".
app.post("/api/irc/reset-notice", async (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const bit = body?.kind === "clients" ? IRC_RESET_CLIENTS : body?.kind === "bots" ? IRC_RESET_BOTS : 0;
  if (!bit) return c.json({ error: "unknown note" }, 400);
  clearIrcResetNotice(account.nick, bit);
  return c.body(null, 204);
});

app.get("/api/irc/certificates", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  try {
    return c.json(await serializeIrcDeviceChange(async () => {
      const fingerprints = new Set(await listCertificates(account.nick, account.ircPassword));
      const rows = db.query("SELECT id, label, fingerprint, created_at FROM irc_certificates WHERE account = ? COLLATE NOCASE ORDER BY created_at DESC").all(account.nick) as { id: string; label: string; fingerprint: string; created_at: number }[];
      for (const row of rows) if (!fingerprints.has(row.fingerprint)) db.query("DELETE FROM irc_certificates WHERE id = ?").run(row.id);
      for (const fingerprint of fingerprints) {
        if (!rows.some((row) => row.fingerprint === fingerprint)) {
          db.query("INSERT INTO irc_certificates (id, account, label, fingerprint, created_at) VALUES (?, ?, 'Certificate', ?, ?)")
            .run(randomBytes(12).toString("base64url"), account.nick, fingerprint, Date.now());
        }
      }
      return (db.query("SELECT id, label, fingerprint, created_at FROM irc_certificates WHERE account = ? COLLATE NOCASE ORDER BY created_at DESC").all(account.nick) as { id: string; label: string; fingerprint: string; created_at: number }[])
        .map((row) => ({ id: row.id, label: row.label, fingerprint: row.fingerprint, createdAt: row.created_at }));
    }));
  } catch (error) {
    return appError(c, error, "Could not load certificates.");
  }
});

app.post("/api/irc/certificates", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const fingerprint = typeof body.fingerprint === "string" ? normalizeCertificateFingerprint(body.fingerprint) : null;
  if (!label || label.length > 80 || /[\r\n]/.test(label)) return c.json({ error: "Enter a certificate name." }, 400);
  if (!fingerprint) return c.json({ error: "Enter a SHA-256 certificate fingerprint." }, 400);
  try {
    const certificate = await serializeIrcDeviceChange(async () => {
      if (db.query("SELECT 1 FROM irc_certificates WHERE account = ? COLLATE NOCASE AND fingerprint = ?").get(account.nick, fingerprint)) return null;
      await addCertificate(account.nick, account.ircPassword, fingerprint);
      const certificate = { id: randomBytes(12).toString("base64url"), label, fingerprint, createdAt: Date.now() };
      db.query("INSERT INTO irc_certificates (id, account, label, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(certificate.id, account.nick, certificate.label, certificate.fingerprint, certificate.createdAt);
      return certificate;
    });
    return certificate ? c.json(certificate, 201) : c.json({ error: "Certificate already added." }, 409);
  } catch (error) {
    return appError(c, error, "Could not add certificate.");
  }
});

app.delete("/api/irc/certificates/:id", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return c.json({ error: "certificate not found" }, 404);
  try {
    const removed = await serializeIrcDeviceChange(async () => {
      const certificate = db.query("SELECT fingerprint FROM irc_certificates WHERE id = ? AND account = ? COLLATE NOCASE").get(id, account.nick) as { fingerprint: string } | null;
      if (!certificate) return false;
      await removeCertificate(account.nick, account.ircPassword, certificate.fingerprint);
      db.query("DELETE FROM irc_certificates WHERE id = ? AND account = ? COLLATE NOCASE").run(id, account.nick);
      return true;
    });
    return removed ? c.body(null, 204) : c.json({ error: "certificate not found" }, 404);
  } catch (error) {
    return appError(c, error, "Could not remove certificate.");
  }
});

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

// Email is the identity that magic links verify, so people cannot change their own. An admin can
// fix a lost inbox with PATCH /api/admin/accounts/:nick.
app.patch("/api/admin/accounts/:nick", async (c) => {
  const requester = currentUser(c);
  const admin = requester ? accountByNick(requester) : null;
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const target = accountByNick(c.req.param("nick"));
  if (!target) return c.json({ error: "account not found" }, 404);
  // Moving another admin's address to one you read would let you sign in as them.
  if (target.kind !== "human" || (target.role === "admin" && target.nick.toLowerCase() !== admin.nick.toLowerCase())) return c.json({ error: "You can't change this account's email." }, 403);
  const { email } = await c.req.json().catch(() => ({}));
  const next = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!validEmail(next)) return c.json({ error: "Enter a valid email address." }, 400);
  if (next !== target.email && accountByEmail(next)) return c.json({ error: "That email is already in use." }, 409);
  db.query("UPDATE accounts SET email = ? WHERE nick = ?").run(next, target.nick);
  // New address, new Gravatar lookup: drop the cached miss so the next profile load refetches.
  db.query("UPDATE profiles SET gravatar_checked_at = NULL WHERE account = ? AND avatar_path IS NULL").run(target.nick);
  return c.json({ nick: target.nick, email: next });
});

// Remove a person from this instance. The app half runs first so they are signed out and kept out
// even if Ergo is slow; repeating the call after a failure retries the IRC half. Their messages stay.
app.delete("/api/admin/accounts/:nick", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const target = db.query("SELECT nick, role, kind, removed_at FROM accounts WHERE nick = ? COLLATE NOCASE").get(c.req.param("nick")) as
    { nick: string; role: string; kind: string; removed_at: number | null } | null;
  if (!target || target.kind !== "human") return c.json({ error: "person not found" }, 404);
  if (target.nick.toLowerCase() === admin.nick.toLowerCase()) return c.json({ error: "You can't remove yourself." }, 400);
  // Admins can't remove each other, so the last admin always stays too.
  if (target.role === "admin") return c.json({ error: "You can't remove another admin." }, 403);
  const targetAccountId = accountByNick(target.nick)?.id;
  const channels = [...new Set([...openChannels, ...markRemoved(target.nick)])];
  try {
    await removeAgentsOwnedBy(target.nick, targetAccountId);
    await removeMemberFromIrc(target.nick, channels);
    // Password and certificates go too, so no IRC client can log in as them again.
    await serializeIrcDeviceChange(async () => {
      const password = await rotateIrcPassword(target.nick);
      for (const fingerprint of await listCertificates(target.nick, password)) await removeCertificate(target.nick, password, fingerprint);
      db.query("DELETE FROM irc_devices WHERE account = ? COLLATE NOCASE").run(target.nick);
      db.query("DELETE FROM irc_certificates WHERE account = ? COLLATE NOCASE").run(target.nick);
    });
    return c.body(null, 204);
  } catch (error) {
    // 500, not 502: Cloudflare swaps an origin 502 for its own error page, and the dialog loses this message.
    return c.json({ error: error instanceof Error ? error.message : "Could not finish removing this person. Try again." }, 500);
  }
});

// Every agent on the instance, whoever owns it, for the admin People page.
app.get("/api/admin/agents", (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const agents = db.query("SELECT nick, owner, created_at FROM accounts WHERE kind = 'agent' ORDER BY owner COLLATE NOCASE, nick COLLATE NOCASE").all() as { nick: string; owner: string; created_at: number }[];
  c.header("Cache-Control", "no-store");
  return c.json(agents.map((agent) => {
    const binding = db.query("SELECT * FROM agent_session_bindings WHERE nick = ? COLLATE NOCASE AND status = 'ready'").get(agent.nick) as Binding | null;
    const channels = (db.query("SELECT channel FROM channel_members WHERE nick = ? AND channel NOT LIKE '#dm-%' AND channel NOT LIKE '#t-%' ORDER BY channel").all(agent.nick) as { channel: string }[]).map((row) => row.channel);
    const online = !!binding && (binding.lease_expires_at || 0) > Date.now() && agentRuntimeConnected(binding.id);
    return { nick: agent.nick, owner: agent.owner, createdAt: agent.created_at, name: binding ? bindingMetadata(binding).name : agent.nick, harness: binding?.harness || null, status: online ? "ready" : "offline", channels };
  }));
});

app.delete("/api/admin/agents/:nick", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const agent = db.query("SELECT nick FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'agent'").get(c.req.param("nick")) as { nick: string } | null;
  if (!agent) return c.json({ error: "agent not found" }, 404);
  try {
    await removeAgent(agent.nick);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not remove agent.");
  }
});

app.get("/api/admin/help-usage", (c) => {
  const requester = currentUser(c);
  const admin = requester ? accountByNick(requester) : null;
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const rows = db.query(`SELECT model, COUNT(*) AS calls, SUM(CASE WHEN cached = 0 THEN 1 ELSE 0 END) AS model_calls,
                        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd,
                        SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cache_hits
                        FROM help_usage GROUP BY model ORDER BY model`).all();
  return c.json({ rows });
});

// Counts and states the host's cron job writes beside the database every five minutes.
app.get("/api/admin/status", async (c) => {
  const requester = currentUser(c);
  const admin = requester ? accountByNick(requester) : null;
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  c.header("Cache-Control", "no-store");
  const text = await Bun.file(join(dirname(process.env.DB_PATH || "/data/chat.sqlite"), "ops-status.json")).text().catch(() => null);
  if (text === null) return c.json({ status: null });
  try { return c.json({ status: JSON.parse(text) }); } catch { return c.json({ status: null, error: "unreadable" }); }
});

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

// First verified sign-in: the help bot opens a DM with the tour. Returns whether the DM channel was
// really provisioned, so a signed-in person can be sent there; a disabled or failed helper never
// fakes that and never blocks the login. The "direct" event lets a tab that loaded before the DM
// existed pick it up, with its unread welcome, without a reload.
async function sendOnboarding(nick: string): Promise<boolean> {
  if (!enabledHelpers().includes("help") || !needsOnboarding(nick)) return false;
  try {
    const direct = await openDirectConversation(nick, "help");
    queueOnboarding(nick, direct.channel);
    publish(nick, "direct", { channel: direct.channel });
    return true;
  } catch (error) {
    console.error(`onboarding DM failed for ${nick}:`, error);
    return false;
  }
}

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

// A vote from the composer (`@poll 2` or `/poll 2`). It never goes over IRC, so nobody in the
// channel sees who voted for what; the confirmation shows only for the voter.
const pollVoteLimit = createLimiter({ limit: 30, windowMs: 60_000 });
app.use("/api/polls/vote", bodyLimit({ maxSize: 512 }));
app.post("/api/polls/vote", async (c) => {
  c.header("Cache-Control", "no-store");
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!sameOriginJson(c, "X-Slirc-Poll")) return c.json({ error: "same-origin request required" }, 403);
  if (!enabledHelpers().includes("poll")) return c.json({ error: "Polls are off on this server." }, 503);
  const body = await c.req.json().catch(() => ({})) as { channel?: unknown; option?: unknown };
  const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
  const option = body.option;
  if (!channel.startsWith("#") || typeof option !== "number" || !Number.isInteger(option)) return c.json({ error: "Vote with a number, like @poll 2." }, 400);
  if (!isMember(requester.nick, channel)) return c.json({ error: "Join the channel to vote." }, 403);
  if (!pollVoteLimit.check(requester.nick)) return c.json({ error: "Too many votes at once. Try again in a minute." }, 429);
  const reply = voteIn(channel, requester.nick, option);
  const open = openPoll(channel);
  if (open) pollChanged(open);
  return c.json({ reply });
});

// Poll cards. The helper's announcement carries +slirc/poll=<id>; the app reads the poll's state
// here and hears about each change through the live "poll" event, sent only to the channel's
// members. The event names the poll, never a voter: each tab asks again and gets its own view.
function pollChanged(poll: { id: number; channel: string }): void {
  // Live listeners are keyed by lowercased nick and channel_members keeps the nick's own case,
  // so membership is compared without case here.
  const member = db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ? COLLATE NOCASE");
  publishWhere((nick) => isOpenChannel(poll.channel) || !!member.get(poll.channel, nick), "poll", { id: poll.id, channel: poll.channel });
}
setPollChangeListener(pollChanged);

// The creator, a server admin or the channel's owner can close a poll from its card. Typed
// `@poll close` keeps its own rule (creator or channel op), which the helper checks over IRC.
function mayClosePoll(poll: Poll, nick: string): boolean {
  return canClosePoll(poll, nick, accountByNick(nick)?.role === "admin" || channelInfo(poll.channel)?.owner?.toLowerCase() === nick.toLowerCase());
}

// One poll the caller can read: a verified member of its channel, on a server with polls on.
function readablePoll(c: any): { poll: Poll; nick: string } | Response {
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!enabledHelpers().includes("poll")) return c.json({ error: "Polls are off on this server." }, 503);
  const poll = pollById(Number(c.req.param("id")));
  // An outsider gets the same answer as a missing poll, so ids reveal nothing.
  if (!poll || !isMember(requester.nick, poll.channel)) return c.json({ error: "poll not found" }, 404);
  return { poll, nick: requester.nick };
}

const pollCreateLimit = createLimiter({ limit: 10, windowMs: 60_000 });
app.use("/api/polls", bodyLimit({ maxSize: 4096 }));
app.use("/api/polls/*", bodyLimit({ maxSize: 4096 }));
app.post("/api/polls", async (c) => {
  c.header("Cache-Control", "no-store");
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!sameOriginJson(c, "X-Slirc-Poll")) return c.json({ error: "same-origin request required" }, 403);
  if (!enabledHelpers().includes("poll")) return c.json({ error: "Polls are off on this server." }, 503);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const channel = typeof body.channel === "string" ? normalized(body.channel) : "";
  if (!channel.startsWith("#")) return c.json({ error: "Pick a channel for the poll." }, 400);
  const helper = accountByNick("poll");
  if (!helper || helper.kind !== "bot") return c.json({ error: "Polls are off on this server." }, 503);
  const denial = memberAddDenial(requester.nick, channel, helper);
  if (denial) return c.json({ error: denial.status === 404 ? "Polls work in channels." : "Join the channel to start a poll." }, denial.status);
  const parsed = checkPoll(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  if (!pollCreateLimit.check(requester.nick)) return c.json({ error: "Too many polls at once. Try again in a minute." }, 429);
  const open = openPoll(channel);
  if (open) return c.json({ error: `There is already an open poll here: ${open.question} Close it first.`, poll: open.id }, 409);
  // The helper joins on its own once it has a membership row; the announcement waits in its outbox.
  if (!belongsTo(helper, channel)) {
    db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(channel, helper.nick);
    if (!isOpenChannel(channel)) {
      try { await grantChannelAccess(channel, helper.nick); } catch (error) {
        db.query("DELETE FROM channel_members WHERE channel = ? AND nick = ?").run(channel, helper.nick);
        console.error(`poll grant failed in ${channel}:`, error);
        return c.json({ error: "Could not add @poll to this channel. Try again." }, 500);
      }
      channelsChanged(channel, [helper.nick], true);
    }
  }
  // Another request may have opened a poll here while the grant was awaited.
  const raced = openPoll(channel);
  if (raced) return c.json({ error: `There is already an open poll here: ${raced.question} Close it first.`, poll: raced.id }, 409);
  const poll = createPoll(channel, requester.nick, parsed);
  helperSay("poll", channel, [announceLines(poll).join("\n")], undefined, pollTag(poll));
  return c.json(pollView(poll, requester.nick, mayClosePoll(poll, requester.nick)));
});

app.get("/api/polls/:id", (c) => {
  c.header("Cache-Control", "no-store");
  const found = readablePoll(c);
  if (found instanceof Response) return found;
  return c.json(pollView(found.poll, found.nick, mayClosePoll(found.poll, found.nick)));
});

// The voter's whole choice for one poll: { options: [2] }, { options: [1, 3] }, or [] to take it back.
app.post("/api/polls/:id/vote", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!sameOriginJson(c, "X-Slirc-Poll")) return c.json({ error: "same-origin request required" }, 403);
  const found = readablePoll(c);
  if (found instanceof Response) return found;
  const body = await c.req.json().catch(() => ({})) as { options?: unknown };
  if (!pollVoteLimit.check(found.nick)) return c.json({ error: "Too many votes at once. Try again in a minute." }, 429);
  const result = setVotes(found.poll, found.nick, body.options);
  if (!result.ok) return c.json({ error: result.error }, result.error === "That poll is closed." ? 409 : 400);
  pollChanged(found.poll);
  return c.json(pollView(found.poll, found.nick, mayClosePoll(found.poll, found.nick)));
});

app.post("/api/polls/:id/close", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!sameOriginJson(c, "X-Slirc-Poll")) return c.json({ error: "same-origin request required" }, 403);
  const found = readablePoll(c);
  if (found instanceof Response) return found;
  const { poll, nick } = found;
  if (pollClosed(poll)) return c.json(pollView(poll, nick, false));
  if (!mayClosePoll(poll, nick)) return c.json({ error: `Only ${poll.creator} or an admin can close this poll.` }, 403);
  const closed = closePoll(poll);
  // IRC clients read the result as text; the app hides that tally and redraws the card instead.
  helperSay("poll", closed.channel, [tallyLines(closed, votes(closed), true).join("\n")], undefined, tallyTag(closed));
  pollChanged(closed);
  return c.json(pollView(closed, nick, false));
});

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
const mailLimit = createLimiter({ limit: 5 });
// An invitation token is personal and unguessable, so its sign-in is limited per token. A per-IP
// bucket would lock out everyone behind one proxy address (a tenant without SLIRC_TRUSTED_PROXIES).
const invitationTokenLimit = createLimiter({ limit: 10 });
const codeLimit = createLimiter({ limit: 20 });

app.post("/auth/invitation/request", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!invitationCsrf(c)) return c.json({ error: "invalid request" }, 403);
  const { token, name } = await c.req.json().catch(() => ({}));
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return c.json({ error: "valid invitation required" }, 404);
  const invite = emailInviteByToken(token);
  if (!invite) return c.json({ error: "valid invitation required" }, 404);
  const inviterRow = invite.inviterAccountId && db.query("SELECT nick FROM accounts WHERE account_id = ?").get(invite.inviterAccountId) as { nick: string } | null;
  const inviter = inviterRow && accountByNick(inviterRow.nick);
  if (!inviter || inviter.kind !== "human" || !inviter.verifiedAt || inviter.id !== invite.inviterAccountId) return c.json({ error: "invitation unavailable" }, 409);
  if (invite.destination !== "dm") {
    const info = invite.channel && channelInfo(invite.channel);
    if (!info || info.archived || (invite.destination === "group" && !info.isGroup) || !isMember(inviter.nick, info.channel)) return c.json({ error: "invitation unavailable" }, 409);
  }
  if (!invitationTokenLimit.check(hash(token))) return c.json({ error: "Too many requests. Try again later." }, 429);
  // An invitation made by a join link closes with its link, and a new member takes one of its places.
  const linkId = joinLinkIdForInvite(token);
  const link = linkId ? joinLinkById(linkId) : null;
  if (linkId && joinLinkState(link) === "closed") return c.json({ error: "This join link is closed." }, 410);
  let account = accountByEmail(invite.email);
  if (account && account.kind !== "human") return c.json({ error: "invitation unavailable" }, 404);
  // New or never-verified address: the invitation link was mailed to it, which proves the mailbox
  // the same way an admission link does. Take the name and sign in here; no second email.
  if (!account?.verifiedAt) {
    const displayName = typeof name === "string" ? name.trim().slice(0, 80) : "";
    if (!account && !displayName) return c.json({ error: "name required" }, 400);
    // Only a new account takes a place; a retry for an account the link already made takes none.
    const reserved = !!linkId && !account;
    if (reserved && !reserveJoin(linkId!)) return c.json({ error: "This join link is full." }, 409);
    try {
      account ||= await provisionAccount(displayName, invite.email);
    } catch (error) {
      if (reserved) releaseJoin(linkId!);
      return c.json({ error: error instanceof Error ? error.message : "Could not prepare this account." }, 400);
    }
    completeFirstVerification(account.nick);
    startSession(c, account.nick);
    // Opening the help DM takes seconds (a fresh operator connection proves it private) and this
    // path lands in the invited channel, so it runs in the background.
    const newNick = account.nick;
    void sendOnboarding(newNick).catch((error) => console.error(`onboarding failed for ${newNick}:`, error));
    return c.json({ signedIn: true, accountId: account.id, nick: account.nick });
  }
  // Existing verified account: an invitation link alone must not open it (it may have been
  // forwarded), so mail a sign-in link that returns here.
  if (!mailLimit.check(invite.email)) return c.json({ error: "Too many requests. Try again later." }, 429);
  if (!devLinks && (!resend || !process.env.RESEND_FROM)) return c.json({ error: "Email delivery is unavailable." }, 503);
  const result = await sendInvitationVerification(account, token, c.req.header("Host"));
  if (result.status === "limited") return c.json({ error: "Check your inbox or try again shortly." }, 429);
  if (result.status === "failed") return c.json({ error: "Could not send verification email." }, 500);
  return c.json(devLinks ? { devLink: result.devLink } : { sent: true }, 202);
});

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

app.use("/api/admission*", bodyLimit({ maxSize: 4_096 }));
app.use("/api/admission*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

app.get("/api/contacts", (c) => {
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const nick = requester.nick;
  const contacts = sharedContacts(nick);
  return c.json({ contacts, accountDetails: accountDetails(contacts) });
});

async function sendAdmission(issue: { id: string; generation: number; token: string; email: string }, host?: string | null) {
  const founder = founderAccount();
  const owner = founder ? { nick: founder.nick, name: profileJson(founder.nick).fullName || undefined } : undefined;
  const origin = process.env.WAITLIST_ORIGIN?.trim() || appOrigin(host);
  const message = admissionEmail({ token: issue.token, origin, appOrigin: appOrigin(host), owner });
  try {
    const result = await resend!.emails.send({ from: process.env.RESEND_FROM!, to: issue.email,
      subject: message.subject, html: message.html, text: message.text }, { idempotencyKey: `admission/${issue.id}/${issue.generation}` });
    if (result.error) {
      recordAdmissionDelivery(issue.id, issue.generation, "failed", "email provider rejected delivery");
      return "failed" as const;
    }
    recordAdmissionDelivery(issue.id, issue.generation, "sent");
    return "sent" as const;
  } catch {
    recordAdmissionDelivery(issue.id, issue.generation, "uncertain", "email delivery outcome is uncertain");
    return "uncertain" as const;
  }
}

app.get("/api/admissions", async (c) => {
  const owner = verifiedHuman(c);
  if (!isFounder(owner)) return c.json({ error: "not found" }, 404);
  // No waitlist config means this instance has no waiting list to review (every hosted or
  // self-hosted private workspace). 404 makes the client drop the section instead of erroring.
  if (!waitlistConfigured()) return c.json({ error: "not found" }, 404);
  c.header("Cache-Control", "no-store");
  try { return c.json({ applications: await waitlistApplications(), admissions: admissionList() }); }
  catch (error) { console.error("waitlist snapshot failed:", error); return c.json({ error: "waitlist snapshot unavailable" }, 500); }
});

app.post("/api/admissions/approve", async (c) => {
  const owner = verifiedHuman(c);
  if (!isFounder(owner)) return c.json({ error: "not found" }, 404);
  if (!admissionCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  if (!resend || !process.env.RESEND_FROM) return c.json({ error: "email delivery is unavailable" }, 503);
  const body = await c.req.json().catch(() => ({})) as { applicationId?: unknown; revision?: unknown };
  if (typeof body.applicationId !== "string" || body.applicationId.length > 64 || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1) {
    return c.json({ error: "application and revision required" }, 400);
  }
  try {
    const application = (await waitlistApplications()).find((item) => item.id === body.applicationId && item.revision === body.revision);
    if (!application) return c.json({ error: "application changed; refresh the list" }, 409);
    const result = approveApplication(application);
    if (result.conflict) return c.json({ error: "email already has an admission" }, 409);
    if (!result.created || !result.token) return c.json({ admission: result.admission, created: false });
    const delivery = await sendAdmission({ id: result.admission.id, generation: result.admission.generation, token: result.token, email: result.admission.email }, c.req.header("Host"));
    return c.json({ admission: { ...result.admission, delivery }, created: true }, delivery === "failed" ? 500 : 202);
  } catch (error) { console.error("waitlist approval failed:", error); return c.json({ error: "could not approve application" }, 500); }
});

app.post("/api/admissions/:id/cancel", (c) => {
  const owner = verifiedHuman(c);
  if (!isFounder(owner)) return c.json({ error: "not found" }, 404);
  if (!admissionCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  return cancelAdmission(c.req.param("id")) ? c.json({ cancelled: true }) : c.json({ error: "admission cannot be cancelled" }, 409);
});

app.post("/api/admissions/:id/reissue", async (c) => {
  const owner = verifiedHuman(c);
  if (!isFounder(owner)) return c.json({ error: "not found" }, 404);
  if (!admissionCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  if (!resend || !process.env.RESEND_FROM) return c.json({ error: "email delivery is unavailable" }, 503);
  const body = await c.req.json().catch(() => ({})) as { revision?: unknown };
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) return c.json({ error: "revision required" }, 400);
  try {
    const old = admissionList().find((item) => item.id === c.req.param("id"));
    if (!old) return c.json({ error: "admission not found" }, 404);
    const application = (await waitlistApplications()).find((item) => item.id === old.applicationId && item.revision === body.revision);
    if (!application || application.revision !== old.revision) return c.json({ error: "application changed; refresh the list" }, 409);
    const issue = reissueAdmission(old.id, application);
    if (!issue) return c.json({ error: "admission cannot be reissued" }, 409);
    const delivery = await sendAdmission({ id: issue.admission.id, generation: issue.generation, token: issue.token, email: issue.admission.email }, c.req.header("Host"));
    return c.json({ admission: { ...issue.admission, delivery } }, delivery === "failed" ? 500 : 202);
  } catch (error) { console.error("admission reissue failed:", error); return c.json({ error: "could not reissue admission" }, 500); }
});

app.post("/api/admission/redeem", async (c) => {
  if (!admissionCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const body = await c.req.json().catch(() => ({})) as { token?: unknown; browserClaim?: unknown; name?: unknown };
  if (typeof body.token !== "string" || typeof body.browserClaim !== "string") return c.json({ error: "valid admission required" }, 404);
  const name = admissionName(body.name);
  if (!name) return c.json({ error: "enter a valid name" }, 400);
  const currentNick = currentUser(c);
  const current = currentNick ? accountByNick(currentNick) : null;
  const admission = admissionForToken(body.token);
  if (!admission) return c.json({ error: "admission unavailable or already used" }, 410);
  if (current && (current.kind !== "human" || normalizeEmail(current.email) !== normalizeEmail(admission.approved_email))) {
    return c.json({ error: "sign out or use the account invited by this email" }, 403);
  }
  const result = beginRedemption(body.token, body.browserClaim, name);
  if (result.status !== "claimed") return c.json({ error: result.status === "claim-mismatch" ? "continue in the browser that started admission" : "admission unavailable or already used" }, 409);
  try {
    const identity = await reserveAdmissionIdentity(result.admission.id, result.fence);
    await provisionAdmissionIdentity(identity, result.admission.id);
    const sessionToken = randomBytes(32).toString("base64url");
    const completed = finalizeRedemption({
      id: result.admission.id,
      fence: result.fence,
      identity,
      session: { tokenHash: hash(sessionToken), createdAt: Date.now(), device: userAgentDetails(c.req.header("User-Agent")).device },
    });
    if (!completed) return c.json({ error: "admission attempt expired or changed; use the current link" }, 409);
    setCookie(c, "slirc_session", sessionToken, sessionCookie);
    setCookie(c, "slirc_acct", completed.nick, acctCookie);
    enqueueWelcomeJob(completed.nick);
    await sendOnboarding(completed.nick);
    return c.json({ admissionId: result.admission.id, accountId: identity.accountId, nick: completed.nick }, 201);
  } catch (error) {
    if (error instanceof AdmissionAttemptStaleError) return c.json({ error: "admission attempt expired or changed; use the current link" }, 409);
    console.error("admission redemption failed:", error instanceof Error ? error.message : "unknown error");
    return c.json({ error: "could not finish admission; retry from this browser" }, 500);
  }
});

app.post("/api/admission/destination", async (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!admissionCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const body = await c.req.json().catch(() => ({})) as { token?: unknown; destination?: unknown };
  if (typeof body.token !== "string" || !["help", "founder"].includes(String(body.destination))) return c.json({ error: "admission destination not found" }, 404);
  const redeemed = redeemedAdmission(body.token);
  if (!redeemed || redeemed.accountId !== account.id) return c.json({ error: "admission destination not found" }, 404);
  const peer = body.destination === "help" ? accountByNick("help") : founderAccount();
  if (!peer || peer.kind !== "human" && body.destination === "founder") return c.json({ error: "admission destination unavailable" }, 503);
  try {
    const direct = await openDirectConversation(account.nick, peer.nick);
    reopenDirectConversation(account.id, direct.channel);
    return c.json({ type: "direct", channel: direct.channel, nick: peer.nick });
  } catch (error) {
    console.error("admission destination failed:", error);
    return c.json({ error: "could not open destination; retry" }, 500);
  }
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

// The links library. It exists only where the `links` helper is switched on; elsewhere every
// route answers 404. Members only: agents, bots and helpers are refused. Each read applies the
// viewer's channel membership inside links.ts, so a private channel's links, counts and filter
// values never reach someone outside it.
// The list and its suggestions each take one, and the list reloads as someone types.
const linkSearchLimit = createLimiter({ limit: 240, windowMs: 60_000 });
const linkRemoveLimit = createLimiter({ limit: 30, windowMs: 60_000 });
function linksViewer(c: any): { account: Account } | { response: Response } {
  c.header("Cache-Control", "private, no-store");
  if (!linksEnabled()) return { response: c.json({ error: "not found" }, 404) };
  if (!currentUser(c)) return { response: c.json({ error: "not signed in" }, 401) };
  const account = verifiedHuman(c);
  return account ? { account } : { response: c.json({ error: "members only" }, 403) };
}
const linkDay = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN);
// What a member sees of a row. The sharer's account id stays on the server;
// `canRemove` says what the screen needs to know about it.
function linkJson(link: LinkRow, viewer: Account) {
  return {
    id: link.id, url: link.url, title: link.title, summary: link.summary, author: link.author, source: link.source, topics: link.topics,
    origins: link.origins, firstSharedAt: link.firstSharedAt, lastSharedAt: link.lastSharedAt, shareCount: link.shareCount,
    sharedBy: link.sharedByName, private: link.scope || null, canRemove: canRemoveLink(viewer, link), image: link.hasImage,
    // An X post's own words and author, and whether the picture is the author's.
    imageKind: link.hasImage ? imageKind(link.id) : null, post: link.source === "x" ? storedPost(link.id) : null,
    // A saved copy exists, and whether the original was found gone.
    copy: hasCopy(link.id), gone: originalGone(link.id),
  };
}

// `when` is week, month, or a calendar year.
const linkSince = (when: string) => when === "week" ? Date.now() - 7 * 24 * 60 * 60_000 : when === "month" ? Date.now() - 30 * 24 * 60 * 60_000 : /^(19|20)\d{2}$/.test(when) ? Date.UTC(Number(when), 0, 1) : undefined;
const linkUntil = (when: string) => (/^(19|20)\d{2}$/.test(when) ? Date.UTC(Number(when) + 1, 0, 1) : undefined);

// One query shape for the list and for its filter suggestions.
function linkQuery(c: any): LinkQuery | null {
  const text = (name: string, max: number) => (c.req.query(name) || "").trim().slice(0, max);
  const source = text("source", 32);
  if (source && !(SOURCES as readonly string[]).includes(source)) return null;
  const from = linkDay(c.req.query("from"));
  const to = linkDay(c.req.query("to"));
  const topics = ((c.req.queries("topic") || []) as string[]).map((topic) => topic.trim().slice(0, 64)).filter(Boolean).slice(0, 6);
  return {
    q: text("q", 200), topics, source, origin: text("origin", 64), sharer: text("sharer", 80), site: text("site", 120), channel: text("channel", 64),
    from: Number.isFinite(from) ? from : linkSince(text("when", 8)), to: Number.isFinite(to) ? to + 24 * 60 * 60_000 : linkUntil(text("when", 8)),
  };
}

app.get("/api/links", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many searches. Try again in a minute." }, 429);
  const query = linkQuery(c);
  if (!query) return c.json({ rows: [], total: 0, more: false });
  const offset = Number(c.req.query("offset"));
  const limit = Number(c.req.query("limit"));
  const results = searchLinks(viewer.account.nick, {
    ...query,
    offset: Number.isInteger(offset) && offset > 0 && offset <= 100_000 ? offset : 0,
    limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
  });
  return c.json({ rows: results.rows.map((link) => linkJson(link, viewer.account)), total: results.total, more: results.more });
});

// Filter values and counts within the current results, from the rows this member can see.
app.get("/api/links/facets", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many searches. Try again in a minute." }, 429);
  const query = linkQuery(c);
  return c.json(query ? linkFilterFacets(viewer.account.nick, query) : { total: 0, topics: [], sources: [], origins: [], sharers: [], years: [], week: 0, month: 0 });
});

// A site's icon for the rows. Fetched once per host through the guarded fetch and kept in the
// database, so a browser never asks a third party for it. Only for a host the member already
// has a link on, a few at a time; a host that gave no icon is asked again after a week.
const faviconLimit = createLimiter({ limit: 600, windowMs: 60_000 });
const FAVICON_RETRY_MS = 7 * 24 * 60 * 60_000;
const faviconWaiting = new Map<string, Promise<void>>();
let faviconRunning = 0;
const faviconTurns: (() => void)[] = [];
app.get("/api/links/favicon", async (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  const host = (c.req.query("host") || "").toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 120) return c.body(null, 404);
  if (!faviconLimit.check(viewer.account.id) || !viewerHasSite(viewer.account.nick, host)) return c.body(null, 404);
  let icon = storedFavicon(host);
  if (!icon || (!icon.body && Date.now() - icon.fetchedAt > FAVICON_RETRY_MS)) {
    let pending = faviconWaiting.get(host);
    if (!pending) {
      // A page of rows asks for many hosts at once. A few are fetched at a time; the rest wait
      // their turn, and past a full queue the answer is "none for now" without recording it.
      if (faviconWaiting.size >= 80) return c.body(null, 404, { "Cache-Control": "private, max-age=60" });
      pending = (async () => {
        while (faviconRunning >= 6) await new Promise<void>((resolve) => faviconTurns.push(resolve));
        faviconRunning++;
        try {
          const found = await fetchFavicon(host);
          storeFavicon(host, found?.mime ?? null, found?.body ?? null);
        } catch {
          storeFavicon(host, null, null);
        } finally {
          faviconRunning--;
          faviconWaiting.delete(host);
          faviconTurns.shift()?.();
        }
      })();
      faviconWaiting.set(host, pending);
    }
    await pending;
    icon = storedFavicon(host);
  }
  if (!icon?.body || !icon.mime) return c.body(null, 404, { "Cache-Control": "private, max-age=86400" });
  return c.body(icon.body as unknown as ArrayBuffer, 200, {
    "Content-Type": icon.mime, "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline",
  });
});

// Is this address already saved? Answers with the row the member can see, or null.
app.get("/api/links/lookup", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many searches. Try again in a minute." }, 429);
  const key = linkKey((c.req.query("url") || "").slice(0, 2_000));
  const link = key ? visibleLinkByKey(viewer.account.nick, key) : null;
  return c.json({ link: link ? linkJson(link, viewer.account) : null });
});

// A link's preview image, to the members who may see the link and nobody else.
app.get("/api/links/:id/image", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  const id = Number(c.req.param("id"));
  const link = Number.isSafeInteger(id) && id > 0 ? visibleLink(viewer.account.nick, id) : null;
  const image = link ? storedImage(link.id) : null;
  if (!image) return c.body(null, 404);
  return c.body(image.body as unknown as ArrayBuffer, 200, {
    "Content-Type": image.mime, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline",
  });
});

// A link's saved copy, for the reader view: the page's text as plain text, or an X post's
// words. Only for members who may see the link; to anyone else it does not exist.
app.get("/api/links/:id/copy", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many requests. Try again in a minute." }, 429);
  const id = Number(c.req.param("id"));
  const link = Number.isSafeInteger(id) && id > 0 ? visibleLink(viewer.account.nick, id) : null;
  const copy = link ? storedCopy(link.id) : null;
  const post = link && !copy ? storedPost(link.id) : null;
  if (!link || (!copy && !post)) return c.json({ error: "no saved copy" }, 404);
  // The preview's stored size reserves its box in the reader before the picture arrives.
  const dims = storedImageDims(link.id);
  return c.json({
    id: link.id, url: link.url, title: copy?.title || link.title, byline: copy?.byline || (post ? [post.name, post.handle && `@${post.handle}`].filter(Boolean).join(" ") : ""),
    text: copy?.text ?? post!.text, savedAt: copy?.savedAt ?? link.firstSharedAt, image: link.hasImage && imageKind(link.id) === "image", gone: originalGone(link.id),
    imageWidth: dims?.width ?? null, imageHeight: dims?.height ?? null,
    kind: copy ? "page" : "post",
  });
});

// Every topic on the links this member can see, for the type-ahead when adding one to a link.
app.get("/api/links/topics", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many searches. Try again in a minute." }, 429);
  return c.json({ topics: linkFacets(viewer.account.nick).topics });
});

// Add or remove one topic on a link. Any member who can see the link may; a link the caller
// cannot see answers 404, like an id that does not exist.
const linkTopicLimit = createLimiter({ limit: 60, windowMs: 60_000 });
app.use("/api/links/:id/topics", bodyLimit({ maxSize: 1_024 }));
app.post("/api/links/:id/topics", async (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!sameOriginJson(c, "X-Slirc-Links")) return c.json({ error: "same-origin request required" }, 403);
  if (!linkTopicLimit.check(viewer.account.id)) return c.json({ error: "Too many edits. Try again in a minute." }, 429);
  const body = await c.req.json().catch(() => ({}));
  const action = body?.add !== undefined ? "add" : body?.remove !== undefined ? "remove" : null;
  const raw = action === "add" ? body.add : action === "remove" ? body.remove : "";
  const id = Number(c.req.param("id"));
  if (!action || typeof raw !== "string" || raw.length > 80) return c.json({ error: "Name one topic to add or remove." }, 400);
  const outcome = Number.isSafeInteger(id) && id > 0 ? editLinkTopic(viewer.account, id, action, raw) : { error: "missing" as const };
  if ("link" in outcome) return c.json({ link: linkJson(outcome.link, viewer.account) });
  if (outcome.error === "missing") return c.json({ error: "link not found" }, 404);
  if (outcome.error === "full") return c.json({ error: `A link holds up to ${MAX_EDITED_TOPICS} topics.` }, 400);
  return c.json({ error: "Topics use letters, numbers and hyphens." }, 400);
});

// Whoever added a link, or an admin, can remove it. A link the caller cannot see answers 404,
// the same as an id that does not exist.
app.post("/api/links/:id/remove", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!sameOriginJson(c, "X-Slirc-Links")) return c.json({ error: "same-origin request required" }, 403);
  if (!linkRemoveLimit.check(viewer.account.id)) return c.json({ error: "Too many removals. Try again in a minute." }, 429);
  const id = Number(c.req.param("id"));
  const outcome = Number.isSafeInteger(id) && id > 0 ? removeLink(viewer.account, id) : "missing";
  if (outcome === "missing") return c.json({ error: "link not found" }, 404);
  if (outcome === "forbidden") return c.json({ error: "Only the person who added it or an admin can remove this." }, 403);
  return c.json({ removed: true });
});

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

// The invite guest route stays anti-enumerating, but can no longer provision or admit accounts.
// Existing members still receive a sign-in link; unknown addresses get the same response.
async function enterAsGuest(c: any, next: string) {
  const { email } = await c.req.json().catch(() => ({}));
  const known = typeof email === "string" ? accountByEmail(email) : null;
  const devLink = known ? await sendMagicLink(known, next, c.req.header("Host")) : undefined;
  return c.json({ pending: true, devLink }, 202);
}

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

app.get("/giphy", async (c) => {
  if (!currentUser(c)) return c.json({ error: "not signed in" }, 401);
  const query = (c.req.query("q") || "").trim().slice(0, 100);
  if (!query) return c.json({ gifs: [] });
  if (!process.env.GIPHY_API_KEY) return c.json({ error: "GIF search is not configured." }, 503);
  let response: Response;
  try {
    response = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(process.env.GIPHY_API_KEY)}&q=${encodeURIComponent(query)}&limit=12&rating=g`, { signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    console.error("GIF search failed:", error);
    return c.json({ error: "GIF search is unavailable right now." }, 500);
  }
  if (!response.ok) {
    console.error(`GIF search returned ${response.status}`);
    return c.json({ error: "GIF search is unavailable right now." }, 500);
  }
  const data = await response.json() as { data: { title: string; images: { fixed_width_small: { url: string }; original: { url: string; width?: string; height?: string } } }[] };
  // Giphy sends sizes as strings; the client validates them before they go on the wire.
  return c.json({ gifs: data.data.map((gif) => ({ title: gif.title, preview: gif.images.fixed_width_small.url, url: gif.images.original.url, width: Number(gif.images.original.width) || undefined, height: Number(gif.images.original.height) || undefined })) });
});

// Media uploads: stills are normalized here, videos are stored as sent; SQLite holds them
// as blobs. Ids are random, so URLs are unlisted — access still follows the room.
const UPLOAD_LIMITS: Record<string, number> = { image: IMAGE_LIMITS.maxOriginalBytes, video: 30 * 1024 * 1024 };
const BUILTIN_EMOJI = new Set(emojiRows.map((row) => row[0]));
// The whole JSON envelope arrives before kind is known, so it must admit the legacy
// 30 MiB video as base64 (4/3) plus field overhead. Both the streamed read and the
// per-kind checks below bound what is actually retained.
const MAX_UPLOAD_REQUEST_BYTES = Math.ceil((UPLOAD_LIMITS.video * 4) / 3) + 512 * 1024;

// Read a JSON object with a hard byte cap, streaming so an absent or lying
// Content-Length cannot allocate an unbounded buffer before the check. The
// signal aborts a stalled read so an upload slot is never held forever.
type BoundedJson = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 408 | 413; error: string };
async function readBoundedJson(c: Context, maxBytes: number, signal: AbortSignal): Promise<BoundedJson> {
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

app.post("/api/uploads", async (c) => {
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

app.get("/api/emoji", (c) => {
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
// Read once at start so a bad SLIRC_EMOJI_BUDGET_BYTES stops the app instead of the first add.
emojiBudgetBytes();

app.post("/api/emoji", async (c) => {
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

app.delete("/api/emoji/:name", (c) => {
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

// The workspace icon replaces the letter tile in the sidebar, the Workspaces dialog and the Mac
// picker. Its renditions live in uploads under the scope "workspace-icon", which is not a channel:
// canReadUploadChannel refuses it, so /uploads/:id never serves them and room deletion never
// touches them. GET /api/workspace-icon is the only read path. The icon is public by design, even
// in a private workspace: another workspace's Workspaces dialog shows it to people who are not
// signed in here, the way a favicon shows. Only admins write it.
const WORKSPACE_ICON_SCOPE = "workspace-icon";
const MAX_WORKSPACE_ICON_REQUEST_BYTES = Math.ceil((WORKSPACE_ICON_LIMITS.maxBytes * 4) / 3) + 4096;
const iconCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Admin");

// The icon's version, the time it was saved, or "" when there is none.
function workspaceIconVersion(): string {
  const row = db.query("SELECT created_at FROM uploads WHERE channel = ? AND kind = 'icon-64'").get(WORKSPACE_ICON_SCOPE) as { created_at: number } | null;
  return row ? String(row.created_at) : "";
}

function workspaceIconAdmin(c: Context) {
  const admin = verifiedHuman(c);
  if (!admin) return { error: c.json({ error: "not signed in" }, currentUser(c) ? 403 : 401) };
  if (admin.role !== "admin") return { error: c.json({ error: "admin required" }, 403) };
  if (!iconCsrf(c)) return { error: c.json({ error: "cross-site request refused" }, 403) };
  return { admin };
}

app.get("/api/workspace-icon", (c) => {
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

app.post("/api/admin/workspace-icon", async (c) => {
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

app.delete("/api/admin/workspace-icon", (c) => {
  c.header("Cache-Control", "no-store");
  const check = workspaceIconAdmin(c);
  if (check.error) return check.error;
  db.query("DELETE FROM uploads WHERE channel = ?").run(WORKSPACE_ICON_SCOPE);
  return c.body(null, 204);
});

// Pixel sizes of photos already stored, so a reader reserves each picture's box before its bytes
// arrive. The same membership rule as /uploads/:id; anything unreadable or unknown is left out.
app.get("/api/uploads/dims", (c) => {
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

app.get("/uploads/:id", (c) => {
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

// Small in-process cache for unfurls; a repeated link is a repeated fetch otherwise.
// ponytail: single Map, no TTL sweep — size is bounded by distinct links in a session.
const embedCache = new Map<string, Record<string, string>>();

// Player hosts we will frame. Anything else degrades to the link card. Vimeo gets do-not-track.
const PLAYER_HOSTS = new Set([
  "player.vimeo.com", "open.spotify.com", "w.soundcloud.com", "embed.bsky.app", "www.tiktok.com", "www.loom.com",
  "codepen.io", "www.figma.com", "embed.music.apple.com", "bandcamp.com", "embed.podcasts.apple.com", "www.youtube-nocookie.com",
  "video.twimg.com", "player.twitch.tv", "clips.twitch.tv", "embed.ted.com", "www.dailymotion.com", "www.kickstarter.com",
]);
// Providers whose pages omit the oEmbed <link> for bots. host -> endpoint that takes ?url=.
const OEMBED_ENDPOINTS: Record<string, string> = {
  "vimeo.com": "https://vimeo.com/api/oembed.json",
  "player.vimeo.com": "https://vimeo.com/api/oembed.json",
  "bsky.app": "https://embed.bsky.app/oembed",
  "www.tiktok.com": "https://www.tiktok.com/oembed",
  "www.twitch.tv": "https://api.twitch.tv/v5/oembed",
  "soundcloud.com": "https://soundcloud.com/oembed",
  "www.loom.com": "https://www.loom.com/v1/oembed",
  "codepen.io": "https://codepen.io/api/oembed",
};
function playerFromOembed(data: Record<string, unknown>, page: URL): { src: string; width: number | null; height: number | null } | null {
  if (data.type !== "video" && data.type !== "rich") return null;
  if (typeof data.html !== "string") return null;
  const src = data.html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, "&");
  if (!src) return null;
  let target: URL;
  try { target = new URL(src, page); } catch { return null; }
  if (target.protocol !== "https:") return null;
  // Same-host players (Mastodon instances, PeerTube) are fine: the page itself vouches for them.
  if (!PLAYER_HOSTS.has(target.hostname) && target.hostname !== page.hostname) return null;
  if (target.hostname === "player.vimeo.com") target.searchParams.set("dnt", "1");
  const size = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return { src: target.href, width: size(data.width), height: size(data.height) };
}

// Preview images go through the app, so a reader's browser never contacts the provider until they press play.
// Local dev serves on private addresses (Tailscale CGNAT, LAN, loopback) that the SSRF
// guard blocks by design. This flag turns the guard off for the local stack only;
// production never sets it.
const embedAllowPrivate = process.env.EMBED_ALLOW_PRIVATE === "true";

const imageCache = new Map<string, { type: string; body: Uint8Array; at: number }>();
// Raster types only: an SVG served from the app origin can run script when opened directly.
const RASTER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
// Video thumbnails for guests. Members still proxy any embed image; anonymous readers
// only ever reach these hosts, so the endpoint stays useless as an open image proxy.
const guestImageHosts = new Set(["i.ytimg.com"]);
app.get("/api/embed/image", async (c) => {
  // Every failure path stays out of caches: a transient upstream 404 must not be
  // pinned for a day by the browser. Only a decoded image gets the long private TTL.
  c.header("Cache-Control", "no-store");
  const raw = c.req.query("url") || "";
  let target: URL;
  try { target = new URL(raw); } catch { return c.body(null, 400); }
  if (target.protocol !== "https:" && target.protocol !== "http:") return c.body(null, 400);
  const cached = imageCache.get(target.href);
  // A signed-out reader (the #open-chat peek) gets images a member already loaded, like link
  // previews in /api/embed; the server never fetches a picture because a guest asked for it.
  if (!currentUser(c) && !guestImageHosts.has(target.hostname) && !cached) return c.body(null, 401);
  if (cached) {
    c.header("Cache-Control", "private, max-age=86400");
    for (const [name, value] of Object.entries(untrustedMediaHeaders(cached.type, "image"))) c.header(name, value);
    return c.body(cached.body);
  }
  try {
    const response = await fetchPublic(target, { accept: "image/*", allowPrivate: embedAllowPrivate });
    const type = (response.header("content-type") || "").split(";", 1)[0]!.trim().toLowerCase();
    if (!response.ok || !RASTER_IMAGE_TYPES.has(type)) {
      response.close();
      return c.body(null, 404);
    }
    const body = await response.bytes(3_000_000);
    if (imageCache.size >= 80) imageCache.delete([...imageCache.keys()][0]);
    imageCache.set(target.href, { type, body, at: Date.now() });
    c.header("Cache-Control", "private, max-age=86400");
    for (const [name, value] of Object.entries(untrustedMediaHeaders(type, "image"))) c.header(name, value);
    return c.body(body);
  } catch (error) {
    if (error instanceof ResponseTooLarge) return c.body(null, 413);
    if (error instanceof Error && error.message === "blocked") return c.body(null, 403);
    return c.body(null, 404);
  }
});

app.post("/api/embed", async (c) => {
  const nick = currentUser(c);
  const { url: rawUrl } = await c.req.json().catch(() => ({}));
  if (typeof rawUrl !== "string" || !/^https?:\/\/[^\s]+$/i.test(rawUrl)) return c.json({ error: "invalid url" }, 400);
  let url: URL;
  try { url = new URL(rawUrl); } catch { return c.json({ error: "invalid url" }, 400); }
  if (!["http:", "https:"].includes(url.protocol)) return c.json({ error: "invalid url" }, 400);
  if (embedCache.has(url.href)) return c.json(embedCache.get(url.href));
  // Anonymous readers in open channels see previews a member already fetched for that
  // link; the server never fetches a page because a guest asked it to.
  if (!nick) return c.json({});

  try {
    const page = await fetchPublic(url, { allowPrivate: embedAllowPrivate });
    // A URL that serves an image is its own preview: reuse the embed card's proxied
    // image instead of parsing binary bytes as OpenGraph HTML.
    const directImage = page.ok ? directImageEmbed(page.finalUrl.href, page.header("content-type")) : null;
    if (directImage) {
      let dimensions: { width: number; height: number } | undefined;
      try {
        const bytes = await page.bytes(3_000_000);
        const meta = await new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels, autoOrient: true }).metadata();
        if (meta.width && meta.height && meta.width * meta.height <= IMAGE_LIMITS.maxPixels) {
          dimensions = { width: meta.width, height: meta.height };
        }
        if (imageCache.size >= 80) imageCache.delete([...imageCache.keys()][0]);
        imageCache.set(page.finalUrl.href, { type: page.header("content-type")!, body: bytes, at: Date.now() });
      } catch { /* Unsupported/oversized images retain the existing validated fallback. */ }
      finally { page.close(); }
      const result = { ...directImage, ...dimensions };
      if (embedCache.size >= 200) embedCache.delete([...embedCache.keys()][0]);
      embedCache.set(url.href, result);
      return c.json(result);
    }
    const html = await page.text(512_000);
    const base = page.finalUrl;
    const meta: Record<string, unknown> = parseOg(html);
    if (typeof meta.image === "string") {
      try { meta.image = new URL(meta.image, base).href; } catch { delete meta.image; }
    }
    // oEmbed: the page advertises a JSON endpoint; providers on the allowlist may supply a player iframe.
    // The browser never loads provider HTML; we keep only the iframe src and render our own sandboxed frame.
    const oembedHref = html.match(/<link[^>]+type=["']application\/json\+oembed["'][^>]*href=["']([^"']+)["']/i)?.[1]
      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/json\+oembed["']/i)?.[1];
    const knownEndpoint = OEMBED_ENDPOINTS[base.hostname] || OEMBED_ENDPOINTS[url.hostname];
    if (oembedHref || knownEndpoint) {
      try {
        const endpoint = oembedHref ? new URL(oembedHref.replace(/&amp;/g, "&"), base) : new URL(`${knownEndpoint}?format=json&url=${encodeURIComponent(url.href)}`);
        if (endpoint.protocol === "https:") {
          const response = await fetchPublic(endpoint, { accept: "application/json", maxHops: 3, allowPrivate: embedAllowPrivate });
          const data = JSON.parse(await response.text(512_000)) as Record<string, unknown>;
          const player = playerFromOembed(data, base);
          if (player) meta.player = player;
          if (!meta.title && typeof data.title === "string") meta.title = data.title;
          if (!meta.site && typeof data.provider_name === "string") meta.site = data.provider_name;
          if (typeof data.author_name === "string") meta.author = data.author_name;
          if (!meta.image && typeof data.thumbnail_url === "string") meta.image = data.thumbnail_url;
          if (data.type === "photo" && typeof data.url === "string") meta.image = data.url;
        }
      } catch (error) {
        console.error(`oembed skipped for ${url.href}:`, error instanceof Error ? error.message : error);
      }
    }
    // CodePen fronts its oEmbed with a bot check; the embed URL follows from the pen URL anyway.
    if (!meta.player && url.hostname === "codepen.io") {
      const pen = url.pathname.match(/^\/([\w-]+)\/(?:pen|full|details)\/([A-Za-z]+)/);
      if (pen) {
        meta.player = { src: `https://codepen.io/${pen[1]}/embed/${pen[2]}?default-tab=result`, width: null, height: null };
        if (!meta.site) meta.site = "CodePen";
      }
    }
    if (embedCache.size >= 200) embedCache.delete([...embedCache.keys()][0]);
    embedCache.set(url.href, meta);
    return c.json(meta);
  } catch (error) {
    // Best-effort previews: a page that blocks bots or times out is not an app
    // error, so the client gets an empty card instead of a noisy 502.
    console.error(`embed failed for ${url.href}:`, error instanceof Error ? error.message : error);
    return c.json({});
  }
});

app.post("/api/channels", async (c) => {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  if (account?.kind === "agent") return c.json({ error: "agents cannot manage channels" }, 403);
  if (!account?.verifiedAt) return c.json({ error: "verify your email before creating channels" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const channel = typeof body.name === "string" ? `#${body.name.trim().replace(/^#+/, "").toLowerCase()}` : "";
  // A private workspace creates secret channels unless the caller names `workspace` explicitly. An
  // explicit value we do not recognise is rejected before any mutation, so a typo cannot publish.
  const requested = body.visibility;
  const privateMode = slircMode() === "private_workspace";
  if (privateMode && requested !== undefined && requested !== "secret" && requested !== "workspace") {
    return c.json({ error: "Visibility must be secret or workspace." }, 400);
  }
  const visibility = requested === "secret" || (privateMode && requested === undefined) ? "secret" : "workspace";
  if (!/^#[a-z][a-z0-9_-]{1,31}$/.test(channel)) return c.json({ error: "Use 2–32 letters, numbers, dashes, or underscores." }, 400);
  // Thread, DM and group names are minted by the server; a plain channel under one would pass for them.
  if (/^#(?:t|dm|g)-/.test(channel)) return c.json({ error: "That name is reserved." }, 400);
  try {
    if (channelInfo(channel) || await ircChannelExists(channel)) return c.json({ error: "That channel already exists." }, 409);
    await createChannel(channel, account.nick, visibility);
    db.transaction(() => {
      db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, ?, ?)").run(channel, account.nick, visibility, Date.now());
      db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(channel, account.nick);
    })();
    channelsChanged(channel, [account.nick], true);
    void opAdmins(channel);
    return c.json({ channel, owner: account.nick, visibility, topic: "", archived: false }, 201);
  } catch (error) {
    return appError(c, error, "Could not create channel.");
  }
});

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

app.post("/api/channels/:channel/join", (c) => {
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const nick = requester.nick;
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  if (!joinWorkspaceChannel(nick, channel)) return c.json({ error: "channel is unavailable" }, 404);
  channelsChanged(channel, [nick], true);
  return c.json({ channel });
});

app.patch("/api/channels/:channel", async (c) => {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const info = channelInfo(channel);
  if (account?.kind === "agent") return c.json({ error: "agents cannot manage channels" }, 403);
  if (!account || !info) return c.json({ error: "channel not found" }, 404);
  const { action, topic, source, name } = await c.req.json().catch(() => ({}));
  const manages = info.owner === account.nick || account.role === "admin";
  // A DM stays between its two people, and a thread follows its parent: neither can be opened,
  // closed or archived on its own, by anyone, admins included.
  const isThread = !!db.query("SELECT 1 FROM threads WHERE channel = ?").get(channel);
  if (["open", "secret", "archive", "unarchive"].includes(action) && (info.visibility === "direct" || isThread)) {
    return c.json({ error: info.visibility === "direct" ? "a DM cannot change visibility" : "a thread follows its channel" }, 403);
  }
  try {
    if (action === "rename" && manages) {
      if (info.visibility === "direct" || isOpenChannel(channel)) return c.json({ error: "this channel cannot be renamed" }, 400);
      const next = typeof name === "string" ? `#${name.trim().replace(/^#+/, "").toLowerCase()}` : "";
      if (!/^#[a-z][a-z0-9_-]{1,31}$/.test(next)) return c.json({ error: "Use 2–32 letters, numbers, dashes, or underscores." }, 400);
      if (next === channel) return c.json(info);
      // The app database is the source of truth for names it manages. Ergo keeps a channel in the
      // owner's registered list even after we unregister it, so a name we freed by an earlier rename
      // lingers there; trusting it would block renaming back. createChannel absorbs "already
      // registered", so a stale Ergo entry reconciles on the way through.
      if (channelInfo(next)) return c.json({ error: "That channel already exists." }, 409);
      const members = (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[]).map((row) => row.nick);
      await renameChannel(channel, next, info.owner, info.visibility === "secret" ? "secret" : "workspace", members, info.topic || "");
      db.transaction(() => {
        db.query("UPDATE channels SET channel = ? WHERE channel = ?").run(next, channel);
        db.query("UPDATE channel_members SET channel = ? WHERE channel = ?").run(next, channel);
        db.query("UPDATE invites SET channel = ? WHERE channel = ?").run(next, channel);
        db.query("UPDATE uploads SET channel = ? WHERE channel = ?").run(next, channel);
        renameLinksChannel(channel, next);
        db.query("UPDATE meta SET key = ? WHERE key = ?").run(`seeded:${next}`, `seeded:${channel}`);
        db.query("UPDATE threads SET parent = ? WHERE parent = ?").run(next, channel);
        db.query("UPDATE project_repos SET channel = ? WHERE channel = ?").run(next, channel);
      })();
      channelsChanged(next, members, true);
      void opAdmins(next);
      return c.json(channelInfo(next));
    }
    if (action === "topic") {
      if (!isMember(account.nick, channel)) return c.json({ error: "channel membership required" }, 403);
      if (typeof topic !== "string" || Buffer.byteLength(topic, "utf8") > 200) return c.json({ error: "Topic must fit within 200 bytes." }, 400);
      // No control characters: CR/LF would start a second IRC command, and the rest render as garbage.
      if (/[\x00-\x1f\x7f]/.test(topic)) return c.json({ error: "Topic can't contain control characters." }, 400);
      // The PWA sets the topic over the member's own IRC connection when it can (source "irc"), so the
      // change is attributed to the person. The oper path is the fallback for channels still carrying +t.
      if (source !== "irc") await setChannelTopic(channel, topic.trim());
      db.query("UPDATE channels SET topic = ? WHERE channel = ?").run(topic.trim(), channel);
    } else if ((action === "archive" || action === "unarchive") && manages) {
      if (source !== "irc") await setChannelMode(channel, action === "archive" ? "+m" : "-m");
      db.query("UPDATE channels SET archived_at = ? WHERE channel = ?").run(action === "archive" ? Date.now() : null, channel);
      // Members' open pages reload channel details, so the composer gives way to the read-only bar at once.
      channelsChanged(channel, (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[]).map((row) => row.nick), true);
    } else if (action === "secret" && manages) {
      const members = (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[]).map((row) => row.nick);
      await makeChannelSecret(channel, members);
      // Public threads go private with their parent: same +si and +I list, and only parent members
      // keep a child row. Anyone else sitting in one is kicked. Already private threads keep their
      // own, narrower grants.
      const children = threadChildren(channel).filter((child) => child.visibility === "workspace").map((child) => child.channel);
      await makeThreadChannelsSecret(children, members);
      db.transaction(() => {
        db.query("UPDATE channels SET visibility = 'secret' WHERE channel = ?").run(channel);
        for (const child of children) {
          db.query("UPDATE channels SET visibility = 'secret' WHERE channel = ?").run(child);
          db.query(`DELETE FROM channel_members WHERE channel = ? AND nick NOT IN (SELECT nick FROM channel_members WHERE channel = ?)`).run(child, channel);
          for (const member of members) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(child, member);
        }
      })();
    } else if (action === "open" && manages) {
      // Existing secret history never becomes workspace-readable in a private workspace. Deny before
      // any SAMODE or SQLite write so a failed conversion leaves the channel exactly as it was.
      if (slircMode() === "private_workspace" && info.visibility === "secret") return c.json({ error: "a secret channel cannot be opened in a private workspace" }, 403);
      if (info.isGroup) return c.json({ error: "private groups cannot be opened" }, 403);
      const agentGrant = db.query(`WITH RECURSIVE descendants(channel) AS (
          SELECT ? UNION SELECT threads.channel FROM threads JOIN descendants ON threads.parent = descendants.channel
        ) SELECT 1 FROM descendants d JOIN channel_members m ON m.channel = d.channel
          JOIN accounts a ON a.nick = m.nick COLLATE NOCASE WHERE a.kind = 'agent' LIMIT 1`).get(channel);
      if (agentGrant) return c.json({ error: "Remove agent access from this channel and its threads before opening it." }, 409);
      await makeChannelOpen(channel);
      db.query("UPDATE channels SET visibility = 'workspace' WHERE channel = ?").run(channel);
    } else {
      return c.json({ error: "channel owner required" }, 403);
    }
    return c.json(channelInfo(channel));
  } catch (error) {
    return appError(c, error, "Could not update channel.");
  }
});

// Who may add whom to a channel. The POST below enforces it and the lookup reports it, so the
// inline Add prompt never offers a click the server would refuse. A person must be discoverable to
// whoever adds them, the same gate as people search.
function memberAddDenial(nick: string, channel: string, target: Account | null): { error: string; status: 403 | 404 } | null {
  if (accountByNick(nick)?.kind === "agent") return { error: "agents cannot manage channels", status: 403 };
  if ((!channelInfo(channel) && !isOpenChannel(channel)) || /^#(t-|dm-)/.test(channel)) return { error: "channel not found", status: 404 };
  if (!isMember(nick, channel) && !isOpenChannel(channel)) return { error: "channel membership required", status: 403 };
  if (!target || (target.kind === "human" && target.nick.toLowerCase() !== nick.toLowerCase() && !discoverableHuman(nick, target.id))) return { error: "person not found", status: 404 };
  if (target.kind === "agent") {
    if (!agentSessionCapabilities.enabled) return { error: agentSessionCapabilities.reason, status: 403 };
    // Open and workspace channels accept an agent only as an owner-only attachment; the attach
    // route writes that flag and the transport wakes the agent for its owner alone.
    if (!isOpenChannel(channel) && !["secret", "workspace"].includes(channelInfo(channel)?.visibility || "")) return { error: "agents can only join channels", status: 403 };
    if (target.owner?.toLowerCase() !== nick.toLowerCase()) return { error: "only the owner can invite this agent", status: 403 };
  }
  return null;
}

// Bots and helpers join only rooms with a membership row, even open ones; every human is already in
// an open channel.
function belongsTo(target: Account, channel: string): boolean {
  if (target.kind === "human") return isMember(target.nick, channel);
  return !!db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ?").get(channel, target.nick);
}

// Everyone who belongs to a channel, for the members panel. Presence comes from IRC on the client.
app.get("/api/channels/:channel/members", (c) => {
  const nick = currentUser(c);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const info = channelInfo(channel);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  // Public rooms have no membership list; the client shows whoever is present from NAMES.
  if (isOpenChannel(channel)) { c.header("Cache-Control", "no-store"); return c.json({ channel, owner: null, public: true, members: [] }); }
  if (!info || info.visibility === "direct") return c.json({ error: "channel not found" }, 404);
  if (!isMember(nick, channel)) return c.json({ error: "channel membership required" }, 403);
  const rows = db.query(`SELECT m.nick, a.kind, a.role, a.machine, p.availability, p.badge, p.avatar_path, p.avatar_version FROM channel_members m LEFT JOIN accounts a ON a.nick = m.nick COLLATE NOCASE
                         LEFT JOIN profiles p ON p.account = m.nick COLLATE NOCASE
                         WHERE m.channel = ? AND m.nick COLLATE NOCASE NOT IN ('slirc', ?) ORDER BY m.nick`).all(channel, ergoOperUser()) as { nick: string; kind: string | null; role: string | null; machine: string | null; availability: string | null; badge: string | null; avatar_path: string | null; avatar_version: number | null }[];
  c.header("Cache-Control", "no-store");
  const viewer = accountByNick(nick);
  const pendingInvitations = viewer ? [...new Map(listEmailInvites(viewer.id)
    .filter((row) => row.channel === channel && ["pending", "sending", "uncertain"].includes(row.status))
    .map((row) => [row.recipientEmail, { email: row.recipientEmail, status: row.status }])).values()] : [];
  return c.json({ channel, owner: info.owner, pendingInvitations, members: rows.map((row) => ({ nick: row.nick, kind: row.kind || "member", role: row.role || "member", machine: row.machine || null, availability: row.availability || "", badge: normalizeProfileBadge(row.badge), avatarVersion: avatarVersion(row), ...(row.kind === "agent" ? { attached: agentAttached(row.nick), agent: agentMetadata(row.nick) } : {}) })) });
});

// The inline Add prompt asks before it offers Add: is this nick here already, and may I add them?
// Unknown people, hidden people and other owners' agents get the same 404 as search would give.
app.get("/api/channels/:channel/members/:nick", (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const lookedUp = accountByNick(c.req.param("nick").replace(/^@/, ""));
  // A helper this instance does not run is missing, so no Add note offers it.
  const found = lookedUp && !inactiveHelper(lookedUp.nick) ? lookedUp : null;
  const target = found?.kind === "agent" && found.owner?.toLowerCase() !== nick.toLowerCase() ? null : found;
  const denial = memberAddDenial(nick, channel, target);
  c.header("Cache-Control", "no-store");
  if (denial) return c.json({ error: denial.error }, denial.status);
  return c.json({ channel, nick: target!.nick, kind: target!.kind, member: belongsTo(target!, channel) });
});

app.post("/api/channels/:channel/members", async (c) => {
  const nick = currentUser(c);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const { nick: rawTarget, invite, msgid } = await c.req.json().catch(() => ({}));
  const lookedUp = typeof rawTarget === "string" ? accountByNick(rawTarget.replace(/^@/, "")) : null;
  const found = lookedUp && !inactiveHelper(lookedUp.nick) ? lookedUp : null;
  // invite: "self" means the PWA will send INVITE over the member's own connection after we set +I;
  // "app" (default, and the fallback when Ergo refused the member) makes the oper send it.
  const inviteMode = invite === "self" ? "self" : "app";
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const denial = memberAddDenial(nick, channel, found);
  if (denial) return c.json({ error: denial.error }, denial.status);
  const target = found!;
  // Add on a helper prompt names the message that mentioned the helper; it answers that line once
  // it joins. Only a fresh add queues it, so a helper that was already here never answers twice.
  const catchUp = () => { if (typeof msgid === "string") queueHelperCatchUp(target.nick, channel, msgid, nick); };
  if (isOpenChannel(channel)) {
    const added = target.kind !== "human" && !db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ?").get(channel, target.nick);
    if (added) {
      db.query("INSERT INTO channel_members (channel, nick, owner_only) VALUES (?, ?, ?)").run(channel, target.nick, target.kind === "agent" ? 1 : 0);
      catchUp();
      // An owner's agent attaches to the open room and is woken only by that owner.
      if (target.kind === "agent") void joinAgentRoomForNick(target.nick, channel).catch(() => {});
    }
    return c.json({ channel, nick: target.nick, added });
  }
  const alreadyMember = isMember(target.nick, channel);
  if (alreadyMember && !(inviteMode === "app" && invite === "app")) return c.json({ channel, nick: target.nick, added: false });
  // A workspace attachment is owner-only too; the transport joins it plainly instead of via +I.
  const workspaceAgent = target.kind === "agent" && channelInfo(channel)?.visibility === "workspace";
  db.query("INSERT INTO channel_members (channel, nick, owner_only) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(channel, target.nick, workspaceAgent ? 1 : 0);
  try {
    if (workspaceAgent) void joinAgentRoomForNick(target.nick, channel).catch(() => {});
    else if (inviteMode === "self") await allowChannelAccess(channel, target.nick);
    else await grantChannelAccess(channel, target.nick);
  } catch (error) {
    console.error(`mention grant failed for ${target.nick} in ${channel}:`, error);
    return c.json({ error: "could not add to channel" }, 500);
  }
  // A freshly granted secret room is joined now; the transport re-proves live +s/+i before JOIN.
  if (target.kind === "agent" && !workspaceAgent) void joinAgentRoomForNick(target.nick, channel).catch(() => {});
  if (!alreadyMember) { catchUp(); channelsChanged(channel, [target.nick], true); }
  return c.json({ channel, nick: target.nick, added: true });
});

app.post("/api/channels/:channel/kick", async (c) => {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const info = channelInfo(channel);
  const { nick: target, reason, source } = await c.req.json().catch(() => ({}));
  if (account?.kind === "agent") return c.json({ error: "agents cannot manage channels" }, 403);
  if (!account || account.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!info || info.visibility === "direct") return c.json({ error: "channel not found" }, 404);
  if (typeof target !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(target) || target.toLowerCase() === account.nick.toLowerCase()) return c.json({ error: "invalid member" }, 400);
  if (!isMember(target, channel)) return c.json({ error: "member not found" }, 404);
  // Admins can't remove each other from channels, the same rule as removing a person.
  if (accountByNick(target)?.role === "admin") return c.json({ error: "You can't kick an admin." }, 403);
  if (typeof reason !== "string" || Buffer.byteLength(reason, "utf8") > 200 || /[\r\n]/.test(reason)) return c.json({ error: "Kick reason must fit within 200 bytes." }, 400);
  try {
    if (source !== "irc") await kickChannelMember(channel, target, reason.trim() || "Removed by an admin");
    if (info.visibility === "secret") await revokeChannelAccess(channel, target);
    // Threads before the parent row, so a failed IRC step leaves a kick that can be retried.
    await removeFromThreads(target, channel, reason.trim() || "Removed by an admin");
    db.query("DELETE FROM channel_members WHERE channel = ? AND nick = ?").run(channel, target);
    channelsChanged(channel, [target], false);
    // Stop any session transport using this room and clear its revoked cached context.
    evictAgentRoomForNick(target, channel);
    if (accountByNick(target)?.kind === "human") await removeOwnerAgentsFromChannel(target, channel);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not remove member.");
  }
});

// Server-enforced moderation delete. Admins are ops and may remove anyone's message, but the
// authorization is recomputed from current state, never from the request: the session account's
// verified admin role, its immutable account id, and live read access to the channel. An admin has
// no private-DM backdoor; a thread needs both parent access and child readability.
const REDACT_CHANNEL = /^#[a-z0-9][a-z0-9_-]{0,62}$/i;
const REDACT_BODY_LIMIT = 4_096;
const redactLimit = createLimiter({ limit: 30, windowMs: 60_000 });

function canReadChannelForModeration(nick: string, channel: string): boolean {
  const info = channelInfo(channel);
  // Configured open channels (#open-chat, #help) have no channels row; everyone can read them.
  if (!info) return isOpenChannel(channel);
  if (info.visibility === "direct") {
    const pair = db.query("SELECT first_nick, second_nick FROM direct_conversations WHERE channel = ?").get(info.channel) as { first_nick: string; second_nick: string } | null;
    if (!pair) return false;
    const folded = asciiFold(nick);
    return pair.first_nick === folded || pair.second_nick === folded;
  }
  const thread = db.query("SELECT parent FROM threads WHERE channel = ?").get(info.channel) as { parent: string } | null;
  if (thread) return canSeeThreadChannel(nick, channel) && canReadChannelForModeration(nick, thread.parent);
  return isOpenChannel(channel) || isMember(nick, channel);
}

app.use("/api/messages/redact", bodyLimit({ maxSize: REDACT_BODY_LIMIT }));
app.post("/api/messages/redact", async (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const account = accountByNick(nick);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (account.kind !== "human" || !account.verifiedAt || account.role !== "admin") return c.json({ error: "admin required" }, 403);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const channel = typeof body.channel === "string" ? normalized(body.channel) : "";
  const msgid = typeof body.msgid === "string" ? body.msgid : "";
  const accountId = typeof body.accountId === "string" ? body.accountId : null;
  const clientId = body.clientId === undefined ? undefined : typeof body.clientId === "string" ? body.clientId : null;
  if (!REDACT_CHANNEL.test(channel) || !/^[A-Za-z0-9_-]{1,64}$/.test(msgid)) return c.json({ error: "invalid channel or message id" }, 400);
  if (clientId === null || (clientId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(clientId))) return c.json({ error: "invalid correlation id" }, 400);
  // The account id is the immutable identity half; a stale id means the caller's session no longer
  // matches the account it claims to act as, so refuse rather than deleting from a moved identity.
  if (accountId === null) return c.json({ error: "accountId is required" }, 400);
  if (accountId !== account.id) return c.json({ error: "stale account" }, 409);
  // A channel the caller cannot read is reported as missing whether it never existed or is private.
  if (!canReadChannelForModeration(account.nick, channel)) return c.json({ error: "channel not found" }, 404);
  if (!redactLimit.check(account.nick)) return c.json({ error: "too many moderation attempts" }, 429);

  // Re-checked inside the helper immediately before REDACT, after the oper login, the channel
  // existence probe, and the join; a revoke during those awaits wins over the deletion.
  const stillAuthorized = () => {
    const current = accountByNick(account.nick);
    return !!current && current.kind === "human" && !!current.verifiedAt && current.role === "admin" && canReadChannelForModeration(current.nick, channel);
  };
  try {
    const result = await redactMessage(channel, msgid, clientId, stillAuthorized);
    return c.json(result === "gone" ? { ok: true, gone: true } : { ok: true });
  } catch (error) {
    if (error instanceof NotAuthorizedError) return c.json({ error: "moderation access changed" }, 403);
    console.error(`admin delete in ${channel} failed:`, error instanceof Error ? error.message : error);
    return appError(c, error, "could not redact message");
  }
});

// An admin edits a bot's message. The same admin, channel and rate checks as the moderation delete
// above; the edit itself goes out from the bot's own account (bot-edit.ts), which also proves from
// Ergo's history that the bot wrote the message. People's and agents' messages are refused.
app.use("/api/messages/bot-edit", bodyLimit({ maxSize: 16_384 }));
app.post("/api/messages/bot-edit", async (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const account = accountByNick(nick);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (account.kind !== "human" || !account.verifiedAt || account.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!sameOriginJson(c, "X-Slirc-Edit")) return c.json({ error: "same-origin request required" }, 403);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const channel = typeof body.channel === "string" ? normalized(body.channel) : "";
  const msgid = typeof body.msgid === "string" ? body.msgid : "";
  const bot = typeof body.bot === "string" ? body.bot : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!REDACT_CHANNEL.test(channel) || !/^[A-Za-z0-9_-]{1,64}$/.test(msgid)) return c.json({ error: "invalid channel or message id" }, 400);
  if (body.accountId !== account.id) return c.json({ error: "stale account" }, 409);
  if (!editableBot(bot)) return c.json({ error: "only bot messages can be edited" }, 403);
  if (!validEditText(text)) return c.json({ error: "invalid text" }, 400);
  if (!canReadChannelForModeration(account.nick, channel)) return c.json({ error: "channel not found" }, 404);
  if (!redactLimit.check(account.nick)) return c.json({ error: "too many moderation attempts" }, 429);

  const stillAuthorized = () => {
    const current = accountByNick(account.nick);
    return !!current && current.kind === "human" && !!current.verifiedAt && current.role === "admin" && canReadChannelForModeration(current.nick, channel);
  };
  try {
    const result = await editBotMessage(bot, channel, msgid, text, stillAuthorized);
    return c.json({ ok: true, msgid: result.msgid });
  } catch (error) {
    if (error instanceof BotEditError) return c.json({ error: error.message }, error.status as 400);
    console.error(`bot edit in ${channel} failed:`, error instanceof Error ? error.message : error);
    return appError(c, error, "could not edit message");
  }
});

// Old #t- threads: the `threads` table stays until a later migration drops it.
// Child half of the thread read boundary used by rooms.ts: a workspace child is readable by parent
// members, anything else (secret, direct, or a legacy child with no channels row) needs an explicit
// child grant. Kept local so POST /api/threads cannot leak an existing private row on re-registration.
function canSeeThreadChannel(nick: string, channel: string) {
  const info = channelInfo(channel);
  if (info && info.visibility === "workspace") return true;
  return isMember(nick, channel);
}
// Reply threads (IRCv3 +reply) this person started or replied to, in channels they can read now.
app.get("/api/reply-threads", (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json({ threads: replyThreadsFor(nick) });
});

// Creation is retired: reply threads need no channel.
app.post("/api/threads", (c) => c.json({ error: "threads are now replies inside the conversation" }, 410));

app.delete("/api/channels/:channel/membership", async (c) => {
  const nick = currentUser(c);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const info = nick && channelInfo(channel);
  if (!nick || !info || !isMember(nick, channel)) return c.json({ error: "channel cannot be left" }, 403);
  if (info.isGroup && info.owner.toLowerCase() === nick.toLowerCase()) return c.json({ error: "group owner cannot leave; transfer or delete the group first" }, 409);
  try {
    // Owners keep their +I invite so they can come back through an invite link.
    if (info.visibility === "secret" && info.owner !== nick) await revokeChannelAccess(channel, nick);
    await removeFromThreads(nick, channel, "Left the channel", info.owner === nick);
    if (!leaveChannel(nick, channel)) return c.json({ error: "channel cannot be left" }, 403);
    channelsChanged(channel, [nick], false);
    await removeOwnerAgentsFromChannel(nick, channel);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not leave channel.");
  }
});

// Deleting a channel is admin-only and final: threads, members, invites, uploads and app rows go,
// Ergo history is purged, and the oper unregisters the room and kicks whoever is still in it.
// DMs, group DMs and threads have their own delete paths; the default and configured open
// channels are where people land, so they stay.
app.delete("/api/channels/:channel", async (c) => {
  const nick = currentUser(c);
  const account = nick && accountByNick(nick);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  if (!account) return c.json({ error: "sign in required" }, 401);
  if (account.role !== "admin") return c.json({ error: "Only admins can delete channels." }, 403);
  const info = channelInfo(channel);
  if (!info) return c.json({ error: "channel not found" }, 404);
  if (info.visibility === "direct" || info.isGroup || /^#(?:t|dm)-/i.test(channel)) return c.json({ error: "Only channels can be deleted here." }, 400);
  if (channel === defaultChannel() || isOpenChannel(channel)) return c.json({ error: "The default channel can't be deleted." }, 409);
  const members = (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[]).map((row) => row.nick);
  try {
    // Same gap as DMs: unregister leaves Ergo history behind. deleteChannelTree clears each channel
    // (and every child thread) first, so a later room of the same name starts empty.
    await deleteChannelTree(channel, unregisterChannel, purgeChannelHistory);
    // Links kept for this channel's members alone go with it.
    deleteScopedLinks(channel);
    channelsChanged(channel, [...members, account.nick], false, { deleted: true });
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not delete channel.");
  }
});

// Reusable membership-granting channel links are disabled: they cannot expire or be revoked.
// Bounded, email-specific invitations remain the way to add people to a channel.
app.post("/api/invites", (c) => c.json({ error: "Reusable channel invite links are turned off. Invite people by email instead." }, 410));

const peopleSearchLimit = createLimiter({ limit: 30, windowMs: 60_000 });
const conversationSubmitLimit = createLimiter({ limit: 20, windowMs: 60_000 });
const idempotencyKey = (c: any) => c.req.header("Idempotency-Key") || "";

app.get("/api/people", (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const query = (c.req.query("q") || "").trim();
  if (query.length < 1 || query.length > 80) return c.json({ error: "search query must be 1–80 characters" }, 400);
  if (!peopleSearchLimit.check(account.id)) return c.json({ error: "too many searches" }, 429);
  c.header("Cache-Control", "no-store");
  const escaped = query.replace(/[\\%_]/g, "\\$&");
  // Shared discovery gate includes public admin contacts and the admin human directory.
  const discovery = humanDiscovery(account.nick);
  const people = db.query(`SELECT a.account_id, a.nick, p.full_name, p.avatar_path, p.avatar_version FROM accounts a
    LEFT JOIN profiles p ON p.account = a.nick COLLATE NOCASE
    WHERE a.kind = 'human' AND a.verified_at IS NOT NULL AND a.account_id <> ?
      AND (a.nick LIKE ? ESCAPE '\\' COLLATE NOCASE OR p.full_name LIKE ? ESCAPE '\\' COLLATE NOCASE)
      AND ${discovery.sql}
    ORDER BY CASE WHEN a.nick = ? COLLATE NOCASE THEN 0 ELSE 1 END, a.nick LIMIT 20`)
    .all(account.id, `%${escaped}%`, `%${escaped}%`, ...discovery.params, query) as Array<{ account_id: string; nick: string; full_name: string | null; avatar_path: string | null; avatar_version: number | null }>;
  // help and remind come first when they run here; the client draws their bot mark.
  const wanted = query.replace(/^@/, "").toLowerCase();
  const helpers = contactHelpers().filter((helper) => helper.includes(wanted)).flatMap((helper) => {
    const row = db.query("SELECT account_id, nick FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'bot'").get(helper) as { account_id: string; nick: string } | null;
    return row ? [{ accountId: row.account_id, nick: row.nick, displayName: row.nick, avatarUrl: "", avatarVersion: 0, kind: "bot" }] : [];
  });
  return c.json({ people: [...helpers, ...people.map((person) => ({ accountId: person.account_id, nick: person.nick,
    displayName: person.full_name || person.nick,
    avatarUrl: versionedAvatarUrl(person.nick, avatarVersion(person)), avatarVersion: avatarVersion(person) }))] });
});

app.get("/api/invites/email", (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  c.header("Cache-Control", "no-store");
  return c.json(emailInviteAllowance(account.id));
});

// Backward-compatible email invitation for existing channel controls.
app.post("/api/invites/email", async (c) => {
  const sender = verifiedHuman(c);
  if (!sender) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const { channel: rawChannel, email: rawEmail } = await c.req.json().catch(() => ({}));
  if (typeof rawChannel !== "string" || typeof rawEmail !== "string" || !validEmail(rawEmail)) return c.json({ error: "valid channel and email required" }, 400);
  const channel = normalized(`#${rawChannel.replace(/^#+/, "")}`);
  const info = channelInfo(channel);
  if (!info || info.archived || /^#(dm-|t-)/.test(channel) || !isMember(sender.nick, channel)) return c.json({ error: "channel membership required" }, 403);
  const email = normalizeEmail(rawEmail);
  const key = idempotencyKey(c) || `legacy_${hash(`${sender.id}:${channel}:${email}:${Math.floor(Date.now() / 60_000)}`).slice(0, 32)}`;
  const operation = beginConversationOperation(sender.id, key, hash(JSON.stringify({ channel, email })));
  if (operation.status === "conflict") return c.json({ error: "idempotency key reused with different payload" }, 409);
  if (operation.status === "replay") return c.json(operation.response, operation.httpStatus as ContentfulStatusCode);
  if (operation.status === "busy") return c.json({ error: "request outcome is still being recovered; retry with the same key" }, 409);
  const match = accountByEmail(email);
  if (match?.kind === "human" && match.verifiedAt) {
    try {
      await addVerifiedRecipient(sender, match, { type: info.isGroup ? "group" : "channel", channel });
      const response = { sent: false, added: true, ...emailInviteAllowance(sender.id) };
      completeConversationOperation(sender.id, key, response, 200);
      return c.json(response);
    } catch (error) {
      const response = { error: error instanceof Error ? error.message : "could not add recipient" };
      completeConversationOperation(sender.id, key, response, 500);
      return c.json(response, 500);
    }
  }
  const destination = { type: info.isGroup ? "group" as const : "channel" as const, channel };
  const existing = pendingEmailInvite(sender.id, email, destination);
  if (!existing && !reserveEmailInvites(sender.id, 1)) {
    const response = { error: `You have used all ${emailInviteLimit()} email invites.`, ...emailInviteAllowance(sender.id) };
    completeConversationOperation(sender.id, key, response, 403);
    return c.json(response, 403);
  }
  const result = existing ? pendingInviteOutcome(existing) : await sendNewInvitation(sender, email, destination, c.req.header("Host"));
  const response = { sent: result.status === "invited", ...result, ...emailInviteAllowance(sender.id) };
  const status = result.status === "failed" ? 500 : 200;
  completeConversationOperation(sender.id, key, response, status);
  return c.json(response, status);
});

app.get("/api/invitations", (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  c.header("Cache-Control", "no-store");
  return c.json({ ...emailInviteAllowance(account.id), invitations: listEmailInvites(account.id).map((row) => ({
    id: row.id, recipientEmail: row.recipientEmail,
    destination: { type: row.destinationType, channel: row.channel }, status: row.status,
    createdAt: row.createdAt, expiresAt: row.expiresAt, sends: row.sends,
  })) });
});

async function addVerifiedRecipient(sender: NonNullable<ReturnType<typeof accountByNick>>, target: NonNullable<ReturnType<typeof accountByNick>>, destination: { type: "dm" | "channel" | "group"; channel: string | null }) {
  if (destination.type === "dm") return openDirectConversation(sender.nick, target.nick);
  const info = destination.channel && channelInfo(destination.channel);
  if (!info || info.archived || (destination.type === "group" && !info.isGroup) || !isMember(sender.nick, info.channel)) throw new Error("inviter no longer has access to destination");
  if (isMember(target.nick, info.channel)) return { channel: info.channel };
  if (info.visibility !== "workspace") await grantChannelAccess(info.channel, target.nick);
  db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(info.channel, target.nick);
  channelsChanged(info.channel, [target.nick], true);
  return { channel: info.channel };
}

function pendingInviteOutcome(row: NonNullable<ReturnType<typeof pendingEmailInvite>>) {
  return { id: row.id, invitationId: row.id, expiresAt: row.expiresAt,
    status: row.deliveryState === "sent" ? "invited" : "uncertain", reused: true };
}

// settle: false for callers that reserved no allowance (bulk invites), so nothing is released or counted.
async function sendNewInvitation(sender: NonNullable<ReturnType<typeof accountByNick>>, email: string,
  destination: { type: "dm"; channel: null } | { type: "channel" | "group"; channel: string }, host?: string, settle = true) {
  const existing = pendingEmailInvite(sender.id, email, destination);
  if (existing) {
    if (settle) settleEmailInvite(sender.id, "failed"); // Release this request's unused reservation.
    return pendingInviteOutcome(existing);
  }
  const row = createEmailInvite({ inviter: sender.nick, inviterAccountId: sender.id, email, destination });
  const outcome = await sendEmailInvite({ to: email, inviter: inviterName(sender.nick), inviterEmail: sender.email, destination, token: row.token, id: row.id, host });
  if (settle) settleEmailInvite(sender.id, outcome);
  recordEmailInviteDelivery(row.token, outcome);
  return { id: row.id, status: outcome === "sent" ? "invited" : outcome, invitationId: row.id, expiresAt: row.expiresAt };
}

app.post("/api/conversations", async (c) => {
  const sender = verifiedHuman(c);
  if (!sender) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!conversationSubmitLimit.check(sender.id)) return c.json({ error: "too many conversation requests" }, 429);
  const body = await c.req.json().catch(() => null);
  const key = idempotencyKey(c);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return c.json({ error: "Idempotency-Key header required" }, 400);
  if (!body || !Array.isArray(body.recipients) || body.recipients.length < 1 || body.recipients.length > 20) return c.json({ error: "one to twenty recipients required" }, 400);
  const dest = body.destination;
  if (dest !== undefined && (!dest || !["new", "channel"].includes(dest.type) || (dest.type === "channel" && typeof dest.channel !== "string"))) return c.json({ error: "invalid destination" }, 400);
  let channel: string | null = null;
  let destinationType: "new" | "channel" = dest?.type || "new";
  if (destinationType === "channel") {
    channel = normalized(`#${dest.channel.replace(/^#+/, "")}`);
    const info = channelInfo(channel);
    if (!info || info.archived || /^#(dm-|t-)/.test(channel) || !isMember(sender.nick, channel)) return c.json({ error: "channel membership required" }, 403);
  }
  const resolved: Array<{ account: NonNullable<ReturnType<typeof accountByNick>> | null; email: string | null }> = [];
  for (const item of body.recipients) {
    if (item && typeof item.accountId === "string" && Object.keys(item).length === 1) {
      // A guessed ID that is not discoverable gets the same generic 404 as an unknown one, before
      // any idempotency reservation, invite quota, grant or DM write.
      const person = discoverableHuman(sender.nick, item.accountId);
      if (!person) return c.json({ error: "verified person not found" }, 404);
      resolved.push({ account: accountByNick(person.nick), email: null });
    } else if (item && typeof item.email === "string" && Object.keys(item).length === 1 && validEmail(item.email)) {
      const email = normalizeEmail(item.email);
      const match = accountByEmail(email);
      const verified = match?.kind === "human" && match.verifiedAt ? match : null;
      resolved.push({ account: verified, email: verified ? null : email });
    } else return c.json({ error: "recipient must contain accountId or valid email" }, 400);
  }
  const unique = new Map<string, typeof resolved[number]>();
  for (const person of resolved) {
    if (person.account?.id === sender.id) return c.json({ error: "cannot select yourself" }, 400);
    unique.set(person.account ? `a:${person.account.id}` : `e:${person.email}`, person);
  }
  const recipients = [...unique.values()];
  if (!recipients.length) return c.json({ error: "at least one other person required" }, 400);
  const canonicalBody = JSON.stringify({ recipients: body.recipients, destination: dest || null });
  const operation = beginConversationOperation(sender.id, key, hash(canonicalBody));
  if (operation.status === "conflict") return c.json({ error: "idempotency key reused with different payload" }, 409);
  if (operation.status === "replay") return c.json(operation.response, operation.httpStatus as ContentfulStatusCode);
  if (operation.status === "busy") return c.json({ error: "request outcome is still being recovered; retry with the same key" }, 409);

  const unknown = recipients.filter((person) => !person.account);
  const reusableDestination = destinationType === "channel"
    ? { type: channelInfo(channel!)?.isGroup ? "group" as const : "channel" as const, channel: channel! }
    : recipients.length === 1 ? { type: "dm" as const, channel: null } : null;
  const existingInvites = new Map(unknown.flatMap((person) => {
    const existing = reusableDestination && pendingEmailInvite(sender.id, person.email!, reusableDestination);
    return existing ? [[person.email!, existing] as const] : [];
  }));
  const newInviteCount = unknown.length - existingInvites.size;
  if (!reserveEmailInvites(sender.id, newInviteCount)) {
    const response = { error: `You have used all ${emailInviteLimit()} email invites.`, ...emailInviteAllowance(sender.id) };
    completeConversationOperation(sender.id, key, response, 403);
    return c.json(response, 403);
  }
  const outcomes: Array<Record<string, unknown>> = [];
  let conversation: Record<string, unknown> | null = null;
  let createdGroup: string | null = null;
  let reserved = newInviteCount;
  try {
    if (destinationType === "channel") {
      const info = channelInfo(channel!)!;
      conversation = { type: info.isGroup ? "group" : "channel", channel };
    } else if (recipients.length === 1 && recipients[0].account) {
      const direct = await openDirectConversation(sender.nick, recipients[0].account.nick);
      conversation = { type: "direct", channel: direct.channel, nick: direct.nick };
    } else if (recipients.length > 1) {
      const group = `#g-${randomBytes(12).toString("hex")}`;
      await createChannel(group, sender.nick, "secret");
      createdGroup = group;
      for (const member of [sender, ...recipients.flatMap((person) => person.account ? [person.account] : [])]) await grantChannelAccess(group, member.nick);
      const topic = recipients.map((person) => person.account?.nick || "Invited person").join(", ").slice(0, 200);
      db.transaction(() => {
        db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at, is_group) VALUES (?, ?, 'secret', ?, ?, 1)").run(group, sender.nick, topic, Date.now());
        for (const member of [sender, ...recipients.flatMap((person) => person.account ? [person.account] : [])])
          db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(group, member.nick);
      })();
      createdGroup = null;
      channelsChanged(group, [sender.nick, ...recipients.flatMap((person) => person.account ? [person.account.nick] : [])], true);
      conversation = { type: "group", channel: group };
    }
      for (const person of recipients) {
      if (person.account) {
        const targetChannel = channel || (typeof conversation?.channel === "string" ? conversation.channel : null);
        const wasMember = !!targetChannel && isMember(person.account.nick, targetChannel);
        if (destinationType === "channel") await addVerifiedRecipient(sender, person.account, { type: channelInfo(channel!)?.isGroup ? "group" : "channel", channel });
        outcomes.push({ accountId: person.account.id, nick: person.account.nick, status: destinationType === "channel" && wasMember ? "existing" : "added" });
      } else {
        const createdGroupChannel = conversation?.type === "group" && typeof conversation.channel === "string" ? conversation.channel : null;
        const inviteDestination = destinationType === "channel"
          ? { type: channelInfo(channel!)?.isGroup ? "group" as const : "channel" as const, channel: channel! }
          : createdGroupChannel
            ? { type: "group" as const, channel: createdGroupChannel }
            : { type: "dm" as const, channel: null };
        if (inviteDestination.type !== "dm") {
          const current = channelInfo(inviteDestination.channel);
          if (!current || current.archived || !isMember(sender.nick, inviteDestination.channel)) throw new Error("inviter no longer has access to destination");
        }
        const existing = existingInvites.get(person.email!);
        const outcome = existing ? pendingInviteOutcome(existing) : await sendNewInvitation(sender, person.email!, inviteDestination, c.req.header("Host"));
        if (!existing) reserved--;
        outcomes.push({ email: person.email, ...outcome });
      }
    }
    const response = { conversation, pending: !conversation, recipients: outcomes, ...emailInviteAllowance(sender.id) };
    const status = outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "uncertain") ? 207 : 200;
    completeConversationOperation(sender.id, key, response, status);
    return c.json(response, status);
  } catch (error) {
    if (createdGroup) {
      try { await unregisterChannel(createdGroup); }
      catch (cleanupError) { console.error(`new group cleanup failed for ${createdGroup}:`, cleanupError instanceof Error ? cleanupError.message : cleanupError); }
    }
    if (reserved) db.query("UPDATE email_invite_quota SET reserved = MAX(0, reserved - ?) WHERE account_id = ?").run(reserved, sender.id);
    const reason = error instanceof Error ? error.message : "conversation creation failed";
    const completed = new Set(outcomes.map((outcome) => `${outcome.accountId ? `a:${outcome.accountId}` : `e:${outcome.email}`}`));
    for (const person of recipients) {
      const identity = person.account ? `a:${person.account.id}` : `e:${person.email}`;
      if (!completed.has(identity)) outcomes.push({ ...(person.account ? { accountId: person.account.id, nick: person.account.nick } : { email: person.email }), status: "failed", error: reason });
    }
    const response = { error: reason, conversation, recipients: outcomes,
      ...emailInviteAllowance(sender.id) };
    completeConversationOperation(sender.id, key, response, 500);
    return c.json(response, 500);
  }
});

// Bulk email invitations, for admins only. The client sends the whole list once with preview: true
// to show what each row will do, then sends it again in batches of 25 with an Idempotency-Key each.
// New addresses go out one at a time, spaced for Resend's request limit, and stop at the bulk share
// of today's mail limit: the rest come back "held" and nothing is created for them.
const bulkPreviewLimit = createLimiter({ limit: 30, windowMs: 10 * 60_000 });
const bulkSendLimit = createLimiter({ limit: 80 });
const bulkGapMs = () => Math.max(0, Number(process.env.BULK_INVITE_GAP_MS ?? 500) || 0);
// One bulk batch at a time in this process, so two runs can't each spend the same mail room.
let bulkSends = Promise.resolve();
function oneBulkSendAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = bulkSends.then(work);
  bulkSends = run.then(() => {}, () => {});
  return run;
}

app.post("/api/invites/bulk", async (c) => {
  c.header("Cache-Control", "no-store");
  const sender = verifiedHuman(c);
  if (!sender) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!invitationCsrf(c)) return c.json({ error: "invalid request" }, 403);
  if (sender.role !== "admin") return c.json({ error: "Only admins can invite many people at once." }, 403);
  const body = await c.req.json().catch(() => null);
  const preview = body?.preview === true;
  const max = preview ? BULK_PREVIEW_MAX : BULK_SEND_MAX;
  if (!body || !Array.isArray(body.emails) || body.emails.length < 1 || body.emails.length > max) return c.json({ error: `Send one to ${max} addresses at a time.` }, 400);
  if (!(preview ? bulkPreviewLimit : bulkSendLimit).check(sender.id)) return c.json({ error: "Too many invite requests. Try again in a few minutes." }, 429);
  const workspace = body.destination?.workspace === true;
  const rawChannel = workspace ? defaultChannel() : typeof body.destination?.channel === "string" ? body.destination.channel : "";
  if (!rawChannel) return c.json({ error: workspace ? "This workspace has no default channel." : "Pick a channel." }, 400);
  const channel = normalized(`#${rawChannel.replace(/^#+/, "")}`);
  const info = channelInfo(channel);
  if (!info || info.archived || info.isGroup || /^#(dm-|t-)/.test(channel) || !isMember(sender.nick, channel)) return c.json({ error: "Pick a channel you belong to." }, 403);
  const destination = { type: "channel" as const, channel: info.channel };
  if (preview) return c.json({ channel: info.channel, rows: planBulkInvite(sender, destination, body.emails).map(bulkRowView), mailRoom: bulkMailRoom() });

  const key = idempotencyKey(c);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return c.json({ error: "Idempotency-Key header required" }, 400);
  const operation = beginConversationOperation(sender.id, key, hash(JSON.stringify({ bulk: info.channel, emails: body.emails })));
  if (operation.status === "conflict") return c.json({ error: "idempotency key reused with different payload" }, 409);
  if (operation.status === "replay") return c.json(operation.response, operation.httpStatus as ContentfulStatusCode);
  if (operation.status === "busy") return c.json({ error: "request outcome is still being recovered; retry with the same key" }, 409);
  const response = await oneBulkSendAtATime(async () => {
    // Sorted and counted again inside the queue: an earlier batch may have invited the same address.
    let room = bulkMailRoom();
    let sentAny = false;
    const results: Array<Record<string, unknown>> = [];
    for (const row of planBulkInvite(sender, destination, body.emails)) {
      const view = bulkRowView(row);
      if (row.status === "add" && row.account) {
        try {
          await addVerifiedRecipient(sender, row.account, destination);
          results.push({ ...view, status: "added" });
        } catch (error) {
          results.push({ ...view, status: "failed", error: error instanceof Error ? error.message : "could not add" });
        }
      } else if (row.status === "new") {
        if (room <= 0) { results.push({ ...view, status: "held" }); continue; }
        if (!isMember(sender.nick, info.channel)) { results.push({ ...view, status: "failed", error: "inviter no longer has access to destination" }); continue; }
        if (sentAny && bulkGapMs()) await Bun.sleep(bulkGapMs());
        const outcome = await sendNewInvitation(sender, row.email, destination, c.req.header("Host"), false);
        if ("reused" in outcome) { results.push({ ...view, status: "pending" }); continue; }
        sentAny = true;
        // "uncertain" may have gone out, so only a confirmed failure gives the room back.
        if (outcome.status !== "failed") room -= 1;
        results.push({ ...view, status: outcome.status });
      } else results.push(view);
    }
    return { channel: info.channel, rows: results, mailRoom: bulkMailRoom() };
  });
  completeConversationOperation(sender.id, key, response, 200);
  return c.json(response);
});

app.post("/api/invitations/:id/resend", async (c) => {
  const sender = verifiedHuman(c);
  if (!sender) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!conversationSubmitLimit.check(sender.id)) return c.json({ error: "too many invitation requests" }, 429);
  const key = idempotencyKey(c);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return c.json({ error: "Idempotency-Key header required" }, 400);
  const invite = inviteById(c.req.param("id"), sender.id);
  if (!invite) return c.json({ error: "invitation not found" }, 404);
  // A join link's invitation lives and dies with its link; the visitor asks the link again.
  if (joinLinkIdForInviteId(invite.id)) return c.json({ error: "This invitation came from a join link and can't be resent." }, 409);
  const bodyHash = hash(JSON.stringify({ action: "resend", id: invite.id }));
  const operation = beginConversationOperation(sender.id, key, bodyHash);
  if (operation.status === "conflict") return c.json({ error: "idempotency key reused with different payload" }, 409);
  if (operation.status === "replay") return c.json(operation.response, operation.httpStatus as ContentfulStatusCode);
  if (operation.status === "busy") return c.json({ error: "request outcome is still being recovered; retry with the same key" }, 409);
  const inviteStatusNow = listEmailInvites(sender.id).find((row) => row.id === invite.id)?.status;
  if (inviteStatusNow === "cancelled") {
    const response = { error: "invitation is cancelled" };
    completeConversationOperation(sender.id, key, response, 409);
    return c.json(response, 409);
  }
  if (invite.destination !== "dm") {
    const info = invite.channel && channelInfo(invite.channel);
    if (!info || info.archived || (invite.destination === "group" && !info.isGroup) || !isMember(sender.nick, info.channel)) {
      const response = { error: "inviter no longer has access to destination" };
      completeConversationOperation(sender.id, key, response, 403);
      return c.json(response, 403);
    }
  }
  const match = accountByEmail(invite.email);
  if (match?.kind === "human" && match.verifiedAt) {
    try {
      if (!acceptEmailInviteById(invite.id, match.nick, match.id, match.email)) throw new Error("invitation is no longer available to this account");
      await addVerifiedRecipient(sender, match, { type: invite.destination, channel: invite.channel });
      const response = { status: "added", accountId: match.id, nick: match.nick, ...emailInviteAllowance(sender.id) };
      completeConversationOperation(sender.id, key, response, 200);
      return c.json(response);
    } catch (error) {
      const response = { error: error instanceof Error ? error.message : "could not add recipient" };
      completeConversationOperation(sender.id, key, response, 500);
      return c.json(response, 500);
    }
  }
  if (inviteStatusNow === "sending" || inviteStatusNow === "uncertain") {
    const response = { error: `invitation delivery is ${inviteStatusNow}; refusing blind resend`, status: inviteStatusNow };
    completeConversationOperation(sender.id, key, response, 409);
    return c.json(response, 409);
  }
  if (!reserveEmailInvites(sender.id, 1)) {
    const response = { error: `You have used all ${emailInviteLimit()} email invites.`, ...emailInviteAllowance(sender.id) };
    completeConversationOperation(sender.id, key, response, 403);
    return c.json(response, 403);
  }
  const claim = claimEmailInviteResend(invite.id, sender.id, randomBytes(16).toString("hex"));
  if (!claim) {
    settleEmailInvite(sender.id, "failed");
    const response = { error: "invitation is already sending or unavailable" };
    completeConversationOperation(sender.id, key, response, 409);
    return c.json(response, 409);
  }
  const outcome = await sendEmailInvite({ to: invite.email, inviter: inviterName(sender.nick), inviterEmail: sender.email,
    destination: { type: invite.destination, channel: invite.channel }, token: claim.token, id: invite.id, host: c.req.header("Host") });
  settleEmailInvite(sender.id, outcome);
  const settled = finishEmailInviteResend(claim, sender.id, outcome);
  const status = outcome === "failed" ? 500 : 200;
  const response = { id: invite.id, status: settled ? outcome : "uncertain", expiresAt: outcome === "failed" ? claim.previousExpiresAt : claim.expiresAt,
    ...emailInviteAllowance(sender.id) };
  completeConversationOperation(sender.id, key, response, status);
  return c.json(response, status);
});

app.delete("/api/invitations/:id", (c) => {
  const sender = verifiedHuman(c);
  if (!sender) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const invite = inviteById(c.req.param("id"), sender.id);
  if (!invite) return c.json({ error: "invitation not found" }, 404);
  const status = listEmailInvites(sender.id).find((row) => row.id === invite.id)?.status;
  if (status === "accepted") return c.json({ error: "invitation already accepted" }, 409);
  if (status !== "cancelled") cancelEmailInvite(invite.id, sender.id);
  return c.body(null, 204);
});

// --- Open join links ------------------------------------------------------------------------------
// An admin makes a link for one channel and posts it where they like. A visitor gives an email
// address and gets one mail: an ordinary invitation for a new address, or a sign-in link for an
// address that already has an account. The answer is the same either way.
const joinLinkPeerLimit = createLimiter({ limit: 20 });
const joinLinkAddressLimit = createLimiter({ limit: 3 });
const joinLinkPerLinkLimit = createLimiter({ limit: 60 });
const joinLinkCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Join");

// The link still works only while its maker is a verified admin who belongs to its channel.
function joinLinkOwner(link: NonNullable<ReturnType<typeof joinLinkById>>) {
  const owner = accountByNick(link.createdBy);
  const info = channelInfo(link.channel);
  if (!owner || owner.id !== link.createdByAccount || owner.kind !== "human" || !owner.verifiedAt || owner.role !== "admin") return null;
  if (!info || info.archived || info.isGroup || /^#(dm-|t-)/.test(info.channel) || !isMember(owner.nick, info.channel)) return null;
  return { owner, info };
}

// The page a link opens. GET changes nothing, so a chat preview fetching it costs no place and no mail.
// A signed-in member of the link's channel goes straight to the channel, whatever the link's state.
app.get("/j/:token", async (c) => {
  const link = joinLinkByToken(c.req.param("token"));
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const nick = link ? currentUser(c) : undefined;
  if (link && nick && isMember(nick, link.channel)) return c.redirect(`/#${link.channel.replace(/^#/, "")}`, 302);
  const state = link && joinLinkOwner(link) ? joinLinkState(link) : "closed";
  let html = await Bun.file("./public/join-link.html").text();
  html = html.replace(/<section data-state="(open|full|spent|closed)"[\s\S]*?<\/section>/g, (block, which: string) => which === state ? block : "");
  html = html.replace(/\{\{host\}\}/g, escapeHtml(instanceHost()));
  return c.html(await versionShell(html));
});

app.post("/api/join-links/:token/request", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!joinLinkCsrf(c)) return c.json({ error: "invalid request" }, 403);
  const link = joinLinkByToken(c.req.param("token"));
  const valid = link ? joinLinkOwner(link) : null;
  const state = link && valid ? joinLinkState(link) : "closed";
  if (!link || !valid || state === "closed") return c.json({ error: "This join link is closed." }, 410);
  if (state === "full") return c.json({ error: "This join link is full." }, 409);
  if (state === "spent") return c.json({ error: "This link has sent all the email it can. Ask whoever shared it for a new one." }, 409);
  const { email: rawEmail } = await c.req.json().catch(() => ({}));
  if (typeof rawEmail !== "string" || !validEmail(rawEmail)) return c.json({ error: "Enter a valid email address." }, 400);
  const email = normalizeEmail(rawEmail);
  // Without trusted proxies every visitor shares the proxy's address, so a per-IP bucket would let
  // one person lock the link for everyone. Then only the per-address and per-link limits apply.
  const perIp = trustedProxies().size > 0 ? joinLinkPeerLimit.check(peerKey(c)) : true;
  if (!perIp || !joinLinkAddressLimit.check(email) || !joinLinkPerLinkLimit.check(link.id)) return c.json({ error: "Too many requests. Try again later." }, 429);
  const sent = (devLink?: string) => c.json(devLinks && devLink ? { sent: true, devLink } : { sent: true }, 202);
  // One mail per person: a pending invitation from this link already reached this address.
  if (pendingLinkInvite(link.id, email)) return sent();
  const existing = accountByEmail(email);
  if ((existing && existing.kind !== "human") || isRemovedEmail(email)) return sent();
  if (!devLinks && (!resend || !process.env.RESEND_FROM)) return c.json({ error: "Email delivery is unavailable." }, 503);
  if (!reserveSend(link.id)) return c.json({ error: "This link has sent all the email it can. Ask whoever shared it for a new one." }, 409);
  const destination = { type: valid.info.isGroup ? "group" as const : "channel" as const, channel: valid.info.channel };
  const invite = createEmailInvite({ inviter: valid.owner.nick, inviterAccountId: valid.owner.id, email, destination });
  markInviteFromLink(invite.id, link.id);
  // An existing account signs in instead of making a second one, and takes no place.
  if (existing?.verifiedAt) {
    const result = await sendInvitationVerification(existing, invite.token, c.req.header("Host"));
    // "limited": a sign-in mail went out a moment ago. Keep it pending so it is not sent again.
    recordEmailInviteDelivery(invite.token, result.status === "sent" ? "sent" : result.status === "limited" ? "uncertain" : "failed");
    if (result.status === "failed") { refundSend(link.id); return c.json({ error: "Could not send the email. Try again." }, 500); }
    return sent("devLink" in result ? result.devLink : undefined);
  }
  const outcome = await sendEmailInvite({ to: email, inviter: inviterName(valid.owner.nick), inviterEmail: valid.owner.email, destination, token: invite.token, id: invite.id, host: c.req.header("Host") });
  recordEmailInviteDelivery(invite.token, outcome);
  if (outcome === "failed") { refundSend(link.id); return c.json({ error: "Could not send the email. Try again." }, 500); }
  return sent(`${appOrigin(c.req.header("Host"))}/join/${invite.token}`);
});

function joinLinkView(link: NonNullable<ReturnType<typeof joinLinkById>>) {
  return { id: link.id, channel: link.channel, joins: link.joins, maxJoins: link.maxJoins, expiresAt: link.expiresAt, revoked: !!link.revokedAt, state: joinLinkState(link) };
}

app.get("/api/join-links", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (account.role !== "admin") return c.json({ links: [] });
  // Only the admin who made a link reads its URL back, and only here. Older links have none.
  const origin = appOrigin(c.req.header("Host"));
  return c.json({ links: listJoinLinks(account.id).map((link) => {
    const token = joinLinkToken(link.id, account.id);
    return { ...joinLinkView(link), url: token ? `${origin}/j/${token}` : null };
  }) });
});

app.post("/api/join-links", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!joinLinkCsrf(c)) return c.json({ error: "invalid request" }, 403);
  if (account.role !== "admin") return c.json({ error: "Only admins can make join links." }, 403);
  const { channel: rawChannel, maxJoins, days } = await c.req.json().catch(() => ({}));
  if (typeof rawChannel !== "string") return c.json({ error: "Pick a channel." }, 400);
  const channel = normalized(`#${rawChannel.replace(/^#+/, "")}`);
  const info = channelInfo(channel);
  if (!info || info.archived || info.isGroup || /^#(dm-|t-)/.test(channel) || !isMember(account.nick, channel)) return c.json({ error: "Pick a channel you belong to." }, 403);
  if (openJoinLinks(account.id) >= OPEN_LINKS_PER_ADMIN) return c.json({ error: `You have ${OPEN_LINKS_PER_ADMIN} open join links. Revoke one first.` }, 409);
  const { link, token } = createJoinLink({ owner: account.nick, ownerAccountId: account.id, channel: info.channel,
    maxJoins: typeof maxJoins === "number" ? maxJoins : undefined, days: typeof days === "number" ? days : undefined });
  return c.json({ ...joinLinkView(link), url: `${appOrigin(c.req.header("Host"))}/j/${token}` }, 201);
});

app.delete("/api/join-links/:id", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!joinLinkCsrf(c)) return c.json({ error: "invalid request" }, 403);
  if (!revokeJoinLink(c.req.param("id"), account.id)) return c.json({ error: "join link not found" }, 404);
  return c.body(null, 204);
});

app.get("/api/join/:token", (c) => {
  const token = c.req.param("token");
  const emailInvite = emailInviteByToken(token, Date.now(), true);
  if (emailInvite) return c.json({ destination: { type: emailInvite.destination, channel: emailInvite.channel }, requiresVerifiedEmail: true });
  // A non-email token can only be a legacy reusable channel link, which no longer grants access.
  return c.json({ error: "This invite link is no longer available. Ask for a personal email invitation." }, 410);
});

app.post("/api/join/:token/guest", (c) => {
  const token = c.req.param("token");
  if (!emailInviteByToken(token)) return c.json({ error: "This invite link is no longer available. Ask for a personal email invitation." }, 410);
  return enterAsGuest(c, `/join/${token}`);
});

app.post("/api/join/:token", async (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const recipient = accountByNick(nick);
  if (recipient?.kind !== "human" || !recipient.verifiedAt) return c.json({ error: "verified sign-in required" }, 403);
  const token = c.req.param("token");
  const emailInvite = emailInviteByToken(token, Date.now(), true);
  if (emailInvite) {
    const recipient = accountByNick(nick);
    if (!recipient?.verifiedAt || recipient.kind !== "human" || normalizeEmail(recipient.email) !== emailInvite.email ||
        (emailInvite.recipientAccountId && recipient.id !== emailInvite.recipientAccountId)) return c.json({ error: "sign in with the verified invited email" }, 403);
    const inviterIdentity = emailInvite.inviterAccountId && db.query("SELECT nick FROM accounts WHERE account_id = ?").get(emailInvite.inviterAccountId) as { nick: string } | null;
    const inviter = inviterIdentity && accountByNick(inviterIdentity.nick);
    if (!inviter || inviter.kind !== "human" || !inviter.verifiedAt || inviter.id !== emailInvite.inviterAccountId) return c.json({ error: "inviter is unavailable" }, 409);
    if (emailInvite.destination !== "dm") {
      const info = emailInvite.channel && channelInfo(emailInvite.channel);
      if (!info || info.archived || (emailInvite.destination === "group" && !info.isGroup) || !isMember(inviter.nick, info.channel)) return c.json({ error: "inviter no longer has access to destination" }, 409);
    }
    const linkId = joinLinkIdForInvite(token);
    if (linkId && joinLinkState(joinLinkById(linkId)) === "closed") return c.json({ error: "This join link is closed." }, 410);
    // Claim before any asynchronous grant so cancellation cannot race a membership/DM grant.
    if (!acceptEmailInvite(token, nick, recipient.id, recipient.email)) return c.json({ error: "invitation expired or unavailable" }, 409);
    try {
      let destination: Record<string, unknown>;
      if (emailInvite.destination === "dm") {
        const direct = await openDirectConversation(inviter.nick, recipient.nick);
        destination = { type: "direct", channel: direct.channel, nick: inviter.nick };
      } else {
        const info = emailInvite.channel && channelInfo(emailInvite.channel);
        if (!info || info.archived || (emailInvite.destination === "group" && !info.isGroup) || !isMember(inviter.nick, info.channel)) return c.json({ error: "inviter no longer has access to destination" }, 409);
        if (!isMember(recipient.nick, info.channel)) {
          if (info.visibility !== "workspace") await grantChannelAccess(info.channel, recipient.nick);
          db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(info.channel, recipient.nick);
          channelsChanged(info.channel, [recipient.nick], true);
        }
        destination = { type: emailInvite.destination, channel: info.channel };
      }
      return c.json({ ...destination, accepted: true });
    } catch (error) {
      return appError(c, error, "could not accept invitation");
    }
  }
  // Reusable copied room links are disabled, so only bounded email invitations can be accepted.
  return c.json({ error: "This invite link is no longer available. Ask for a personal email invitation." }, 410);
});

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
