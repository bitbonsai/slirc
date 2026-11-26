import { createLimiter } from "../request-security.ts";
import { type Account } from "../accounts.ts";
import { linksEnabled, type LinkRow, canRemoveLink, type LinkQuery, SOURCES, searchLinks, linkFilterFacets, viewerHasSite, storedFavicon, storeFavicon, linkKey, visibleLinkByKey, visibleLink, linkFacets, editLinkTopic, MAX_EDITED_TOPICS, removeLink } from "../links.ts";
import { currentUser, verifiedHuman, sameOriginJson } from "../http/session.ts";
import { imageKind, storedPost, hasCopy, originalGone, storedImage, storedCopy, storedImageDims } from "../links-images.ts";
import { text } from "../http/common.ts";
import { fetchFavicon } from "../links-fetch.ts";
import { join } from "node:path";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";

export const links = new Hono();

// The links library. It exists only where the `links` helper is switched on; elsewhere every
// route answers 404. Members only: agents, bots and helpers are refused. Each read applies the
// viewer's channel membership inside links.ts, so a private channel's links, counts and filter
// values never reach someone outside it.
// The list and its suggestions each take one, and the list reloads as someone types.
const linkSearchLimit = createLimiter({ limit: 240, windowMs: 60_000 });

const linkRemoveLimit = createLimiter({ limit: 30, windowMs: 60_000 });

function linksViewer(c: any): { account: Account } | { response: Response } {
  c.header("Cache-Control", "private, no-store");
  if (!linksEnabled()) return { response: c.json({ error: "not found" }, 404) };
  if (!currentUser(c)) return { response: c.json({ error: "not signed in" }, 401) };
  const account = verifiedHuman(c);
  return account ? { account } : { response: c.json({ error: "members only" }, 403) };
}

const linkDay = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN);

// What a member sees of a row. The sharer's account id stays on the server;
// `canRemove` says what the screen needs to know about it.
function linkJson(link: LinkRow, viewer: Account) {
  return {
    id: link.id, url: link.url, title: link.title, summary: link.summary, author: link.author, source: link.source, topics: link.topics,
    origins: link.origins, firstSharedAt: link.firstSharedAt, lastSharedAt: link.lastSharedAt, shareCount: link.shareCount,
    sharedBy: link.sharedByName, private: link.scope || null, canRemove: canRemoveLink(viewer, link), image: link.hasImage,
    // An X post's own words and author, and whether the picture is the author's.
    imageKind: link.hasImage ? imageKind(link.id) : null, post: link.source === "x" ? storedPost(link.id) : null,
    // A saved copy exists, and whether the original was found gone.
    copy: hasCopy(link.id), gone: originalGone(link.id),
  };
}

// `when` is week, month, or a calendar year.
const linkSince = (when: string) => when === "week" ? Date.now() - 7 * 24 * 60 * 60_000 : when === "month" ? Date.now() - 30 * 24 * 60 * 60_000 : /^(19|20)\d{2}$/.test(when) ? Date.UTC(Number(when), 0, 1) : undefined;

const linkUntil = (when: string) => (/^(19|20)\d{2}$/.test(when) ? Date.UTC(Number(when) + 1, 0, 1) : undefined);

// One query shape for the list and for its filter suggestions.
function linkQuery(c: any): LinkQuery | null {
  const text = (name: string, max: number) => (c.req.query(name) || "").trim().slice(0, max);
  const source = text("source", 32);
  if (source && !(SOURCES as readonly string[]).includes(source)) return null;
  const from = linkDay(c.req.query("from"));
  const to = linkDay(c.req.query("to"));
  const topics = ((c.req.queries("topic") || []) as string[]).map((topic) => topic.trim().slice(0, 64)).filter(Boolean).slice(0, 6);
  return {
    q: text("q", 200), topics, source, origin: text("origin", 64), sharer: text("sharer", 80), site: text("site", 120), channel: text("channel", 64),
    from: Number.isFinite(from) ? from : linkSince(text("when", 8)), to: Number.isFinite(to) ? to + 24 * 60 * 60_000 : linkUntil(text("when", 8)),
  };
}

links.get("/api/links", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many searches. Try again in a minute." }, 429);
  const query = linkQuery(c);
  if (!query) return c.json({ rows: [], total: 0, more: false });
  const offset = Number(c.req.query("offset"));
  const limit = Number(c.req.query("limit"));
  const results = searchLinks(viewer.account.nick, {
    ...query,
    offset: Number.isInteger(offset) && offset > 0 && offset <= 100_000 ? offset : 0,
    limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
  });
  return c.json({ rows: results.rows.map((link) => linkJson(link, viewer.account)), total: results.total, more: results.more });
});

// Filter values and counts within the current results, from the rows this member can see.
links.get("/api/links/facets", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many searches. Try again in a minute." }, 429);
  const query = linkQuery(c);
  return c.json(query ? linkFilterFacets(viewer.account.nick, query) : { total: 0, topics: [], sources: [], origins: [], sharers: [], years: [], week: 0, month: 0 });
});

// A site's icon for the rows. Fetched once per host through the guarded fetch and kept in the
// database, so a browser never asks a third party for it. Only for a host the member already
// has a link on, a few at a time; a host that gave no icon is asked again after a week.
const faviconLimit = createLimiter({ limit: 600, windowMs: 60_000 });

const FAVICON_RETRY_MS = 7 * 24 * 60 * 60_000;

const faviconWaiting = new Map<string, Promise<void>>();

let faviconRunning = 0;

const faviconTurns: (() => void)[] = [];

links.get("/api/links/favicon", async (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  const host = (c.req.query("host") || "").toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 120) return c.body(null, 404);
  if (!faviconLimit.check(viewer.account.id) || !viewerHasSite(viewer.account.nick, host)) return c.body(null, 404);
  let icon = storedFavicon(host);
  if (!icon || (!icon.body && Date.now() - icon.fetchedAt > FAVICON_RETRY_MS)) {
    let pending = faviconWaiting.get(host);
    if (!pending) {
      // A page of rows asks for many hosts at once. A few are fetched at a time; the rest wait
      // their turn, and past a full queue the answer is "none for now" without recording it.
      if (faviconWaiting.size >= 80) return c.body(null, 404, { "Cache-Control": "private, max-age=60" });
      pending = (async () => {
        while (faviconRunning >= 6) await new Promise<void>((resolve) => faviconTurns.push(resolve));
        faviconRunning++;
        try {
          const found = await fetchFavicon(host);
          storeFavicon(host, found?.mime ?? null, found?.body ?? null);
        } catch {
          storeFavicon(host, null, null);
        } finally {
          faviconRunning--;
          faviconWaiting.delete(host);
          faviconTurns.shift()?.();
        }
      })();
      faviconWaiting.set(host, pending);
    }
    await pending;
    icon = storedFavicon(host);
  }
  if (!icon?.body || !icon.mime) return c.body(null, 404, { "Cache-Control": "private, max-age=86400" });
  return c.body(icon.body as unknown as ArrayBuffer, 200, {
    "Content-Type": icon.mime, "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline",
  });
});

// Is this address already saved? Answers with the row the member can see, or null.
links.get("/api/links/lookup", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many searches. Try again in a minute." }, 429);
  const key = linkKey((c.req.query("url") || "").slice(0, 2_000));
  const link = key ? visibleLinkByKey(viewer.account.nick, key) : null;
  return c.json({ link: link ? linkJson(link, viewer.account) : null });
});

// A link's preview image, to the members who may see the link and nobody else.
links.get("/api/links/:id/image", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  const id = Number(c.req.param("id"));
  const link = Number.isSafeInteger(id) && id > 0 ? visibleLink(viewer.account.nick, id) : null;
  const image = link ? storedImage(link.id) : null;
  if (!image) return c.body(null, 404);
  return c.body(image.body as unknown as ArrayBuffer, 200, {
    "Content-Type": image.mime, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline",
  });
});

// A link's saved copy, for the reader view: the page's text as plain text, or an X post's
// words. Only for members who may see the link; to anyone else it does not exist.
links.get("/api/links/:id/copy", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many requests. Try again in a minute." }, 429);
  const id = Number(c.req.param("id"));
  const link = Number.isSafeInteger(id) && id > 0 ? visibleLink(viewer.account.nick, id) : null;
  const copy = link ? storedCopy(link.id) : null;
  const post = link && !copy ? storedPost(link.id) : null;
  if (!link || (!copy && !post)) return c.json({ error: "no saved copy" }, 404);
  // The preview's stored size reserves its box in the reader before the picture arrives.
  const dims = storedImageDims(link.id);
  return c.json({
    id: link.id, url: link.url, title: copy?.title || link.title, byline: copy?.byline || (post ? [post.name, post.handle && `@${post.handle}`].filter(Boolean).join(" ") : ""),
    text: copy?.text ?? post!.text, savedAt: copy?.savedAt ?? link.firstSharedAt, image: link.hasImage && imageKind(link.id) === "image", gone: originalGone(link.id),
    imageWidth: dims?.width ?? null, imageHeight: dims?.height ?? null,
    kind: copy ? "page" : "post",
  });
});

// Every topic on the links this member can see, for the type-ahead when adding one to a link.
links.get("/api/links/topics", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!linkSearchLimit.check(viewer.account.id)) return c.json({ error: "Too many searches. Try again in a minute." }, 429);
  return c.json({ topics: linkFacets(viewer.account.nick).topics });
});

// Add or remove one topic on a link. Any member who can see the link may; a link the caller
// cannot see answers 404, like an id that does not exist.
const linkTopicLimit = createLimiter({ limit: 60, windowMs: 60_000 });

links.use("/api/links/:id/topics", bodyLimit({ maxSize: 1_024 }));

links.post("/api/links/:id/topics", async (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!sameOriginJson(c, "X-Slirc-Links")) return c.json({ error: "same-origin request required" }, 403);
  if (!linkTopicLimit.check(viewer.account.id)) return c.json({ error: "Too many edits. Try again in a minute." }, 429);
  const body = await c.req.json().catch(() => ({}));
  const action = body?.add !== undefined ? "add" : body?.remove !== undefined ? "remove" : null;
  const raw = action === "add" ? body.add : action === "remove" ? body.remove : "";
  const id = Number(c.req.param("id"));
  if (!action || typeof raw !== "string" || raw.length > 80) return c.json({ error: "Name one topic to add or remove." }, 400);
  const outcome = Number.isSafeInteger(id) && id > 0 ? editLinkTopic(viewer.account, id, action, raw) : { error: "missing" as const };
  if ("link" in outcome) return c.json({ link: linkJson(outcome.link, viewer.account) });
  if (outcome.error === "missing") return c.json({ error: "link not found" }, 404);
  if (outcome.error === "full") return c.json({ error: `A link holds up to ${MAX_EDITED_TOPICS} topics.` }, 400);
  return c.json({ error: "Topics use letters, numbers and hyphens." }, 400);
});

// Whoever added a link, or an admin, can remove it. A link the caller cannot see answers 404,
// the same as an id that does not exist.
links.post("/api/links/:id/remove", (c) => {
  const viewer = linksViewer(c);
  if ("response" in viewer) return viewer.response;
  if (!sameOriginJson(c, "X-Slirc-Links")) return c.json({ error: "same-origin request required" }, 403);
  if (!linkRemoveLimit.check(viewer.account.id)) return c.json({ error: "Too many removals. Try again in a minute." }, 429);
  const id = Number(c.req.param("id"));
  const outcome = Number.isSafeInteger(id) && id > 0 ? removeLink(viewer.account, id) : "missing";
  if (outcome === "missing") return c.json({ error: "link not found" }, 404);
  if (outcome === "forbidden") return c.json({ error: "Only the person who added it or an admin can remove this." }, 403);
  return c.json({ removed: true });
});
