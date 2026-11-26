import { db } from "./db.ts";
import { DAY, SECOND, UNIT, spanMs } from "../shared/duration.ts";
export { parseDuration } from "../shared/duration.ts";

// Each account carries the IANA zone its browser reports, so "tomorrow 9:00" and the confirmation
// use the asker's clock. Accounts without one fall back to the instance default.
try { db.exec("ALTER TABLE accounts ADD COLUMN time_zone TEXT"); } catch {}

export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; }
}

export function defaultTimeZone(): string {
  const zone = process.env.TZ;
  return validTimeZone(zone) ? zone : "UTC";
}

export function userTimeZone(nick: string): string {
  const row = db.query("SELECT time_zone FROM accounts WHERE nick = ? COLLATE NOCASE").get(nick) as { time_zone: string | null } | null;
  return validTimeZone(row?.time_zone) ? row!.time_zone! : defaultTimeZone();
}

export function setUserTimeZone(accountId: string, zone: string): boolean {
  if (!validTimeZone(zone)) return false;
  return db.query("UPDATE accounts SET time_zone = ? WHERE account_id = ?").run(zone, accountId).changes > 0;
}

// Wall-clock parts of an instant in a zone, and the instant for wall-clock parts in a zone.
function zonedParts(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    .formatToParts(ms).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

function zonedTime(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, zone);
    guess += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return guess;
}

export type NewReminder = { fireAt: number; text: string };

// "in 20m", "in 2 hours", "in 1 year", and the same without "in" ("1min stretch")
// A marked clock time at the start of `input`: "14:30", "9am", "at 9". A bare number is not a time.
function clock(input: string): { hours: number; minutes: number; rest: string } | null {
  const match = input.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?=\s|$)\s*(.*)$/i);
  if (!match || !(match[2] || match[3] || /^at\s/i.test(input))) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = (match[3] || "").toLowerCase();
  if (hours > 23 || minutes > 59) return null;
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return { hours, minutes, rest: match[4] };
}

// "in 3 days 14:30 dentist": a day or year span followed by a clock time lands at that time that day.
function relative(input: string, now: number, zone: string): NewReminder | null {
  const match = input.match(new RegExp(`^(?:in\\s+)?(\\d{1,4})\\s*(${UNIT})\\b\\s*(.*)$`, "i"));
  if (!match) return null;
  const fireAt = now + Number(match[1]) * spanMs(match[2]);
  const at = /^[dy]/i.test(match[2]) ? clock(match[3]) : null;
  if (!at) return { fireAt, text: match[3].trim() };
  const day = zonedParts(fireAt, zone);
  return { fireAt: zonedTime(day.year, day.month, day.day, at.hours, at.minutes, zone), text: at.rest.trim() };
}

// "of this message in 1 year": the same span, said after the text instead of before it.
function trailing(input: string, now: number): NewReminder | null {
  const match = input.match(new RegExp(`^(.+?)\\s+in\\s+(\\d{1,4})\\s*(${UNIT})\\b\\s*$`, "i"));
  if (!match) return null;
  return { fireAt: now + Number(match[2]) * spanMs(match[3]), text: match[1].trim() };
}

// "at 9:30", "tomorrow 9", "18:45". A bare number is not a time: "5 apples" stays ambiguous.
function absolute(input: string, now: number, zone: string): NewReminder | null {
  const match = input.match(/^(?:(today|tomorrow)\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(.*)$/i);
  if (!match) return null;
  const marked = Boolean(match[1] || match[3] || match[4]) || /^at\s/i.test(input);
  if (!marked) return null;
  let hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  const meridiem = (match[4] || "").toLowerCase();
  if (hours > 23 || minutes > 59) return null;
  if (meridiem === "pm" && hours < 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  const today = zonedParts(now, zone);
  let fireAt = zonedTime(today.year, today.month, today.day, hours, minutes, zone);
  if ((match[1] || "").toLowerCase() === "tomorrow" || fireAt <= now) fireAt = zonedTime(today.year, today.month, today.day + 1, hours, minutes, zone);
  return { fireAt, text: match[5].trim() };
}

export function parseReminder(input: string, now = Date.now(), zone = defaultTimeZone()): NewReminder | null {
  const text = input.trim();
  if (!text) return null;
  return relative(text, now, zone) || trailing(text, now) || absolute(text, now, zone);
}

export function describeWhen(fireAt: number, now = Date.now()): string {
  const seconds = Math.max(1, Math.round((fireAt - now) / SECOND));
  if (seconds < 60) return `in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  if (days >= 365) return `in ${Math.round(days / 365)} ${Math.round(days / 365) === 1 ? "year" : "years"}`;
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

// Clock time in the asker's zone plus the day relative to today: 0 today, 1 tomorrow.
function dayAndClock(fireAt: number, zone: string, now: number) {
  const at = zonedParts(fireAt, zone);
  const today = zonedParts(now, zone);
  const days = Math.round((Date.UTC(at.year, at.month - 1, at.day) - Date.UTC(today.year, today.month - 1, today.day)) / DAY);
  const clock = `${at.hour}:${String(at.minute).padStart(2, "0")}`;
  const date = days < 2 ? "" : new Date(fireAt).toLocaleDateString("en-GB", days < 7
    ? { timeZone: zone, weekday: "long" }
    : { timeZone: zone, day: "numeric", month: "short", ...(at.year === today.year ? {} : { year: "numeric" }) });
  return { days, clock, date };
}

// For the list: a friendly relative plus the clock time in the asker's zone, "Tomorrow at 9:00".
export function describeListWhen(fireAt: number, zone = defaultTimeZone(), now = Date.now()): string {
  const { days, clock, date } = dayAndClock(fireAt, zone, now);
  if (fireAt <= now) return `Due at ${clock}`;
  const when = describeWhen(fireAt, now);
  if (days === 0) return `${when[0].toUpperCase()}${when.slice(1)}, ${clock}`;
  if (days === 1) return `Tomorrow at ${clock}`;
  return `${date} at ${clock}`;
}

const SOON_MS = 12 * 60 * 60_000;

// For the confirmation: "at 12:22 (in 1 minute)", "tomorrow at 9:00", "Friday at 9:00", "3 Nov at 9:00".
export function describeSetWhen(fireAt: number, zone = defaultTimeZone(), now = Date.now()): string {
  const { days, clock, date } = dayAndClock(fireAt, zone, now);
  if (days <= 0) return `at ${clock} (${describeWhen(fireAt, now)})`;
  // Past midnight but soon keeps the relative part: "tomorrow at 0:12 (in 20 minutes)".
  if (days === 1) return fireAt - now < SOON_MS ? `tomorrow at ${clock} (${describeWhen(fireAt, now)})` : `tomorrow at ${clock}`;
  return `${date} at ${clock}`;
}

export type ReminderState = "pending" | "sending" | "uncertain" | "delivered" | "cancelled";

export type Row = {
  id: number; nick: string; channel: string; fire_at: number; text: string;
  state: ReminderState; cid: string | null; target: string | null; body: string | null;
  attempt_at: number | null; delivered_at: number | null; msgid: string | null; server_time: string | null;
  ergo_started: string | null; attempt_conn: string | null; resent_at: number | null;
};

const COLUMNS = "id, nick, channel, fire_at, text, state, cid, target, body, attempt_at, delivered_at, msgid, server_time, ergo_started, attempt_conn, resent_at";

export function addReminder(nick: string, channel: string, fireAt: number, text: string): number {
  const result = db.query("INSERT INTO reminders (nick, channel, fire_at, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(nick, channel, fireAt, text, Date.now());
  return Number(result.lastInsertRowid);
}

// Everything the owner still has open: pending, in-flight and uncertain. Cancelled and delivered are hidden.
export function pendingReminders(nick: string): Row[] {
  return db.query(`SELECT ${COLUMNS} FROM reminders WHERE nick = ? COLLATE NOCASE AND delivered_at IS NULL AND state <> 'cancelled' ORDER BY fire_at`).all(nick) as Row[];
}

// Only a row that was never claimed may be dispatched. A sending/uncertain row never re-enters this set.
export function dueReminders(now = Date.now()): Row[] {
  return db.query(`SELECT ${COLUMNS} FROM reminders WHERE state = 'pending' AND delivered_at IS NULL AND fire_at <= ? ORDER BY fire_at`).all(now) as Row[];
}

// In-flight or uncertain rows: a previous process may already have written them. Reconciliation only.
export function unresolvedReminders(): Row[] {
  return db.query(`SELECT ${COLUMNS} FROM reminders WHERE state IN ('sending','uncertain') AND delivered_at IS NULL ORDER BY fire_at`).all() as Row[];
}

export function reminderByCid(cid: string): Row | null {
  return db.query(`SELECT ${COLUMNS} FROM reminders WHERE cid = ?`).get(cid) as Row | null;
}

// Persist the frozen CID, target and exact body, and move pending -> sending in one guarded write, so
// two timer ticks cannot both claim the same row. False means another tick already owns it. Ergo's
// start time and the helper connection are kept as evidence for a later automatic resend.
export function claimReminder(id: number, cid: string, target: string, body: string, ergoStarted: string | null = null, conn: string | null = null): boolean {
  const result = db.query(`UPDATE reminders SET state='sending', cid=?, target=?, body=?, attempt_at=?, ergo_started=?, attempt_conn=?
    WHERE id=? AND state='pending' AND delivered_at IS NULL`).run(cid, target, body, Date.now(), ergoStarted, conn, id);
  return result.changes > 0;
}

// The one automatic resend of an uncertain row, with its frozen CID and body. False means it was
// already resent once, settled, cancelled or claimed elsewhere.
export function claimAutoResend(id: number, ergoStarted: string, conn: string): boolean {
  const now = Date.now();
  return db.query(`UPDATE reminders SET state='sending', attempt_at=?, ergo_started=?, attempt_conn=?, resent_at=?
    WHERE id=? AND state='uncertain' AND resent_at IS NULL AND delivered_at IS NULL`).run(now, ergoStarted, conn, now, id).changes > 0;
}

// The owner's Send again: an uncertain row goes back to pending with no frozen attempt, so the next
// tick sends it under a new CID. The owner accepted that it may arrive twice.
export function retryReminder(nick: string, id: number): boolean {
  return db.query(`UPDATE reminders SET state='pending', cid=NULL, target=NULL, body=NULL, attempt_at=NULL, ergo_started=NULL, attempt_conn=NULL, resent_at=NULL
    WHERE id=? AND nick=? COLLATE NOCASE AND state='uncertain' AND delivered_at IS NULL`).run(id, nick).changes > 0;
}

// A proven pre-write refusal (dead socket) returns the row to pending so a later tick can retry.
export function releaseReminder(id: number): void {
  db.query("UPDATE reminders SET state='pending', cid=NULL, target=NULL, body=NULL, attempt_at=NULL WHERE id=? AND state='sending'").run(id);
}

// No positive acknowledgement means a 'sending' row from a previous process could have been written or
// not. Expose it as uncertain; only the helper's three-part proof may resend it. Called once per helper connection.
export function markSendingUncertain(): number {
  return db.query("UPDATE reminders SET state='uncertain' WHERE state='sending'").run().changes;
}

// A live send whose echo never arrived is also unknowable; age it into the same uncertain state so the
// owner sees it and reconciliation runs. Age alone never allows a resend.
export function markStaleSendingUncertain(cutoff: number): number {
  return db.query("UPDATE reminders SET state='uncertain' WHERE state='sending' AND attempt_at IS NOT NULL AND attempt_at <= ?").run(cutoff).changes;
}

// Positive settlement. Only a validated self echo or matching history reaches here. A late echo also
// settles a cancelled attempt: the message did go out even though the owner stopped tracking it.
export function settleReminder(id: number, msgid: string, serverTime: string): boolean {
  const now = Date.now();
  const result = db.query(`UPDATE reminders SET state='delivered', delivered_at=?, msgid=?, server_time=?, acked_at=?
    WHERE id=? AND delivered_at IS NULL AND state IN ('sending','uncertain','cancelled')`).run(now, msgid, serverTime, now, id);
  return result.changes > 0;
}

export function cancelReminder(nick: string, id: number): boolean {
  const row = db.query("SELECT state FROM reminders WHERE id = ? AND nick = ? COLLATE NOCASE AND delivered_at IS NULL").get(id, nick) as { state: ReminderState } | null;
  if (!row || row.state === "cancelled") return false;
  if (row.state === "pending") {
    // Never written, so deleting it cannot race a send.
    db.query("DELETE FROM reminders WHERE id = ?").run(id);
  } else {
    // A possible write already happened: keep the frozen CID/body for a late echo and stop retries.
    db.query("UPDATE reminders SET state='cancelled' WHERE id = ? AND state IN ('sending','uncertain')").run(id);
  }
  return true;
}

// A validated acknowledgement: our stable CID, the frozen target and exact body, and an authenticated
// account tag naming the helper. A prefix nick alone is not identity, so absent tags never confirm.
export function reminderAckMatches(row: Row, message: { command: string; params: string[]; tags: Record<string, string>; prefix?: string }, helper: string): boolean {
  if (message.command !== "PRIVMSG") return false;
  if (!row.cid || (message.tags["+slirc/cid"] || "") !== row.cid) return false;
  if ((message.params[0] || "").toLowerCase() !== (row.target || "").toLowerCase()) return false;
  if ((message.params[1] || "") !== row.body) return false;
  const account = (message.tags.account || "").toLowerCase();
  if (!account || account !== helper.toLowerCase()) return false;
  const nick = (message.prefix?.split("!", 1)[0] || "").toLowerCase();
  return nick === helper.toLowerCase();
}
