import { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";

function hasMappings(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='direct_conversations'").get();
}
function hasReadiness(db: Database): boolean {
  return (db.query("PRAGMA table_info(direct_conversations)").all() as { name: string }[])
    .some((column) => column.name === "provision_ready");
}

// No IRC work at boot or login. Pre-column databases also fail closed.
export function assertDirectReadiness(db: Database): void {
  if (!hasMappings(db)) return;
  const pending = db.query(`SELECT COUNT(*) AS n FROM direct_conversations${hasReadiness(db) ? " WHERE provision_ready IS NULL" : ""}`).get() as { n: number };
  if (pending.n) throw new Error(`${pending.n} legacy DMs need the guarded app deployment verification; refusing startup`);
}

type Proof = (channel: string, members: string[]) => Promise<boolean>;

// The operator has stopped all app writers. Keep one SQLite write lock across proof and
// the host's final runtime check. Any failure rolls back the entire readiness checkpoint.
export async function verifyDirectReadiness(db: Database, proof: Proof, checkpoint: () => Promise<void>): Promise<number> {
  db.exec("BEGIN IMMEDIATE");
  try {
    let count = 0;
    if (hasMappings(db)) {
      if (!hasReadiness(db)) db.exec("ALTER TABLE direct_conversations ADD COLUMN provision_ready INTEGER");
      const rows = db.query("SELECT channel, first_nick, second_nick FROM direct_conversations WHERE provision_ready IS NULL ORDER BY channel")
        .all() as { channel: string; first_nick: string; second_nick: string }[];
      for (const row of rows) {
        const { channel, first_nick: first, second_nick: second } = row;
        const metadata = db.query("SELECT 1 FROM channels WHERE channel=? AND visibility='direct' AND archived_at IS NULL").get(channel);
        const members = (db.query("SELECT nick FROM channel_members WHERE channel=? ORDER BY nick").all(channel) as { nick: string }[]).map((m) => m.nick);
        if (!first || first >= second || members.length !== 2 || members[0] !== first || members[1] !== second || !metadata) {
          throw new Error(`Legacy DM metadata needs explicit disposition: ${channel}`);
        }
        if (!await proof(channel, [first, second])) throw new Error(`Legacy DM proof unresolved: ${channel}`);
        db.query("UPDATE direct_conversations SET provision_ready=1 WHERE channel=? AND provision_ready IS NULL").run(channel);
        count++;
      }
    }
    await checkpoint();
    assertDirectReadiness(db);
    db.exec("COMMIT");
    return count;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

if (import.meta.main) {
  try {
    const path = process.env.DB_PATH;
    if (!path || !path.startsWith("/")) throw new Error("An explicit absolute DB_PATH is required");
    if (process.argv[2] === "check") {
      // A fresh install has no legacy mappings. Never create a database in the preflight.
      if (existsSync(path)) {
        const db = new Database(path, { readonly: true });
        try { assertDirectReadiness(db); } finally { db.close(); }
      }
    } else if (process.argv[2] === "verify") {
      const [origin, expectedPath, stoppedId] = process.argv.slice(3);
      if (!origin || origin !== process.env.APP_ORIGIN || expectedPath !== path
        || process.env.SLIRC_DEV_PROFILE || process.env.DEV_IRC_NICK || !/^[a-f0-9]{64}$/.test(stoppedId || "")
        || !process.env.ERGO_HOST || !process.env.ERGO_PORT || !process.env.ERGO_OPER_USER || !process.env.ERGO_OPER_PASS) {
        throw new Error("Maintenance target/profile does not match the explicit deployment context");
      }
      // Only the host recipe creates this temporary mount after inspecting the stopped app.
      if ((await Bun.file("/run/dm-upgrade/stopped").text()).trim() !== stoppedId) throw new Error("Missing app pause checkpoint");
      const db = new Database(path, { create: false, readwrite: true });
      try {
        const { readDirectChannelReady } = await import("./grants.ts");
        const count = await verifyDirectReadiness(db, readDirectChannelReady, async () => {
          await Bun.write("/run/dm-upgrade/ready.tmp", stoppedId);
          renameSync("/run/dm-upgrade/ready.tmp", "/run/dm-upgrade/ready");
          const deadline = Date.now() + 30_000;
          while (!existsSync("/run/dm-upgrade/commit")) {
            if (Date.now() >= deadline) throw new Error("Host did not confirm the stopped writers before commit");
            await Bun.sleep(100);
          }
          if ((await Bun.file("/run/dm-upgrade/commit").text()).trim() !== stoppedId) throw new Error("Invalid host checkpoint");
        });
        console.log(`Verified ${count} legacy DMs; readiness checkpoint committed`);
      } finally { db.close(); }
    } else throw new Error("Usage: direct-readiness.ts check | verify <origin> <absolute-db-path> <stopped-container-id>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "DM readiness verification failed");
    process.exitCode = 1;
  }
}
