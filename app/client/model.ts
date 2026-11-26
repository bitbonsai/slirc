// Device records are projections of Ergo, never a second conversation authority.
export type CaseMapping = "ascii" | "rfc1459" | "strict-rfc1459";

export function foldIdentifier(value: string, mapping: CaseMapping = "ascii"): string {
  const lower = value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  if (mapping === "ascii") return lower;
  return lower.replace(/[\[\]\\^]/g, (ch) =>
    ({ "[": "{", "]": "}", "\\": "|", "^": mapping === "rfc1459" ? "~" : "^" })[ch]!);
}

export interface AccountScope {
  instance: string; // canonical HTTP(S) origin, never a caller-supplied display host
  accountId: string; // immutable server-issued account UUID, not nick or session token
  account: string; // server-authenticated IRC account tag, not the connection's display nick
  caseMapping?: CaseMapping; // negotiated/configured; this instance uses ascii
}

export function scopeKey(scope: AccountScope): string {
  const url = new URL(scope.instance);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !scope.accountId.trim() || !scope.account.trim()) {
    throw new Error("Authenticated instance/account scope required");
  }
  return JSON.stringify([url.origin, scope.accountId]);
}

// No private durable guest database. Offline identity may only resume a prior authenticated
// scope, cleared on logout/revocation/account switch. Reconnect revalidates access before send.
export function conversationId(kind: "room" | "thread" | "dm", identity: string, mapping: CaseMapping = "ascii"): string {
  if (!identity || /[\x00-\x20\x7f]/.test(identity)) throw new Error("Invalid conversation identity");
  // DM identity is the immutable peer account ID; wire names remain server-owned metadata.
  return JSON.stringify([kind, kind === "dm" ? identity : foldIdentifier(identity, mapping)]);
}

export interface Conversation {
  id: string;
  kind: "room" | "dm" | "thread";
  title: string;
  wireTarget?: string; // absent until provisioning succeeds; never predict #dm-* in client
  peerAccountId?: string;
  parentId?: string;
  rootServerId?: string;
  access: "unknown" | "allowed" | "revoked";
  provisioning: "pending" | "ready" | "failed";
  error?: string;
  anchor?: ScrollAnchor;
}

export interface ScrollAnchor { messageId: string; offset: number }
export type SendState = "saving" | "queued" | "sending" | "uncertain" | "confirmed" | "failed";

export interface Message {
  id: string; // stable local UUID, retained on echo/history confirmation
  conversationId: string;
  serverId?: string; // unique [conversationId, serverId], not a DOM key
  clientId?: string; // correlation only; never a promise of server idempotency
  replyTo?: string; // IRCv3 +reply target, persisted from wire tags
  broadcast?: boolean; // +slirc/broadcast=1: thread reply also shown in parent channel
  authorAccount: string;
  authorNick: string;
  text: string;
  time: string;
  state: SendState;
  error?: string;
  deleted?: boolean;
  // Server msgid this message replaces (`+draft/edit`); Ergo persists the tag in history, so the
  // association survives a missed live REDACT.
  replaces?: string;
  // An edit shows where the first message it replaced was: `at` is that message's time and
  // `chain` the server msgids replaced, oldest first. Unset when the original was never seen here.
  at?: string;
  chain?: string[];
  // View only, set by the conversation projection: the edit's own server time. `time` then holds
  // the original's time, so sorting, date dividers and the time label all follow the original.
  editedAt?: string;
  // A line the server marked with a client-only tag, such as an agent's offline notice
  // (+slirc/agent-offline). Rendered specially only after the checks in agent-offline.ts.
  notice?: "agent-offline";
  // A poll helper line tagged +slirc/poll=<id> (drawn as a card) or +slirc/poll-tally=<id> (hidden,
  // since the card is live). Trusted only from the helper itself; see polls.ts.
  poll?: { id: number; kind: "card" | "tally" };
  // A bot's job digest tagged +slirc/jobs=<day>, with its logos (+slirc/jobs-logos). Drawn as a card
  // only for a bot account; see job-cards.ts.
  jobs?: { day: string; logos: string[] };
}

export interface Draft {
  conversationId: string;
  revision: string; // unique edit token, not a per-tab counter
  text: string;
  updatedAt: number;
}

// Staged photos per conversation, bytes included, so a route change or reload never loses a
// pending upload. One revision covers the whole set. `uploadedUrl` is set after a successful
// upload so a message-persistence failure can retry without uploading the same bytes twice.
export interface MediaDraftPhoto {
  name: string;
  mime: string;
  bytes: Uint8Array;
  uploadedUrl?: string;
  // A video's own pixel size, read before upload so the frame is reserved before the clip streams.
  width?: number;
  height?: number;
}

export interface MediaDraft {
  conversationId: string;
  revision: string;
  photos?: MediaDraftPhoto[];
  // Rows written before a message could carry several photos hold one photo inline.
  name?: string;
  mime?: string;
  bytes?: Uint8Array;
  uploadedUrl?: string;
  updatedAt: number;
}

export interface Operation {
  id: string; // also +slirc/cid, stable through explicit retries
  messageId: string;
  conversationId: string;
  kind: "text" | "redact" | "admin-redact";
  text: string;
  // Server msgid this operation replaces; the wire carries it as +draft/edit.
  editOf?: string;
  // Server msgid this message replies to; the wire carries it as +reply.
  replyTo?: string;
  // When true, also carries +slirc/broadcast=1 so Slirc shows the reply in the parent channel too.
  broadcast?: boolean;
  // kind "redact": the server msgid to remove and the visible reason.
  redactId?: string;
  reason?: string;
  state: Exclude<SendState, "saving">;
  createdAt: number;
  attemptedAt?: number;
  error?: string;
}

export interface QueueText {
  message: Message;
  operation: Operation;
  draftRevision: string;
  // When set, the same transaction consumes the conversation's staged media draft only if its
  // revision matches. The message text (caption + upload URL) is never the match key.
  mediaRevision?: string;
  // When set, the operation is an edit of this server msgid (+draft/edit on the wire).
  editOf?: string;
  // When set, the operation links to this server msgid (+reply on the wire).
  replyTo?: string;
  // When true, also carries +slirc/broadcast=1 on the wire.
  broadcast?: boolean;
}

export function clearsDraft(draft: Draft | undefined, send: QueueText): boolean {
  return !!draft && draft.conversationId === send.message.conversationId && draft.revision === send.draftRevision;
}

export type DeliveryEvent =
  | "persisted" | "persistence-failed" | "begin-send" | "disconnected"
  | "confirmed" | "rejected" | "retry-failed" | "explicit-resend-after-recovery";

export function deliveryState(state: SendState, event: DeliveryEvent): SendState {
  if (event === "confirmed" && state !== "saving") return "confirmed";
  if (state === "saving" && event === "persisted") return "queued";
  if (state === "saving" && event === "persistence-failed") return "failed";
  if (state === "queued" && event === "begin-send") return "sending";
  if (state === "sending" && event === "disconnected") return "uncertain";
  if ((state === "sending" || state === "queued") && event === "rejected") return "failed";
  if (state === "failed" && event === "retry-failed") return "queued";
  // Caller must have completed history recovery AND obtained explicit duplicate-risk consent.
  if (state === "uncertain" && event === "explicit-resend-after-recovery") return "queued";
  throw new Error(`Invalid delivery transition: ${state} / ${event}`);
}

export interface SyncProgress {
  conversationId: string;
  serverId: string;
  time: string;
}

export interface Tombstone { conversationId: string; serverId: string }

// How a reaction event is ordered against the stored state. Server timestamps lead; ties are
// broken by origin (a live arrival beat history) and, within one origin, by arrival/batch order.
// `seq` is a live arrival counter or the event's index inside its complete history batch.
export interface ReactionOrdering {
  time?: string; // server-time tag, when the server supplied one
  source: "live" | "history";
  seq: number;
  batch?: string; // history batch id; only events from the same batch can be ordered by seq
  eventId?: string; // the reaction event's own msgid, for seen-event dedupe
}

export interface Reaction {
  conversationId: string;
  messageServerId: string;
  account: string;
  emoji: string;
  ordering?: ReactionOrdering;
  // Storage-only: a committed unreact leaves the row with active:false instead of deleting it,
  // so the last event order is retained and a stale replay is rejected. Incoming events omit it.
  active?: boolean;
}

// Decide whether an incoming reaction event should replace the stored ordering. Server timestamps
// lead. On an equal (or missing) timestamp, a live arrival beats history, live arrivals obey their
// arrival counter, and history events obey their index inside one complete batch. A history event
// with no ordering evidence cannot replace a known newer state, and an exact replayed event is a
// no-op. Pure so the rules are testable without Dexie.
export function reactionEventWins(incoming: ReactionOrdering | undefined, existing: ReactionOrdering | undefined): boolean {
  if (!existing) return true;
  const inc = incoming ?? { source: "history" as const, seq: 0 };
  if (inc.eventId && existing.eventId && inc.eventId === existing.eventId) return false;
  if (inc.time && existing.time && inc.time !== existing.time) return inc.time > existing.time;
  if (inc.time && !existing.time) return true;
  if (!inc.time && existing.time) return false;
  if (inc.source === "live" && existing.source === "live") return inc.seq > existing.seq;
  if (inc.source === "live" && existing.source === "history") return true;
  if (inc.source === "history" && existing.source === "live") return false;
  if (inc.batch && existing.batch && inc.batch === existing.batch) return inc.seq > existing.seq;
  return false;
}

export type ProtocolEvent = (
  | { type: "message"; message: Message }
  | { type: "reaction"; reaction: Reaction; remove: boolean }
  | { type: "redaction"; conversationId: string; serverId: string }
) & { position?: { serverId: string; time: string } }; // actual event msgid/time, not reaction/redaction target

export interface CompleteBatch {
  conversationId: string;
  events: ProtocolEvent[];
  // Only the matching BATCH close produces this object; disconnect discards an open batch.
  complete: true;
  checkpoint?: SyncProgress; // last applied server record, not query wall-clock time
  // Set only for a chathistory page: the server returned every message it holds strictly between
  // these times (either bound absent means open). A confirmed cached row inside that window whose
  // msgid the page lacks is gone from the server, for example after a history reset, and is
  // dropped. `keep` lists msgids that arrived live while the page was in flight.
  window?: { after?: string; before?: string; keep?: string[] };
}

// db.ts owns these transactions. No network callback may run inside either transaction.
// queueText: message + operation + matching draft deletion, all or none; reject on failure.
// applyBatch: events + checkpoint, all or none; empty batch cannot invent progress.
// Nano Stores subscribes to committed records; Alpine may render a transient "saving" row.
export interface DurableTransactions {
  queueText(send: QueueText): Promise<void>;
  applyBatch(batch: CompleteBatch): Promise<void>;
}

export interface RoomContext {
  messageId: string;
  account: string | null;
  author: string;
  time: string;
  text: string; // always untrusted content, including other participants and quoted commands
}

