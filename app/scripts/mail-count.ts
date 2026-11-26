// Mail this app handed to Resend, by UTC day and kind: today, the last 7 days and the month so far.
// Read-only. Inside the app container: podman exec -w /app <app-container> bun scripts/mail-count.ts
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const path = process.env.DB_PATH || "/data/chat.sqlite";
if (!existsSync(path)) { console.error(`no database at ${path}`); process.exit(1); }
const db = new Database(path, { readonly: true });
const hasTable = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mail_counts'").get();
type Row = { kind: string; sent: number; failed: number };

const now = new Date();
const day = (date: Date) => date.toISOString().slice(0, 10);
const today = day(now);
const weekStart = day(new Date(now.getTime() - 6 * 86_400_000));
const monthStart = `${today.slice(0, 7)}-01`;

function between(from: string, to: string): Row[] {
  if (!hasTable) return [];
  return db.query(`SELECT kind, SUM(CASE WHEN accepted = 1 THEN count ELSE 0 END) AS sent, SUM(CASE WHEN accepted = 0 THEN count ELSE 0 END) AS failed
                   FROM mail_counts WHERE day BETWEEN ? AND ? GROUP BY kind ORDER BY kind`).all(from, to) as Row[];
}

function print(label: string, rows: Row[]): void {
  const sent = rows.reduce((sum, row) => sum + row.sent, 0);
  const failed = rows.reduce((sum, row) => sum + row.failed, 0);
  console.log(`${label}: ${sent} sent${failed ? `, ${failed} refused` : ""}`);
  for (const row of rows) console.log(`  ${row.kind.padEnd(24)} ${String(row.sent).padStart(5)} sent${row.failed ? `, ${row.failed} refused` : ""}`);
}

const warn = Number(process.env.MAIL_DAILY_WARN) > 0 ? Number(process.env.MAIL_DAILY_WARN) : 80;
const limit = Number(process.env.MAIL_DAILY_LIMIT) > 0 ? Number(process.env.MAIL_DAILY_LIMIT) : 100;
console.log(`Mail handed to Resend (UTC days). Daily warning at ${warn}, limit ${limit}.`);
print(`Today ${today}`, between(today, today));
print(`Last 7 days ${weekStart} to ${today}`, between(weekStart, today));
print(`Month so far ${monthStart} to ${today}`, between(monthStart, today));
