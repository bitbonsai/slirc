// Reading a page someone else controls: the patterns stay linear on hostile input, a slow read
// is cut off, and thumbnails take turns and refuse oversized sources.
import "./fixture.ts";

import { expect, test } from "bun:test";

process.chdir(new URL("..", import.meta.url).pathname);
const { describeHtml, extractReadable, within, HEAD_MAX_CHARS, PAGE_MAX_BYTES } = await import("../src/links-fetch.ts");
const { parseOg } = await import("../src/og.ts");
const { makeThumbnail, THUMB_MAX_PIXELS } = await import("../src/links-images.ts");
const { linkKey } = await import("../src/links.ts");

const BASE = new URL("https://example.com/");
const timed = async (work: () => unknown) => { const start = performance.now(); await work(); return performance.now() - start; };
// 1.5 MB of a tag that never closes: each start once scanned to the end of the page.
const hostile = (piece: string) => piece.repeat(Math.ceil(PAGE_MAX_BYTES / piece.length));

test("1.5 MB of unclosed tags is read quickly by every function a page reaches", async () => {
  for (const piece of ["<meta ", "<title>", "<meta name=\"description\" ", "<meta property='og:title' content='x", "<title", "<"]) {
    const page = hostile(piece);
    expect(page.length).toBeGreaterThanOrEqual(PAGE_MAX_BYTES);
    expect(await timed(() => parseOg(page))).toBeLessThan(1_000);
    expect(await timed(() => describeHtml(page, BASE))).toBeLessThan(1_000);
    expect(await timed(() => extractReadable(page))).toBeLessThan(3_000);
  }
});

test("a normal page still reads the same, and only the head is searched", () => {
  const head = `<html><head><title lang="en">A &amp; B</title><meta name="description" content="What it says."><meta property="og:image" content="/c.png"><meta property="og:site_name" content="Site"></head>`;
  expect(describeHtml(`${head}<body><p>text</p></body></html>`, BASE)).toEqual({ title: "A & B", description: "What it says.", site: "Site", image: "https://example.com/c.png" });
  expect(describeHtml(`<title>Plain</title>`, BASE).title).toBe("Plain");
  // og values come back decoded once from parseOg: an escaped entity stays literal text.
  expect(describeHtml(`<meta property="og:title" content="Use &amp;lt;b&amp;gt;"><meta property="og:image" content="/i?a=1&amp;b=2">`, BASE)).toMatchObject({ title: "Use &lt;b&gt;", image: "https://example.com/i?a=1&b=2" });
  // A title far past the head is not looked for.
  expect(describeHtml(`${"<p>filler</p>".repeat(HEAD_MAX_CHARS / 10)}<title>Too late</title>`, BASE).title).toBe("");
  expect(parseOg(`<meta property="og:title" content="One"><meta property="og:title" content="Two">`).title).toBe("One");
});

test("a read that drips in is cut off and its connection closed", async () => {
  let closed = 0;
  const page = { close() { closed++; } };
  await expect(within(page, new Promise<string>(() => {}), 30)).rejects.toThrow("timed out");
  expect(closed).toBe(1);
  expect(await within(page, Promise.resolve("ok"), 30)).toBe("ok");
  expect(closed).toBe(1);
});

test("thumbnails take turns, and a source over twelve megapixels is refused before decoding", async () => {
  const photo = new Uint8Array(await Bun.file("./public/og.jpg").arrayBuffer());
  // Many at once all finish: the pool makes them wait, it does not turn them away.
  const made = await Promise.all(Array.from({ length: 8 }, () => makeThumbnail(photo)));
  expect(made.every((image) => image && image.width === 320)).toBe(true);
  expect(THUMB_MAX_PIXELS).toBe(12_000_000);
  // A 5000 by 4000 picture, 20 megapixels, that compresses to almost nothing.
  const huge = new Uint8Array(await new Bun.Image(photo).resize(5000, 4000, { fit: "fill" }).png().toBuffer());
  expect(await makeThumbnail(huge)).toBeNull();
  // Uploads still work after the queue has drained.
  expect(await makeThumbnail(photo)).not.toBeNull();
});

test("a port that is not the scheme's own is part of the link", () => {
  expect(linkKey("https://example.com:8443/a")).toBe("example.com:8443/a");
  expect(linkKey("https://example.com:8443/a")).not.toBe(linkKey("https://example.com/a"));
  expect(linkKey("https://example.com:443/a")).toBe(linkKey("http://example.com:80/a"));
});
