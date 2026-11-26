// Founder-only, client-driven welcome. The server never sends as a human: it resolves the real
// verified human admin, persists an opt-in, and queues one job per newly verified human. The
// founder's own signed-in browser opens each DM and sends through the normal durable outbox.
import { randomUUID } from "node:crypto";
import { accountByNick, type Account } from "./accounts.ts";
import { db } from "./db.ts";

// The configured instance owner. Only a verified human admin qualifies, so a reused nick owned by
// a member, bot or agent can never inherit the queue or the control.
export function founderAccount(): Account | null {
  const nick = (process.env.OWNER_NICK || process.env.ADMIN_NICK || "").trim();
  const account = nick ? accountByNick(nick) : null;
  if (!account || account.kind !== "human" || account.role !== "admin" || !account.verifiedAt) return null;
  return account;
}

export function isFounder(account: Account | null): boolean {
  const founder = founderAccount();
  return !!account && !!founder && account.id === founder.id;
}

export function welcomeEnabled(): boolean {
  const founder = founderAccount();
  if (!founder) return false;
  const row = db.query("SELECT enabled FROM founder_welcome_optin WHERE founder_account_id = ?").get(founder.id) as { enabled: number } | null;
  return row?.enabled === 1;
}

// Only the founder may change the setting; the row is keyed by the immutable account id.
export function setWelcomeEnabled(account: Account, enabled: boolean): boolean {
  if (!isFounder(account)) return false;
  db.query(`INSERT INTO founder_welcome_optin (founder_account_id, enabled, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(founder_account_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .run(account.id, enabled ? 1 : 0, Date.now());
  return true;
}

// Called on the first verification of a human only, after opt-in. Idempotent per recipient, so a
// retried auth callback or two tabs cannot queue the same person twice. Older members are never
// scanned in: nothing here reads history.
export function enqueueWelcomeJob(recipientNick: string): void {
  // Queueing is best-effort end to end: a welcome must never make a sign-in fail, including a
  // read or identity lookup that throws. The unique recipient index still prevents a duplicate
  // on the next callback.
  try {
    const founder = founderAccount();
    if (!founder || !welcomeEnabled()) return;
    const recipient = accountByNick(recipientNick);
    if (!recipient || recipient.kind !== "human" || !recipient.verifiedAt) return;
    if (recipient.id === founder.id) return;
    const now = Date.now();
    db.query(`INSERT INTO founder_welcome_jobs (id, founder_account_id, recipient_account_id, recipient_nick, state, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'pending', ?, ?)
              ON CONFLICT(recipient_account_id) DO NOTHING`)
      .run(randomUUID(), founder.id, recipient.id, recipient.nick, now, now);
  } catch (error) {
    console.error(`founder welcome enqueue failed for ${recipientNick}:`, error instanceof Error ? error.message : error);
  }
}

export type WelcomeJob = { id: string; recipientAccountId: string; recipientNick: string; state: "pending" | "claimed"; claimId: string | null };

export function welcomeJobs(founder: Account): WelcomeJob[] {
  const rows = db.query(`SELECT id, recipient_account_id, recipient_nick, state, claim_id FROM founder_welcome_jobs
                         WHERE founder_account_id = ? AND state IN ('pending', 'claimed') ORDER BY created_at`)
    .all(founder.id) as { id: string; recipient_account_id: string; recipient_nick: string; state: "pending" | "claimed"; claim_id: string | null }[];
  return rows.map((row) => ({ id: row.id, recipientAccountId: row.recipient_account_id, recipientNick: row.recipient_nick, state: row.state, claimId: row.claim_id }));
}

// One atomic pending -> claimed transition. A second tab or device gets null and must not send.
// The claim id is the delivery token; only the winner may ack or release.
export function claimWelcomeJob(founder: Account, id: string): string | null {
  const claimId = randomUUID();
  const changed = db.query(`UPDATE founder_welcome_jobs SET state = 'claimed', claim_id = ?, updated_at = ?
                            WHERE id = ? AND founder_account_id = ? AND state = 'pending'`)
    .run(claimId, Date.now(), id, founder.id).changes;
  return changed ? claimId : null;
}

// Delivered only after the client proves an echo. A socket write or outbox enqueue is not proof.
export function markWelcomeDelivered(founder: Account, id: string, claimId: string, msgid: string | null): boolean {
  const changed = db.query(`UPDATE founder_welcome_jobs SET state = 'delivered', claim_id = NULL, delivered_msgid = ?, updated_at = ?
                            WHERE id = ? AND founder_account_id = ? AND state = 'claimed' AND claim_id = ?`)
    .run(msgid, Date.now(), id, founder.id, claimId).changes;
  return changed > 0;
}

// A refused or never-enqueued delivery returns the job to pending. An uncertain send keeps the
// claim so no other device silently re-sends a message that may already exist.
export function releaseWelcomeJob(founder: Account, id: string, claimId: string): boolean {
  const changed = db.query(`UPDATE founder_welcome_jobs SET state = 'pending', claim_id = NULL, updated_at = ?
                            WHERE id = ? AND founder_account_id = ? AND state = 'claimed' AND claim_id = ?`)
    .run(Date.now(), id, founder.id, claimId).changes;
  return changed > 0;
}
