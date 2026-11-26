import "./fixture.ts";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

const previousCwd = process.cwd();
process.chdir(join(import.meta.dir, ".."));
process.env.APP_ORIGIN = "https://slirc2.example.test";
process.env.MAGIC_LINK_LOG = "true";
process.env.SLIRC_DEV_PROFILE = "slirc2";
process.env.SLIRC_HELPERS_ENABLED = "false";
const quiet = spyOn(console, "log").mockImplementation(() => {});
afterAll(() => { process.chdir(previousCwd); quiet.mockRestore(); });
const { app } = await import("../src/server.ts");
const { db } = await import("../src/db.ts");
const { localDevLinks } = await import("../src/config.ts");
const { resetRateLimits } = await import("../src/request-security.ts");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const auth = { Cookie: "slirc_session=owner-test-session" };
const post = (body: unknown, headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  resetRateLimits();
  for (const table of ["sessions", "pair_requests", "magic_links"]) db.query(`DELETE FROM ${table}`).run();
  db.query("DELETE FROM accounts WHERE nick <> 'bitbonsai'").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(hash("owner-test-session"), Date.now());
  db.query("UPDATE profiles SET avatar_path = 'fixture' WHERE account = 'bitbonsai'").run();
});

test("HTTPS dev links need explicit isolated profile and ignore forged request origin", async () => {
  expect(localDevLinks()).toBe(true);
  delete process.env.SLIRC_DEV_PROFILE;
  expect(localDevLinks()).toBe(false);
  process.env.SLIRC_DEV_PROFILE = "slirc2";
  delete process.env.MAGIC_LINK_LOG;
  expect(localDevLinks()).toBe(false);
  process.env.MAGIC_LINK_LOG = "true";
  const response = await app.request("https://attacker.test/auth/request", post({ email: "owner@example.com", next: "/" }, { Host: "attacker.test", "X-Forwarded-Host": "attacker.test" }));
  expect(response.status).toBe(200);
  const { devLink } = await response.json();
  expect(new URL(devLink).origin).toBe("https://slirc2.example.test");
  const login = await app.request(devLink);
  expect(login.headers.get("location")).toBe("/");
  expect(login.headers.get("set-cookie")).toContain("Secure");
});

test("client entry, pairing and DM paths serve or redirect to the client shell", async () => {
  for (const path of ["/", "/open-chat", "/dm/eve"]) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('x-data="client()"');
  }
  const pair = await app.request("/pair/123456");
  expect(pair.status).toBe(302);
  expect(pair.headers.get("location")).toBe("/?pair=123456");
});

test("every root path serves the client with manifest and worker hook, and the version follows the bundle", async () => {
  const { clientVersion } = await import("../src/server.ts");
  for (const path of ["/", "/dms", "/more", "/open-chat", "/help", "/dm/eve", "/profile", "/invitations", "/join/tok", "/index.html"]) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain('x-data="client()"');
  }
  const root = await (await app.request("/")).text();
  expect(root).toContain('rel="manifest"');
  expect(root).toContain('<script src="/sw-register.js?v=');
  expect((await app.request("/boot.html")).status).toBe(302);
  const worker = await app.request("/sw.js");
  expect(await worker.text()).toContain("LEGACY_CACHE_PREFIX");
  const bundle = await (await app.request("/client.js")).text();
  const { version } = await (await app.request("/api/version")).json();
  expect(version).toBe(clientVersion(bundle));
  expect(clientVersion(`${bundle} `)).not.toBe(version);
});

test("removed client aliases are 404 without a client-selection flag", async () => {
  for (const path of ["/preview", "/preview/dms", "/preview/more", "/preview/profile"]) {
    expect((await app.request(path)).status).toBe(404);
  }
});

test("device pairing preserves account identity, rejects another owner and consumes tokens once", async () => {
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('eve', 'eve@example.test', 'member', ?, ?)").run(Date.now(), Date.now());
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'eve', ?)").run(hash("eve-test-session"), Date.now());
  const ownerId = (db.query("SELECT account_id FROM accounts WHERE nick='bitbonsai'").get() as any).account_id;
  const issued = await app.request("/api/pair", post({ kind: "session", email: "owner@example.com" }));
  expect(issued.status).toBe(201);
  expect(issued.headers.get("cache-control")).toBe("no-store");
  const { code, secret } = await issued.json();
  expect((await app.request(`/api/pair/${code}/allow`, { method: "POST", headers: { ...auth, Origin: "https://attacker.test", Host: "attacker.test" } })).status).toBe(403);
  expect((await app.request(`/api/pair/${code}/allow`, { method: "POST", headers: { Cookie: "slirc_session=eve-test-session" } })).status).toBe(403);
  expect(db.query("SELECT count(*) AS n FROM magic_links").get()).toEqual({ n: 0 });
  expect((await app.request(`/api/pair/${code}/allow`, { method: "POST", headers: auth })).status).toBe(200);
  expect((await app.request(`/api/pair/${code}`, { headers: { "X-Pair-Secret": "wrong" } })).status).toBe(404);
  const delivery = await app.request(`/api/pair/${code}`, { headers: { "X-Pair-Secret": secret } });
  expect(delivery.headers.get("cache-control")).toBe("no-store");
  const { loginToken } = await delivery.json();
  expect(loginToken).toHaveLength(43);
  expect((await app.request(`/api/pair/${code}`, { headers: { "X-Pair-Secret": secret } })).status).toBe(404);
  const path = `/api/pair/${code}/session?token=${encodeURIComponent(loginToken)}`;
  const [login, replay] = await Promise.all([app.request(path), app.request(path)]);
  expect(login.status).toBe(302);
  expect(replay.status).toBe(404);
  expect(login.headers.get("location")).toBe("/");
  const cookie = login.headers.get("set-cookie")!.match(/slirc_session=[^;]+/)![0];
  const me = await (await app.request("/auth/me", { headers: { Cookie: cookie } })).json();
  expect(me.nick).toBe("bitbonsai");
  expect(me.accountId).toBe(ownerId);
  expect((await app.request(path)).status).toBe(404);
  expect(db.query("SELECT nick FROM accounts ORDER BY nick").all()).toEqual([{ nick: "bitbonsai" }, { nick: "eve" }]);
});

test("pairing rejects oversized/invalid bodies and bounds deny-code guessing", async () => {
  expect((await app.request("/api/pair", post(null))).status).toBe(400);
  expect((await app.request("/api/pair", post({ kind: "session", email: "x".repeat(2_048) }))).status).toBe(413);
  expect(db.query("SELECT count(*) AS n FROM pair_requests").get()).toEqual({ n: 0 });
  for (let i = 0; i < 30; i++) {
    expect((await app.request(`/api/pair/${String(i).padStart(6, "0")}/deny`, { method: "POST", headers: auth })).status).toBe(404);
  }
  expect((await app.request("/api/pair/999999/deny", { method: "POST", headers: auth })).status).toBe(429);
});
