import "./fixture.ts";

import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  clientIp,
  closeSessionSockets,
  encodeSaslPlain,
  handleRelayUpgrade,
  isAuthenticateResponse,
  marksAuthenticateRequest,
  originAllowed,
  relayWebsocketHandlers,
  rewriteAuthenticateLine,
  trackSocket,
  untrackSocket,
  webircLine,
  type RelaySocketData,
} from "../src/relay.ts";

// serveStatic resolves "./public" from the cwd; `bun test app` from the repo root would otherwise 404.
process.chdir(new URL("..", import.meta.url).pathname);

describe("originAllowed", () => {
  test("accepts a matching origin", () => {
    expect(originAllowed("https://slirc.org", "https://slirc.org")).toBe(true);
  });
  test("rejects a foreign origin", () => {
    expect(originAllowed("https://evil.example", "https://slirc.org")).toBe(false);
  });
  test("rejects a missing origin", () => {
    expect(originAllowed(null, "https://slirc.org")).toBe(false);
    expect(originAllowed(undefined, "https://slirc.org")).toBe(false);
  });
  test("ignores path and query differences", () => {
    expect(originAllowed("https://slirc.org/foo?x=1", "https://slirc.org")).toBe(true);
  });
  test("rejects a garbage origin instead of throwing", () => {
    expect(originAllowed("not a url", "https://slirc.org")).toBe(false);
  });
});

describe("clientIp", () => {
  test("takes the last X-Forwarded-For hop, the one Caddy appended", () => {
    const headers = new Headers({ "X-Forwarded-For": "6.6.6.6, 203.0.113.5" });
    expect(clientIp(headers, "127.0.0.1")).toBe("203.0.113.5");
  });
  test("falls back to the socket address with no proxy header", () => {
    expect(clientIp(new Headers(), "192.168.1.9")).toBe("192.168.1.9");
  });
  test("falls back to the socket address when the header isn't a bare IP (spoof/injection attempt)", () => {
    const headers = new Headers({ "X-Forwarded-For": "1.2.3.4 secure" });
    expect(clientIp(headers, "192.168.1.9")).toBe("192.168.1.9");
  });
  test("falls back to the socket address for a non-IP string", () => {
    const headers = new Headers({ "X-Forwarded-For": "not-an-ip" });
    expect(clientIp(headers, "192.168.1.9")).toBe("192.168.1.9");
  });
});

test("webircLine matches Ergo's WEBIRC syntax", () => {
  expect(webircLine("secret", "host.example", "203.0.113.5")).toBe("WEBIRC secret slirc host.example 203.0.113.5");
});

describe("AUTHENTICATE rewrite (the relay's SASL swap)", () => {
  function data(awaiting = false): RelaySocketData {
    return { tokenHash: "t", nick: "ana", ip: "1.2.3.4", awaitingAuthenticate: awaiting };
  }

  test("marksAuthenticateRequest/isAuthenticateResponse tell the two client lines apart", () => {
    expect(marksAuthenticateRequest("AUTHENTICATE PLAIN")).toBe(true);
    expect(isAuthenticateResponse("AUTHENTICATE PLAIN")).toBe(false);
    expect(marksAuthenticateRequest("AUTHENTICATE Kg==")).toBe(false);
    expect(isAuthenticateResponse("AUTHENTICATE Kg==")).toBe(true);
  });

  test("the bare PLAIN request passes through unchanged and arms the rewrite", () => {
    const state = data();
    expect(rewriteAuthenticateLine("AUTHENTICATE PLAIN", state, () => "real-pass")).toBe("AUTHENTICATE PLAIN");
    expect(state.awaitingAuthenticate).toBe(true);
  });

  test("the client's placeholder response is replaced with the real SASL PLAIN payload", () => {
    const state = data(true);
    const line = rewriteAuthenticateLine("AUTHENTICATE Kg==", state, (nick) => (nick === "ana" ? "real-pass" : null));
    expect(state.awaitingAuthenticate).toBe(false);
    expect(line).toBe(`AUTHENTICATE ${encodeSaslPlain("ana", "real-pass")}`);
    expect(Buffer.from(line.split(" ")[1], "base64").toString("utf8")).toBe("\0ana\0real-pass");
  });

  test("no password on file leaves the line (and the placeholder) alone", () => {
    const state = data(true);
    expect(rewriteAuthenticateLine("AUTHENTICATE Kg==", state, () => null)).toBe("AUTHENTICATE Kg==");
  });

  test("a response line outside the armed window is never rewritten", () => {
    const state = data(false);
    expect(rewriteAuthenticateLine("AUTHENTICATE Kg==", state, () => "real-pass")).toBe("AUTHENTICATE Kg==");
  });
});

describe("handleRelayUpgrade (the auth gate before any Ergo connection opens)", () => {
  const deps = {
    sessionByToken: (token: string) => (token === "good" ? { nick: "ana", tokenHash: "hash-ana" } : null),
    ircPasswordFor: () => "unused",
    appOrigin: "https://slirc.org",
    ergoHost: "ergo",
    ergoPort: 6667,
    mode: "public_playground" as const,
  };
  const privateDeps = { ...deps, mode: "private_workspace" as const };
  function req({ cookie, origin }: { cookie?: string; origin?: string } = {}) {
    const headers = new Headers();
    if (origin !== undefined) headers.set("Origin", origin);
    if (cookie) headers.set("Cookie", `slirc_session=${cookie}`);
    return new Request("https://slirc.org/irc", { headers });
  }

  test("a request with no session connects as a guest, with no identity attached", () => {
    let data: any = null;
    const upgrade = (_r: Request, options: { data: any }) => { data = options.data; return true; };
    const response = handleRelayUpgrade(req({ origin: "https://slirc.org" }), "/irc", upgrade, deps, "1.2.3.4");
    expect(response).toBeUndefined();
    expect(data.guest).toBe(true);
    expect(data.nick).toBe("");
  });

  test("a stale session token connects as a guest instead of being refused", () => {
    let data: any = null;
    const upgrade = (_r: Request, options: { data: any }) => { data = options.data; return true; };
    const response = handleRelayUpgrade(req({ origin: "https://slirc.org", cookie: "not-a-real-token" }), "/irc", upgrade, deps, "1.2.3.4");
    expect(response).toBeUndefined();
    expect(data.guest).toBe(true);
    expect(data.nick).toBe("");
  });

  test("rejects a foreign Origin before the session is even looked at", () => {
    const upgrade = () => { throw new Error("must not upgrade"); };
    const response = handleRelayUpgrade(req({ origin: "https://evil.example", cookie: "good" }), "/irc", upgrade, deps, "1.2.3.4");
    expect(response?.status).toBe(403);
  });

  test("rejects a missing Origin the same way", () => {
    const response = handleRelayUpgrade(req({ cookie: "good" }), "/irc", () => true, deps, "1.2.3.4");
    expect(response?.status).toBe(403);
  });

  test("a valid session and origin hand the upgrade the session's account", () => {
    let upgraded: { data: RelaySocketData } | null = null;
    const response = handleRelayUpgrade(req({ origin: "https://slirc.org", cookie: "good" }), "/irc", (_req, options) => { upgraded = options; return true; }, deps, "1.2.3.4");
    expect(response).toBeUndefined();
    expect(upgraded?.data).toMatchObject({ nick: "ana", tokenHash: "hash-ana", ip: "1.2.3.4", awaitingAuthenticate: false });
  });

  test("a failed upgrade (server.upgrade returning false) becomes a 400, not a silent drop", () => {
    const response = handleRelayUpgrade(req({ origin: "https://slirc.org", cookie: "good" }), "/irc", () => false, deps, "1.2.3.4");
    expect(response?.status).toBe(400);
  });

  test("private mode rejects every unauthenticated case before the upgrade callback runs", () => {
    for (const cookie of [undefined, "not-a-real-token"]) {
      let called = false;
      const response = handleRelayUpgrade(req({ origin: "https://slirc.org", cookie }), "/irc", () => { called = true; return true; }, privateDeps, "1.2.3.4");
      expect(response?.status).toBe(401);
      expect(called).toBe(false);
    }
  });

  test("private mode still rejects a bad Origin first", () => {
    let called = false;
    const response = handleRelayUpgrade(req({ origin: "https://evil.example", cookie: "good" }), "/irc", () => { called = true; return true; }, privateDeps, "1.2.3.4");
    expect(response?.status).toBe(403);
    expect(called).toBe(false);
  });

  test("private mode hands a valid session upgrade the session's account", () => {
    let upgraded: { data: RelaySocketData } | null = null;
    const response = handleRelayUpgrade(req({ origin: "https://slirc.org", cookie: "good" }), "/irc", (_req, options) => { upgraded = options; return true; }, privateDeps, "1.2.3.4");
    expect(response).toBeUndefined();
    expect(upgraded?.data).toMatchObject({ nick: "ana", tokenHash: "hash-ana" });
    expect(upgraded?.data.guest).toBeUndefined();
  });
});

describe("session socket tracking (revoke closes live sockets in-process)", () => {
  test("closeSessionSockets closes every socket tracked for that token, then forgets them", () => {
    const closed: string[] = [];
    const ws1 = { close: () => closed.push("a") } as any;
    const ws2 = { close: () => closed.push("b") } as any;
    trackSocket("revoke-tok", ws1);
    trackSocket("revoke-tok", ws2);
    closeSessionSockets("revoke-tok");
    expect(closed.sort()).toEqual(["a", "b"]);
    // Idempotent: a second revoke (e.g. a double session-delete) finds nothing left to close.
    expect(() => closeSessionSockets("revoke-tok")).not.toThrow();
  });

  test("untrackSocket removes a socket without closing it (the socket's own close handler calls this)", () => {
    let closed = false;
    const ws = { close: () => { closed = true; } } as any;
    trackSocket("untrack-tok", ws);
    untrackSocket("untrack-tok", ws);
    closeSessionSockets("untrack-tok");
    expect(closed).toBe(false);
  });
});

describe("relayWebsocketHandlers (Ergo -> browser leg)", () => {
  function makeWs() {
    const sent: string[] = [];
    const closed: { code?: number; reason?: string }[] = [];
    const ws = {
      data: { tokenHash: "handlers-tok", nick: "ana", ip: "1.2.3.4", awaitingAuthenticate: false } as RelaySocketData,
      send: (data: string) => { sent.push(data); },
      close: (code?: number, reason?: string) => { closed.push({ code, reason }); },
      sent,
      closed,
    };
    return ws;
  }

  test("a line split across two onData calls reaches the browser whole, not fragmented", () => {
    let feed: ((chunk: Buffer) => void) | null = null;
    const deps: any = {
      sessionByToken: () => null,
      ircPasswordFor: () => null,
      appOrigin: "https://slirc.org",
      ergoHost: "ergo",
      ergoPort: 6667,
      connectSocket: async (_host: string, _port: number, onData: (chunk: Buffer) => void) => {
        feed = onData;
        return { write: () => {}, end: () => {} };
      },
    };
    const handlers = relayWebsocketHandlers(deps);
    const ws = makeWs();
    handlers.open(ws as any);
    expect(feed).not.toBeNull();
    // The first read carries only half of one IRC line (routine once message-tags push a line
    // past a TCP segment boundary); the second carries the rest.
    feed!(Buffer.from(":ergo!ergo@host PRIVMSG #room :hel"));
    feed!(Buffer.from("lo\r\n"));
    expect(ws.sent).toEqual([":ergo!ergo@host PRIVMSG #room :hello\r\n"]);
  });

  test("every byte split of a tagged line reaches the browser as one line", () => {
    const line = "@time=2026-01-01T00:00:00.000Z :ergo!ergo@host PRIVMSG #room :h\u00e9llo \u{1F600} \u{1F389}\r\n";
    const bytes = Buffer.from(line, "utf8");
    for (let split = 0; split <= bytes.length; split++) {
      let feed: ((chunk: Buffer) => void) | null = null;
      const deps: any = {
        sessionByToken: () => null,
        ircPasswordFor: () => null,
        appOrigin: "https://slirc.org",
        ergoHost: "ergo",
        ergoPort: 6667,
        connectSocket: async (_host: string, _port: number, onData: (chunk: Buffer) => void) => {
          feed = onData;
          return { write: () => {}, end: () => {} };
        },
      };
      const handlers = relayWebsocketHandlers(deps);
      const ws = makeWs();
      handlers.open(ws as any);
      feed!(bytes.subarray(0, split));
      feed!(bytes.subarray(split));
      expect(ws.sent).toEqual([line]);
    }
  });

  test("multiple complete lines in one chunk are each forwarded separately, partial tail held back", () => {
    let feed: ((chunk: Buffer) => void) | null = null;
    const deps: any = {
      sessionByToken: () => null,
      ircPasswordFor: () => null,
      appOrigin: "https://slirc.org",
      ergoHost: "ergo",
      ergoPort: 6667,
      connectSocket: async (_host: string, _port: number, onData: (chunk: Buffer) => void) => {
        feed = onData;
        return { write: () => {}, end: () => {} };
      },
    };
    const handlers = relayWebsocketHandlers(deps);
    const ws = makeWs();
    handlers.open(ws as any);
    feed!(Buffer.from("PING :one\r\nPING :two\r\nPING :thr"));
    expect(ws.sent).toEqual(["PING :one\r\n", "PING :two\r\n"]);
    feed!(Buffer.from("ee\r\n"));
    expect(ws.sent).toEqual(["PING :one\r\n", "PING :two\r\n", "PING :three\r\n"]);
  });

  test("a UTF-8 character split across two reads is decoded whole, not as U+FFFD", () => {
    let feed: ((chunk: Buffer) => void) | null = null;
    const deps: any = {
      sessionByToken: () => null,
      ircPasswordFor: () => null,
      appOrigin: "https://slirc.org",
      ergoHost: "ergo",
      ergoPort: 6667,
      connectSocket: async (_host: string, _port: number, onData: (chunk: Buffer) => void) => {
        feed = onData;
        return { write: () => {}, end: () => {} };
      },
    };
    const handlers = relayWebsocketHandlers(deps);
    const ws = makeWs();
    handlers.open(ws as any);
    const line = ":ergo!ergo@host PRIVMSG #room :h\u00e9llo \u{1F600} world\r\n";
    const bytes = Buffer.from(line, "utf8");
    const emojiAt = bytes.indexOf(Buffer.from("\u{1F600}"));
    // Split one byte into the emoji's four-byte sequence: a per-chunk toString() would corrupt it.
    feed!(bytes.subarray(0, emojiAt + 1));
    feed!(bytes.subarray(emojiAt + 1));
    expect(ws.sent).toEqual([line]);
  });

  test("a NUL byte and a lone CR in a browser line are removed/ folded before Ergo", async () => {
    const written: string[] = [];
    const deps: any = {
      sessionByToken: () => null,
      ircPasswordFor: () => null,
      appOrigin: "https://slirc.org",
      ergoHost: "ergo",
      ergoPort: 6667,
      connectSocket: async () => ({ write: (data: string) => written.push(data), end: () => {} }),
    };
    const handlers = relayWebsocketHandlers(deps);
    const ws = makeWs();
    handlers.open(ws as any);
    await ws.data.tcp;
    handlers.message(ws as any, "PRIVMSG #room :a\0b\r\n");
    handlers.message(ws as any, "PRIVMSG #room :a\rQUIT");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toContain("PRIVMSG #room :ab\r\n");
    expect(written).toContain("PRIVMSG #room :a QUIT\r\n");
    expect(written).not.toContain("QUIT\r\n");
  });

  test("a failed Ergo connect closes the browser socket instead of waiting on the keepalive timeout", async () => {
    const deps: any = {
      sessionByToken: () => null,
      ircPasswordFor: () => null,
      appOrigin: "https://slirc.org",
      ergoHost: "ergo",
      ergoPort: 6667,
      connectSocket: async () => { throw new Error("ECONNREFUSED"); },
    };
    const handlers = relayWebsocketHandlers(deps);
    const ws = makeWs();
    handlers.open(ws as any);
    await ws.data.tcp!.catch(() => {});
    expect(ws.closed).toEqual([{ code: 1011, reason: "ergo unreachable" }]);
  });
});

describe("/auth/me", () => {
  test("never sends the IRC password", async () => {
    const { db } = await import("../src/db.ts");
    await import("../src/accounts.ts");
    const { app } = await import("../src/server.ts");
    const token = "relay-test-owner-session";
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)")
      .run(createHash("sha256").update(token).digest("hex"), Date.now());
    const response = await app.request("/auth/me", { headers: { Cookie: `slirc_session=${token}` } });
    const body = await response.json();
    expect(body.authenticated).toBe(true);
    expect(body).not.toHaveProperty("ircPassword");
    expect(JSON.stringify(body)).not.toContain("owner-pass");
  });
});
