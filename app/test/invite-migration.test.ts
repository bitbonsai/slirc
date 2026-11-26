import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";

process.env.NODE_ENV = "test";
const dir = mkdtempSync(join(tmpdir(), "slirc-invite-migration-"));
process.env.DB_PATH = join(dir, "chat.sqlite");
const legacy = new Database(process.env.DB_PATH);
legacy.exec(`CREATE TABLE accounts (
  nick TEXT PRIMARY KEY COLLATE NOCASE, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT 'member', verified_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE channels (
  channel TEXT PRIMARY KEY, owner TEXT NOT NULL, visibility TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '', archived_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY, channel TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  email TEXT, sent_at INTEGER, accepted_at INTEGER, accepted_by TEXT, sends INTEGER NOT NULL DEFAULT 0
);
INSERT INTO accounts VALUES ('Ada','ada@example.com','member',1,100);
INSERT INTO invites VALUES ('copied-hash','#room','Ada',100,NULL,NULL,NULL,NULL,0);
INSERT INTO invites VALUES ('email-hash','#room','Ada',100,'new@example.com',200,NULL,NULL,2);`);
legacy.close();
const { db } = await import("../src/db.ts");

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("legacy invite table migration preserves links and backfills scoped email accounting", () => {
  const columns = db.query("PRAGMA table_info(invites)").all() as Array<{ name: string; notnull: number }>;
  expect(columns.find((column) => column.name === "channel")?.notnull).toBe(0);
  expect(db.query("SELECT channel, email, destination_type FROM invites WHERE token_hash='copied-hash'").get()).toEqual({
    channel: "#room", email: null, destination_type: "channel",
  });
  const row = db.query(`SELECT email, inviter_account_id, invitation_id, expires_at, sends, delivery_state
    FROM invites WHERE token_hash='email-hash'`).get() as any;
  expect(row).toMatchObject({ email: "new@example.com", expires_at: 604800100, sends: 2, delivery_state: "sent" });
  expect(row.inviter_account_id).toBeTruthy();
  expect(row.invitation_id).toHaveLength(32);
  expect(db.query("SELECT sent FROM email_invite_quota WHERE account_id=?").get(row.inviter_account_id)).toEqual({ sent: 2 });
  const restarted = spawnSync(process.execPath, ["-e", "const {db}=await import('./src/db.ts'); const n=db.query(\"SELECT COUNT(*) AS n FROM invites\").get().n; console.log(n); db.close();"], {
    cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, DB_PATH: process.env.DB_PATH }, encoding: "utf8",
  });
  expect(restarted.status).toBe(0);
  expect(restarted.stdout.trim()).toBe("2");
});
