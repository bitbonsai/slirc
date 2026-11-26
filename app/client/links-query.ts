// The Links view's query: what is typed and the filters beside it. The filter column, the typed
// form and the address are three forms of this one value. Pure functions, so the rules are
// testable without a browser.

export interface LinkFilters { topics: string[]; sharer: string; source: string; origin: string; when: string; site: string }
export interface LinkQueryState extends LinkFilters { text: string }
export interface Facet { value: string; count: number }
export interface LinkFacets { total: number; topics: Facet[]; sources: Facet[]; origins: Facet[]; sharers: Facet[]; years: Facet[]; week: number; month: number }
export type FilterKind = "topic" | "sharer" | "source" | "origin" | "when" | "site";
export interface FilterToken { key: string; kind: FilterKind; value: string; label: string }

export const emptyFacets = (): LinkFacets => ({ total: 0, topics: [], sources: [], origins: [], sharers: [], years: [], week: 0, month: 0 });
export const emptyQuery = (): LinkQueryState => ({ text: "", topics: [], sharer: "", source: "", origin: "", when: "", site: "" });

export const SOURCE_LABELS: Record<string, string> = {
  x: "X", github: "GitHub", youtube: "YouTube", linkedin: "LinkedIn", reddit: "Reddit", "hacker-news": "Hacker News",
  blog: "Blogs", product: "Products", docs: "Docs", news: "News", research: "Research", web: "Other sites",
};
const WHEN_LABELS: Record<string, string> = { week: "This week", month: "This month" };

export function filterLabel(kind: FilterKind, value: string): string {
  if (kind === "source") return SOURCE_LABELS[value] || value;
  if (kind === "when") return WHEN_LABELS[value] || value;
  if (kind === "topic") return `#${value}`;
  return value;
}

export const hasFilters = (state: LinkFilters) => !!(state.topics.length || state.sharer || state.source || state.origin || state.when || state.site);
export const filterCount = (state: LinkFilters) => state.topics.length + [state.sharer, state.source, state.origin, state.when, state.site].filter(Boolean).length;
export const isEmptyQuery = (state: LinkQueryState) => !hasFilters(state) && !state.text.trim();

// The address a message would save: the box holds one http(s) URL, with an optional note after it.
export function addressIn(text: string): string | null {
  const match = /^\s*(https?:\/\/[^\s<>"`]+)(?:\s[\s\S]*)?$/i.exec(text);
  if (!match) return null;
  try {
    const url = new URL(match[1]!);
    return url.hostname.includes(".") && !url.username && !url.password ? match[1]! : null;
  } catch { return null; }
}

const TOPIC = /^[a-z0-9][a-z0-9-]{0,39}$/;
const WHEN = /^(week|month|(19|20)\d{2})$/;
const SITE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const quoted = (value: string) => (/\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value);

// The typed form: `#agents @"Ada Example" source:github site:bun.sh in:dev_links when:2025 rust async`.
export function encodeQuery(state: LinkQueryState): string {
  return [
    ...state.topics.map((topic) => `#${topic}`),
    state.sharer ? `@${quoted(state.sharer)}` : "",
    state.source ? `source:${state.source}` : "",
    state.site ? `site:${state.site}` : "",
    state.origin ? `in:${state.origin}` : "",
    state.when ? `when:${state.when}` : "",
    state.text.trim(),
  ].filter(Boolean).join(" ");
}

// Reads the typed form back. Used for the address, where every token is taken at its word; the
// server ignores a value that names nothing.
export function decodeQuery(raw: string): LinkQueryState {
  const state = emptyQuery();
  const words: string[] = [];
  for (const match of raw.slice(0, 400).matchAll(/@"([^"]*)"|(\S+)/g)) {
    const token = match[2] ?? "";
    if (match[1] !== undefined) { if (match[1].trim()) state.sharer = match[1].trim().slice(0, 80); continue; }
    const lower = token.toLowerCase();
    if (token.startsWith("#") && TOPIC.test(lower.slice(1))) { if (!state.topics.includes(lower.slice(1)) && state.topics.length < 6) state.topics.push(lower.slice(1)); }
    else if (token.startsWith("@") && token.length > 1) state.sharer = token.slice(1, 81);
    else if (lower.startsWith("source:") && SOURCE_LABELS[lower.slice(7)]) state.source = lower.slice(7);
    else if (lower.startsWith("site:") && SITE.test(lower.slice(5))) state.site = lower.slice(5).replace(/^www\./, "");
    else if (lower.startsWith("in:") && /^[#a-z0-9][a-z0-9_.-]{0,63}$/.test(lower.slice(3))) state.origin = lower.slice(3);
    else if (lower.startsWith("when:") && WHEN.test(lower.slice(5))) state.when = lower.slice(5);
    else words.push(token);
  }
  state.text = words.join(" ");
  return state;
}

// While typing, a finished `#topic` or `@name` token becomes its filter, but only when it names
// a value the current results really hold. A finished bare domain becomes a site filter.
// Anything else stays as words.
export function absorbTokens(state: LinkQueryState, facets: LinkFacets): LinkQueryState {
  if (!/\s$/.test(state.text) || !/(^|\s)([#@]\S|[a-z0-9-]+\.[a-z]{2,})/i.test(state.text)) return state;
  const next: LinkQueryState = { ...state, topics: [...state.topics] };
  const kept: string[] = [];
  for (const token of state.text.trim().split(/\s+/)) {
    const value = token.slice(1).toLowerCase();
    if (token.startsWith("#") && facets.topics.some((facet) => facet.value === value)) {
      if (!next.topics.includes(value)) next.topics.push(value);
    } else if (token.startsWith("@") && value) {
      const exact = facets.sharers.filter((facet) => facet.value.toLowerCase() === value);
      const starts = facets.sharers.filter((facet) => facet.value.toLowerCase().split(/\s+/).some((part) => part.startsWith(value)));
      const found = exact[0] ?? (starts.length === 1 ? starts[0] : undefined);
      if (found) next.sharer = found.value; else kept.push(token);
    } else if (SITE.test(token.toLowerCase()) && /\.[a-z]{2,}$/i.test(token)) next.site = token.toLowerCase().replace(/^www\./, "");
    else kept.push(token);
  }
  next.text = kept.length ? `${kept.join(" ")} ` : "";
  return next;
}

// What the list and its suggestions ask the server for. `channel` narrows to one channel's view.
export function requestParams(state: LinkQueryState, channel: string): URLSearchParams {
  const params = new URLSearchParams();
  const words = state.text.trim();
  if (words) params.set("q", words.replace(/(^|\s)[#@](?=\S)/g, "$1"));
  for (const topic of state.topics) params.append("topic", topic);
  if (state.sharer) params.set("sharer", state.sharer);
  if (state.source) params.set("source", state.source);
  if (state.site) params.set("site", state.site);
  if (state.origin) params.set("origin", state.origin);
  if (state.when) params.set("when", state.when);
  if (channel) params.set("channel", channel);
  return params;
}

const token = (kind: FilterKind, value: string): FilterToken => ({ key: `${kind}:${value.toLowerCase()}`, kind, value, label: filterLabel(kind, value) });

// The filters that are on, in the order they show under the search field.
export function activeFilters(state: LinkFilters): FilterToken[] {
  return [
    ...state.topics.map((topic) => token("topic", topic)),
    ...(state.source ? [token("source", state.source)] : []),
    ...(state.site ? [token("site", state.site)] : []),
    ...(state.sharer ? [token("sharer", state.sharer)] : []),
    ...(state.when ? [token("when", state.when)] : []),
    ...(state.origin ? [token("origin", state.origin)] : []),
  ];
}

export function filterIsOn(state: LinkFilters, kind: FilterKind, value: string): boolean {
  if (kind === "topic") return state.topics.includes(value);
  if (kind === "sharer") return state.sharer.toLowerCase() === value.toLowerCase();
  const current = kind === "source" ? state.source : kind === "origin" ? state.origin : kind === "site" ? state.site : state.when;
  return current === value;
}

// Turning a filter on or off. Topics add up; the other kinds hold one value at a time.
export function toggleFilter(state: LinkQueryState, kind: FilterKind, value: string): LinkQueryState {
  const next: LinkQueryState = { ...state, topics: [...state.topics] };
  const on = filterIsOn(state, kind, value);
  if (kind === "topic") next.topics = on ? next.topics.filter((topic) => topic !== value) : [...next.topics, value].slice(0, 6);
  else if (kind === "sharer") next.sharer = on ? "" : value;
  else if (kind === "source") next.source = on ? "" : value;
  else if (kind === "origin") next.origin = on ? "" : value;
  else if (kind === "site") next.site = on ? "" : value;
  else next.when = on ? "" : value;
  return next;
}

// Backspace in an empty field removes the filter that shows last under it.
export function dropLastFilter(state: LinkQueryState): LinkQueryState {
  const next: LinkQueryState = { ...state, topics: [...state.topics] };
  const last = activeFilters(state).pop();
  return last ? toggleFilter(next, last.kind, last.value) : next;
}

export function placeholderFor(libraryTotal: number, loaded: boolean): string {
  if (!loaded || !libraryTotal) return "Search links, or paste one to add";
  return `Search ${libraryTotal.toLocaleString("en-US")} ${libraryTotal === 1 ? "link" : "links"}, or paste one to add`;
}

// The groups of the filter column, in their fixed order. Entries keep the order the server gave
// (by count) for as long as the query stands, so nothing moves while someone reads.
export interface FilterEntry { key: string; kind: FilterKind; value: string; label: string; count: number }
export interface FilterGroup { id: string; title: string; kind: FilterKind; entries: FilterEntry[]; short: number }
export function filterGroups(facets: LinkFacets): FilterGroup[] {
  const entries = (kind: FilterKind, list: Facet[]): FilterEntry[] => list.filter((facet) => facet.count > 0)
    .map((facet) => ({ key: `${kind}:${facet.value.toLowerCase()}`, kind, value: facet.value, label: kind === "topic" ? facet.value : filterLabel(kind, facet.value), count: facet.count }));
  const when = [{ value: "week", count: facets.week }, { value: "month", count: facets.month }, ...facets.years];
  return [
    { id: "topics", title: "Topics", kind: "topic" as const, entries: entries("topic", facets.topics), short: 8 },
    { id: "sources", title: "Sources", kind: "source" as const, entries: entries("source", facets.sources), short: 6 },
    { id: "people", title: "Shared by", kind: "sharer" as const, entries: entries("sharer", facets.sharers), short: 6 },
    { id: "when", title: "When", kind: "when" as const, entries: entries("when", when), short: 6 },
    { id: "from", title: "From", kind: "origin" as const, entries: entries("origin", facets.origins), short: 5 },
  ].filter((group) => group.entries.length);
}

// What a row shows, with rough data tidied at render time.
const URLISH = /^(https?:\/\/|www\.)\S+$/i;
export function readableAddress(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, "").replace(/[-_]+/g, " ").split("/").filter(Boolean).slice(-2).join(" › ");
    const host = parsed.hostname.replace(/^www\./, "");
    return path ? `${host} › ${path.length > 70 ? `${path.slice(0, 69)}…` : path}` : host;
  } catch { return url; }
}
export function displayTitle(link: { title: string; url: string }): string {
  const title = (link.title || "").trim();
  return !title || URLISH.test(title) || title === link.url ? readableAddress(link.url) : title;
}
export function displaySummary(link: { summary: string; title: string }): string {
  const summary = (link.summary || "").trim();
  if (!summary || /^(unavailable|n\/a|none|no (summary|description)( available)?)\.?$/i.test(summary) || summary === (link.title || "").trim()) return "";
  return summary;
}
// An X post is a post: the person who wrote it, from the address.
export function postAuthor(link: { url: string; source: string; author?: string }): string {
  if (link.source !== "x") return "";
  try {
    const handle = new URL(link.url).pathname.split("/").filter(Boolean)[0] || "";
    if (/^[A-Za-z0-9_]{1,15}$/.test(handle) && !["i", "home", "search", "hashtag"].includes(handle.toLowerCase())) return `@${handle}`;
  } catch { /* fall through */ }
  return link.author ? `@${link.author.replace(/^@/, "")}` : "";
}

// Day headings for a newest-first list: Today, Yesterday, then dates.
export function dayHeading(at: number, now: number): string {
  const day = (value: number) => { const date = new Date(value); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); };
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const date = new Date(at);
  const sameYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

// A topic as it is stored: lower case, words joined by hyphens, letters and digits only. The
// server applies the same rule.
export function normalizeTopic(raw: string): string {
  const topic = raw.toLowerCase().trim().replace(/^#+/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return TOPIC.test(topic) ? topic : "";
}

// The type-ahead for adding a topic to a link: existing topics that match what is typed, ones
// that start with it first, and "Create" last and only when nothing has that exact name.
export interface TopicOption { value: string; label: string; count: number; create: boolean }
export function topicOptions(all: Facet[], onLink: string[], typed: string, limit = 7): TopicOption[] {
  const word = normalizeTopic(typed);
  const free = all.filter((facet) => !onLink.includes(facet.value));
  const starts = word ? free.filter((facet) => facet.value.startsWith(word)) : free;
  const holds = word ? free.filter((facet) => !facet.value.startsWith(word) && facet.value.includes(word)) : [];
  const options: TopicOption[] = [...starts, ...holds].slice(0, limit).map((facet) => ({ value: facet.value, label: `#${facet.value}`, count: facet.count, create: false }));
  const exists = all.some((facet) => facet.value === word) || onLink.includes(word);
  if (word.length >= 2 && !exists) options.push({ value: word, label: `Create #${word}`, count: 0, create: true });
  return options;
}

// A busy day folds: a day with more than five links shows five and keeps the rest behind one
// control. Nothing folds while a search or a filter is on.
export const FOLD_SHOWN = 5;
export function foldDay<T>(rows: T[], folding: boolean, expanded: boolean): { shown: T[]; hidden: number } {
  if (!folding || expanded || rows.length <= FOLD_SHOWN) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, FOLD_SHOWN), hidden: rows.length - FOLD_SHOWN };
}
// "8 more from Monday": the weekday inside the last week, otherwise the date.
export function foldLabel(hidden: number, at: number, now: number): string {
  const heading = dayHeading(at, now);
  const day = (value: number) => { const date = new Date(value); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); };
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  const from = heading === "Today" ? "today" : heading === "Yesterday" ? "yesterday"
    : days < 7 ? new Date(at).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }) : heading;
  return `${hidden} more from ${from}`;
}

// Where "You were last here" goes in a newest-first list: before the first link that is not
// newer than the read position. -1 when there is no position, nothing new, or nothing old yet.
export function lastHereIndex(rows: { firstSharedAt: number }[], marker: number | undefined): number {
  if (!marker || !Number.isFinite(marker)) return -1;
  const index = rows.findIndex((row) => row.firstSharedAt <= marker);
  return index > 0 ? index : -1;
}

// An X link drawn as a quoted post. `linked` is set when the post mainly shares another page:
// the row then leads with that page, and the post stays one click away through "on X".
export interface PostData { text: string; name: string; handle: string; linkedUrl: string; linkedTitle: string }
export interface QuotedPost { handle: string; text: string; postUrl: string; linked: { url: string; title: string; host: string } | null }
export function quotedPost(link: { url: string; source: string; title: string; summary: string; author?: string; post?: PostData | null }): QuotedPost | null {
  if (link.source !== "x") return null;
  const post = link.post || null;
  const handle = post?.handle ? `@${post.handle}` : postAuthor(link);
  // The post's own words when the feed gave them, otherwise the text the import came with.
  const text = (post?.text || displaySummary({ summary: link.summary, title: "" }) || displayTitle(link)).trim();
  let linked: QuotedPost["linked"] = null;
  if (post?.linkedUrl) {
    try {
      const target = new URL(post.linkedUrl);
      if (target.protocol === "https:" || target.protocol === "http:") {
        linked = { url: target.href, title: post.linkedTitle || readableAddress(target.href), host: target.hostname.replace(/^www\./, "") };
      }
    } catch { /* Not an address: the post stays the main link. */ }
  }
  return { handle: handle || "A post", text, postUrl: link.url, linked };
}

// The saved copy as the reader view draws it: blocks of plain text. Headings and list items are
// told apart by the `#` and `-` the server wrote; everything is shown as text, never as markup.
export interface ReaderBlock { kind: "h1" | "h2" | "h3" | "li" | "p"; text: string }
export function readerBlocks(text: string): ReaderBlock[] {
  return text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).map((block): ReaderBlock => {
    const heading = /^(#{1,3}) +(.+)$/s.exec(block);
    if (heading) return { kind: `h${heading[1]!.length}` as ReaderBlock["kind"], text: heading[2]! };
    const item = /^- +(.+)$/s.exec(block);
    return item ? { kind: "li", text: item[1]! } : { kind: "p", text: block };
  });
}
