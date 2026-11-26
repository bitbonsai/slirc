import { db } from "./db.ts";

// How many mails this app hands to Resend, per UTC day and kind, so the free tier (about 100 a day)
// is not hit by surprise. Counts only: never an address, subject, token or link. A failed count
// never stops a mail.
db.exec(`CREATE TABLE IF NOT EXISTS mail_counts (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, accepted)
)`);

export type MailKind = "sign-in" | "invitation" | "invitation-verification" | "admission" | "other";

// Every send already carries an idempotency key that starts with what it is.
const PREFIXES: [string, MailKind][] = [["magic-link/", "sign-in"], ["invite-signup/", "invitation-verification"], ["invite/", "invitation"], ["admission/", "admission"]];
export function mailKind(idempotencyKey: unknown): MailKind {
  const key = typeof idempotencyKey === "string" ? idempotencyKey : "";
  return PREFIXES.find(([prefix]) => key.startsWith(prefix))?.[1] ?? "other";
}

// Defaults match Resend's free tier; an upgraded plan raises them.
const limit = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
export const mailWarnAt = () => limit("MAIL_DAILY_WARN", 80);
export const mailLimitAt = () => limit("MAIL_DAILY_LIMIT", 100);

export const mailDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// null when the count can't be read: callers that cap mail must then send none.
export function mailsSentToday(now = Date.now()): number | null {
  try {
    return (db.query("SELECT COALESCE(SUM(count), 0) AS total FROM mail_counts WHERE day = ? AND accepted = 1").get(mailDay(now)) as { total: number }).total;
  } catch { return null; }
}

// Bulk invitations stop at 75% of the daily limit, so sign-in links and the invitees' own
// sign-ups still have room that day.
export const bulkMailShare = 0.75;
export function bulkMailRoom(now = Date.now()): number {
  const sent = mailsSentToday(now);
  return sent === null ? 0 : Math.max(0, Math.floor(mailLimitAt() * bulkMailShare) - sent);
}

// New-address signups per UTC day. Each takes a slot before the account exists, and the slot plus
// every accepted mail count against MAIL_DAILY_LIMIT, so a failed send or a burst of concurrent
// signups cannot push past it. Conservative on purpose: a signup's own mail counts twice once sent.
db.exec("CREATE TABLE IF NOT EXISTS signup_counts (day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)");
export function reserveSignup(now = Date.now()): boolean {
  try {
    return db.transaction(() => {
      const day = mailDay(now);
      const sent = mailsSentToday(now);
      const signups = (db.query("SELECT count FROM signup_counts WHERE day = ?").get(day) as { count: number } | null)?.count ?? 0;
      if (sent === null || sent + signups >= mailLimitAt()) return false;
      db.query("INSERT INTO signup_counts (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1").run(day);
      return true;
    })();
  } catch { return false; }
}

export function recordMail(kind: MailKind, accepted: boolean, now = Date.now(), log: (line: string) => void = console.warn): void {
  try {
    const day = mailDay(now);
    db.query(`INSERT INTO mail_counts (day, kind, accepted, count) VALUES (?, ?, ?, 1)
              ON CONFLICT(day, kind, accepted) DO UPDATE SET count = count + 1`).run(day, kind, accepted ? 1 : 0);
    if (!accepted) return;
    // Each accepted mail adds one, so a threshold is crossed exactly when the total equals it.
    const total = (db.query("SELECT COALESCE(SUM(count), 0) AS total FROM mail_counts WHERE day = ? AND accepted = 1").get(day) as { total: number }).total;
    if (total === mailWarnAt()) log(`mail: ${total} sent today (${day} UTC), warning at ${mailWarnAt()}, limit ${mailLimitAt()}`);
    if (total === mailLimitAt()) log(`mail: ${total} sent today (${day} UTC), the daily limit of ${mailLimitAt()}`);
  } catch (error) {
    console.error("mail count failed:", error instanceof Error ? error.message : error);
  }
}

export type MailSender = { emails: { send: (payload: any, options?: any) => Promise<{ error?: unknown } & Record<string, any>> } };

// Wraps the one Resend client so every send is counted without touching the call sites, which only
// use emails.send.
export function countedMail<T extends MailSender>(client: T): { emails: { send: T["emails"]["send"] } } {
  return {
    emails: {
      send: (async (payload: any, options?: any) => {
        const kind = mailKind(options?.idempotencyKey);
        try {
          const result = await client.emails.send(payload, options);
          recordMail(kind, !result?.error);
          return result;
        } catch (error) {
          // A send that throws may still have reached Resend, so it counts against the limit.
          recordMail(kind, true);
          throw error;
        }
      }) as T["emails"]["send"],
    },
  };
}
