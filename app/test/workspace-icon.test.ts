// Workspace icon: admin-only writes with the same-origin JSON guard, png/jpeg/webp only, a size cap,
// square input, WebP renditions without metadata, a public read path that works in a private
// workspace, and no way to reach the bytes through /uploads/:id.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

process.chdir(new URL("..", import.meta.url).pathname);
const ORIGIN = "https://slirc.test";
process.env.APP_ORIGIN = ORIGIN;
// The icon is read from other workspaces by people not signed in here, so the private mode matters.
process.env.SLIRC_MODE = "private_workspace";
process.env.OPEN_CHANNELS = "";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const headers = (token: string | null, extra: Record<string, string> = {}) => ({
  ...(token ? { Cookie: `slirc_session=${token}` } : {}),
  Origin: ORIGIN, "Content-Type": "application/json", "X-Slirc-Admin": "1", ...extra,
});
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function png(width: number, height: number): Promise<Uint8Array> {
  const raw = new Uint8Array(width * height * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256));
  // A 32-bit BMP, re-encoded as PNG.
  const bmp = Buffer.alloc(54 + width * height * 4);
  bmp.write("BM", 0, "ascii"); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(32, 28);
  Buffer.from(raw).copy(bmp, 54);
  return new Uint8Array(await new Bun.Image(new Uint8Array(bmp)).png().toBuffer());
}

// A JPEG carrying an EXIF APP1 with a GPS-looking marker string, to prove metadata does not survive.
async function jpegWithExif(size: number): Promise<Uint8Array> {
  const plain = Buffer.from(await new Bun.Image(await png(size, size)).jpeg({ quality: 80 }).toBuffer());
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), Buffer.from("II*\0\x08\0\0\0\0\0SECRET-GPS-48.8584N", "binary")]);
  const app1 = Buffer.alloc(4); app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(payload.length + 2, 2);
  return new Uint8Array(Buffer.concat([plain.subarray(0, 2), app1, payload, plain.subarray(2)]));
}

const post = (token: string | null, body: unknown, extra: Record<string, string> = {}) =>
  app.request("/api/admin/workspace-icon", { method: "POST", headers: headers(token, extra), body: JSON.stringify(body) });

beforeEach(() => {
  db.query("DELETE FROM uploads").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM accounts WHERE nick IN ('member', 'unverified')").run();
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('member', 'm@example.com', 'member', 'human', ?, ?), ('unverified', 'u@example.com', 'admin', 'human', NULL, ?)")
    .run(Date.now(), Date.now(), Date.now());
  for (const [token, nick] of [["admin", "bitbonsai"], ["member", "member"], ["unverified", "unverified"]]) {
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(hash(token), nick, Date.now());
  }
});

describe("workspace icon writes", () => {
  test("an admin saves a square icon; both renditions are WebP at 64 and 256 px", async () => {
    const response = await post("admin", { mime: "image/png", data: b64(await png(300, 300)) });
    expect(response.status).toBe(200);
    for (const size of [64, 256]) {
      const read = await app.request(`/api/workspace-icon?size=${size}`);
      expect(read.status).toBe(200);
      expect(read.headers.get("Content-Type")).toBe("image/webp");
      const meta = await new Bun.Image(new Uint8Array(await read.arrayBuffer())).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["webp", size, size]);
    }
  });

  test("metadata from the original never reaches the stored icon", async () => {
    const source = await jpegWithExif(128);
    expect(Buffer.from(source).includes("SECRET-GPS")).toBe(true);
    expect((await post("admin", { mime: "image/jpeg", data: b64(source) })).status).toBe(200);
    const stored = db.query("SELECT data FROM uploads WHERE channel = 'workspace-icon'").all() as { data: Uint8Array }[];
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(Buffer.from(row.data).includes("SECRET-GPS")).toBe(false);
      expect(Buffer.from(row.data).includes("Exif")).toBe(false);
    }
  });

  test("a member, an unverified admin and a signed-out visitor cannot write or remove it", async () => {
    const data = b64(await png(64, 64));
    expect((await post("member", { mime: "image/png", data })).status).toBe(403);
    expect((await post("unverified", { mime: "image/png", data })).status).toBe(403);
    expect((await post(null, { mime: "image/png", data })).status).toBe(401);
    expect((await post("admin", { mime: "image/png", data })).status).toBe(200);
    const remove = (token: string | null) => app.request("/api/admin/workspace-icon", { method: "DELETE", headers: headers(token) });
    expect((await remove("member")).status).toBe(403);
    expect((await remove(null)).status).toBe(401);
    expect((await app.request("/api/workspace-icon")).status).toBe(200);
  });

  test("cross-site writes are refused even from an admin", async () => {
    const data = b64(await png(64, 64));
    expect((await post("admin", { mime: "image/png", data }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("admin", { mime: "image/png", data }, { "X-Slirc-Admin": "" })).status).toBe(403);
    expect((await post("admin", { mime: "image/png", data }, { "Content-Type": "text/plain" })).status).toBe(403);
    const remove = await app.request("/api/admin/workspace-icon", { method: "DELETE", headers: headers("admin", { Origin: "https://evil.example" }) });
    expect(remove.status).toBe(403);
  });

  test("only still PNG, JPEG and WebP squares under the cap are accepted", async () => {
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
    expect((await post("admin", { mime: "image/gif", data: b64(gif) })).status).toBe(400);
    expect((await post("admin", { mime: "image/png", data: b64(gif) })).status).toBe(400);
    expect((await post("admin", { mime: "image/svg+xml", data: btoa("<svg/>") })).status).toBe(400);
    expect((await post("admin", { mime: "image/png", data: btoa("<svg xmlns='http://www.w3.org/2000/svg'/>") })).status).toBe(400);
    const wide = await post("admin", { mime: "image/png", data: b64(await png(120, 60)) });
    expect(wide.status).toBe(400);
    expect((await wide.json()).error).toContain("square");
    const huge = await post("admin", { mime: "image/png", data: "A".repeat(3 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect(db.query("SELECT COUNT(*) AS n FROM uploads").get()).toEqual({ n: 0 });
  });

  test("Remove brings back the letter tile", async () => {
    expect((await post("admin", { mime: "image/png", data: b64(await png(64, 64)) })).status).toBe(200);
    const removed = await app.request("/api/admin/workspace-icon", { method: "DELETE", headers: headers("admin") });
    expect(removed.status).toBe(204);
    expect((await app.request("/api/workspace-icon")).status).toBe(404);
  });
});

describe("the shell's icon flag", () => {
  const flag = async () => (await (await app.request("/")).text()).match(/<meta name="slirc-workspace-icon" content="([^"]*)" \/>/)?.[1] ?? null;

  test("with no icon the shell carries no flag, so the client asks for nothing", async () => {
    expect(await flag()).toBeNull();
  });

  test("a saved icon puts its version in the shell; Remove takes the flag away", async () => {
    const saved = await post("admin", { mime: "image/png", data: b64(await png(64, 64)) });
    const { version } = await saved.json() as { version: number };
    expect(await flag()).toBe(String(version));
    expect((await app.request(`/api/workspace-icon?size=64&v=${version}`)).status).toBe(200);
    expect((await app.request("/api/admin/workspace-icon", { method: "DELETE", headers: headers("admin") })).status).toBe(204);
    expect(await flag()).toBeNull();
  });
});

describe("workspace icon reads", () => {
  test("anyone can read it, cross-origin, with a short public cache and an ETag", async () => {
    expect((await post("admin", { mime: "image/png", data: b64(await png(64, 64)) })).status).toBe(200);
    const read = await app.request("/api/workspace-icon?size=64");
    expect(read.status).toBe(200);
    expect(read.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(read.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(read.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const etag = read.headers.get("ETag")!;
    expect(etag).toBeTruthy();
    expect((await app.request("/api/workspace-icon?size=64", { headers: { "If-None-Match": etag } })).status).toBe(304);
    // A new icon changes the ETag, so a cached copy is replaced on the next check.
    await Bun.sleep(2);
    expect((await post("admin", { mime: "image/png", data: b64(await png(80, 80)) })).status).toBe(200);
    expect((await app.request("/api/workspace-icon?size=64")).headers.get("ETag")).not.toBe(etag);
  });

  test("no icon is a cacheable 404", async () => {
    const read = await app.request("/api/workspace-icon");
    expect(read.status).toBe(404);
    expect(read.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  test("the stored renditions are not reachable through /uploads/:id", async () => {
    expect((await post("admin", { mime: "image/png", data: b64(await png(64, 64)) })).status).toBe(200);
    const { id } = db.query("SELECT id FROM uploads WHERE channel = 'workspace-icon' LIMIT 1").get() as { id: string };
    expect((await app.request(`/uploads/${id}`)).status).toBe(401);
    expect((await app.request(`/uploads/${id}`, { headers: { Cookie: "slirc_session=member" } })).status).toBe(403);
  });
});
