import { accountByNick } from "./accounts.ts";
import { db } from "./db.ts";
import { helperSay } from "./helper-bot.ts";
import { configuredAppOrigin } from "./request-security.ts";

// First sign-in: the help bot opens a private DM that says what the place is and where things live.
// Copy describes only what ships in the online MVP; no dates in the agent placeholder, and no
// `/?screen=` links that the new router does not implement.
try { db.exec("ALTER TABLE accounts ADD COLUMN onboarded_at INTEGER"); } catch {}

const PENDING_PREFIX = "onboarding-pending:";

// The link is absolute so it is clickable in Slirc and in any IRC client. It comes from server
// config, never from a request header.
export function onboardingLines(nick: string): string[] {
  const origin = configuredAppOrigin();
  return [
    `Hi ${nick}, I'm help. Ask me anything about Slirc, any time.`,
    `Your first steps, plus a few things worth trying: ${new URL("/welcome", origin).href}`,
  ];
}

export function needsOnboarding(nick: string): boolean {
  const row = db.query("SELECT onboarded_at, kind FROM accounts WHERE nick = ? COLLATE NOCASE").get(nick) as { onboarded_at: number | null; kind: string } | null;
  return !!row && row.kind === "human" && !row.onboarded_at;
}

// The default destinations a first sign-in lands on when the person did not ask for a specific
// room, message, invite or Profile screen. Explicit destinations always win.
export function isDefaultReturn(next: string): boolean {
  return next === "/";
}

// First verification with a default return lands in the help DM once the DM really exists on Ergo.
// Existing users, explicit destinations, and a failed or disabled helper all keep the requested next.
export function onboardingDestination(next: string, firstVerification: boolean, provisioned: boolean): string {
  if (!firstVerification || !provisioned || !isDefaultReturn(next)) return next;
  return "/dm/help";
}

// The caller opens the pair channel first (openDirectConversation). The stamp is set only after
// helperSay has accepted the lines, so a sign-in is never marked done before the outbox sees them.
// A pending row survives a crash before the bot flushed: resumeOnboarding re-queues it on boot.
export function queueOnboarding(nick: string, channel: string): void {
  const key = PENDING_PREFIX + nick.toLowerCase();
  helperSay("help", channel, onboardingLines(nick), () => db.query("DELETE FROM meta WHERE key = ?").run(key));
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, channel.toLowerCase());
  db.query("UPDATE accounts SET onboarded_at = ? WHERE nick = ? COLLATE NOCASE").run(Date.now(), nick);
}

// A crash between queueing and the bot's send leaves the pending row; re-queue it on boot. A crash
// after the socket write but before the delete can resend the welcome, which is the honest side to
// err on: the outbox is in-memory and cannot prove exactly-once.
export function resumeOnboarding(): void {
  const rows = db.query("SELECT key, value FROM meta WHERE key LIKE ?").all(`${PENDING_PREFIX}%`) as { key: string; value: string }[];
  for (const row of rows) {
    const nick = row.key.slice(PENDING_PREFIX.length);
    if (accountByNick(nick)) helperSay("help", row.value, onboardingLines(nick), () => db.query("DELETE FROM meta WHERE key = ?").run(row.key));
    else db.query("DELETE FROM meta WHERE key = ?").run(row.key);
  }
}
