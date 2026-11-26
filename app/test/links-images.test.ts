// Preview images for links: what a fetch can end as, one attempt per link, SVG refused, and a
// backfill that carries on after a restart. A fake fetcher stands in for the network.
import "./fixture.ts";

process.env.SLIRC_HELPERS = "help,links";

import { beforeEach, expect, test } from "bun:test";

process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
const { recordShare, removeLink, searchLinks } = await import("../src/links.ts");
const images = await import("../src/links-images.ts");
const { fetchLinkImage, imageProgress, imageState, makeThumbnail, pendingImages, resetImageBackfill, runImageBackfill, storedImage, youtubeThumbnail, HOST_DELAY_MS } = images;

const PHOTO = new Uint8Array(await Bun.file("./public/og.jpg").arrayBuffer());
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><script>alert(1)</script></svg>');
const page = (image: string) => `<html><head><title>T</title>${image ? `<meta property="og:image" content="${image}">` : ""}</head><body></body></html>`;

type Reply = { status?: number; type?: string; body?: string | Uint8Array; throws?: string };
let replies: Record<string, Reply> = {};
let asked: string[] = [];
const fetcher = (async (url: URL) => {
  asked.push(url.href);
  const reply = replies[url.href] ?? { status: 404 };
  if (reply.throws) throw new Error(reply.throws);
  const status = reply.status ?? 200;
  const bytes = typeof reply.body === "string" ? new TextEncoder().encode(reply.body) : reply.body ?? new Uint8Array();
  return {
    ok: status >= 200 && status < 300, status, finalUrl: url,
    header: (name: string) => (name.toLowerCase() === "content-type" ? reply.type ?? "text/html" : null),
    text: async () => new TextDecoder().decode(bytes), bytes: async () => bytes, close() {},
  };
}) as any;

let at = Date.UTC(2026, 10, 1);
function link(url: string, fields: Record<string, unknown> = {}): number {
  at += 60_000;
  return recordShare({ url, title: "T", sharedAt: at, sharerName: "ada", sharerAccount: "acct-ada", enriched: true, ...fields })!.id;
}

beforeEach(() => {
  process.env.SLIRC_HELPERS = "help,links";
  delete process.env.LINKS_IMAGE_BACKFILL_PER_RUN;
  replies = {}; asked = [];
  resetImageBackfill();
  db.exec("DELETE FROM links; DELETE FROM links_fts; DELETE FROM link_images; DELETE FROM link_posts; DELETE FROM link_copies; DELETE FROM channel_members; DELETE FROM channels");
});

test("a page's og:image is fetched, shrunk and stored as WebP", async () => {
  const id = link("https://example.com/post");
  replies["https://example.com/post"] = { body: page("/cover.jpg") };
  replies["https://example.com/cover.jpg"] = { type: "image/jpeg", body: PHOTO };
  expect(await fetchLinkImage(id, { fetcher })).toBe("image");
  const stored = storedImage(id)!;
  expect(stored.mime).toBe("image/webp");
  expect(new TextDecoder().decode(stored.body.slice(0, 4))).toBe("RIFF");
  expect(stored.body.byteLength).toBeLessThan(PHOTO.byteLength);
  const size = db.query("SELECT width, height FROM link_images WHERE link_id = ?").get(id) as { width: number; height: number };
  expect(size.width).toBe(320);
  expect(searchLinks("ada").rows[0].hasImage).toBe(true);
});

test("each way a fetch can end is recorded: none, blocked, failed", async () => {
  const noImage = link("https://example.com/plain");
  const notHtml = link("https://example.com/file.pdf");
  const forbidden = link("https://walled.example/a");
  const imageForbidden = link("https://example.com/hot");
  const dead = link("https://gone.example/a");
  const guarded = link("https://internal.example/a");
  const broken = link("https://example.com/broken");
  const tiny = link("https://example.com/tiny");
  replies["https://example.com/plain"] = { body: page("") };
  replies["https://example.com/file.pdf"] = { type: "application/pdf", body: "%PDF" };
  replies["https://walled.example/a"] = { status: 403 };
  replies["https://example.com/hot"] = { body: page("https://cdn.example/x.jpg") };
  replies["https://cdn.example/x.jpg"] = { status: 403 };
  replies["https://gone.example/a"] = { throws: "ECONNRESET" };
  replies["https://internal.example/a"] = { throws: "blocked" };
  replies["https://example.com/broken"] = { body: page("/broken.jpg") };
  replies["https://example.com/broken.jpg"] = { type: "image/jpeg", body: new Uint8Array([255, 216, 255, 1, 2, 3]) };
  replies["https://example.com/tiny"] = { body: page("/pixel.png") };
  replies["https://example.com/pixel.png"] = { type: "image/png", body: new Uint8Array(await Bun.file("./public/icons/favicon-32.png").arrayBuffer()) };
  const states = [];
  for (const id of [noImage, notHtml, forbidden, imageForbidden, dead, guarded, broken, tiny]) states.push(await fetchLinkImage(id, { fetcher }));
  expect(states).toEqual(["none", "none", "blocked", "blocked", "failed", "blocked", "none", "none"]);
  expect(imageProgress()).toEqual({ total: 8, done: 8, image: 0, none: 4, blocked: 3, failed: 1 });
  expect(storedImage(broken)).toBeNull();
});

test("SVG is refused, by its type and by its bytes", async () => {
  const honest = link("https://example.com/svg");
  const disguised = link("https://example.com/disguised");
  replies["https://example.com/svg"] = { body: page("/a.svg") };
  replies["https://example.com/a.svg"] = { type: "image/svg+xml", body: SVG };
  replies["https://example.com/disguised"] = { body: page("/b.png") };
  replies["https://example.com/b.png"] = { type: "image/png", body: SVG };
  expect(await fetchLinkImage(honest, { fetcher })).toBe("none");
  expect(await fetchLinkImage(disguised, { fetcher })).toBe("none");
  expect(await makeThumbnail(SVG)).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM link_images WHERE body IS NOT NULL").get()).toEqual({ n: 0 });
});

test("one attempt per link, whatever came of it", async () => {
  const id = link("https://example.com/once");
  replies["https://example.com/once"] = { status: 500 };
  expect(await fetchLinkImage(id, { fetcher })).toBe("none");
  replies["https://example.com/once"] = { body: page("/cover.jpg") };
  replies["https://example.com/cover.jpg"] = { type: "image/jpeg", body: PHOTO };
  const before = asked.length;
  expect(await fetchLinkImage(id, { fetcher })).toBe("none");
  expect(asked.length).toBe(before);
  expect(imageState(id)).toBe("none");
});

test("shortcuts: a YouTube thumbnail comes from the video id, an X post is not fetched, a page already read is not read again", async () => {
  expect(youtubeThumbnail("https://youtu.be/dQw4w9WgXcQ?si=x")).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  expect(youtubeThumbnail("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  expect(youtubeThumbnail("https://www.youtube.com/shorts/abcDEF12345")).toBe("https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg");
  expect(youtubeThumbnail("https://www.youtube.com/@channel")).toBeNull();
  expect(youtubeThumbnail("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  const video = link("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  replies["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"] = { type: "image/jpeg", body: PHOTO };
  expect(await fetchLinkImage(video, { fetcher })).toBe("image");
  expect(asked).toEqual(["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"]);
  const read = link("https://example.com/read");
  expect(await fetchLinkImage(read, { fetcher, pageRead: true })).toBe("none");
  const given = link("https://example.com/given");
  replies["https://example.com/og.jpg"] = { type: "image/jpeg", body: PHOTO };
  expect(await fetchLinkImage(given, { fetcher, pageImage: "https://example.com/og.jpg" })).toBe("image");
  expect(asked.length).toBe(2);
});

const FEED = (id: string) => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`;
const feed = (extra: Record<string, unknown> = {}) => JSON.stringify({
  __typename: "Tweet", text: "Worth reading &amp; short https://t.co/abc https://t.co/media1", display_text_range: [0, 42],
  entities: { urls: [{ url: "https://t.co/abc", display_url: "example.com/essay", expanded_url: "https://example.com/essay?utm_source=x" }] },
  user: { name: "Sam Example", screen_name: "sam", profile_image_url_https: "https://pbs.twimg.com/profile_images/1/face_normal.jpg" }, ...extra,
});

test("an X post is read from the embed feed: its words, its author, the page it links to, and a picture", async () => {
  const withPhoto = link("https://x.com/sam/status/1234567890123");
  replies[FEED("1234567890123")] = { type: "application/json", body: feed({ mediaDetails: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/photo.jpg" }], card: { binding_values: { title: { string_value: "An essay on evals" } } } }) };
  replies["https://pbs.twimg.com/media/photo.jpg"] = { type: "image/jpeg", body: PHOTO };
  expect(await fetchLinkImage(withPhoto, { fetcher })).toBe("image");
  expect(images.storedPost(withPhoto)).toEqual({ text: "Worth reading & short example.com/essay", name: "Sam Example", handle: "sam", linkedUrl: "https://example.com/essay?utm_source=x", linkedTitle: "An essay on evals" });
  expect(images.imageKind(withPhoto)).toBe("image");
  // The x.com page itself is never asked.
  expect(asked.some((url) => url.startsWith("https://x.com/"))).toBe(false);
  // The post's own words are searchable.
  expect(searchLinks("ada", { q: "worth reading" }).rows.map((row) => row.id)).toEqual([withPhoto]);

  // No attached image: the author's picture, kept small.
  const textOnly = link("https://twitter.com/sam/status/2234567890123?s=20");
  replies[FEED("2234567890123")] = { type: "application/json", body: feed({ text: "Just words here", display_text_range: [0, 15], entities: { urls: [] } }) };
  replies["https://pbs.twimg.com/profile_images/1/face_200x200.jpg"] = { type: "image/jpeg", body: PHOTO };
  expect(await fetchLinkImage(textOnly, { fetcher })).toBe("image");
  expect(images.imageKind(textOnly)).toBe("avatar");
  expect(images.storedPost(textOnly)).toEqual({ text: "Just words here", name: "Sam Example", handle: "sam", linkedUrl: "", linkedTitle: "" });

  // A link to another post is not "the page it links to".
  const quoting = link("https://x.com/sam/status/3234567890123");
  replies[FEED("3234567890123")] = { type: "application/json", body: feed({ entities: { urls: [{ url: "https://t.co/abc", display_url: "x.com/other/status/9", expanded_url: "https://x.com/other/status/9" }] }, user: { name: "Sam", screen_name: "sam" } }) };
  expect(await fetchLinkImage(quoting, { fetcher })).toBe("none");
  expect(images.storedPost(quoting)!.linkedUrl).toBe("");
});

test("each outcome of the feed check is recorded once: post, gone, blocked, failed", async () => {
  const cases: [string, Reply, string, string][] = [
    ["4000000000001", { status: 404, body: "<html>" }, "gone", "none"],
    ["4000000000002", { type: "application/json", body: "{}" }, "gone", "none"],
    ["4000000000003", { type: "application/json", body: JSON.stringify({ __typename: "TweetTombstone" }) }, "gone", "none"],
    ["4000000000004", { status: 429 }, "blocked", "blocked"],
    ["4000000000005", { status: 403 }, "blocked", "blocked"],
    ["4000000000006", { status: 503 }, "failed", "failed"],
    ["4000000000007", { throws: "ETIMEDOUT" }, "failed", "failed"],
    ["4000000000008", { throws: "blocked" }, "blocked", "blocked"],
    ["4000000000009", { type: "application/json", body: "not json" }, "failed", "failed"],
    ["4000000000010", { type: "application/json", body: feed({ user: { name: "S", screen_name: "sam" } }) }, "post", "none"],
  ];
  for (const [pid, reply, post, image] of cases) {
    const id = link(`https://x.com/sam/status/${pid}`);
    replies[FEED(pid)] = reply;
    expect([pid, await fetchLinkImage(id, { fetcher }), images.postState(id)]).toEqual([pid, image, post]);
    expect(images.storedPost(id) === null).toBe(post !== "post");
    const before = asked.length;
    // One attempt per post.
    await fetchLinkImage(id, { fetcher });
    expect(asked.length).toBe(before);
  }
  // An X address that is not a post is not asked at all.
  const profile = link("https://x.com/sam");
  const before = asked.length;
  expect(await fetchLinkImage(profile, { fetcher })).toBe("none");
  expect([asked.length, images.postState(profile)]).toEqual([before, "gone"]);
  expect(images.postId("https://x.com/sam/status/123456?s=1")).toBe("123456");
  expect(images.postId("https://example.com/sam/status/123456")).toBeNull();
});

test("the backfill takes the newest first, a few per run, one per host, and carries on after a restart", async () => {
  const ids = ["https://a.example/1", "https://a.example/2", "https://b.example/1", "https://c.example/1", "https://x.com/s/status/1234567", "https://d.example/1"].map((url) => link(url));
  for (const host of ["a", "b", "c", "d"]) for (const path of ["1", "2"]) replies[`https://${host}.example/${path}`] = { body: page("") };
  const now = Date.now();
  // Newest first, one per host; the second a.example link waits.
  expect(pendingImages(4, now).map((item) => item.id)).toEqual([ids[5], ids[4], ids[3], ids[2]]);
  expect(await runImageBackfill({ fetcher, limit: 4, now })).toBe(4);
  expect(imageProgress().done).toBe(4);
  // "Restart": the in-memory state is gone; what is left is the rows with no outcome.
  resetImageBackfill();
  expect(pendingImages(3, now).map((item) => item.id)).toEqual([ids[1], ids[0]].slice(0, 1));
  expect(await runImageBackfill({ fetcher, limit: 3, now })).toBe(1);
  // The same host is not asked again until its pause has passed.
  expect(pendingImages(3, now + 1_000)).toEqual([]);
  expect(await runImageBackfill({ fetcher, limit: 3, now: now + HOST_DELAY_MS + 1 })).toBe(1);
  expect(imageProgress()).toEqual({ total: 6, done: 6, image: 0, none: 6, blocked: 0, failed: 0 });
  expect(await runImageBackfill({ fetcher, limit: 3, now: now + 60_000 })).toBe(0);
  // Each address was asked exactly once.
  expect(asked.length).toBe(new Set(asked).size);
  process.env.SLIRC_HELPERS = "help";
  link("https://e.example/1");
  expect(await runImageBackfill({ fetcher, limit: 3, now: now + 90_000 })).toBe(0);
});

const article = (body: string, head = "") => `<html><head><title>The Title</title><meta name="author" content="A. Writer">${head}<script>var leak = "head script";</script></head><body><nav>Home | About | menu words</nav><article><h1>The Title</h1><p>${body}</p><ul><li>First point</li><li>Second point</li></ul><script>alert("in article")</script></article><footer>Footer words and legal text</footer></body></html>`;
const LONG = "Readable sentence about tokio runtimes and schedulers. ".repeat(8);

test("a page's readable text is saved with its image in one read, as plain text", async () => {
  const id = link("https://example.com/essay");
  replies["https://example.com/essay"] = { body: article(`${LONG} It shows &lt;script&gt;alert(1)&lt;/script&gt; and <b>bold</b> words.`, '<meta property="og:image" content="/cover.jpg">') };
  replies["https://example.com/cover.jpg"] = { type: "image/jpeg", body: PHOTO };
  expect(await fetchLinkImage(id, { fetcher })).toBe("image");
  // One read of the page gave both.
  expect(asked.filter((url) => url === "https://example.com/essay").length).toBe(1);
  const copy = images.storedCopy(id)!;
  expect([copy.title, copy.byline]).toEqual(["The Title", "A. Writer"]);
  expect(copy.text.startsWith("# The Title\n\nReadable sentence")).toBe(true);
  expect(copy.text).toContain("- First point\n\n- Second point");
  // Markup the page showed as text stays text; the page's real scripts, navigation and footer are gone.
  expect(copy.text).toContain("<script>alert(1)</script> and bold words.");
  expect(copy.text).not.toMatch(/in article|head script|menu words|Footer words/);
  expect(images.hasCopy(id)).toBe(true);
  expect(images.originalGone(id)).toBe(false);
});

test("the saved text is capped, and a page with too little text is recorded as having none", async () => {
  const { COPY_MAX_CHARS } = await import("../src/links-fetch.ts");
  const big = link("https://example.com/big");
  const thin = link("https://example.com/thin");
  const pdf = link("https://example.com/paper.pdf");
  const video = link("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  replies["https://example.com/big"] = { body: article("word ".repeat(40_000)) };
  replies["https://example.com/thin"] = { body: "<html><body><div id=app></div><script>render()</script></body></html>" };
  replies["https://example.com/paper.pdf"] = { type: "application/pdf", body: "%PDF" };
  for (const id of [big, thin, pdf, video]) await fetchLinkImage(id, { fetcher });
  expect(images.storedCopy(big)!.text.length).toBe(COPY_MAX_CHARS + 1);
  expect([images.copyState(thin), images.copyState(pdf), images.copyState(video)]).toEqual(["none", "none", "none"]);
  expect(images.storedCopy(thin)).toBeNull();
});

test("stored content is permanent: an original that now answers 404 keeps its text and image", async () => {
  // Image fetched before text was kept; the page has since gone.
  const early = link("https://example.com/early");
  db.query("INSERT INTO link_images (link_id, state, mime, body, width, height, fetched_at, kind) VALUES (?, 'image', 'image/webp', ?, 320, 200, 1, 'image')").run(early, new Uint8Array([82, 73, 70, 70]));
  replies["https://example.com/early"] = { status: 404 };
  expect(await images.fetchLinkCopy(early, { fetcher })).toBe("gone");
  expect(storedImage(early)!.body.byteLength).toBe(4);
  expect(images.originalGone(early)).toBe(true);
  expect(searchLinks("ada").rows.find((row) => row.id === early)!.hasImage).toBe(true);

  // Text and image stored; a later look finds the page gone. Nothing is replaced or removed.
  const kept = link("https://example.com/kept");
  replies["https://example.com/kept"] = { body: article(LONG, '<meta property="og:image" content="/cover.jpg">') };
  replies["https://example.com/cover.jpg"] = { type: "image/jpeg", body: PHOTO };
  await fetchLinkImage(kept, { fetcher });
  const before = images.storedCopy(kept)!;
  replies["https://example.com/kept"] = { status: 404 };
  images.markGone(kept);
  expect(await images.fetchLinkCopy(kept, { fetcher })).toBe("text");
  expect(await fetchLinkImage(kept, { fetcher })).toBe("image");
  expect(images.storedCopy(kept)).toEqual(before);
  expect(storedImage(kept)).not.toBeNull();
  expect([images.hasCopy(kept), images.originalGone(kept)]).toEqual([true, true]);
  expect(searchLinks("ada", { q: "tokio schedulers" }).rows.map((row) => row.id)).toEqual([kept]);

  // The same for a post: stored words stay when the feed later says it is gone.
  const xpost = link("https://x.com/sam/status/5550001");
  replies[FEED("5550001")] = { type: "application/json", body: feed({ user: { name: "Sam", screen_name: "sam" } }) };
  await fetchLinkImage(xpost, { fetcher });
  replies[FEED("5550001")] = { status: 404 };
  await fetchLinkImage(xpost, { fetcher });
  expect(images.storedPost(xpost)!.text).toBe("Worth reading & short example.com/essay");
  // A page gone before anything was saved has no copy to offer.
  const never = link("https://example.com/never");
  replies["https://example.com/never"] = { status: 410 };
  expect(await fetchLinkImage(never, { fetcher })).toBe("none");
  expect([images.hasCopy(never), images.originalGone(never)]).toEqual([false, true]);
});

// A post page the way LinkedIn serves it to a visitor: the post, then each comment in a
// `section.comment` inside the same article. Hacker News and WordPress threads come along.
const withComments = (post: string) => `<html><head><title>A post</title></head><body><article><div class="has-comments">${post}</div><p>18 Comments</p>
  <section class="comment flex grow-1 comment-with-action"><p>Julius Volz</p><p>Amazing, I was just thinking about a zebrafinch rewrite.</p></section>
  <section class="comment"><p>Second commenter quokka words.</p></section>
  <table class="comment-tree"><tr><td><div class="comment">Hacker News pangolin reply</div></td></tr></table>
  <div id="comments" class="comments-area"><ol class="comment-list"><li>WordPress narwhal reply</li></ol></div></article></body></html>`;

test("what people wrote under a page is never saved with it", async () => {
  const id = link("https://www.linkedin.com/posts/someone_rust-activity-1");
  replies["https://www.linkedin.com/posts/someone_rust-activity-1"] = { body: withComments(LONG) };
  await fetchLinkImage(id, { fetcher });
  const text = images.storedCopy(id)!.text;
  // The post itself is kept, even inside a wrapper whose class only mentions comments.
  expect(text).toContain("Readable sentence about tokio runtimes");
  expect(text).not.toMatch(/Julius|zebrafinch|quokka|pangolin|narwhal/);
  expect(searchLinks("ada", { q: "zebrafinch" }).rows).toEqual([]);
});

test("the cleanup re-reads a copy saved with comments and keeps every other copy as it is", async () => {
  const save = (url: string, text: string) => {
    const id = link(url);
    db.query("INSERT INTO link_copies (link_id, state, title, byline, text, saved_at) VALUES (?, 'text', 'T', '', ?, 1)").run(id, text);
    return id;
  };
  const old = `${LONG}\n\nJulius Volz\n\nAmazing, I was just thinking about a zebrafinch rewrite.`;
  const commented = save("https://example.com/commented", old);
  const plain = save("https://example.com/plain", "Text saved earlier that the page no longer has. ".repeat(6));
  const gone = save("https://example.com/gone", old);
  const { writeFts } = await import("../src/links.ts");
  for (const id of [commented, plain, gone]) writeFts(id);
  replies["https://example.com/commented"] = { body: withComments(LONG) };
  replies["https://example.com/plain"] = { body: article(`${LONG} A newer version of the page.`) };
  replies["https://example.com/gone"] = { status: 404 };

  // A dry run reports and writes nothing.
  expect(await images.rereadCopyWithoutComments(commented, { fetcher, write: false })).toBe("cleaned");
  expect(images.storedCopy(commented)!.text).toBe(old);

  expect(await images.rereadCopyWithoutComments(commented, { fetcher })).toBe("cleaned");
  expect(images.storedCopy(commented)!.text).toContain("Readable sentence about tokio runtimes");
  expect(images.storedCopy(commented)!.text).not.toMatch(/Julius|zebrafinch/);
  expect(searchLinks("ada", { q: "zebrafinch" }).rows.map((row) => row.id)).toEqual([gone]);
  expect(await images.rereadCopyWithoutComments(commented, { fetcher })).toBe("unchanged");
  // A page with no comment thread is not replaced by its newer version; one that is gone keeps its text.
  expect(await images.rereadCopyWithoutComments(plain, { fetcher })).toBe("unchanged");
  expect(images.storedCopy(plain)!.text).toStartWith("Text saved earlier");
  expect(await images.rereadCopyWithoutComments(gone, { fetcher })).toBe("unreadable");
  expect(images.storedCopy(gone)!.text).toBe(old);
});

test("a word in the title ranks above the same word in the saved text", async () => {
  const inBody = link("https://example.com/body", { title: "Notes from a meetup" });
  const inTitle = link("https://example.com/title", { title: "Zeppelin internals" });
  replies["https://example.com/body"] = { body: article(`${LONG} zeppelin zeppelin zeppelin zeppelin zeppelin zeppelin`).replace(/The Title/g, "Notes") };
  replies["https://example.com/title"] = { body: article(LONG).replace(/The Title/g, "Other") };
  await fetchLinkImage(inBody, { fetcher });
  await fetchLinkImage(inTitle, { fetcher });
  expect(searchLinks("ada", { q: "zeppelin" }).rows.map((row) => row.id)).toEqual([inTitle, inBody]);
});

test("links fetched before text was kept get one more read, behind the links not yet reached", async () => {
  const done = link("https://old.example/a");
  const post = link("https://x.com/sam/status/7770001");
  db.query("INSERT INTO link_images (link_id, state, fetched_at) VALUES (?, 'none', 1), (?, 'none', 1)").run(done, post);
  db.query("INSERT INTO link_posts (link_id, state, fetched_at) VALUES (?, 'gone', 1)").run(post);
  const fresh = link("https://new.example/a");
  replies["https://old.example/a"] = { body: article(LONG) };
  replies["https://new.example/a"] = { body: article(LONG) };
  const now = Date.now();
  expect(pendingImages(6, now).map((item) => [item.id, item.work])).toEqual([[fresh, "image"], [post, "copy"], [done, "copy"]]);
  expect(await runImageBackfill({ fetcher, limit: 6, now })).toBe(3);
  expect([images.copyState(fresh), images.copyState(done), images.copyState(post)]).toEqual(["text", "text", "none"]);
  // Once each; nothing is left to do.
  expect(pendingImages(6, now + 60_000)).toEqual([]);
  expect(asked.filter((url) => url.includes("old.example")).length).toBe(1);
  expect(images.copyProgress().text).toBe(2);
});

test("removing a link drops its image and its saved text", async () => {
  const id = link("https://example.com/post");
  replies["https://example.com/post"] = { body: article(LONG, '<meta property="og:image" content="/cover.jpg">') };
  replies["https://example.com/cover.jpg"] = { type: "image/jpeg", body: PHOTO };
  await fetchLinkImage(id, { fetcher });
  replies["https://example.com/post"] = { body: article(LONG, '<meta property="og:image" content="/cover.jpg">') };
  expect(images.storedCopy(id)).not.toBeNull();
  // Removing the link is the one thing that deletes what is stored for it.
  expect(removeLink({ id: "acct-ada", nick: "ada", role: "member" }, id)).toBe("removed");
  expect(storedImage(id)).toBeNull();
  expect(images.storedCopy(id)).toBeNull();
});
