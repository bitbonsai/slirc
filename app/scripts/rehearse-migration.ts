// Run from app/: bun scripts/rehearse-migration.ts /path/to/consistent-app-snapshot.sqlite
// Never pass a live database: the input must come from SQLite's backup API.
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const input = process.argv[2];
if (!input) throw new Error("Provide a consistent SQLite snapshot, not a live database.");
const dir = mkdtempSync(join(tmpdir(), "slirc-migration-"));
chmodSync(dir, 0o700);
const path = join(dir, "app.sqlite");
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tables = (db: Database) => (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
const columns = (db: Database, table: string) => (db.query(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map((row) => row.name);
const rows = (db: Database, table: string, fields: string[]) => db.query(`SELECT ${fields.map(quote).join(",")} FROM ${quote(table)}`).values().map((row) => JSON.stringify(row)).sort();

try {
  copyFileSync(input, path);
  chmodSync(path, 0o600);
  const original = new Database(path, { readonly: true });
  const before = new Map(tables(original).map((table) => {
    const fields = columns(original, table);
    return [table, { fields, rows: rows(original, table, fields) }];
  }));
  original.close();
  let first: Map<string, string[]> | undefined;
  for (let run = 1; run <= 2; run++) {
    const result = Bun.spawnSync([process.execPath, "-e", "const {db}=await import('./src/db.ts'); db.close();"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, DB_PATH: path }, stdout: "pipe", stderr: "pipe",
    });
    // Do not print migration stderr: a failed SQL statement may contain private data.
    assert.equal(result.exitCode, 0, `migration run ${run} failed; private snapshot remains untouched`);
    const migrated = new Database(path, { readonly: true });
    assert.deepEqual(migrated.query("PRAGMA integrity_check").values(), [["ok"]]);
    for (const [table, old] of before) {
      assert.deepEqual(rows(migrated, table, old.fields), old.rows, `${table}: original data changed`);
    }
    assert.equal((migrated.query("SELECT count(*) AS n FROM accounts WHERE account_id IS NULL").get() as { n: number }).n, 0);
    const current = new Map(tables(migrated).map((table) => [table, rows(migrated, table, columns(migrated, table))]));
    if (first) assert.deepEqual(current, first, "second migration changed data or account IDs");
    first = current;
    migrated.close();
    console.log(`Run ${run}: integrity OK; ${before.size} original tables preserved.`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
