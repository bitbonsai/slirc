import "./fixture.ts";

import { beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const onboarding = await import("../src/onboarding.ts");

const NOW = 1_700_000_000_000;

function account(nick: string, fields: { kind?: string; verified?: boolean } = {}) {
  db.query("INSERT INTO accounts (nick, email, role, kind, owner, verified_at, provisional_expires_at, created_at) VALUES (?, ?, 'member', ?, NULL, ?, ?, ?)")
    .run(nick, `${nick}@example.com`, fields.kind || "human", fields.verified ? NOW : null, Date.now() + 60_000, NOW);
}

beforeEach(() => {
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.exec("DELETE FROM meta WHERE key LIKE 'onboarding-pending:%'");
});

test("welcome DM greets and links to the absolute /welcome page on this server", () => {
  const before = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "https://chat.example.test";
  const lines = onboarding.onboardingLines("ana");
  if (before === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = before;
  const copy = lines.join("\n");
  expect(lines[0]).toContain("ana");
  // Short enough to read; phone-only places like the More tab stay out.
  expect(lines.length).toBeLessThanOrEqual(3);
  expect(copy).not.toContain("More tab");
  expect(copy).toContain("https://chat.example.test/welcome");
  expect(copy).not.toContain("—");
  // The new router has no /?screen= paths; stale ones would land nowhere.
  expect(copy).not.toContain("/?screen=");
  expect(copy).not.toMatch(/\b20\d\d\b/);
});

test("only a verified first human with a default return lands in the help DM", () => {
  expect(onboarding.onboardingDestination("/", true, true)).toBe("/dm/help");
  // Explicit destinations and existing users keep what they asked for.
  expect(onboarding.onboardingDestination("/open-chat", true, true)).toBe("/open-chat");
  expect(onboarding.onboardingDestination("/dms", true, true)).toBe("/dms");
  expect(onboarding.onboardingDestination("/", false, true)).toBe("/");
  // A disabled or failed helper never forges the DM.
  expect(onboarding.onboardingDestination("/", true, false)).toBe("/");
});

test("needsOnboarding is false for existing, bot and already-onboarded accounts", () => {
  account("ana");
  expect(onboarding.needsOnboarding("ana")).toBe(true);
  db.query("UPDATE accounts SET onboarded_at = ? WHERE nick = 'ana'").run(NOW);
  expect(onboarding.needsOnboarding("ana")).toBe(false);
  account("remind", { kind: "bot" });
  expect(onboarding.needsOnboarding("remind")).toBe(false);
});

test("queueing stamps the account and leaves a recoverable pending row", () => {
  account("ana");
  onboarding.queueOnboarding("ana", "#Dm-Ana-Help");
  expect((db.query("SELECT onboarded_at FROM accounts WHERE nick = 'ana'").get() as { onboarded_at: number }).onboarded_at).toBeGreaterThan(0);
  expect((db.query("SELECT value FROM meta WHERE key = 'onboarding-pending:ana'").get() as { value: string }).value).toBe("#dm-ana-help");
  // The bot has not flushed, so the pending row is preserved rather than pretending success.
  onboarding.resumeOnboarding();
  expect(db.query("SELECT 1 FROM meta WHERE key = 'onboarding-pending:ana'").get()).not.toBeNull();
});

test("pending rows for deleted accounts are dropped on resume", () => {
  db.query("INSERT INTO meta (key, value) VALUES ('onboarding-pending:ghost', '#dm-ghost-help')").run();
  onboarding.resumeOnboarding();
  expect(db.query("SELECT 1 FROM meta WHERE key = 'onboarding-pending:ghost'").get()).toBeNull();
});
