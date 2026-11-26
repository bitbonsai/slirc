import { db } from "./db.ts";
import { linkById, linkHost, linksEnabled, safeUrl, setSavedTextSource, writeFts } from "./links.ts";
import { COPY_MIN_CHARS, extractReadable, PAGE_MAX_BYTES, squash, tidy, within } from "./links-fetch.ts";
import { describeHtml } from "./links-fetch.ts";
import { withDecodeTurn } from "./photo.ts";
import { fetchPublic } from "./safe-fetch.ts";

// A small preview image per link, shown at the left of its row. The page's own og:image (or
// twitter:image) is fetched through the guarded fetch that link previews use, resized by the
// image pipeline and kept in the database, so a browser never asks a third party for it.
// Each link gets one attempt and its outcome is recorded; there is no retry.
db.exec(`CREATE TABLE IF NOT EXISTS link_images (
  link_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  mime TEXT,
  body BLOB,
  width INTEGER,
  height INTEGER,
  fetched_at INTEGER NOT NULL
)`);

// An X post, read from X's public embed feed: the text as written, who wrote it, and the page
// the post links to when it has one. One attempt per post, with the outcome recorded.
db.exec(`CREATE TABLE IF NOT EXISTS link_posts (
  link_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  linked_url TEXT NOT NULL DEFAULT '',
  linked_title TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL
)`);
// `kind` says what the stored picture is: the link's own image, or its author's picture.
try { db.exec("ALTER TABLE link_images ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'"); } catch { /* Already there. */ }
// X posts were first recorded as having no image without being asked. They get their one real
// attempt now: an X link with no post row is put back in the queue.
db.exec(`DELETE FROM link_images WHERE state <> 'image' AND link_id NOT IN (SELECT link_id FROM link_posts)
         AND link_id IN (SELECT id FROM links WHERE url_key LIKE 'x.com/%')`);

// A saved copy of an article's readable text, so the link survives its page going away. One
// attempt per link. `gone_at` records that the original was found gone; it never removes what
// is stored.
db.exec(`CREATE TABLE IF NOT EXISTS link_copies (
  link_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  byline TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  saved_at INTEGER NOT NULL,
  gone_at INTEGER
)`);
export type CopyState = "text" | "none" | "blocked" | "failed" | "gone";
export type Copy = { title: string; byline: string; text: string; savedAt: number };

export type ImageState = "image" | "none" | "blocked" | "failed";
export type PostState = "post" | "gone" | "blocked" | "failed";
export type Post = { text: string; name: string; handle: string; linkedUrl: string; linkedTitle: string };
export const THUMB_WIDTH = 320;
export const THUMB_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const SOURCE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowPrivate = () => process.env.EMBED_ALLOW_PRIVATE === "true";

export function imageState(id: number): ImageState | null {
  return (db.query("SELECT state FROM link_images WHERE link_id = ?").get(id) as { state: ImageState } | null)?.state ?? null;
}
export function storedImage(id: number): { mime: string; body: Uint8Array } | null {
  const raw = db.query("SELECT mime, body FROM link_images WHERE link_id = ? AND state = 'image'").get(id) as { mime: string; body: Uint8Array } | null;
  return raw?.body ? raw : null;
}
// The stored preview's own pixel size, recorded when it was made, so a reader reserves its box.
export function storedImageDims(id: number): { width: number; height: number } | null {
  const raw = db.query("SELECT width, height FROM link_images WHERE link_id = ? AND state = 'image'").get(id) as { width: number | null; height: number | null } | null;
  return raw?.width && raw.height ? { width: raw.width, height: raw.height } : null;
}
function record(id: number, state: ImageState, image?: { body: Uint8Array; width: number; height: number }, kind: "image" | "avatar" = "image"): void {
  db.query("INSERT INTO link_images (link_id, state, mime, body, width, height, fetched_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(link_id) DO NOTHING")
    .run(id, state, image ? "image/webp" : null, image?.body ?? null, image?.width ?? null, image?.height ?? null, Date.now(), kind);
}
export function imageKind(id: number): "image" | "avatar" | null {
  return (db.query("SELECT kind FROM link_images WHERE link_id = ? AND state = 'image'").get(id) as { kind: "image" | "avatar" } | null)?.kind ?? null;
}
export function postState(id: number): PostState | null {
  return (db.query("SELECT state FROM link_posts WHERE link_id = ?").get(id) as { state: PostState } | null)?.state ?? null;
}
export function storedPost(id: number): Post | null {
  const raw = db.query("SELECT text, name, handle, linked_url, linked_title FROM link_posts WHERE link_id = ? AND state = 'post'").get(id) as { text: string; name: string; handle: string; linked_url: string; linked_title: string } | null;
  return raw ? { text: raw.text, name: raw.name, handle: raw.handle, linkedUrl: raw.linked_url, linkedTitle: raw.linked_title } : null;
}
function recordPost(id: number, state: PostState, post?: Post): void {
  db.query("INSERT INTO link_posts (link_id, state, text, name, handle, linked_url, linked_title, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(link_id) DO NOTHING")
    .run(id, state, post?.text ?? "", post?.name ?? "", post?.handle ?? "", post?.linkedUrl ?? "", post?.linkedTitle ?? "", Date.now());
  // The post's own words are searchable with the row.
  if (post) writeFts(id);
}
// What is searchable beyond the row itself: an X post's own words, or the saved text of a page.
setSavedTextSource((id) => {
  const post = (db.query("SELECT text FROM link_posts WHERE link_id = ? AND state = 'post'").get(id) as { text: string } | null)?.text ?? "";
  const copy = (db.query("SELECT text FROM link_copies WHERE link_id = ? AND state = 'text'").get(id) as { text: string } | null)?.text ?? "";
  return post && copy ? `${post}\n${copy}` : post || copy;
});

export function copyState(id: number): CopyState | null {
  return (db.query("SELECT state FROM link_copies WHERE link_id = ?").get(id) as { state: CopyState } | null)?.state ?? null;
}
export function storedCopy(id: number): Copy | null {
  const raw = db.query("SELECT title, byline, text, saved_at FROM link_copies WHERE link_id = ? AND state = 'text'").get(id) as { title: string; byline: string; text: string; saved_at: number } | null;
  return raw ? { title: raw.title, byline: raw.byline, text: raw.text, savedAt: raw.saved_at } : null;
}
// Stored content is permanent. A write happens only when nothing is recorded yet, so a later
// fetch that fails, is refused or finds the page gone can never replace what is kept.
function recordCopy(id: number, state: CopyState, copy?: { title: string; byline: string; text: string }): void {
  const added = db.query("INSERT INTO link_copies (link_id, state, title, byline, text, saved_at, gone_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(link_id) DO NOTHING")
    .run(id, state, copy?.title ?? "", copy?.byline ?? "", copy?.text ?? "", Date.now(), state === "gone" ? Date.now() : null).changes;
  if (added && copy) writeFts(id);
}
// The original was found gone. This only sets a mark: the text, image and post stay.
export function markGone(id: number, now = Date.now()): void {
  db.query("INSERT INTO link_copies (link_id, state, saved_at, gone_at) VALUES (?, 'gone', ?, ?) ON CONFLICT(link_id) DO UPDATE SET gone_at = COALESCE(link_copies.gone_at, excluded.gone_at)").run(id, now, now);
}
export function originalGone(id: number): boolean {
  return !!db.query("SELECT 1 FROM link_copies WHERE link_id = ? AND gone_at IS NOT NULL").get(id) || postState(id) === "gone";
}
// A link has a saved copy when its page text or its post's words are stored.
export function hasCopy(id: number): boolean {
  return copyState(id) === "text" || postState(id) === "post";
}

// Save a page's readable text from HTML already in hand. Too little text is "none": a page
// that is only script, a login wall, a video.
export async function saveCopyFromHtml(id: number, html: string, title: string): Promise<CopyState> {
  const existing = copyState(id);
  if (existing) return existing;
  let read: { byline: string; text: string };
  try { read = await extractReadable(html); } catch { recordCopy(id, "failed"); return "failed"; }
  if (read.text.length < COPY_MIN_CHARS) { recordCopy(id, "none"); return "none"; }
  recordCopy(id, "text", { title: squash(title, 300), byline: read.byline, text: read.text });
  return "text";
}

// One attempt at a page's text for a link whose image was fetched before text was kept.
export async function fetchLinkCopy(id: number, options: { fetcher?: Fetcher } = {}): Promise<CopyState> {
  const existing = copyState(id);
  if (existing) return existing;
  const link = linkById(id);
  const url = link && !link.removedAt ? safeUrl(link.url) : null;
  if (!link || !url) return "none";
  // A video has no text to keep, and an X post's words are kept as the post.
  if (linkHost(url) === "x.com" || youtubeThumbnail(link.url)) { recordCopy(id, "none"); return "none"; }
  const fetcher = options.fetcher ?? fetchPublic;
  try {
    const page = await fetcher(url, { accept: "text/html,application/xhtml+xml", allowPrivate: allowPrivate(), timeoutMs: 8_000 });
    try {
      if (page.status === 404 || page.status === 410) { markGone(id); return "gone"; }
      if (!page.ok) { const state: CopyState = refused(page.status) ? "blocked" : "failed"; recordCopy(id, state); return state; }
      const type = (page.header("content-type") || "").split(";")[0].trim().toLowerCase();
      if (type !== "text/html" && type !== "application/xhtml+xml") { recordCopy(id, "none"); return "none"; }
      const html = await within(page, page.text(PAGE_MAX_BYTES));
      return await saveCopyFromHtml(id, html, describeHtml(html, page.finalUrl).title || link.title);
    } finally {
      page.close();
    }
  } catch (error) {
    const state: CopyState = error instanceof Error && error.message === "blocked" ? "blocked" : "failed";
    recordCopy(id, state);
    return state;
  }
}
// Copies saved before comment threads were left out can hold what people wrote under a page.
// This reads the page again and replaces the stored text only when the page still answers with
// text and that text has comments the extractor now leaves out; a page with no comment thread,
// or one that no longer answers, keeps what is stored. `write: false` only reports.
export type Reread = "cleaned" | "unchanged" | "unreadable";
export async function rereadCopyWithoutComments(id: number, options: { fetcher?: Fetcher; write?: boolean } = {}): Promise<Reread> {
  const stored = storedCopy(id);
  const link = linkById(id);
  const url = stored && link && !link.removedAt ? safeUrl(link.url) : null;
  if (!stored || !url) return "unreadable";
  let html: string;
  try {
    const page = await (options.fetcher ?? fetchPublic)(url, { accept: "text/html,application/xhtml+xml", allowPrivate: allowPrivate(), timeoutMs: 8_000 });
    try {
      const type = (page.header("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!page.ok || (type !== "text/html" && type !== "application/xhtml+xml")) return "unreadable";
      html = await within(page, page.text(PAGE_MAX_BYTES));
    } finally {
      page.close();
    }
  } catch { return "unreadable"; }
  const [read, withComments] = [await extractReadable(html), await extractReadable(html, { withComments: true })];
  if (read.text.length < COPY_MIN_CHARS) return "unreadable";
  if (read.text === withComments.text || read.text === stored.text) return "unchanged";
  if (options.write !== false) {
    db.query("UPDATE link_copies SET text = ?, byline = ? WHERE link_id = ? AND state = 'text'").run(read.text, read.byline, id);
    writeFts(id);
  }
  return "cleaned";
}

export function forgetImage(id: number): void {
  db.query("DELETE FROM link_images WHERE link_id = ?").run(id);
  db.query("DELETE FROM link_posts WHERE link_id = ?").run(id);
  db.query("DELETE FROM link_copies WHERE link_id = ?").run(id);
}

// The numeric id in an X post's address.
export function postId(raw: string): string | null {
  const url = safeUrl(raw);
  if (!url || linkHost(url) !== "x.com") return null;
  return url.pathname.match(/^\/[^/]+\/status(?:es)?\/(\d{5,25})/)?.[1] ?? null;
}

// X's embed feed: the JSON that embedded posts are built from. It answers a server without a
// login. It wants a `token` parameter to be present and accepts any value, so a fixed
// placeholder is sent; nothing is derived or scraped.
export const postFeedUrl = (id: string) => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`;

const X_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co)$/;
// What the feed says about one post, reduced to what a row shows. Null when it is not a post
// (deleted, withheld, or an empty answer).
export function readPost(body: unknown): { post: Post; image: string; avatar: string } | null {
  const data = body as any;
  if (!data || typeof data !== "object" || data.__typename !== "Tweet" || typeof data.text !== "string") return null;
  const urls: any[] = Array.isArray(data.entities?.urls) ? data.entities.urls : [];
  const range = Array.isArray(data.display_text_range) ? data.display_text_range : [0, undefined];
  let text = [...data.text].slice(Number(range[0]) || 0, typeof range[1] === "number" ? range[1] : undefined).join("");
  // Shortened addresses read as the address they stand for; the ones that only stand for an
  // attached picture or video go.
  for (const item of urls) if (typeof item?.url === "string" && typeof item.display_url === "string") text = text.split(item.url).join(item.display_url);
  text = tidy(text.replace(/https?:\/\/t\.co\/\w+/g, " ").replace(/\n{2,}/g, "\n"), 1_200);
  let linkedUrl = "";
  for (const item of urls) {
    const target = typeof item?.expanded_url === "string" ? safeUrl(item.expanded_url) : null;
    if (target && !X_HOSTS.test(target.hostname.toLowerCase())) { linkedUrl = target.href; break; }
  }
  const title = data.card?.binding_values?.title?.string_value;
  const media = Array.isArray(data.mediaDetails) ? data.mediaDetails.find((item: any) => typeof item?.media_url_https === "string") : null;
  const avatar = typeof data.user?.profile_image_url_https === "string" ? data.user.profile_image_url_https.replace(/_normal(\.\w+)$/, "_200x200$1") : "";
  return {
    post: {
      text, name: tidy(String(data.user?.name || ""), 80), handle: /^[A-Za-z0-9_]{1,15}$/.test(String(data.user?.screen_name || "")) ? String(data.user.screen_name) : "",
      linkedUrl, linkedTitle: linkedUrl && typeof title === "string" ? tidy(title, 200) : "",
    },
    image: media?.media_url_https || (typeof data.video?.poster === "string" ? data.video.poster : ""),
    avatar,
  };
}

// A YouTube link's thumbnail follows from its video id, with no page to read.
export function youtubeThumbnail(raw: string): string | null {
  const url = safeUrl(raw);
  if (!url) return null;
  const host = linkHost(url);
  const id = host === "youtu.be" ? url.pathname.split("/")[1]
    : host === "youtube.com" ? url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] : null;
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

// Decode, shrink and re-encode. Anything that is not a still JPEG, PNG or WebP is refused,
// which leaves out SVG and whatever the pipeline cannot read.
// A thumbnail is 320 pixels wide, so a source far larger than a screen is refused before its
// pixels are allocated. Decodes take turns in the same pool as uploads, so several large
// images arriving at once cannot run the process out of memory.
export const THUMB_MAX_PIXELS = 12_000_000;
export async function makeThumbnail(bytes: Uint8Array, small = false): Promise<{ body: Uint8Array; width: number; height: number } | null> {
  try {
    return await withDecodeTurn(async () => {
      const source = new Bun.Image(bytes, { maxPixels: THUMB_MAX_PIXELS, autoOrient: true });
      const meta = await source.metadata();
      const format = String(meta.format || "").toLowerCase();
      if (!["jpeg", "jpg", "png", "webp"].includes(format) || !meta.width || !meta.height) return null;
      if (meta.width * meta.height > THUMB_MAX_PIXELS) return null;
      // Icons and tracking pixels are not previews.
      if (!small && (meta.width < 120 || meta.height < 60)) return null;
      if (small && (meta.width < 40 || meta.height < 40)) return null;
      const resized = source.resize(THUMB_WIDTH, THUMB_WIDTH, { fit: "inside", withoutEnlargement: true });
      const body = new Uint8Array(await resized.webp({ quality: 72 }).toBuffer());
      return { body, width: resized.width, height: resized.height };
    });
  } catch {
    return null;
  }
}

type Fetcher = typeof fetchPublic;
const refused = (status: number) => status === 401 || status === 403 || status === 429 || status === 451;

async function downloadImage(address: string, fetcher: Fetcher, small = false): Promise<{ state: ImageState; image?: { body: Uint8Array; width: number; height: number } }> {
  const target = safeUrl(address);
  if (!target) return { state: "none" };
  const response = await fetcher(target, { accept: "image/*", allowPrivate: allowPrivate(), timeoutMs: 8_000, maxHops: 4 });
  try {
    if (!response.ok) return { state: refused(response.status) ? "blocked" : "none" };
    const type = (response.header("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!SOURCE_TYPES.has(type)) return { state: "none" };
    const image = await makeThumbnail(await within(response, response.bytes(THUMB_MAX_SOURCE_BYTES)), small);
    return image ? { state: "image", image } : { state: "none" };
  } finally {
    response.close();
  }
}

// One attempt for one link. `pageImage` is the og:image address when the page was already read
// for its title, so it is not read twice.
export async function fetchLinkImage(id: number, options: { pageImage?: string; pageRead?: boolean; fetcher?: Fetcher } = {}): Promise<ImageState> {
  const existing = imageState(id);
  if (existing) return existing;
  const link = linkById(id);
  const url = link && !link.removedAt ? safeUrl(link.url) : null;
  if (!link || !url) return "none";
  const fetcher = options.fetcher ?? fetchPublic;
  // An X post's page gives a server nothing; its embed feed does.
  if (linkHost(url) === "x.com") { recordCopy(id, "none"); return fetchPost(id, link.url, fetcher); }
  let outcome: Awaited<ReturnType<typeof downloadImage>>;
  try {
    let address = options.pageImage || youtubeThumbnail(link.url) || "";
    if (youtubeThumbnail(link.url)) recordCopy(id, "none");
    if (!address && options.pageRead) outcome = { state: "none" };
    else {
      if (!address) {
        const page = await fetcher(url, { accept: "text/html,application/xhtml+xml", allowPrivate: allowPrivate(), timeoutMs: 8_000 });
        try {
          const type = (page.header("content-type") || "").split(";")[0].trim().toLowerCase();
          // The same read gives the page's text, so the page is not asked twice.
          if (page.status === 404 || page.status === 410) markGone(id);
          else if (!page.ok) { address = refused(page.status) ? "blocked:" : ""; recordCopy(id, refused(page.status) ? "blocked" : "failed"); }
          else if (type === "text/html" || type === "application/xhtml+xml") {
            const html = await within(page, page.text(PAGE_MAX_BYTES));
            const described = describeHtml(html, page.finalUrl);
            address = described.image;
            await saveCopyFromHtml(id, html, described.title || link.title);
          } else recordCopy(id, "none");
        } finally {
          page.close();
        }
      }
      outcome = address === "blocked:" ? { state: "blocked" } : address ? await downloadImage(address, fetcher) : { state: "none" };
    }
  } catch (error) {
    // The guard refusing an address is "blocked"; anything else on the wire is "failed".
    outcome = { state: error instanceof Error && error.message === "blocked" ? "blocked" : "failed" };
    if (!options.pageImage && !options.pageRead) recordCopy(id, outcome.state === "blocked" ? "blocked" : "failed");
  }
  record(id, outcome.state, outcome.image);
  return outcome.state;
}

// One attempt for one X post: its text and author from the feed, then one picture for the row's
// slot. The attached image or video poster when there is one, otherwise the author's picture.
async function fetchPost(id: number, address: string, fetcher: Fetcher): Promise<ImageState> {
  const pid = postId(address);
  if (!pid) { recordPost(id, "gone"); record(id, "none"); return "none"; }
  let read: ReturnType<typeof readPost> = null;
  try {
    const response = await fetcher(new URL(postFeedUrl(pid)), { accept: "application/json", allowPrivate: allowPrivate(), timeoutMs: 8_000, maxHops: 2 });
    try {
      if (!response.ok) {
        const state: PostState = refused(response.status) ? "blocked" : response.status === 404 || response.status === 410 ? "gone" : "failed";
        recordPost(id, state);
        record(id, state === "gone" ? "none" : state);
        return state === "gone" ? "none" : state;
      }
      read = readPost(JSON.parse(await within(response, response.text(400_000))));
    } finally {
      response.close();
    }
  } catch (error) {
    const state: PostState = error instanceof Error && error.message === "blocked" ? "blocked" : "failed";
    recordPost(id, state);
    record(id, state);
    return state;
  }
  if (!read) { recordPost(id, "gone"); record(id, "none"); return "none"; }
  recordPost(id, "post", read.post);
  let picture: Awaited<ReturnType<typeof downloadImage>> = { state: "none" };
  let kind: "image" | "avatar" = "image";
  try {
    if (read.image) picture = await downloadImage(read.image, fetcher);
    if (picture.state !== "image" && read.avatar) { picture = await downloadImage(read.avatar, fetcher, true); kind = "avatar"; }
  } catch {
    picture = { state: "failed" };
  }
  record(id, picture.state, picture.image, kind);
  return picture.state;
}

// The backfill: links with no recorded attempt, newest first, a few at a time and never two from
// one host at once, with a pause before a host is asked again. What is left to do is simply
// the rows without an outcome, so a restart carries on where it stopped.
export const backfillPerRun = () => {
  const value = Number(process.env.LINKS_IMAGE_BACKFILL_PER_RUN);
  return Number.isInteger(value) && value >= 0 && process.env.LINKS_IMAGE_BACKFILL_PER_RUN?.trim() ? Math.min(value, 20) : 6;
};
// A tick tops the work in flight back up to the limit; a slow site holds one place, not the run.
export const BACKFILL_INTERVAL_MS = 5_000;
export const HOST_DELAY_MS = 10_000;
const lastAsked = new Map<string, number>();
const inFlight = new Map<number, string>();

export type Pending = { id: number; host: string; work: "image" | "copy" };
export function pendingImages(limit: number, now = Date.now()): Pending[] {
  // Links with nothing fetched yet come first. Behind them, links whose image was fetched
  // before page text was kept get one more read for their text.
  const fresh = db.query(`SELECT links.id, links.url FROM links LEFT JOIN link_images ON link_images.link_id = links.id
                          WHERE link_images.link_id IS NULL AND links.removed_at IS NULL ORDER BY links.first_shared_at DESC, links.id DESC LIMIT 400`).all() as { id: number; url: string }[];
  const texts = db.query(`SELECT links.id, links.url FROM links JOIN link_images ON link_images.link_id = links.id LEFT JOIN link_copies ON link_copies.link_id = links.id
                          WHERE link_copies.link_id IS NULL AND links.removed_at IS NULL ORDER BY links.first_shared_at DESC, links.id DESC LIMIT 400`).all() as { id: number; url: string }[];
  const picked: Pending[] = [];
  const hosts = new Set<string>([...inFlight.values()].filter(Boolean));
  for (const [rows, work] of [[fresh, "image"], [texts, "copy"]] as const) {
    for (const item of rows) {
      if (picked.length >= limit) break;
      if (inFlight.has(item.id)) continue;
      const url = safeUrl(item.url);
      const host = url ? linkHost(url) : "";
      // A copy that needs no fetch (a video, an X post) is settled without waiting for its host.
      const free = work === "copy" && (host === "x.com" || !!youtubeThumbnail(item.url));
      if (!free && (hosts.has(host) || now - (lastAsked.get(host) ?? 0) < HOST_DELAY_MS)) continue;
      if (!free) hosts.add(host);
      picked.push({ id: item.id, host: free ? "" : host, work });
    }
  }
  return picked;
}

export function copyProgress(): { total: number; done: number; text: number; none: number; blocked: number; failed: number; gone: number; chars: number } {
  const total = (db.query("SELECT COUNT(*) AS n FROM links WHERE removed_at IS NULL").get() as { n: number }).n;
  const counts = Object.fromEntries((db.query("SELECT state, COUNT(*) AS n FROM link_copies GROUP BY state").all() as { state: string; n: number }[]).map((item) => [item.state, item.n]));
  const of = (state: string) => counts[state] || 0;
  const chars = (db.query("SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM link_copies WHERE state = 'text'").get() as { n: number }).n;
  return { total, done: of("text") + of("none") + of("blocked") + of("failed") + of("gone"), text: of("text"), none: of("none"), blocked: of("blocked"), failed: of("failed"), gone: of("gone"), chars };
}

export function imageProgress(): { total: number; done: number; image: number; none: number; blocked: number; failed: number } {
  const total = (db.query("SELECT COUNT(*) AS n FROM links WHERE removed_at IS NULL").get() as { n: number }).n;
  const counts = Object.fromEntries((db.query("SELECT state, COUNT(*) AS n FROM link_images GROUP BY state").all() as { state: string; n: number }[]).map((item) => [item.state, item.n]));
  const of = (state: string) => counts[state] || 0;
  return { total, done: of("image") + of("none") + of("blocked") + of("failed"), image: of("image"), none: of("none"), blocked: of("blocked"), failed: of("failed") };
}

export async function runImageBackfill(options: { fetcher?: Fetcher; limit?: number; now?: number } = {}): Promise<number> {
  if (!linksEnabled()) return 0;
  const now = options.now ?? Date.now();
  const room = (options.limit ?? backfillPerRun()) - inFlight.size;
  if (room <= 0) return 0;
  const batch = pendingImages(room, now);
  await Promise.all(batch.map(async ({ id, host, work }) => {
    inFlight.set(id, host);
    if (host) lastAsked.set(host, now);
    try {
      if (work === "image") await fetchLinkImage(id, { fetcher: options.fetcher });
      else await fetchLinkCopy(id, { fetcher: options.fetcher });
    } finally { inFlight.delete(id); }
  }));
  return batch.length;
}

let timer: ReturnType<typeof setInterval> | undefined;
let lastLogged = -1;
export function startImageBackfill(): void {
  if (timer || !linksEnabled() || backfillPerRun() === 0) return;
  timer = setInterval(async () => {
    try {
      const worked = await runImageBackfill();
      const progress = imageProgress();
      // One line per hundred links, and one when it finishes. Counts only.
      const mark = Math.floor((progress.done + copyProgress().done) / 100);
      if (worked && (mark !== lastLogged || progress.done === progress.total)) {
        lastLogged = mark;
        const copies = copyProgress();
        console.log(`links images: ${progress.done} of ${progress.total} done, ${progress.image} with an image, ${progress.none} without, ${progress.blocked} blocked, ${progress.failed} failed; saved text: ${copies.done} done, ${copies.text} with text, ${copies.gone} gone`);
      }
    } catch (error) {
      console.error("links images:", error instanceof Error ? error.message : error);
    }
  }, BACKFILL_INTERVAL_MS);
  timer.unref?.();
}
export const resetImageBackfill = () => { lastAsked.clear(); inFlight.clear(); };
