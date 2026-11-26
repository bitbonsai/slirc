// A URL that serves an image must become an inline image embed, not a raw link. This is
// the route-level check for the content-type decision in og.ts; the fetch is local, so
// the production SSRF guard is only relaxed the same way the local dev stack relaxes it.
import "./fixture.ts";
process.env.EMBED_ALLOW_PRIVATE = "true";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const server = createServer((req, res) => {
  const url = req.url || "";
  res.on("error", () => {});
  if (url.startsWith("/photo.png")) {
    res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
    return;
  }
  if (url.startsWith("/photo.jpeg")) {
    res.writeHead(200, { "content-type": "image/jpeg" }).end(jpeg);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end("<html><head><meta property=\"og:title\" content=\"Example Page\"></head></html>");
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

process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const token = "embed-image-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)")
  .run(createHash("sha256").update(token).digest("hex"), Date.now());

const embed = (url: string) => app.request("/api/embed", {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: `slirc_session=${token}` },
  body: JSON.stringify({ url }),
});

describe("direct image previews", () => {
  test("a jpeg with a query string becomes an inline image, not a raw link", async () => {
    const url = `http://127.0.0.1:${port}/photo.jpeg?auto=compress&cs=tinysrgb&w=1200`;
    const response = await embed(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "image", image: url });
  });

  test("validated image dimensions are available before the browser loads it", async () => {
    const url = `http://127.0.0.1:${port}/photo.png`;
    const response = await embed(url);
    expect(await response.json()).toEqual({ kind: "image", image: url, width: 1, height: 1 });
  });

  test("an HTML page still goes through OpenGraph parsing", async () => {
    const response = await embed(`http://127.0.0.1:${port}/page`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: "Example Page" });
  });
});
