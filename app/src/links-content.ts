import { db } from "./db.ts";
import { storedFavicon, storeFavicon, writeFts } from "./links.ts";
import { COPY_MAX_CHARS } from "./links-fetch.ts";
import "./links-images.ts";

// Carrying fetched content from one instance to another: preview images, X posts, saved page
// text and site icons, with the recorded misses so they are not tried again. Records are keyed by the link's
// address and the site's host, never by row id, since ids differ between instances. Links kept
// for a private channel's members are left out, and so is every host that only they use: the
// file holds page images and public post text, and no member data.
export type ContentRecord =
  | { t: "image"; key: string; state: string; kind: string; mime: string | null; width: number | null; height: number | null; at: number; body: string | null }
  | { t: "post"; key: string; state: string; text: string; name: string; handle: string; linkedUrl: string; linkedTitle: string; at: number }
  | { t: "copy"; key: string; state: string; title: string; byline: string; text: string; at: number; goneAt: number | null }
  | { t: "icon"; host: string; mime: string | null; at: number; body: string | null };

const base64 = (bytes: Uint8Array | null) => (bytes ? Buffer.from(bytes).toString("base64") : null);
const PUBLIC = "links.scope = '' AND links.removed_at IS NULL";

export function* exportContent(): Generator<ContentRecord> {
  const images = db.query(`SELECT links.url_key AS key, i.state, i.kind, i.mime, i.width, i.height, i.fetched_at AS at, i.body
                           FROM link_images i JOIN links ON links.id = i.link_id WHERE ${PUBLIC} ORDER BY links.url_key`).iterate() as Iterable<any>;
  for (const row of images) yield { t: "image", key: row.key, state: row.state, kind: row.kind, mime: row.mime, width: row.width, height: row.height, at: row.at, body: base64(row.body) };
  const posts = db.query(`SELECT links.url_key AS key, p.state, p.text, p.name, p.handle, p.linked_url, p.linked_title, p.fetched_at AS at
                          FROM link_posts p JOIN links ON links.id = p.link_id WHERE ${PUBLIC} ORDER BY links.url_key`).iterate() as Iterable<any>;
  for (const row of posts) yield { t: "post", key: row.key, state: row.state, text: row.text, name: row.name, handle: row.handle, linkedUrl: row.linked_url, linkedTitle: row.linked_title, at: row.at };
  const copies = db.query(`SELECT links.url_key AS key, c.state, c.title, c.byline, c.text, c.saved_at AS at, c.gone_at
                           FROM link_copies c JOIN links ON links.id = c.link_id WHERE ${PUBLIC} ORDER BY links.url_key`).iterate() as Iterable<any>;
  for (const row of copies) yield { t: "copy", key: row.key, state: row.state, title: row.title, byline: row.byline, text: row.text, at: row.at, goneAt: row.gone_at };
  // A site's icon goes along only when a link everyone can see is on that site.
  const hosts = new Set<string>();
  for (const row of db.query(`SELECT url_key FROM links WHERE ${PUBLIC}`).iterate() as Iterable<{ url_key: string }>) hosts.add(row.url_key.split(/[/?]/, 1)[0]!);
  for (const row of db.query("SELECT host, mime, body, fetched_at AS at FROM link_favicons ORDER BY host").iterate() as Iterable<any>) {
    if (hosts.has(row.host)) yield { t: "icon", host: row.host, mime: row.mime, at: row.at, body: base64(row.body) };
  }
}

export type ContentReport = { read: number; images: number; posts: number; copies: number; icons: number; unknown: number; kept: number; bad: number };
const COPY_STATES = new Set(["text", "none", "blocked", "failed", "gone"]);
const STATES = new Set(["image", "none", "blocked", "failed"]);
const POST_STATES = new Set(["post", "gone", "blocked", "failed"]);
const IMAGE_TYPES = new Set(["image/webp"]);
const ICON_TYPES = new Set(["image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/jpeg", "image/gif", "image/webp"]);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
function bytes(value: unknown, max: number): Uint8Array | null {
  if (typeof value !== "string" || value.length > max * 1.4) return null;
  const decoded = new Uint8Array(Buffer.from(value, "base64"));
  return decoded.length && decoded.length <= max ? decoded : null;
}

// Fills in what this instance does not have. A link is matched by its address among the links
// everyone can see; one that already has something stored keeps it, so nothing newer is ever
// overwritten and a second run changes nothing. The file is read as untrusted: states, types
// and sizes are checked, and a record that fails is counted and skipped.
export function importContent(records: Iterable<unknown>): ContentReport {
  const report: ContentReport = { read: 0, images: 0, posts: 0, copies: 0, icons: 0, unknown: 0, kept: 0, bad: 0 };
  const linkId = db.query("SELECT id FROM links WHERE url_key = ? AND scope = '' AND removed_at IS NULL");
  const find = (key: unknown) => (typeof key === "string" ? (linkId.get(key) as { id: number } | null)?.id ?? 0 : 0);
  db.transaction(() => {
    for (const raw of records) {
      report.read++;
      const record = raw as any;
      if (!record || typeof record !== "object") { report.bad++; continue; }
      if (record.t === "image") {
        const body = record.state === "image" ? bytes(record.body, 400_000) : null;
        if (!STATES.has(record.state) || (record.state === "image" && (!body || !IMAGE_TYPES.has(record.mime)))) { report.bad++; continue; }
        const id = find(record.key);
        if (!id) { report.unknown++; continue; }
        const done = db.query("INSERT INTO link_images (link_id, state, mime, body, width, height, fetched_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(link_id) DO NOTHING")
          .run(id, record.state, body ? "image/webp" : null, body, Number(record.width) || null, Number(record.height) || null, Number(record.at) || Date.now(), record.kind === "avatar" ? "avatar" : "image").changes;
        if (done) report.images++; else report.kept++;
      } else if (record.t === "post") {
        if (!POST_STATES.has(record.state)) { report.bad++; continue; }
        const id = find(record.key);
        if (!id) { report.unknown++; continue; }
        const linked = text(record.linkedUrl, 2_000);
        const done = db.query("INSERT INTO link_posts (link_id, state, text, name, handle, linked_url, linked_title, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(link_id) DO NOTHING")
          .run(id, record.state, text(record.text, 1_200), text(record.name, 80), /^[A-Za-z0-9_]{1,15}$/.test(String(record.handle)) ? record.handle : "",
            /^https?:\/\//i.test(linked) ? linked : "", text(record.linkedTitle, 200), Number(record.at) || Date.now()).changes;
        if (done) { report.posts++; writeFts(id); } else report.kept++;
      } else if (record.t === "copy") {
        const body = text(record.text, COPY_MAX_CHARS + 1);
        if (!COPY_STATES.has(record.state) || (record.state === "text" && !body)) { report.bad++; continue; }
        const id = find(record.key);
        if (!id) { report.unknown++; continue; }
        const done = db.query("INSERT INTO link_copies (link_id, state, title, byline, text, saved_at, gone_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(link_id) DO NOTHING")
          .run(id, record.state, text(record.title, 300), text(record.byline, 120), record.state === "text" ? body : "", Number(record.at) || Date.now(), Number(record.goneAt) || null).changes;
        if (done) { report.copies++; if (record.state === "text") writeFts(id); } else report.kept++;
      } else if (record.t === "icon") {
        const host = text(record.host, 120).toLowerCase();
        const body = record.body === null ? null : bytes(record.body, 150_000);
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || (record.body !== null && (!body || !ICON_TYPES.has(record.mime)))) { report.bad++; continue; }
        if (storedFavicon(host)) { report.kept++; continue; }
        storeFavicon(host, body ? record.mime : null, body, Number(record.at) || Date.now());
        report.icons++;
      } else report.bad++;
    }
  })();
  return report;
}
