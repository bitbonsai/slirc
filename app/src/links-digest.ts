// A short post about links an import added, for a channel people read every day. The importer
// queues it and the running `links` helper posts it, so a script never needs its own IRC
// connection. LINKS_DIGEST_CHANNEL names the channel; unset means no post.
//
// The helper only posts in that channel. It saves no links from it and gives it no Links view,
// unless the channel is also the links home.
import { db } from "./db.ts";
import { channelInfo, isOpenChannel, normalized } from "./rooms.ts";
import { grantChannelAccess } from "./grants.ts";
import { sanitizeLine } from "./irc.ts";

db.exec(`CREATE TABLE IF NOT EXISTS links_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  posted_at INTEGER
)`);

export type AddedLink = { title: string; url: string; topics: string[]; shares: number; lastSharedAt: number };

const SHOWN = 3;
const TITLE_MAX = 100;

// A Markdown link Slirc renders: brackets in the label would end it early, and a ")" or space in
// the URL would cut it short. IRC clients show the same text, which still reads.
const link = (label: string, url: string) => `[${label.replace(/\[/g, "(").replace(/\]/g, ")")}](${url.replace(/\)/g, "%29").replace(/ /g, "%20")})`;

export function digestChannel(): string {
  const name = normalized(process.env.LINKS_DIGEST_CHANNEL || "");
  return /^#[a-z][a-z0-9_-]{1,31}$/.test(name) ? name : "";
}

// A count, the most shared few, and where the rest are. Empty when nothing is new.
export function digestLines(added: AddedLink[], libraryUrl: string): string[] {
  if (!added.length) return [];
  const top = [...added].sort((a, b) => b.shares - a.shares || b.lastSharedAt - a.lastSharedAt).slice(0, SHOWN);
  const count = added.length === 1 ? "1 new link" : `${added.length} new links`;
  const lines = [`${count} from Slack today:`];
  for (const item of top) {
    const title = item.title.length > TITLE_MAX ? `${item.title.slice(0, TITLE_MAX - 1).trimEnd()}…` : item.title;
    const topics = item.topics.slice(0, 2).join(", ");
    lines.push(sanitizeLine(`• ${link(title, item.url)}${topics ? ` (${topics})` : ""}`));
  }
  lines.push(link(added.length > SHOWN ? `${added.length - SHOWN} more in the library` : "In the library", libraryUrl));
  return lines;
}

export function libraryUrl(home: string): string {
  const origin = (process.env.APP_ORIGIN || "").replace(/\/+$/, "");
  return `${origin}/${home}`;
}

export function queueDigest(lines: string[], now = Date.now()): boolean {
  const channel = digestChannel();
  if (!channel || !lines.length) return false;
  db.query("INSERT INTO links_digests (channel, body, created_at) VALUES (?, ?, ?)").run(channel, lines.join("\n"), now);
  return true;
}

// Posts waiting for a channel the helper has joined, stamped first so a dropped socket never
// posts one twice. A post older than a day is dropped: it would no longer say "today".
export function takeDigests(joined: Set<string>, now = Date.now()): { channel: string; body: string }[] {
  const rows = db.query("SELECT id, channel, body, created_at FROM links_digests WHERE posted_at IS NULL ORDER BY id").all() as { id: number; channel: string; body: string; created_at: number }[];
  const due: { channel: string; body: string }[] = [];
  for (const row of rows) {
    const stale = now - row.created_at > 24 * 60 * 60_000;
    if (!stale && !joined.has(row.channel)) continue;
    if (db.query("UPDATE links_digests SET posted_at = ? WHERE id = ? AND posted_at IS NULL").run(now, row.id).changes === 0) continue;
    if (!stale) due.push({ channel: row.channel, body: row.body });
  }
  return due;
}

// True for the channel the helper only posts in. The links home is never one.
export function postOnly(channel: string, home: string): boolean {
  const digest = digestChannel();
  return !!digest && normalized(channel) === digest && digest !== home;
}

// The helper joins the digest channel on its next sync. A private channel needs its invite
// exception first, the same one `/invite @links` would set.
export async function ensureDigestChannel(): Promise<void> {
  const channel = digestChannel();
  if (!channel) return;
  const info = channelInfo(channel);
  if (!info && !isOpenChannel(channel)) return;
  if (db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = 'links'").get(channel)) return;
  if (info && info.visibility !== "workspace" && !isOpenChannel(channel) && process.env.ERGO_API_MOCK !== "true") await grantChannelAccess(channel, "links");
  db.query("INSERT INTO channel_members (channel, nick) VALUES (?, 'links') ON CONFLICT DO NOTHING").run(channel);
}
