import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";

process.chdir(new URL("..", import.meta.url).pathname);

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const { testflightUrl } = await import("../src/testflight.ts");

const JOIN = "https://testflight.apple.com/join/AbC123xy";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const get = (token?: string) => app.request("/api/apps", { headers: token ? { Cookie: `slirc_session=${token}` } : {} });

beforeEach(() => {
  process.env.TESTFLIGHT_URL = JOIN;
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM accounts WHERE nick IN ('ivy', 'una', 'ivy-pi')").run();
  const now = Date.now();
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('ivy', 'ivy@example.com', 'member', 'human', ?, ?)").run(now, now);
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('una', 'una@example.com', 'member', 'human', NULL, ?)").run(now);
  db.query("INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at) VALUES ('ivy-pi', 'ivy-pi@agents.invalid', 'member', 'agent', 'ivy', ?, ?)").run(now, now);
  for (const nick of ["ivy", "una", "ivy-pi"]) db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(hash(`${nick}-session`), nick, now);
});

test("signed out gets 401 and no link", async () => {
  const response = await get();
  expect(response.status).toBe(401);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).not.toContain("testflight");
});

test("a verified human gets the link, never cached", async () => {
  const response = await get("ivy-session");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ testflight: JOIN });
});

test("agents and unverified accounts get 403 and no link", async () => {
  for (const token of ["ivy-pi-session", "una-session"]) {
    const response = await get(token);
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("testflight.apple.com");
  }
});

test("unset or invalid TESTFLIGHT_URL means null", async () => {
  delete process.env.TESTFLIGHT_URL;
  expect(await (await get("ivy-session")).json()).toEqual({ testflight: null });
  process.env.TESTFLIGHT_URL = "http://testflight.apple.com/join/AbC123xy";
  expect(await (await get("ivy-session")).json()).toEqual({ testflight: null });
});

test("only https://testflight.apple.com/join/<code> links count", () => {
  expect(testflightUrl(JOIN)).toBe(JOIN);
  expect(testflightUrl(` ${JOIN} `)).toBe(JOIN);
  for (const bad of [undefined, "", "not a url", "http://testflight.apple.com/join/AbC123xy", "https://evil.example/join/AbC123xy",
    "https://testflight.apple.com.evil.example/join/AbC123xy", "https://testflight.apple.com/v1/app/123", "https://testflight.apple.com/join/",
    "https://testflight.apple.com/join/AbC/extra", "https://user@testflight.apple.com/join/AbC123xy", "https://testflight.apple.com:8443/join/AbC123xy",
    "https://testflight.apple.com/join/AbC123xy?x=1", "https://testflight.apple.com/join/AbC123xy#x", "javascript:alert(1)"]) {
    expect(testflightUrl(bad)).toBeNull();
  }
});
