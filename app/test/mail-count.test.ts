// The app counts the mail it hands to Resend, per UTC day and kind, without storing who it went to,
// logs once when a day reaches the warning and the limit, and never lets a count stop a mail.
import "./fixture.ts";

import { afterEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { countedMail, mailKind, recordMail } = await import("../src/mail-count.ts");

afterEach(() => {
  db.exec("DELETE FROM mail_counts");
  delete process.env.MAIL_DAILY_WARN;
  delete process.env.MAIL_DAILY_LIMIT;
});

const DAY = Date.UTC(2026, 10, 11, 12);

test("each send is counted by kind from its idempotency key, accepted or refused, and nothing else is stored", async () => {
  const sent: unknown[] = [];
  const client = countedMail({ emails: { send: async (payload: any, options?: any) => { sent.push([payload, options]); return payload.to === "bad@example.test" ? { data: null, error: { message: "rejected" } } : { data: { id: "x" }, error: null }; } } });
  await client.emails.send({ to: "ana@example.test", subject: "Sign in" }, { idempotencyKey: "magic-link/abc" });
  await client.emails.send({ to: "ana@example.test", subject: "Join" }, { idempotencyKey: "invite/1/abc" });
  await client.emails.send({ to: "bad@example.test", subject: "Join" }, { idempotencyKey: "invite/2/def" });
  await client.emails.send({ to: "ana@example.test", subject: "Verify" }, { idempotencyKey: "invite-signup/a/b" });
  await client.emails.send({ to: "ana@example.test", subject: "Admitted" }, { idempotencyKey: "admission/1/1" });
  // The real send happened every time, unchanged.
  expect(sent).toHaveLength(5);
  const rows = db.query("SELECT kind, accepted, count FROM mail_counts ORDER BY kind, accepted").all();
  expect(rows).toEqual([
    { kind: "admission", accepted: 1, count: 1 },
    { kind: "invitation", accepted: 0, count: 1 },
    { kind: "invitation", accepted: 1, count: 1 },
    { kind: "invitation-verification", accepted: 1, count: 1 },
    { kind: "sign-in", accepted: 1, count: 1 },
  ]);
  const stored = JSON.stringify(db.query("SELECT * FROM mail_counts").all());
  expect(stored).not.toContain("@");
  expect(stored).not.toContain("abc");
  expect(mailKind(undefined)).toBe("other");
});

test("a send that throws may have gone out, so it counts as sent, and still throws", async () => {
  const client = countedMail({ emails: { send: async () => { throw new Error("network down"); } } });
  await expect(client.emails.send({ to: "ana@example.test" }, { idempotencyKey: "magic-link/x" })).rejects.toThrow("network down");
  expect(db.query("SELECT kind, accepted, count FROM mail_counts").all()).toEqual([{ kind: "sign-in", accepted: 1, count: 1 }]);
});

test("one log line at the warning and one at the limit, with settings that raise them", () => {
  const lines: string[] = [];
  for (let i = 0; i < 101; i++) recordMail("invitation", true, DAY, (line) => lines.push(line));
  expect(lines).toEqual([
    "mail: 80 sent today (2026-11-11 UTC), warning at 80, limit 100",
    "mail: 100 sent today (2026-11-11 UTC), the daily limit of 100",
  ]);
  // Refused mails do not count toward the limit; a new UTC day starts again.
  recordMail("invitation", false, DAY, (line) => lines.push(line));
  db.exec("DELETE FROM mail_counts");
  lines.length = 0;
  process.env.MAIL_DAILY_WARN = "3";
  process.env.MAIL_DAILY_LIMIT = "5";
  for (let i = 0; i < 6; i++) recordMail("sign-in", true, DAY + 86_400_000, (line) => lines.push(line));
  expect(lines).toEqual([
    "mail: 3 sent today (2026-11-12 UTC), warning at 3, limit 5",
    "mail: 5 sent today (2026-11-12 UTC), the daily limit of 5",
  ]);
});

test("a broken count never stops a mail", async () => {
  db.exec("ALTER TABLE mail_counts RENAME TO mail_counts_hidden");
  try {
    let delivered = false;
    const client = countedMail({ emails: { send: async () => { delivered = true; return { data: { id: "x" }, error: null }; } } });
    const result = await client.emails.send({ to: "ana@example.test" }, { idempotencyKey: "invite/1/a" });
    expect(delivered).toBe(true);
    expect(result.error).toBeNull();
  } finally {
    db.exec("ALTER TABLE mail_counts_hidden RENAME TO mail_counts");
  }
});

test("the report script prints today, the last 7 days and the month by kind, read-only", async () => {
  const path = `/tmp/mail-count-test-${process.pid}.sqlite`;
  const { Database } = await import("bun:sqlite");
  const file = new Database(path);
  file.exec("CREATE TABLE mail_counts (day TEXT NOT NULL, kind TEXT NOT NULL, accepted INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, accepted))");
  const today = new Date().toISOString().slice(0, 10);
  file.query("INSERT INTO mail_counts VALUES (?, 'invitation', 1, 7), (?, 'sign-in', 1, 2), (?, 'invitation', 0, 1)").run(today, today, today);
  file.close();
  const run = Bun.spawnSync([process.execPath, "scripts/mail-count.ts"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, DB_PATH: path } });
  const out = run.stdout.toString();
  await Bun.file(path).delete?.();
  expect(run.exitCode).toBe(0);
  expect(out).toContain(`Today ${today}: 9 sent, 1 refused`);
  expect(out).toMatch(/invitation\s+7 sent, 1 refused/);
  expect(out).toContain("Last 7 days");
  expect(out).toContain("Month so far");
});
