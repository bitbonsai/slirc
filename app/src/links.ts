import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { enabledHelpers } from "./config.ts";
import { memberChannels } from "./rooms.ts";
import type { AddedLink } from "./links-digest.ts";

// The links library: one table behind the /links page, the `links` helper and auto-collect.
// A row is one link in one scope. Scope is '' for a link every member may see, or the name of the
// private channel it was collected in; text taken from a private message never leaves that row.
db.exec(`CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'web',
  topics TEXT NOT NULL DEFAULT '',
  origins TEXT NOT NULL DEFAULT '',
  first_shared_at INTEGER NOT NULL,
  last_shared_at INTEGER NOT NULL,
  share_count INTEGER NOT NULL DEFAULT 1,
  shared_by_name TEXT NOT NULL DEFAULT '',
  shared_by_account TEXT,
  enriched_at INTEGER,
  removed_at INTEGER,
  UNIQUE (url_key, scope)
)`);
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(title, summary, topics, author, host, content, tokenize = "unicode61 remove_diacritics 2", prefix = '2 3')`);
// A share already counted: a hash of an imported file row, or <msgid>:<url_key> from a channel.
db.exec("CREATE TABLE IF NOT EXISTS link_seen (key TEXT PRIMARY KEY)");
db.exec("CREATE TABLE IF NOT EXISTS link_model_counts (day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)");

export const SOURCES = ["x", "github", "youtube", "linkedin", "reddit", "hacker-news", "blog", "product", "docs", "news", "research", "web"] as const;
export const MODEL_SOURCES = ["blog", "product", "docs", "news", "research"] as const;
export const MAX_TOPICS = 4;
export const PAGE_SIZE = 50;
export const DAY_MS = 24 * 60 * 60_000;

// The library exists only where the `links` helper is switched on.
export const linksEnabled = () => enabledHelpers().includes("links");

export type LinkRow = {
  id: number; url: string; urlKey: string; scope: string; title: string; summary: string; author: string; source: string;
  topics: string[]; origins: string[]; firstSharedAt: number; lastSharedAt: number; shareCount: number;
  sharedByName: string; sharedByAccount: string | null; enrichedAt: number | null; removedAt: number | null;
  /** True once a preview image is stored for the row. */
  hasImage: boolean;
};
const list = (value: string) => value.split(" ").filter(Boolean);
// links-images.ts owns the table; it may not exist yet when a script imports this module alone.
function hasStoredImage(id: number): boolean {
  try { return !!db.query("SELECT 1 FROM link_images WHERE link_id = ? AND state = 'image'").get(id); } catch { return false; }
}
function dropStoredImages(where: string, ...args: (string | number)[]): void {
  for (const table of ["link_images", "link_posts", "link_copies"]) {
    try { db.query(`DELETE FROM ${table} WHERE link_id IN (SELECT id FROM links WHERE ${where})`).run(...args); } catch { /* No table yet: nothing stored. */ }
  }
}
function row(raw: any): LinkRow {
  return {
    id: raw.id, url: raw.url, urlKey: raw.url_key, scope: raw.scope, title: raw.title, summary: raw.summary, author: raw.author, source: raw.source,
    topics: list(raw.topics), origins: list(raw.origins), firstSharedAt: raw.first_shared_at, lastSharedAt: raw.last_shared_at, shareCount: raw.share_count,
    sharedByName: raw.shared_by_name, sharedByAccount: raw.shared_by_account, enrichedAt: raw.enriched_at, removedAt: raw.removed_at,
    hasImage: hasStoredImage(raw.id),
  };
}

const TRACKING = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;
const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);

// An http(s) URL without credentials, or null. Everything saved passes through here.
export function safeUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length > 2_000) return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname.includes(".")) return null;
  return url;
}

export function linkHost(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (X_HOSTS.has(host)) return "x.com";
  if (host === "m.youtube.com" || host === "music.youtube.com") return "youtube.com";
  return host;
}

// The URL in a comparable form: two shares with the same key are the same link. The scheme is
// left out, so the http and https addresses of a page are one link.
export function linkKey(raw: string): string | null {
  const url = safeUrl(raw);
  if (!url) return null;
  // A port that is not the scheme's own is part of the address: two services on one host are two links.
  let host = `${linkHost(url)}${url.port ? `:${url.port}` : ""}`;
  let path = url.pathname;
  const params = new URLSearchParams(url.search);
  if (host === "youtu.be" && path.length > 1) {
    params.set("v", path.slice(1).split("/")[0]);
    host = "youtube.com";
    path = "/watch";
  }
  for (const name of [...params.keys()]) {
    if (TRACKING.test(name) || (host === "x.com" && (name === "s" || name === "t")) || (host === "youtube.com" && (name === "si" || name === "feature"))) params.delete(name);
  }
  path = path.replace(/\/+$/, "");
  const query = params.toString();
  return `${host}${path}${query ? `?${query}` : ""}`;
}

const HOST_SOURCES: [RegExp, string][] = [
  [/^x\.com$/, "x"], [/(^|\.)github\.com$/, "github"], [/^(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)linkedin\.com$/, "linkedin"], [/(^|\.)reddit\.com$/, "reddit"], [/^news\.ycombinator\.com$/, "hacker-news"],
];
// The source code can tell from the host alone; null leaves the choice to the model.
export function hostSource(raw: string): string | null {
  const url = safeUrl(raw);
  if (!url) return null;
  const host = linkHost(url);
  return HOST_SOURCES.find(([pattern]) => pattern.test(host))?.[1] ?? null;
}

const TOPIC = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const cleanTopics = (topics: string[]) => [...new Set(topics.map((topic) => topic.trim().toLowerCase()).filter((topic) => TOPIC.test(topic)))];

// LINKS_TOPICS when set, otherwise the topics already on rows every member may see. Topics that
// exist only on private rows never shape what a new link can be tagged with.
export function allowedTopics(): string[] {
  const configured = cleanTopics((process.env.LINKS_TOPICS || "").split(","));
  if (configured.length) return configured;
  const rows = db.query("SELECT topics FROM links WHERE scope = '' AND removed_at IS NULL AND topics <> ''").all() as { topics: string }[];
  return [...new Set(rows.flatMap((item) => list(item.topics)))].sort();
}

// The saved copy's text, once copies exist. Indexed with the row so search reads the article too.
let savedText: (id: number) => string = () => "";
export function setSavedTextSource(source: (id: number) => string): void { savedText = source; }

export function writeFts(id: number): void {
  const link = db.query("SELECT url, title, summary, topics, author, removed_at FROM links WHERE id = ?").get(id) as any;
  db.query("DELETE FROM links_fts WHERE rowid = ?").run(id);
  if (!link || link.removed_at) return;
  const url = safeUrl(link.url);
  db.query("INSERT INTO links_fts (rowid, title, summary, topics, author, host, content) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, link.title, link.summary, link.topics, link.author, url ? linkHost(url) : "", savedText(id));
}

// Private channels the viewer belongs to, read at query time: leaving a channel hides its links
// on the next request.
function viewerScopes(nick: string): string[] {
  return memberChannels(nick).map((channel) => channel.toLowerCase());
}

// The one visibility rule. In the workspace-wide view a private row is also hidden when the same
// link has a row everyone can see, so a member of the private channel is shown that link once.
function visibleSql(scopes: string[], dedupe = true): string {
  const marks = scopes.map(() => "?").join(",");
  const shared = dedupe ? " AND NOT EXISTS (SELECT 1 FROM links shared WHERE shared.url_key = links.url_key AND shared.scope = '' AND shared.removed_at IS NULL)" : "";
  const scoped = scopes.length ? `links.scope IN (${marks})${shared}` : "0";
  return `links.removed_at IS NULL AND (links.scope = '' OR (${scoped}))`;
}

// `channel` narrows to one channel's own view; the rest filter within whatever view that is.
export type LinkQuery = { q?: string; topics?: string[]; source?: string; origin?: string; sharer?: string; site?: string; channel?: string; from?: number; to?: number; offset?: number; limit?: number };
export type LinkResults = { rows: LinkRow[]; total: number; more: boolean };

// Search words as an FTS5 expression. Each word is reduced to letters and digits, quoted and given
// a prefix star, so nothing a person types is ever read as FTS5 syntax.
export function matchExpression(q: string, join: "AND" | "OR"): string {
  const tokens = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].slice(0, 8);
  return tokens.map((token) => `"${token}"*`).join(` ${join} `);
}

const WORD = /^[#a-z0-9][a-z0-9_.-]{0,63}$/i;
const wordLike = (column: string) => `(' ' || links.${column} || ' ') LIKE ?`;

// The rows a query selects for a viewer, as SQL pieces the search and the facets both run. Null
// means the query can match nothing.
function selection(viewer: string, query: LinkQuery): { from: string; filter: string; args: (string | number)[]; ranked: boolean } | null {
  const scopes = viewerScopes(viewer);
  const channel = (query.channel || "").toLowerCase();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (channel) {
    // One channel's view: honoured only for a channel the viewer is in. Its own rows always show,
    // so the workspace-wide duplicate rule is off here.
    if (!WORD.test(channel) || !scopes.includes(channel)) return null;
    where.push(visibleSql(scopes, false), `(links.scope = ? OR (links.scope = '' AND ${wordLike("origins")}))`);
    args.push(...scopes, channel, `% ${channel} %`);
  } else {
    where.push(visibleSql(scopes));
    args.push(...scopes);
  }
  // Topics and origins are space-separated words; padding both sides matches a whole word.
  for (const topic of query.topics || []) {
    if (!WORD.test(topic)) return null;
    where.push(wordLike("topics"));
    args.push(`% ${topic.toLowerCase()} %`);
  }
  if (query.origin) {
    if (!WORD.test(query.origin)) return null;
    where.push(wordLike("origins"));
    args.push(`% ${query.origin.toLowerCase()} %`);
  }
  if (query.source) { where.push("links.source = ?"); args.push(query.source); }
  if (query.sharer) { where.push("links.shared_by_name = ? COLLATE NOCASE"); args.push(query.sharer); }
  if (query.site) {
    // One host's links. The key starts with the host, so no pattern characters can come from it.
    const site = query.site.toLowerCase().replace(/^www\./, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) return null;
    where.push("(links.url_key = ? OR links.url_key LIKE ? OR links.url_key LIKE ?)");
    args.push(site, `${site}/%`, `${site}?%`);
  }
  if (Number.isFinite(query.from)) { where.push("links.first_shared_at >= ?"); args.push(query.from!); }
  if (Number.isFinite(query.to)) { where.push("links.first_shared_at < ?"); args.push(query.to!); }
  const plain = { from: "links", filter: where.join(" AND "), args, ranked: false };
  const words = matchExpression(query.q || "", "AND");
  if (!words) return query.q?.trim() ? null : plain;
  const matched = (match: string) => ({ from: "links_fts JOIN links ON links.id = links_fts.rowid", filter: `links_fts MATCH ? AND ${where.join(" AND ")}`, args: [match, ...args], ranked: true });
  const all = matched(words);
  if (!words.includes(" AND ")) return all;
  // Nothing holds every word: fall back to any of them.
  const found = db.query(`SELECT 1 FROM ${all.from} WHERE ${all.filter} LIMIT 1`).get(...all.args);
  return found ? all : matched(matchExpression(query.q || "", "OR"));
}

export function searchLinks(viewer: string, query: LinkQuery = {}): LinkResults {
  const chosen = selection(viewer, query);
  if (!chosen) return { rows: [], total: 0, more: false };
  const limit = Math.min(Math.max(1, query.limit ?? PAGE_SIZE), 100);
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  // Title counts most, then topics, then summary, and the saved text least; a tie goes to the newer link.
  const order = chosen.ranked ? "bm25(links_fts, 10.0, 3.0, 5.0, 2.0, 1.0, 0.5), links.first_shared_at DESC" : "links.first_shared_at DESC, links.id DESC";
  const total = (db.query(`SELECT COUNT(*) AS total FROM ${chosen.from} WHERE ${chosen.filter}`).get(...chosen.args) as { total: number }).total;
  const rows = db.query(`SELECT links.* FROM ${chosen.from} WHERE ${chosen.filter} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...chosen.args, limit, offset) as any[];
  return { rows: rows.map(row), total, more: offset + rows.length < total };
}

export type Facet = { value: string; count: number };
export type Facets = { total: number; topics: Facet[]; sources: Facet[]; origins: Facet[]; sharers: Facet[]; years: Facet[]; week: number; month: number };

// Filter values and their counts for a query, from the rows it selects for this viewer and
// nothing else: a private channel's name, topics, people and numbers never reach someone outside
// it. Counting within the current results means a suggested filter can never lead to an empty list.
// Facets for a filter column. A group where one value is chosen at a time (source, sharer, origin,
// date) is counted without its own filter, so the other values stay on offer to switch to.
// Topics narrow together, so they are counted inside the full query.
export function linkFilterFacets(viewer: string, query: LinkQuery = {}, now = Date.now()): Facets {
  const base = linkFacets(viewer, query, now);
  const without = (change: Partial<LinkQuery>) => linkFacets(viewer, { ...query, ...change }, now);
  const dates = query.from !== undefined || query.to !== undefined ? without({ from: undefined, to: undefined }) : base;
  return {
    ...base,
    sources: query.source ? without({ source: "" }).sources : base.sources,
    sharers: query.sharer ? without({ sharer: "" }).sharers : base.sharers,
    origins: query.origin ? without({ origin: "" }).origins : base.origins,
    years: dates.years, week: dates.week, month: dates.month,
  };
}

export function linkFacets(viewer: string, query: LinkQuery = {}, now = Date.now()): Facets {
  const chosen = selection(viewer, query);
  const rows = chosen ? db.query(`SELECT links.topics, links.source, links.origins, links.shared_by_name, links.first_shared_at FROM ${chosen.from} WHERE ${chosen.filter}`).all(...chosen.args) as { topics: string; source: string; origins: string; shared_by_name: string; first_shared_at: number }[] : [];
  const count = (values: string[], fold = false) => {
    const counts = new Map<string, { value: string; count: number }>();
    for (const value of values) {
      if (!value) continue;
      const key = fold ? value.toLowerCase() : value;
      const entry = counts.get(key) || { value, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };
  return {
    total: rows.length,
    topics: count(rows.flatMap((item) => list(item.topics))),
    sources: count(rows.map((item) => item.source)),
    origins: count(rows.flatMap((item) => list(item.origins))),
    sharers: count(rows.map((item) => item.shared_by_name), true).slice(0, 200),
    years: count(rows.map((item) => String(new Date(item.first_shared_at).getUTCFullYear()))).sort((a, b) => Number(b.value) - Number(a.value)),
    week: rows.filter((item) => item.first_shared_at >= now - 7 * DAY_MS).length,
    month: rows.filter((item) => item.first_shared_at >= now - 30 * DAY_MS).length,
  };
}

export function visibleLink(viewer: string, id: number): LinkRow | null {
  const scopes = viewerScopes(viewer);
  const raw = db.query(`SELECT * FROM links WHERE id = ? AND ${visibleSql(scopes, false)}`).get(id, ...scopes);
  return raw ? row(raw) : null;
}

export function visibleLinkByKey(viewer: string, key: string): LinkRow | null {
  const scopes = viewerScopes(viewer);
  const raw = db.query(`SELECT * FROM links WHERE url_key = ? AND ${visibleSql(scopes)} ORDER BY scope = '' DESC LIMIT 1`).get(key, ...scopes);
  return raw ? row(raw) : null;
}

export const canRemoveLink = (viewer: { id: string; role: string }, link: Pick<LinkRow, "sharedByAccount">) =>
  viewer.role === "admin" || (!!link.sharedByAccount && link.sharedByAccount === viewer.id);

// Removal clears the text and keeps an emptied row, so auto-collect does not bring the link back
// the next time someone posts it. A link the viewer cannot see is "missing", like an unknown id.
export function removeLink(viewer: { id: string; nick: string; role: string }, id: number, now = Date.now()): "removed" | "missing" | "forbidden" {
  const link = visibleLink(viewer.nick, id);
  if (!link) return "missing";
  if (!canRemoveLink(viewer, link)) return "forbidden";
  db.transaction(() => {
    db.query("UPDATE links SET title = '', summary = '', author = '', topics = '', enriched_at = NULL, removed_at = ? WHERE id = ?").run(now, id);
    dropStoredImages("id = ?", id);
    writeFts(id);
  })();
  return "removed";
}

export type Share = {
  url: string; scope?: string; origin?: string; sharedAt: number; sharerName: string; sharerAccount?: string | null;
  title?: string; summary?: string; author?: string; source?: string; topics?: string[]; enriched?: boolean; count?: number;
};

const mergeWords = (current: string[], added: string[], limit = Infinity) => [...new Set([...current, ...added])].slice(0, limit).join(" ");

// Insert a link, or count a repeat share on the row that already holds it. A repeat keeps the
// first date and the first sharer; an earlier date (an import of older history) moves both back.
export function recordShare(share: Share): { id: number; created: boolean; removed: boolean } | null {
  const key = linkKey(share.url);
  if (!key) return null;
  const scope = (share.scope || "").toLowerCase();
  const count = Math.max(1, share.count ?? 1);
  const origins = share.origin ? [share.origin.toLowerCase()] : [];
  return db.transaction(() => {
    const existing = db.query("SELECT * FROM links WHERE url_key = ? AND scope = ?").get(key, scope) as any;
    if (!existing) {
      const id = Number(db.query(`INSERT INTO links (url, url_key, scope, title, summary, author, source, topics, origins, first_shared_at, last_shared_at, share_count, shared_by_name, shared_by_account, enriched_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(share.url.trim(), key, scope, share.title || "", share.summary || "", share.author || "", share.source || hostSource(share.url) || "web",
          cleanTopics(share.topics || []).slice(0, MAX_TOPICS).join(" "), origins.join(" "), share.sharedAt, share.sharedAt, count, share.sharerName, share.sharerAccount ?? null,
          share.enriched ? Date.now() : null).lastInsertRowid);
      writeFts(id);
      return { id, created: true, removed: false };
    }
    if (existing.removed_at) return { id: existing.id as number, created: false, removed: true };
    const earlier = share.sharedAt < existing.first_shared_at;
    db.query("UPDATE links SET share_count = share_count + ?, first_shared_at = ?, last_shared_at = ?, origins = ?, shared_by_name = ?, shared_by_account = ? WHERE id = ?")
      .run(count, Math.min(existing.first_shared_at, share.sharedAt), Math.max(existing.last_shared_at, share.sharedAt), mergeWords(list(existing.origins), origins),
        earlier ? share.sharerName : existing.shared_by_name, earlier ? share.sharerAccount ?? null : existing.shared_by_account, existing.id);
    return { id: existing.id as number, created: false, removed: false };
  })();
}

// True the first time a key is seen. Saving is idempotent through this.
export function markSeen(key: string): boolean {
  return db.query("INSERT INTO link_seen (key) VALUES (?) ON CONFLICT DO NOTHING").run(key).changes > 0;
}
export const wasSeen = (key: string) => !!db.query("SELECT 1 FROM link_seen WHERE key = ?").get(key);

export function linkById(id: number): LinkRow | null {
  const raw = db.query("SELECT * FROM links WHERE id = ?").get(id);
  return raw ? row(raw) : null;
}

// Fill in what a fetch or the model found. Also how a removed link comes back when someone
// sends it to the helper again.
export function describeLink(id: number, fields: { title?: string; summary?: string; author?: string; source?: string; topics?: string[]; enriched?: boolean; restore?: { sharedAt: number; sharerName: string; sharerAccount: string | null; origin?: string } }): void {
  db.transaction(() => {
    const current = db.query("SELECT * FROM links WHERE id = ?").get(id) as any;
    if (!current) return;
    const restore = fields.restore;
    db.query(`UPDATE links SET title = ?, summary = ?, author = ?, source = ?, topics = ?, enriched_at = ?, removed_at = ?, first_shared_at = ?, last_shared_at = ?, share_count = ?, shared_by_name = ?, shared_by_account = ?, origins = ? WHERE id = ?`)
      .run(fields.title ?? current.title, fields.summary ?? current.summary, fields.author ?? current.author, fields.source ?? current.source,
        fields.topics ? cleanTopics(fields.topics).slice(0, MAX_TOPICS).join(" ") : current.topics,
        fields.enriched ? Date.now() : fields.enriched === false ? null : current.enriched_at,
        restore ? null : current.removed_at,
        restore ? restore.sharedAt : current.first_shared_at, restore ? restore.sharedAt : current.last_shared_at, restore ? 1 : current.share_count,
        restore ? restore.sharerName : current.shared_by_name, restore ? restore.sharerAccount : current.shared_by_account,
        restore ? (restore.origin || "") : current.origins, id);
    writeFts(id);
  })();
}

// Rows scoped to a channel go when the channel does.
export function deleteScopedLinks(channel: string): number {
  const scope = channel.toLowerCase();
  if (!scope) return 0;
  return db.transaction(() => {
    db.query("DELETE FROM links_fts WHERE rowid IN (SELECT id FROM links WHERE scope = ?)").run(scope);
    db.query("DELETE FROM link_topic_edits WHERE link_id IN (SELECT id FROM links WHERE scope = ?)").run(scope);
    dropStoredImages("scope = ?", scope);
    return db.query("DELETE FROM links WHERE scope = ?").run(scope).changes;
  })();
}

// Topics are curated by hand as well. Any member who can see a link may add or remove a topic
// on it; each change is recorded with who made it and when, so a bad edit can be traced.
db.exec(`CREATE TABLE IF NOT EXISTS link_topic_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  nick TEXT NOT NULL,
  action TEXT NOT NULL,
  topic TEXT NOT NULL,
  at INTEGER NOT NULL
)`);
export const MAX_EDITED_TOPICS = 8;

// A topic as it is stored: lower case, words joined by hyphens, letters and digits only.
export function normalizeTopic(raw: string): string {
  const topic = String(raw || "").toLowerCase().trim().replace(/^#+/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return TOPIC.test(topic) ? topic : "";
}

export type TopicEdit = { link: LinkRow } | { error: "missing" | "invalid" | "full" };
// One change to one link's topics. The visibility rule comes first: a link in a private channel
// can be edited only by that channel's members, and to anyone else it does not exist.
export function editLinkTopic(viewer: { id: string; nick: string }, id: number, action: "add" | "remove", raw: string, now = Date.now()): TopicEdit {
  const link = visibleLink(viewer.nick, id);
  if (!link) return { error: "missing" };
  const topic = normalizeTopic(raw);
  if (!topic) return { error: "invalid" };
  const has = link.topics.includes(topic);
  if (action === "add" && !has && link.topics.length >= MAX_EDITED_TOPICS) return { error: "full" };
  if ((action === "add") !== has) {
    const topics = action === "add" ? [...link.topics, topic] : link.topics.filter((item) => item !== topic);
    db.transaction(() => {
      db.query("UPDATE links SET topics = ? WHERE id = ?").run(topics.join(" "), id);
      db.query("INSERT INTO link_topic_edits (link_id, account_id, nick, action, topic, at) VALUES (?, ?, ?, ?, ?, ?)").run(id, viewer.id, viewer.nick, action, topic, now);
      writeFts(id);
    })();
  }
  return { link: visibleLink(viewer.nick, id)! };
}

// A renamed channel takes its links along, so the old name never points at them again.
export function renameLinksChannel(from: string, to: string): void {
  const before = from.toLowerCase();
  const after = to.toLowerCase();
  db.query("UPDATE OR IGNORE links SET scope = ? WHERE scope = ?").run(after, before);
  db.query("DELETE FROM links_fts WHERE rowid IN (SELECT id FROM links WHERE scope = ?)").run(before);
  db.query("DELETE FROM links WHERE scope = ?").run(before);
  const rows = db.query("SELECT id, origins FROM links WHERE (' ' || origins || ' ') LIKE ?").all(`% ${before} %`) as { id: number; origins: string }[];
  for (const item of rows) db.query("UPDATE links SET origins = ? WHERE id = ?").run([...new Set(list(item.origins).map((origin) => (origin === before ? after : origin)))].join(" "), item.id);
}

// A site's icon, fetched once and kept. `body` null records a host that gave none, so it is not
// asked again for a while.
db.exec("CREATE TABLE IF NOT EXISTS link_favicons (host TEXT PRIMARY KEY, mime TEXT, body BLOB, fetched_at INTEGER NOT NULL)");
export type Favicon = { mime: string | null; body: Uint8Array | null; fetchedAt: number };
export function storedFavicon(host: string): Favicon | null {
  const raw = db.query("SELECT mime, body, fetched_at FROM link_favicons WHERE host = ?").get(host) as { mime: string | null; body: Uint8Array | null; fetched_at: number } | null;
  return raw ? { mime: raw.mime, body: raw.body, fetchedAt: raw.fetched_at } : null;
}
export function storeFavicon(host: string, mime: string | null, body: Uint8Array | null, now = Date.now()): void {
  db.query("INSERT INTO link_favicons (host, mime, body, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(host) DO UPDATE SET mime = excluded.mime, body = excluded.body, fetched_at = excluded.fetched_at")
    .run(host, mime, body, now);
}
// Does this viewer have a link on that host? An icon is fetched only for a host they can already see.
export function viewerHasSite(viewer: string, host: string): boolean {
  const chosen = selection(viewer, { site: host });
  return !!chosen && !!db.query(`SELECT 1 FROM ${chosen.from} WHERE ${chosen.filter} LIMIT 1`).get(...chosen.args);
}

// Model calls for summaries and search terms, per UTC day, in the style of the mail counter.
const modelDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export function modelCallCap(): number {
  const value = Number(process.env.LINKS_DAILY_MODEL_CALLS);
  return Number.isFinite(value) && value >= 0 && process.env.LINKS_DAILY_MODEL_CALLS?.trim() ? Math.floor(value) : 200;
}
export function modelCallsToday(now = Date.now()): number {
  return (db.query("SELECT count FROM link_model_counts WHERE day = ?").get(modelDay(now)) as { count: number } | null)?.count ?? 0;
}
// Takes one call from today's budget; false when the day is used up.
export function takeModelCall(now = Date.now(), log: (line: string) => void = console.warn): boolean {
  const cap = modelCallCap();
  if (modelCallsToday(now) >= cap) return false;
  db.query("INSERT INTO link_model_counts (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1").run(modelDay(now));
  if (modelCallsToday(now) === cap) log(`links: ${cap} model calls today (${modelDay(now)} UTC), the daily limit`);
  return true;
}

// Rows still waiting for a summary and topics, oldest first.
export function unenrichedLinks(limit = 5): LinkRow[] {
  return (db.query("SELECT * FROM links WHERE enriched_at IS NULL AND removed_at IS NULL ORDER BY first_shared_at ASC LIMIT ?").all(limit) as any[]).map(row);
}

export type ImportRow = { line: number; date: string; channel: string; title: string; link: string; summary: string; author: string; source: string; topics: string; shared_by: string };
export type ImportReport = { read: number; added: number; merged: number; skipped: { line: number; reason: string }[]; alreadyImported: number };

// The import. Rows with one link key become one row: the earliest date and its sharer, title and
// summary; share count is the number of rows; topics merged, most frequent first. Only the named
// columns are read, so a comment column in the file cannot be stored.
// `added`, when given, collects the links new to the library (dry run included), for the digest.
// The report itself stays counts only.
export function importLinks(rows: ImportRow[], options: { dryRun?: boolean; added?: AddedLink[] } = {}): ImportReport {
  const report: ImportReport = { read: rows.length, added: 0, merged: 0, skipped: [], alreadyImported: 0 };
  const groups = new Map<string, { item: ImportRow; at: number; hash: string }[]>();
  const hashes = new Set<string>();
  for (const item of rows) {
    const key = linkKey(item.link || "");
    const at = /^\d{4}-\d{2}-\d{2}$/.test(item.date || "") ? Date.parse(`${item.date}T12:00:00Z`) : NaN;
    if (!key) { report.skipped.push({ line: item.line, reason: "link is missing or not http(s)" }); continue; }
    if (!Number.isFinite(at)) { report.skipped.push({ line: item.line, reason: "date is not YYYY-MM-DD" }); continue; }
    if (!(item.title || "").trim()) { report.skipped.push({ line: item.line, reason: "title is empty" }); continue; }
    const hash = `import:${createHash("sha256").update([item.date, item.channel, item.link, item.shared_by, item.title].join("\n")).digest("hex").slice(0, 32)}`;
    if (hashes.has(hash)) { report.skipped.push({ line: item.line, reason: "same as an earlier row" }); continue; }
    hashes.add(hash);
    if (wasSeen(hash)) { report.alreadyImported++; continue; }
    groups.set(key, [...(groups.get(key) || []), { item, at, hash }]);
  }
  const apply = db.transaction(() => {
    for (const [key, group] of groups) {
      group.sort((a, b) => a.at - b.at);
      const first = group[0];
      const frequency = new Map<string, number>();
      for (const { item } of group) for (const topic of cleanTopics((item.topics || "").split(/\s+/))) frequency.set(topic, (frequency.get(topic) || 0) + 1);
      const topics = [...frequency].sort((a, b) => b[1] - a[1]).map(([topic]) => topic);
      const origins = [...new Set(group.map(({ item }) => item.channel.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-")).filter(Boolean))];
      const existing = db.query("SELECT id, removed_at, topics, origins FROM links WHERE url_key = ? AND scope = ''").get(key) as { id: number; removed_at: number | null; topics: string; origins: string } | null;
      // Every valid row is either the one that made a new link or folded into another.
      if (existing) report.merged += group.length; else { report.added++; report.merged += group.length - 1; }
      if (!existing) options.added?.push({ title: first.item.title.trim(), url: first.item.link.trim(), topics, shares: group.length, lastSharedAt: group[group.length - 1].at });
      if (options.dryRun) continue;
      for (const { hash } of group) markSeen(hash);
      if (existing?.removed_at) continue;
      const source = SOURCES.includes(first.item.source.trim().toLowerCase() as any) ? first.item.source.trim().toLowerCase() : hostSource(first.item.link) || "web";
      const saved = recordShare({
        url: first.item.link, sharedAt: first.at, sharerName: first.item.shared_by.trim(), sharerAccount: null, count: group.length,
        title: first.item.title.trim(), summary: first.item.summary.trim(), author: first.item.author.trim(), source, topics, enriched: true,
      });
      if (!saved) continue;
      const last = group[group.length - 1].at;
      const current = db.query("SELECT topics, origins, last_shared_at FROM links WHERE id = ?").get(saved.id) as { topics: string; origins: string; last_shared_at: number };
      db.query("UPDATE links SET origins = ?, topics = ?, last_shared_at = ? WHERE id = ?")
        .run(mergeWords(list(current.origins), origins), mergeWords(list(current.topics), topics, MAX_TOPICS), Math.max(current.last_shared_at, last), saved.id);
      writeFts(saved.id);
    }
  });
  apply();
  return report;
}

// A small CSV reader: quoted fields, doubled quotes and newlines inside quotes.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { record.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index++;
      record.push(field); field = "";
      if (record.length > 1 || record[0] !== "") rows.push(record);
      record = [];
    } else field += char;
  }
  if (field !== "" || record.length) { record.push(field); rows.push(record); }
  return rows;
}

export const IMPORT_COLUMNS = ["date", "channel", "title", "link", "summary", "author", "source", "topics", "shared_by"] as const;

// Columns are read by name. Anything else in the file, a comment column included, is dropped here.
export function importRowsFromCsv(text: string): ImportRow[] {
  const [header, ...records] = parseCsv(text);
  if (!header) return [];
  const names = header.map((name) => name.trim().toLowerCase());
  const missing = IMPORT_COLUMNS.filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`The file is missing columns: ${missing.join(", ")}`);
  const at = Object.fromEntries(IMPORT_COLUMNS.map((name) => [name, names.indexOf(name)])) as Record<(typeof IMPORT_COLUMNS)[number], number>;
  return records.map((record, index) => ({
    line: index + 2,
    ...(Object.fromEntries(IMPORT_COLUMNS.map((name) => [name, record[at[name]] ?? ""])) as Omit<ImportRow, "line">),
  }));
}
