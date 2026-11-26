import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { AdmissionAttemptStaleError, signupDisplayName, validEmail } from "./accounts.ts";
import { normalizeEmail } from "./email-invites.ts";

export const admissionLifetimeMs = 7 * 24 * 60 * 60_000;

export type WaitlistApplication = { id: string; email: string; selfhost: boolean; createdAt: number; revision: number };
export type AdmissionRow = {
  id: string; application_id: string; application_revision: number; generation: number; approved_email: string;
  token_hash: string; expires_at: number; state: "pending" | "redeeming" | "redeemed" | "cancelled";
  delivery_state: "sending" | "sent" | "failed" | "uncertain" | "cancelled";
  delivery_error: string | null; claim_hash: string | null; claim_name: string | null;
  reserved_account_id: string | null; reserved_nick: string | null; reserved_new_account: number | null;
  redeemed_account_id: string | null; created_at: number;
};
export type AdmissionFence = { generation: number; tokenHash: string; claimHash: string; name: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function waitlistConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env.WAITLIST_INTERNAL_TOKEN || "";
  const base = env.WAITLIST_API_URL?.trim() || "";
  if (token.length < 32 || !base) return false;
  try {
    const url = new URL("/api/internal/applications", base);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function waitlistApplications(fetcher: typeof fetch = fetch): Promise<WaitlistApplication[]> {
  const token = process.env.WAITLIST_INTERNAL_TOKEN || "";
  const base = process.env.WAITLIST_API_URL?.trim() || "";
  if (token.length < 32 || !base) throw new Error("waitlist integration is unavailable");
  const url = new URL("/api/internal/applications", base);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("waitlist integration is unavailable");
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`waitlist returned ${response.status}`);
  const body = await response.json() as { applications?: unknown };
  if (!Array.isArray(body.applications) || body.applications.length > 20_000) throw new Error("invalid waitlist snapshot");
  return body.applications.map((raw) => {
    const row = raw as Record<string, unknown>;
    if ((typeof row.id !== "string" && typeof row.id !== "number") || typeof row.email !== "string" ||
        !validEmail(row.email) || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
        typeof row.createdAt !== "number" || !Number.isSafeInteger(row.createdAt) || typeof row.selfhost !== "boolean") {
      throw new Error("invalid waitlist application");
    }
    return { id: String(row.id), email: row.email, selfhost: row.selfhost, createdAt: row.createdAt, revision: row.revision };
  });
}

export function admissionList() {
  return (db.query("SELECT * FROM admissions ORDER BY created_at DESC").all() as AdmissionRow[]).map(summary);
}

function insertAdmission(application: WaitlistApplication, email: string, now = Date.now()) {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  db.query(`INSERT INTO admissions
    (id, application_id, application_revision, generation, approved_email, token_hash, expires_at, state, delivery_state, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, 'pending', 'sending', ?, ?)`)
    .run(id, application.id, application.revision, email, hash(token), now + admissionLifetimeMs, now, now);
  return { id, token, email, expiresAt: now + admissionLifetimeMs, generation: 1 };
}

type RotatedAdmission = { admission: ReturnType<typeof summary>; token: string; generation: number };

function otherApplicationForEmail(applicationId: string, email: string): AdmissionRow | null {
  return (db.query("SELECT * FROM admissions WHERE application_id<>?").all(applicationId) as AdmissionRow[])
    .find((row) => normalizeEmail(row.approved_email) === normalizeEmail(email)) || null;
}

function rotateAdmission(current: AdmissionRow, now = Date.now()): RotatedAdmission | null {
  const token = randomBytes(32).toString("base64url");
  const generation = current.generation + 1;
  const changed = db.query(`UPDATE admissions SET token_hash=?, expires_at=?, state='pending', delivery_state='sending',
    delivery_error=NULL, claim_hash=NULL, claim_name=NULL, generation=?, updated_at=?
    WHERE id=? AND generation=? AND state<>'redeemed'`)
    .run(hash(token), now + admissionLifetimeMs, generation, now, current.id, current.generation).changes;
  if (!changed) return null;
  return { admission: summary(db.query("SELECT * FROM admissions WHERE id=?").get(current.id) as AdmissionRow), token, generation };
}

export function approveApplication(application: WaitlistApplication): { admission: ReturnType<typeof summary>; token: string | null; created: boolean; conflict?: boolean } {
  return db.transaction(() => {
    const rows = db.query("SELECT * FROM admissions WHERE application_id=? ORDER BY created_at").all(application.id) as AdmissionRow[];
    if (rows.length > 1) return { admission: summary(rows[0]!), token: null, created: false, conflict: true };
    const current = rows[0];
    if (current && (current.application_revision !== application.revision ||
        normalizeEmail(current.approved_email) !== normalizeEmail(application.email))) {
      return { admission: summary(current), token: null, created: false, conflict: true };
    }
    const duplicate = otherApplicationForEmail(application.id, application.email);
    if (duplicate) return { admission: summary(current || duplicate), token: null, created: false, conflict: true };
    if (current) {
      if (current.state !== "cancelled") return { admission: summary(current), token: null, created: false };
      const rotated = rotateAdmission(current);
      return rotated
        ? { ...rotated, created: true }
        : { admission: summary(current), token: null, created: false, conflict: true };
    }
    const issued = insertAdmission(application, normalizeEmail(application.email));
    const row = db.query("SELECT * FROM admissions WHERE id=?").get(issued.id) as AdmissionRow;
    return { admission: summary(row), token: issued.token, created: true };
  })();
}

export function reissueAdmission(id: string, application: WaitlistApplication): RotatedAdmission | null {
  return db.transaction(() => {
    const current = db.query("SELECT * FROM admissions WHERE id=?").get(id) as AdmissionRow | null;
    if (!current || current.state === "redeemed" || current.application_id !== application.id ||
        current.application_revision !== application.revision ||
        normalizeEmail(current.approved_email) !== normalizeEmail(application.email) ||
        otherApplicationForEmail(application.id, current.approved_email)) return null;
    return rotateAdmission(current);
  })();
}

export function cancelAdmission(id: string): boolean {
  const now = Date.now();
  return db.query(`UPDATE admissions SET state='cancelled', delivery_state='cancelled', delivery_error=NULL,
    claim_hash=NULL, claim_name=NULL, generation=generation+1, updated_at=?
    WHERE id=? AND state<>'redeemed'`).run(now, id).changes > 0;
}

export function recordAdmissionDelivery(id: string, generation: number, outcome: "sent" | "failed" | "uncertain", error?: string): void {
  db.query(`UPDATE admissions SET delivery_state=?, delivery_error=?, updated_at=?
    WHERE id=? AND generation=? AND state='pending' AND delivery_state='sending'`)
    .run(outcome, error?.slice(0, 500) || null, Date.now(), id, generation);
}

export function admissionForToken(token: string): (AdmissionFence & Pick<AdmissionRow, "id" | "approved_email" | "state" | "expires_at">) | null {
  if (token.length < 32 || token.length > 100) return null;
  const tokenHash = hash(token);
  const row = db.query("SELECT id, approved_email, state, expires_at, generation FROM admissions WHERE token_hash=?")
    .get(tokenHash) as Pick<AdmissionRow, "id" | "approved_email" | "state" | "expires_at" | "generation"> | null;
  return row && (row.state === "pending" || row.state === "redeeming") && row.expires_at > Date.now()
    ? { ...row, tokenHash, claimHash: "", name: "" } : null;
}

export function beginRedemption(token: string, browserClaim: string, name: string):
  | { status: "claimed"; admission: AdmissionRow; fence: AdmissionFence }
  | { status: "spent" | "invalid" | "claim-mismatch" | "name-mismatch" } {
  if (token.length < 32 || token.length > 100 || !/^[A-Za-z0-9_-]{32,128}$/.test(browserClaim)) return { status: "invalid" };
  const tokenHash = hash(token);
  const claimHash = hash(browserClaim);
  return db.transaction(() => {
    const row = db.query("SELECT * FROM admissions WHERE token_hash=?").get(tokenHash) as AdmissionRow | null;
    if (!row) return { status: "invalid" };
    if (row.state === "redeemed") return { status: "spent" };
    if ((row.state !== "pending" && row.state !== "redeeming") || row.expires_at <= Date.now()) return { status: "invalid" };
    if (row.claim_hash && row.claim_hash !== claimHash) return { status: "claim-mismatch" };
    if (row.claim_name && row.claim_name !== name) return { status: "name-mismatch" };
    if (row.state === "pending") {
      const changed = db.query(`UPDATE admissions SET state='redeeming', claim_hash=?, claim_name=?, updated_at=?
        WHERE id=? AND generation=? AND token_hash=? AND state='pending' AND expires_at>?`)
        .run(claimHash, name, Date.now(), row.id, row.generation, tokenHash, Date.now()).changes;
      if (!changed) return { status: "invalid" };
    }
    return {
      status: "claimed",
      admission: { ...row, state: "redeeming", claim_hash: claimHash, claim_name: name },
      fence: { generation: row.generation, tokenHash, claimHash, name },
    };
  })();
}

export function finalizeRedemption(input: {
  id: string; fence: AdmissionFence;
  identity: { accountId: string; nick: string; email: string; newAccount: boolean; fullName: string };
  session: { tokenHash: string; createdAt: number; device: string };
}, now = Date.now()): { nick: string } | null {
  return db.transaction(() => {
    const row = db.query("SELECT * FROM admissions WHERE id=?").get(input.id) as AdmissionRow | null;
    const identity = input.identity;
    const fence = input.fence;
    if (!row || row.state !== "redeeming" || row.generation !== fence.generation || row.token_hash !== fence.tokenHash ||
        row.claim_hash !== fence.claimHash || row.claim_name !== fence.name || row.expires_at <= now ||
        row.reserved_account_id !== identity.accountId || row.reserved_nick?.toLowerCase() !== identity.nick.toLowerCase() ||
        normalizeEmail(row.approved_email) !== normalizeEmail(identity.email) || !!row.reserved_new_account !== identity.newAccount) return null;

    const account = db.query("SELECT account_id, nick, email, kind FROM accounts WHERE account_id=?").get(identity.accountId) as
      { account_id: string; nick: string; email: string; kind: string } | null;
    if (account) {
      if (account.nick.toLowerCase() !== identity.nick.toLowerCase() || normalizeEmail(account.email) !== normalizeEmail(identity.email) || account.kind !== "human") return null;
      db.query("UPDATE accounts SET verified_at=COALESCE(verified_at, ?), provisional_expires_at=NULL WHERE account_id=?")
        .run(now, identity.accountId);
    } else {
      if (!identity.newAccount || db.query("SELECT 1 FROM accounts WHERE nick=? COLLATE NOCASE OR email=? COLLATE NOCASE").get(identity.nick, identity.email)) return null;
      db.query(`INSERT INTO accounts (nick,email,irc_password_gen,role,kind,verified_at,provisional_expires_at,created_at,account_id)
        VALUES (?, ?, 0, 'member', 'human', ?, NULL, ?, ?)`)
        .run(identity.nick, identity.email.toLowerCase(), now, now, identity.accountId);
      db.query("INSERT INTO profiles (account, full_name) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET full_name=excluded.full_name")
        .run(identity.nick, signupDisplayName(identity.fullName, identity.nick));
    }
    const completed = db.query(`UPDATE admissions SET state='redeemed', redeemed_account_id=?, redeemed_at=?, updated_at=?
      WHERE id=? AND generation=? AND token_hash=? AND state='redeeming' AND claim_hash=? AND claim_name=? AND expires_at>?`)
      .run(identity.accountId, now, now, input.id, fence.generation, fence.tokenHash, fence.claimHash, fence.name, now).changes;
    if (!completed) throw new AdmissionAttemptStaleError();
    db.query("INSERT INTO sessions (token_hash,nick,created_at,device) VALUES (?,?,?,?)")
      .run(input.session.tokenHash, identity.nick, input.session.createdAt, input.session.device);
    return { nick: identity.nick };
  })();
}

export function redeemedAdmission(token: string): { id: string; accountId: string } | null {
  if (token.length < 32 || token.length > 100) return null;
  const row = db.query("SELECT id, redeemed_account_id FROM admissions WHERE token_hash=? AND state='redeemed'")
    .get(hash(token)) as { id: string; redeemed_account_id: string | null } | null;
  return row?.redeemed_account_id ? { id: row.id, accountId: row.redeemed_account_id } : null;
}

function summary(row: AdmissionRow) {
  return { id: row.id, applicationId: row.application_id, revision: row.application_revision, generation: row.generation,
    email: row.approved_email, expiresAt: row.expires_at, state: row.state, delivery: row.delivery_state,
    deliveryError: row.delivery_error, createdAt: row.created_at };
}
