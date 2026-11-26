// SEC-01 (stored thread URL) and SEC-06 (sign-in request abuse), plus the stable account identity
// exposed to the client cache. One Bun process, isolated in-memory DB, no network.
//
// Existing guest/email routes already have their own coverage (embed-guests.test.ts,
// email-invites.test.ts) and are not changed here.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";

// Threads are created through the server's own provisioning; the Ergo half is stubbed.
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, createThreadChannel: async () => {} }));
const realAccounts = await import("../src/accounts.ts");
mock.module("../src/accounts.ts", () => ({ ...realAccounts, ircChannelExists: async () => false }));

const ORIGIN = "https://app.example.test";
// Thread URLs resolve against configuration, never the request Host.
const savedOrigin = process.env.APP_ORIGIN;
process.env.APP_ORIGIN = ORIGIN;

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const { addressBucket, createLimiter, resetRateLimits, threadUrl } = await import("../src/request-security.ts");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const auth = (token: string, extra: Record<string, string> = {}) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json", ...extra });
const peer = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 0 }) });

beforeEach(() => {
  resetRateLimits();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM threads").run();
  db.query("DELETE FROM channel_members WHERE channel = '#room'").run();
  db.query("DELETE FROM channels WHERE channel = '#room'").run();
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#room', 'bitbonsai', 'secret', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#room', 'bitbonsai')").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(hash("owner-session"), Date.now());
});

afterAll(() => {
  if (savedOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = savedOrigin;
});

describe("topic control characters", () => {
  const setTopic = (topic: string) => app.request("/api/channels/room", {
    method: "PATCH",
    headers: auth("owner-session"),
    body: JSON.stringify({ action: "topic", topic, source: "irc" }),
  });

  test("a topic with CR/LF, NUL, a bell, a tab, or DEL is refused and not stored", async () => {
    for (const topic of ["hello\r\nSAMODE #room +o evil", "a\0b", "ding\x07", "a\tb", "a\x7fb"]) {
      const response = await setTopic(topic);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Topic can't contain control characters." });
    }
    expect((db.query("SELECT topic FROM channels WHERE channel = '#room'").get() as { topic: string | null }).topic ?? "").toBe("");
  });

  test("a plain topic, including non-ASCII text, is still accepted", async () => {
    expect((await setTopic("Release plan — v2 🚀")).status).toBe(200);
    expect((db.query("SELECT topic FROM channels WHERE channel = '#room'").get() as { topic: string }).topic).toBe("Release plan — v2 🚀");
  });
});

describe("thread url validation", () => {
  test("rejects javascript, data, protocol-relative, userinfo, foreign, lookalike, and controls", () => {
    expect(threadUrl("javascript:alert(1)", ORIGIN)).toBe("");
    expect(threadUrl("data:text/html,hi", ORIGIN)).toBe("");
    expect(threadUrl("//evil.example/room", ORIGIN)).toBe("");
    expect(threadUrl("/\\evil.example/room", ORIGIN)).toBe("");
    expect(threadUrl("https://app.example.test@evil.example/room", ORIGIN)).toBe("");
    expect(threadUrl("https://user:pass@app.example.test/room", ORIGIN)).toBe("");
    expect(threadUrl("https://app.example.test.evil.example/room", ORIGIN)).toBe("");
    expect(threadUrl("https://evil.example/room", ORIGIN)).toBe("");
    expect(threadUrl(`blob:${ORIGIN}/uuid`, ORIGIN)).toBe("");
    expect(threadUrl("/ro\u0000om", ORIGIN)).toBe("");
    expect(threadUrl("/ro\nom", ORIGIN)).toBe("");
  });
});

describe("cache identity", () => {
  test("/auth/me exposes accountId and peer ids without credentials", async () => {
    const accountId = (db.query("SELECT account_id FROM accounts WHERE nick = 'bitbonsai'").get() as { account_id: string }).account_id;
    const response = await app.request("/auth/me", { headers: auth("owner-session") });
    const body = await response.json() as { accountId: string; accountDetails: { id: string; nick: string }[]; nick: string };
    expect(body.accountId).toBe(accountId);
    expect(body.accountDetails.find((detail) => detail.nick === "bitbonsai")?.id).toBe(accountId);
    expect(JSON.stringify(body)).not.toContain("ircPassword");
  });
});

test("saved availability and badge reach authorized data without exposing help participants", async () => {
  const previous = db.query("SELECT availability, badge FROM profiles WHERE account = 'bitbonsai'").get() as { availability: string; badge: string } | null;
  db.query("INSERT INTO profiles (account, availability, badge) VALUES ('bitbonsai', 'Busy', 'focus') ON CONFLICT(account) DO UPDATE SET availability = excluded.availability, badge = excluded.badge").run();
  try {
    const me = await (await app.request("/auth/me", { headers: auth("owner-session") })).json();
    expect(me.accountDetails.find((row: { nick: string }) => row.nick === "bitbonsai")?.availability).toBe("Busy");
    expect(me.accountDetails.find((row: { nick: string }) => row.nick === "bitbonsai")?.badge).toBe("focus");
    const members = await (await app.request("/api/channels/%23room/members", { headers: auth("owner-session") })).json();
    expect(members.members.find((row: { nick: string }) => row.nick === "bitbonsai")?.availability).toBe("Busy");
    expect(members.members.find((row: { nick: string }) => row.nick === "bitbonsai")?.badge).toBe("focus");
    expect((await app.request("/api/channels/%23room/members")).status).toBe(401);
    const help = await (await app.request("/api/channels/%23help/members", { headers: auth("owner-session") })).json();
    expect(help.members).toEqual([]);
  } finally {
    if (previous) db.query("UPDATE profiles SET availability = ?, badge = ? WHERE account = 'bitbonsai'").run(previous.availability, previous.badge);
    else db.query("DELETE FROM profiles WHERE account = 'bitbonsai'").run();
  }
});

test("Profile badge saves, survives legacy edits and reload, and rejects invalid or unsigned writes", async () => {
  const patch = (body: unknown, signedIn = true) => app.request("/profile", {
    method: "PATCH", headers: signedIn ? auth("owner-session") : { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const fields = { fullName: "Fixture owner", availability: "Out of office until Monday", about: "" };
  expect((await patch({ ...fields, badge: "vacation" }, false)).status).toBe(401);
  for (const badge of ["away", "available", "busy", "focus", "break", "resting", "vacation", ""]) {
    const saved = await patch({ ...fields, badge });
    expect(saved.status).toBe(200);
    expect((await saved.json()).badge).toBe(badge);
  }
  await patch({ ...fields, badge: "vacation" });
  expect((await (await patch(fields)).json()).badge).toBe("vacation");
  for (const badge of ["<img>", "constructor", 1, null, {}]) {
    expect((await patch({ ...fields, badge })).status).toBe(400);
  }
  expect((await patch(null)).status).toBe(400);
  const me = await (await app.request("/auth/me", { headers: auth("owner-session") })).json();
  expect(me.profile.badge).toBe("vacation");
  expect(me.profile.availability).toBe(fields.availability);
  const accountId = me.accountId;
  expect((await patch({ badge: "busy", accountId: "old-account" })).status).toBe(409);
  const statusOnly = await patch({ badge: "busy", accountId });
  expect(statusOnly.status).toBe(200);
  const updated = await statusOnly.json();
  expect(updated.badge).toBe("busy");
  expect(updated.fullName).toBe(fields.fullName);
  expect(updated.availability).toBe(fields.availability);
});

describe("sign-in rate limits", () => {
  const requestLink = (email: string, extra: Record<string, string> = {}, env?: unknown) => app.request("/auth/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify({ email }),
  }, env as never);
  const postCode = (email: string, extra: Record<string, string> = {}, env?: unknown) => app.request("/auth/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Sign-In": "1", ...extra },
    body: JSON.stringify({ email, code: "000000" }),
  }, env as never);

  test("ten requests from the local bucket an hour, then 429", async () => {
    for (let i = 0; i < 10; i++) expect((await requestLink(`a${i}@example.com`)).status).toBe(204);
    expect((await requestLink("blocked@example.com")).status).toBe(429);
  });

  test("spoofed X-Forwarded-For and X-Real-IP cannot split the local bucket", async () => {
    for (let i = 0; i < 10; i++) expect((await requestLink(`x${i}@example.com`, { "X-Forwarded-For": `10.0.0.${i}` })).status).toBe(204);
    expect((await requestLink("xff@example.com", { "X-Forwarded-For": "203.0.113.9" })).status).toBe(429);
    expect((await requestLink("xreal@example.com", { "X-Real-IP": "203.0.113.9" })).status).toBe(429);
  });

  test("a trusted peer uses only the last valid forwarded hop", async () => {
    process.env.SLIRC_TRUSTED_PROXIES = "10.10.0.1";
    try {
      for (let i = 0; i < 10; i++) expect((await requestLink(`t${i}@example.com`, { "X-Forwarded-For": `1.1.1.1, 198.51.100.7` }, peer("10.10.0.1"))).status).toBe(204);
      expect((await requestLink("same-hop@example.com", { "X-Forwarded-For": "9.9.9.9, 198.51.100.7" }, peer("10.10.0.1"))).status).toBe(429);
      // A different last hop is a different budget even from the same trusted proxy.
      expect((await requestLink("other-hop@example.com", { "X-Forwarded-For": "1.1.1.1, 198.51.100.8" }, peer("10.10.0.1"))).status).toBe(204);
    } finally {
      delete process.env.SLIRC_TRUSTED_PROXIES;
    }
  });

  test("a trusted peer seen as an IPv4-mapped address still counts as trusted", async () => {
    process.env.SLIRC_TRUSTED_PROXIES = "10.10.0.1";
    try {
      for (let i = 0; i < 10; i++) expect((await requestLink(`m${i}@example.com`, { "X-Forwarded-For": "198.51.100.20" }, peer("::ffff:10.10.0.1"))).status).toBe(204);
      expect((await requestLink("mapped-same@example.com", { "X-Forwarded-For": "198.51.100.20" }, peer("::ffff:10.10.0.1"))).status).toBe(429);
      expect((await requestLink("mapped-other@example.com", { "X-Forwarded-For": "198.51.100.21" }, peer("::ffff:10.10.0.1"))).status).toBe(204);
    } finally {
      delete process.env.SLIRC_TRUSTED_PROXIES;
    }
  });

  test("an untrusted peer's forwarded headers are ignored", async () => {
    process.env.SLIRC_TRUSTED_PROXIES = "10.10.0.1";
    try {
      for (let i = 0; i < 10; i++) expect((await requestLink(`u${i}@example.com`, { "X-Forwarded-For": `198.51.100.${i + 1}` }, peer("10.10.0.2"))).status).toBe(204);
      expect((await requestLink("untrusted@example.com", { "X-Forwarded-For": "198.51.100.99" }, peer("10.10.0.2"))).status).toBe(429);
    } finally {
      delete process.env.SLIRC_TRUSTED_PROXIES;
    }
  });

  test("many peers cannot flood one mailbox", async () => {
    process.env.SLIRC_TRUSTED_PROXIES = "10.10.0.1";
    try {
      for (let i = 0; i < 5; i++) expect((await requestLink("target@example.com", { "X-Forwarded-For": `203.0.113.${i + 1}` }, peer("10.10.0.1"))).status).toBe(204);
      expect((await requestLink("target@example.com", { "X-Forwarded-For": "203.0.113.200" }, peer("10.10.0.1"))).status).toBe(429);
    } finally {
      delete process.env.SLIRC_TRUSTED_PROXIES;
    }
  });

  test("the request limit expires after its window", async () => {
    const base = Date.now();
    setSystemTime(base);
    try {
      for (let i = 0; i < 10; i++) expect((await requestLink(`w${i}@example.com`)).status).toBe(204);
      expect((await requestLink("window@example.com")).status).toBe(429);
      setSystemTime(base + 60 * 60_000 + 1_000);
      expect((await requestLink("window@example.com")).status).toBe(204);
    } finally {
      setSystemTime();
    }
  });

  test("/auth/code keeps twenty attempts an hour and ignores spoofed headers", async () => {
    for (let i = 0; i < 20; i++) expect((await postCode("nobody@example.com", { "X-Forwarded-For": `10.1.0.${i}` })).status).toBe(400);
    expect((await postCode("nobody@example.com", { "X-Forwarded-For": "10.1.0.200" })).status).toBe(429);
  });
});

describe("limiter memory bound", () => {
  test("evicts the oldest key at the cap instead of refusing, reclaims after expiry, and stays bounded", () => {
    const limiter = createLimiter({ limit: 2, windowMs: 1_000, maxKeys: 2 });
    const t0 = 1_000_000;
    expect(limiter.check("a", t0)).toBe(true);
    expect(limiter.check("b", t0)).toBe(true);
    // Full of live keys: a new key still gets in, the oldest goes, and the map stays at the cap.
    expect(limiter.check("c", t0)).toBe(true);
    expect(limiter.size()).toBe(2);
    expect(limiter.check("b", t0)).toBe(true);
    expect(limiter.check("b", t0)).toBe(false);
    // Once the window passes, the sweep reclaims the old keys.
    expect(limiter.check("d", t0 + 2_000)).toBe(true);
    expect(limiter.size()).toBe(1);
  });

  test("IPv6 addresses share one bucket per /64; IPv4 and mapped IPv4 stay per address", () => {
    expect(addressBucket("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:0db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressBucket("::1")).toBe("0:0:0:0::/64");
    expect(addressBucket("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(addressBucket("192.0.2.7")).toBe("192.0.2.7");
  });
});
