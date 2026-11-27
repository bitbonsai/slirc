import "./fixture.ts";
import { expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { apnsConfig } from "../src/config.ts";
import { apnsPayload, apnsToken, deadToken, isApnsToken, sendApns } from "../src/apns.ts";

// A throwaway P-256 key made for this run, shaped like an Apple .p8 file.
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = { APNS_KEY: pem, APNS_KEY_ID: "KEYFIXTURE", APNS_TEAM_ID: "TEAMFIXTURE", APNS_TOPIC: "com.example.slirc.app" };

test("APNs stays off until the key, key ID, team ID and topic are all set", () => {
  expect(apnsConfig({})).toBeNull();
  expect(apnsConfig({ ...env, APNS_KEY_ID: "" })).toBeNull();
  expect(apnsConfig({ ...env, APNS_TOPIC: " " })).toBeNull();
  expect(apnsConfig({ ...env, APNS_KEY: "not a key" })).toBeNull();
  expect(apnsConfig(env)?.keyId).toBe("KEYFIXTURE");
  // One env line with \n escapes reads as the same key.
  expect(apnsConfig({ ...env, APNS_KEY: pem.trim().replace(/\n/g, "\\n") })?.key).toBe(pem.trim());
});

test("the provider token is an ES256 JWT Apple can verify, reused for 40 minutes", () => {
  const config = apnsConfig(env)!;
  const now = 1_800_000_000_000;
  const token = apnsToken(config, now);
  const [header, claims, signature] = token.split(".");
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEYFIXTURE" });
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: "TEAMFIXTURE", iat: now / 1000 });
  const ok = verify("sha256", Buffer.from(`${header}.${claims}`), { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"));
  expect(ok).toBe(true);
  expect(apnsToken(config, now + 39 * 60_000)).toBe(token);
  expect(apnsToken(config, now + 41 * 60_000)).not.toBe(token);
});

test("the payload names the workspace and route, and keeps long text under Apple's limit", () => {
  const payload = apnsPayload({ title: "ada in #general", body: "x".repeat(5000), url: "/#general", origin: "https://team.example.test", thread: "#general" });
  expect(payload.origin).toBe("https://team.example.test");
  expect(payload.url).toBe("/#general");
  expect(payload.aps.alert.title).toBe("ada in #general");
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4096);
});

test("only tokens Apple calls dead are dropped", () => {
  expect(deadToken(410, "Unregistered")).toBe(true);
  expect(deadToken(400, "BadDeviceToken")).toBe(true);
  expect(deadToken(400, "DeviceTokenNotForTopic")).toBe(true);
  expect(deadToken(429, "TooManyRequests")).toBe(false);
  expect(deadToken(403, "ExpiredProviderToken")).toBe(false);
  expect(deadToken(0, "timeout")).toBe(false);
});

test("device tokens are hex, and sending without APNs set up does nothing", async () => {
  expect(isApnsToken("ab".repeat(32))).toBe(true);
  expect(isApnsToken("zz".repeat(32))).toBe(false);
  expect(isApnsToken("ab")).toBe(false);
  expect(await sendApns({ token: "ab".repeat(32), environment: "sandbox" }, {}, "tag", null)).toEqual({ status: 0, reason: "not configured" });
});
