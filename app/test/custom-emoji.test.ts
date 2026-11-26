import "./fixture.ts";

import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.chdir(new URL("..", import.meta.url).pathname);

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const token = "emoji-session";
const auth = { Cookie: `slirc_session=${token}`, "Content-Type": "application/json" };

// fixture.ts pins public_playground; each mode test sets its own and restores it.
const defaultMode = process.env.SLIRC_MODE;
function useMode(mode: "private_workspace" | "public_playground") {
  process.env.SLIRC_MODE = mode;
}

beforeEach(() => {
  process.env.SLIRC_MODE = defaultMode;
  db.query("DELETE FROM custom_emoji").run();
  db.query("DELETE FROM uploads").run();
  db.query("DELETE FROM channel_members WHERE channel = '#private'").run();
  db.query("DELETE FROM sessions").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)")
    .run(createHash("sha256").update(token).digest("hex"), Date.now());
  db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES ('party-image', 'bitbonsai', '#help', 'image', 'image/webp', ?, ?)")
    .run(new Uint8Array([1, 2, 3]), Date.now());
});

test("creates, lists, and removes custom emoji backed by an upload", async () => {
  const created = await app.request("/api/emoji", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "party_parrot", uploadId: "party-image" }),
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ name: "party_parrot", url: "/uploads/party-image?type=image", addedBy: "bitbonsai" });

  const list = await app.request("/api/emoji");
  expect(await list.json()).toEqual([{ name: "party_parrot", url: "/uploads/party-image?type=image", addedBy: "bitbonsai" }]);
  const bytes = await app.request("/uploads/party-image");
  expect(bytes.status).toBe(200);
  expect(bytes.headers.get("Cache-Control")).toBe("public, max-age=300");

  expect((await app.request("/api/emoji/party_parrot", { method: "DELETE", headers: auth })).status).toBe(204);
  expect(db.query("SELECT 1 FROM custom_emoji").get()).toBeNull();
  expect(db.query("SELECT 1 FROM uploads WHERE id = 'party-image'").get()).toBeNull();
});

test("public playground keeps anonymous emoji listing and short public caching", async () => {
  useMode("public_playground");
  db.query("INSERT INTO custom_emoji (name, upload_id, added_by, created_at) VALUES ('party', 'party-image', 'bitbonsai', 1)").run();
  const list = await app.request("/api/emoji");
  expect(list.status).toBe(200);
  expect((await list.json()).length).toBe(1);
  const bytes = await app.request("/uploads/party-image");
  expect(bytes.status).toBe(200);
  expect(bytes.headers.get("Cache-Control")).toBe("public, max-age=300");
});

test("private workspace denies anonymous emoji listing but allows a signed-in account", async () => {
  useMode("private_workspace");
  db.query("INSERT INTO custom_emoji (name, upload_id, added_by, created_at) VALUES ('party', 'party-image', 'bitbonsai', 1)").run();
  expect((await app.request("/api/emoji")).status).toBe(401);
  const list = await app.request("/api/emoji", { headers: auth });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual([{ name: "party", url: "/uploads/party-image?type=image", addedBy: "bitbonsai" }]);
});

test("private workspace emoji bytes require a session and are never cached", async () => {
  useMode("private_workspace");
  db.query("INSERT INTO custom_emoji (name, upload_id, added_by, created_at) VALUES ('party', 'party-image', 'bitbonsai', 1)").run();
  expect((await app.request("/uploads/party-image")).status).toBe(401);
  const bytes = await app.request("/uploads/party-image", { headers: auth });
  expect(bytes.status).toBe(200);
  expect(bytes.headers.get("Cache-Control")).toBe("private, no-store");
  expect(bytes.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(bytes.headers.get("Content-Type")).toBe("image/webp");
  expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([1, 2, 3]);
  const ranged = await app.request("/uploads/party-image", { headers: { ...auth, Range: "bytes=1-1" } });
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get("Cache-Control")).toBe("private, no-store");
  expect(ranged.headers.get("Content-Range")).toBe("bytes 1-1/3");
  expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([2]);
});

test("private workspace keeps room uploads membership-based and private", async () => {
  useMode("private_workspace");
  db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES ('room-image', 'bitbonsai', '#private', 'image', 'image/webp', ?, ?)")
    .run(new Uint8Array([4, 5, 6]), Date.now());
  expect((await app.request("/uploads/room-image")).status).toBe(401);
  expect((await app.request("/uploads/room-image", { headers: auth })).status).toBe(403);
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#private', 'bitbonsai')").run();
  const bytes = await app.request("/uploads/room-image", { headers: auth });
  expect(bytes.status).toBe(200);
  expect(bytes.headers.get("Cache-Control")).toBe("private, no-store");
});

test("rejects standard names and uploads owned by someone else", async () => {
  const standard = await app.request("/api/emoji", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "tada", uploadId: "party-image" }),
  });
  expect(standard.status).toBe(409);

  db.query("UPDATE uploads SET nick = 'someone-else' WHERE id = 'party-image'").run();
  const foreign = await app.request("/api/emoji", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "party_parrot", uploadId: "party-image" }),
  });
  expect(foreign.status).toBe(404);
});

// Minimal files: the animated path reads only signatures, block lists and sizes.
function u32be(value: number) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function u32le(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
function ascii(text: string) {
  return [...text].map((char) => char.charCodeAt(0));
}
function gif(width: number, height: number, frames = 2, padding = 0) {
  // Each frame: image descriptor, LZW code size, one data sub-block, terminator.
  const frame = [0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 2, 1, 0, 0];
  return new Uint8Array([
    ...ascii("GIF89a"), width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0,
    ...Array.from({ length: frames }, () => frame).flat(),
    0x3b,
    ...new Array(padding).fill(0),
  ]);
}
function png(width: number, height: number, frames: number) {
  const chunk = (type: string, data: number[]) => [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...(frames ? chunk("acTL", [...u32be(frames), ...u32be(0)]) : []),
    ...Array.from({ length: frames }, () => chunk("fcTL", new Array(26).fill(0))).flat(),
    ...chunk("IEND", []),
  ]);
}
function animatedWebp(width: number, height: number, frames = 2) {
  const vp8x = [...ascii("VP8X"), ...u32le(10), 0x02, 0, 0, 0, (width - 1) & 0xff, ((width - 1) >> 8) & 0xff, 0, (height - 1) & 0xff, ((height - 1) >> 8) & 0xff, 0];
  const anim = [...ascii("ANIM"), ...u32le(6), 0, 0, 0, 0, 0, 0];
  const anmf = Array.from({ length: frames }, () => [...ascii("ANMF"), ...u32le(16), ...new Array(16).fill(0)]).flat();
  const body = [...ascii("WEBP"), ...vp8x, ...anim, ...anmf];
  return new Uint8Array([...ascii("RIFF"), ...u32le(body.length), ...body]);
}
function addAnimated(name: string, bytes: Uint8Array, mime = "image/gif") {
  return app.request("/api/emoji", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, mime, data: Buffer.from(bytes).toString("base64") }),
  });
}
function seedEmoji(count: number, addedBy: string, createdAt: number) {
  const insert = db.query("INSERT INTO custom_emoji (name, upload_id, added_by, created_at) VALUES (?, 'party-image', ?, ?)");
  db.transaction(() => { for (let i = 0; i < count; i++) insert.run(`seed_${addedBy}_${createdAt}_${i}`, addedBy, createdAt); })();
}

test("stores an animated GIF as sent and serves it as image/gif", async () => {
  const bytes = gif(32, 32);
  const created = await addAnimated("party_blob", bytes);
  expect(created.status).toBe(201);
  const { url } = await created.json() as { url: string };
  const row = db.query("SELECT u.channel, u.mime, u.kind, u.nick FROM custom_emoji e JOIN uploads u ON u.id = e.upload_id WHERE e.name = 'party_blob'").get();
  expect(row).toEqual({ channel: "emoji", mime: "image/gif", kind: "image", nick: "bitbonsai" });
  const served = await app.request(url.split("?")[0], { headers: auth });
  expect(served.status).toBe(200);
  expect(served.headers.get("Content-Type")).toBe("image/gif");
  expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([...bytes]);
});

test("accepts APNG and animated WebP, sniffing the type instead of trusting mime", async () => {
  expect((await addAnimated("spin_png", png(64, 64, 3), "image/gif")).status).toBe(201);
  expect((await addAnimated("spin_webp", animatedWebp(128, 128), "image/gif")).status).toBe(201);
  const mimes = db.query("SELECT e.name, u.mime FROM custom_emoji e JOIN uploads u ON u.id = e.upload_id ORDER BY e.name").all();
  expect(mimes).toEqual([{ name: "spin_png", mime: "image/png" }, { name: "spin_webp", mime: "image/webp" }]);
});

test("rejects stills, files over 128 KB and canvases over 128 px on the animated path", async () => {
  expect((await addAnimated("still_png", png(32, 32, 0), "image/gif")).status).toBe(400);
  expect((await addAnimated("still_jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]))).status).toBe(400);
  expect((await addAnimated("broken_gif", new Uint8Array([...ascii("GIF89a"), 16, 0, 16, 0, 0, 0, 0, 0x99]))).status).toBe(400);
  expect((await addAnimated("just_fits", gif(32, 32, 2, 128 * 1024 - gif(32, 32).length))).status).toBe(201);
  expect((await addAnimated("too_heavy", gif(32, 32, 2, 128 * 1024))).status).toBe(413);
  expect((await addAnimated("too_wide", gif(129, 16))).status).toBe(413);
  expect((await addAnimated("too_tall", png(16, 200, 2))).status).toBe(413);
  expect(db.query("SELECT COUNT(*) AS count FROM uploads WHERE channel = 'emoji'").get()).toEqual({ count: 1 });
});

test("allows 50 frames and rejects a 51st in each format", async () => {
  expect((await addAnimated("gif_50", gif(16, 16, 50))).status).toBe(201);
  expect((await addAnimated("gif_51", gif(16, 16, 51))).status).toBe(413);
  expect((await addAnimated("png_50", png(16, 16, 50))).status).toBe(201);
  expect((await addAnimated("png_51", png(16, 16, 51))).status).toBe(413);
  expect((await addAnimated("webp_50", animatedWebp(16, 16, 50))).status).toBe(201);
  const webp51 = await addAnimated("webp_51", animatedWebp(16, 16, 51));
  expect(webp51.status).toBe(413);
  expect(await webp51.json()).toEqual({ error: "Animated emoji can have at most 50 frames." });
});

test("animated emoji bytes fail closed once the emoji row is gone", async () => {
  const created = await addAnimated("gone_soon", gif(16, 16));
  const { url } = await created.json() as { url: string };
  db.query("DELETE FROM custom_emoji WHERE name = 'gone_soon'").run();
  expect((await app.request(url.split("?")[0], { headers: auth })).status).toBe(403);
});

test("has no instance-wide cap", async () => {
  seedEmoji(1200, "someone-else", Date.now());
  expect((await addAnimated("still_room", gif(16, 16))).status).toBe(201);
});

test("limits each member to 50 new emoji per rolling 24 hours on both paths", async () => {
  seedEmoji(60, "bitbonsai", Date.now() - 25 * 60 * 60 * 1000);
  seedEmoji(49, "bitbonsai", Date.now() - 60 * 1000);
  expect((await addAnimated("fiftieth", gif(16, 16))).status).toBe(201);
  const raw = await addAnimated("fifty_first", gif(16, 16));
  expect(raw.status).toBe(429);
  expect(await raw.json()).toEqual({ error: "You can add 50 custom emoji a day. Try again later." });
  const still = await app.request("/api/emoji", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "fifty_first", uploadId: "party-image" }),
  });
  expect(still.status).toBe(429);
});

test("rejects an emoji that would push the instance over its storage budget, on both paths", async () => {
  const previous = process.env.SLIRC_EMOJI_BUDGET_BYTES;
  process.env.SLIRC_EMOJI_BUDGET_BYTES = String(gif(16, 16).length * 2);
  try {
    expect((await addAnimated("first", gif(16, 16))).status).toBe(201);
    expect((await addAnimated("second", gif(16, 16))).status).toBe(201);
    const over = await addAnimated("third", gif(16, 16));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "This Slirc has used its custom emoji storage. Remove some emoji to make room." });
    const still = await app.request("/api/emoji", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "third", uploadId: "party-image" }),
    });
    expect(still.status).toBe(413);
    expect(db.query("SELECT COUNT(*) AS count FROM uploads WHERE channel = 'emoji'").get()).toEqual({ count: 2 });
  } finally {
    if (previous === undefined) delete process.env.SLIRC_EMOJI_BUDGET_BYTES;
    else process.env.SLIRC_EMOJI_BUDGET_BYTES = previous;
  }
});
