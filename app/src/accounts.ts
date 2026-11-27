import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { accountIrcPassword, ircPasswordFor } from "./irc-key.ts";
import { ergoOperUser, localDevLinks, slircMode } from "./config.ts";
import { closeSessionSockets } from "./relay.ts";
import type { AdmissionFence } from "./admissions.ts";
import { SERVICE_BOT_NICKS } from "../shared/service-bots.ts";

export class AdmissionAttemptStaleError extends Error {
  constructor() { super("admission attempt is no longer current"); }
}

// Every `DELETE FROM sessions` site in this file closes the matching live relay sockets first,
// the same way server.ts's closeSessionsForNick does, so a revoked/replaced account's browser
// tab drops its Ergo connection in-process instead of talking to Ergo as a nick that no longer
// belongs to it.
function closeSessionsForNick(nick: string) {
  const rows = db.query("SELECT token_hash FROM sessions WHERE nick = ? COLLATE NOCASE").all(nick) as { token_hash: string }[];
  for (const row of rows) closeSessionSockets(row.token_hash);
  const tokens = db.query("SELECT token_hash FROM client_tokens WHERE nick = ? COLLATE NOCASE").all(nick) as { token_hash: string }[];
  for (const row of tokens) closeSessionSockets(row.token_hash);
  db.query("DELETE FROM client_tokens WHERE nick = ? COLLATE NOCASE").run(nick);
}

export type Account = {
  id: string;
  nick: string;
  email: string;
  ircPassword: string;
  role: "admin" | "member";
  kind: "human" | "agent" | "bot";
  owner: string | null;
  machine: string | null;
  verifiedAt: number | null;
  provisionalExpiresAt: number | null;
  createdAt: number;
};

const legacyUsers = JSON.parse(process.env.USERS_JSON || "{}") as Record<string, string>;
const ownerNick = (process.env.OWNER_NICK || process.env.ADMIN_NICK || "").trim().toLowerCase();
if (!ownerNick && process.env.NODE_ENV !== "test") throw new Error("OWNER_NICK required");
// Explicit local mode has no email delivery; fixture accounts verify immediately.
const localDev = localDevLinks();
// A local stack marks a new account verified at once, since nobody clicks its mail. Never on the
// public playground: there anyone can type an address, so only the mailed link verifies it.
const preVerified = () => localDev && slircMode() !== "public_playground";
const ownerEmail = ownerNick ? legacyUsers[ownerNick] : undefined;

if (ownerEmail) {
  const previousOwner = db.query("SELECT nick FROM accounts WHERE email = ? COLLATE NOCASE").get(ownerEmail.trim().toLowerCase()) as { nick: string } | null;
  if (previousOwner && previousOwner.nick.toLowerCase() !== ownerNick) db.transaction(() => {
    const from = previousOwner.nick;
    db.query("UPDATE profiles SET account = ? WHERE account = ?").run(ownerNick, from);
    db.query("UPDATE channel_members SET nick = ? WHERE nick = ?").run(ownerNick, from);
    db.query("UPDATE channels SET owner = ? WHERE owner = ?").run(ownerNick, from);
    db.query("UPDATE sessions SET nick = ? WHERE nick = ?").run(ownerNick, from);
    db.query("UPDATE magic_links SET nick = ? WHERE nick = ?").run(ownerNick, from);
    db.query("UPDATE subscriptions SET nick = ? WHERE nick = ?").run(ownerNick, from);
    db.query("UPDATE native_devices SET nick = ? WHERE nick = ?").run(ownerNick, from);
    db.query("UPDATE notification_prefs SET nick = ? WHERE nick = ?").run(ownerNick, from);
    db.query("UPDATE uploads SET nick = ? WHERE nick = ?").run(ownerNick, from);
    db.query("UPDATE invites SET created_by = ? WHERE created_by = ?").run(ownerNick, from);
    db.query("UPDATE accounts SET nick = ? WHERE nick = ?").run(ownerNick, from);
  })();
  db.query(`INSERT INTO accounts (nick, email, irc_password_gen, role, verified_at, created_at)
            VALUES (?, ?, 0, 'admin', ?, ?)
            ON CONFLICT(nick) DO UPDATE SET email = excluded.email,
              role = 'admin', verified_at = COALESCE(accounts.verified_at, excluded.verified_at)`)
    .run(ownerNick, ownerEmail.trim().toLowerCase(), Date.now(), Date.now());
  for (const row of db.query("SELECT DISTINCT nick FROM sessions WHERE nick NOT IN (SELECT nick FROM accounts)").all() as { nick: string }[]) {
    closeSessionsForNick(row.nick);
  }
  db.query("DELETE FROM sessions WHERE nick NOT IN (SELECT nick FROM accounts)").run();
  db.query("DELETE FROM channel_members WHERE nick NOT IN (SELECT nick FROM accounts)").run();
  db.query("INSERT INTO profiles (account, full_name) VALUES (?, ?) ON CONFLICT(account) DO NOTHING").run(ownerNick, ownerNick);
}

function rowAccount(row: any): Account | null {
  if (!row || row.removed_at || (!row.verified_at && row.provisional_expires_at && row.provisional_expires_at <= Date.now())) return null;
  return {
    id: row.account_id,
    nick: row.nick,
    email: row.email,
    ircPassword: accountIrcPassword(row),
    role: row.role,
    kind: row.kind,
    owner: row.owner,
    machine: row.machine,
    verifiedAt: row.verified_at,
    provisionalExpiresAt: row.provisional_expires_at,
    createdAt: row.created_at,
  };
}

export function accountByNick(nick: string): Account | null {
  return rowAccount(db.query("SELECT * FROM accounts WHERE nick = ? COLLATE NOCASE").get(nick));
}

export function accountByEmail(email: string): Account | null {
  return rowAccount(db.query("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE").get(email.trim()));
}

export function allAccounts(): Account[] {
  return (db.query("SELECT * FROM accounts ORDER BY created_at").all() as any[]).map(rowAccount).filter(Boolean) as Account[];
}

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export function accountNick(name: string): string {
  const base = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^[^a-z]+/, "").slice(0, 20);
  return base || "member";
}

// Staff and service names a person must not take, so nobody signs up as "admin" or "nickserv".
// Bots and agents name themselves elsewhere; this guards human accounts only.
const STAFF_NICKS = ["admin", "administrator", "support", "security", "help", "helpdesk", "slirc", "root", "owner", "mod",
  "moderator", "ops", "oper", "operator", "staff", "system", "sysop", "official", "chanserv", "nickserv", "histserv",
  "operserv", "hostserv", "memoserv", "botserv", "ergo"];
export function reservedNick(nick: string): boolean {
  const key = nick.toLowerCase();
  const owner = (process.env.OWNER_NICK || process.env.ADMIN_NICK || "").trim().toLowerCase();
  return STAFF_NICKS.includes(key) || (SERVICE_BOT_NICKS as readonly string[]).includes(key) || (!!owner && key === owner) || key === operNick();
}
function operNick(): string {
  try { return accountNick(ergoOperUser()); } catch { return ""; }
}
// A display name is free text shown on profile cards, in people search and in invitation mail.
// Whitespace collapses to single spaces. Control, format (zero-width, bidi) and private-use
// characters are refused, and so is any name that folds to a reserved nick ("Admin", "Nick Serv"),
// starts with "Slirc", or folds to the nick of an admin, agent or bot other than the person saving
// it. Two people may share a name like "Ben"; their @handles tell them apart.
export const DISPLAY_NAME_MAX = 80;
export function cleanDisplayName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim();
}
export function displayNameError(name: string, selfNick: string): string | null {
  if (!name) return "Enter a display name.";
  if (name.length > DISPLAY_NAME_MAX) return `Keep your display name to ${DISPLAY_NAME_MAX} characters.`;
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) return "Remove the hidden characters from your display name.";
  if (!/[\p{L}\p{N}]/u.test(name)) return "Use at least one letter or number in your display name.";
  const folded = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!folded || folded === selfNick.toLowerCase().replace(/[^a-z0-9]+/g, "")) return null;
  if (reservedNick(folded) || folded.startsWith("slirc")) return "That name is reserved.";
  const taken = db.query(`SELECT nick FROM accounts WHERE lower(replace(replace(nick, '-', ''), '_', '')) = ?
    AND removed_at IS NULL AND (role = 'admin' OR kind <> 'human')`).get(folded) as { nick: string } | null;
  if (taken) return `That name belongs to @${taken.nick}.`;
  return null;
}

// The name a new account starts with. One that fails displayNameError falls back to the nick, which
// is "member" or similar for a staff name; the person can pick a real one later on the You tab.
export function signupDisplayName(name: string, nick: string): string {
  const cleaned = cleanDisplayName(name);
  return displayNameError(cleaned, nick) ? nick : cleaned;
}

// A person's starting nick: their name's base, or "member" when that base is a staff name or starts
// with "slirc", the same names displayNameError refuses.
function humanNickBase(name: string): string {
  const base = accountNick(name);
  return reservedNick(base) || base.startsWith("slirc") ? "member" : base;
}

import { ergo } from "./ergo-api.ts";
export { ergo };

let provisioning = Promise.resolve();

function serializeProvisioning<T>(task: () => Promise<T>): Promise<T> {
  const work = provisioning.then(task);
  provisioning = work.then(() => {}, () => {});
  return work;
}

export function provisionAccount(name: string, email: string): Promise<Account> {
  return serializeProvisioning(async () => {
    const fullName = name.trim().slice(0, 80);
    const normalizedEmail = email.trim().toLowerCase();
    // Deliberately modest email validation: reject obvious test addresses like g@g.m, accept real-world local parts.
    if (!fullName || !validEmail(normalizedEmail)) throw new Error("Enter your name and a valid email address.");
    if (isRemovedEmail(normalizedEmail)) throw new Error(REMOVED_MESSAGE);
    if (db.query("SELECT 1 FROM admissions WHERE approved_email=? COLLATE NOCASE AND reserved_account_id IS NOT NULL").get(normalizedEmail)) {
      throw new Error("This address is reserved for its admission link.");
    }
    const existing = db.query("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE").get(normalizedEmail) as any;
    if (existing && rowAccount(existing)) throw new Error("Check your email for a sign-in link.");
    const now = Date.now();
    if (existing) {
      // An expired, never-verified account for this address: start its window again under the same
      // nick and Ergo account (its password unchanged) instead of registering a
      // second, suffixed one and orphaning the first. Anything it held before is dropped.
      closeSessionsForNick(existing.nick);
      db.query("DELETE FROM sessions WHERE nick = ?").run(existing.nick);
      db.query("DELETE FROM channel_members WHERE nick = ?").run(existing.nick);
      db.query("UPDATE accounts SET provisional_expires_at = ?, verified_at = ? WHERE nick = ?")
        .run(now + 2 * 60 * 60_000, preVerified() ? now : null, existing.nick);
      db.query("INSERT INTO profiles (account, full_name) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET full_name = excluded.full_name")
        .run(existing.nick, signupDisplayName(fullName, existing.nick));
      return accountByNick(existing.nick)!;
    }

    const base = humanNickBase(fullName);
    // The id exists before the row, so Ergo gets the derived password the row will compute.
    const accountId = randomBytes(16).toString("hex");
    const password = ircPasswordFor(accountId, 0);
    let nick = base;
    let registered = false;
    for (let suffix = 1; suffix <= 99; suffix++) {
      // Helper nicks stay free even on an instance that does not run them yet, so turning one on later
      // never collides with a person.
      if ((SERVICE_BOT_NICKS as readonly string[]).includes(nick) || db.query("SELECT 1 FROM accounts WHERE nick = ? COLLATE NOCASE").get(nick) || db.query("SELECT 1 FROM admissions WHERE reserved_nick = ? COLLATE NOCASE AND reserved_account_id IS NOT NULL").get(nick)) {
        nick = `${base.slice(0, 18)}${suffix + 1}`;
        continue;
      }
      const result = await ergo("/v1/ns/saregister", { accountName: nick, passphrase: password });
      if (result.success) {
        registered = true;
        break;
      }
      if (result.errorCode !== "ACCOUNT_EXISTS") throw new Error(result.error || "Could not create chat account.");
      nick = `${base.slice(0, 18)}${suffix + 1}`;
    }
    if (!registered) throw new Error("Could not find an available account name.");

    db.query("INSERT INTO accounts (nick, email, irc_password_gen, account_id, role, verified_at, provisional_expires_at, created_at) VALUES (?, ?, 0, ?, 'member', ?, ?, ?)")
      .run(nick, normalizedEmail, accountId, preVerified() ? now : null, now + 2 * 60 * 60_000, now);
    db.query("INSERT INTO profiles (account, full_name) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET full_name = excluded.full_name")
      .run(nick, signupDisplayName(fullName, nick));
    return accountByNick(nick)!;
  });
}

// newAccount: the reserved identity is a new account, registered in Ergo with the password derived
// from accountId at counter 0. False for an address that already has an account.
export type AdmissionIdentity = { accountId: string; nick: string; email: string; newAccount: boolean; fullName: string; fence: AdmissionFence };

type AdmissionAttemptRow = {
  approved_email: string; state: string; generation: number; token_hash: string; expires_at: number;
  claim_hash: string; claim_name: string; reserved_account_id: string | null; reserved_nick: string | null; reserved_new_account: number | null;
};

function currentAdmissionAttempt(id: string, fence: AdmissionFence): AdmissionAttemptRow {
  const row = db.query(`SELECT approved_email,state,generation,token_hash,expires_at,claim_hash,claim_name,
    reserved_account_id,reserved_nick,reserved_new_account FROM admissions WHERE id=?`).get(id) as AdmissionAttemptRow | null;
  if (!row || row.state !== "redeeming" || row.generation !== fence.generation || row.token_hash !== fence.tokenHash ||
      row.claim_hash !== fence.claimHash || row.claim_name !== fence.name || row.expires_at <= Date.now()) throw new AdmissionAttemptStaleError();
  return row;
}

export function reserveAdmissionIdentity(admissionId: string, fence: AdmissionFence): Promise<AdmissionIdentity> {
  return serializeProvisioning(async () => {
    const admission = currentAdmissionAttempt(admissionId, fence);
    if (admission.reserved_account_id && admission.reserved_nick) return {
      accountId: admission.reserved_account_id, nick: admission.reserved_nick, email: admission.approved_email,
      newAccount: !!admission.reserved_new_account, fullName: fence.name, fence,
    };
    if (admission.reserved_account_id || admission.reserved_nick || admission.reserved_new_account != null) throw new AdmissionAttemptStaleError();

    const existing = db.query("SELECT account_id, nick, kind, removed_at FROM accounts WHERE email=? COLLATE NOCASE")
      .get(admission.approved_email) as { account_id: string; nick: string; kind: string; removed_at: number | null } | null;
    if (existing && existing.kind !== "human") throw new Error("approved address is already bound to a non-human account");
    if (existing?.removed_at) throw new Error(REMOVED_MESSAGE);
    const base = humanNickBase(fence.name);
    let nick = existing?.nick || "";
    if (!nick) for (let suffix = 0; suffix < 100; suffix++) {
      const candidate = suffix ? `${base.slice(0, 18)}${suffix + 1}` : base;
      if (!(SERVICE_BOT_NICKS as readonly string[]).includes(candidate) && !db.query("SELECT 1 FROM accounts WHERE nick=? COLLATE NOCASE").get(candidate) &&
          !db.query("SELECT 1 FROM admissions WHERE reserved_nick=? COLLATE NOCASE AND reserved_account_id IS NOT NULL").get(candidate)) {
        nick = candidate;
        break;
      }
    }
    if (!nick) throw new Error("Could not find an available account name.");
    const identity = {
      accountId: existing?.account_id || randomBytes(16).toString("hex"), nick, email: admission.approved_email,
      newAccount: !existing, fullName: fence.name, fence,
    };
    const reserved = db.query(`UPDATE admissions SET reserved_account_id=?,reserved_nick=?,reserved_new_account=?,updated_at=?
      WHERE id=? AND generation=? AND token_hash=? AND state='redeeming' AND claim_hash=? AND claim_name=? AND expires_at>? AND reserved_account_id IS NULL`)
      .run(identity.accountId, identity.nick, identity.newAccount ? 1 : 0, Date.now(), admissionId, fence.generation, fence.tokenHash,
        fence.claimHash, fence.name, Date.now()).changes;
    if (!reserved) throw new AdmissionAttemptStaleError();
    return identity;
  });
}

export function provisionAdmissionIdentity(identity: AdmissionIdentity, admissionId: string): Promise<void> {
  return serializeProvisioning(async () => {
    const admission = currentAdmissionAttempt(admissionId, identity.fence);
    if (admission.reserved_account_id !== identity.accountId || admission.reserved_nick?.toLowerCase() !== identity.nick.toLowerCase() ||
        !!admission.reserved_new_account !== identity.newAccount) throw new AdmissionAttemptStaleError();
    if (!identity.newAccount) {
      const existing = db.query("SELECT account_id,nick,email,kind FROM accounts WHERE account_id=?").get(identity.accountId) as
        { account_id: string; nick: string; email: string; kind: string } | null;
      if (!existing || existing.nick.toLowerCase() !== identity.nick.toLowerCase() || existing.email.toLowerCase() !== identity.email.toLowerCase() || existing.kind !== "human") {
        throw new Error("reserved admission identity needs recovery");
      }
      return;
    }

    const password = ircPasswordFor(identity.accountId, 0);
    let registered;
    try { registered = await ergo("/v1/ns/saregister", { accountName: identity.nick, passphrase: password }); }
    finally { currentAdmissionAttempt(admissionId, identity.fence); }
    if (registered.success) return;
    if (registered.errorCode !== "ACCOUNT_EXISTS") throw new Error(registered.error || "Ergo rejected admission account registration");
    let checked;
    try { checked = await ergo("/v1/check_auth", { accountName: identity.nick, passphrase: password }); }
    catch { checked = { success: false }; }
    currentAdmissionAttempt(admissionId, identity.fence);
    if (!checked.success) throw new Error("reserved admission account needs recovery");
  });
}

// The app owns the owner's IRC password like everyone else's, so an existing Ergo account is set to
// the derived value rather than trusted to match a configured one.
export async function ensureOwnerIrcAccount(): Promise<void> {
  if (!ownerNick) throw new Error("OWNER_NICK required");
  const owner = ownerEmail ? accountByNick(ownerNick) : null;
  if (!owner) throw new Error("owner credentials are missing");
  const result = await ergo("/v1/ns/saregister", { accountName: ownerNick, passphrase: owner.ircPassword });
  if (result.success) return;
  if (result.errorCode !== "ACCOUNT_EXISTS") throw new Error(result.error || "Could not create owner IRC account.");
  const updated = await ergo("/v1/ns/passwd", { accountName: ownerNick, passphrase: owner.ircPassword });
  if (!updated.success) throw new Error(updated.error || "Could not set the owner IRC password.");
}

// A new IRC password for this account: bump its counter and set Ergo to the new derived value.
// Ergo goes first, so a failure leaves the old password working. Callers that change several
// things for one person (the Clients page) serialize around this.
export async function rotateIrcPassword(nick: string): Promise<string> {
  const row = db.query("SELECT nick, account_id, irc_password_gen FROM accounts WHERE nick = ? COLLATE NOCASE").get(nick) as
    { nick: string; account_id: string; irc_password_gen: number | null } | null;
  if (!row) throw new Error("account not found");
  const gen = (row.irc_password_gen ?? 0) + 1;
  const password = ircPasswordFor(row.account_id, gen);
  const result = await ergo("/v1/ns/passwd", { accountName: row.nick, passphrase: password });
  if (!result.success) throw new Error(result.error || `Could not rotate IRC password (${result.errorCode || "unknown error"}).`);
  db.query("UPDATE accounts SET irc_password_gen = ? WHERE nick = ?").run(gen, row.nick);
  return password;
}

export async function ensureOperIrcAccount(): Promise<void> {
  const accountName = ergoOperUser();
  const passphrase = process.env.ERGO_OPER_PASS;
  if (!passphrase) throw new Error("ERGO_OPER_PASS required");
  const registered = await ergo("/v1/ns/saregister", { accountName, passphrase });
  if (!registered.success && registered.errorCode !== "ACCOUNT_EXISTS") throw new Error(registered.error || "Could not create oper IRC account.");
  const updated = await ergo("/v1/ns/passwd", { accountName, passphrase });
  if (!updated.success) throw new Error(updated.error || `Could not set oper IRC password: ${updated.errorCode || "unknown error"}`);
}

export async function ircChannelExists(channel: string): Promise<boolean> {
  const active = await ergo("/v1/list", {});
  const owned = ownerNick ? await ergo("/v1/ns/info", { accountName: ownerNick }) : { success: true, channels: [] };
  if (!active.success || !owned.success) throw new Error("Could not check channel name.");
  return [...active.channels || [], ...owned.channels || []].some((item) =>
    (typeof item === "string" ? item : item.name).toLowerCase() === channel.toLowerCase());
}

export function markVerified(nick: string) {
  db.query("UPDATE accounts SET verified_at = ? WHERE nick = ? AND removed_at IS NULL").run(Date.now(), nick);
}

const REMOVED_MESSAGE = "This address can't join here. Ask an admin.";

// A removed person keeps their row (see db.ts), so every way back in checks the email first.
export function isRemovedEmail(email: string): boolean {
  return !!db.query("SELECT 1 FROM accounts WHERE email = ? COLLATE NOCASE AND removed_at IS NOT NULL").get(email.trim());
}

// The app half of removing a person. Clearing verified_at drops them from every verified-human
// query (people search, contacts, discovery, invitations); removed_at keeps them out for good.
// Sessions, sign-in links, pairing offers and push subscriptions go, and each live relay socket
// closes. Returns the channels they were in, for the IRC half to kick them from.
export function markRemoved(nick: string): string[] {
  const channels = (db.query("SELECT channel FROM channel_members WHERE nick = ? COLLATE NOCASE").all(nick) as { channel: string }[]).map((row) => row.channel);
  closeSessionsForNick(nick);
  db.transaction(() => {
    db.query("UPDATE accounts SET removed_at = COALESCE(removed_at, ?), verified_at = NULL WHERE nick = ? COLLATE NOCASE").run(Date.now(), nick);
    db.query("DELETE FROM sessions WHERE nick = ? COLLATE NOCASE").run(nick);
    db.query("DELETE FROM client_tokens WHERE nick = ? COLLATE NOCASE").run(nick);
    db.query("DELETE FROM magic_links WHERE nick = ? COLLATE NOCASE").run(nick);
    db.query("DELETE FROM pair_offers WHERE nick = ? COLLATE NOCASE").run(nick);
    db.query("DELETE FROM subscriptions WHERE nick = ? COLLATE NOCASE").run(nick);
    db.query("DELETE FROM native_devices WHERE nick = ? COLLATE NOCASE").run(nick);
    db.query("DELETE FROM channel_members WHERE nick = ? COLLATE NOCASE").run(nick);
    db.query("DELETE FROM notes WHERE account_id IN (SELECT account_id FROM accounts WHERE nick = ? COLLATE NOCASE)").run(nick);
    db.query("DELETE FROM uploads WHERE channel IN (SELECT 'notes:' || account_id FROM accounts WHERE nick = ? COLLATE NOCASE)").run(nick);
  })();
  return channels;
}
