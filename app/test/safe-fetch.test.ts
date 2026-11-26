import "./fixture.ts";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { createGuardedLookup, fetchPublic, type LookupFunction, resolveAddresses, ResponseTooLarge } from "../src/safe-fetch.ts";
import { isPrivateIp } from "../src/og.ts";

// A local listener is enough to exercise every path: injected DNS points the test
// hostnames at it, and the guard decides what is allowed to connect.
const hits = new Set<string>();
const server = createServer((req, res) => {
  hits.add(req.url || "");
  res.on("error", () => {});
  const local = `127.0.0.1:${port}`;
  switch (req.url) {
    case "/ok":
      return void res.writeHead(200, { "content-type": "text/plain" }).end("fine");
    case "/secret":
      return void res.writeHead(200, { "content-type": "text/plain" }).end("secret");
    case "/redirect-private":
      return void res.writeHead(302, { location: `http://priv.test:${port}/secret` }).end();
    case "/redirect-ftp":
      return void res.writeHead(302, { location: "ftp://127.0.0.1/etc/passwd" }).end();
    case "/hop":
      return void res.writeHead(302, { location: `http://${local}/ok` }).end();
    case "/loop":
      return void res.writeHead(302, { location: `http://${local}/loop` }).end();
    case "/exact":
      return void res.writeHead(200, { "content-type": "text/plain" }).end(Buffer.alloc(1000, "a"));
    case "/slow":
      return; // never responds
    case "/stream": {
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write(Buffer.alloc(64, "a")), 1);
      res.on("close", () => clearInterval(timer));
      return;
    }
    default:
      return void res.writeHead(404).end();
  }
});
let port = 0;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
  port = (server.address() as AddressInfo).port;
  resolve();
}));
afterAll(() => {
  server.closeAllConnections?.();
  server.close();
});

const lookupOnce = (lookup: LookupFunction, hostname: string) =>
  new Promise<{ error: Error | null; address?: string; records?: { address: string; family: number }[] }>((resolve) => {
    lookup(hostname, { all: true }, (error, address) => {
      resolve({ error: error as Error | null, address: address as string, records: Array.isArray(address) ? address : undefined });
    });
  });

describe("guarded lookup", () => {
  test("rejects a private answer before anything connects", async () => {
    const lookup = createGuardedLookup(async () => ["127.0.0.1"], (address) => !isPrivateIp(address));
    const result = await lookupOnce(lookup, "internal.test");
    expect(result.error?.message).toBe("blocked");
    expect(result.records).toBeUndefined();
  });

  test("returns the validated address and resolves exactly once", async () => {
    let calls = 0;
    const lookup = createGuardedLookup(async () => { calls++; return ["1.1.1.1"]; }, () => true);
    const result = await lookupOnce(lookup, "example.test");
    expect(result.records).toEqual([{ address: "1.1.1.1", family: 4 }]);
    expect(calls).toBe(1);
  });

  test("rejects a mixed public/private answer so the public address cannot be used", async () => {
    const lookup = createGuardedLookup(async () => ["1.1.1.1", "10.0.0.1"], (address) => !isPrivateIp(address));
    expect((await lookupOnce(lookup, "mixed.test")).error?.message).toBe("blocked");
  });

  test("rejects a non-address answer", async () => {
    const lookup = createGuardedLookup(async () => ["not-an-ip"], () => true);
    expect((await lookupOnce(lookup, "bad.test")).error?.message).toBe("blocked");
  });

  test("validates an IP literal without resolving it", async () => {
    let calls = 0;
    const lookup = createGuardedLookup(async () => { calls++; return ["1.1.1.1"]; }, (address) => !isPrivateIp(address));
    const allowed = await lookupOnce(lookup, "[2606:4700::6810:84e5]");
    expect(allowed.records).toEqual([{ address: "2606:4700::6810:84e5", family: 6 }]);
    expect((await lookupOnce(lookup, "[::1]")).error?.message).toBe("blocked");
    expect(calls).toBe(0);
  });

  test("the default resolver returns address records", async () => {
    const records = await resolveAddresses("localhost");
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((address) => isPrivateIp(address))).toBe(true);
  });

  test("a rebinding resolver is consulted once, so a later private answer is never connected", async () => {
    let calls = 0;
    const answers = [["1.1.1.1"], ["127.0.0.1"]];
    const lookup = createGuardedLookup(async () => answers[Math.min(calls++, answers.length - 1)] as string[], (address) => !isPrivateIp(address));
    const result = await lookupOnce(lookup, "rebind.test");
    expect(result.records).toEqual([{ address: "1.1.1.1", family: 4 }]);
    expect(calls).toBe(1);
  });
});

describe("fetchPublic", () => {
  test("refuses an IP-literal target before connecting", async () => {
    hits.clear();
    await expect(fetchPublic(new URL(`http://127.0.0.1:${port}/ok`))).rejects.toThrow("blocked");
    expect(hits.has("/ok")).toBe(false);
  });

  test("refuses a hostname whose answer is private", async () => {
    hits.clear();
    const resolve = async () => ["10.0.0.5"];
    await expect(fetchPublic(new URL(`http://internal.test:${port}/ok`), { resolve })).rejects.toThrow("blocked");
    expect(hits.has("/ok")).toBe(false);
  });

  test("re-checks each redirect and refuses a public-to-private bounce", async () => {
    hits.clear();
    const resolve = async (hostname: string) => (hostname === "pub.test" || hostname === "priv.test" ? ["127.0.0.1"] : ["1.1.1.1"]);
    const addressAllowed = (address: string, hostname: string) => hostname === "pub.test" || !isPrivateIp(address);
    await expect(fetchPublic(new URL(`http://pub.test:${port}/redirect-private`), { resolve, addressAllowed })).rejects.toThrow("blocked");
    expect(hits.has("/redirect-private")).toBe(true);
    expect(hits.has("/secret")).toBe(false);
  });

  test("refuses a redirect to an unsafe scheme", async () => {
    await expect(fetchPublic(new URL(`http://127.0.0.1:${port}/redirect-ftp`), { allowPrivate: true })).rejects.toThrow("blocked");
  });

  test("follows a bounded redirect chain between allowed hosts", async () => {
    const page = await fetchPublic(new URL(`http://127.0.0.1:${port}/hop`), { allowPrivate: true });
    expect(await page.text(100)).toBe("fine");
    expect(page.finalUrl.pathname).toBe("/ok");
    await expect(fetchPublic(new URL(`http://127.0.0.1:${port}/loop`), { allowPrivate: true, maxHops: 2 })).rejects.toThrow("blocked");
  });

  test("refuses credentials and unsafe schemes", async () => {
    await expect(fetchPublic(new URL("http://user:pass@127.0.0.1/x"), { allowPrivate: true })).rejects.toThrow("blocked");
    await expect(fetchPublic(new URL("ftp://127.0.0.1/x"))).rejects.toThrow("blocked");
  });

  test("times out a stalled response", async () => {
    await expect(fetchPublic(new URL(`http://127.0.0.1:${port}/slow`), { allowPrivate: true, timeoutMs: 200 })).rejects.toThrow();
  });

  test("bounds a streamed body instead of buffering it", async () => {
    const response = await fetchPublic(new URL(`http://127.0.0.1:${port}/stream`), { allowPrivate: true });
    await expect(response.bytes(1000)).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  test("truncates a streamed text body at the limit", async () => {
    const response = await fetchPublic(new URL(`http://127.0.0.1:${port}/stream`), { allowPrivate: true });
    const text = await response.text(1000);
    expect(text).toBe("a".repeat(1000));
  });

  test("allows a body of exactly the limit and refuses one byte more", async () => {
    const exact = await fetchPublic(new URL(`http://127.0.0.1:${port}/exact`), { allowPrivate: true });
    expect((await exact.bytes(1000)).byteLength).toBe(1000);
    const over = await fetchPublic(new URL(`http://127.0.0.1:${port}/exact`), { allowPrivate: true });
    await expect(over.bytes(999)).rejects.toBeInstanceOf(ResponseTooLarge);
  });
});

// The route is the caller that matters in production; the private IP literal is
// rejected by the same guard the direct tests exercise.
process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const token = "safe-fetch-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(createHash("sha256").update(token).digest("hex"), Date.now());

describe("image proxy route", () => {
  test("answers 403 for a private target", async () => {
    const response = await app.request(`/api/embed/image?url=${encodeURIComponent(`http://127.0.0.1:${port}/ok`)}`, {
      headers: { Cookie: `slirc_session=${token}` },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("failed image responses are not cacheable", async () => {
    const anonymous = await app.request(`/api/embed/image?url=${encodeURIComponent(`http://127.0.0.1:${port}/ok`)}`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");

    const malformed = await app.request("/api/embed/image?url=not-a-url", {
      headers: { Cookie: `slirc_session=${token}` },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
  });
});
