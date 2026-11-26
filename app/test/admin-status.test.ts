// GET /api/admin/status: admins read the ops-status.json the host writes beside the database.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";

const dir = mkdtempSync(join(tmpdir(), "slirc-admin-status-"));
process.env.DB_PATH = join(dir, "chat.sqlite");
const statusFile = join(dir, "ops-status.json");

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");

const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const get = (token?: string) => app.request("/api/admin/status", { headers: token ? { Cookie: `slirc_session=${token}` } : {} });

beforeEach(() => {
  rmSync(statusFile, { force: true });
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM accounts WHERE nick != 'bitbonsai'").run();
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('igor', 'igor@example.com', 'member', 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sha("admin-session"), Date.now());
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'igor', ?)").run(sha("member-session"), Date.now());
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("not signed in gets 401", async () => {
  expect((await get()).status).toBe(401);
});

test("a member gets 403", async () => {
  writeFileSync(statusFile, JSON.stringify({ generated_at: "2026-11-14T10:00:00Z" }));
  const response = await get("member-session");
  expect(response.status).toBe(403);
  expect(await response.json()).not.toHaveProperty("status");
});

test("an admin gets the file's content, never cached", async () => {
  const status = { generated_at: "2026-11-14T10:00:00Z", days: ["2026-11-14"], instances: [{ host: "guild.example.test", state: "running", healthy: true }] };
  writeFileSync(statusFile, JSON.stringify(status));
  const response = await get("admin-session");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ status });
});

test("an admin gets status null when the file is missing", async () => {
  const response = await get("admin-session");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: null });
});

test("an unparseable file says so", async () => {
  writeFileSync(statusFile, "{ not json");
  const response = await get("admin-session");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: null, error: "unreadable" });
});

const { statusView } = await import("@client/admin-page.ts");
const NOW = Date.parse("2026-11-14T10:05:00Z");
const day = "2026-11-14";
const instance = { host: "guild.example.test", state: "running", healthy: true, commit: "abc", members_total: 3, mail_warn: 8, mail_limit: 10, mail: { [day]: 9 }, errors: { [day]: 2 }, backup: null };

test("a tenant file shows only its certificates and instance, with thresholds", () => {
  const view = statusView({ generated_at: "2026-11-14T10:00:00Z", days: [day], instances: [instance], certs: [
    { host: "guild.example.test", port: 443, expires: "2026-11-27T00:00:00Z", days_left: 13 },
    { host: "guild.example.test", port: 6697, expires: "2026-12-04T00:00:00Z", days_left: 20 },
    { host: "guild.example.test", port: 8443, error: "connection refused" },
  ] }, NOW);
  expect(view.updated.tone).toBe("muted");
  expect(view.sections.map((part) => part.title)).toEqual(["Certificates", "guild.example.test"]);
  const certs = view.sections[0]!.tables[0]!.rows;
  expect(certs.map((row) => row[2]!.tone)).toEqual(["bad", "warn", ""]);
  expect(certs[2]![1]).toEqual({ text: "connection refused", tone: "bad" });
  const pairs = Object.fromEntries(view.sections[1]!.pairs.map((pair) => [pair.term, pair.value]));
  expect(pairs.Backup).toEqual({ text: "no daily backup", tone: "bad" });
  expect(pairs["Mail today"]!.tone).toBe("warn");
  // Only the series the instance has become rows; absent ones are left out.
  expect(view.sections[1]!.tables[0]!.rows.map((row) => row[0]!.text)).toEqual(["Errors and warnings", "Mail sent"]);
});

test("a stale file says the collector stopped, and failed sections show their error", () => {
  const view = statusView({ generated_at: "2026-11-14T09:00:00Z", days: [day], host: { error: "no /proc" }, containers: { error: "podman timed out" },
    links_sync: { last_run: "2026-11-12T00:00:00Z", age_hours: 58, found: 1 }, instances: [{ ...instance, backup: { age_hours: 30, newest_bytes: 1, copies: 1, total_bytes: 1 } }] }, NOW);
  expect(view.updated.tone).toBe("bad");
  expect(view.updated.text).toContain("The collector has stopped");
  expect(view.sections.find((part) => part.key === "host")!.error).toBe("no /proc");
  expect(view.sections.find((part) => part.key === "containers")!.error).toBe("podman timed out");
  expect(view.sections.find((part) => part.key === "jobs")!.pairs[0]!.value.tone).toBe("bad");
  const withCheckouts = statusView({ generated_at: "2026-11-14T10:00:00Z", days: [day], checkouts: { slirc: "abc123", hosting: "def456" } }, NOW);
  const terms = withCheckouts.sections.find((part) => part.key === "jobs")!.pairs.map((pair) => pair.term);
  expect(terms).toEqual(["Links sync", "Checkout (slirc)", "Checkout (hosting)"]);
  expect(terms.join(" ")).not.toMatch(/beta|slirc\.app/i);
  expect(view.sections.find((part) => part.key === "instance-0")!.pairs.find((pair) => pair.term === "Backup")!.value.tone).toBe("bad");
});

test("/admin is a client shell route", async () => {
  const response = await app.request("/admin", { headers: { Cookie: "slirc_session=admin-session" } });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('x-data="adminPage"');
});
