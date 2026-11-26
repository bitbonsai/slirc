import { accountByEmail, accountByNick, validEmail, isRemovedEmail } from "../accounts.ts";
import { sendMagicLink, resend, sendInvitationVerification, sendEmailInvite, inviterName } from "../http/mail.ts";
import { createLimiter, trustedProxies, peerKey } from "../request-security.ts";
import { sameOriginJson, currentUser, devLinks, appOrigin, verifiedHuman } from "../http/session.ts";
import { joinLinkById, joinLinkByToken, joinLinkState, pendingLinkInvite, reserveSend, markInviteFromLink, refundSend, listJoinLinks, joinLinkToken, openJoinLinks, OPEN_LINKS_PER_ADMIN, createJoinLink, revokeJoinLink, joinLinkIdForInvite } from "../join-links.ts";
import { channelInfo, isMember, normalized } from "../rooms.ts";
import { text, appError } from "../http/common.ts";
import { escapeHtml } from "../../shared/escape-html.ts";
import { instanceHost } from "../agent-connect.ts";
import { versionShell } from "../http/assets.ts";
import { normalizeEmail, createEmailInvite, recordEmailInviteDelivery, emailInviteByToken, acceptEmailInvite } from "../email-invites.ts";
import { links } from "./links.ts";
import { db } from "../db.ts";
import { openDirectConversation } from "../direct.ts";
import { grantChannelAccess } from "../grants.ts";
import { channelsChanged } from "../live.ts";
import { Hono } from "hono";

export const joinlinks = new Hono();

// The invite guest route stays anti-enumerating, but can no longer provision or admit accounts.
// Existing members still receive a sign-in link; unknown addresses get the same response.
async function enterAsGuest(c: any, next: string) {
  const { email } = await c.req.json().catch(() => ({}));
  const known = typeof email === "string" ? accountByEmail(email) : null;
  const devLink = known ? await sendMagicLink(known, next, c.req.header("Host")) : undefined;
  return c.json({ pending: true, devLink }, 202);
}

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
joinlinks.get("/j/:token", async (c) => {
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

joinlinks.post("/api/join-links/:token/request", async (c) => {
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

joinlinks.get("/api/join-links", (c) => {
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

joinlinks.post("/api/join-links", async (c) => {
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

joinlinks.delete("/api/join-links/:id", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!joinLinkCsrf(c)) return c.json({ error: "invalid request" }, 403);
  if (!revokeJoinLink(c.req.param("id"), account.id)) return c.json({ error: "join link not found" }, 404);
  return c.body(null, 204);
});

joinlinks.get("/api/join/:token", (c) => {
  const token = c.req.param("token");
  const emailInvite = emailInviteByToken(token, Date.now(), true);
  if (emailInvite) return c.json({ destination: { type: emailInvite.destination, channel: emailInvite.channel }, requiresVerifiedEmail: true });
  // A non-email token can only be a legacy reusable channel link, which no longer grants access.
  return c.json({ error: "This invite link is no longer available. Ask for a personal email invitation." }, 410);
});

joinlinks.post("/api/join/:token/guest", (c) => {
  const token = c.req.param("token");
  if (!emailInviteByToken(token)) return c.json({ error: "This invite link is no longer available. Ask for a personal email invitation." }, 410);
  return enterAsGuest(c, `/join/${token}`);
});

joinlinks.post("/api/join/:token", async (c) => {
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
