// Recovery sync: the layer that takes an authenticated socket, resolves the caller's complete
// authorized conversation list, JOINs each conversation, catches it up from the durable cursor, and
// only then publishes readiness. It owns no socket: the bridge injects `send` and feeds inbound
// bytes through `push`, which runs the batch assembler from ./irc.ts.
//
// Contract for the delivery lane (outbox.ts): readiness is read through `isReady(conversationId)`
// and the injected `onReady`/`onUnready` hooks. This module never imports outbox.ts, so there is no
// cycle between the two.
//
// Choices worth stating:
//   - The caller enumerates every authorized conversation. `CHATHISTORY TARGETS` is capped (50), so
//     it is not used for discovery; a 51st room must not be silently lost.
//   - A room resumes from its durable checkpoint by time (the stored msgid may have been deleted
//     since), then pages forward by the final applied server msgid, so equal timestamps cannot
//     skip inside one sync.
//   - A complete batch is applied with its checkpoint in one Dexie transaction (db.applyBatch). A
//     rejected page, a cycling cursor, or a thrown transaction leaves the room unready and its
//     checkpoint untouched. An empty complete batch is "caught up", never a failure.

import Dexie from "dexie";
import { isConcat, joinParts } from "../public/multiline.js";
import type { ClientDatabase } from "./db.ts";
import { AGENT_OFFLINE_TAG } from "@client/agent-offline.ts";
import { pollMark } from "@client/polls.ts";
import { jobsMark } from "@client/job-cards.ts";
import {
  foldIdentifier,
  type CompleteBatch,
  type Message,
  type ProtocolEvent,
  type SyncProgress,
} from "./model.ts";
import { BatchAssembler, type BatchItem, type IrcBatch, type IrcMessage } from "./irc.ts";

export interface AuthorizedConversation {
  /** Stable internal conversation id (see model.conversationId), never the wire target. */
  conversationId: string;
  /** IRC name the server owns: `#room`, `#dm-a-b`, `#t-...`. */
  wireTarget: string;
  kind?: "room" | "dm" | "thread";
}

export interface SyncHooks {
  onReady?(conversation: AuthorizedConversation): void;
  onUnready?(conversation: AuthorizedConversation): void;
  /** We were kicked from this conversation, for example because its thread was deleted. */
  onKicked?(conversation: AuthorizedConversation): void;
  onError?(conversation: AuthorizedConversation | undefined, error: Error): void;
  /** WHOIS replies for a lookup the page owns; numerics never map to a conversation. */
  onWhois?(message: IrcMessage): void;
  /** A live line for an authorized conversation, before it becomes a durable event. History replay
   *  never reaches this hook, so ephemeral signals like typing cannot come from a chathistory page. */
  onLive?(conversation: AuthorizedConversation, message: IrcMessage): void;
  /** Server read marker for an authorized conversation: a server time, or "" for `*` (none set). */
  onReadMarker?(conversation: AuthorizedConversation, timestamp: string): void;
  /** Ergo refused a REDACT this connection sent, for example a message the sender may not delete. */
  onRedactRefused?(msgid: string, reason: string): void;
}

export interface SyncOptions {
  db: ClientDatabase;
  send(line: string): boolean;
  hooks?: SyncHooks;
  /** Our authenticated nick, when the bridge knows it; self-JOIN/PART/KICK matching is stricter. */
  nick?: string;
  now?: () => Date;
  pageLimit?: number;
  maxPages?: number;
  msgidCursor?: boolean;
  /** Delay before NAMES-probing a JOIN that got no echo; 0 disables probing (tests). */
  namesProbeMs?: number;
}

/** The narrow readiness surface delivery may depend on. */
export interface ReadinessSource {
  isReady(conversationId: string): boolean;
}

export interface LoadOlderResult {
  loaded: number;
  hasMore: boolean;
}

interface OlderRequest {
  conversation: AuthorizedConversation;
  epoch: number;
  promise: Promise<LoadOlderResult>;
  resolve: (result: LoadOlderResult) => void;
  reject: (error: Error) => void;
}

interface Cursor {
  msgid?: string;
  timestamp?: string;
}

interface PendingRoom {
  conversation: AuthorizedConversation;
  epoch: number;
  joined: boolean;
  awaiting: boolean;
  pages: number;
  cursor?: Cursor;
  // The durable checkpoint this sync resumed from. If the first page does not contain it, the
  // server lost it (deleted, or history reset), so one LATEST page re-checks what the cache shows.
  resumedFrom?: string;
  verify?: "pending" | "sent";
  // msgids applied from live lines while a page was in flight; a page window never prunes them.
  live: Set<string>;
  // Ergo multiclient can leave a connection already in a channel, so its JOIN produces no echo.
  // A bounded NAMES probe confirms the self nick before history; see armProbe().
  probeTimer?: ReturnType<typeof setTimeout>;
  probes: number;
  // Callers of catchUp() waiting for this room's pages: true once they landed, false if dropped.
  waiters?: ((ok: boolean) => void)[];
}

function prefixNick(prefix?: string): string {
  if (!prefix) return "";
  const end = Math.min(
    prefix.indexOf("!") === -1 ? prefix.length : prefix.indexOf("!"),
    prefix.indexOf("@") === -1 ? prefix.length : prefix.indexOf("@"),
  );
  return prefix.slice(0, end);
}

function foldTarget(target: string): string {
  return foldIdentifier(target, "ascii");
}

export function buildJoinCommand(target: string): string {
  return `JOIN ${target}`;
}

// Ergo fakelag counts every line after the burst of 5 and then allows 2 a second, and JOIN has no
// command budget. On reconnect, always-on reattach has already joined every room, so one JOIN line
// per conversation was all no-ops that held MONITOR and CHATHISTORY behind them: 22 rooms took 8.5 s
// to show history. One comma-list JOIN per ~400 bytes stays inside the 512-byte IRC line limit.
export function buildJoinCommands(targets: string[], maxLength = 400): string[] {
  const lines: string[] = [];
  let line = "";
  for (const target of targets) {
    if (line && line.length + 1 + target.length > maxLength) {
      lines.push(line);
      line = "";
    }
    line = line ? `${line},${target}` : buildJoinCommand(target);
  }
  if (line) lines.push(line);
  return lines;
}

export function buildLatestCommand(target: string, limit: number): string {
  return `CHATHISTORY LATEST ${target} * ${limit}`;
}

export function buildAfterCommand(target: string, cursor: Cursor, limit: number): string {
  const anchor = cursor.msgid ? `msgid=${cursor.msgid}` : `timestamp=${cursor.timestamp}`;
  return `CHATHISTORY AFTER ${target} ${anchor} ${limit}`;
}

// A shared message link may point past the cached window: one page centred on it, any age.
export function buildAroundCommand(target: string, serverId: string, limit: number): string {
  return `CHATHISTORY AROUND ${target} msgid=${serverId} ${limit}`;
}

export function buildBeforeCommand(target: string, timestamp: string | undefined, limit: number): string {
  const anchor = timestamp ? `timestamp=${timestamp}` : "*";
  return `CHATHISTORY BEFORE ${target} ${anchor} ${limit}`;
}

export function buildMarkReadCommand(target: string, timestamp: string): string {
  return `MARKREAD ${target} timestamp=${timestamp}`;
}

// Ergo pushes `MARKREAD <target> timestamp=<t>` on JOIN and when another session moves the marker,
// or `MARKREAD <target> *` when none is set. Anything else reads as unset.
export function parseMarkRead(params: readonly string[]): { target: string; timestamp: string } {
  const raw = params[1] ?? "";
  const timestamp = raw.startsWith("timestamp=") ? raw.slice("timestamp=".length) : "";
  return { target: params[0] ?? "", timestamp: Number.isFinite(Date.parse(timestamp)) ? timestamp : "" };
}

function messageId(conversationId: string, serverId: string | undefined): string {
  // Ergo can reuse one event msgid across channels; IndexedDB row ids cannot.
  if (serverId) return `srv:${JSON.stringify([conversationId, serverId])}`;
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `hist-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function positionOf(message: IrcMessage): { serverId: string; time: string } | undefined {
  if (!message.tags.msgid || !message.tags.time) return undefined;
  return { serverId: message.tags.msgid, time: message.tags.time };
}

// A replacement message carries `+draft/edit=<old server msgid>`. Only a well-formed msgid is
// trusted; anything else is ignored so junk cannot tombstone an unrelated row.
function editTarget(tags: Record<string, string | undefined>): string | undefined {
  const raw = tags["+draft/edit"];
  return raw && /^[a-z0-9_-]{1,512}$/i.test(raw) ? raw : undefined;
}

function replyTarget(tags: Record<string, string | undefined>): string | undefined {
  const raw = tags["+reply"] ?? tags["+draft/reply"];
  return raw && /^[a-z0-9_-]{1,512}$/i.test(raw) ? raw : undefined;
}

function isBroadcastReply(tags: Record<string, string | undefined>): boolean {
  return tags["+slirc/broadcast"] === "1";
}

function withPoll(tags: Record<string, string | undefined>): { poll?: Message["poll"]; jobs?: Message["jobs"] } {
  const poll = pollMark(tags);
  const jobs = jobsMark(tags);
  return { ...(poll ? { poll } : {}), ...(jobs ? { jobs } : {}) };
}

interface ReactionContext { source: "live" | "history"; seq: number; batch?: string }

function eventFromLine(conversationId: string, message: IrcMessage, reactionContext?: ReactionContext): ProtocolEvent | null {
  const nick = prefixNick(message.prefix);
  const account = message.tags.account ?? nick ?? "";
  const position = positionOf(message);

  if (message.command === "PRIVMSG") {
    const text = message.params[1] ?? "";
    const serverId = message.tags.msgid;
    return {
      type: "message",
      position,
      message: {
        id: messageId(conversationId, serverId),
        conversationId,
        serverId,
        clientId: message.tags["+slirc/cid"],
        replyTo: replyTarget(message.tags),
        ...(isBroadcastReply(message.tags) ? { broadcast: true } : {}),
        authorAccount: account,
        authorNick: nick || "unknown",
        text,
        time: message.tags.time ?? new Date(0).toISOString(),
        state: "confirmed",
        replaces: editTarget(message.tags),
        ...(message.tags[AGENT_OFFLINE_TAG] !== undefined ? { notice: "agent-offline" as const } : {}),
        ...withPoll(message.tags),
      },
    };
  }

  if (message.command === "TAGMSG") {
    const react = message.tags["+draft/react"];
    const unreact = message.tags["+draft/unreact"];
    const replyTo = replyTarget(message.tags);
    if (!replyTo || (!react && !unreact)) return null;
    // The reaction's own position is its TAGMSG msgid/time, never the reacted-to message's id.
    return {
      type: "reaction",
      position,
      reaction: {
        conversationId,
        messageServerId: replyTo,
        account,
        emoji: react ?? unreact ?? "",
        ordering: {
          time: position?.time,
          source: reactionContext?.source ?? "live",
          seq: reactionContext?.seq ?? 0,
          batch: reactionContext?.batch,
          eventId: position?.serverId,
        },
      },
      remove: Boolean(unreact),
    };
  }

  if (message.command === "REDACT") {
    const serverId = message.params[1];
    if (!serverId) return null;
    return { type: "redaction", conversationId, serverId, position };
  }

  return null;
}

// A nested `draft/multiline` batch is one message: join the inner PRIVMSG texts with newlines and
// take `+slirc/cid` from the opener (C1). Its server msgid is the opener's, falling back to the
// last inner line on a server that tags differently.
function multilineMessage(conversationId: string, batch: IrcBatch): Message | null {
  const lines = batch.items
    .filter((item): item is { kind: "line"; message: IrcMessage } => item.kind === "line")
    .map((item) => item.message)
    .filter((message) => message.command === "PRIVMSG");
  if (lines.length === 0) return null;
  const first = lines[0];
  const serverId = batch.tags.msgid ?? lines[lines.length - 1].tags.msgid;
  const nick = prefixNick(first.prefix);
  return {
    id: messageId(conversationId, serverId),
    conversationId,
    serverId,
    clientId: batch.tags["+slirc/cid"],
    replyTo: replyTarget(batch.tags) ?? replyTarget(first.tags),
    ...(isBroadcastReply(batch.tags) || isBroadcastReply(first.tags) ? { broadcast: true } : {}),
    authorAccount: batch.tags.account ?? first.tags.account ?? nick ?? "",
    authorNick: nick || "unknown",
    text: joinParts(lines.map((message) => ({ text: message.params[1] ?? "", concat: isConcat(message.tags) }))),
    time: batch.tags.time ?? first.tags.time ?? new Date(0).toISOString(),
    state: "confirmed",
    replaces: editTarget(batch.tags),
    ...withPoll(batch.tags),
  };
}

export function eventsFromBatch(conversationId: string, batch: IrcBatch): ProtocolEvent[] {
  const messageEvent = (message: Message): ProtocolEvent => ({
    type: "message",
    position: message.serverId ? { serverId: message.serverId, time: message.time } : undefined,
    message,
  });
  // The passed batch itself may be a multiline message (a live send), not a history container.
  if (batch.type === "draft/multiline") {
    const message = multilineMessage(conversationId, batch);
    return message ? [messageEvent(message)] : [];
  }
  const events: ProtocolEvent[] = [];
  // Reactions replayed inside one complete batch keep the server's batch order.
  let reactionSeq = 0;
  const walk = (items: BatchItem[]): void => {
    for (const item of items) {
      if (item.kind === "line") {
        const event = eventFromLine(conversationId, item.message, { source: "history", seq: reactionSeq++, batch: batch.id });
        if (event) events.push(event);
        continue;
      }
      if (!item.batch) continue;
      if (item.batch.type === "draft/multiline") {
        const message = multilineMessage(conversationId, item.batch);
        if (message) events.push(messageEvent(message));
      } else {
        walk(item.batch.items);
      }
    }
  };
  walk(batch.items);
  return events;
}

// The checkpoint is the last applied server record, taken from that event's own position (or, for
// a message, the message's serverId/time). A page with only query metadata, or no server-recorded
// event, advances nothing. The db only commits a checkpoint that matches an event in the batch.
export function checkpointOf(conversationId: string, events: ProtocolEvent[]): SyncProgress | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const position = event.position ??
      (event.type === "message" ? { serverId: event.message.serverId, time: event.message.time } : undefined);
    if (position?.serverId && position.time) {
      return { conversationId, serverId: position.serverId, time: position.time };
    }
  }
  return undefined;
}

function isEventLine(message: IrcMessage): boolean {
  return message.command === "PRIVMSG" || message.command === "TAGMSG" || message.command === "REDACT";
}

function rawEventLineCount(batch: IrcBatch): number {
  let count = 0;
  for (const item of batch.items) {
    if (item.kind === "line") {
      if (isEventLine(item.message)) count += 1;
    } else if (item.batch) {
      count += rawEventLineCount(item.batch);
    }
  }
  return count;
}

function cursorKey(cursor: Cursor | undefined): string {
  return cursor?.msgid ?? cursor?.timestamp ?? "";
}

const AUTH_FAILURE = new Set(["904", "905", "906", "907"]);

export class SyncEngine implements ReadinessSource {
  private readonly opts: SyncOptions;
  private readonly assembler: BatchAssembler;
  private readonly authorized = new Map<string, AuthorizedConversation>();
  private readonly byTarget = new Map<string, AuthorizedConversation>();
  private readonly ready = new Set<string>();
  private readonly pending = new Map<string, PendingRoom>();
  private readonly olderRequests = new Map<string, OlderRequest>();
  private readonly exhausted = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  // One AROUND lookup per conversation. It is sent only while no page is in flight there, and the
  // server answers in order, so the next chathistory batch or FAIL for that target is its answer,
  // even after a sync page is requested behind it. A timed-out lookup stays until that answer
  // arrives, so a late reply can never be read as a sync page.
  private readonly arounds = new Map<string, { serverId: string; epoch: number; resolve: (found: boolean | null) => void }>();
  private authenticated = false;
  private epoch = 0;
  // Live reaction arrivals need a monotonic tiebreak so equal server timestamps still obey the
  // order the client actually received them in. Date.now() seeds it so the value keeps increasing
  // across a reload and cannot fall behind a previous session's stored ordering.
  private liveReactionSeq = 0;

  private nextLiveSeq(): number {
    const now = Date.now();
    this.liveReactionSeq = now > this.liveReactionSeq ? now : this.liveReactionSeq + 1;
    return this.liveReactionSeq;
  }

  constructor(options: SyncOptions) {
    this.opts = options;
    this.assembler = new BatchAssembler({
      onLine: (message) => this.handleLine(message),
      onBatch: (batch) => this.onBatch(batch),
      onDrop: (id, reason) =>
        this.opts.hooks?.onError?.(undefined, new Error(`Dropped batch ${id || "(line)"}: ${reason}`)),
    });
  }

  private get limit(): number {
    return this.opts.pageLimit ?? 250;
  }

  private get maxPages(): number {
    return this.opts.maxPages ?? 1000;
  }

  /** Feed raw socket bytes; framing, tag escapes and batch completion live in the assembler. */
  push(chunk: string | Uint8Array): void {
    this.assembler.push(chunk);
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  isReady(conversationId: string): boolean {
    return this.authenticated && this.ready.has(conversationId);
  }

  isExhausted(conversationId: string): boolean {
    return this.exhausted.has(conversationId);
  }

  /** Fetch one older page via CHATHISTORY BEFORE without touching forward sync progress or pruning. */
  loadOlder(conversationId: string): Promise<LoadOlderResult> {
    const existing = this.olderRequests.get(conversationId);
    if (existing) return existing.promise;
    if (this.exhausted.has(conversationId)) return Promise.resolve({ loaded: 0, hasMore: false });
    const conversation = this.authorized.get(conversationId);
    if (!this.authenticated || !conversation) return Promise.reject(new Error("Conversation is not connected"));
    if (this.pending.get(conversationId)?.awaiting) return Promise.reject(new Error("Sync is still in progress"));

    let resolve!: (result: LoadOlderResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<LoadOlderResult>((res, rej) => { resolve = res; reject = rej; });
    const request: OlderRequest = { conversation, epoch: this.epoch, promise, resolve, reject };
    this.olderRequests.set(conversationId, request);

    this.track((async () => {
      try {
        const oldest = await this.opts.db.messages
          .where("[conversationId+time]")
          .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
          .filter((message) => message.state === "confirmed")
          .first();
        if (!this.authenticated || request.epoch !== this.epoch || this.olderRequests.get(conversationId) !== request) {
          if (this.olderRequests.get(conversationId) === request) this.olderRequests.delete(conversationId);
          request.reject(new Error("Disconnected"));
          return;
        }
        const line = buildBeforeCommand(conversation.wireTarget, oldest?.time, this.limit);
        if (!this.opts.send(line)) {
          this.olderRequests.delete(conversationId);
          request.reject(new Error(`Send failed for ${conversation.wireTarget}`));
        }
      } catch (error) {
        if (this.olderRequests.get(conversationId) === request) this.olderRequests.delete(conversationId);
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    })());

    return promise;
  }

  /** The caller's complete authorized set: every conversation to join and catch up. Not capped. */
  recover(conversations: AuthorizedConversation[]): void {
    const previous = new Map(this.authorized);
    for (const id of [...this.ready]) this.unready(id);
    this.clearPending();
    this.authorized.clear();
    this.byTarget.clear();
    for (const conversation of conversations) {
      this.authorized.set(conversation.conversationId, conversation);
      this.byTarget.set(foldTarget(conversation.wireTarget), conversation);
    }
    for (const [id, conversation] of previous) {
      if (this.authorized.has(id)) continue;
      if (this.ready.delete(id)) this.opts.hooks?.onUnready?.(conversation);
      this.exhausted.delete(id);
      this.dropRoom(id);
    }
    if (this.authenticated) this.join([...this.authorized.values()]);
  }

  /**
   * Incremental authorized-set update for a sender that discovered queued work for a
   * conversation it never opened. Adds/removes conversations without disturbing the readiness
   * of ones already known, so repeated calls add no duplicate JOIN or history request. New
   * conversations join only when the connection is authenticated; otherwise 001 joins them.
   */
  ensure(conversations: AuthorizedConversation[]): void {
    const wanted = new Map(conversations.map((conversation) => [conversation.conversationId, conversation]));
    const joining: AuthorizedConversation[] = [];
    for (const [id, conversation] of [...this.authorized]) {
      if (wanted.has(id)) continue;
      if (this.ready.delete(id)) this.opts.hooks?.onUnready?.(conversation);
      this.exhausted.delete(id);
      this.dropRoom(id);
      this.authorized.delete(id);
      const folded = foldTarget(conversation.wireTarget);
      if (this.byTarget.get(folded)?.conversationId === id) this.byTarget.delete(folded);
    }
    for (const conversation of conversations) {
      const existing = this.authorized.get(conversation.conversationId);
      if (existing) {
        if (existing.wireTarget === conversation.wireTarget) continue;
        // The server-owned target changed: the old JOIN and its history no longer describe this
        // conversation, so drop readiness/pending and recover fresh against the new target.
        this.unready(conversation.conversationId);
        this.exhausted.delete(conversation.conversationId);
        this.dropRoom(conversation.conversationId);
        const folded = foldTarget(existing.wireTarget);
        if (this.byTarget.get(folded)?.conversationId === conversation.conversationId) this.byTarget.delete(folded);
        this.authorized.set(conversation.conversationId, conversation);
        this.byTarget.set(foldTarget(conversation.wireTarget), conversation);
        joining.push(conversation);
        continue;
      }
      this.authorized.set(conversation.conversationId, conversation);
      this.byTarget.set(foldTarget(conversation.wireTarget), conversation);
      joining.push(conversation);
    }
    if (this.authenticated) this.join(joining);
  }

  /**
   * Pull-to-refresh: page anything newer than the stored checkpoint for conversations that are
   * already ready, on the current connection and without a new JOIN. Resolves true once every page
   * has landed, false when one failed or the connection dropped first. A conversation still in its
   * first sync is skipped: that sync is already fetching.
   */
  catchUp(conversationIds: string[]): Promise<boolean> {
    if (!this.authenticated) return Promise.resolve(false);
    const waits: Promise<boolean>[] = [];
    for (const id of conversationIds) {
      const conversation = this.authorized.get(id);
      if (!conversation || !this.ready.has(id)) continue;
      waits.push(new Promise<boolean>((resolve) => {
        const current = this.pending.get(id);
        // A page already in flight answers this caller too.
        if (current?.awaiting && current.epoch === this.epoch) { (current.waiters ??= []).push(resolve); return; }
        this.dropRoom(id);
        const room: PendingRoom = { conversation, epoch: this.epoch, joined: false, awaiting: false, pages: 0, probes: 0, live: new Set(), waiters: [resolve] };
        this.pending.set(id, room);
        this.track(this.startSync(room));
      }));
    }
    return Promise.all(waits).then((results) => results.every(Boolean));
  }

  /**
   * Load the history around one message of a ready conversation, for a shared link. Resolves true
   * when the server returned that message, false when it did not (deleted, or never there), null
   * when it could not ask: not ready, a sync page in flight, or the connection dropped. Rows land
   * without a checkpoint or prune window, so they never move the sync cursor or delete anything.
   */
  around(conversationId: string, serverId: string, limit = 100): Promise<boolean | null> {
    const conversation = this.authorized.get(conversationId);
    if (!conversation || !this.isReady(conversationId) || this.pending.get(conversationId)?.awaiting || this.arounds.has(conversationId)) return Promise.resolve(null);
    if (!/^[a-z0-9_-]{1,512}$/i.test(serverId)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000);
      const query = { serverId, epoch: this.epoch, resolve: (found: boolean | null) => { clearTimeout(timer); if (this.arounds.get(conversationId) === query) this.arounds.delete(conversationId); resolve(found); } };
      this.arounds.set(conversationId, query);
      if (!this.opts.send(buildAroundCommand(conversation.wireTarget, serverId, limit))) query.resolve(null);
    });
  }

  private async applyAround(conversation: AuthorizedConversation, batch: IrcBatch): Promise<void> {
    const query = this.arounds.get(conversation.conversationId);
    if (!query) return;
    if (query.epoch !== this.epoch) { query.resolve(null); return; }
    // Take the slot now: the next batch for this target belongs to whatever was sent after.
    this.arounds.delete(conversation.conversationId);
    const events = eventsFromBatch(conversation.conversationId, batch);
    const found = events.some((event) => event.type === "message" && event.message.serverId === query.serverId);
    try {
      if (events.length) await this.opts.db.applyBatch({ conversationId: conversation.conversationId, events, complete: true });
      query.resolve(found);
    } catch (error) {
      query.resolve(null);
      this.opts.hooks?.onError?.(conversation, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private settle(room: PendingRoom, ok: boolean): void {
    const waiters = room.waiters;
    room.waiters = undefined;
    for (const resolve of waiters ?? []) resolve(ok);
  }

  /** 001: authenticated. Every authorized conversation is (re)joined and re-synced from scratch. */
  onWelcome(): void {
    for (const query of [...this.arounds.values()]) query.resolve(null);
    this.arounds.clear();
    this.authenticated = true;
    this.epoch += 1;
    for (const id of [...this.ready]) this.unready(id);
    this.clearPending();
    this.join([...this.authorized.values()]);
  }

  /** Disconnect: drop unfinished protocol state, clear readiness, and invalidate late batches. */
  onDisconnect(): void {
    this.assembler.reset("disconnect");
    for (const query of [...this.arounds.values()]) query.resolve(null);
    this.arounds.clear();
    this.epoch += 1;
    this.authenticated = false;
    for (const id of [...this.ready]) this.unready(id);
    this.ready.clear();
    this.clearPending();
  }

  onAuthFailed(reason = "authentication refused"): void {
    this.assembler.reset("auth-failed");
    this.epoch += 1;
    this.authenticated = false;
    for (const id of [...this.ready]) this.unready(id);
    this.ready.clear();
    this.clearPending();
    this.opts.hooks?.onError?.(undefined, new Error(reason));
  }

  handleLine(message: IrcMessage): void {
    switch (message.command) {
      case "001":
        this.onWelcome();
        return;
      case "ERROR":
        this.onDisconnect();
        return;
      case "FAIL":
        this.onFail(message);
        return;
      case "JOIN":
        this.onJoin(message);
        return;
      case "353":
      case "366":
        this.onNames(message);
        return;
      case "PART":
      case "KICK":
        this.onLeave(message);
        return;
      case "QUIT":
        if (this.isSelf(message)) this.onDisconnect();
        return;
      case "401":
      case "402":
      case "311":
      case "312":
      case "318":
      case "319":
      case "330":
      case "671":
        this.opts.hooks?.onWhois?.(message);
        return;
      case "MARKREAD": {
        // A read position is metadata, never a message row; unknown targets are not authorization.
        const { target, timestamp } = parseMarkRead(message.params);
        const conversation = target ? this.byTarget.get(foldTarget(target)) : undefined;
        if (conversation) this.opts.hooks?.onReadMarker?.(conversation, timestamp);
        return;
      }
      case "AWAY":
      case "301":
      case "302":
        // Presence lines belong to presence.ts; an away message is never a conversation target.
        return;
      default:
        break;
    }
    if (AUTH_FAILURE.has(message.command)) {
      this.onAuthFailed(message.params.at(-1) || message.command);
      return;
    }
    const conversation = message.params[0] ? this.byTarget.get(foldTarget(message.params[0])) : undefined;
    if (!conversation) return;
    this.opts.hooks?.onLive?.(conversation, message);
    const event = eventFromLine(conversation.conversationId, message, { source: "live", seq: this.nextLiveSeq() });
    if (!event) return;
    this.noteLive(conversation, [event]);
    this.track(this.applyEvents(conversation, [event], undefined));
  }

  private onBatch(batch: IrcBatch): void {
    if (batch.complete !== true) return;
    const target = batch.params[0];
    const conversation = target ? this.byTarget.get(foldTarget(target)) : undefined;
    if (!conversation) return;
    if (batch.type === "chathistory") {
      if (this.arounds.has(conversation.conversationId)) { this.track(this.applyAround(conversation, batch)); return; }
      const room = this.pending.get(conversation.conversationId);
      if (room && room.awaiting && room.epoch === this.epoch) {
        room.awaiting = false;
        this.track(this.applyPage(room, batch));
        return;
      }
      const older = this.olderRequests.get(conversation.conversationId);
      if (older && older.epoch === this.epoch) {
        this.olderRequests.delete(conversation.conversationId);
        this.track(this.applyOlderPage(older, batch));
        return;
      }
      return;
    }
    if (batch.type === "draft/multiline" || batch.type === "draft/event-playback") {
      const events = eventsFromBatch(conversation.conversationId, batch);
      this.noteLive(conversation, events);
      if (events.length) this.track(this.applyEvents(conversation, events, undefined));
    }
  }

  private noteLive(conversation: AuthorizedConversation, events: ProtocolEvent[]): void {
    const room = this.pending.get(conversation.conversationId);
    if (!room?.awaiting) return;
    for (const event of events) if (event.type === "message" && event.message.serverId) room.live.add(event.message.serverId);
  }

  private join(conversations: AuthorizedConversation[]): void {
    if (!this.authenticated) return;
    for (const line of buildJoinCommands(conversations.map((conversation) => this.begin(conversation)))) this.opts.send(line);
  }

  // Arms one room and returns its target; join() sends the targets together.
  private begin(conversation: AuthorizedConversation): string {
    this.dropRoom(conversation.conversationId);
    const room: PendingRoom = {
      conversation,
      epoch: this.epoch,
      joined: false,
      awaiting: false,
      pages: 0,
      probes: 0,
      live: new Set(),
    };
    this.pending.set(conversation.conversationId, room);
    // Metadata authorizes the JOIN; the server reply proves membership. A self-JOIN seen before
    // authorization is deliberately not reused: it is not proof the server still holds the
    // membership, whereas the bounded NAMES probe below is.
    this.armProbe(room);
    return conversation.wireTarget;
  }

  // A JOIN to a channel the connection already holds is a no-op on Ergo (multiclient shares the
  // nick's membership) and can produce no reply at all. Probe with NAMES: the 353 list names the
  // members, so the self nick there is the membership proof that lets history start.
  private armProbe(room: PendingRoom): void {
    const delay = this.opts.namesProbeMs ?? 1_500;
    if (delay <= 0 || room.probes >= 3) return;
    room.probeTimer = setTimeout(() => {
      room.probeTimer = undefined;
      if (!this.authenticated || room.joined || room.epoch !== this.epoch) return;
      if (this.pending.get(room.conversation.conversationId) !== room) return;
      room.probes += 1;
      this.opts.send(`NAMES ${room.conversation.wireTarget}`);
      this.armProbe(room);
    }, delay * (room.probes + 1));
  }

  private clearProbe(room: PendingRoom): void {
    if (room.probeTimer === undefined) return;
    clearTimeout(room.probeTimer);
    room.probeTimer = undefined;
  }

  private dropRoom(conversationId: string): void {
    const room = this.pending.get(conversationId);
    if (room) { this.clearProbe(room); this.settle(room, false); }
    this.pending.delete(conversationId);
    const older = this.olderRequests.get(conversationId);
    if (older) {
      this.olderRequests.delete(conversationId);
      older.reject(new Error("Conversation closed"));
    }
  }

  private clearPending(): void {
    for (const room of this.pending.values()) { this.clearProbe(room); this.settle(room, false); }
    this.pending.clear();
    for (const older of this.olderRequests.values()) older.reject(new Error("Disconnected"));
    this.olderRequests.clear();
  }

  private onJoin(message: IrcMessage): void {
    if (!this.isSelf(message)) return;
    const target = message.params[0];
    if (!target) return;
    const conversation = this.byTarget.get(foldTarget(target));
    // An unknown target is not authorization; a JOIN echo for it is ignored. The NAMES probe
    // after begin() is what recovers a membership the server no longer echoes.
    if (!conversation) return;
    const room = this.pending.get(conversation.conversationId);
    if (!room || room.joined || room.epoch !== this.epoch) return;
    this.track(this.startSync(room));
  }

  // NAMES is not an authorization check and 366 only ends a reply, so history starts only when a
  // 353 for a target in the authoritative set actually lists our own nick. NAMES never marks a
  // conversation ready by itself; the history page still gates the wire send.
  private onNames(message: IrcMessage): void {
    if (message.command !== "353") return;
    const target = message.params[2];
    if (!target || !this.namesIncludeSelf(message.params[3] ?? "")) return;
    const conversation = this.byTarget.get(foldTarget(target));
    if (!conversation) return;
    const room = this.pending.get(conversation.conversationId);
    if (!room || room.joined || room.epoch !== this.epoch) return;
    this.track(this.startSync(room));
  }

  private namesIncludeSelf(names: string): boolean {
    // No known identity means no possible proof: a NAMES reply cannot be attributed to us.
    if (!this.opts.nick) return false;
    const self = foldIdentifier(this.opts.nick, "ascii");
    return names.split(" ").some((raw) => {
      const nick = raw.replace(/^[~&@%+]+/, "");
      return !!nick && foldIdentifier(nick, "ascii") === self;
    });
  }

  private onLeave(message: IrcMessage): void {
    const target = message.params[0];
    if (!target) return;
    const conversation = this.byTarget.get(foldTarget(target));
    if (!conversation) return;
    if (message.command === "PART" && !this.isSelf(message)) return;
    // A KICK only unreadies us when we are the kicked nick (params[1]); unknown nick stays lenient.
    if (message.command === "KICK" && this.opts.nick && message.params[1] !== this.opts.nick) return;
    this.unready(conversation.conversationId);
    this.dropRoom(conversation.conversationId);
    if (message.command === "KICK") this.opts.hooks?.onKicked?.(conversation);
  }

  private onFail(message: IrcMessage): void {
    // FAIL REDACT <code> <target> <msgid> :<description>
    if (message.params[0] === "REDACT") {
      const msgid = message.params[3];
      if (!msgid) return;
      // Ergo has no such message (deleted elsewhere, or history reset): the delete already holds.
      // Apply it locally like a REDACT echo, which also settles the in-flight operation.
      const conversation = message.params[2] ? this.byTarget.get(foldTarget(message.params[2])) : undefined;
      if (message.params[1] === "UNKNOWN_MSGID" && conversation) {
        this.track(this.applyEvents(conversation, [{ type: "redaction", conversationId: conversation.conversationId, serverId: msgid }], undefined));
        return;
      }
      this.opts.hooks?.onRedactRefused?.(msgid, message.params.at(-1) || "delete refused");
      return;
    }
    if (message.params[0] !== "CHATHISTORY") return;
    // `FAIL CHATHISTORY <code> <target>`, or with the subcommand before the target.
    let conversation: AuthorizedConversation | undefined;
    for (const target of message.params.slice(2, 4)) {
      if (!conversation && target && target !== "*") conversation = this.byTarget.get(foldTarget(target));
    }
    if (conversation && !this.arounds.has(conversation.conversationId)) {
      const older = this.olderRequests.get(conversation.conversationId);
      if (older && !this.pending.get(conversation.conversationId)?.awaiting) {
        this.olderRequests.delete(conversation.conversationId);
        const reason = message.params.at(-1) || "history request refused";
        older.reject(new Error(`CHATHISTORY refused for ${conversation.wireTarget}: ${reason}`));
        return;
      }
    }
    if (!conversation) {
      for (const room of this.pending.values()) {
        if (room.awaiting) {
          conversation = room.conversation;
          break;
        }
      }
    }
    if (!conversation) return;
    // A refused link lookup only means that message is not there; the conversation stays ready.
    const query = this.arounds.get(conversation.conversationId);
    if (query) { query.resolve(false); return; }
    const reason = message.params.at(-1) || "history request refused";
    this.failRoom(conversation, new Error(`CHATHISTORY refused for ${conversation.wireTarget}: ${reason}`));
  }

  private async startSync(room: PendingRoom): Promise<void> {
    if (room.joined) return; // JOIN echo, self-JOIN and NAMES can race; recover history only once
    room.joined = true;
    this.clearProbe(room);
    const saved = await this.opts.db.progress.get(room.conversation.conversationId);
    if (!this.authenticated || this.epoch !== room.epoch || this.pending.get(room.conversation.conversationId) !== room) return;
    room.joined = true;
    // Resume by time, never by the stored msgid. Ergo answers AFTER an unknown msgid (a deleted
    // message, or the redacted original of an edit) with an empty batch, which reads as caught up
    // forever. One millisecond back covers equal-time neighbours; replayed rows dedup by msgid.
    if (saved) {
      room.cursor = { timestamp: new Date(Date.parse(saved.time) - 1).toISOString() };
      room.resumedFrom = saved.serverId;
    }
    this.requestPage(room);
  }

  private requestPage(room: PendingRoom): void {
    if (room.pages >= this.maxPages) {
      this.failRoom(room.conversation, new Error(`History paging exceeded ${this.maxPages} pages`));
      return;
    }
    room.pages += 1;
    room.epoch = this.epoch;
    room.awaiting = true;
    room.live.clear();
    const { wireTarget } = room.conversation;
    const supportsMsgid = this.opts.msgidCursor !== false;
    let cursor: Cursor | undefined;
    if (room.cursor) {
      if (supportsMsgid && room.cursor.msgid) cursor = { msgid: room.cursor.msgid };
      else if (room.cursor.timestamp) cursor = { timestamp: room.cursor.timestamp };
      else if (room.cursor.msgid) cursor = { msgid: room.cursor.msgid };
    }
    const line = cursor && room.verify !== "sent"
      ? buildAfterCommand(wireTarget, cursor, this.limit)
      : buildLatestCommand(wireTarget, this.limit);
    if (!this.opts.send(line)) {
      room.awaiting = false;
      this.failRoom(room.conversation, new Error(`Send failed for ${wireTarget}`));
    }
  }

  private async applyPage(room: PendingRoom, batch: IrcBatch): Promise<void> {
    const { conversationId } = room.conversation;
    const current = () => this.authenticated && room.epoch === this.epoch && this.pending.get(conversationId) === room;
    if (!current()) return;
    try {
      const events = eventsFromBatch(conversationId, batch);
      const checkpoint = checkpointOf(conversationId, events);
      const full = rawEventLineCount(batch) >= this.limit;
      const latest = !room.cursor || room.verify === "sent";
      const window = this.pageWindow(room, latest, full, events);
      if (room.resumedFrom && room.pages === 1 && !events.some((event) => (event.position?.serverId ?? (event.type === "message" ? event.message.serverId : undefined)) === room.resumedFrom)) {
        room.verify = "pending";
      }
      const page: CompleteBatch = { conversationId, events, complete: true, checkpoint, window };
      await this.opts.db.applyBatch(page);

      // Re-read the durable checkpoint: db.applyBatch may reject an older time, so the engine's
      // cursor must follow stored progress, never the page's own (possibly regressing) position.
      const stored = await this.opts.db.progress.get(conversationId);
      if (!current()) return;
      const nextCursor: Cursor | undefined = stored
        ? { msgid: stored.serverId, timestamp: stored.time }
        : room.cursor;
      if (room.verify === "sent") {
        this.markReady(room.conversation);
        this.settle(room, true);
        return;
      }
      if (!full) {
        if (room.verify === "pending") {
          room.verify = "sent";
          this.requestPage(room);
          return;
        }
        this.markReady(room.conversation);
        this.settle(room, true);
        return;
      }
      if (cursorKey(nextCursor) === cursorKey(room.cursor)) {
        this.failRoom(room.conversation, new Error(`History cursor did not advance for ${room.conversation.wireTarget}`));
        return;
      }
      room.cursor = nextCursor;
      this.requestPage(room);
    } catch (error) {
      if (current()) this.failRoom(room.conversation, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async applyOlderPage(older: OlderRequest, batch: IrcBatch): Promise<void> {
    const { conversationId } = older.conversation;
    if (!this.authenticated || older.epoch !== this.epoch) {
      older.reject(new Error("Disconnected"));
      return;
    }
    try {
      const events = eventsFromBatch(conversationId, batch);
      const hasMore = rawEventLineCount(batch) >= this.limit;
      if (!hasMore) this.exhausted.add(conversationId);
      await this.opts.db.applyBatch({ conversationId, events, complete: true, checkpoint: undefined });
      const loaded = events.filter((event) => event.type === "message").length;
      older.resolve({ loaded, hasMore });
    } catch (error) {
      older.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // The span this page answered for, exclusive at both ends: equal-time neighbours past the edge may
  // sit on the next page. AFTER starts past its cursor; LATEST and a short last page reach the end.
  // A full LATEST page starts at its oldest message, anything older was simply not asked for.
  private pageWindow(room: PendingRoom, latest: boolean, full: boolean, events: ProtocolEvent[]): CompleteBatch["window"] {
    const times = events.map((event) => event.position?.time ?? (event.type === "message" ? event.message.time : undefined))
      .filter((time): time is string => !!time && Number.isFinite(Date.parse(time)))
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const keep = [...room.live];
    if (latest) {
      if (full && !times.length) return undefined;
      return { after: full ? times[0] : undefined, keep };
    }
    const after = room.cursor?.timestamp;
    if (!after || !Number.isFinite(Date.parse(after))) return undefined;
    if (full && !times.length) return undefined;
    return { after, before: full ? times.at(-1) : undefined, keep };
  }

  private async applyEvents(
    conversation: AuthorizedConversation,
    events: ProtocolEvent[],
    checkpoint: SyncProgress | undefined,
  ): Promise<void> {
    try {
      await this.opts.db.applyBatch({ conversationId: conversation.conversationId, events, complete: true, checkpoint });
    } catch (error) {
      this.opts.hooks?.onError?.(conversation, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private markReady(conversation: AuthorizedConversation): void {
    if (this.ready.has(conversation.conversationId)) return;
    this.ready.add(conversation.conversationId);
    this.opts.hooks?.onReady?.(conversation);
  }

  private unready(conversationId: string): void {
    if (!this.ready.delete(conversationId)) return;
    for (const conversation of this.authorized.values()) {
      if (conversation.conversationId === conversationId) {
        this.opts.hooks?.onUnready?.(conversation);
        return;
      }
    }
  }

  private failRoom(conversation: AuthorizedConversation, error: Error): void {
    this.dropRoom(conversation.conversationId);
    this.unready(conversation.conversationId);
    this.opts.hooks?.onError?.(conversation, error);
  }

  private isSelf(message: IrcMessage, index = 0): boolean {
    if (!this.opts.nick) return true;
    if (index === 1) return message.params[1] === this.opts.nick;
    return prefixNick(message.prefix) === this.opts.nick;
  }

  private track(promise: Promise<void>): void {
    const guarded = promise.catch((error) =>
      this.opts.hooks?.onError?.(undefined, error instanceof Error ? error : new Error(String(error))),
    );
    this.inflight.add(guarded);
    void guarded.finally(() => this.inflight.delete(guarded));
  }

  /** Test/bridge barrier: resolve once every in-flight page or live apply has settled. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }
}

export function createSyncEngine(options: SyncOptions): SyncEngine {
  return new SyncEngine(options);
}
