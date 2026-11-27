import "./fixture.ts";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
const { db } = await import("../src/db.ts");
const { accountByNick, markVerified } = await import("../src/accounts.ts");
markVerified("bitbonsai");
const { app } = await import("../src/server.ts");
afterAll(() => db.close());
const token = "settings-local-fixture";
const id = createHash("sha256").update(token).digest("hex");
db.query("INSERT INTO sessions (token_hash, nick, device, created_at) VALUES (?, 'bitbonsai', 'Local settings fixture', ?)").run(id, Date.now());
const accountId = accountByNick("bitbonsai")!.id;
const headers = { "Content-Type": "application/json", Cookie: `slirc_session=${token}` };
const save = (body: unknown, authenticated = true) => app.request("/push/preference", { method: "POST", headers: authenticated ? headers : { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("notification preference requires identity and valid input, and Off needs no subscription", async () => {
  expect((await save({ accountId, preference: "none" }, false)).status).toBe(401);
  expect((await save(null)).status).toBe(400);
  expect((await save({ accountId, preference: "invalid" })).status).toBe(400);
  expect((await save({ accountId: "old-account", preference: "none" })).status).toBe(409);
  expect((await save({ accountId, preference: "none" })).status).toBe(204);
  expect(await (await app.request("/push/preference", { headers })).json()).toEqual({ preference: "none" });
  expect((db.query("SELECT COUNT(*) AS count FROM subscriptions").get() as { count: number }).count).toBe(0);
  expect((await app.request("/push/subscribe", { method: "POST", headers, body: JSON.stringify({ accountId: "old-account" }) })).status).toBe(409);
});

test("notification status does not claim another owner's subscription", async () => {
  const endpoint = "https://push.example.test/other-local-fixture";
  db.query("INSERT INTO subscriptions (endpoint, nick, p256dh, auth, preference, updated_at) VALUES (?, 'unrelated-fixture', 'fixture', 'fixture', 'all', ?)").run(endpoint, Date.now());
  const fingerprint = createHash("sha256").update(endpoint).digest("hex");
  expect(await (await app.request(`/push/preference?subscription=${fingerprint}`, { headers })).json()).toEqual({ preference: "none", subscribed: false });
});

test("the iPhone app stores its device token per account, only once APNs is set up", async () => {
  const device = "ab".repeat(32);
  const register = (body: unknown, authenticated = true) => app.request("/push/native", { method: "POST", headers: authenticated ? headers : { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const fingerprint = createHash("sha256").update(device).digest("hex");
  expect((await register({ accountId, token: device, environment: "sandbox" }, false)).status).toBe(401);
  expect((await register({ accountId: "old-account", token: device, environment: "sandbox" })).status).toBe(409);
  expect((await register({ accountId, token: "not-hex", environment: "sandbox" })).status).toBe(400);
  expect((await register({ accountId, token: device, environment: "staging" })).status).toBe(400);
  expect((await register({ accountId, token: device, environment: "sandbox" })).status).toBe(503);
  expect(await (await app.request(`/push/preference?device=${fingerprint}`, { headers })).json()).toMatchObject({ subscribed: false, apns: false });
  const { generateKeyPairSync } = await import("node:crypto");
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  Object.assign(process.env, { APNS_KEY: pem, APNS_KEY_ID: "KEYFIXTURE", APNS_TEAM_ID: "TEAMFIXTURE", APNS_TOPIC: "com.example.slirc.app" });
  try {
    await save({ accountId, preference: "none" });
    expect((await register({ accountId, token: device, environment: "sandbox" })).status).toBe(204);
    expect(await (await app.request(`/push/preference?device=${fingerprint}`, { headers })).json()).toEqual({ preference: "all", subscribed: true, apns: true });
    // Another owner's phone is never reported as this account's.
    const other = "cd".repeat(32);
    db.query("INSERT INTO native_devices (token, nick, environment, updated_at) VALUES (?, 'unrelated-fixture', 'sandbox', ?)").run(other, Date.now());
    const otherPrint = createHash("sha256").update(other).digest("hex");
    expect(await (await app.request(`/push/preference?device=${otherPrint}`, { headers })).json()).toMatchObject({ subscribed: false });
  } finally {
    for (const key of ["APNS_KEY", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_TOPIC"]) delete process.env[key];
    await save({ accountId, preference: "none" });
  }
});

test("other-session removal cannot revoke the current browser or another owner's session", async () => {
  expect((await app.request(`/api/sessions/${id}?other=1`, { method: "DELETE", headers })).status).toBe(409);
  expect(db.query("SELECT token_hash FROM sessions WHERE token_hash = ?").get(id)).toBeTruthy();
  const other = "b".repeat(64);
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'unrelated-fixture', ?)").run(other, Date.now());
  expect((await app.request(`/api/sessions/${other}?other=1`, { method: "DELETE", headers })).status).toBe(404);
  expect(db.query("SELECT token_hash FROM sessions WHERE token_hash = ?").get(other)).toBeTruthy();
});
