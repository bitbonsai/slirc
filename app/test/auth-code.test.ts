import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app, settleSignIns } = await import("../src/server.ts");
const { resetRateLimits } = await import("../src/request-security.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const codeHash = (nick: string, code: string) => sha(`${nick}:${code}`);
const post = (body: unknown, ip = "1.1.1.1") =>
  app.request("/auth/code", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example.test", "X-Slirc-Sign-In": "1", "X-Forwarded-For": ip }, body: JSON.stringify(body) });
const rejected = { error: "That code is wrong or expired. Try again, or request a new one." };
const mint = (nick: string, code: string, expiresIn = 15 * 60_000) => {
  const token = `tok-${nick}-${code}`;
  db.query("INSERT INTO magic_links (token_hash, nick, expires_at, created_at, code_hash) VALUES (?, ?, ?, ?, ?)")
    .run(sha(token), nick, Date.now() + expiresIn, Date.now(), codeHash(nick, code));
  return sha(token);
};

beforeEach(() => {
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM magic_links").run();
  db.query("DELETE FROM used_magic_links").run();
  db.query("DELETE FROM accounts WHERE nick != 'bitbonsai'").run();
  // The limiters are module-level in-memory maps; clear them so one test's attempts cannot 429 the next.
  resetRateLimits();
  db.query("INSERT INTO accounts (nick, email, role, verified_at, provisional_expires_at, created_at) VALUES ('igor', 'igor@example.com', 'member', NULL, ?, 1)").run(Date.now() + 60_000);
});

test("requesting a link also mints a code on the same row", async () => {
  const response = await app.request("/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.com" }) });
  expect(response.status).toBe(204);
  await settleSignIns();
  const row = db.query("SELECT code_hash, attempts FROM magic_links WHERE nick = 'bitbonsai'").get() as { code_hash: string; attempts: number };
  expect(row.code_hash).toHaveLength(64);
  expect(row.attempts).toBe(0);
});

test("the right code signs in, verifies the account, burns the link, and returns a safe next", async () => {
  const tokenHash = mint("igor", "042917");
  const response = await post({ email: "Igor@Example.com", code: "042 917", next: "/open-chat" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ next: "/open-chat" });
  expect(response.headers.get("set-cookie")).toContain("slirc_session=");
  // Non-httpOnly slirc_acct rides along on every sign-in so the PWA can check a cached snapshot
  // belongs to this account before painting it (shared-device leak, .plans/instant.md stage 1).
  const setCookie = response.headers.get("set-cookie") || "";
  expect(setCookie).toContain("slirc_acct=igor");
  expect(setCookie).not.toMatch(/slirc_acct=[^;]*;[^,]*HttpOnly/i);
  expect((db.query("SELECT verified_at FROM accounts WHERE nick = 'igor'").get() as { verified_at: number }).verified_at).toBeGreaterThan(0);
  expect(db.query("SELECT 1 FROM magic_links WHERE token_hash = ?").get(tokenHash)).toBeNull();
  expect(db.query("SELECT 1 FROM used_magic_links WHERE token_hash = ?").get(tokenHash)).not.toBeNull();
  // The link that was mailed with the code reports itself used, so a phone polling it moves on.
  const status = await (await app.request(`/auth/link-status?token=tok-igor-042917`)).json();
  expect(status.used).toBe(true);
});

test("logout clears both slirc_session and slirc_acct", async () => {
  mint("igor", "055055");
  const signedIn = await post({ email: "igor@example.com", code: "055055" });
  const sessionToken = signedIn.headers.get("set-cookie")?.match(/slirc_session=([^;]+)/)?.[1];
  const response = await app.request("/auth/logout", { method: "POST", headers: { Cookie: `slirc_session=${sessionToken}` } });
  expect(response.status).toBe(204);
  const cleared = response.headers.get("set-cookie") || "";
  expect(cleared).toContain("slirc_session=;");
  expect(cleared).toContain("slirc_acct=;");
});

test("an unsafe next falls back to the root", async () => {
  mint("igor", "111111");
  expect(await (await post({ email: "igor@example.com", code: "111111", next: "https://evil.example" })).json()).toEqual({ next: "/" });
});

test("wrong codes count against the row and five of them burn it", async () => {
  const tokenHash = mint("igor", "222222");
  for (let i = 0; i < 4; i++) expect((await post({ email: "igor@example.com", code: "000000" })).status).toBe(400);
  expect((db.query("SELECT attempts FROM magic_links WHERE token_hash = ?").get(tokenHash) as { attempts: number }).attempts).toBe(4);
  expect((await post({ email: "igor@example.com", code: "000000" })).status).toBe(400);
  expect(db.query("SELECT 1 FROM magic_links WHERE token_hash = ?").get(tokenHash)).toBeNull();
  const late = await post({ email: "igor@example.com", code: "222222" });
  expect(late.status).toBe(400);
  expect(await late.json()).toEqual(rejected);
  expect(db.query("SELECT 1 FROM sessions WHERE nick = 'igor'").get()).toBeNull();
});

test("expired rows, unknown emails, and malformed codes never sign in", async () => {
  mint("igor", "333333", -1);
  expect((await post({ email: "igor@example.com", code: "333333" })).status).toBe(400);
  expect((await post({ email: "nobody@example.com", code: "333333" })).status).toBe(400);
  expect((await post({ email: "igor@example.com", code: "33" })).status).toBe(400);
  expect((await post({})).status).toBe(400);
  expect(db.query("SELECT 1 FROM sessions").get()).toBeNull();
});

test("one address gets twenty tries an hour", async () => {
  mint("igor", "444444");
  for (let i = 0; i < 20; i++) await post({ email: "igor@example.com", code: "999999" }, "9.9.9.9");
  expect((await post({ email: "igor@example.com", code: "444444" }, "9.9.9.9")).status).toBe(429);
});

test("unknown address, no live code and a wrong code get one answer", async () => {
  mint("igor", "666666");
  const answers = [
    await post({ email: "nobody@example.com", code: "666666" }),
    await post({ email: "owner@example.com", code: "666666" }), // account exists, no code requested
    await post({ email: "igor@example.com", code: "000000" }),
    await post({ email: "igor@example.com", code: "66" }),
  ];
  for (const answer of answers) {
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual(rejected);
    expect(answer.headers.get("set-cookie")).toBeNull();
  }
});

test("a cross-site or header-less post is refused and does not spend the code", async () => {
  mint("igor", "777777");
  const body = JSON.stringify({ email: "igor@example.com", code: "777777" });
  const json = { "Content-Type": "application/json" };
  for (const headers of [
    json,
    { ...json, Origin: "https://app.example.test" },
    { ...json, "X-Slirc-Sign-In": "1" },
    { ...json, Origin: "https://evil.example", "X-Slirc-Sign-In": "1" },
    { "Content-Type": "text/plain", Origin: "https://app.example.test", "X-Slirc-Sign-In": "1" },
  ]) {
    const refused = await app.request("/auth/code", { method: "POST", headers, body });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();
  }
  expect((db.query("SELECT attempts FROM magic_links WHERE nick = 'igor'").get() as { attempts: number }).attempts).toBe(0);
  expect((await post({ email: "igor@example.com", code: "777777" })).status).toBe(200);
});

test("a pasted email with outer whitespace and a code with spaces still sign in", async () => {
  const requested = await app.request("/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "  owner@example.com\n" }) });
  expect(requested.status).toBe(204);
  await settleSignIns();
  expect(db.query("SELECT 1 FROM magic_links WHERE nick = 'bitbonsai' AND code_hash IS NOT NULL").get()).toBeTruthy();
  mint("igor", "320245");
  const response = await post({ email: " igor@example.com ", code: " 320 245 " });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("slirc_session=");
});
