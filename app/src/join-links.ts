import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { hash, normalized } from "./rooms.ts";

// An open join link for one channel of a private workspace. The link is the gate: unguessable,
// posted where the owner chooses. Opening it never counts; each visitor proves their mailbox through
// an ordinary personal invitation the link creates. Lookups go by the token's hash; the token itself
// is kept beside it only so the admin who made the link can copy it again, and is cleared once the
// link is revoked or expires. JoinLink never carries it: read it with joinLinkToken.
db.exec(`CREATE TABLE IF NOT EXISTS join_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_account TEXT NOT NULL,
  max_joins INTEGER NOT NULL,
  joins INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
)`);
try { db.exec("ALTER TABLE invites ADD COLUMN join_link_id TEXT"); } catch {}
// Links made before this column have no token and cannot be copied again.
try { db.exec("ALTER TABLE join_links ADD COLUMN token TEXT"); } catch {}

export const JOIN_LINK_DEFAULT_MAX = 99;
export const JOIN_LINK_DEFAULT_DAYS = 7;
// Mail a link may cause in total, so a posted link cannot be used to mail strangers without end.
export const SENDS_PER_JOIN = 2;
// Open links one admin may hold at once.
export const OPEN_LINKS_PER_ADMIN = 5;

export type JoinLink = { id: string; channel: string; createdBy: string; createdByAccount: string; maxJoins: number; joins: number; sends: number; expiresAt: number; revokedAt: number | null; createdAt: number };

function row(raw: any): JoinLink | null {
  return raw ? { id: raw.id, channel: raw.channel, createdBy: raw.created_by, createdByAccount: raw.created_by_account, maxJoins: raw.max_joins, joins: raw.joins,
    sends: raw.sends, expiresAt: raw.expires_at, revokedAt: raw.revoked_at, createdAt: raw.created_at } : null;
}

export function createJoinLink(input: { owner: string; ownerAccountId: string; channel: string; maxJoins?: number; days?: number }, now = Date.now()): { link: JoinLink; token: string } {
  const token = randomBytes(24).toString("base64url");
  const id = randomBytes(12).toString("hex");
  const maxJoins = Math.max(1, Math.min(500, Math.floor(input.maxJoins ?? JOIN_LINK_DEFAULT_MAX)));
  const days = Math.max(1, Math.min(30, Math.floor(input.days ?? JOIN_LINK_DEFAULT_DAYS)));
  db.query(`INSERT INTO join_links (id, token_hash, token, channel, created_by, created_by_account, max_joins, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, hash(token), token, normalized(input.channel), input.owner, input.ownerAccountId, maxJoins, now + days * 86_400_000, now);
  return { link: joinLinkById(id)!, token };
}

export function joinLinkById(id: string): JoinLink | null {
  return row(db.query("SELECT * FROM join_links WHERE id = ?").get(id));
}

export function joinLinkByToken(token: string): JoinLink | null {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  return row(db.query("SELECT * FROM join_links WHERE token_hash = ?").get(hash(token)));
}

// Fails closed: revoked or expired is never open. Full is a separate answer, since a person who
// already signed up through the link may still finish joining.
// "spent" means the link sent all the mail it may, so the owner knows to make a new one.
export function joinLinkState(link: JoinLink | null, now = Date.now()): "open" | "full" | "spent" | "closed" {
  if (!link || link.revokedAt || link.expiresAt <= now) return "closed";
  if (link.joins >= link.maxJoins) return "full";
  return link.sends >= link.maxJoins * SENDS_PER_JOIN ? "spent" : "open";
}

export function openJoinLinks(ownerAccountId: string, now = Date.now()): number {
  return (db.query("SELECT COUNT(*) AS n FROM join_links WHERE created_by_account = ? AND revoked_at IS NULL AND expires_at > ? AND joins < max_joins")
    .get(ownerAccountId, now) as { n: number }).n;
}

// One atomic step claims a place, so two people racing for the last one get exactly one.
export function reserveJoin(id: string, now = Date.now()): boolean {
  return db.query("UPDATE join_links SET joins = joins + 1 WHERE id = ? AND joins < max_joins AND revoked_at IS NULL AND expires_at > ?").run(id, now).changes > 0;
}

export function releaseJoin(id: string): void {
  db.query("UPDATE join_links SET joins = joins - 1 WHERE id = ? AND joins > 0").run(id);
}

export function reserveSend(id: string, now = Date.now()): boolean {
  return db.query(`UPDATE join_links SET sends = sends + 1
                   WHERE id = ? AND sends < max_joins * ? AND joins < max_joins AND revoked_at IS NULL AND expires_at > ?`).run(id, SENDS_PER_JOIN, now).changes > 0;
}

// A mail that never went out gives its send back.
export function refundSend(id: string): void {
  db.query("UPDATE join_links SET sends = sends - 1 WHERE id = ? AND sends > 0").run(id);
}

export function joinLinkIdForInviteId(inviteId: string): string | null {
  const found = db.query("SELECT join_link_id FROM invites WHERE invitation_id = ?").get(inviteId) as { join_link_id: string | null } | null;
  return found?.join_link_id ?? null;
}

export function joinLinkIdForInvite(token: string): string | null {
  const found = db.query("SELECT join_link_id FROM invites WHERE token_hash = ?").get(hash(token)) as { join_link_id: string | null } | null;
  return found?.join_link_id ?? null;
}

export function markInviteFromLink(inviteId: string, linkId: string): void {
  db.query("UPDATE invites SET join_link_id = ? WHERE invitation_id = ?").run(linkId, inviteId);
}

// A pending invitation this link already mailed to the address, so a second request sends nothing.
export function pendingLinkInvite(linkId: string, email: string, now = Date.now()): boolean {
  return !!db.query(`SELECT 1 FROM invites WHERE join_link_id = ? AND email = ? AND accepted_at IS NULL AND cancelled_at IS NULL
                     AND expires_at > ? AND delivery_state <> 'failed'`).get(linkId, email, now);
}

// The stored token of the owner's own link while it is still open to copy; null for links made
// before tokens were kept, and for revoked or expired ones.
export function joinLinkToken(id: string, ownerAccountId: string, now = Date.now()): string | null {
  const found = db.query("SELECT token FROM join_links WHERE id = ? AND created_by_account = ? AND revoked_at IS NULL AND expires_at > ?")
    .get(id, ownerAccountId, now) as { token: string | null } | null;
  return found?.token ?? null;
}

export function listJoinLinks(ownerAccountId: string, now = Date.now()): JoinLink[] {
  db.query("UPDATE join_links SET token = NULL WHERE created_by_account = ? AND token IS NOT NULL AND (revoked_at IS NOT NULL OR expires_at <= ?)").run(ownerAccountId, now);
  return (db.query("SELECT * FROM join_links WHERE created_by_account = ? ORDER BY created_at DESC LIMIT 20").all(ownerAccountId) as any[]).map((raw) => row(raw)!);
}

export function revokeJoinLink(id: string, ownerAccountId: string, now = Date.now()): boolean {
  return db.query("UPDATE join_links SET revoked_at = ?, token = NULL WHERE id = ? AND created_by_account = ? AND revoked_at IS NULL").run(now, id, ownerAccountId).changes > 0;
}
