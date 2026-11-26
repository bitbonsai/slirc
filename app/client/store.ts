// Nano Stores projections over ClientDatabase. A projection is a bounded, read-only view of
// committed records: it holds no authoritative writable map and every emission is a fresh
// database read. Alpine may still render a transient "saving" row of its own.
import Dexie, { liveQuery, type Subscription } from "dexie";
import { atom, type ReadableAtom } from "nanostores";
import type { ClientDatabase } from "./db.ts";
import { foldIdentifier, type CaseMapping, type Message } from "./model.ts";

export const CONFIRMED_LIMIT = 200;
// Rows shown above a linked message that is older than the newest window.
const AROUND_BEFORE = 50;

// Current reaction state for one conversation, keyed by target server msgid. Counts are derived
// only from committed live/history reaction records; there is no second writable map.
export interface ReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
  accounts: string[];
}

export type ReactionMap = Record<string, ReactionSummary[]>;

// Pending/failed delete state for a confirmed message, keyed by server msgid. A confirmed redact
// is not listed: the row is tombstoned and no longer renders.
export type RedactState = "queued" | "sending" | "uncertain" | "failed";
export type RedactMap = Record<string, { state: RedactState; operationId: string }>;

export interface ConversationView {
  conversationId: string | null;
  messages: Message[];
  reactions: ReactionMap;
  redactions: RedactMap;
  loading: boolean;
  error?: string;
}

function byTimeThenId(a: Message, b: Message): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function readReactions(db: ClientDatabase, conversationId: string): Promise<ReactionMap> {
  // ponytail: full-table filter; the reactions table is small and there is no single-column
  // index for it. Widen the schema only if a profile ever shows up.
  const rows = await db.reactions.filter((row) => row.conversationId === conversationId).toArray();
  const self = foldIdentifier(db.scope.account, db.scope.caseMapping);
  const byMessage = new Map<string, Map<string, { count: number; mine: boolean; accounts: string[] }>>();
  for (const row of rows) {
    if (row.active === false) continue;
    let byEmoji = byMessage.get(row.messageServerId);
    if (!byEmoji) byMessage.set(row.messageServerId, (byEmoji = new Map()));
    let bucket = byEmoji.get(row.emoji);
    if (!bucket) byEmoji.set(row.emoji, (bucket = { count: 0, mine: false, accounts: [] }));
    bucket.count += 1;
    bucket.accounts.push(row.account);
    if (!bucket.mine && foldIdentifier(row.account, db.scope.caseMapping) === self) bucket.mine = true;
  }
  const reactions: ReactionMap = {};
  for (const [messageServerId, byEmoji] of byMessage) {
    reactions[messageServerId] = [...byEmoji.entries()]
      .map(([emoji, bucket]) => ({ emoji, ...bucket }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  }
  return reactions;
}

// Reactions given before an edit stay on the edited message: each one shows under the newest text,
// once per person and emoji.
export function foldEditedReactions(reactions: ReactionMap, messages: readonly Message[], mapping?: CaseMapping): ReactionMap {
  const folded: ReactionMap = { ...reactions };
  for (const message of messages) {
    if (!message.serverId || !message.chain?.length) continue;
    const byEmoji = new Map<string, ReactionSummary>();
    for (const id of [...message.chain, message.serverId]) {
      for (const summary of reactions[id] ?? []) {
        const bucket = byEmoji.get(summary.emoji) ?? { emoji: summary.emoji, count: 0, mine: false, accounts: [] };
        for (const account of summary.accounts) {
          if (bucket.accounts.some((seen) => foldIdentifier(seen, mapping) === foldIdentifier(account, mapping))) continue;
          bucket.accounts.push(account);
          bucket.count += 1;
        }
        bucket.mine ||= summary.mine;
        byEmoji.set(summary.emoji, bucket);
      }
    }
    if (byEmoji.size) folded[message.serverId] = [...byEmoji.values()].sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  }
  return folded;
}

async function readConversation(db: ClientDatabase, conversationId: string, focusServerId?: string): Promise<Message[]> {
  // liveQuery reruns this on every committed change to messages, so pending rows appear when the
  // send transaction lands. Confirmed history is bounded; pending work is never evicted.
  const latest = await db.messages
    .where("[conversationId+time]")
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
    .reverse()
    .filter((message) => message.state === "confirmed" && !message.deleted)
    .limit(CONFIRMED_LIMIT)
    .toArray();
  // A deep link/thread-parent jump may target a root older than the newest window. Include one
  // bounded window around that root, some history before it and a page after (existing indexes
  // only); a missing or deleted root adds nothing, so deleted content is never resurrected.
  const confirmed = [...latest];
  // An edit sits at its original's time. One whose original is older than this window belongs to a
  // page not shown yet, so it stays out until that page is; it never lands at the bottom.
  let start = latest.length === CONFIRMED_LIMIT ? latest[latest.length - 1]!.time : undefined;
  if (focusServerId && !latest.some((message) => message.serverId === focusServerId)) {
    const root = await db.messages.where("[conversationId+serverId]").equals([conversationId, focusServerId]).first();
    if (root?.state === "confirmed" && !root.deleted) {
      const shown = (message: Message) => message.state === "confirmed" && !message.deleted;
      const before = await db.messages
        .where("[conversationId+time]")
        .between([conversationId, Dexie.minKey], [conversationId, root.time])
        .reverse()
        .filter(shown)
        .limit(AROUND_BEFORE)
        .toArray();
      const after = await db.messages
        .where("[conversationId+time]")
        .between([conversationId, root.time], [conversationId, Dexie.maxKey])
        .filter(shown)
        .limit(CONFIRMED_LIMIT)
        .toArray();
      for (const row of [...before, ...after]) if (!confirmed.some((message) => message.id === row.id)) confirmed.push(row);
      const first = before.at(-1)?.time ?? root.time;
      if (start && first < start) start = first;
    }
  }
  const pending = await db.messages
    .where("conversationId")
    .equals(conversationId)
    .filter((message) => message.state !== "confirmed" && !message.deleted)
    .toArray();
  // While an edit is on its way the original gives up its place to it, unless the send failed.
  const editing = new Set(pending.filter((message) => message.state !== "failed" && message.replaces).map((message) => message.replaces));
  const shown = confirmed.reverse().filter((message) => (!start || !message.at || message.at >= start) && !(message.serverId && editing.has(message.serverId)));
  return [...shown, ...pending].map(inPlace).sort(byTimeThenId);
}

// The view of an edit: placed and timed as its original, with its own time kept as `editedAt`.
function inPlace(message: Message): Message {
  if (!message.replaces) return message;
  return { ...message, time: message.at ?? message.time, editedAt: message.time };
}

async function readRedactions(db: ClientDatabase, conversationId: string): Promise<RedactMap> {
  // ponytail: bounded scan of this conversation's operations; add an index if it grows.
  const ops = await db.operations.where("conversationId").equals(conversationId).filter((op) => op.kind === "redact" || op.kind === "admin-redact").toArray();
  const redactions: RedactMap = {};
  for (const op of ops) {
    if (!op.redactId || op.state === "confirmed" || op.state === "saving") continue;
    redactions[op.redactId] = { state: op.state as RedactState, operationId: op.id };
  }
  return redactions;
}

export interface ConversationProjection {
  view: ReadableAtom<ConversationView>;
  select(conversationId: string | null, focusServerId?: string): void;
  dispose(): void;
}

// One projection tracks exactly one loaded conversation. Selecting a new conversation cancels the
// previous subscription, and a late result for an abandoned conversation is dropped rather than
// replacing the current selected view.
export function createConversationProjection(db: ClientDatabase): ConversationProjection {
  const view = atom<ConversationView>({ conversationId: null, messages: [], reactions: {}, redactions: {}, loading: false });
  let current: string | null = null;
  let generation = 0;
  let subscription: Subscription | undefined;

  function select(conversationId: string | null, focusServerId?: string): void {
    generation += 1;
    const mine = generation;
    current = conversationId;
    subscription?.unsubscribe();
    subscription = undefined;
    if (!conversationId) {
      view.set({ conversationId: null, messages: [], reactions: {}, redactions: {}, loading: false });
      return;
    }
    view.set({ conversationId, messages: [], reactions: {}, redactions: {}, loading: true });
    subscription = liveQuery(async () => {
      const messages = await readConversation(db, conversationId, focusServerId);
      return {
        messages,
        reactions: foldEditedReactions(await readReactions(db, conversationId), messages, db.scope.caseMapping),
        redactions: await readRedactions(db, conversationId),
      };
    }).subscribe({
      next: ({ messages, reactions, redactions }) => {
        if (mine !== generation || current !== conversationId) return;
        view.set({ conversationId, messages, reactions, redactions, loading: false });
      },
      error: (error) => {
        if (mine !== generation || current !== conversationId) return;
        view.set({
          conversationId,
          messages: [],
          reactions: {},
          redactions: {},
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  function dispose(): void {
    generation += 1;
    current = null;
    subscription?.unsubscribe();
    subscription = undefined;
  }

  return { view, select, dispose };
}

// --- Unread counts -------------------------------------------------------------------------------
// Counts are derived from committed rows after each conversation's read marker. A conversation
// with no marker yet counts nothing; the runtime seeds one after its first sync.
export type UnreadCounts = Record<string, number>;

export const EPOCH = new Date(0).toISOString();

// One confirmed, visible message from someone else. Edits replace an existing row, reactions live in
// their own table, and a multiline message is already one row.
export function countsAsUnread(message: Message, self: string, mapping?: CaseMapping): boolean {
  return message.state === "confirmed" && !message.deleted && !message.replaces && message.authorNick !== "HistServ"
    && foldIdentifier(message.authorAccount, mapping) !== self;
}

async function readUnreadCounts(db: ClientDatabase, countable: (message: Message) => boolean): Promise<UnreadCounts> {
  const mapping = db.scope.caseMapping;
  const self = foldIdentifier(db.scope.account, mapping);
  const counts: UnreadCounts = {};
  for (const { conversationId, time } of await db.readMarkers.toArray()) {
    const count = await db.messages
      .where("[conversationId+time]")
      .between([conversationId, time], [conversationId, Dexie.maxKey], false, true)
      .filter((message) => countsAsUnread(message, self, mapping) && countable(message))
      .count();
    if (count) counts[conversationId] = count;
  }
  return counts;
}

export interface UnreadProjection {
  counts: ReadableAtom<UnreadCounts>;
  dispose(): void;
}

// `countable` drops rows this person chose not to see (the daily G'day when it is off). Only the
// count changes; read markers still move by time, so other sessions stay in step.
export function createUnreadProjection(db: ClientDatabase, countable: (message: Message) => boolean = () => true): UnreadProjection {
  const counts = atom<UnreadCounts>({});
  let live = true;
  const subscription = liveQuery(() => readUnreadCounts(db, countable)).subscribe({
    next: (value) => { if (live) counts.set(value); },
    error: () => { /* keep the last counts; the next committed change retries */ },
  });
  return {
    counts,
    dispose: () => { live = false; subscription.unsubscribe(); },
  };
}

// The newest server-recorded time in a conversation: the only time a read marker may carry. A
// pending row has a client clock and is never used.
export async function newestServerTime(db: ClientDatabase, conversationId: string): Promise<string | undefined> {
  const newest = await db.messages
    .where("[conversationId+time]")
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
    .reverse()
    .filter((message) => message.state === "confirmed" && !!message.serverId)
    .first();
  return newest?.time;
}

export interface MarkReadState {
  visible: boolean;
  focused: boolean;
  onScreen: boolean;
  ready: boolean;
  pinned: boolean;
  newest?: string;
  marker?: string;
}

// Read means the reader can actually see the newest message: a foreground focused tab, the
// conversation on screen and synced, and the transcript scrolled to the bottom.
export function shouldMarkRead(state: MarkReadState): boolean {
  if (!state.visible || !state.focused || !state.onScreen || !state.ready || !state.pinned || !state.newest) return false;
  return !state.marker || Date.parse(state.newest) > Date.parse(state.marker);
}

// Where a conversation's first read marker starts when no session has one. Usually at the newest
// message, so a new device does not light up with all of history, and Ergo is told. Help's DM is
// the exception: its welcome arrives before the new member's first load, so when Ergo says nobody
// has read it, every line counts until the DM is opened.
export function firstReadMarker(input: { newest?: string; peer?: string; serverSaidNone: boolean }): { time: string; tellServer: boolean } {
  if (input.serverSaidNone && input.peer?.toLowerCase() === "help") return { time: EPOCH, tellServer: false };
  return { time: input.newest ?? EPOCH, tellServer: !!input.newest && input.serverSaidNone };
}

// The dock and tab badge: unread counts of conversations the sidebar lists, and nothing else, so a
// count left behind for a conversation that is gone can't keep a badge nobody can clear.
export function sidebarUnreadTotal(unread: Record<string, number>, listed: (id: string) => boolean, count: (id: string) => number): number {
  return Object.keys(unread).reduce((sum, id) => sum + (listed(id) ? count(id) : 0), 0);
}

export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}
