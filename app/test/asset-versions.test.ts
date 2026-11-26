// The shell addresses every first-party file it loads by a hash of that file's bytes, and the app
// sets its own cache headers: a versioned address may be kept for a year, the same file without
// its current version must be checked every time. A stale cached client.js once ran against new
// HTML for hours after a deploy.
import "./fixture.ts";

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.chdir(new URL("..", import.meta.url).pathname);
const { app, assetVersion, versionShell } = await import("../src/server.ts");

const LONG = "public, max-age=31536000, immutable";
const hashOf = async (path: string) => createHash("sha256").update(new Uint8Array(await Bun.file(`./public${path}`).arrayBuffer())).digest("hex").slice(0, 8);
const shell = async (path = "/") => (await app.request(path)).text();

test("the served shell references each file it loads with that file's hash", async () => {
  const html = await shell();
  const bundle = (await (await app.request("/api/version")).json()).version;
  expect(bundle).toMatch(/^[a-f0-9]{8}$/);
  expect(html).toContain(`<script type="module" src="/client.js?v=${bundle}"></script>`);
  expect(html).toContain(`href="/style.css?v=${await hashOf("/style.css")}"`);
  expect(html).toContain(`src="/theme.js?v=${await hashOf("/theme.js")}"`);
  expect(html).toContain(`src="/vendor/qrcode.js?v=${await hashOf("/vendor/qrcode.js")}"`);
  const sprite = await hashOf("/icons/lucide/sprite.svg");
  expect(html).toContain(`href="/icons/lucide/sprite.svg?v=${sprite}#plus"`);
  expect(html).toContain(`<meta name="slirc-sprite" content="${sprite}" />`);
  // The video encoder bundle is imported on demand by the address this meta gives.
  const video = await assetVersion("/video-encode.js");
  expect(video).toMatch(/^[a-f0-9]{8}$/);
  expect(html).toContain(`<meta name="slirc-video" content="${video}" />`);
  const encoder = await app.request(`/video-encode.js?v=${video}`);
  expect(encoder.status).toBe(200);
  expect(encoder.headers.get("Cache-Control")).toBe(LONG);
  expect(await encoder.text()).toContain("encodeVideo");
  // No script, stylesheet, manifest or sprite is left without a version.
  const bare = [...html.matchAll(/\b(?:href|src)="(\/[^"?#]+\.(?:js|css|webmanifest|svg))(?:#[^"]*)?"/g)].map((match) => match[1]);
  expect(bare).toEqual([]);
  // Every route that serves the shell does the same.
  for (const path of ["/dms", "/profile", "/dm/someone", "/index.html"]) expect(await shell(path)).toContain(`/client.js?v=${bundle}`);
});

test("the hash is the file's own, and a version already in the markup is replaced, not trusted", async () => {
  const css = await hashOf("/style.css");
  const page = `<head><link href="/style.css?v=stale" /><script src="/theme.js"></script><use href="/icons/lucide/sprite.svg#x"></use><script src="/missing.js"></script><a href="https://example.com/a.js">x</a></head>`;
  const out = await versionShell(page);
  expect(out).toContain(`href="/style.css?v=${css}"`);
  expect(out).toContain(`src="/theme.js?v=${await hashOf("/theme.js")}"`);
  expect(out).toContain(`href="/icons/lucide/sprite.svg?v=${await hashOf("/icons/lucide/sprite.svg")}#x"`);
  // A file that does not exist, and an address on another site, are left alone.
  expect(out).toContain('src="/missing.js"');
  expect(out).toContain('href="https://example.com/a.js"');
  // Different bytes, different hash.
  expect(await assetVersion("/style.css")).toBe(css);
  expect(css).not.toBe(await hashOf("/theme.js"));
  expect(await assetVersion("/../src/server.ts")).toBe("");
});

test("a versioned address may be kept for a year; without its current version a file is always checked", async () => {
  const bundle = (await (await app.request("/api/version")).json()).version;
  const cases: [string, string][] = [
    [`/client.js?v=${bundle}`, LONG], ["/client.js", "no-cache"], ["/client.js?v=00000000", "no-cache"],
    [`/style.css?v=${await hashOf("/style.css")}`, LONG], ["/style.css", "no-cache"], ["/style.css?v=old", "no-cache"],
    [`/theme.js?v=${await hashOf("/theme.js")}`, LONG], ["/theme.js", "no-cache"],
    [`/vendor/qrcode.js?v=${await hashOf("/vendor/qrcode.js")}`, LONG], ["/vendor/qrcode.js", "no-cache"],
    [`/icons/lucide/sprite.svg?v=${await hashOf("/icons/lucide/sprite.svg")}`, LONG], ["/icons/lucide/sprite.svg", "no-cache"],
    ["/manifest.webmanifest", "no-cache"],
    // The service worker and the page itself are never kept.
    ["/sw.js", "no-cache"], ["/sw.js?v=anything", "no-cache"], ["/", "no-cache"],
  ];
  for (const [path, expected] of cases) {
    const response = await app.request(path);
    expect([path, response.status, response.headers.get("cache-control")]).toEqual([path, 200, expected]);
  }
  // A missing file gets no long cache, and the API keeps its own rules.
  expect((await app.request("/nope.js?v=1")).headers.get("cache-control")).not.toBe(LONG);
  expect((await app.request("/api/version")).headers.get("cache-control")).toBe("no-store");
});

// The wordmark follows SLIRC_BRAND, defaulting to the neutral slirc.org mark.
test("the served shell names its wordmark brand from SLIRC_BRAND", async () => {
  const previous = process.env.SLIRC_BRAND;
  try {
    delete process.env.SLIRC_BRAND;
    expect(await versionShell('<html lang="en"><head></head></html>')).toContain('<html data-brand="org" lang="en">');
    process.env.SLIRC_BRAND = "slirc.org";
    expect(await versionShell('<html lang="en"><head></head></html>')).toContain('<html data-brand="org" lang="en">');
    process.env.SLIRC_BRAND = "slirc.app";
    expect(await versionShell('<html lang="en"><head></head></html>')).toContain('<html data-brand="app" lang="en">');
  } finally {
    if (previous === undefined) delete process.env.SLIRC_BRAND;
    else process.env.SLIRC_BRAND = previous;
  }
});
