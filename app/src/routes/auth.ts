import { ergoOperUser, slircMode, enabledHelpers } from "../config.ts";
import { verifiedHuman, session, hash, revokeSession, sameOriginJson, cookieSession, CLIENT_TOKEN_TTL_MS, MAX_CLIENT_TOKENS_PER_SESSION, closeClientTokensForSession, clientBearerToken, devLinks, invitationCsrf, signInCsrf, completeFirstVerification, startSession, devUser, sessionOrBearer, sessionCookie, acctCookie } from "../http/session.ts";
import { db } from "../db.ts";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createLimiter, peerKey } from "../request-security.ts";
import { accountByNick, validEmail, accountByEmail, provisionAccount, markVerified } from "../accounts.ts";
import { randomBytes } from "node:crypto";
import { closeSessionSockets } from "../relay.ts";
import { canonicalMailbox, emailInviteByToken } from "../email-invites.ts";
import { mailLimit, sendMagicLink, codeHash } from "../http/mail.ts";
import { reserveSignup } from "../mail-count.ts";
import { sendOnboarding } from "../http/onboarding.ts";
import { onboardingDestination } from "../onboarding.ts";
import { isValidNext, directConversations, memberChannels, visibleChannels, sharedContacts, openChannels, defaultChannel } from "../rooms.ts";
import { isPublicRoomNext } from "../http/public-rooms.ts";
import { text } from "../http/common.ts";
import { enqueueWelcomeJob, isFounder } from "../founder-welcome.ts";
import { openRoom } from "../welcome.ts";
import { joinLinksHomeOnce, linksHome, linksChannelsFor } from "../links-collect.ts";
import { linksEnabled } from "../links.ts";
import { ircResetNotice } from "../http/irc-devices.ts";
import { channels } from "./channels.ts";
import { irc } from "./irc.ts";
import { ircConnectionMeta } from "../http/irc-connection.ts";
import { accountDetails, profileJson } from "../http/profiles.ts";
import { profile } from "./profile.ts";
import { Hono } from "hono";

export const auth = new Hono();

const serviceNicks = () => ["slirc", ergoOperUser()];

auth.get("/api/sessions", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  const active = session(c);
  if (!account || !active) return c.json({ error: "not signed in" }, 401);
  const currentHash = hash(active.token);
  const rows = db.query("SELECT token_hash, device, created_at FROM sessions WHERE nick = ? COLLATE NOCASE ORDER BY created_at DESC").all(account.nick) as { token_hash: string; device: string; created_at: number }[];
  return c.json(rows.map((row) => ({ id: row.token_hash, device: row.device, createdAt: row.created_at, current: row.token_hash === currentHash })));
});

auth.delete("/api/sessions/:id", (c) => {
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

auth.post("/auth/client-token", (c) => {
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

auth.post("/auth/logout", (c) => {
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

auth.post("/auth/request", async (c) => {
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

auth.post("/auth/code", async (c) => {
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

auth.get("/auth/link-status", (c) => {
  const tokenHash = hash(c.req.query("token") || "");
  const link = db.query("SELECT 1 FROM magic_links WHERE token_hash = ? AND expires_at >= ?").get(tokenHash, Date.now());
  const used = db.query("SELECT 1 FROM used_magic_links WHERE token_hash = ?").get(tokenHash);
  // gone: expired or burned by wrong codes, never signed in. The dev poller stops without claiming a sign-in.
  return c.json({ used: Boolean(used), gone: !used && !link });
});

auth.get("/auth/verify", async (c) => {
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

auth.get("/auth/me", (c) => {
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
