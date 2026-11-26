// The sidebar THREADS group: reply threads (IRCv3 +reply) this person started or replied to, newest
// activity first. The server index (/api/reply-threads) holds ids and times only; the root's text
// comes from this device's history, and the read position sits in the same readMarkers table the
// channel unread counts use, under a `reply:<root id>` key.
import type { ClientDatabase } from "./db.ts";
import { badgeText } from "./store.ts";

export interface ReplyThreadRow { rootId: string; channel: string; replies: number; lastAt: string; lastBy: string; others: string[] }

export interface ReplyThreadItem {
  rootId: string;
  channel: string;
  title: string;
  label: string;
  unread: number;
  lastAt: string;
  nick?: string;
}

export const REPLY_THREADS_SHOWN = 3;
// One marker with this id remembers when this device first listed threads. A thread with no marker of
// its own counts replies after that moment, so history from before the feature stays quiet.
const SEED_MARKER = "reply:";

export function replyThreadMarkerId(rootId: string): string { return `reply:${rootId}`; }

/** Replies from other people after the read position. */
export function replyThreadUnread(others: readonly string[], readAt: string | undefined): number {
  const since = Date.parse(readAt ?? "");
  if (!Number.isFinite(since)) return others.length;
  return others.filter((time) => Date.parse(time) > since).length;
}

/** First line of the root's text, trimmed to a sidebar row. A root that is only a link shows the page's title when known, else its host. */
export function replyThreadTitle(text: string | undefined, linkTitle?: (url: string) => string | undefined): string {
  const line = (text ?? "").split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  let clean = line.replace(/\s+/g, " ");
  if (!clean) return "Thread";
  const url = /^<?(https?:\/\/\S+?)>?$/i.exec(clean)?.[1];
  if (url) clean = linkTitle?.(url)?.replace(/\s+/g, " ").trim() || hostOf(url) || clean;
  return clean.length > 80 ? `${clean.slice(0, 79).trimEnd()}…` : clean;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function visibleReplyThreads<T>(items: readonly T[], expanded: boolean, limit = REPLY_THREADS_SHOWN): { shown: T[]; more: number } {
  if (expanded || items.length <= limit) return { shown: [...items], more: 0 };
  return { shown: items.slice(0, limit), more: items.length - limit };
}

export interface ReplyThreadConversation { conversationId: string; label: string; nick?: string }

export function createReplyThreadList(reactive: <T extends object>(value: T) => T, deps: {
  db: () => ClientDatabase | null;
  /** The conversation this channel belongs to for the signed-in person, or null when it is not authorized. */
  conversationFor: (channel: string) => ReplyThreadConversation | null;
  /** The reply thread open right now, if any. */
  openRootId: () => string;
  /** Show the channel or DM, then the thread. */
  show: (item: ReplyThreadItem) => void;
  /** The preview title for a link, when one has been fetched. */
  linkTitle?: (url: string) => string | undefined;
  fetcher?: typeof fetch;
}) {
  let epoch = 0;
  let rows: ReplyThreadRow[] = [];
  const state = reactive({
    items: [] as ReplyThreadItem[],
    listOpen: true,
    expanded: false,
    visible(): { shown: ReplyThreadItem[]; more: number } { return visibleReplyThreads(state.items, state.expanded); },
    unreadTotal(): number { return state.items.reduce((sum, item) => sum + item.unread, 0); },
    isActive(item: ReplyThreadItem): boolean { return !!deps.openRootId() && deps.openRootId() === item.rootId; },
    badge(count: number): string { return badgeText(count); },
    collapsible(): boolean { return state.expanded && state.items.length > REPLY_THREADS_SHOWN; },
    toggle(): void { state.listOpen = !state.listOpen; },
    toggleExpanded(): void { state.expanded = !state.expanded; },
    reset(): void { epoch += 1; rows = []; state.items = []; state.expanded = false; },
    /** The newest server answer wins; a stale one from before a sign-out or account switch is dropped. */
    async load(): Promise<void> {
      const mine = ++epoch;
      const db = deps.db();
      if (!db) return;
      try {
        const response = await (deps.fetcher ?? fetch)("/api/reply-threads", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json();
        if (mine !== epoch || deps.db() !== db) return;
        rows = Array.isArray(body?.threads) ? body.threads.filter(validRow) : [];
        await state.refresh();
      } catch { /* keep what is shown; the next event or reconnect retries */ }
    },
    /** Rebuild the rows from the last server answer, this device's history and its read markers. */
    async refresh(): Promise<void> {
      const mine = epoch;
      const db = deps.db();
      if (!db) return;
      if (!await db.readMarkers.get(SEED_MARKER)) await db.advanceReadMarker(SEED_MARKER, new Date().toISOString());
      const seed = (await db.readMarkers.get(SEED_MARKER))?.time;
      const items: ReplyThreadItem[] = [];
      for (const row of rows) {
        const conversation = deps.conversationFor(row.channel);
        if (!conversation) continue;
        const [root, marker] = await Promise.all([
          db.messages.where("[conversationId+serverId]").equals([conversation.conversationId, row.rootId]).first(),
          db.readMarkers.get(replyThreadMarkerId(row.rootId)),
        ]);
        // A thread open on screen is being read: its position moves with each refresh.
        const open = deps.openRootId() === row.rootId;
        if (open) await db.advanceReadMarker(replyThreadMarkerId(row.rootId), row.lastAt);
        items.push(item(row, conversation, replyThreadTitle(root?.text, deps.linkTitle), open ? 0 : replyThreadUnread(row.others, marker?.time ?? seed)));
      }
      if (mine === epoch && deps.db() === db) state.items = items;
    },
    async open(entry: ReplyThreadItem): Promise<void> {
      deps.show(entry);
      const db = deps.db();
      if (db && await db.advanceReadMarker(replyThreadMarkerId(entry.rootId), entry.lastAt)) await state.refresh();
    },
  });
  return state;
}

function item(row: ReplyThreadRow, conversation: ReplyThreadConversation, title: string, unread: number): ReplyThreadItem {
  return { rootId: row.rootId, channel: row.channel, title, label: conversation.label, unread, lastAt: row.lastAt, nick: conversation.nick };
}

function validRow(value: any): value is ReplyThreadRow {
  return !!value && typeof value.rootId === "string" && typeof value.channel === "string" && typeof value.lastAt === "string"
    && Array.isArray(value.others) && value.others.every((time: unknown) => typeof time === "string");
}
