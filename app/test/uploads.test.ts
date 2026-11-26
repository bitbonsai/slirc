// Server photo boundary: Bun.Image normalization (format, bounds, orientation,
// EXIF strip, alpha, animation rejection) and upload read/write authorization
// (membership, revocation, threads, public/emoji exceptions, ranges).
import "./fixture.ts";

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { beforeEach, describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const { canReadUploadChannel, IMAGE_LIMITS, normalizeUploadImage, PhotoError, UPLOAD_LIMITS, withUploadSlot } = await import("../src/photo.ts");

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function session(token: string, nick: string): void {
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(hashToken(token), nick, Date.now());
}

function accountId(nick: string): string {
  return (db.query("SELECT account_id FROM accounts WHERE nick = ?").get(nick) as { account_id: string }).account_id;
}

// --- image builders -------------------------------------------------------

function bmp(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(54 + dataSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = 54 + y * rowSize + x * 3;
    const [b, g, r] = pixel(x, y);
    buf[offset] = b; buf[offset + 1] = g; buf[offset + 2] = r;
  }
  return new Uint8Array(buf);
}

function jpeg(width: number, height: number): Promise<Uint8Array> {
  return new Bun.Image(bmp(width, height, (x, y) => [x % 256, y % 256, 90])).jpeg({ quality: 80 }).toBuffer().then((b) => new Uint8Array(b));
}

// Minimal little-endian EXIF APP1 carrying an Orientation tag. The TIFF header
// must follow "Exif\0\0" directly; extra provenance text goes in a COM segment.
function exifApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const app1 = Buffer.alloc(4 + payload.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  return app1;
}

function commentSegment(text: string): Buffer {
  const payload = Buffer.from(text, "ascii");
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff; segment[1] = 0xfe;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const tag = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}

function pngRGBA(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 4) + 1 + x * 4;
      const [r, g, b, a] = pixel(x, y);
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b; raw[offset + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function webpChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, "ascii"), length, data, Buffer.alloc(data.length & 1)]);
}

function webpBytes(vp8xFlags: number | null, chunks: [string, Buffer][]): Uint8Array {
  const parts: Buffer[] = [];
  if (vp8xFlags !== null) parts.push(webpChunk("VP8X", Buffer.from([vp8xFlags, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
  for (const [type, data] of chunks) parts.push(webpChunk(type, data));
  const body = Buffer.concat(parts);
  const riff = Buffer.alloc(4); riff.write("RIFF", 0, "ascii");
  const size = Buffer.alloc(4); size.writeUInt32LE(4 + body.length);
  return new Uint8Array(Buffer.concat([riff, size, Buffer.from("WEBP", "ascii"), body]));
}

function stalledStream(): { stream: ReadableStream<Uint8Array>; close: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode("{")); } });
  return { stream, close: () => { controller.enqueue(new TextEncoder().encode("}")); controller.close(); } };
}

function webpHasAlpha(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (type === "VP8X") return (bytes[offset + 8] & 0x10) !== 0;
    offset += 8 + size + (size & 1);
  }
  return false;
}

// --- fixtures -------------------------------------------------------------

const SECRET = "#secret";
const OPEN = "#help";
const THREAD = "#t-aaa111";
const WS_THREAD = "#t-bbb222";

function upload(id: string, channel: string, bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])): void {
  db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES (?, 'bitbonsai', ?, 'image', 'image/webp', ?, ?)")
    .run(id, channel, bytes, Date.now());
}

beforeEach(() => {
  db.query("DELETE FROM uploads").run();
  db.query("DELETE FROM custom_emoji").run();
  db.query("DELETE FROM threads").run();
  db.query("DELETE FROM channels").run();
  db.query("DELETE FROM channel_members").run();
  db.query("DELETE FROM sessions").run();
  for (const [nick, email] of [["eve", "eve@example.test"], ["mallory", "mallory@example.test"]] as const) {
    db.query(`INSERT OR IGNORE INTO accounts (nick, email, role, kind, owner, verified_at, provisional_expires_at, created_at)
              VALUES (?, ?, 'member', 'human', NULL, ?, NULL, ?)`).run(nick, email, Date.now(), Date.now());
  }
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, 'bitbonsai', 'secret', 1)").run(SECRET);
  db.query("INSERT INTO channel_members (channel, nick) VALUES (?, 'bitbonsai'), (?, 'eve')").run(SECRET, SECRET);
  session("eve-session", "eve");
  session("bit-session", "bitbonsai");
  session("mallory-session", "mallory");
});

describe("normalizeUploadImage", () => {
  test("re-encodes a large still to a bounded WebP and drops EXIF", async () => {
    const source = await jpeg(2000, 1000);
    const withExif = new Uint8Array([source[0], source[1], ...commentSegment("GPSLatitude"), ...exifApp1(1), ...source.subarray(2)]);
    const normalized = await normalizeUploadImage(withExif);
    expect(normalized.mime).toBe("image/webp");
    expect(normalized.width).toBe(1600);
    expect(normalized.height).toBe(800);
    expect(normalized.bytes.byteLength).toBeLessThanOrEqual(IMAGE_LIMITS.maxOutputBytes);
    expect(new TextDecoder().decode(normalized.bytes)).not.toContain("Exif");
    expect(new TextDecoder().decode(normalized.bytes)).not.toContain("GPSLatitude");
  });

  test("applies EXIF orientation before resizing", async () => {
    const source = await jpeg(40, 20);
    const oriented = new Uint8Array([source[0], source[1], ...exifApp1(6), ...source.subarray(2)]);
    const normalized = await normalizeUploadImage(oriented);
    expect(normalized.width).toBe(20);
    expect(normalized.height).toBe(40);
  });

  test("keeps alpha in the WebP output", async () => {
    const source = new Uint8Array(pngRGBA(4, 4, (x) => [30, 90, 200, x === 0 ? 0 : 255]));
    const normalized = await normalizeUploadImage(source);
    expect(normalized.mime).toBe("image/webp");
    expect(webpHasAlpha(normalized.bytes)).toBe(true);
  });

  test("rejects animated containers instead of flattening them", async () => {
    const base = pngRGBA(4, 4, () => [0, 0, 0, 255]);
    const apng = Buffer.concat([base.subarray(0, 8), pngChunk("acTL", Buffer.alloc(8)), base.subarray(8)]);
    await expect(normalizeUploadImage(apng)).rejects.toThrow(/Animated/);
    // APNG frame chunks without acTL are rejected defensively too.
    const fcTL = Buffer.concat([base.subarray(0, 8), pngChunk("fcTL", Buffer.alloc(26)), base.subarray(8)]);
    await expect(normalizeUploadImage(fcTL)).rejects.toThrow(/Animated/);
    // A non-animated VP8X must not hide a later ANIM chunk.
    const sneaky = webpBytes(0, [["ANIM", Buffer.alloc(6)]]);
    await expect(normalizeUploadImage(sneaky)).rejects.toThrow(/Animated/);
    const flagged = webpBytes(0x02, []);
    await expect(normalizeUploadImage(flagged)).rejects.toThrow(/Animated/);
    // GIF is rejected on its own terms, not with the animation message.
    const gif = new Uint8Array(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary"));
    await expect(normalizeUploadImage(gif)).rejects.toThrow(/GIF uploads are not supported/);
  });

  test("rejects malformed, oversized, and pixel-bomb input", async () => {
    await expect(normalizeUploadImage(new Uint8Array(Buffer.from("not an image at all")))).rejects.toBeInstanceOf(PhotoError);
    await expect(normalizeUploadImage(new Uint8Array(IMAGE_LIMITS.maxOriginalBytes + 1))).rejects.toMatchObject({ status: 413 });
    const bomb = Buffer.alloc(54);
    bomb.write("BM", 0, "ascii");
    bomb.writeUInt32LE(54, 2);
    bomb.writeUInt32LE(54, 10);
    bomb.writeUInt32LE(40, 14);
    bomb.writeInt32LE(40_000, 18);
    bomb.writeInt32LE(40_000, 22);
    bomb.writeUInt16LE(1, 26);
    bomb.writeUInt16LE(24, 28);
    await expect(normalizeUploadImage(new Uint8Array(bomb))).rejects.toMatchObject({ status: 413 });
  });
});

describe("POST /api/uploads", () => {
  test("stores normalized WebP with dimensions and keeps legacy clients working", async () => {
    const source = await jpeg(40, 20);
    const created = await app.request("/api/uploads", {
      method: "POST",
      headers: auth("bit-session"),
      body: JSON.stringify({ channel: OPEN, kind: "image", mime: "image/jpeg", data: b64(source), accountId: accountId("bitbonsai") }),
    });
    expect(created.status).toBe(200);
    const body = await created.json() as { url: string; mime: string; width: number; height: number };
    expect(body.url).toMatch(/^\/uploads\/[^?]+\?type=image$/);
    expect(body.mime).toBe("image/webp");
    expect(body.width).toBe(40);
    expect(body.height).toBe(20);
    const row = db.query("SELECT mime, data FROM uploads WHERE id = ?").get(body.url.slice("/uploads/".length, body.url.indexOf("?"))) as { mime: string; data: Uint8Array };
    expect(row.mime).toBe("image/webp");
    expect(row.data.byteLength).toBeGreaterThan(0);
  });

  test("records the stored size and serves it to readers who may see the room", async () => {
    const source = await jpeg(60, 30);
    const created = await app.request("/api/uploads", {
      method: "POST",
      headers: auth("bit-session"),
      body: JSON.stringify({ channel: OPEN, kind: "image", mime: "image/jpeg", data: b64(source), accountId: accountId("bitbonsai") }),
    });
    expect(created.status).toBe(200);
    const { url } = await created.json() as { url: string };
    const id = url.slice("/uploads/".length, url.indexOf("?"));
    // The row keeps the size the re-encode reported, so a reader reserves the box before the bytes.
    const stored = db.query("SELECT width, height FROM uploads WHERE id = ?").get(id) as { width: number; height: number };
    expect([stored.width, stored.height]).toEqual([60, 30]);
    const dims = await app.request(`/api/uploads/dims?ids=${id},missing,${id}`, { headers: auth("bit-session") });
    expect(dims.status).toBe(200);
    expect(await dims.json()).toEqual({ [id]: { width: 60, height: 30 } });
  });

  test("a video keeps the size its uploader reported, and absurd values are dropped", async () => {
    const bytes = new Uint8Array(2048);
    const send = (extra: Record<string, unknown>) => app.request("/api/uploads", {
      method: "POST",
      headers: auth("bit-session"),
      body: JSON.stringify({ channel: OPEN, kind: "video", mime: "video/mp4", data: b64(bytes), accountId: accountId("bitbonsai"), ...extra }),
    });
    const portrait = await send({ width: 1080, height: 1920 });
    expect(portrait.status).toBe(200);
    const { url } = await portrait.json() as { url: string };
    const id = url.slice("/uploads/".length, url.indexOf("?"));
    const row = db.query("SELECT width, height FROM uploads WHERE id = ?").get(id) as { width: number; height: number };
    expect([row.width, row.height]).toEqual([1080, 1920]);
    // Layout metadata only: a nonsense size is dropped, the clip is still stored.
    for (const extra of [{ width: -1, height: 1920 }, { width: 1080 }, { width: "1080", height: 1920 }, { width: 99_999, height: 1920 }]) {
      const response = await send(extra);
      expect(response.status).toBe(200);
      const other = (await response.json() as { url: string }).url;
      const otherId = other.slice("/uploads/".length, other.indexOf("?"));
      const kept = db.query("SELECT width, height FROM uploads WHERE id = ?").get(otherId) as { width: number | null; height: number | null };
      expect([kept.width, kept.height]).toEqual([null, null]);
    }
  });

  test("dims are only for readers who may see that room", async () => {
    upload("secret-photo", SECRET);
    db.query("UPDATE uploads SET width = 800, height = 600 WHERE id = 'secret-photo'").run();
    const asMember = await app.request("/api/uploads/dims?ids=secret-photo", { headers: auth("bit-session") });
    expect(await asMember.json()).toEqual({ "secret-photo": { width: 800, height: 600 } });
    const asOutsider = await app.request("/api/uploads/dims?ids=secret-photo", { headers: auth("mallory-session") });
    expect(await asOutsider.json()).toEqual({});
    const anonymous = await app.request("/api/uploads/dims?ids=secret-photo");
    expect(await anonymous.json()).toEqual({});
    // A stored photo from before sizes were kept has none; the reader keeps its default box.
    upload("old-photo", OPEN);
    const old = await app.request("/api/uploads/dims?ids=old-photo", { headers: auth("bit-session") });
    expect(await old.json()).toEqual({});
  });

  test("stores an iPhone video as sent and serves it with byte ranges", async () => {
    const bytes = new Uint8Array(4096).map((_, index) => index % 251);
    const created = await app.request("/api/uploads", {
      method: "POST",
      headers: auth("bit-session"),
      body: JSON.stringify({ channel: OPEN, kind: "video", mime: "video/quicktime", data: b64(bytes), accountId: accountId("bitbonsai") }),
    });
    expect(created.status).toBe(200);
    const { url, mime } = await created.json() as { url: string; mime: string };
    expect(url).toMatch(/^\/uploads\/[^?]+\?type=video$/);
    expect(mime).toBe("video/quicktime");
    const ranged = await app.request(url, { headers: { ...auth("bit-session"), Range: "bytes=0-99" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-type")).toBe("video/quicktime");
    expect(ranged.headers.get("content-range")).toBe("bytes 0-99/4096");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.subarray(0, 100));
    for (const refused of ["video/x-matroska", "video/avi"]) {
      const response = await app.request("/api/uploads", {
        method: "POST",
        headers: auth("bit-session"),
        body: JSON.stringify({ channel: OPEN, kind: "video", mime: refused, data: b64(bytes), accountId: accountId("bitbonsai") }),
      });
      expect(response.status).toBe(400);
    }
  });

  test("a Notes image is readable only by the account that pasted it", async () => {
    const created = await app.request("/api/uploads", {
      method: "POST",
      headers: auth("eve-session"),
      body: JSON.stringify({ channel: "notes", kind: "image", mime: "image/jpeg", data: b64(await jpeg(8, 8)), accountId: accountId("eve") }),
    });
    expect(created.status).toBe(200);
    const { url } = await created.json() as { url: string };
    const row = db.query("SELECT channel FROM uploads WHERE id = ?").get(url.slice("/uploads/".length, url.indexOf("?"))) as { channel: string };
    expect(row.channel).toBe(`notes:${accountId("eve")}`);
    expect((await app.request(url, { headers: auth("eve-session") })).status).toBe(200);
    expect((await app.request(url, { headers: auth("mallory-session") })).status).toBe(403);
    expect((await app.request(url)).status).toBe(401);
    expect(canReadUploadChannel(null, row.channel)).toBe(false);
  });

  test("rejects an account mismatch before work and writes nothing", async () => {
    const before = (db.query("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n;
    const source = await jpeg(4, 4);
    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: auth("bit-session"),
      body: JSON.stringify({ channel: OPEN, kind: "image", mime: "image/jpeg", data: b64(source), accountId: "not-this-account" }),
    });
    expect(response.status).toBe(409);
    expect((db.query("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n).toBe(before);
  });

  test("rejects prototype-like kinds and mismatched kind/mime families without writing", async () => {
    const before = (db.query("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n;
    const source = await jpeg(4, 4);
    const payloads: { kind: unknown; mime: string }[] = [
      { kind: "constructor", mime: "image/png" },
      { kind: "toString", mime: "image/png" },
      { kind: "__proto__", mime: "image/png" },
      { kind: "hasOwnProperty", mime: "image/png" },
      { kind: [], mime: "image/png" },
      { kind: {}, mime: "image/png" },
      { kind: null, mime: "image/png" },
      { kind: "video", mime: "image/png" },
      { kind: "image", mime: "video/mp4" },
    ];
    for (const payload of payloads) {
      const response = await app.request("/api/uploads", {
        method: "POST",
        headers: auth("bit-session"),
        body: JSON.stringify({ accountId: accountId("bitbonsai"), channel: OPEN, data: b64(source), ...payload }),
      });
      expect(response.status).toBe(400);
    }
    expect((db.query("SELECT COUNT(*) AS n FROM uploads").get() as { n: number }).n).toBe(before);
  });

  test("caps concurrent upload slots and releases them", async () => {
    const gates: (() => void)[] = [];
    const hold = () => withUploadSlot(() => new Promise<void>((resolve) => { gates.push(resolve); }));
    const first = hold();
    const second = hold();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(withUploadSlot(async () => "third")).rejects.toMatchObject({ status: 503 });
    for (const release of gates) release();
    await Promise.all([first, second]);
    await expect(withUploadSlot(async () => "after")).resolves.toBe("after");
  });

  test("gates the route before body buffering and refuses a third concurrent upload", async () => {
    const one = stalledStream();
    const two = stalledStream();
    const req = (stream: ReadableStream<Uint8Array>) => app.request("/api/uploads", { method: "POST", headers: auth("bit-session"), body: stream, duplex: "half" } as RequestInit);
    const pendingOne = req(one.stream);
    const pendingTwo = req(two.stream);
    const source = await jpeg(4, 4);
    let sawBusy = false;
    for (let i = 0; i < 50 && !sawBusy; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const probe = await app.request("/api/uploads", { method: "POST", headers: auth("bit-session"), body: JSON.stringify({ channel: OPEN, kind: "image", mime: "image/jpeg", data: b64(source) }) });
      if (probe.status === 503) sawBusy = true;
    }
    expect(sawBusy).toBe(true);
    one.close(); two.close();
    await Promise.allSettled([pendingOne, pendingTwo]);
  });

  test("abandons a stalled body, frees the slot, and reports a timeout", async () => {
    const previous = UPLOAD_LIMITS.bodyReadTimeoutMs;
    UPLOAD_LIMITS.bodyReadTimeoutMs = 40;
    try {
      const stalled = await app.request("/api/uploads", { method: "POST", headers: auth("bit-session"), body: stalledStream().stream, duplex: "half" } as RequestInit);
      expect(stalled.status).toBe(408);
      const source = await jpeg(8, 8);
      const after = await app.request("/api/uploads", { method: "POST", headers: auth("bit-session"), body: JSON.stringify({ channel: OPEN, kind: "image", mime: "image/jpeg", data: b64(source) }) });
      expect(after.status).toBe(200);
    } finally {
      UPLOAD_LIMITS.bodyReadTimeoutMs = previous;
    }
  });

  test("refuses a nonmember, and a revoked member is rechecked after decode", async () => {
    const source = await jpeg(4, 4);
    const denied = await app.request("/api/uploads", {
      method: "POST",
      headers: auth("mallory-session"),
      body: JSON.stringify({ accountId: accountId("mallory"), channel: SECRET, kind: "image", mime: "image/jpeg", data: b64(source) }),
    });
    expect(denied.status).toBe(403);

    const real = Bun.Image;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reachedDecode = false;
    let decoded!: () => void;
    const started = new Promise<void>((resolve) => { decoded = resolve; });
    (Bun as unknown as { Image: unknown }).Image = function (...args: unknown[]) {
      const instance = new (real as new (...a: unknown[]) => { metadata: () => Promise<unknown> })(...args);
      const metadata = instance.metadata.bind(instance);
      instance.metadata = () => {
        reachedDecode = true;
        decoded();
        return gate.then(() => metadata());
      };
      return instance;
    };
    try {
      const pending = app.request("/api/uploads", {
        method: "POST",
        headers: auth("eve-session"),
        body: JSON.stringify({ accountId: accountId("eve"), channel: SECRET, kind: "image", mime: "image/jpeg", data: b64(source) }),
      });
      await started;
      expect(reachedDecode).toBe(true);
      db.query("DELETE FROM channel_members WHERE channel = ? AND nick = 'eve'").run(SECRET);
      release();
      const response = await pending;
      expect(response.status).toBe(403);
      expect((db.query("SELECT COUNT(*) AS n FROM uploads WHERE nick = 'eve'").get() as { n: number }).n).toBe(0);
    } finally {
      (Bun as unknown as { Image: unknown }).Image = real;
    }
  });

  test("bounds the payload per kind even when Content-Length lies", async () => {
    const oversized = new Uint8Array(IMAGE_LIMITS.maxOriginalBytes + 1024);
    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: { ...auth("bit-session"), "Content-Length": "5" },
      body: JSON.stringify({ accountId: accountId("bitbonsai"), channel: OPEN, kind: "image", mime: "image/png", data: b64(oversized) }),
    });
    expect(response.status).toBe(413);
  });

  test("accepts a streamed body with no Content-Length", async () => {
    const source = await jpeg(8, 8);
    const payload = JSON.stringify({ accountId: accountId("bitbonsai"), channel: OPEN, kind: "image", mime: "image/jpeg", data: b64(source) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); },
    });
    const response = await app.request("/api/uploads", { method: "POST", headers: auth("bit-session"), body: stream, duplex: "half" } as RequestInit);
    expect(response.status).toBe(200);
  });
});

describe("GET /uploads/:id authorization", () => {
  test("member, nonmember, guest, former member, and ranges", async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    upload("secret-upload", SECRET, bytes);

    expect((await app.request("/uploads/secret-upload")).status).toBe(401);
    expect((await app.request("/uploads/secret-upload", { headers: auth("mallory-session") })).status).toBe(403);

    const member = await app.request("/uploads/secret-upload", { headers: auth("eve-session") });
    expect(member.status).toBe(200);
    expect(member.headers.get("Cache-Control")).toContain("no-store");
    expect(member.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect([...new Uint8Array(await member.arrayBuffer())]).toEqual([...bytes]);

    const ranged = await app.request("/uploads/secret-upload", { headers: { ...auth("eve-session"), Range: "bytes=2-4" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toBe("bytes 2-4/8");
    expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([30, 40, 50]);

    // A denied range must not leak length or advertize ranges.
    const deniedRange = await app.request("/uploads/secret-upload", { headers: { ...auth("mallory-session"), Range: "bytes=2-4" } });
    expect(deniedRange.status).toBe(403);
    expect(deniedRange.headers.get("Content-Range")).toBeNull();
    expect(deniedRange.headers.get("Accept-Ranges")).toBeNull();

    // Former member: revocation takes effect on the next read.
    session("former-session", "eve");
    db.query("DELETE FROM channel_members WHERE channel = ? AND nick = 'eve'").run(SECRET);
    expect((await app.request("/uploads/secret-upload", { headers: auth("former-session") })).status).toBe(403);
  });

  test("open-room uploads and global custom emoji stay public", async () => {
    upload("public-upload", OPEN, new Uint8Array([1, 2, 3]));
    const open = await app.request("/uploads/public-upload");
    expect(open.status).toBe(200);
    expect(open.headers.get("Cache-Control")).toContain("public");
    expect([...new Uint8Array(await open.arrayBuffer())]).toEqual([1, 2, 3]);

    upload("emoji-upload", SECRET, new Uint8Array([9, 9]));
    db.query("INSERT INTO custom_emoji (name, upload_id, added_by, created_at) VALUES ('party', 'emoji-upload', 'bitbonsai', 1)").run();
    expect((await app.request("/uploads/emoji-upload")).status).toBe(200);
  });

  test("secret thread children need child and parent access; open parents do not leak them", async () => {
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, 'bitbonsai', 'secret', 1)").run(THREAD);
    db.query("INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES (?, ?, 'm', 'T', '', 'x', '', '', 'bitbonsai', 1, 1)").run(THREAD, SECRET);
    upload("thread-upload", THREAD, new Uint8Array([7]));

    // Parent member without the child grant is refused.
    expect((await app.request("/uploads/thread-upload", { headers: auth("eve-session") })).status).toBe(403);
    db.query("INSERT INTO channel_members (channel, nick) VALUES (?, 'eve')").run(THREAD);
    expect((await app.request("/uploads/thread-upload", { headers: auth("eve-session") })).status).toBe(200);
    // Losing the parent revokes the child even while the child grant stays.
    db.query("DELETE FROM channel_members WHERE channel = ? AND nick = 'eve'").run(SECRET);
    expect((await app.request("/uploads/thread-upload", { headers: auth("eve-session") })).status).toBe(403);

    // Secret child under an open parent is never anonymous-readable.
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, 'bitbonsai', 'secret', 1)").run(WS_THREAD);
    db.query("INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES (?, '#help', 'm', 'U', '', 'x', '', '', 'bitbonsai', 1, 1)").run(WS_THREAD);
    db.query("INSERT INTO channel_members (channel, nick) VALUES (?, 'eve')").run(WS_THREAD);
    upload("open-thread-upload", WS_THREAD, new Uint8Array([8]));
    expect((await app.request("/uploads/open-thread-upload")).status).toBe(401);
    expect(canReadUploadChannel(null, WS_THREAD)).toBe(false);
  });
});
