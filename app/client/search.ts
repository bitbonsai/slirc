// Channel search (v1): pure query parsing, matching, safe snippet segments, and
// Dexie/Notes search over the currently open conversation.
import type { ClientDatabase } from "./db.ts";
import type { Message } from "./model.ts";
import { noteMessage, type Note } from "./notes.ts";
import { formatTime, messageDateLabel } from "./presentation.ts";
import type { AuthorizedConversation } from "./sync.ts";
import type { ThreadGrant } from "./access.ts";
import { isHiddenThreadAnnouncement } from "./threads.ts";
import { isLegacyThreadAnnouncement } from "./reply-threads.ts";
import { inlineMedia } from "./media.ts";
import { embedImageUrl } from "./render.ts";
import type { EmbedMeta } from "./embed.ts";
import { isDailyGreeting } from "../shared/service-bots.ts";

export const SEARCH_RESULT_LIMIT = 50;
const SNIPPET_MAX_LEN = 140;
const SNIPPET_LEAD_CONTEXT = 35;

export interface ParsedSearchQuery {
  from: string | null;
  terms: string[];
}

export interface SnippetSegment {
  text: string;
  hit: boolean;
}

export interface SearchHit {
  id: string;
  focusId: string;
  authorNick: string;
  time: string;
  timeLabel: string;
  segments: SnippetSegment[];
  thumb: string;
  link: SearchLink | null;
}

export interface SearchLink {
  url: string;
  host: string;
  title: string;
  thumb: string;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  parsed: ParsedSearchQuery;
}

export type SearchKind = "images" | "links";

export interface SearchOptions {
  kind?: SearchKind | null;
  origin?: string;
  embeds?: Record<string, EmbedMeta>;
  threads?: readonly ThreadGrant[];
  conversations?: readonly AuthorizedConversation[];
  greeting?: boolean;
  hidden?: (message: Message) => boolean;
  limit?: number;
  now?: Date;
}

// Cmd+F on Apple keyboards, Ctrl+F elsewhere.
export function isChannelSearchShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean },
  apple: boolean,
): boolean {
  if (event.isComposing || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return false;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const trimmed = raw.trim();
  if (!trimmed) return { from: null, terms: [] };
  let from: string | null = null;
  const terms: string[] = [];
  for (const token of trimmed.split(/\s+/)) {
    const match = /^from:@?(.*)$/i.exec(token);
    if (match) {
      const nick = match[1]!.trim().toLowerCase();
      if (nick) from = nick;
      continue;
    }
    terms.push(token.toLowerCase());
  }
  return { from, terms };
}

export function hasSearchCriteria(parsed: ParsedSearchQuery): boolean {
  return Boolean(parsed.from || parsed.terms.length > 0);
}

export function effectiveMessageTime(message: Message): string {
  return message.at ?? message.time;
}

export function formatSearchTime(iso: string, now: Date = new Date()): string {
  const time = formatTime(iso);
  const dateLabel = messageDateLabel(iso, now);
  if (!dateLabel || dateLabel === "Today") return time;
  return time ? `${dateLabel} ${time}` : dateLabel;
}

const IMAGE_URL = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif)(?:[?#]\S*)?(?=\s|$)/i;
const ANY_URL = /https?:\/\/\S+/i;

// Images: our uploads, Giphy lines and bare image links. Links: any other message with a URL.
export function messageHasKind(message: Message, kind: SearchKind, origin = "http://localhost"): boolean {
  const image = inlineMedia(message.text, origin).length > 0 || IMAGE_URL.test(message.text);
  return kind === "images" ? image : !image && ANY_URL.test(message.text);
}

// A picture to show beside a hit: our upload, a GIF or a bare image link.
export function messageThumb(message: Message, origin: string): string {
  const media = inlineMedia(message.text, origin).find((item) => item.kind !== "video");
  if (media) return media.href;
  const image = IMAGE_URL.exec(message.text);
  if (image) return embedImageUrl(image[0]);
  return "";
}

// The first link of a message that is not a picture, with what the client already knows of its preview.
export function messageLink(message: Message, origin: string, embeds: Record<string, EmbedMeta> = {}): SearchLink | null {
  if (messageHasKind(message, "images", origin)) return null;
  const url = ANY_URL.exec(message.text)?.[0].replace(/[.,;:!?]+$/, "");
  if (!url) return null;
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep the raw text */ }
  const meta = embeds[url];
  return { url, host, title: meta?.title ?? "", thumb: meta?.image ? embedImageUrl(meta.image) : "" };
}

export function matchesSearchMessage(message: Message, parsed: ParsedSearchQuery, allowEmpty = false): boolean {
  if (!allowEmpty && !hasSearchCriteria(parsed)) return false;
  if (parsed.from) {
    const nick = message.authorNick.toLowerCase();
    const account = message.authorAccount.toLowerCase();
    if (nick !== parsed.from && account !== parsed.from) return false;
  }
  if (!parsed.terms.length) return true;
  const haystack = parsed.from
    ? message.text.toLowerCase()
    : `${message.authorNick} ${message.text}`.toLowerCase();
  return parsed.terms.every((term) => haystack.includes(term));
}

// Build plain-text highlight segments so Alpine renders them with `x-text` and zero raw HTML.
// Defaults to the full message (`maxLen = Infinity`); callers may pass a finite `maxLen` to clip.
export function buildSnippetSegments(
  text: string,
  terms: readonly string[],
  maxLen = Infinity,
): SnippetSegment[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const needles = [...new Set(terms.map((term) => term.toLowerCase()).filter(Boolean))];
  if (!needles.length) {
    const clipped = normalized.length > maxLen ? `${normalized.slice(0, maxLen).trimEnd()}…` : normalized;
    return [{ text: clipped, hit: false }];
  }

  const lower = normalized.toLowerCase();
  const ranges: [number, number][] = [];
  for (const needle of needles) {
    let at = 0;
    while (at < lower.length) {
      const found = lower.indexOf(needle, at);
      if (found < 0) break;
      ranges.push([found, found + needle.length]);
      at = found + Math.max(1, needle.length);
    }
  }

  if (!ranges.length) {
    const clipped = normalized.length > maxLen ? `${normalized.slice(0, maxLen).trimEnd()}…` : normalized;
    return [{ text: clipped, hit: false }];
  }

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const firstStart = merged[0]![0];
  let winStart = 0;
  let winEnd = normalized.length;
  if (normalized.length > maxLen) {
    winStart = Math.max(0, firstStart - SNIPPET_LEAD_CONTEXT);
    winEnd = Math.min(normalized.length, winStart + maxLen);
    if (winEnd === normalized.length) winStart = Math.max(0, winEnd - maxLen);
  }

  const segments: SnippetSegment[] = [];
  const push = (value: string, hit: boolean): void => {
    if (!value) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.hit === hit) prev.text += value;
    else segments.push({ text: value, hit });
  };

  if (winStart > 0) push("…", false);
  let cursor = winStart;
  for (const [start, end] of merged) {
    if (end <= winStart) continue;
    if (start >= winEnd) break;
    const segStart = Math.max(start, winStart);
    const segEnd = Math.min(end, winEnd);
    if (segStart > cursor) push(normalized.slice(cursor, segStart), false);
    push(normalized.slice(segStart, segEnd), true);
    cursor = segEnd;
  }
  if (cursor < winEnd) push(normalized.slice(cursor, winEnd), false);
  if (winEnd < normalized.length) push("…", false);
  return segments;
}

function newestFirst(a: Message, b: Message): number {
  const ta = effectiveMessageTime(a);
  const tb = effectiveMessageTime(b);
  if (ta !== tb) return ta > tb ? -1 : 1;
  return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
}

export function searchMessages(
  messages: readonly Message[],
  rawQuery: string,
  options: SearchOptions = {},
): SearchResult {
  const parsed = parseSearchQuery(rawQuery);
  const kind = options.kind ?? null;
  if (!kind && !hasSearchCriteria(parsed)) return { hits: [], total: 0, parsed };

  const origin = options.origin ?? globalThis.location?.origin ?? "http://localhost";
  const threads = options.threads ?? [];
  const conversations = options.conversations ?? [];
  const greeting = options.greeting ?? true;
  const hidden = options.hidden;
  const limit = options.limit ?? SEARCH_RESULT_LIMIT;
  const now = options.now ?? new Date();

  const visible = messages.filter((message) => {
    if (message.deleted || isLegacyThreadAnnouncement(message)) return false;
    if (!greeting && isDailyGreeting(message.authorAccount, message.text)) return false;
    if (threads.length && isHiddenThreadAnnouncement(message, threads, conversations, messages)) return false;
    if (hidden?.(message)) return false;
    return true;
  });

  const matched = visible.filter((message) => (!kind || messageHasKind(message, kind, origin)) && matchesSearchMessage(message, parsed, !!kind)).sort(newestFirst);
  const hits: SearchHit[] = matched.slice(0, limit).map((message) => {
    const time = effectiveMessageTime(message);
    const link = messageLink(message, origin, options.embeds);
    return {
      id: message.id,
      focusId: message.serverId ?? message.id,
      authorNick: message.authorNick,
      time,
      timeLabel: formatSearchTime(time, now),
      segments: buildSnippetSegments(link ? message.text.replace(link.url, "").trim() : message.text, parsed.terms),
      thumb: link ? "" : messageThumb(message, origin),
      link,
    };
  });

  return { hits, total: matched.length, parsed };
}

export async function searchConversation(
  db: ClientDatabase,
  conversationId: string,
  rawQuery: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const parsed = parseSearchQuery(rawQuery);
  if (!options.kind && !hasSearchCriteria(parsed)) return { hits: [], total: 0, parsed };
  const rows = await db.messages.where("conversationId").equals(conversationId).toArray();
  return searchMessages(rows, rawQuery, options);
}

export function searchNotes(
  notes: readonly Note[],
  account: string,
  nick: string,
  rawQuery: string,
  options: SearchOptions = {},
): SearchResult {
  const messages = notes.map((note) => noteMessage(note, account, nick));
  return searchMessages(messages, rawQuery, options);
}
