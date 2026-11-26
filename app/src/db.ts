import { Database } from "bun:sqlite";
import webpush from "web-push";

export const db = new Database(process.env.DB_PATH || "/data/chat.sqlite", { create: true });
// The seed and the server open this file at the same time on boot. Without a busy timeout the
// loser throws SQLITE_BUSY at once, and the dev server (bun --watch) then sits dead until a file changes.
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (
    nick TEXT PRIMARY KEY COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL DEFAULT 'member',
    kind TEXT NOT NULL DEFAULT 'human',
    owner TEXT,
    machine TEXT,
    verified_at INTEGER,
    provisional_expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY,
    nick TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    code_hash TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS used_magic_links (
    token_hash TEXT PRIMARY KEY,
    used_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    nick TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    device TEXT NOT NULL DEFAULT 'Unknown device'
  );
  CREATE TABLE IF NOT EXISTS client_tokens (
    token_hash TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL,
    nick TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS client_tokens_session ON client_tokens(session_hash);
  CREATE INDEX IF NOT EXISTS client_tokens_nick ON client_tokens(nick COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    nick TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    preference TEXT NOT NULL DEFAULT 'mentions',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profiles (
    account TEXT PRIMARY KEY,
    full_name TEXT NOT NULL DEFAULT '',
    about TEXT NOT NULL DEFAULT '',
    availability TEXT NOT NULL DEFAULT '',
    badge TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    avatar_mime TEXT,
    gravatar_checked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS channels (
    channel TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    visibility TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    archived_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_members (
    channel TEXT NOT NULL,
    nick TEXT NOT NULL,
    owner_only INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel, nick)
  );
  CREATE TABLE IF NOT EXISTS public_author_evidence (
    account_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    msgid TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, channel)
  );
  CREATE TABLE IF NOT EXISTS direct_conversations (
    channel TEXT PRIMARY KEY,
    first_nick TEXT NOT NULL,
    second_nick TEXT NOT NULL,
    provision_ready INTEGER,
    UNIQUE(first_nick, second_nick)
  );
  CREATE TABLE IF NOT EXISTS closed_direct_conversations (
    account_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    PRIMARY KEY(account_id, channel)
  );
  CREATE TABLE IF NOT EXISTS invites (
    token_hash TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admissions (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    application_revision INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    approved_email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','redeeming','redeemed','cancelled')),
    delivery_state TEXT NOT NULL CHECK (delivery_state IN ('sending','sent','failed','uncertain','cancelled')),
    delivery_error TEXT,
    claim_hash TEXT,
    claim_name TEXT,
    reserved_account_id TEXT UNIQUE,
    reserved_nick TEXT COLLATE NOCASE UNIQUE,
    redeemed_account_id TEXT,
    redeemed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS admissions_active_application ON admissions(application_id) WHERE state <> 'cancelled';
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    nick TEXT NOT NULL,
    channel TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    width INTEGER,
    height INTEGER
  );
  CREATE TABLE IF NOT EXISTS notification_prefs (
    nick TEXT PRIMARY KEY,
    preference TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS custom_emoji (
    name TEXT PRIMARY KEY,
    upload_id TEXT NOT NULL,
    added_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pair_requests (
    code TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    machine TEXT NOT NULL,
    tool TEXT NOT NULL,
    browser TEXT,
    os TEXT,
    ip TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    password TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pair_offers (
    token_hash TEXT PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    nick TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    redeemed_session TEXT,
    browser TEXT,
    os TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_connect_requests (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    secret_hash TEXT NOT NULL UNIQUE,
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_file TEXT NOT NULL,
    session_name TEXT NOT NULL,
    repo TEXT,
    model TEXT,
    provider TEXT,
    machine TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decision TEXT CHECK (decision IN ('allow','deny')),
    binding_id TEXT
  );
  CREATE TABLE IF NOT EXISTS agent_session_bindings (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    owner_account_id TEXT NOT NULL,
    owner_nick TEXT NOT NULL,
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_file TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
    dm TEXT,
    status TEXT NOT NULL CHECK (status IN ('provisioning','ready','revoked')),
    machine TEXT NOT NULL,
    session_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attached_at INTEGER,
    lease_id TEXT,
    lease_nonce TEXT,
    lease_expires_at INTEGER,
    intro_state TEXT NOT NULL DEFAULT 'pending',
    intro_cid TEXT,
    intro_msgid TEXT,
    intro_text TEXT,
    UNIQUE(instance_id, owner_account_id, harness, session_id)
  );
  CREATE TABLE IF NOT EXISTS agent_session_requests (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES agent_session_bindings(id),
    source_channel TEXT NOT NULL,
    reply_channel TEXT NOT NULL,
    original_msgid TEXT NOT NULL,
    current_msgid TEXT NOT NULL,
    author_account_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    text TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    lease_id TEXT,
    confirm_revision INTEGER,
    reply_text TEXT,
    reply_cid TEXT,
    reply_msgid TEXT,
    reply_line_count INTEGER NOT NULL DEFAULT 0,
    reply_echo_count INTEGER NOT NULL DEFAULT 0,
    reply_echo_msgids TEXT NOT NULL DEFAULT '[]',
    reply_batch TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(binding_id, source_channel, original_msgid)
  );
  CREATE TABLE IF NOT EXISTS irc_devices (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS irc_certificates (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    label TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(account, fingerprint)
  );
`);
// Cache scope survives sign-in and nick changes, but not deletion/recreation of an account.
// Keep inserts from older app versions working during the additive-schema overlap.
if (!(db.query("PRAGMA table_info(accounts)").all() as { name: string }[]).some((column) => column.name === "account_id")) {
  db.exec("ALTER TABLE accounts ADD COLUMN account_id TEXT");
}
db.exec(`
  UPDATE accounts SET account_id = lower(hex(randomblob(16))) WHERE account_id IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_id ON accounts(account_id);
  CREATE TRIGGER IF NOT EXISTS accounts_assign_id AFTER INSERT ON accounts
  WHEN NEW.account_id IS NULL BEGIN
    UPDATE accounts SET account_id = lower(hex(randomblob(16))) WHERE nick = NEW.nick;
  END;
`);
try { db.exec("ALTER TABLE accounts ADD COLUMN provisional_expires_at INTEGER"); } catch {}
// IRC passwords are derived from account_id and this counter (irc-key.ts); NULL counts as 0.
try { db.exec("ALTER TABLE accounts ADD COLUMN irc_password_gen INTEGER"); } catch {}
// Set by the deploy A migration for people whose plain IRC clients or managed bots need the new password:
// 1 = their own clients, 2 = bots they own. Cleared by a new password or by dismissing the note.
try { db.exec("ALTER TABLE accounts ADD COLUMN irc_reset_notice INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE accounts ADD COLUMN theme TEXT"); } catch {}
// Pixel size of a stored photo, known after the WebP re-encode. The transcript reserves the
// picture's box from it before the bytes arrive, so a channel of photos does not jump.
try { db.exec("ALTER TABLE uploads ADD COLUMN width INTEGER"); } catch {}
try { db.exec("ALTER TABLE uploads ADD COLUMN height INTEGER"); } catch {}
// Set when an admin removes a person. The row stays so their nick, name and past messages keep
// resolving, and so the same email cannot sign up again. Undo: clear it, restore verified_at, and
// run NS SUSPEND DEL <nick> as the oper.
try { db.exec("ALTER TABLE accounts ADD COLUMN removed_at INTEGER"); } catch {}
// Settings > G'day greeting. 0 shows the daily greeting and notifies; 1 hides it for this person only.
try { db.exec("ALTER TABLE accounts ADD COLUMN hide_greeting INTEGER NOT NULL DEFAULT 0"); } catch {}
// 1 once the one-time note under the first greeting has shown on any device.
try { db.exec("ALTER TABLE accounts ADD COLUMN greeting_note_seen INTEGER NOT NULL DEFAULT 0"); } catch {}
// Bumped on every new photo so /avatars/<nick>?v=<version> can be cached for good.
try { db.exec("ALTER TABLE profiles ADD COLUMN avatar_version INTEGER"); } catch {}
// NULL is legacy/unverified, 0 is a reservation, 1 follows confirmed Ergo provisioning.
// Never backfill readiness from the mapping alone.
try { db.exec("ALTER TABLE direct_conversations ADD COLUMN provision_ready INTEGER"); } catch {}
// Session-bound agents are additive; legacy connect records stay readable but cannot authorize bindings.
// Codes minted by Slirc (slirc-agent 2.x) are gone; sessions now ask and the owner allows.
db.exec("DROP TABLE IF EXISTS agent_connect_codes");
try { db.exec("ALTER TABLE agent_session_bindings ADD COLUMN agent_account_id TEXT"); } catch {}
// 1 when the reserved identity is a new account (its password derives from reserved_account_id at
// counter 0), 0 when it is an existing one. Replaced reserved_password.
try { db.exec("ALTER TABLE admissions ADD COLUMN reserved_new_account INTEGER"); } catch {}
// Deploy B: the stored IRC passwords go. A row deploy A's migration (irc-migration.ts) has not
// moved would lose its only working password, so the columns drop only once none is left.
// migrate-founder.ts runs that migration on boot for databases that skipped deploy A (dev stacks);
// it sets SLIRC_IRC_MIGRATION so this import does not refuse first. Every other process refuses.
export function dropStoredIrcPasswords(): number {
  const has = (table: string, column: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((item) => item.name === column);
  const stored = [
    has("accounts", "irc_password") ? ["accounts", "irc_password", "irc_password_gen IS NULL AND COALESCE(irc_password, '') <> ''"] : null,
    has("agent_session_bindings", "irc_password") ? ["agent_session_bindings", "irc_password", "irc_password <> ''"] : null,
    has("admissions", "reserved_password") ? ["admissions", "reserved_password", "reserved_password IS NOT NULL"] : null,
  ].filter(Boolean) as [string, string, string][];
  const left = stored.reduce((sum, [table, , where]) => sum + (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n, 0);
  if (!left) for (const [table, column] of stored) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  return left;
}
export const hasStoredIrcPasswordColumns = () => (db.query("PRAGMA table_info(accounts)").all() as { name: string }[]).some((item) => item.name === "irc_password");
{
  const left = dropStoredIrcPasswords();
  if (left && !process.env.SLIRC_IRC_MIGRATION) throw new Error(`${left} rows still hold a stored IRC password; run bun src/migrate-founder.ts once (it moves them) before starting the app`);
}
try { db.exec("ALTER TABLE agent_session_requests ADD COLUMN reply_line_count INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE agent_session_requests ADD COLUMN reply_echo_count INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE agent_session_requests ADD COLUMN reply_echo_msgids TEXT NOT NULL DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE agent_session_requests ADD COLUMN reply_batch TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_session_requests ADD COLUMN started_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE agent_session_bindings ADD COLUMN intro_text TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_session_bindings ADD COLUMN intro_cid TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_session_bindings ADD COLUMN intro_msgid TEXT"); } catch {}
// Display metadata the adapter reports: repo folder name and current model, never a full path.
try { db.exec("ALTER TABLE agent_session_bindings ADD COLUMN repo TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_session_bindings ADD COLUMN model TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_session_bindings ADD COLUMN provider TEXT"); } catch {}
// Epoch ms when an attached session went away and its offline notice is still owed. Persisted so a restart keeps it.
try { db.exec("ALTER TABLE agent_session_bindings ADD COLUMN away_since INTEGER"); } catch {}
// An owner rename the adapter has not applied yet; NULL when there is none.
try { db.exec("ALTER TABLE agent_session_bindings ADD COLUMN rename_pending TEXT"); } catch {}
// An agent attached to an open/workspace channel is owner-only: only its owner's messages wake it.
// Secret-room grants keep 0 and their existing private-mode proof.
try { db.exec("ALTER TABLE channel_members ADD COLUMN owner_only INTEGER NOT NULL DEFAULT 0"); } catch {}
// When the owner allowed this session in Slirc. NULL is a pending pairing, never provisioned.
// Bindings made before owner confirmation existed count as allowed when they were created.
try {
  db.exec("ALTER TABLE agent_session_bindings ADD COLUMN confirmed_at INTEGER");
  db.exec("UPDATE agent_session_bindings SET confirmed_at = created_at");
} catch {}

// Sign-in codes ride the same row as the link they were mailed with.
try { db.exec("ALTER TABLE magic_links ADD COLUMN code_hash TEXT"); } catch {}
try { db.exec("ALTER TABLE magic_links ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"); } catch {}
// Invite backfill resolves verified human identities before the older additive account migrations below.
try { db.exec("ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'"); } catch {}
// Email invitations ride on the same invite rows as copied links; these columns
// are set only when one was mailed to an address.
try { db.exec("ALTER TABLE invites ADD COLUMN email TEXT"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN sent_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN accepted_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN accepted_by TEXT"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN sends INTEGER NOT NULL DEFAULT 0"); } catch {}
// Preserve reusable channel links while allowing explicit DM destinations with NULL channel.
if ((db.query("PRAGMA table_info(invites)").all() as { name: string; notnull: number }[]).some((column) => column.name === "channel" && column.notnull)) {
  db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS invites_migration");
    db.exec(`CREATE TABLE invites_migration (
      token_hash TEXT PRIMARY KEY, channel TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      email TEXT, sent_at INTEGER, accepted_at INTEGER, accepted_by TEXT, sends INTEGER NOT NULL DEFAULT 0
    )`);
    db.query(`INSERT INTO invites_migration SELECT token_hash, channel, created_by, created_at, email, sent_at, accepted_at, accepted_by, sends FROM invites`).run();
    db.exec("DROP TABLE invites; ALTER TABLE invites_migration RENAME TO invites;");
  })();
}
try { db.exec("ALTER TABLE invites ADD COLUMN destination_type TEXT NOT NULL DEFAULT 'channel'"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN inviter_account_id TEXT"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN recipient_account_id TEXT"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN expires_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN cancelled_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN invitation_id TEXT"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'sent'"); } catch {}
try { db.exec("ALTER TABLE invites ADD COLUMN resend_claim TEXT"); } catch {}
try { db.exec("ALTER TABLE conversation_operations ADD COLUMN response_status INTEGER NOT NULL DEFAULT 200"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS invites_invitation_id ON invites(invitation_id) WHERE invitation_id IS NOT NULL"); } catch {}
db.exec(`UPDATE invites SET
  invitation_id = COALESCE(invitation_id, lower(hex(randomblob(16)))),
  inviter_account_id = COALESCE(inviter_account_id, (SELECT account_id FROM accounts WHERE nick = invites.created_by COLLATE NOCASE)),
  recipient_account_id = COALESCE(recipient_account_id, (SELECT account_id FROM accounts WHERE email = invites.email COLLATE NOCASE AND verified_at IS NOT NULL AND kind = 'human')),
  expires_at = COALESCE(expires_at, created_at + 604800000)
WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS email_invite_quota (
  account_id TEXT PRIMARY KEY, sent INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0
);
INSERT INTO email_invite_quota (account_id, sent)
  SELECT a.account_id, COALESCE(SUM(i.sends), 0) FROM accounts a
  LEFT JOIN invites i ON i.created_by = a.nick COLLATE NOCASE AND i.email IS NOT NULL
  GROUP BY a.account_id ON CONFLICT(account_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS conversation_operations (
  account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  state TEXT NOT NULL, response_json TEXT, response_status INTEGER NOT NULL DEFAULT 200,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, idempotency_key)
);
`);
try { db.exec("ALTER TABLE channels ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("DROP TABLE IF EXISTS email_changes"); } catch {}
try { db.exec("DROP TABLE IF EXISTS reactions"); } catch {}
try { db.exec("ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'"); } catch {}
try { db.exec("ALTER TABLE accounts ADD COLUMN owner TEXT"); } catch {}
try { db.exec("ALTER TABLE accounts ADD COLUMN machine TEXT"); } catch {}
// Session agents once stored their harness as the machine; take the host name from the binding.
try { db.exec("UPDATE accounts SET machine = (SELECT b.machine FROM agent_session_bindings b WHERE b.nick = accounts.nick COLLATE NOCASE ORDER BY b.created_at DESC LIMIT 1) WHERE kind = 'agent' AND machine IN (SELECT harness FROM agent_session_bindings b WHERE b.nick = accounts.nick COLLATE NOCASE)"); } catch {}
try { db.exec("ALTER TABLE sessions ADD COLUMN device TEXT NOT NULL DEFAULT 'Unknown device'"); } catch {}
try { db.exec("ALTER TABLE client_tokens ADD COLUMN expires_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE profiles ADD COLUMN badge TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE admissions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1"); } catch {}
try { db.exec("ALTER TABLE pair_requests ADD COLUMN browser TEXT"); } catch {}
try { db.exec("ALTER TABLE pair_requests ADD COLUMN os TEXT"); } catch {}
try { db.exec("ALTER TABLE channels ADD COLUMN topic TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE help_answer_cache ADD COLUMN model INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE help_answer_cache ADD COLUMN model_name TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE help_answer_cache ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE help_answer_cache ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE help_answer_cache ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0"); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS reply_threads (
    root_msgid TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    root_author TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS reply_threads_channel ON reply_threads (channel);
  CREATE TABLE IF NOT EXISTS reply_thread_msgs (
    msgid TEXT PRIMARY KEY,
    root_msgid TEXT NOT NULL,
    nick TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reply_thread_msgs_root ON reply_thread_msgs (root_msgid, at);
  CREATE TABLE IF NOT EXISTS reply_thread_people (
    root_msgid TEXT NOT NULL,
    nick TEXT NOT NULL,
    PRIMARY KEY (root_msgid, nick)
  );
  CREATE INDEX IF NOT EXISTS reply_thread_people_nick ON reply_thread_people (nick);
`);
// Threads mirror their parent here. IRC history gets an ordinary quoted seed after the child channel JOINs.
db.exec(`CREATE TABLE IF NOT EXISTS threads (
  channel TEXT PRIMARY KEY,
  parent TEXT NOT NULL,
  root TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  root_nick TEXT NOT NULL DEFAULT '',
  root_text TEXT NOT NULL DEFAULT '',
  root_time TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL
)`);
try { db.exec("ALTER TABLE threads ADD COLUMN root_nick TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE threads ADD COLUMN root_text TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE threads ADD COLUMN root_time TEXT NOT NULL DEFAULT ''"); } catch {}
// Room helpers (@remind) keep their schedule here; delivery is one message in the channel where it was asked.
// Delivery withholds an unconfirmed attempt rather than resending it: state persists a stable CID, a
// frozen target/body and a sending claim before the socket write, and settles only on a validated self
// echo or matching history (see reminders.ts). It is not at-least-once.
// The schema detection, additive columns and old-row classification share one transaction. A crash or
// backfill failure rolls the whole reminder upgrade back, so the next boot retries instead of seeing a
// state column and assuming an upgrade that never ran.
db.transaction(() => {
  // A database created before this state machine lacks `state`. A past-due, unstamped row from the old
  // loop may already have been sent, so its one-time upgrade marks it uncertain instead of resending it.
  const reminderHadState = (db.query("PRAGMA table_info(reminders)").all() as { name: string }[]).some((column) => column.name === "state");
  db.exec(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nick TEXT NOT NULL,
    channel TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    state TEXT NOT NULL DEFAULT 'pending',
    cid TEXT,
    target TEXT,
    body TEXT,
    attempt_at INTEGER,
    msgid TEXT,
    server_time TEXT,
    acked_at INTEGER
  )`);
  // Additive columns. A duplicate-column error is expected on every later boot and is caught here;
  // only the classification below is allowed to abort the transaction.
  try { db.exec("ALTER TABLE reminders ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'"); } catch {}
  try { db.exec("ALTER TABLE reminders ADD COLUMN cid TEXT"); } catch {}
  try { db.exec("ALTER TABLE reminders ADD COLUMN target TEXT"); } catch {}
  try { db.exec("ALTER TABLE reminders ADD COLUMN body TEXT"); } catch {}
  try { db.exec("ALTER TABLE reminders ADD COLUMN attempt_at INTEGER"); } catch {}
  try { db.exec("ALTER TABLE reminders ADD COLUMN msgid TEXT"); } catch {}
  try { db.exec("ALTER TABLE reminders ADD COLUMN server_time TEXT"); } catch {}
  try { db.exec("ALTER TABLE reminders ADD COLUMN acked_at INTEGER"); } catch {}
  // Evidence for the one automatic resend of an uncertain attempt (helper-bot.ts mayAutoResend).
  try { db.exec("ALTER TABLE reminders ADD COLUMN ergo_started TEXT"); } catch {}
  try { db.exec("ALTER TABLE reminders ADD COLUMN attempt_conn TEXT"); } catch {}
  try { db.exec("ALTER TABLE reminders ADD COLUMN resent_at INTEGER"); } catch {}
  if (!reminderHadState) {
    // One-time upgrade only. A stamped row is delivered; a past-due unstamped row is uncertain because
    // the old loop may have sent it; a future row is still safely pending. No CID is fabricated.
    const upgradedAt = Date.now();
    db.query("UPDATE reminders SET state='delivered' WHERE delivered_at IS NOT NULL").run();
    db.query("UPDATE reminders SET state='uncertain' WHERE delivered_at IS NULL AND fire_at <= ?").run(upgradedAt);
    db.query("UPDATE reminders SET state='pending' WHERE delivered_at IS NULL AND fire_at > ?").run(upgradedAt);
  }
})();
// Room polls (@poll): one open poll per channel. Options are a JSON array; multi allows several picks per account.
db.exec(`CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  creator TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  named INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  closes_at INTEGER,
  closed_at INTEGER
)`);
// One row per picked option: a poll with multiple answers holds several rows per account.
db.exec(`CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id INTEGER NOT NULL,
  nick TEXT NOT NULL COLLATE NOCASE,
  option INTEGER NOT NULL,
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, nick, option)
)`);
try { db.exec("ALTER TABLE polls ADD COLUMN multi INTEGER NOT NULL DEFAULT 0"); } catch {}
// Tables made before multiple answers keyed votes by (poll_id, nick); rebuild them with the option in the key.
if ((db.query("SELECT COUNT(*) AS n FROM pragma_table_info('poll_votes') WHERE pk > 0").get() as { n: number }).n === 2) {
  db.transaction(() => {
    db.exec("ALTER TABLE poll_votes RENAME TO poll_votes_old");
    db.exec(`CREATE TABLE poll_votes (
      poll_id INTEGER NOT NULL,
      nick TEXT NOT NULL COLLATE NOCASE,
      option INTEGER NOT NULL,
      voted_at INTEGER NOT NULL,
      PRIMARY KEY (poll_id, nick, option)
    )`);
    db.exec("INSERT INTO poll_votes SELECT poll_id, nick, option, voted_at FROM poll_votes_old");
    db.exec("DROP TABLE poll_votes_old");
  })();
}
// A helper added from the inline prompt answers the message that mentioned it. One row per helper
// and msgid; handled_at is stamped before the answer, so it never runs twice.
db.exec(`CREATE TABLE IF NOT EXISTS helper_catchups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  helper TEXT NOT NULL,
  channel TEXT NOT NULL,
  msgid TEXT NOT NULL,
  inviter TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  handled_at INTEGER,
  UNIQUE (helper, msgid)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS help_answer_cache (
  question TEXT NOT NULL,
  docs_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  model INTEGER NOT NULL DEFAULT 0,
  model_name TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (question, docs_version)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS help_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  cached INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);
// Founder welcome: opt-in is per immutable founder account id, jobs are one per recipient and
// survive restarts until the founder's own browser delivers them. See founder-welcome.ts.
db.exec(`CREATE TABLE IF NOT EXISTS founder_welcome_optin (
  founder_account_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS founder_welcome_jobs (
  id TEXT PRIMARY KEY,
  founder_account_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  recipient_nick TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  claim_id TEXT,
  delivered_msgid TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
// One job per recipient, ever: a person verifies once, so a repeat enqueue is a no-op.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS founder_welcome_jobs_recipient ON founder_welcome_jobs(recipient_account_id)`);

// Notes: a private scratchpad per immutable account id. App-only: never sent over IRC, never shown
// to another account. See notes.ts.
db.exec(`CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS notes_account ON notes(account_id, created_at)`);

// OSS project channels: one Slirc channel per GitHub repository, fed by that repository's
// webhooks. The secret is stored once and only returned when the binding is created.
db.exec(`CREATE TABLE IF NOT EXISTS project_repos (
  channel TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  creator_nick TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS project_repos_repo ON project_repos(lower(repo_owner), lower(repo_name))`);

type VapidKeys = { publicKey: string; privateKey: string };

export function vapidKeys(): VapidKeys {
  const row = db.query("SELECT value FROM meta WHERE key = 'vapid'").get() as { value: string } | null;
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  db.query("INSERT INTO meta (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  return keys;
}
