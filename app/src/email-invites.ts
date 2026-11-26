import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { hash, normalized } from "./rooms.ts";

export const emailInviteLimit = () => Math.max(0, Math.floor(Number(process.env.EMAIL_INVITE_LIMIT || 9)));
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
// One inbox however it is spelled, for rate limits only (never stored or mailed): +tags dropped,
// and Gmail's dots and googlemail.com folded.
export function canonicalMailbox(email: string): string {
  const [local = "", domain = ""] = normalizeEmail(email).split(/@(?=[^@]*$)/);
  const gmail = domain === "gmail.com" || domain === "googlemail.com";
  const user = local.split("+", 1)[0]!;
  return `${gmail ? user.replaceAll(".", "") : user}@${gmail ? "gmail.com" : domain}`;
}
export const inviteLifetimeMs = 7 * 24 * 60 * 60_000;

export type InviteDestination = { type: "dm"; channel: null } | { type: "channel" | "group"; channel: string };
export type EmailInvite = { id: string; email: string; channel: string | null; destination: "dm" | "channel" | "group"; inviter: string; inviterAccountId: string | null; recipientAccountId: string | null; expiresAt: number; sends: number };

type Quota = { sent: number; reserved: number };

// Admins have no allowance. Mail counting (mail-count.ts) and the request rate limits still apply.
export function unlimitedEmailInvites(accountId: string): boolean {
  return !!db.query("SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND kind = 'human' AND removed_at IS NULL").get(accountId);
}

// What the invite screens show: the allowance left, or unlimited for an admin.
export function emailInviteAllowance(accountId: string): { remaining: number | null; limit: number | null; unlimited: boolean } {
  if (unlimitedEmailInvites(accountId)) return { remaining: null, limit: null, unlimited: true };
  return { remaining: emailInvitesRemaining(accountId), limit: emailInviteLimit(), unlimited: false };
}

export function emailInvitesRemaining(accountId: string): number {
  const row = db.query("SELECT sent, reserved FROM email_invite_quota WHERE account_id = ?").get(accountId) as Quota | null;
  return Math.max(0, emailInviteLimit() - (row?.sent || 0) - (row?.reserved || 0));
}

// Reservation and lifetime accounting survive invitation cancellation/deletion.
export function reserveEmailInvites(accountId: string, amount: number): boolean {
  if (amount <= 0 || unlimitedEmailInvites(accountId)) return true;
  const limit = emailInviteLimit();
  const row = db.query(`INSERT INTO email_invite_quota (account_id, sent, reserved)
    SELECT ?, 0, ? WHERE ? <= ?
    ON CONFLICT(account_id) DO UPDATE SET reserved = reserved + excluded.reserved
    WHERE sent + reserved + excluded.reserved <= ? RETURNING reserved`)
    .get(accountId, amount, amount, limit, limit);
  return !!row;
}
export const reserveEmailInvite = (accountId: string) => reserveEmailInvites(accountId, 1);

export function settleEmailInvite(accountId: string, outcome: "sent" | "failed" | "uncertain"): void {
  db.query(`UPDATE email_invite_quota SET reserved = MAX(0, reserved - 1),
    sent = sent + CASE WHEN ? IN ('sent', 'uncertain') THEN 1 ELSE 0 END WHERE account_id = ?`).run(outcome, accountId);
}

export function createEmailInvite(input: {
  inviter: string; inviterAccountId: string; email: string; destination: InviteDestination; recipientAccountId?: string | null;
}): { token: string; id: string; expiresAt: number } {
  const token = randomBytes(24).toString("base64url");
  const id = randomBytes(16).toString("hex");
  const now = Date.now();
  const channel = input.destination.channel ? normalized(input.destination.channel) : null;
  const email = normalizeEmail(input.email);
  db.query(`INSERT INTO invites (token_hash, channel, created_by, created_at, email, destination_type,
      inviter_account_id, recipient_account_id, expires_at, invitation_id, delivery_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending')`)
    .run(hash(token), channel, input.inviter, now, email, input.destination.type, input.inviterAccountId,
      input.recipientAccountId || null, now + inviteLifetimeMs, id);
  return { token, id, expiresAt: now + inviteLifetimeMs };
}

export function emailInviteByToken(token: string, now = Date.now(), allowAccepted = false): EmailInvite | null {
  const row = db.query(`SELECT invitation_id, email, channel, destination_type, created_by, inviter_account_id,
      recipient_account_id, expires_at, sends, accepted_at, cancelled_at, delivery_state
    FROM invites WHERE token_hash = ? AND email IS NOT NULL`).get(hash(token)) as any;
  if (!row || row.cancelled_at || (!row.accepted_at && (row.expires_at == null || row.expires_at <= now)) || (row.accepted_at && !allowAccepted)) return null;
  return { id: row.invitation_id, email: row.email, channel: row.channel, destination: row.destination_type,
    inviter: row.created_by, inviterAccountId: row.inviter_account_id, recipientAccountId: row.recipient_account_id,
    expiresAt: row.expires_at, sends: row.sends };
}

function acceptInviteRecord(invite: EmailInvite | null, nick: string, accountId: string | undefined, email: string | undefined, where: string, key: string, allowExpired = false): EmailInvite | null {
  if (!invite || !accountId || invite.inviterAccountId === accountId || invite.inviter.toLowerCase() === nick.toLowerCase()) return null;
  const recipient = db.query("SELECT nick, email, kind, verified_at FROM accounts WHERE account_id = ?").get(accountId) as { nick: string; email: string; kind: string; verified_at: number | null } | null;
  if (!recipient || recipient.nick.toLowerCase() !== nick.toLowerCase() || recipient.kind !== "human" || !recipient.verified_at ||
      normalizeEmail(recipient.email) !== normalizeEmail(invite.email) || !email || normalizeEmail(email) !== normalizeEmail(invite.email)) return null;
  if (invite.recipientAccountId && accountId !== invite.recipientAccountId) return null;
  const updated = db.query(`UPDATE invites SET accepted_at = COALESCE(accepted_at, ?), accepted_by = COALESCE(accepted_by, ?), recipient_account_id = COALESCE(recipient_account_id, ?)
    WHERE ${where} = ? AND cancelled_at IS NULL AND (delivery_state <> 'sending' OR accepted_at IS NOT NULL)
      AND (? = 1 OR accepted_at IS NOT NULL OR expires_at > ?)
      AND (recipient_account_id IS NULL OR recipient_account_id = ?)`)
    .run(Date.now(), nick, accountId, key, allowExpired ? 1 : 0, Date.now(), accountId);
  return updated.changes ? invite : null;
}

export function acceptEmailInvite(token: string, nick: string, accountId?: string, email?: string): EmailInvite | null {
  return acceptInviteRecord(emailInviteByToken(token, Date.now(), true), nick, accountId, email, "token_hash", hash(token));
}
export function acceptEmailInviteById(id: string, nick: string, accountId?: string, email?: string): EmailInvite | null {
  const invite = db.query(`SELECT invitation_id, email, channel, destination_type, created_by, inviter_account_id,
    recipient_account_id, expires_at, sends FROM invites WHERE invitation_id = ?`).get(id) as any;
  const record: EmailInvite | null = invite ? { id: invite.invitation_id, email: invite.email, channel: invite.channel,
    destination: invite.destination_type, inviter: invite.created_by, inviterAccountId: invite.inviter_account_id,
    recipientAccountId: invite.recipient_account_id, expiresAt: invite.expires_at, sends: invite.sends } : null;
  return acceptInviteRecord(record, nick, accountId, email, "invitation_id", id, true);
}

export function inviteById(id: string, senderAccountId: string): EmailInvite | null {
  const row = db.query(`SELECT invitation_id, email, channel, destination_type, created_by, inviter_account_id,
      recipient_account_id, expires_at, sends, accepted_at, cancelled_at
    FROM invites WHERE invitation_id = ? AND inviter_account_id = ?`).get(id, senderAccountId) as any;
  if (!row) return null;
  return { id: row.invitation_id, email: row.email, channel: row.channel, destination: row.destination_type,
    inviter: row.created_by, inviterAccountId: row.inviter_account_id, recipientAccountId: row.recipient_account_id,
    expiresAt: row.expires_at || 0, sends: row.sends };
}

export function listEmailInvites(senderAccountId: string) {
  return (db.query(`SELECT invitation_id AS id, email AS recipientEmail, channel, destination_type AS destinationType,
      created_at AS createdAt, expires_at AS expiresAt, sends, accepted_at AS acceptedAt, cancelled_at AS cancelledAt,
      delivery_state AS deliveryState
    FROM invites WHERE inviter_account_id = ? AND email IS NOT NULL ORDER BY created_at DESC`).all(senderAccountId) as Array<any>).map((row) => ({
      ...row, status: row.cancelledAt ? "cancelled" : row.acceptedAt ? "accepted" : row.expiresAt <= Date.now() ? "expired" : row.deliveryState === "sent" ? "pending" : row.deliveryState,
    }));
}

export function pendingEmailInvite(senderAccountId: string, email: string, destination: InviteDestination) {
  return db.query(`SELECT invitation_id AS id, expires_at AS expiresAt, delivery_state AS deliveryState
    FROM invites WHERE inviter_account_id = ? AND email = ? AND destination_type = ? AND channel IS ?
      AND accepted_at IS NULL AND cancelled_at IS NULL AND expires_at > ? AND join_link_id IS NULL
      AND delivery_state IN ('sending', 'sent', 'uncertain') ORDER BY created_at DESC LIMIT 1`)
    .get(senderAccountId, normalizeEmail(email), destination.type, destination.channel ? normalized(destination.channel) : null, Date.now()) as { id: string; expiresAt: number; deliveryState: string } | null;
}

export function cancelEmailInvite(id: string, senderAccountId: string): boolean {
  return !!db.query(`UPDATE invites SET cancelled_at = ? WHERE invitation_id = ? AND inviter_account_id = ?
    AND accepted_at IS NULL AND cancelled_at IS NULL`).run(Date.now(), id, senderAccountId).changes;
}

export type ResendClaim = { id: string; token: string; claim: string; previousHash: string; previousExpiresAt: number; previousDeliveryState: string; previousCreatedAt: number; previousSentAt: number | null; expiresAt: number; invite: EmailInvite };

export function claimEmailInviteResend(id: string, senderAccountId: string, claim: string): ResendClaim | null {
  const existing = inviteById(id, senderAccountId);
  const account = db.query("SELECT verified_at FROM accounts WHERE account_id = ?").get(senderAccountId) as { verified_at: number | null } | null;
  if (!existing || !account?.verified_at) return null;
  const prior = db.query(`SELECT token_hash, expires_at, delivery_state, created_at, sent_at FROM invites
    WHERE invitation_id = ? AND inviter_account_id = ? AND accepted_at IS NULL AND cancelled_at IS NULL
      AND delivery_state IN ('sent','failed','pending') AND resend_claim IS NULL`)
    .get(id, senderAccountId) as { token_hash: string; expires_at: number; delivery_state: string; created_at: number; sent_at: number | null } | null;
  if (!prior) return null;
  const token = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + inviteLifetimeMs;
  const result = db.query(`UPDATE invites SET token_hash = ?, created_at = ?, sent_at = NULL, expires_at = ?, delivery_state = 'sending', resend_claim = ?
    WHERE invitation_id = ? AND inviter_account_id = ? AND token_hash = ? AND delivery_state = ? AND resend_claim IS NULL
      AND accepted_at IS NULL AND cancelled_at IS NULL`)
    .run(hash(token), Date.now(), expiresAt, claim, id, senderAccountId, prior.token_hash, prior.delivery_state);
  if (!result.changes) return null;
  return { id, token, claim, previousHash: prior.token_hash, previousExpiresAt: prior.expires_at,
    previousDeliveryState: prior.delivery_state, previousCreatedAt: prior.created_at, previousSentAt: prior.sent_at,
    expiresAt, invite: { ...existing, expiresAt } };
}

export function finishEmailInviteResend(resend: ResendClaim, senderAccountId: string, outcome: "sent" | "failed" | "uncertain"): boolean {
  if (outcome === "failed") return !!db.query(`UPDATE invites SET token_hash = ?, expires_at = ?, delivery_state = ?, created_at = ?, sent_at = ?, resend_claim = NULL
    WHERE invitation_id = ? AND inviter_account_id = ? AND token_hash = ? AND resend_claim = ? AND delivery_state = 'sending'`)
    .run(resend.previousHash, resend.previousExpiresAt, resend.previousDeliveryState, resend.previousCreatedAt, resend.previousSentAt,
      resend.id, senderAccountId, hash(resend.token), resend.claim).changes;
  return !!db.query(`UPDATE invites SET delivery_state = ?, sent_at = ?, sends = sends + 1, resend_claim = NULL
    WHERE invitation_id = ? AND inviter_account_id = ? AND token_hash = ? AND resend_claim = ? AND delivery_state = 'sending'`)
    .run(outcome, Date.now(), resend.id, senderAccountId, hash(resend.token), resend.claim).changes;
}

export type OperationStart = { status: "new" } | { status: "replay"; response: unknown; httpStatus: number } | { status: "busy" } | { status: "conflict" };
export function beginConversationOperation(accountId: string, key: string, payloadHash: string): OperationStart {
  const now = Date.now();
  const insert = db.query(`INSERT INTO conversation_operations (account_id, idempotency_key, payload_hash, state, created_at, updated_at)
    VALUES (?, ?, ?, 'processing', ?, ?) ON CONFLICT DO NOTHING`).run(accountId, key, payloadHash, now, now);
  if (insert.changes) return { status: "new" };
  const row = db.query(`SELECT payload_hash, state, response_json, response_status FROM conversation_operations
    WHERE account_id = ? AND idempotency_key = ?`).get(accountId, key) as { payload_hash: string; state: string; response_json: string | null; response_status: number };
  if (row.payload_hash !== payloadHash) return { status: "conflict" };
  if (row.state === "complete" && row.response_json) return { status: "replay", response: JSON.parse(row.response_json), httpStatus: row.response_status };
  return { status: "busy" };
}
export function completeConversationOperation(accountId: string, key: string, response: unknown, status = 200): void {
  db.query(`UPDATE conversation_operations SET state = 'complete', response_json = ?, response_status = ?, updated_at = ?
    WHERE account_id = ? AND idempotency_key = ? AND state = 'processing'`)
    .run(JSON.stringify(response), status, Date.now(), accountId, key);
}

// Update invite state after initial send; quota reservation is settled separately.
export function recordEmailInviteDelivery(token: string, outcome: "sent" | "failed" | "uncertain"): void {
  db.query(`UPDATE invites SET delivery_state = ?, sent_at = CASE WHEN ? = 'failed' THEN sent_at ELSE ? END,
    sends = sends + CASE WHEN ? = 'failed' THEN 0 ELSE 1 END WHERE token_hash = ?`)
    .run(outcome, outcome, Date.now(), outcome, hash(token));
}
