import { accountByNick, ircChannelExists, type Account } from "./accounts.ts";
import { db } from "./db.ts";
import { createChannel } from "./grants.ts";
import { describeLink, linkById, linkHost, linkKey, linksEnabled, markSeen, recordShare, safeUrl, wasSeen } from "./links.ts";
import { postOnly } from "./links-digest.ts";
import { describePage } from "./links-fetch.ts";
import { fetchLinkImage, saveCopyFromHtml } from "./links-images.ts";
import { createLimiter } from "./request-security.ts";
import { channelInfo, isOpenChannel, joinWorkspaceChannel, memberChannels, normalized } from "./rooms.ts";

// Saving links inside Slirc: the home channel, and what the `links` helper keeps from the
// channels it is in. Everything written here goes through recordShare in links.ts.

// The home channel is where every member browses the library. An ordinary channel: IRC clients
// see messages and a helper, nothing else.
export function linksHome(): string {
  const name = normalized(process.env.LINKS_CHANNEL || "#links");
  return /^#[a-z][a-z0-9_-]{1,31}$/.test(name) ? name : "#links";
}

// Make sure the home channel exists and the helper is in it. A channel that already exists keeps
// its owner and visibility; only the helper's membership is added.
export async function ensureLinksHome(): Promise<void> {
  if (!linksEnabled()) return;
  const channel = linksHome();
  if (!channelInfo(channel) && !isOpenChannel(channel)) {
    const owner = (db.query("SELECT nick FROM accounts WHERE kind = 'human' AND role = 'admin' ORDER BY created_at ASC LIMIT 1").get() as { nick: string } | null)?.nick;
    if (!owner) return;
    if (process.env.ERGO_API_MOCK !== "true" && !(await ircChannelExists(channel))) await createChannel(channel, owner, "workspace");
    db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES (?, ?, 'workspace', ?, ?) ON CONFLICT DO NOTHING")
      .run(channel, owner, "Links people share here. Post one to save it.", Date.now());
  }
  db.query("INSERT INTO channel_members (channel, nick) VALUES (?, 'links') ON CONFLICT DO NOTHING").run(channel);
}

// Each member is added to the home channel once, so it sits in their sidebar. Someone who leaves
// is not added again.
export function joinLinksHomeOnce(account: Pick<Account, "id" | "nick" | "kind" | "verifiedAt">): boolean {
  if (!linksEnabled() || account.kind !== "human" || !account.verifiedAt) return false;
  const channel = linksHome();
  if (isOpenChannel(channel) || channelInfo(channel)?.visibility !== "workspace") return false;
  const key = `links-home-joined:${account.id}`;
  if (db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING").run(key, channel).changes === 0) return false;
  return joinWorkspaceChannel(account.nick, channel);
}

// Channels this member is in that have the helper: the ones that offer a Links view.
export function linksChannelsFor(nick: string): string[] {
  if (!linksEnabled()) return [];
  const withHelper = new Set((db.query("SELECT channel FROM channel_members WHERE nick = 'links'").all() as { channel: string }[]).map((row) => row.channel.toLowerCase()));
  return memberChannels(nick).map((channel) => channel.toLowerCase()).filter((channel) => channel.startsWith("#") && withHelper.has(channel) && !/^#(dm|t)-/.test(channel) && !postOnly(channel, linksHome()));
}

const TRAILING = /[.,;:!?'"”’)\]}>]+$/;
// http(s) addresses in a message, in order, without the ones inside code. A closing bracket is
// kept when the address opened one, so a Wikipedia link survives.
export function extractUrls(text: string, limit = 5): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const found: string[] = [];
  for (const match of prose.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
    let url = match[0];
    for (;;) {
      const trimmed = url.replace(TRAILING, (tail) => (tail.startsWith(")") && (url.match(/\(/g)?.length || 0) >= (url.match(/\)/g)?.length || 0) ? tail : ""));
      if (trimmed === url) break;
      url = trimmed;
    }
    const safe = safeUrl(url);
    if (safe && !found.includes(safe.href)) found.push(safe.href);
    if (found.length >= limit) break;
  }
  return found;
}

const SKIP_HOSTS = /(^|\.)(giphy\.com|tenor\.com)$/;
function ownHost(): string {
  try { return new URL(process.env.APP_ORIGIN || `https://${process.env.APP_HOST || ""}`).hostname.toLowerCase(); } catch { return ""; }
}
// Links that are part of the conversation, not something to keep: this workspace's own pages and
// uploads, and GIFs.
export function collectable(raw: string): boolean {
  const url = safeUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return host !== ownHost() && !SKIP_HOSTS.test(host);
}

// The poster's words without the address: the title for hosts that give none, such as X.
export function messageTitle(message: string): string {
  const words = message.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
  return words.length > 200 ? `${words.slice(0, 199).trimEnd()}…` : words;
}
function addressTitle(raw: string): string {
  const url = safeUrl(raw)!;
  const path = decodeURIComponent(url.pathname.replace(/\/+$/, "")).slice(0, 80);
  return `${linkHost(url)}${path}`;
}

// New rows one person may cause in an hour, across channels and the helper's DM.
const newLinkLimit = createLimiter({ limit: 30, windowMs: 60 * 60_000 });
export const resetLinkLimits = () => newLinkLimit.reset();

export type SaveOutcome = { id: number; state: "saved" | "repeat" | "removed" | "limited" | "seen" | "invalid" };
export type SaveInput = { url: string; scope: string; origin: string; sharer: Pick<Account, "id" | "nick">; message?: string; sharedAt?: number; seenKey?: string; restore?: boolean; describe?: typeof describePage };

// The only way a row is written inside Slirc. A repeat share costs neither a fetch nor a model
// call. A new row is saved at once with the best title at hand; the page's own title and
// description follow from one guarded fetch.
export function saveLink(input: SaveInput): SaveOutcome {
  const key = linkKey(input.url);
  if (!key || !collectable(input.url)) return { id: 0, state: "invalid" };
  if (input.seenKey && wasSeen(input.seenKey)) return { id: 0, state: "seen" };
  const scope = input.scope.toLowerCase();
  const existing = db.query("SELECT id, removed_at FROM links WHERE url_key = ? AND scope = ?").get(key, scope) as { id: number; removed_at: number | null } | null;
  const sharedAt = input.sharedAt ?? Date.now();
  const title = messageTitle(input.message || "") || addressTitle(input.url);
  let id: number;
  if (existing && !existing.removed_at) {
    if (input.seenKey) markSeen(input.seenKey);
    recordShare({ url: input.url, scope, origin: input.origin, sharedAt, sharerName: input.sharer.nick, sharerAccount: input.sharer.id });
    return { id: existing.id, state: "repeat" };
  }
  if (existing && !input.restore) {
    // Removed on purpose: a channel post does not bring it back.
    if (input.seenKey) markSeen(input.seenKey);
    return { id: existing.id, state: "removed" };
  }
  if (!newLinkLimit.check(input.sharer.id)) return { id: 0, state: "limited" };
  if (input.seenKey) markSeen(input.seenKey);
  if (existing) {
    id = existing.id;
    describeLink(id, { title, summary: "", author: "", topics: [], enriched: false, restore: { sharedAt, sharerName: input.sharer.nick, sharerAccount: input.sharer.id, origin: input.origin.toLowerCase() } });
  } else {
    const saved = recordShare({ url: input.url, scope, origin: input.origin, sharedAt, sharerName: input.sharer.nick, sharerAccount: input.sharer.id, title });
    if (!saved) return { id: 0, state: "invalid" };
    id = saved.id;
  }
  void fillFromPage(id, input.url, input.message || "", input.describe ?? describePage);
  return { id, state: "saved" };
}

// X rarely gives a title, so the poster's own words stay. Elsewhere the page's title wins.
async function fillFromPage(id: number, url: string, message: string, describe: typeof describePage): Promise<void> {
  try {
    const page = await describe(url);
    const current = linkById(id);
    if (!page || !current || current.removedAt) return;
    const parsed = safeUrl(url);
    const own = messageTitle(message);
    const keepOwn = !!own && (!page.title || (parsed ? linkHost(parsed) === "x.com" : false));
    describeLink(id, { title: keepOwn ? own : page.title || current.title, summary: page.description || current.summary, author: page.site || current.author });
    // The page was just read, so its image address is at hand: the row gets its preview now.
    // Its text is kept from the same read, so the link survives its page going away.
    if (page.html) await saveCopyFromHtml(id, page.html, page.title || current.title);
    if (describe === describePage) await fetchLinkImage(id, { pageImage: page.image || undefined, pageRead: true });
  } catch (error) {
    // The host only: an address can carry something private.
    const host = safeUrl(url)?.hostname || "unknown host";
    console.error(`links: could not read ${host}:`, error instanceof Error ? error.message : error);
  }
}

// What the helper keeps from one channel message. Only a member's own message counts: other
// helpers, bots, agents and unknown nicks are ignored by the caller's account check and here.
export function collectFromMessage(input: { channel: string; nick: string; text: string; msgid?: string; time?: string; describe?: typeof describePage }): SaveOutcome[] {
  if (!linksEnabled()) return [];
  const channel = normalized(input.channel);
  if (!channel.startsWith("#") || /^#(dm|t)-/.test(channel) || postOnly(channel, linksHome())) return [];
  const sharer = accountByNick(input.nick);
  if (!sharer || sharer.kind !== "human") return [];
  const info = channelInfo(channel);
  if (info?.visibility === "direct") return [];
  // A channel every member can read saves for everyone. Anything else, a channel with no row
  // included, keeps its links to its own members.
  const open = isOpenChannel(channel) || info?.visibility === "workspace";
  const sharedAt = Date.parse(input.time || "") || Date.now();
  return extractUrls(input.text).map((url) => {
    const key = linkKey(url);
    return saveLink({
      url, scope: open ? "" : channel, origin: channel, sharer, message: input.text, sharedAt,
      seenKey: key ? `${input.msgid || `${channel}:${input.time || sharedAt}`}:${key}` : undefined, describe: input.describe,
    });
  });
}
