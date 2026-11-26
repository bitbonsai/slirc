import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";

// serveStatic and the shell resolve "./public" from the cwd.
process.chdir(new URL("..", import.meta.url).pathname);

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const { subscribe } = await import("../src/live.ts");
const { resetRateLimits } = await import("../src/request-security.ts");

const origin = "https://app.example.test";
const ownerToken = "owner-session";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const same = { Origin: origin, "X-Slirc-Pair": "1" };
const signedIn = (token = ownerToken) => ({ ...same, Cookie: `slirc_session=${token}` });

const mint = (headers: Record<string, string> = signedIn()) => app.request("/api/pair/offer", { method: "POST", headers });
const redeem = (token: unknown, headers: Record<string, string> = same) => app.request("/api/pair/offer/redeem", {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": iphone, ...headers },
  body: JSON.stringify({ token }),
});
async function minted(headers?: Record<string, string>) {
  const response = await mint(headers);
  expect(response.status).toBe(201);
  const body = await response.json() as { id: string; url: string; expiresAt: number };
  return { ...body, token: new URLSearchParams(new URL(body.url).hash.slice(1)).get("o")! };
}
const sessions = () => (db.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count;
const cookieToken = (response: Response) => response.headers.getSetCookie().find((cookie) => cookie.startsWith("slirc_session="))?.match(/^slirc_session=([^;]+)/)?.[1];

beforeEach(() => {
  resetRateLimits();
  db.query("DELETE FROM pair_offers").run();
  db.query("DELETE FROM pair_requests").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM accounts WHERE nick <> 'bitbonsai'").run();
  db.query("UPDATE accounts SET kind = 'human', verified_at = 1 WHERE nick = 'bitbonsai'").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sha(ownerToken), Date.now());
});

describe("minting", () => {
  test("a signed-in verified human gets a pair link with the token in the fragment", async () => {
    const before = Date.now();
    const response = await mint();
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as { id: string; url: string; expiresAt: number };
    const url = new URL(body.url);
    expect(url.origin + url.pathname + url.search).toBe(`${origin}/pair`);
    expect(url.hash).toMatch(/^#o=[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test("signed-out and unknown sessions are refused", async () => {
    expect((await mint(same)).status).toBe(401);
    expect((await mint(signedIn("not-a-session"))).status).toBe(401);
    expect(db.query("SELECT COUNT(*) AS count FROM pair_offers").get()).toEqual({ count: 0 });
  });

  test("agents, bots and unverified accounts cannot mint", async () => {
    for (const change of ["kind = 'agent'", "kind = 'bot'", "verified_at = NULL"]) {
      db.query("UPDATE accounts SET kind = 'human', verified_at = 1 WHERE nick = 'bitbonsai'").run();
      db.query(`UPDATE accounts SET ${change} WHERE nick = 'bitbonsai'`).run();
      expect((await mint()).status).toBe(401);
    }
    expect(db.query("SELECT COUNT(*) AS count FROM pair_offers").get()).toEqual({ count: 0 });
  });

  test("cross-site, header-less and origin-less requests are refused on every offer route", async () => {
    const cookie = { Cookie: `slirc_session=${ownerToken}` };
    const offer = await minted();
    for (const headers of [{ ...cookie, Origin: "https://evil.example", "X-Slirc-Pair": "1" }, { ...cookie, Origin: origin }, { ...cookie, "X-Slirc-Pair": "1" }, cookie]) {
      expect((await mint(headers)).status).toBe(403);
      expect((await redeem(offer.token, headers)).status).toBe(403);
      expect((await app.request("/api/pair/offer", { method: "DELETE", headers })).status).toBe(403);
      expect((await app.request(`/api/pair/offer/${offer.id}/session`, { method: "DELETE", headers })).status).toBe(403);
    }
    expect((await redeem(offer.token)).status).toBe(200);
  });

  test("minting is rate limited per account", async () => {
    for (let index = 0; index < 60; index++) expect((await mint()).status).toBe(201);
    const refused = await mint();
    expect(refused.status).toBe(429);
    expect(db.query("SELECT COUNT(*) AS count FROM pair_offers").get()).toEqual({ count: 1 });
  });

  test("cancelling removes this session's offer", async () => {
    const offer = await minted();
    expect((await app.request("/api/pair/offer", { method: "DELETE", headers: same })).status).toBe(401);
    expect((await app.request("/api/pair/offer", { method: "DELETE", headers: signedIn() })).status).toBe(204);
    expect((await redeem(offer.token)).status).toBe(400);
  });
});

describe("redeeming", () => {
  test("a signed-out browser is signed in as the minting account and the minter is told", async () => {
    const events: { event: string; data: unknown }[] = [];
    const unsubscribe = subscribe("bitbonsai", (event, data) => events.push({ event, data }));
    const offer = await minted();
    const response = await redeem(offer.token);
    unsubscribe();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ signedIn: true, accountId: expect.stringMatching(/^[a-f0-9]{32}$/), nick: "bitbonsai" });
    const token = cookieToken(response)!;
    expect(db.query("SELECT nick, device FROM sessions WHERE token_hash = ?").get(sha(token))).toEqual({ nick: "bitbonsai", device: "Safari · iOS" });
    expect(response.headers.getSetCookie().find((cookie) => cookie.startsWith("slirc_session="))).toMatch(/HttpOnly/i);
    // Browser and OS only: no token, no session id, no address.
    expect(events).toEqual([{ event: "pair-offer", data: { id: offer.id, browser: "Safari", os: "iOS" } }]);
    expect(await (await app.request("/auth/me", { headers: { Cookie: `slirc_session=${token}` } })).json()).toMatchObject({ nick: "bitbonsai" });
  });

  test("a browser that is already signed in keeps its session and does not spend the offer", async () => {
    db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('ana', 'ana@example.com', 'member', 1, 1)").run();
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'ana', ?)").run(sha("ana-session"), Date.now());
    const offer = await minted();
    const response = await redeem(offer.token, { ...same, Cookie: "slirc_session=ana-session" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: true, already: true });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(sessions()).toBe(2);
    expect(db.query("SELECT status FROM pair_offers").get()).toEqual({ status: "pending" });
    // A stale cookie is not a session: that browser can still pair.
    expect((await redeem(offer.token, { ...same, Cookie: "slirc_session=revoked" })).status).toBe(200);
    expect(db.query("SELECT nick FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1").get()).toEqual({ nick: "bitbonsai" });
  });

  test("unknown, expired, used, cancelled and orphaned tokens all get the same answer", async () => {
    const used = await minted();
    expect((await redeem(used.token)).status).toBe(200);
    const expired = await minted();
    db.query("UPDATE pair_offers SET expires_at = ? WHERE id = ?").run(Date.now() - 1, expired.id);
    const replaced = await minted();
    const cancelled = await minted();
    await app.request("/api/pair/offer", { method: "DELETE", headers: signedIn() });
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sha("second"), Date.now());
    const orphaned = await minted(signedIn("second"));
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha("second"));
    const before = sessions();
    const answers = new Set<string>();
    for (const token of ["A".repeat(43), used.token, expired.token, replaced.token, cancelled.token, orphaned.token, "", "short", 42, null]) {
      const response = await redeem(token);
      expect(response.headers.getSetCookie()).toEqual([]);
      answers.add(`${response.status} ${await response.text()}`);
    }
    expect([...answers]).toEqual([`400 ${JSON.stringify({ error: "That code is no longer valid. Show a new one and scan again." })}`]);
    expect(sessions()).toBe(before);
  });

  test("a malformed body is refused the same way", async () => {
    const response = await app.request("/api/pair/offer/redeem", { method: "POST", headers: { ...same, "Content-Type": "application/json" }, body: "{" });
    expect(response.status).toBe(400);
    expect(sessions()).toBe(1);
  });

  test("two redeems at once give one session", async () => {
    const offer = await minted();
    const responses = await Promise.all([redeem(offer.token), redeem(offer.token), redeem(offer.token)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400, 400]);
    expect(sessions()).toBe(2);
  });

  test("redeeming is rate limited per peer and failures count", async () => {
    for (let index = 0; index < 20; index++) expect((await redeem("A".repeat(43))).status).toBe(400);
    const offer = await minted();
    const refused = await redeem(offer.token);
    expect(refused.status).toBe(429);
    expect(sessions()).toBe(1);
  });

  test("the token never reaches the log", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => { lines.push(parts.join(" ")); });
    const error = spyOn(console, "error").mockImplementation((...parts: unknown[]) => { lines.push(parts.join(" ")); });
    try {
      const offer = await minted();
      await redeem("B".repeat(43), { ...same, "User-Agent": "account=admin <script> Safari/1 (iPhone)" });
      await redeem(offer.token);
      await redeem(offer.token);
      expect(lines).toEqual([
        "pair offer refused device=Safari/iOS",
        "pair offer redeemed account=bitbonsai device=Safari/iOS",
        "pair offer refused device=Safari/iOS",
      ]);
      expect(lines.join("\n")).not.toContain(offer.token);
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});

describe("the pair page", () => {
  test("GET /pair serves the shell and signs nobody in, with or without a token", async () => {
    const offer = await minted();
    for (const path of ["/pair", `/pair?o=${offer.token}`, `/pair?token=${offer.token}`]) {
      const response = await app.request(path, { headers: { "User-Agent": iphone } });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(sessions()).toBe(1);
    expect(db.query("SELECT status FROM pair_offers").get()).toEqual({ status: "pending" });
    // A GET of the API paths cannot spend it either.
    expect((await app.request("/api/pair/offer/redeem")).status).toBe(404);
    expect((await app.request(`/api/pair/offer/redeem?token=${offer.token}`)).status).toBe(404);
    expect((await redeem(offer.token)).status).toBe(200);
  });

  test("the older code link still redirects", async () => {
    const response = await app.request("/pair/482917");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?pair=482917");
  });
});

describe("sign it out", () => {
  test("the minting session ends the session its offer started, and nothing else", async () => {
    const offer = await minted();
    const phone = cookieToken(await redeem(offer.token))!;
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sha("second"), Date.now());
    const path = `/api/pair/offer/${offer.id}/session`;
    expect((await app.request(path, { method: "DELETE", headers: same })).status).toBe(401);
    expect((await app.request(path, { method: "DELETE", headers: signedIn("second") })).status).toBe(404);
    expect((await app.request("/api/pair/offer/unknown/session", { method: "DELETE", headers: signedIn() })).status).toBe(404);
    expect(sessions()).toBe(3);
    expect((await app.request(path, { method: "DELETE", headers: signedIn() })).status).toBe(204);
    expect(db.query("SELECT 1 FROM sessions WHERE token_hash = ?").get(sha(phone))).toBeNull();
    expect(sessions()).toBe(2);
    expect(await (await app.request("/auth/me", { headers: { Cookie: `slirc_session=${phone}` } })).json()).not.toHaveProperty("nick");
    expect((await app.request(path, { method: "DELETE", headers: signedIn() })).status).toBe(404);
  });

  test("the phone cannot use the offer id to sign the desktop out", async () => {
    const offer = await minted();
    const phone = cookieToken(await redeem(offer.token))!;
    expect((await app.request(`/api/pair/offer/${offer.id}/session`, { method: "DELETE", headers: signedIn(phone) })).status).toBe(404);
    expect(sessions()).toBe(2);
  });
});

describe("the sidebar shortcut flag", () => {
  test("/auth/me reports a phone only once a phone session exists", async () => {
    const me = async () => (await (await app.request("/auth/me", { headers: { Cookie: `slirc_session=${ownerToken}` } })).json() as { hasPhone?: boolean }).hasPhone;
    expect(await me()).toBe(false);
    const laptop = await minted();
    await redeem(laptop.token, { ...same, "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15" });
    expect(await me()).toBe(false);
    const phone = await minted();
    await redeem(phone.token);
    expect(await me()).toBe(true);
  });
});
