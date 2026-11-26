import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A database from deploy A: the stored-password columns still exist. db.ts drops them only once
// every row has moved to a derived password, and refuses to start otherwise.
function deployADatabase(gen: number | null, password: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "slirc-irc-columns-")), "chat.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE accounts (nick TEXT PRIMARY KEY COLLATE NOCASE, email TEXT NOT NULL UNIQUE COLLATE NOCASE, irc_password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', kind TEXT NOT NULL DEFAULT 'human', owner TEXT, machine TEXT, verified_at INTEGER,
      provisional_expires_at INTEGER, created_at INTEGER NOT NULL, account_id TEXT, irc_password_gen INTEGER);
    CREATE TABLE agent_session_bindings (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, owner_account_id TEXT NOT NULL, owner_nick TEXT NOT NULL,
      harness TEXT NOT NULL, session_id TEXT NOT NULL, session_file TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
      irc_password TEXT NOT NULL, dm TEXT, status TEXT NOT NULL, machine TEXT NOT NULL, session_name TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO accounts (nick, email, irc_password, created_at, account_id, irc_password_gen) VALUES ('ada', 'ada@example.test', '${password}', 1, 'abc', ${gen ?? "NULL"});
    INSERT INTO agent_session_bindings VALUES ('b', 'i', 'abc', 'ada', 'pi', 's', '/f', 'h', 'pi-ab', '', NULL, 'ready', 'Mac', 'n', 1);`);
  db.close();
  return path;
}

async function boot(path: string) {
  const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(join(import.meta.dir, "../src/db.ts"))});`], {
    env: { PATH: process.env.PATH ?? "", DB_PATH: path, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  return { status: await child.exited, stderr };
}

const columns = (path: string, table: string) => {
  const db = new Database(path);
  try { return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name); } finally { db.close(); }
};

test("a row deploy A has not moved stops the boot and keeps its stored password", async () => {
  const path = deployADatabase(null, "still-in-use");
  const result = await boot(path);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("still hold a stored IRC password");
  expect(result.stderr).toContain("migrate-founder");
  expect(columns(path, "accounts")).toContain("irc_password");
});

test("once every row is derived the stored-password columns are dropped and the rows stay", async () => {
  const path = deployADatabase(0, "");
  const result = await boot(path);
  expect(result.status, result.stderr).toBe(0);
  expect(columns(path, "accounts")).not.toContain("irc_password");
  expect(columns(path, "agent_session_bindings")).not.toContain("irc_password");
  expect(columns(path, "admissions")).not.toContain("reserved_password");
  const db = new Database(path);
  expect(db.query("SELECT nick, account_id, irc_password_gen FROM accounts").all()).toEqual([{ nick: "ada", account_id: "abc", irc_password_gen: 0 }]);
  db.close();
  expect((await boot(path)).status).toBe(0);
});

// A database that skipped deploy A: stored passwords and no counter column yet (dev stacks).
function preDeployADatabase(): string {
  const path = join(mkdtempSync(join(tmpdir(), "slirc-irc-columns-")), "chat.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE accounts (nick TEXT PRIMARY KEY COLLATE NOCASE, email TEXT NOT NULL UNIQUE COLLATE NOCASE, irc_password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', kind TEXT NOT NULL DEFAULT 'human', owner TEXT, machine TEXT, verified_at INTEGER,
      provisional_expires_at INTEGER, created_at INTEGER NOT NULL, account_id TEXT);
    CREATE TABLE agent_session_bindings (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, owner_account_id TEXT NOT NULL, owner_nick TEXT NOT NULL,
      harness TEXT NOT NULL, session_id TEXT NOT NULL, session_file TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
      irc_password TEXT NOT NULL, dm TEXT, status TEXT NOT NULL, machine TEXT NOT NULL, session_name TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO accounts (nick, email, irc_password, created_at, account_id) VALUES ('ada', 'ada@example.test', 'old-ada', 1, 'abc');
    INSERT INTO accounts (nick, email, irc_password, kind, created_at, account_id) VALUES ('pi-ab', 'pi@example.test', 'old-pi', 'agent', 1, 'def');
    INSERT INTO agent_session_bindings VALUES ('b', 'i', 'abc', 'ada', 'pi', 's', '/f', 'h', 'pi-ab', 'old-pi', NULL, 'ready', 'Mac', 'n', 1);`);
  db.close();
  return path;
}

test("migrate-founder moves a database that skipped deploy A, then the app boots", async () => {
  const path = preDeployADatabase();
  expect((await boot(path)).stderr).toContain("run bun src/migrate-founder.ts once");
  // The migrate-founder steps with Ergo faked: every passwd and check_auth succeeds.
  const src = join(import.meta.dir, "../src");
  const child = Bun.spawn([process.execPath, "-e", `
    process.env.SLIRC_IRC_MIGRATION = "1";
    const { dropStoredIrcPasswords, hasStoredIrcPasswordColumns } = await import(${JSON.stringify(join(src, "db.ts"))});
    const { migrateIrcPasswords } = await import(${JSON.stringify(join(src, "irc-migration.ts"))});
    const { ircPasswordFor } = await import(${JSON.stringify(join(src, "irc-key.ts"))});
    const calls = [];
    const before = hasStoredIrcPasswordColumns();
    const result = await migrateIrcPasswords(async (path, body) => { calls.push([path, body.accountName, body.passphrase]); return { success: true }; });
    console.log(JSON.stringify({ before, result, left: dropStoredIrcPasswords(), after: hasStoredIrcPasswordColumns(), calls, derived: ircPasswordFor("abc", 0) }));
  `], {
    // An owner in USERS_JSON makes accounts.ts write the owner row on import, which fails while the stored column is NOT NULL.
    env: { PATH: process.env.PATH ?? "", DB_PATH: path, NODE_ENV: "test", OWNER_NICK: "ada", USERS_JSON: JSON.stringify({ ada: "ada@example.test" }) },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  expect(await child.exited, err).toBe(0);
  const moved = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(moved.before).toBe(true);
  expect(moved.result).toEqual({ accounts: 2, failed: 0, bindings: 1, admissions: 0 });
  expect(moved.left).toBe(0);
  expect(moved.after).toBe(false);
  expect(moved.calls).toContainEqual(["/v1/ns/passwd", "ada", moved.derived]);
  expect(moved.calls).toContainEqual(["/v1/check_auth", "ada", moved.derived]);
  expect(columns(path, "agent_session_bindings")).not.toContain("irc_password");
  const db = new Database(path);
  expect(db.query("SELECT nick, irc_password_gen FROM accounts ORDER BY nick").all()).toEqual([{ nick: "ada", irc_password_gen: 0 }, { nick: "pi-ab", irc_password_gen: 0 }]);
  db.close();
  const booted = await boot(path);
  expect(booted.status, booted.stderr).toBe(0);
});

test("a database deploy A already moved needs no migration", async () => {
  const path = deployADatabase(0, "");
  expect((await boot(path)).status).toBe(0);
  const db = new Database(path);
  expect((db.query("PRAGMA table_info(accounts)").all() as { name: string }[]).some((c) => c.name === "irc_password")).toBe(false);
  db.close();
});

test("migrate-founder itself moves the passwords before it loads accounts.ts", async () => {
  const path = preDeployADatabase();
  const keyFile = join(dirname(path), "irc-key");
  writeFileSync(keyFile, "k".repeat(32));
  // Ergo's API is mocked; the oper IRC sign-in at the end has nothing to reach and fails, after the migration.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/migrate-founder.ts")], {
    env: { PATH: process.env.PATH ?? "", DB_PATH: path, SLIRC_IRC_KEY_FILE: keyFile, ERGO_API_MOCK: "true", ERGO_HOST: "127.0.0.1", ERGO_PORT: "1",
      OWNER_NICK: "ada", USERS_JSON: JSON.stringify({ ada: "ada@example.test" }) },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 8000);
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  clearTimeout(timer);
  expect(stderr).not.toContain("NOT NULL");
  expect(columns(path, "accounts"), stderr).not.toContain("irc_password");
  expect(columns(path, "agent_session_bindings")).not.toContain("irc_password");
}, 15000);
