import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { ergo } from "./ergo-api.ts";
import { ircPasswordFor } from "./irc-key.ts";

type ErgoCall = (path: string, body: Record<string, unknown>) => Promise<{ success: boolean; errorCode?: string; error?: string }>;
export type IrcMigrationResult = { accounts: number; failed: number; bindings: number; admissions: number };

// One-time move from stored IRC passwords to derived ones (deploy A). migrate-founder.ts runs it
// before the app listens, only while the stored-password columns exist (a database that skipped
// deploy A); db.ts then drops them. Each account row whose counter is still NULL gets its derived password in
// Ergo, checked with check_auth, then counter 0 and the stored copy cleared in one write. A row that
// fails stays NULL and keeps working on its stored password, so a crash or an Ergo refusal halfway
// is safe and the next boot finishes the job. An unreachable Ergo throws, and the boot loop retries.
// A second run finds nothing to do. Never logs a password.
export async function migrateIrcPasswords(call: ErgoCall = ergo): Promise<IrcMigrationResult> {
  const result: IrcMigrationResult = { accounts: 0, failed: 0, bindings: 0, admissions: 0 };
  // Each table moves only while its stored column is there; a table created after deploy B never had one.
  const has = (table: string, column: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((item) => item.name === column);
  const rows = !has("accounts", "irc_password") ? [] : db.query(`SELECT nick, account_id, kind, owner, removed_at FROM accounts WHERE irc_password_gen IS NULL`).all() as
    { nick: string; account_id: string; kind: string; owner: string | null; removed_at: number | null }[];
  for (const row of rows) {
    const password = ircPasswordFor(row.account_id, 0);
    const updated = await call("/v1/ns/passwd", { accountName: row.nick, passphrase: password });
    const checked = updated.success ? await call("/v1/check_auth", { accountName: row.nick, passphrase: password }) : updated;
    // A removed person's Ergo account is suspended, so the new password may not check out. Nobody
    // signs in to it either way, and the stored copy must still go.
    if (!checked.success && !row.removed_at) {
      result.failed++;
      console.error(`irc passwords: ${row.nick} kept its stored password (${checked.errorCode || checked.error || "check failed"})`);
      continue;
    }
    // Plain IRC clients and managed bots were given the old password; their people get a note.
    const clients = row.kind === "human" && !row.removed_at && !!db.query("SELECT 1 FROM irc_devices WHERE account = ? COLLATE NOCASE").get(row.nick);
    db.transaction(() => {
      db.query("UPDATE accounts SET irc_password_gen = 0, irc_password = '', irc_reset_notice = irc_reset_notice | ? WHERE nick = ? AND irc_password_gen IS NULL")
        .run(clients ? 1 : 0, row.nick);
      if (row.kind === "bot" && row.owner) db.query("UPDATE accounts SET irc_reset_notice = irc_reset_notice | 2 WHERE nick = ? COLLATE NOCASE").run(row.owner);
    })();
    result.accounts++;
  }

  // Bindings: the agent's accounts row decides its password once it exists (bindingIrcPassword), so
  // the stored copy only matters for a binding still provisioning. That one gets a fixed account id,
  // and an Ergo account a crashed attempt already made is moved to the derived password.
  const bindings = !has("agent_session_bindings", "irc_password") ? [] : db.query("SELECT id, nick, irc_password, agent_account_id, status FROM agent_session_bindings WHERE irc_password <> ''").all() as
    { id: string; nick: string; irc_password: string; agent_account_id: string | null; status: string }[];
  for (const binding of bindings) {
    const account = db.query("SELECT account_id FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'agent'").get(binding.nick) as { account_id: string } | null;
    const accountId = binding.agent_account_id || account?.account_id || randomBytes(16).toString("hex");
    if (!account && binding.status !== "revoked" && !await moveReservedErgoAccount(call, binding.nick, binding.irc_password, accountId)) {
      result.failed++;
      continue;
    }
    db.query("UPDATE agent_session_bindings SET agent_account_id = ?, irc_password = '' WHERE id = ?").run(accountId, binding.id);
    result.bindings++;
  }

  // Admissions: reserved_password becomes the reserved_new_account flag. A redemption that was
  // halfway (Ergo account made, row not yet) is moved like a provisioning binding.
  const admissions = !has("admissions", "reserved_password") ? [] : db.query(`SELECT id, state, reserved_account_id, reserved_nick, reserved_password FROM admissions
    WHERE reserved_password IS NOT NULL OR (reserved_account_id IS NOT NULL AND reserved_new_account IS NULL)`).all() as
    { id: string; state: string; reserved_account_id: string | null; reserved_nick: string | null; reserved_password: string | null }[];
  for (const admission of admissions) {
    const pending = admission.state === "redeeming" && admission.reserved_password && admission.reserved_account_id && admission.reserved_nick &&
      !db.query("SELECT 1 FROM accounts WHERE account_id = ?").get(admission.reserved_account_id);
    if (pending && !await moveReservedErgoAccount(call, admission.reserved_nick!, admission.reserved_password!, admission.reserved_account_id!)) {
      result.failed++;
      continue;
    }
    db.query("UPDATE admissions SET reserved_new_account = ?, reserved_password = NULL WHERE id = ?").run(admission.reserved_password ? 1 : 0, admission.id);
    result.admissions++;
  }
  if (result.accounts || result.failed || result.bindings || result.admissions) {
    console.log(`irc passwords: ${result.accounts} accounts, ${result.bindings} agent bindings, ${result.admissions} admissions moved to derived passwords; ${result.failed} kept for the next boot`);
  }
  return result;
}

// An Ergo account registered with a reserved password before its row existed. If the stored
// password still signs in, Ergo gets the derived one; if it does not, there is no such account
// yet and the later registration uses the derived password anyway.
async function moveReservedErgoAccount(call: ErgoCall, nick: string, stored: string, accountId: string): Promise<boolean> {
  const current = await call("/v1/check_auth", { accountName: nick, passphrase: stored });
  if (!current.success) return true;
  const password = ircPasswordFor(accountId, 0);
  const updated = await call("/v1/ns/passwd", { accountName: nick, passphrase: password });
  return updated.success && (await call("/v1/check_auth", { accountName: nick, passphrase: password })).success;
}