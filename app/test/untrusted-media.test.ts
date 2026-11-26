// Routes that serve bytes chosen by a member or a remote site must never let those bytes
// run as a document on the app origin.
import "./fixture.ts";

process.env.EMBED_ALLOW_PRIVATE = "true";
process.env.OPEN_CHANNELS = "#open-chat";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");

const token = "untrusted-media-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(createHash("sha256").update(token).digest("hex"), Date.now());
const signedIn = { headers: { Cookie: `slirc_session=${token}` } };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const upstream = createServer((request, response) => {
  if (request.url === "/evil.svg") {
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');
  } else if (request.url === "/photo.png" || request.url === "/photo.png?guest") {
    response.writeHead(200, { "Content-Type": "image/png; charset=binary" });
    response.end(PNG);
  } else if (request.url === "/odd.bmp") {
    response.writeHead(200, { "Content-Type": "image/bmp" });
    response.end(PNG);
  } else {
    response.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const port = (upstream.address() as AddressInfo).port;
afterAll(() => upstream.close());

const proxied = (path: string) => app.request(`/api/embed/image?url=${encodeURIComponent(`http://127.0.0.1:${port}${path}`)}`, signedIn);

function expectInertHeaders(response: Response) {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  expect(response.headers.get("content-disposition")).toMatch(/^inline; filename="[a-z]+(\.[a-z0-9]+)?"$/);
}

describe("/api/embed/image", () => {
  test("refuses an SVG from a remote site", async () => {
    const response = await proxied("/evil.svg");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<script>");
  });

  test("a guest gets only an image a member already loaded", async () => {
    const guest = (path: string) => app.request(`/api/embed/image?url=${encodeURIComponent(`http://127.0.0.1:${port}${path}`)}`);
    expect((await guest("/photo.png?guest")).status).toBe(401);
    expect((await proxied("/photo.png?guest")).status).toBe(200);
    const cached = await guest("/photo.png?guest");
    expect(cached.status).toBe(200);
    expectInertHeaders(cached);
  });

  test("refuses image types outside the raster allowlist", async () => {
    expect((await proxied("/odd.bmp")).status).toBe(404);
  });

  test("serves a raster image with inert headers, fresh and from cache", async () => {
    for (let round = 0; round < 2; round++) {
      const response = await proxied("/photo.png");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-disposition")).toBe('inline; filename="image.png"');
      expectInertHeaders(response);
    }
  });
});

describe("/uploads/:id", () => {
  test("sends inert headers on full and range reads", async () => {
    db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES ('inert-upload', 'bitbonsai', '#open-chat', 'image', 'image/webp', ?, ?)")
      .run(new Uint8Array([1, 2, 3, 4]), Date.now());
    const full = await app.request("/uploads/inert-upload", signedIn);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-disposition")).toBe('inline; filename="upload.webp"');
    expectInertHeaders(full);
    const range = await app.request("/uploads/inert-upload", { headers: { ...signedIn.headers, Range: "bytes=0-1" } });
    expect(range.status).toBe(206);
    expectInertHeaders(range);
  });
});

describe("/avatars/:account", () => {
  test("the generated initial SVG cannot run as a document", async () => {
    const response = await app.request("/avatars/nophoto", signedIn);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="avatar.svg"');
    expectInertHeaders(response);
  });

  test("a stored photo cannot run as a document", async () => {
    const path = join(tmpdir(), `slirc-avatar-${process.pid}`);
    await Bun.write(path, PNG);
    db.query("INSERT INTO profiles (account, avatar_path, avatar_mime, avatar_version) VALUES ('bitbonsai', ?, 'image/png', 1) ON CONFLICT(account) DO UPDATE SET avatar_path = excluded.avatar_path, avatar_mime = excluded.avatar_mime").run(path);
    const response = await app.request("/avatars/bitbonsai", signedIn);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('inline; filename="avatar.png"');
    expectInertHeaders(response);
  });
});
