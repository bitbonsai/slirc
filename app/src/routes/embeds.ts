import { currentUser } from "../http/session.ts";
import { untrustedMediaHeaders } from "../http/media.ts";
import { fetchPublic, ResponseTooLarge } from "../safe-fetch.ts";
import { directImageEmbed, parseOg } from "../og.ts";
import { IMAGE_LIMITS } from "../photo.ts";
import { text } from "../http/common.ts";
import { Hono } from "hono";

export const embeds = new Hono();

embeds.get("/giphy", async (c) => {
  if (!currentUser(c)) return c.json({ error: "not signed in" }, 401);
  const query = (c.req.query("q") || "").trim().slice(0, 100);
  if (!query) return c.json({ gifs: [] });
  if (!process.env.GIPHY_API_KEY) return c.json({ error: "GIF search is not configured." }, 503);
  let response: Response;
  try {
    response = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(process.env.GIPHY_API_KEY)}&q=${encodeURIComponent(query)}&limit=12&rating=g`, { signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    console.error("GIF search failed:", error);
    return c.json({ error: "GIF search is unavailable right now." }, 500);
  }
  if (!response.ok) {
    console.error(`GIF search returned ${response.status}`);
    return c.json({ error: "GIF search is unavailable right now." }, 500);
  }
  const data = await response.json() as { data: { title: string; images: { fixed_width_small: { url: string }; original: { url: string; width?: string; height?: string } } }[] };
  // Giphy sends sizes as strings; the client validates them before they go on the wire.
  return c.json({ gifs: data.data.map((gif) => ({ title: gif.title, preview: gif.images.fixed_width_small.url, url: gif.images.original.url, width: Number(gif.images.original.width) || undefined, height: Number(gif.images.original.height) || undefined })) });
});

// Small in-process cache for unfurls; a repeated link is a repeated fetch otherwise.
// ponytail: single Map, no TTL sweep — size is bounded by distinct links in a session.
export const embedCache = new Map<string, Record<string, string>>();

// Player hosts we will frame. Anything else degrades to the link card. Vimeo gets do-not-track.
export const PLAYER_HOSTS = new Set([
  "player.vimeo.com", "open.spotify.com", "w.soundcloud.com", "embed.bsky.app", "www.tiktok.com", "www.loom.com",
  "codepen.io", "www.figma.com", "embed.music.apple.com", "bandcamp.com", "embed.podcasts.apple.com", "www.youtube-nocookie.com",
  "video.twimg.com", "player.twitch.tv", "clips.twitch.tv", "embed.ted.com", "www.dailymotion.com", "www.kickstarter.com",
]);

// Providers whose pages omit the oEmbed <link> for bots. host -> endpoint that takes ?url=.
const OEMBED_ENDPOINTS: Record<string, string> = {
  "vimeo.com": "https://vimeo.com/api/oembed.json",
  "player.vimeo.com": "https://vimeo.com/api/oembed.json",
  "bsky.app": "https://embed.bsky.app/oembed",
  "www.tiktok.com": "https://www.tiktok.com/oembed",
  "www.twitch.tv": "https://api.twitch.tv/v5/oembed",
  "soundcloud.com": "https://soundcloud.com/oembed",
  "www.loom.com": "https://www.loom.com/v1/oembed",
  "codepen.io": "https://codepen.io/api/oembed",
};

function playerFromOembed(data: Record<string, unknown>, page: URL): { src: string; width: number | null; height: number | null } | null {
  if (data.type !== "video" && data.type !== "rich") return null;
  if (typeof data.html !== "string") return null;
  const src = data.html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, "&");
  if (!src) return null;
  let target: URL;
  try { target = new URL(src, page); } catch { return null; }
  if (target.protocol !== "https:") return null;
  // Same-host players (Mastodon instances, PeerTube) are fine: the page itself vouches for them.
  if (!PLAYER_HOSTS.has(target.hostname) && target.hostname !== page.hostname) return null;
  if (target.hostname === "player.vimeo.com") target.searchParams.set("dnt", "1");
  const size = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return { src: target.href, width: size(data.width), height: size(data.height) };
}

// Preview images go through the app, so a reader's browser never contacts the provider until they press play.
// Local dev serves on private addresses (Tailscale CGNAT, LAN, loopback) that the SSRF
// guard blocks by design. This flag turns the guard off for the local stack only;
// production never sets it.
const embedAllowPrivate = process.env.EMBED_ALLOW_PRIVATE === "true";

const imageCache = new Map<string, { type: string; body: Uint8Array; at: number }>();

// Raster types only: an SVG served from the app origin can run script when opened directly.
const RASTER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

// Video thumbnails for guests. Members still proxy any embed image; anonymous readers
// only ever reach these hosts, so the endpoint stays useless as an open image proxy.
const guestImageHosts = new Set(["i.ytimg.com"]);

embeds.get("/api/embed/image", async (c) => {
  // Every failure path stays out of caches: a transient upstream 404 must not be
  // pinned for a day by the browser. Only a decoded image gets the long private TTL.
  c.header("Cache-Control", "no-store");
  const raw = c.req.query("url") || "";
  let target: URL;
  try { target = new URL(raw); } catch { return c.body(null, 400); }
  if (target.protocol !== "https:" && target.protocol !== "http:") return c.body(null, 400);
  const cached = imageCache.get(target.href);
  // A signed-out reader (the #open-chat peek) gets images a member already loaded, like link
  // previews in /api/embed; the server never fetches a picture because a guest asked for it.
  if (!currentUser(c) && !guestImageHosts.has(target.hostname) && !cached) return c.body(null, 401);
  if (cached) {
    c.header("Cache-Control", "private, max-age=86400");
    for (const [name, value] of Object.entries(untrustedMediaHeaders(cached.type, "image"))) c.header(name, value);
    return c.body(cached.body);
  }
  try {
    const response = await fetchPublic(target, { accept: "image/*", allowPrivate: embedAllowPrivate });
    const type = (response.header("content-type") || "").split(";", 1)[0]!.trim().toLowerCase();
    if (!response.ok || !RASTER_IMAGE_TYPES.has(type)) {
      response.close();
      return c.body(null, 404);
    }
    const body = await response.bytes(3_000_000);
    if (imageCache.size >= 80) imageCache.delete([...imageCache.keys()][0]);
    imageCache.set(target.href, { type, body, at: Date.now() });
    c.header("Cache-Control", "private, max-age=86400");
    for (const [name, value] of Object.entries(untrustedMediaHeaders(type, "image"))) c.header(name, value);
    return c.body(body);
  } catch (error) {
    if (error instanceof ResponseTooLarge) return c.body(null, 413);
    if (error instanceof Error && error.message === "blocked") return c.body(null, 403);
    return c.body(null, 404);
  }
});

embeds.post("/api/embed", async (c) => {
  const nick = currentUser(c);
  const { url: rawUrl } = await c.req.json().catch(() => ({}));
  if (typeof rawUrl !== "string" || !/^https?:\/\/[^\s]+$/i.test(rawUrl)) return c.json({ error: "invalid url" }, 400);
  let url: URL;
  try { url = new URL(rawUrl); } catch { return c.json({ error: "invalid url" }, 400); }
  if (!["http:", "https:"].includes(url.protocol)) return c.json({ error: "invalid url" }, 400);
  if (embedCache.has(url.href)) return c.json(embedCache.get(url.href));
  // Anonymous readers in open channels see previews a member already fetched for that
  // link; the server never fetches a page because a guest asked it to.
  if (!nick) return c.json({});

  try {
    const page = await fetchPublic(url, { allowPrivate: embedAllowPrivate });
    // A URL that serves an image is its own preview: reuse the embed card's proxied
    // image instead of parsing binary bytes as OpenGraph HTML.
    const directImage = page.ok ? directImageEmbed(page.finalUrl.href, page.header("content-type")) : null;
    if (directImage) {
      let dimensions: { width: number; height: number } | undefined;
      try {
        const bytes = await page.bytes(3_000_000);
        const meta = await new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels, autoOrient: true }).metadata();
        if (meta.width && meta.height && meta.width * meta.height <= IMAGE_LIMITS.maxPixels) {
          dimensions = { width: meta.width, height: meta.height };
        }
        if (imageCache.size >= 80) imageCache.delete([...imageCache.keys()][0]);
        imageCache.set(page.finalUrl.href, { type: page.header("content-type")!, body: bytes, at: Date.now() });
      } catch { /* Unsupported/oversized images retain the existing validated fallback. */ }
      finally { page.close(); }
      const result = { ...directImage, ...dimensions };
      if (embedCache.size >= 200) embedCache.delete([...embedCache.keys()][0]);
      embedCache.set(url.href, result);
      return c.json(result);
    }
    const html = await page.text(512_000);
    const base = page.finalUrl;
    const meta: Record<string, unknown> = parseOg(html);
    if (typeof meta.image === "string") {
      try { meta.image = new URL(meta.image, base).href; } catch { delete meta.image; }
    }
    // oEmbed: the page advertises a JSON endpoint; providers on the allowlist may supply a player iframe.
    // The browser never loads provider HTML; we keep only the iframe src and render our own sandboxed frame.
    const oembedHref = html.match(/<link[^>]+type=["']application\/json\+oembed["'][^>]*href=["']([^"']+)["']/i)?.[1]
      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/json\+oembed["']/i)?.[1];
    const knownEndpoint = OEMBED_ENDPOINTS[base.hostname] || OEMBED_ENDPOINTS[url.hostname];
    if (oembedHref || knownEndpoint) {
      try {
        const endpoint = oembedHref ? new URL(oembedHref.replace(/&amp;/g, "&"), base) : new URL(`${knownEndpoint}?format=json&url=${encodeURIComponent(url.href)}`);
        if (endpoint.protocol === "https:") {
          const response = await fetchPublic(endpoint, { accept: "application/json", maxHops: 3, allowPrivate: embedAllowPrivate });
          const data = JSON.parse(await response.text(512_000)) as Record<string, unknown>;
          const player = playerFromOembed(data, base);
          if (player) meta.player = player;
          if (!meta.title && typeof data.title === "string") meta.title = data.title;
          if (!meta.site && typeof data.provider_name === "string") meta.site = data.provider_name;
          if (typeof data.author_name === "string") meta.author = data.author_name;
          if (!meta.image && typeof data.thumbnail_url === "string") meta.image = data.thumbnail_url;
          if (data.type === "photo" && typeof data.url === "string") meta.image = data.url;
        }
      } catch (error) {
        console.error(`oembed skipped for ${url.href}:`, error instanceof Error ? error.message : error);
      }
    }
    // CodePen fronts its oEmbed with a bot check; the embed URL follows from the pen URL anyway.
    if (!meta.player && url.hostname === "codepen.io") {
      const pen = url.pathname.match(/^\/([\w-]+)\/(?:pen|full|details)\/([A-Za-z]+)/);
      if (pen) {
        meta.player = { src: `https://codepen.io/${pen[1]}/embed/${pen[2]}?default-tab=result`, width: null, height: null };
        if (!meta.site) meta.site = "CodePen";
      }
    }
    if (embedCache.size >= 200) embedCache.delete([...embedCache.keys()][0]);
    embedCache.set(url.href, meta);
    return c.json(meta);
  } catch (error) {
    // Best-effort previews: a page that blocks bots or times out is not an app
    // error, so the client gets an empty card instead of a noisy 502.
    console.error(`embed failed for ${url.href}:`, error instanceof Error ? error.message : error);
    return c.json({});
  }
});
