import "./fixture.ts";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real image storage, in a disposable directory, never the local stack's avatars.
const directory = await mkdtemp(join(tmpdir(), "slirc-avatar-test-"));
process.env.DB_PATH = join(directory, "chat.sqlite");
process.env.SLIRC_HELPERS_ENABLED = "false";
const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
db.query("INSERT OR REPLACE INTO profiles (account, gravatar_checked_at) VALUES ('bitbonsai', ?)").run(Date.now());
const { app } = await import("../src/server.ts");
afterAll(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

const token = "avatar-fixture-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)")
  .run(createHash("sha256").update(token).digest("hex"), Date.now());
const accountId = accountByNick("bitbonsai")!.id;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const upload = (body: unknown, signedIn = true) => app.request("/profile/avatar", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(signedIn ? { Cookie: `slirc_session=${token}` } : {}) },
  body: JSON.stringify(body),
});

test("photo upload requires sign-in and rejects a changed account before writing", async () => {
  expect((await upload({ mime: "image/png", data: png, accountId }, false)).status).toBe(401);
  const wrongAccount = await upload({ mime: "image/png", data: png, accountId: "previous-account" });
  expect(wrongAccount.status).toBe(409);
  expect((await upload(null)).status).toBe(400);
  expect(await Bun.file(join(directory, "avatars", "bitbonsai")).exists()).toBe(false);
});

test("a valid photo is served, invalid replacement preserves it, and legacy uploads still work", async () => {
  const response = await upload({ mime: "image/png", data: png, accountId });
  expect(response.status).toBe(200);
  const profile = await response.json();
  expect(profile.avatarUrl).toMatch(/^\/avatars\/bitbonsai\?v=\d+$/);
  const served = await app.request(profile.avatarUrl, { headers: { Cookie: `slirc_session=${token}` } });
  expect(served.status).toBe(200);
  // Stored as a re-encoded WebP, like message photos, so metadata never survives.
  expect(served.headers.get("content-type")).toBe("image/webp");
  const stored = Buffer.from(await served.arrayBuffer());
  expect((await new Bun.Image(stored).metadata()).format).toBe("webp");
  expect((await upload({ mime: "image/png", data: btoa("not an image"), accountId })).status).toBe(400);
  expect(Buffer.from(await Bun.file(join(directory, "avatars", "bitbonsai")).arrayBuffer()).equals(stored)).toBe(true);
  const webp = await new Bun.Image(Buffer.from(png, "base64")).webp().toBuffer();
  expect((await upload({ mime: "image/webp", data: Buffer.from(webp).toString("base64") })).status).toBe(200);
});

test("each upload bumps the version, and only versioned avatar URLs are cached for good", async () => {
  const headers = { Cookie: `slirc_session=${token}` };
  const first = await (await upload({ mime: "image/png", data: png, accountId })).json();
  const second = await (await upload({ mime: "image/png", data: png, accountId })).json();
  expect(first.avatarVersion).toBeGreaterThan(0);
  expect(second.avatarVersion).toBeGreaterThan(first.avatarVersion);
  expect(second.avatarUrl).toBe(`/avatars/bitbonsai?v=${second.avatarVersion}`);
  expect((await (await app.request("/profiles/bitbonsai", { headers })).json()).avatarVersion).toBe(second.avatarVersion);
  const cache = async (path: string) => (await app.request(path, { headers })).headers.get("cache-control");
  expect(await cache(second.avatarUrl)).toBe("private, max-age=31536000, immutable");
  expect(await cache("/avatars/bitbonsai")).toBe("private, max-age=300");
  // No photo: the generated initial is never versioned, so a later upload shows within minutes.
  expect(await cache("/avatars/nophoto")).toBe("private, max-age=300");
  expect(await cache("/avatars/nophoto?v=1")).toBe("private, max-age=31536000, immutable");
});

// A real decompression bomb: a 10000x10000 grayscale PNG whose IDAT inflates to 100 MB of zeros
// but ships as about 100 KB. Deflated in slices so the test never holds the raw pixels.
async function bombPng(side: number) {
  const { createDeflate, crc32 } = await import("node:zlib");
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth; colour type 0 (grayscale), default compression, filter, no interlace
  const deflate = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on("data", (part: Buffer) => parts.push(part));
  const done = new Promise((resolve) => deflate.on("end", resolve));
  // 100 filtered rows per write: about 1 MB of zeros, reused.
  const rows = Buffer.alloc((side + 1) * 100);
  for (let y = 0; y < side; y += 100) {
    if (!deflate.write(rows)) await new Promise((resolve) => deflate.once("drain", resolve));
  }
  deflate.end();
  await done;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", Buffer.concat(parts)), chunk("IEND", Buffer.alloc(0))]);
}

test("a decompression-bomb photo is refused with a clear error and memory stays flat", async () => {
  const before = await Bun.file(join(directory, "avatars", "bitbonsai")).arrayBuffer();
  const bomb = await bombPng(10_000);
  expect(bomb.byteLength).toBeLessThan(200_000);
  Bun.gc(true);
  const rss = process.memoryUsage().rss;
  const response = await upload({ mime: "image/png", data: bomb.toString("base64"), accountId });
  expect(response.status).toBe(413);
  expect((await response.json()).error).toBe("That image has too many pixels.");
  // Decoding it would allocate 100 MB of pixels at least (545 MB RSS before the fix).
  expect(process.memoryUsage().rss - rss).toBeLessThan(50 * 1024 * 1024);
  expect(Buffer.from(await Bun.file(join(directory, "avatars", "bitbonsai")).arrayBuffer()).equals(Buffer.from(before))).toBe(true);
});

test("an oversized request body is refused before it is read", async () => {
  const response = await upload({ mime: "image/png", data: "A".repeat(7 * 1024 * 1024), accountId });
  expect(response.status).toBe(413);
  expect((await response.json()).error).toBe("image must be under 4 MB");
});
