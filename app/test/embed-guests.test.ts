import "./fixture.ts";

process.env.OPEN_CHANNELS = "#open-chat";

import { describe, expect, test } from "bun:test";

// serveStatic resolves "./public" from the cwd; `bun test app` from the repo root would otherwise 404.
process.chdir(new URL("..", import.meta.url).pathname);

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");

const embed = (url: string) => app.request("/api/embed", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url }),
});
const image = (url: string) => app.request(`/api/embed/image?url=${encodeURIComponent(url)}`);

function storeUpload(id: string, channel: string) {
  db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES (?, 'mira', ?, 'image', 'image/jpeg', ?, ?)")
    .run(id, channel, new Uint8Array([1, 2, 3]), Date.now());
}

describe("link previews without a session", () => {
  // Would return title/description if the handler fetched the page itself.
  test("returns no metadata instead of fetching the page", async () => {
    const response = await embed("https://example.com/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  test("still rejects urls it cannot preview", async () => {
    expect((await embed("not a url")).status).toBe(400);
    expect((await embed("file:///etc/passwd")).status).toBe(400);
  });

  test("image proxy is limited to video thumbnails", async () => {
    expect((await image("https://example.com/photo.png")).status).toBe(401);
    expect((await image("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")).status).not.toBe(401);
  });
});

describe("media without a session", () => {
  test("a photo posted in an open room stays readable", async () => {
    storeUpload("open-room-photo", "#open-chat");
    const response = await app.request("/uploads/open-room-photo");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  test("a photo from a private room needs an account", async () => {
    storeUpload("private-room-photo", "#calango");
    expect((await app.request("/uploads/private-room-photo")).status).toBe(401);
  });
});
