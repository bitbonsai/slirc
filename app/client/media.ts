// Composer photo and video staging and message media recognition. Pure so the picker rules, the
// Giphy wire format, and the inline-media split are testable without a DOM or a network. No image
// library: only browser-decodable stills (normalized on the server) and the video containers the
// server stores as sent are accepted.
import { embedImageUrl, textSegments } from "@client/render.ts";

export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // matches the server raw limit
// iPhone videos arrive as video/quicktime (.mov); the server stores videos as sent, without
// transcoding, so only containers a browser can play are accepted.
export const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024; // matches the server video limit
// A browser that compresses video before upload takes a bigger clip; the result must still fit.
export const MAX_VIDEO_SOURCE_BYTES = 500 * 1024 * 1024;
// The picker's accept list. iOS filters its photo picker by it, so a list without video types
// shows "No Results" in a library full of videos.
export const ATTACH_ACCEPT = [...IMAGE_MIMES, ...VIDEO_MIMES].join(",");

export type PickResult = { ok: true; mime: string; kind: "image" | "video" } | { ok: false; error: string };

export function isVideoMime(mime: string): boolean {
  return (VIDEO_MIMES as readonly string[]).includes(mime.toLowerCase());
}

// Photos and videos. Animated GIFs, HEIC and every other file are refused with a clear next step
// instead of being uploaded and rejected later.
export function pickAttachment(file: { type?: string; name?: string; size?: number }, options: { compressible?: boolean } = {}): PickResult {
  const mime = (file.type || "").toLowerCase();
  if (mime === "image/gif") return { ok: false, error: "Animated GIFs are not supported. Send one with /giphy, or choose a JPEG, PNG, or WebP." };
  if (mime.startsWith("video/")) {
    if (!isVideoMime(mime)) return { ok: false, error: "That video format is not supported. Choose an MP4, MOV, or WebM video." };
    const limit = options.compressible ? MAX_VIDEO_SOURCE_BYTES : MAX_VIDEO_BYTES;
    if (typeof file.size === "number" && file.size > limit) return { ok: false, error: options.compressible ? "Videos must be under 500 MB." : "Videos must be under 30 MB." };
    return { ok: true, mime, kind: "video" };
  }
  if (mime.startsWith("image/hei")) return { ok: false, error: "HEIC photos are not supported here. Choose a JPEG, PNG, or WebP." };
  if (!(IMAGE_MIMES as readonly string[]).includes(mime)) return { ok: false, error: "That file type is not supported. Choose a JPEG, PNG, or WebP." };
  if (typeof file.size === "number" && file.size > MAX_IMAGE_BYTES) return { ok: false, error: "Photos must be under 12 MB." };
  return { ok: true, mime, kind: "image" };
}

// A GIF side length from Giphy (a string there) or from the wire: an integer 1..8192, or nothing.
export function giphySide(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 8192 ? n : undefined;
}

// The wire text IRC clients see: a readable GIF link. A known size rides in the URL fragment
// (`#w=480&h=270`), which browsers never send and older clients ignore, so the box is reserved
// at the GIF's real shape before its bytes arrive.
export function giphyWireText(query: string, url: string, width?: unknown, height?: unknown): string {
  const w = giphySide(width), h = giphySide(height);
  return `[Giphy: ${query}] ${url}${w && h ? `#w=${w}&h=${h}` : ""}`;
}

const GIPHY_LINE = /^\[Giphy:\s*(.*?)\]\s*(https?:\/\/\S+)\s*$/i;

// Only https Giphy-hosted media is treated as an inline GIF. Anything else (another host,
// http, credentials, lookalike) stays ordinary text and thus an ordinary link fallback.
export function isGiphyHost(href: string): boolean {
  let url: URL;
  try { url = new URL(href); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return url.hostname === "giphy.com" || url.hostname.endsWith(".giphy.com");
}

export function parseGiphyText(text: string): { query: string; url: string; width?: number; height?: number } | null {
  const match = GIPHY_LINE.exec(text.trim());
  if (!match || !isGiphyHost(match[2]!)) return null;
  // The fragment never leaves the client: the GIF loads and links without it.
  const [url, fragment = ""] = match[2]!.split("#", 2) as [string, string?];
  const dims = /^w=(\d+)&h=(\d+)$/.exec(fragment);
  const width = giphySide(dims?.[1]), height = giphySide(dims?.[2]);
  return { query: match[1]!.trim(), url, ...(width && height ? { width, height } : {}) };
}

// Open channels collect a GIF every day plus every /giphy. On a phone only the newest one plays
// inline; every earlier Giphy message starts collapsed to its label until tapped open.
export function isOlderGiphy(messages: readonly { id: string; text: string }[], message: { id: string; text: string }): boolean {
  const hasGiphy = (text: string) => text.split("\n").some((line) => parseGiphyText(line.trim()));
  if (!hasGiphy(message.text)) return false;
  return messages.findLast((item) => hasGiphy(item.text))?.id !== message.id;
}

// Where older GIFs start collapsed. #open-chat does it on every device, signed in or out, since
// the daily GIF piles up there; other open channels only on a phone. Never in a DM or thread.
export function collapsesOlderGiphy(view: { channel: string; coarse: boolean; open: boolean; direct: boolean; thread: boolean }): boolean {
  if (view.direct || view.thread) return false;
  return view.channel.toLowerCase() === "#open-chat" || (view.coarse && view.open);
}

// A message line that points at one of our own uploads, whether absolute or root-relative.
// Anything cross-origin is not an upload and never gets the private-read treatment.
export function uploadPath(href: string, origin: string): string | null {
  let url: URL;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.origin !== origin) return null;
  if (!/^\/uploads\/[A-Za-z0-9_-]+$/.test(url.pathname)) return null;
  return url.pathname + (url.search || "?type=image");
}

export interface InlineMedia {
  width?: number;
  height?: number;
  kind: "image" | "video" | "giphy";
  href: string;   // what the browser loads: our upload path or the same-origin proxy
  alt: string;
  label?: string; // the bracketed wire label, shown above a Giphy GIF
  url?: string;   // original link target, for the fallback when an external image fails
  uploadId?: string; // one of our own uploads, whose stored pixel size the server knows
}

// Media a body should render, in message order. A caption line stays text; only an upload URL
// line or a `[Giphy: …] url` line becomes media.
export function inlineMedia(text: string, origin: string): InlineMedia[] {
  const media: InlineMedia[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const giphy = parseGiphyText(line);
    if (giphy) {
      const { width, height } = giphy;
      media.push({ kind: "giphy", href: giphy.url, alt: giphy.query || "GIF", label: `[Giphy: ${giphy.query || "GIF"}]`, url: giphy.url, ...(width && height ? { width, height } : {}) });
      continue;
    }
    const path = uploadPath(line, origin);
    if (path) {
      const video = new URLSearchParams(path.slice(path.indexOf("?"))).get("type") === "video";
      const uploadId = path.slice("/uploads/".length).split("?")[0];
      media.push(video ? { kind: "video", href: new URL(path, origin).href, alt: "Video", uploadId } : { kind: "image", href: new URL(path, origin).href, alt: "Photo", uploadId });
    }
  }
  return media;
}

// The server returns `kind: "image"` only after fetching the URL and checking the real content
// type. That marker, not the link's host or extension, is what turns a URL line into an ordinary
// inline photo; external bytes always load through the same-origin proxy, never a raw src.
export function directImageMedia(href: string, kind: string | undefined): InlineMedia | null {
  if (kind !== "image") return null;
  return { kind: "image", href: embedImageUrl(href), alt: "Photo", url: href };
}

// The wire stays exactly `[Giphy: query] url` in IRC and storage. The client shows the bracketed
// label above the inline GIF and drops the raw URL from the body, so nothing is printed twice.
export function stripGiphyWire(text: string): string {
  return text.split("\n").filter((line) => !parseGiphyText(line.trim())).join("\n").replace(/^\n+|\n+$/g, "");
}

// Hide only a bare URL that the server confirmed is a direct image, once its photo renders. Plain
// prose and labelled links stay; the original wire text is never touched.
export function hideDirectImageUrls(text: string, isDirectImage: (href: string) => boolean): string {
  const spans: [number, number][] = [];
  for (const segment of textSegments(text)) {
    if (segment.sourceStart === undefined || !segment.href || !segment.raw) continue;
    if (segment.text !== segment.raw) continue; // keep a labelled link's own text
    if (!isDirectImage(segment.href)) continue;
    spans.push([segment.sourceStart, segment.sourceStart + segment.raw.length]);
  }
  if (!spans.length) return text;
  let out = "", cursor = 0;
  for (const [start, end] of spans) { out += text.slice(cursor, start); cursor = end; }
  return out + text.slice(cursor);
}

// The text a message body prints. Every link that renders as an inline image drops out: an upload
// or Giphy line (the same lines `inlineMedia` turns into media) and a confirmed direct image URL.
// A message that is only an image prints nothing. The wire text keeps every URL for IRC clients.
export function messageBodyText(text: string, origin: string, isDirectImage: (href: string) => boolean): string {
  return hideDirectImageUrls(splitInlineMedia(text, origin).text, isDirectImage);
}

// Remove one recognized attachment line from an edit, leaving its caption and other URLs intact.
export function removeInlineMedia(text: string, href: string, origin: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => inlineMedia(line, origin).some((media) => media.href === href));
  if (index < 0) return text;
  lines.splice(index, 1);
  return lines.join("\n").replace(/^\n+|\n+$/g, "");
}

export function splitInlineMedia(text: string, origin: string): { text: string; attachments: string[] } {
  const body: string[] = [];
  const attachments: string[] = [];
  for (const line of text.split("\n")) {
    if (inlineMedia(line, origin).length) attachments.push(line.trim());
    else body.push(line);
  }
  return { text: body.join("\n").replace(/^\n+|\n+$/g, ""), attachments };
}

if (import.meta.main) {
  const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
  assert(pickAttachment({ type: "image/jpeg", size: 10 }).ok, "jpeg accepted");
  assert(!pickAttachment({ type: "image/gif" }).ok, "gif refused");
  assert(pickAttachment({ type: "video/quicktime", size: 10 }).ok, "iPhone video accepted");
  assert(!pickAttachment({ type: "video/mp4", size: MAX_VIDEO_BYTES + 1 }).ok, "oversize video refused");
  assert(!pickAttachment({ type: "image/heic" }).ok, "heic refused");
  assert(pickAttachment({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }).ok === false, "oversize refused");
  assert(inlineMedia("caption\n/uploads/abc123?type=image", "https://app.test").length === 1, "upload line is media");
  assert(inlineMedia(giphyWireText("cats", "https://media.giphy.com/x.gif"), "https://app.test")[0]?.kind === "giphy", "giphy line is media");
  assert(inlineMedia("https://evil.test/uploads/abc123", "https://app.test").length === 0, "cross-origin upload is not media");
  assert(directImageMedia("https://img.test/a?b=c", "image")?.href === "/api/embed/image?url=https%3A%2F%2Fimg.test%2Fa%3Fb%3Dc", "direct image is proxied inline media");
  assert(directImageMedia("https://page.test/post", undefined) === null, "an ordinary link is not direct image media");
  assert(stripGiphyWire("caption\n[Giphy: cats] https://media.giphy.com/x.gif") === "caption", "giphy wire drops its raw URL line");
  const direct = "https://img.test/a.jpg";
  assert(hideDirectImageUrls(`Pexels image ${direct}`, (href) => href === direct) === "Pexels image ", "direct image URL is hidden but its caption stays");
  assert(hideDirectImageUrls("see https://github.com/x", () => false) === "see https://github.com/x", "ordinary page link stays visible");
  console.log("media self-check ok");
}
