// Carrying fetched content between instances: the export leaves out private-channel links, and
// the import fills gaps only, never overwrites, and changes nothing when run twice.
import "./fixture.ts";

process.env.SLIRC_HELPERS = "help,links";

import { beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { recordShare, searchLinks, storedFavicon, storeFavicon } = await import("../src/links.ts");
const images = await import("../src/links-images.ts");
const { exportContent, importContent } = await import("../src/links-content.ts");

const WEBP = new Uint8Array([82, 73, 70, 70, 9, 9, 9, 9, 87, 69, 66, 80]);
const link = (url: string, scope = "") => recordShare({ url, scope, title: "T", sharedAt: 1_000, sharerName: "Ada Example", sharerAccount: "acct-ada", enriched: true })!.id;
const image = (id: number, state = "image", kind = "image") => db.query("INSERT INTO link_images (link_id, state, mime, body, width, height, fetched_at, kind) VALUES (?, ?, ?, ?, 320, 200, 5, ?)")
  .run(id, state, state === "image" ? "image/webp" : null, state === "image" ? WEBP : null, kind);
const post = (id: number, text: string) => db.query("INSERT INTO link_posts (link_id, state, text, name, handle, linked_url, linked_title, fetched_at) VALUES (?, 'post', ?, 'Sam', 'sam', 'https://example.com/essay', 'An essay', 5)").run(id, text);
const copy = (id: number, text: string) => db.query("INSERT INTO link_copies (link_id, state, title, byline, text, saved_at) VALUES (?, 'text', 'Saved title', 'A. Writer', ?, 5)").run(id, text);
const wipe = () => db.exec("DELETE FROM links; DELETE FROM links_fts; DELETE FROM link_images; DELETE FROM link_posts; DELETE FROM link_copies; DELETE FROM link_favicons; DELETE FROM channel_members; DELETE FROM channels");

beforeEach(wipe);

function source(): unknown[] {
  const article = link("https://example.com/article");
  const miss = link("https://walled.example/a");
  const xpost = link("https://x.com/sam/status/1234567");
  const secret = link("https://secret.example/plan", "#vault");
  const secretPost = link("https://x.com/sam/status/7654321", "#vault");
  image(article); image(miss, "blocked"); image(xpost, "image", "avatar"); image(secret); image(secretPost);
  post(xpost, "Public words"); post(secretPost, "Private words");
  copy(article, "The article body, saved."); copy(secret, "Private page text.");
  db.query("INSERT INTO link_copies (link_id, state, saved_at, gone_at) VALUES (?, 'gone', 5, 5)").run(miss);
  storeFavicon("example.com", "image/png", new Uint8Array(40), 5);
  storeFavicon("walled.example", null, null, 5);
  storeFavicon("secret.example", "image/png", new Uint8Array(40), 5);
  return [...exportContent()];
}

test("the export is keyed by address and host, keeps the misses, and leaves out private-channel links", () => {
  const records = source() as any[];
  expect(records.filter((record) => record.t === "image").map((record) => [record.key, record.state, record.kind, !!record.body])).toEqual([
    ["example.com/article", "image", "image", true], ["walled.example/a", "blocked", "image", false], ["x.com/sam/status/1234567", "image", "avatar", true],
  ]);
  expect(records.filter((record) => record.t === "post").map((record) => [record.key, record.text])).toEqual([["x.com/sam/status/1234567", "Public words"]]);
  expect(records.filter((record) => record.t === "icon").map((record) => [record.host, !!record.body])).toEqual([["example.com", true], ["walled.example", false]]);
  const file = JSON.stringify(records);
  // Nothing from the private channel, no row ids, no member.
  expect(records.filter((record) => record.t === "copy").map((record) => [record.key, record.state, record.text, !!record.goneAt])).toEqual([
    ["example.com/article", "text", "The article body, saved.", false], ["walled.example/a", "gone", "", true],
  ]);
  expect(file).not.toMatch(/secret|vault|Private words|Private page|7654321|Ada|acct-ada|link_id|"id"/);
});

test("the import fills in links that exist here, skips the rest, and a second run changes nothing", () => {
  const records = source();
  wipe();
  // The other instance has two of the links, under different ids, and one private link with the same address.
  link("https://unrelated.example/first");
  const article = link("https://www.example.com/article/?utm_source=x");
  const xpost = link("https://twitter.com/sam/status/1234567");
  const privateTwin = link("https://walled.example/a", "#vault");
  const first = importContent(records);
  expect(first).toEqual({ read: 8, images: 2, posts: 1, copies: 1, icons: 2, unknown: 2, kept: 0, bad: 0 });
  expect(images.storedImage(article)!.body.byteLength).toBe(12);
  expect(images.imageKind(xpost)).toBe("avatar");
  expect(images.storedPost(xpost)!.text).toBe("Public words");
  expect(images.storedCopy(article)).toEqual({ title: "Saved title", byline: "A. Writer", text: "The article body, saved.", savedAt: 5 });
  expect(searchLinks("ada", { q: "article body saved" }).rows.map((row) => row.id)).toEqual([article]);
  // A private link is never filled from a file, even when its address matches.
  expect(images.imageState(privateTwin)).toBeNull();
  expect(storedFavicon("walled.example")).toEqual({ mime: null, body: null, fetchedAt: 5 });
  // The post's words are searchable here too.
  expect(searchLinks("ada", { q: "public words" }).rows.map((row) => row.id)).toEqual([xpost]);
  const second = importContent(records);
  expect(second).toEqual({ read: 8, images: 0, posts: 0, copies: 0, icons: 0, unknown: 2, kept: 6, bad: 0 });
});

test("what is already stored here is never overwritten", () => {
  const records = source();
  wipe();
  const article = link("https://example.com/article");
  const xpost = link("https://x.com/sam/status/1234567");
  db.query("INSERT INTO link_images (link_id, state, mime, body, width, height, fetched_at, kind) VALUES (?, 'none', NULL, NULL, NULL, NULL, 99, 'image')").run(article);
  post(xpost, "Words fetched here");
  copy(article, "Text saved here");
  storeFavicon("example.com", "image/png", new Uint8Array(77), 99);
  const report = importContent(records);
  expect([report.images, report.posts, report.copies, report.icons, report.kept]).toEqual([1, 0, 0, 1, 4]);
  expect(images.storedCopy(article)!.text).toBe("Text saved here");
  expect(images.imageState(article)).toBe("none");
  expect(images.storedPost(xpost)!.text).toBe("Words fetched here");
  expect(storedFavicon("example.com")!.body!.byteLength).toBe(77);
});

test("a file is read as untrusted: wrong states, types and sizes are counted and skipped", () => {
  const id = link("https://example.com/article");
  const report = importContent([
    null, "text", { t: "nope" },
    { t: "image", key: "example.com/article", state: "image", mime: "image/svg+xml", body: "PHN2Zz4=", kind: "image" },
    { t: "image", key: "example.com/article", state: "image", mime: "image/webp", body: null },
    { t: "image", key: "example.com/article", state: "pwned" },
    { t: "post", key: "example.com/article", state: "weird" },
    { t: "icon", host: "../etc", mime: "image/png", body: "AAAA" },
    { t: "icon", host: "example.com", mime: "image/svg+xml", body: "PHN2Zz4=" },
    { t: "copy", key: "example.com/article", state: "text", text: "" },
    { t: "copy", key: "example.com/article", state: "stolen", text: "x" },
    { t: "post", key: "example.com/article", state: "post", text: "ok", name: "n", handle: "bad handle!", linkedUrl: "javascript:alert(1)", linkedTitle: "t" },
  ]);
  expect(report).toEqual({ read: 12, images: 0, posts: 1, copies: 0, icons: 0, unknown: 0, kept: 0, bad: 11 });
  expect(images.imageState(id)).toBeNull();
  expect(images.storedPost(id)).toEqual({ text: "ok", name: "n", handle: "", linkedUrl: "", linkedTitle: "t" });
});
