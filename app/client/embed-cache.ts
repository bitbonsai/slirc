// Preview cards are fetched after the rows paint, so a reload drew every link as bare text and then
// grew each row as its card landed. The metadata for links already seen is kept per account in
// localStorage and read synchronously when a session opens, so known cards are in the first paint.
// A link that never had a card is not stored, so it never reserves space.
import { embedMetaFromResponse, type EmbedMeta } from "@client/embed.ts";

type Store = Pick<Storage, "getItem" | "setItem">;
type Entry = { meta: EmbedMeta; at: number };

export const EMBED_CACHE_LIMIT = 300;
// Old previews are fetched again so a page that changed its card is not frozen forever.
export const EMBED_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const keyFor = (accountId: string): string => `slirc2-embeds:${accountId}`;
const storage = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

function readEntries(accountId: string, store: Store | null, now: number): Record<string, Entry> {
  if (!accountId || !store) return {};
  let raw: unknown;
  try { raw = JSON.parse(store.getItem(keyFor(accountId)) ?? "{}"); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries: Record<string, Entry> = {};
  for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^https?:\/\//.test(url) || !value || typeof value !== "object") continue;
    const at = (value as { at?: unknown }).at;
    if (typeof at !== "number" || !(now - at < EMBED_CACHE_MAX_AGE)) continue;
    // Stored data is re-checked like a server response, so an edited entry cannot widen a player.
    const meta = embedMetaFromResponse((value as { meta?: unknown }).meta);
    if (meta) entries[url] = { meta, at };
  }
  return entries;
}

export function cachedEmbeds(accountId: string, store: Store | null = storage(), now = Date.now()): Record<string, EmbedMeta> {
  return Object.fromEntries(Object.entries(readEntries(accountId, store, now)).map(([url, entry]) => [url, entry.meta]));
}

export function rememberEmbed(accountId: string, url: string, meta: EmbedMeta, store: Store | null = storage(), now = Date.now()): void {
  if (!accountId || !store) return;
  const entries = readEntries(accountId, store, now);
  delete entries[url];
  entries[url] = { meta, at: now };
  // Insertion order is age order: drop the oldest past the limit.
  const urls = Object.keys(entries);
  for (const old of urls.slice(0, Math.max(0, urls.length - EMBED_CACHE_LIMIT))) delete entries[old];
  try { store.setItem(keyFor(accountId), JSON.stringify(entries)); } catch { /* full or blocked storage: the card is fetched next time */ }
}
