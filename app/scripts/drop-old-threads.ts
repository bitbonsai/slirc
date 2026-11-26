// One-off: delete the old #t- thread channels (the pre-reply-thread feature) on one instance.
//
//   podman exec <app> bun scripts/drop-old-threads.ts            dry run: prints counts, deletes nothing
//   podman exec <app> bun scripts/drop-old-threads.ts --apply    deletes
//
// Dry run opens SQLite read-only and never contacts Ergo. --apply, for each #t- channel the app
// knows (a threads row, or a channels row with no thread row), clears its Ergo history, unregisters
// it, then drops its app rows (members, channels, threads, uploads, reminders, polls and the like)
// in one transaction. Parent channels, DMs and the announcement lines in them are not touched.
// --apply needs the same env the app has (ERGO_OPER_PASS and so on).
import { Database } from "bun:sqlite";

const apply = process.argv.includes("--apply");
const path = process.env.DB_PATH || "/data/chat.sqlite";
const db = new Database(path, apply ? undefined : { readonly: true });

const THREAD = /^#t-[a-z0-9]{6}$/i;
const fromThreads = (db.query("SELECT channel FROM threads").all() as { channel: string }[]).map((row) => row.channel);
const fromChannels = (db.query("SELECT channel FROM channels WHERE channel LIKE '#t-%'").all() as { channel: string }[]).map((row) => row.channel);
const channels = [...new Set([...fromThreads, ...fromChannels].map((channel) => channel.toLowerCase()))].filter((channel) => THREAD.test(channel));
const orphans = channels.filter((channel) => !fromThreads.some((item) => item.toLowerCase() === channel));

// Tables keyed by a thread channel. Each is counted in the dry run and cleared with --apply.
const TABLES: { table: string; column: string; guard?: string }[] = [
  { table: "channel_members", column: "channel" },
  { table: "channels", column: "channel" },
  { table: "threads", column: "channel" },
  { table: "uploads", column: "channel", guard: "id NOT IN (SELECT upload_id FROM custom_emoji)" },
  { table: "reminders", column: "channel" },
  { table: "polls", column: "channel" },
  { table: "helper_catchups", column: "channel" },
  { table: "public_author_evidence", column: "channel" },
  { table: "project_repos", column: "channel" },
  { table: "agent_session_requests", column: "source_channel" },
];

const marks = (values: string[]) => values.map(() => "?").join(",");
const count = (table: string, column: string, guard?: string): number | string => {
  try {
    const where = `lower(${column}) IN (${marks(channels)})${guard ? ` AND ${guard}` : ""}`;
    return (db.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...channels) as { n: number }).n;
  } catch {
    return "n/a";
  }
};

const parents = db.query("SELECT parent, count(*) AS n FROM threads GROUP BY parent ORDER BY n DESC").all() as { parent: string; n: number }[];
console.log(`${apply ? "APPLY" : "DRY RUN"} ${path}`);
console.log(`thread channels: ${channels.length} (${orphans.length} without a threads row)`);
for (const { table, column, guard } of TABLES) console.log(`  ${table}.${column}: ${channels.length ? count(table, column, guard) : 0}`);
if (channels.length && !apply) {
  const bytes = db.query(`SELECT coalesce(sum(length(data)), 0) AS n FROM uploads WHERE lower(channel) IN (${marks(channels)})`).get(...channels) as { n: number };
  console.log(`  upload bytes: ${bytes.n}`);
}
for (const { parent, n } of parents.slice(0, 10)) console.log(`  parent ${parent}: ${n}`);
console.log("Ergo history is not counted; --apply clears it per channel.");

if (!apply) {
  console.log("Nothing deleted. Re-run with --apply to delete.");
  process.exit(0);
}
if (!process.env.ERGO_OPER_PASS) throw new Error("ERGO_OPER_PASS required");

const { purgeChannelHistory, unregisterChannel } = await import("../src/grants.ts");
let done = 0;
let failed = 0;
for (const channel of channels) {
  try {
    const history = await purgeChannelHistory(channel);
    if (history.partial) console.log(`${channel}: history purge incomplete (scanned ${history.scanned}, deleted ${history.deleted}, failed ${history.failed})`);
    await unregisterChannel(channel);
    db.transaction(() => {
      for (const { table, column, guard } of TABLES) {
        try { db.query(`DELETE FROM ${table} WHERE lower(${column}) = ?${guard ? ` AND ${guard}` : ""}`).run(channel); } catch {}
      }
      db.query("DELETE FROM meta WHERE key LIKE 'thread-provision:%' AND lower(value) = ?").run(channel);
    })();
    done++;
  } catch (error) {
    failed++;
    console.log(`${channel}: failed, left in place (${error instanceof Error ? error.message : error})`);
  }
}
console.log(`deleted ${done}, failed ${failed}`);
process.exit(failed ? 1 : 0);
