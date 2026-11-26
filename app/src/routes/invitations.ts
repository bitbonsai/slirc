import { createLimiter } from "../request-security.ts";
import { invitationCsrf, hash, completeFirstVerification, startSession, devLinks, appOrigin, verifiedHuman, admissionCsrf, currentUser, session, userAgentDetails, sessionCookie, acctCookie } from "../http/session.ts";
import { emailInviteByToken, normalizeEmail, emailInviteAllowance, beginConversationOperation, completeConversationOperation, pendingEmailInvite, reserveEmailInvites, emailInviteLimit, listEmailInvites, settleEmailInvite, createEmailInvite, recordEmailInviteDelivery, inviteById, acceptEmailInviteById, claimEmailInviteResend, finishEmailInviteResend, cancelEmailInvite } from "../email-invites.ts";
import { db } from "../db.ts";
import { accountByNick, accountByEmail, provisionAccount, reserveAdmissionIdentity, provisionAdmissionIdentity, AdmissionAttemptStaleError, validEmail } from "../accounts.ts";
import { channelInfo, isMember, reopenDirectConversation, humanDiscovery, normalized, discoverableHuman, defaultChannel } from "../rooms.ts";
import { joinLinkIdForInvite, joinLinkById, joinLinkState, reserveJoin, releaseJoin, joinLinkIdForInviteId } from "../join-links.ts";
import { sendOnboarding } from "../http/onboarding.ts";
import { mailLimit, resend, sendInvitationVerification, sendEmailInvite, inviterName } from "../http/mail.ts";
import { bodyLimit } from "hono/body-limit";
import { founderAccount, isFounder, enqueueWelcomeJob } from "../founder-welcome.ts";
import { profileJson, avatarVersion, versionedAvatarUrl } from "../http/profiles.ts";
import { admissionEmail } from "../admissions-email.ts";
import { text } from "../http/common.ts";
import { recordAdmissionDelivery, waitlistConfigured, waitlistApplications, admissionList, approveApplication, cancelAdmission, reissueAdmission, admissionForToken, beginRedemption, finalizeRedemption, redeemedAdmission } from "../admissions.ts";
import { randomBytes } from "node:crypto";
import { setCookie } from "hono/cookie";
import { openDirectConversation } from "../direct.ts";
import { contactHelpers } from "../config.ts";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import { grantChannelAccess, createChannel, unregisterChannel } from "../grants.ts";
import { channelsChanged } from "../live.ts";
import { join } from "node:path";
import { BULK_PREVIEW_MAX, BULK_SEND_MAX, planBulkInvite, bulkRowView } from "../bulk-invites.ts";
import { bulkMailRoom } from "../mail-count.ts";
import { Hono } from "hono";

export const invitations = new Hono();

function admissionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name) ? name : null;
}

// An invitation token is personal and unguessable, so its sign-in is limited per token. A per-IP
// bucket would lock out everyone behind one proxy address (a tenant without SLIRC_TRUSTED_PROXIES).
const invitationTokenLimit = createLimiter({ limit: 10 });

invitations.post("/auth/invitation/request", async (c) => {
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

invitations.use("/api/admission*", bodyLimit({ maxSize: 4_096 }));

invitations.use("/api/admission*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

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

invitations.get("/api/admissions", async (c) => {
  const owner = verifiedHuman(c);
  if (!isFounder(owner)) return c.json({ error: "not found" }, 404);
  // No waitlist config means this instance has no waiting list to review (every hosted or
  // self-hosted private workspace). 404 makes the client drop the section instead of erroring.
  if (!waitlistConfigured()) return c.json({ error: "not found" }, 404);
  c.header("Cache-Control", "no-store");
  try { return c.json({ applications: await waitlistApplications(), admissions: admissionList() }); }
  catch (error) { console.error("waitlist snapshot failed:", error); return c.json({ error: "waitlist snapshot unavailable" }, 500); }
});

invitations.post("/api/admissions/approve", async (c) => {
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

invitations.post("/api/admissions/:id/cancel", (c) => {
  const owner = verifiedHuman(c);
  if (!isFounder(owner)) return c.json({ error: "not found" }, 404);
  if (!admissionCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  return cancelAdmission(c.req.param("id")) ? c.json({ cancelled: true }) : c.json({ error: "admission cannot be cancelled" }, 409);
});

invitations.post("/api/admissions/:id/reissue", async (c) => {
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

invitations.post("/api/admission/redeem", async (c) => {
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

invitations.post("/api/admission/destination", async (c) => {
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

// Reusable membership-granting channel links are disabled: they cannot expire or be revoked.
// Bounded, email-specific invitations remain the way to add people to a channel.
invitations.post("/api/invites", (c) => c.json({ error: "Reusable channel invite links are turned off. Invite people by email instead." }, 410));

const peopleSearchLimit = createLimiter({ limit: 30, windowMs: 60_000 });

const conversationSubmitLimit = createLimiter({ limit: 20, windowMs: 60_000 });

const idempotencyKey = (c: any) => c.req.header("Idempotency-Key") || "";

invitations.get("/api/people", (c) => {
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

invitations.get("/api/invites/email", (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  c.header("Cache-Control", "no-store");
  return c.json(emailInviteAllowance(account.id));
});

// Backward-compatible email invitation for existing channel controls.
invitations.post("/api/invites/email", async (c) => {
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

invitations.get("/api/invitations", (c) => {
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

invitations.post("/api/conversations", async (c) => {
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

invitations.post("/api/invites/bulk", async (c) => {
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

invitations.post("/api/invitations/:id/resend", async (c) => {
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

invitations.delete("/api/invitations/:id", (c) => {
  const sender = verifiedHuman(c);
  if (!sender) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const invite = inviteById(c.req.param("id"), sender.id);
  if (!invite) return c.json({ error: "invitation not found" }, 404);
  const status = listEmailInvites(sender.id).find((row) => row.id === invite.id)?.status;
  if (status === "accepted") return c.json({ error: "invitation already accepted" }, 409);
  if (status !== "cancelled") cancelEmailInvite(invite.id, sender.id);
  return c.body(null, 204);
});
