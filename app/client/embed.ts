// Pure embed metadata normalization and player policy for the new client. The server already
// sanitizes /api/embed, but the client re-checks the player host and https before framing so a
// malformed or future server response cannot widen the iframe surface. No provider HTML is ever
// injected; only an allowlisted src goes into our own sandboxed dialog iframe.

// Mirrors the server's framed-player allowlist. Anything else degrades to the link card.
export const PLAYER_HOSTS = new Set([
  "player.vimeo.com", "open.spotify.com", "w.soundcloud.com", "embed.bsky.app", "www.tiktok.com", "www.loom.com",
  "codepen.io", "www.figma.com", "embed.music.apple.com", "bandcamp.com", "embed.podcasts.apple.com", "www.youtube-nocookie.com",
  "video.twimg.com", "player.twitch.tv", "clips.twitch.tv", "embed.ted.com", "www.dailymotion.com", "www.kickstarter.com",
]);

export interface EmbedPlayer {
  src: string;
  width: number | null;
  height: number | null;
}

export interface EmbedMeta {
  kind?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
  image?: string;
  site?: string;
  author?: string;
  url?: string;
  player?: EmbedPlayer;
}

export function sanitizePlayer(player: unknown): EmbedPlayer | null {
  if (!player || typeof player !== "object") return null;
  const src = (player as { src?: unknown }).src;
  if (typeof src !== "string" || !src) return null;
  let url: URL;
  try { url = new URL(src); } catch { return null; }
  // Reject credentials so a provider-parsed src cannot smuggle userinfo past the host check.
  if (url.protocol !== "https:" || url.username || url.password || !PLAYER_HOSTS.has(url.hostname)) return null;
  const size = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
  return { src: url.href, width: size((player as { width?: unknown }).width), height: size((player as { height?: unknown }).height) };
}

// Keep only the fields the renderer understands, and only when there is something to show.
export function embedMetaFromResponse(raw: unknown): EmbedMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const meta: EmbedMeta = {};
  for (const key of ["title", "description", "image", "site", "author", "url"] as const) {
    if (typeof body[key] === "string" && body[key]) meta[key] = body[key] as string;
  }
  if (typeof body.kind === "string" && body.kind) meta.kind = body.kind;
  if (typeof body.width === "number" && typeof body.height === "number" && Number.isInteger(body.width) && Number.isInteger(body.height) && body.width > 0 && body.height > 0 && body.width * body.height <= 50_000_000) {
    meta.width = body.width; meta.height = body.height;
  }
  const player = sanitizePlayer(body.player);
  if (player) meta.player = player;
  return meta.player || meta.title || meta.image || meta.description || meta.site ? meta : null;
}

// Provider-declared size drives the frame aspect; the 16:9 default is only a fallback.
export function playerAspect(player: EmbedPlayer | undefined): number {
  const width = player?.width, height = player?.height;
  return width && height ? width / height : 16 / 9;
}

// Strip players (Spotify track, SoundCloud mini) get a narrow frame.
export function isCompactPlayer(player: EmbedPlayer | undefined): boolean {
  return typeof player?.height === "number" && player.height < 200;
}

export function playerHostKind(src: string): "audio" | "video" {
  try {
    const host = new URL(src).hostname;
    return /spotify|soundcloud|music\.apple|podcasts\.apple|bandcamp/.test(host) ? "audio" : "video";
  } catch { return "video"; }
}

if (import.meta.main) {
  const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
  assert(sanitizePlayer({ src: "https://open.spotify.com/embed/track/x", width: 456, height: 152 })?.src.includes("spotify"), "allowlisted https player kept");
  assert(sanitizePlayer({ src: "https://evil.test/embed" }) === null, "foreign host refused");
  assert(sanitizePlayer({ src: "http://open.spotify.com/embed" }) === null, "http refused");
  assert(embedMetaFromResponse({ title: "T", player: { src: "https://player.vimeo.com/video/1" } })?.player?.src.includes("vimeo"), "player kept");
  assert(embedMetaFromResponse({ nothing: true }) === null, "empty meta dropped");
  assert(playerAspect({ src: "https://open.spotify.com/embed", width: 456, height: 152 }) > 2, "declared aspect used");
  assert(isCompactPlayer({ src: "x", width: 456, height: 152 }), "small player is compact");
  console.log("embed self-check ok");
}
