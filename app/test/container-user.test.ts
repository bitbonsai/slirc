import { expect, test } from "bun:test";

// Rehearses ownership migration on a newly created disposable volume, never an existing one.
test.skipIf(process.env.SLIRC_CONTAINER_TESTS !== "1")("non-root SQLite migration needs volume ownership; root rollback preserves rows", () => {
  const image = process.env.SLIRC_TEST_IMAGE;
  if (!image || !/^[a-f0-9]{64}$/.test(image)) throw new Error("Pin SLIRC_TEST_IMAGE to a local app image ID");
  const volume = `slirc2-user-test-${crypto.randomUUID()}`;
  const command = (...args: string[]) => Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  const checked = (...args: string[]) => {
    const result = command(...args);
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  const run = (user: string, script: string) => command("podman", "run", "--rm", "--pull=never", "--network=none", "--user", user,
    "-v", `${volume}:/data`, "-v", `${new URL("../src/", import.meta.url).pathname}:/app/src:ro`,
    image, "bun", "-e", script);
  checked("podman", "volume", "create", volume);
  try {
    // Old populated schema without account_id, matching the pre-Slirc 2 accounts table.
    const old = run("0", `import { Database } from 'bun:sqlite'; const db = new Database('/data/chat.sqlite'); db.exec(\`CREATE TABLE accounts (nick TEXT PRIMARY KEY COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE, irc_password TEXT, role TEXT DEFAULT 'member', kind TEXT DEFAULT 'human', owner TEXT, machine TEXT, verified_at INTEGER, provisional_expires_at INTEGER, created_at INTEGER); INSERT INTO accounts (nick,email,created_at) VALUES ('fixture','fixture@example.test',1);\`);`);
    expect(old.exitCode, old.stderr.toString()).toBe(0);
    const denied = run("1000:1000", `await import('/app/src/db.ts');`);
    expect(denied.exitCode).not.toBe(0);
    checked("podman", "run", "--rm", "--pull=never", "--network=none", "--user", "0", "-v", `${volume}:/data`, image, "chown", "-R", "1000:1000", "/data");
    const migrated = run("1000:1000", `const {db} = await import('/app/src/db.ts'); const row = db.query("SELECT account_id FROM accounts WHERE nick='fixture'").get(); if (!/^[a-f0-9]{32}$/.test(row.account_id)) throw Error('missing identity'); db.query("INSERT INTO accounts (nick,email,created_at) VALUES ('second','second@example.test',2)").run(); console.log(row.account_id);`);
    expect(migrated.exitCode, migrated.stderr.toString()).toBe(0);
    const id = migrated.stdout.toString().trim();
    const rollback = run("0", `import { Database } from 'bun:sqlite'; const db = new Database('/data/chat.sqlite'); if (db.query('SELECT count(*) AS n FROM accounts').get().n !== 2) throw Error('lost data'); console.log(db.query("SELECT account_id FROM accounts WHERE nick='fixture'").get().account_id); db.query("UPDATE accounts SET email='updated@example.test' WHERE nick='fixture'").run();`);
    expect(rollback.exitCode, rollback.stderr.toString()).toBe(0);
    expect(rollback.stdout.toString().trim()).toBe(id);
  } finally {
    checked("podman", "volume", "rm", volume);
  }
}, 60_000);
