import { createHash, randomBytes, randomInt } from "node:crypto";
import { db } from "./db.ts";
import { createLimiter } from "./request-security.ts";

// Browser-session pairing: a signed-out browser asks for a code, a signed-in one approves it, and the
// first gets a login token. Agent pairing used to share this table; agents redeem connect codes now
// (agent-connect.ts). The pair_requests columns machine and tool stay in the schema and are written empty.

export type PairRequest = {
  code: string;
  kind: "session";
  owner: string;
  browser: string | null;
  os: string | null;
  ip: string;
  status: "pending" | "approved" | "delivered";
  password: string | null;
  expiresAt: number;
  createdAt: number;
};

export class PairingError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 429 = 400) {
    super(message);
  }
}

const blockedIps = new Map<string, number>();
const hour = 60 * 60_000;
const requestLimit = createLimiter({ limit: 60, windowMs: hour });

function hash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function rowRequest(row: any): PairRequest | null {
  return row && {
    code: row.code,
    kind: row.kind,
    owner: row.owner,
    browser: row.browser,
    os: row.os,
    ip: row.ip,
    status: row.status,
    password: row.password,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function sweepExpired(now = Date.now()): void {
  db.query("DELETE FROM pair_requests WHERE expires_at <= ?").run(now);
  for (const [ip, until] of blockedIps) if (until <= now) blockedIps.delete(ip);
}

type CreateRequestInput = { ip: string; kind: "session"; browser: string; os: string; owner?: string };

export function createRequest(input: CreateRequestInput) {
  const now = Date.now();
  sweepExpired(now);
  const ip = input.ip.trim();
  if (!ip || ip.length > 128) throw new PairingError("invalid IP");
  if ((blockedIps.get(ip) || 0) > now) throw new PairingError("pairing blocked for this IP", 429);

  if (!requestLimit.check(ip, now)) throw new PairingError("too many pairing requests", 429);

  const browser = input.browser.trim().slice(0, 40) || "Browser";
  const os = input.os.trim().slice(0, 40) || "Unknown OS";
  // Who this signs in as, when the phone said which email it belongs to. Empty means nobody's
  // clients will be told about it, and the code has to be typed on the other device.
  const owner = (input.owner || "").trim();

  const secret = randomBytes(32).toString("base64url");
  const expiresAt = now + 2 * 60_000;
  let code = "";
  for (let retry = 0; retry < 10; retry++) {
    code = randomInt(1_000_000).toString().padStart(6, "0");
    if (!db.query("SELECT 1 FROM pair_requests WHERE code = ?").get(code)) break;
    code = "";
  }
  if (!code) throw new PairingError("could not create pairing request");
  db.query(`INSERT INTO pair_requests (code, secret_hash, kind, owner, machine, tool, browser, os, ip, status, expires_at, created_at)
            VALUES (?, ?, 'session', ?, '', '', ?, ?, ?, 'pending', ?, ?)`)
    .run(code, hash(secret), owner, browser, os, ip, expiresAt, now);
  return { code, secret, expiresAt };
}

export function findByCode(code: string): PairRequest | null {
  sweepExpired();
  return rowRequest(db.query("SELECT * FROM pair_requests WHERE code = ?").get(code));
}

export function pendingForOwner(owner: string, directCode = "") {
  sweepExpired();
  return (db.query(`SELECT code, kind, browser, os, created_at, expires_at FROM pair_requests
                    WHERE status = 'pending' AND kind = 'session' AND (owner = ? COLLATE NOCASE OR (owner = '' AND code = ?))
                    ORDER BY created_at`).all(owner, directCode) as any[])
    .map((row) => ({ code: row.code, kind: row.kind, browser: row.browser, os: row.os, createdAt: row.created_at, expiresAt: row.expires_at }));
}

export function approve(code: string, owner: string, loginToken: string): boolean {
  const now = Date.now();
  return db.query(`UPDATE pair_requests SET status = 'approved', password = ?, owner = ?, expires_at = ?
                   WHERE code = ? AND kind = 'session' AND (owner = ? COLLATE NOCASE OR owner = '') AND status = 'pending' AND expires_at > ?`)
    .run(loginToken, owner, now + 5 * 60_000, code, owner, now).changes === 1;
}

export function deny(code: string, owner: string): boolean {
  const row = findByCode(code);
  if (!row || row.status !== "pending" || (row.owner && row.owner.toLowerCase() !== owner.toLowerCase())) return false;
  db.query("DELETE FROM pair_requests WHERE code = ?").run(code);
  blockedIps.set(row.ip, Date.now() + hour);
  return true;
}

export function deliverOnce(code: string, secret: string): { pending: true } | { loginToken: string } | null {
  sweepExpired();
  return db.transaction(() => {
    const row = db.query("SELECT status, password FROM pair_requests WHERE code = ? AND kind = 'session' AND secret_hash = ? AND expires_at > ?")
      .get(code, hash(secret), Date.now()) as { status: string; password: string | null } | null;
    if (!row) return null;
    if (row.status === "pending") return { pending: true } as const;
    if (row.status !== "approved" || !row.password) return null;
    const delivered = db.query("UPDATE pair_requests SET status = 'delivered', password = NULL WHERE code = ? AND status = 'approved' AND password = ?")
      .run(code, row.password).changes;
    if (delivered !== 1) return null;
    return { loginToken: row.password };
  })();
}
