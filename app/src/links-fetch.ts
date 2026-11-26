import { decodeEntities, parseOg } from "./og.ts";
import { fetchPublic } from "./safe-fetch.ts";

// Reading a page for the links library. It uses the guarded fetch that link previews use, so the
// address checks, redirect limit, size limit and timeout are the same ones.
export type PageDescription = { title: string; description: string; site: string; image: string; html?: string };

const allowPrivate = () => process.env.EMBED_ALLOW_PRIVATE === "true";
export const squash = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);
export const tidy = (text: string, max: number) => squash(decodeEntities(text), max);

// Title, description, site name and image address from a page's own markup. Null when the page
// is not HTML or cannot be read.
// Only the start of the page is read here: titles and meta tags live in the head. The patterns
// exclude `<`, so each is linear in the text and a hostile page cannot stall the one thread.
export const HEAD_MAX_CHARS = 200_000;
export function describeHtml(page: string, base: URL): PageDescription {
  const html = page.length > HEAD_MAX_CHARS ? page.slice(0, HEAD_MAX_CHARS) : page;
  const meta = parseOg(html);
  // parseOg values arrive decoded; only the raw-markup fallbacks still need decoding.
  const title = meta.title || decodeEntities(html.match(/<title[^<>]*>([^<]*)<\/title>/i)?.[1] || "");
  const description = meta.description || decodeEntities(html.match(/<meta\b[^<>]*name=["']description["'][^<>]*content=["']([^"'<>]*)["']/i)?.[1] || "");
  let image = "";
  if (meta.image) { try { image = new URL(meta.image, base).href; } catch { image = ""; } }
  return { title: squash(title, 300), description: squash(description, 400), site: squash(meta.site || "", 80), image };
}

export async function describePage(raw: string): Promise<PageDescription | null> {
  const page = await fetchPublic(new URL(raw), { accept: "text/html,application/xhtml+xml", allowPrivate: allowPrivate(), timeoutMs: 8_000 });
  try {
    const type = (page.header("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!page.ok || (type !== "text/html" && type !== "application/xhtml+xml")) return null;
    const html = await within(page, page.text(PAGE_MAX_BYTES));
    return { ...describeHtml(html, page.finalUrl), html };
  } finally {
    page.close();
  }
}

const ICON_TYPES = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/jpeg", "image/gif", "image/webp"]);
export const FAVICON_MAX_BYTES = 150_000;

// A site's icon from its conventional address, through the same guarded fetch. SVG is refused:
// it can carry script, and these bytes are served from this origin. Null when the site gives none.
export async function fetchFavicon(host: string): Promise<{ mime: string; body: Uint8Array } | null> {
  const page = await fetchPublic(new URL(`https://${host}/favicon.ico`), { accept: "image/*", allowPrivate: allowPrivate(), timeoutMs: 5_000, maxHops: 3 });
  try {
    const mime = (page.header("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!page.ok || !ICON_TYPES.has(mime)) return null;
    const body = await within(page, page.bytes(FAVICON_MAX_BYTES));
    return body.length > 16 ? { mime, body } : null;
  } finally {
    page.close();
  }
}

// How much of a page is read, and how much readable text is kept per link.
export const PAGE_MAX_BYTES = 1_500_000;
export const COPY_MAX_CHARS = 100_000;
export const COPY_MIN_CHARS = 200;

const SKIPPED = "script, style, noscript, template, svg, iframe, nav, header, footer, aside, form, button, select, dialog, [hidden], [aria-hidden='true']";
// What people wrote under a page is theirs, not the page's, and is never kept: LinkedIn
// (`section.comment`), Hacker News (`comment-tree`), Reddit, WordPress and Disqus threads.
// Classes match as whole words, so `no-comments` or `has-comments` on a wrapper keeps its text.
const COMMENTS = "[id='comments'], [id='disqus_thread'], [class~='comment'], [class~='comments'], [class~='comment-list'], [class~='commentlist'], [class~='comments-area'], [class~='comment-tree'], [class~='commentarea'], [itemprop='comment'], shreddit-comment-tree, shreddit-comment";
const BLOCKS = "p, div, section, li, blockquote, pre, h1, h2, h3, h4, h5, h6, br, tr, dt, dd, figcaption";
const PREFIX: Record<string, string> = { h1: "# ", h2: "## ", h3: "### ", h4: "### ", h5: "### ", h6: "### ", li: "- " };

// The readable text of a page, as plain text with `#` headings and `-` list items. Bun's own
// HTML parser walks the page once: text inside <article> is taken when there is enough of it,
// otherwise <main>, otherwise the body, and scripts, styles, navigation, headers, footers,
// sidebars, forms and comment threads are left out. No markup is kept, so nothing from the page can run later.
// `withComments` reads the threads too; only the cleanup of copies saved before they were left out uses it.
export async function extractReadable(html: string, options: { withComments?: boolean } = {}): Promise<{ byline: string; text: string }> {
  const parts = { article: [] as string[], main: [] as string[], body: [] as string[] };
  let skip = 0;
  let article = 0;
  let main = 0;
  let byline = "";
  const push = (piece: string) => {
    parts.body.push(piece);
    if (main) parts.main.push(piece);
    if (article) parts.article.push(piece);
  };
  // An element with no end tag cannot be waited for; it is then not counted at all.
  const scoped = (enter: () => void, leave: () => void) => ({ element(el: any) { try { el.onEndTag(leave); enter(); } catch { /* No end tag. */ } } });
  await new HTMLRewriter()
    .on("meta", { element(el) {
      const name = (el.getAttribute("name") || el.getAttribute("property") || "").toLowerCase();
      if (!byline && (name === "author" || name === "article:author" || name === "twitter:creator")) byline = el.getAttribute("content") || "";
    } })
    .on("head", scoped(() => { skip++; }, () => { skip--; }))
    .on(options.withComments ? SKIPPED : `${SKIPPED}, ${COMMENTS}`, scoped(() => { skip++; }, () => { skip--; }))
    .on("article", scoped(() => { article++; }, () => { article--; }))
    .on("main, [role='main']", scoped(() => { main++; }, () => { main--; }))
    .on(BLOCKS, { element(el) { if (!skip) push(`\n\n${PREFIX[el.tagName.toLowerCase()] || ""}`); } })
    .on("*", { text(chunk) { if (!skip && chunk.text) push(chunk.text); } })
    .transform(new Response(html)).text();
  const clean = (pieces: string[]) => decodeEntities(pieces.join(""))
    .replace(/[ \t\f\v\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n(#{1,3}|-) ?\n+/g, "\n$1 ").replace(/\n{3,}/g, "\n\n")
    .split("\n\n").map((block) => block.trim()).filter((block) => block && !/^(#{1,3}|-)$/.test(block)).join("\n\n");
  const [fromArticle, fromMain, fromBody] = [clean(parts.article), clean(parts.main), clean(parts.body)];
  const text = fromArticle.length >= 500 ? fromArticle : fromMain.length >= 500 ? fromMain : fromBody;
  return { byline: byline.startsWith("http") ? "" : tidy(byline, 120), text: text.length > COPY_MAX_CHARS ? `${text.slice(0, COPY_MAX_CHARS).trimEnd()}…` : text };
}

// A read that must finish in time. The request's own timeout should end a body that drips in
// slowly; this makes sure of it, so a slow page can never hold a backfill place for good.
export async function within<T>(page: { close(): void }, read: Promise<T>, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { page.close(); reject(new Error("timed out")); }, ms); });
  try { return await Promise.race([read, late]); } finally { clearTimeout(timer); }
}
