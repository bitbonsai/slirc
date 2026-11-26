// Multi-instance cross-origin session auth, client bearer tokens, relay upgrade, and CORS rules.
import "./fixture.ts";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleRelayUpgrade, type RelayDeps } from "../src/relay.ts";
import { isAllowedClientOrigin } from "../src/request-security.ts";

const { db } = await import("../src/db.ts");
const { app, sessionByToken } = await import("../src/server.ts");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const ENV_KEYS = ["SLIRC_ALLOWED_CLIENT_ORIGINS", "SLIRC_DEV_PROFILE", "APP_ORIGIN"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  db.query("DELETE FROM client_tokens").run();
  db.query("DELETE FROM sessions").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(
    hash("owner-session"),
    Date.now(),
  );
});

const ORIGIN = "https://app.example.test";
const clientTokenHeaders = (cookie = "owner-session", extra: Record<string, string> = {}) => ({
  Cookie: `slirc_session=${cookie}`,
  Origin: ORIGIN,
  "Content-Type": "application/json",
  "X-Slirc-Client-Token": "1",
  ...extra,
});

describe("POST /auth/client-token and Bearer authentication", () => {
  test("issues a hashed, expiring client bearer token for an authenticated session cookie", async () => {
    const before = Date.now();
    const res = await app.request("/auth/client-token", {
      method: "POST",
      headers: clientTokenHeaders(),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { token: string; nick: string; accountId: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThanOrEqual(32);
    expect(body.nick).toBe("bitbonsai");
    expect(body.accountId).toBeTruthy();

    // Stored hashed with a 30-day expires_at, never plaintext.
    const row = db
      .query("SELECT token_hash, session_hash, nick, expires_at FROM client_tokens WHERE token_hash = ?")
      .get(hash(body.token)) as { token_hash: string; session_hash: string; nick: string; expires_at: number | null } | null;
    expect(row).toMatchObject({
      token_hash: hash(body.token),
      session_hash: hash("owner-session"),
      nick: "bitbonsai",
    });
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(row!.expires_at).toBeGreaterThanOrEqual(before + thirtyDaysMs - 5_000);
    expect(row!.expires_at).toBeLessThanOrEqual(Date.now() + thirtyDaysMs + 5_000);

    // Authenticating /auth/me via Bearer resolves the same account and does not set cookies.
    const meRes = await app.request("/auth/me", {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(meRes.status).toBe(200);
    expect(meRes.headers.get("Set-Cookie")).toBeNull();
    const me = (await meRes.json()) as { authenticated: boolean; nick: string; accountId: string };
    expect(me.authenticated).toBe(true);
    expect(me.nick).toBe("bitbonsai");
    expect(me.accountId).toBe(body.accountId);

    // Bearer tokens are scoped to /auth/me, /auth/logout, and /irc: other routes reject them.
    expect((await app.request("/api/sessions", { headers: { Authorization: `Bearer ${body.token}` } })).status).toBe(401);
    expect((await app.request("/api/projects", { headers: { Authorization: `Bearer ${body.token}` } })).status).toBe(401);
    expect((await app.request("/api/events", { headers: { Authorization: `Bearer ${body.token}` } })).status).toBe(401);

    // Expired client tokens are rejected.
    db.query("UPDATE client_tokens SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1_000, hash(body.token));
    expect(sessionByToken(body.token)).toBeNull();
    const expiredMe = await app.request("/auth/me", {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(((await expiredMe.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });

  test("rejects unauthenticated, missing-Origin, missing-header, and cross-origin token issuance", async () => {
    const noCsrf = await app.request("/auth/client-token", { method: "POST" });
    expect(noCsrf.status).toBe(403);

    const noOrigin = await app.request("/auth/client-token", {
      method: "POST",
      headers: {
        Cookie: "slirc_session=owner-session",
        "Content-Type": "application/json",
        "X-Slirc-Client-Token": "1",
      },
    });
    expect(noOrigin.status).toBe(403);

    const noHeader = await app.request("/auth/client-token", {
      method: "POST",
      headers: {
        Cookie: "slirc_session=owner-session",
        Origin: ORIGIN,
        "Content-Type": "application/json",
      },
    });
    expect(noHeader.status).toBe(403);

    const noCookie = await app.request("/auth/client-token", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        "X-Slirc-Client-Token": "1",
      },
    });
    expect(noCookie.status).toBe(401);

    const crossOrigin = await app.request("/auth/client-token", {
      method: "POST",
      headers: clientTokenHeaders("owner-session", { Origin: "https://evil.example" }),
    });
    expect(crossOrigin.status).toBe(403);
  });

  test("caps active client tokens per session at 10 (evicting oldest) and rate-limits bursts", async () => {
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(
      hash("cap-session"),
      Date.now(),
    );
    const issuedTokens: string[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.request("/auth/client-token", {
        method: "POST",
        headers: clientTokenHeaders("cap-session"),
      });
      expect(res.status).toBe(201);
      issuedTokens.push(((await res.json()) as { token: string }).token);
    }
    const count = (db.query("SELECT COUNT(*) AS n FROM client_tokens WHERE session_hash = ?").get(hash("cap-session")) as { n: number }).n;
    expect(count).toBe(10);
    // Oldest two were evicted; newest remains valid.
    expect(sessionByToken(issuedTokens[0]!)).toBeNull();
    expect(sessionByToken(issuedTokens[1]!)).toBeNull();
    expect(sessionByToken(issuedTokens[11]!)?.nick).toBe("bitbonsai");

    // Exhaust the per-session rate limit (20/min).
    let limited = false;
    for (let i = 0; i < 15; i++) {
      const res = await app.request("/auth/client-token", {
        method: "POST",
        headers: clientTokenHeaders("cap-session"),
      });
      if (res.status === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });

  test("rejects invalid and revoked client tokens", async () => {
    const invalidRes = await app.request("/auth/me", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(invalidRes.status).toBe(200);
    expect(((await invalidRes.json()) as { authenticated: boolean }).authenticated).toBe(false);

    const issued = (await (
      await app.request("/auth/client-token", {
        method: "POST",
        headers: clientTokenHeaders(),
      })
    ).json()) as { token: string };

    // Sign out with session cookie revokes the parent session AND its client tokens.
    const logoutRes = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: "slirc_session=owner-session" },
    });
    expect(logoutRes.status).toBe(204);

    const afterLogout = await app.request("/auth/me", {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(((await afterLogout.json()) as { authenticated: boolean }).authenticated).toBe(false);
    expect(sessionByToken(issued.token)).toBeNull();
  });

  test("revokes a single bearer token via POST /auth/logout with Authorization header", async () => {
    const issued = (await (
      await app.request("/auth/client-token", {
        method: "POST",
        headers: clientTokenHeaders(),
      })
    ).json()) as { token: string };

    const logoutRes = await app.request("/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(logoutRes.status).toBe(204);

    // Bearer token is revoked, while the browser session cookie remains valid.
    expect(sessionByToken(issued.token)).toBeNull();
    expect(sessionByToken("owner-session")?.nick).toBe("bitbonsai");
  });
});

describe("CORS headers for cross-origin client requests", () => {
  test("reflects allowed origins with Allow-Credentials: false only on /auth/me, /auth/logout, and /irc", async () => {
    process.env.SLIRC_ALLOWED_CLIENT_ORIGINS = "https://custom.example.org";

    for (const origin of [
      "https://app.slirc.org",
      "https://team.slirc.app",
      "https://custom.example.org",
    ]) {
      const preflight = await app.request("/auth/me", {
        method: "OPTIONS",
        headers: { Origin: origin },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
      expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type");
      expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBe("false");
      expect(preflight.headers.get("Vary")).toContain("Origin");

      const getRes = await app.request("/auth/me", {
        headers: { Origin: origin },
      });
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(getRes.headers.get("Access-Control-Allow-Credentials")).toBe("false");

      // Other routes must not emit CORS headers even for allowed origins.
      const apiRes = await app.request("/api/projects", {
        headers: { Origin: origin },
      });
      expect(apiRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  test("omits Access-Control-Allow-Origin for disallowed origins", async () => {
    delete process.env.SLIRC_ALLOWED_CLIENT_ORIGINS;
    for (const origin of [
      "https://evil.example",
      "https://evil-slirc.app",
      "https://slirc.app.evil.com",
      "http://app.slirc.org",
      "https://nested.sub.slirc.app",
    ]) {
      const preflight = await app.request("/auth/me", {
        method: "OPTIONS",
        headers: { Origin: origin },
      });
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();

      const getRes = await app.request("/auth/me", {
        headers: { Origin: origin },
      });
      expect(getRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  test("allows http://localhost:* only in dev mode", () => {
    expect(isAllowedClientOrigin("http://localhost:9110", { dev: true })).toBe(true);
    expect(isAllowedClientOrigin("http://localhost:3000", { dev: true })).toBe(true);
    expect(isAllowedClientOrigin("http://localhost:9110", { dev: false })).toBe(false);
    expect(isAllowedClientOrigin("https://localhost:9110", { dev: true })).toBe(false);
  });
});

describe("Cross-origin WebSocket relay upgrade", () => {
  test("accepts Sec-WebSocket-Protocol (echoing it), rejects ?token= query string, and never trusts cookies cross-origin", async () => {
    const issued = (await (
      await app.request("/auth/client-token", {
        method: "POST",
        headers: clientTokenHeaders(),
      })
    ).json()) as { token: string };

    const deps: RelayDeps = {
      sessionByToken,
      ircPasswordFor: () => "unused",
      appOrigin: "https://remote.slirc.app",
      isAllowedClientOrigin: (origin) => isAllowedClientOrigin(origin, { dev: false }),
      ergoHost: "ergo",
      ergoPort: 6667,
      mode: "private_workspace",
    };

    // Query ?token= is rejected (tokens must not travel in URLs).
    const queryReq = new Request(`https://remote.slirc.app/irc?token=${encodeURIComponent(issued.token)}`, {
      headers: { Origin: "https://app.slirc.org" },
    });
    const queryRes = handleRelayUpgrade(queryReq, "/irc", () => true, deps, "127.0.0.1");
    expect(queryRes?.status).toBe(401);

    // Sec-WebSocket-Protocol slirc-token.<token> from allowed origin succeeds and echoes the protocol.
    let upgradedOptions: { data: any; headers?: Record<string, string> } | null = null;
    const protoReq = new Request("https://remote.slirc.app/irc", {
      headers: {
        Origin: "https://team.slirc.app",
        "Sec-WebSocket-Protocol": `slirc-token.${issued.token}`,
      },
    });
    const protoRes = handleRelayUpgrade(
      protoReq,
      "/irc",
      (_req, options) => {
        upgradedOptions = options;
        return true;
      },
      deps,
      "127.0.0.1",
    );
    expect(protoRes).toBeUndefined();
    expect(upgradedOptions?.data?.nick).toBe("bitbonsai");
    expect(upgradedOptions?.headers).toEqual({
      "Sec-WebSocket-Protocol": `slirc-token.${issued.token}`,
    });

    // Cookie alone cross-origin is rejected with 401 (no CSWSH).
    const cookieCrossOrigin = new Request("https://remote.slirc.app/irc", {
      headers: {
        Origin: "https://app.slirc.org",
        Cookie: "slirc_session=owner-session",
      },
    });
    const cookieRes = handleRelayUpgrade(cookieCrossOrigin, "/irc", () => true, deps, "127.0.0.1");
    expect(cookieRes?.status).toBe(401);

    // Disallowed origin with valid token is rejected with 403.
    const evilReq = new Request("https://remote.slirc.app/irc", {
      headers: {
        Origin: "https://evil.example",
        "Sec-WebSocket-Protocol": `slirc-token.${issued.token}`,
      },
    });
    const evilRes = handleRelayUpgrade(evilReq, "/irc", () => true, deps, "127.0.0.1");
    expect(evilRes?.status).toBe(403);
  });
});
