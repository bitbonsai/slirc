import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { accountByNick } from "./accounts.ts";

// Phone pairing by QR: a signed-in browser mints an offer, shows it as a QR code, and whichever
// browser redeems the token is signed in as the same account. Nobody confirms on the minting side,
// so the offer is a login for as long as it lives. Its short lifetime, single use and binding to
// the minting session are what keep that safe. The older code flow (pairing.ts) runs the other way
// and is untouched.

export const OFFER_LIFETIME_MS = 60_000;
// A used offer stays long enough for "Not you? Sign it out" on the minting card, then is swept.
const USED_RETENTION_MS = 10 * 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export type Offer = { id: string; token: string; expiresAt: number };
export type Redeemed = { id: string; nick: string; sessionHash: string };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function eligible(nick: string): boolean {
  const account = accountByNick(nick);
  return account?.kind === "human" && !!account.verifiedAt;
}

export function sweepOffers(now = Date.now()): void {
  db.query("DELETE FROM pair_offers WHERE (status = 'pending' AND expires_at <= ?) OR (status = 'used' AND expires_at <= ?)")
    .run(now, now - USED_RETENTION_MS);
}

// One live offer per minting session: a new one cancels the last. The caller has already checked
// that the session belongs to a verified human.
export function mintOffer(nick: string, sessionHash: string, now = Date.now()): Offer {
  sweepOffers(now);
  const token = randomBytes(32).toString("base64url");
  const id = randomBytes(12).toString("base64url");
  const expiresAt = now + OFFER_LIFETIME_MS;
  db.transaction(() => {
    db.query("DELETE FROM pair_offers WHERE session_hash = ? AND status = 'pending'").run(sessionHash);
    db.query("INSERT INTO pair_offers (token_hash, id, nick, session_hash, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(hash(token), id, nick, sessionHash, expiresAt, now);
  })();
  return { id, token, expiresAt };
}

export function cancelOffers(sessionHash: string): void {
  db.query("DELETE FROM pair_offers WHERE session_hash = ? AND status = 'pending'").run(sessionHash);
}

// Spends the offer and starts the session in one transaction, so two concurrent redeems give one
// session. Every dead token (unknown, expired, used, cancelled, minting session gone, account no
// longer a verified human) returns null: the caller answers them all identically.
export function redeemOffer(
  token: unknown,
  device: { browser: string; os: string },
  startSession: (nick: string) => string,
  now = Date.now(),
): Redeemed | null {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  const tokenHash = hash(token);
  return db.transaction(() => {
    const row = db.query("SELECT id, nick, session_hash FROM pair_offers WHERE token_hash = ? AND status = 'pending' AND expires_at > ?")
      .get(tokenHash, now) as { id: string; nick: string; session_hash: string } | null;
    if (!row) return null;
    const minter = db.query("SELECT 1 FROM sessions WHERE token_hash = ? AND nick = ? COLLATE NOCASE").get(row.session_hash, row.nick);
    if (!minter || !eligible(row.nick)) {
      db.query("DELETE FROM pair_offers WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    const spent = db.query("UPDATE pair_offers SET status = 'used', browser = ?, os = ? WHERE token_hash = ? AND status = 'pending' AND expires_at > ?")
      .run(device.browser.slice(0, 40), device.os.slice(0, 40), tokenHash, now).changes;
    if (spent !== 1) return null;
    const sessionHash = startSession(row.nick);
    db.query("UPDATE pair_offers SET redeemed_session = ? WHERE token_hash = ?").run(sessionHash, tokenHash);
    return { id: row.id, nick: row.nick, sessionHash };
  })();
}

// The session a used offer started, for "Sign it out". Only the minting session may ask, and only
// while the offer row is still retained.
export function redeemedSession(id: string, minterSessionHash: string): { nick: string; sessionHash: string } | null {
  sweepOffers();
  const row = db.query("SELECT nick, redeemed_session FROM pair_offers WHERE id = ? AND session_hash = ? AND status = 'used'")
    .get(id, minterSessionHash) as { nick: string; redeemed_session: string | null } | null;
  return row?.redeemed_session ? { nick: row.nick, sessionHash: row.redeemed_session } : null;
}
