import { type AccountScope } from "@client/model.ts";
import { type Composer } from "@client/drafts.ts";
import { type Outbox } from "@client/outbox.ts";
import { type RelayBridge } from "@client/protocol.ts";
import { type AuthorizedConversation, type SyncEngine } from "@client/sync.ts";
import { type ClientDatabase } from "@client/db.ts";
import { type ConversationProjection, type UnreadProjection } from "@client/store.ts";

// A first-contact DM the server has not authorized yet, keyed by the account-scoped conversation
// id. Pending is local enqueue permission only and never enters `authorized`.
export interface PendingDm { nick: string; accountId: string; state: "provisioning" | "failed"; error?: string }

// Mutable account, connection and conversation state that several runtime modules read. The
// runtime owns the one instance; modules take it, or a Pick of it, as a typed input.
export interface RuntimeState {
  db: ClientDatabase | null;
  outbox: Outbox | null;
  sync: SyncEngine | null;
  bridge: RelayBridge | null;
  composer: Composer | null;
  socket: WebSocket | null;
  scope: AccountScope | null;
  // Open conversation id, or null when no conversation is showing.
  roomId: string | null;
  currentScope: string;
  // Immutable account id from the latest /auth/me, kept even when access is denied for zero
  // conversations. The join acceptance compares this instead of the mutable scope key.
  authenticatedAccountId: string;
  // Blocks callbacks during teardown or after a real unload.
  stopped: boolean;
  // BFCache freeze: socket closed, durable state kept for resume.
  suspended: boolean;
  signingOut: boolean;
  // The open scope's conversation and unread projections over its database.
  projection: ConversationProjection | null;
  unreadProjection: UnreadProjection | null;
  // The latest connect run, so a live event can wait for it instead of superseding it mid-flight.
  connecting: Promise<void>;
  // Bumped by every connect run and every socket close, so a late /auth/me answer can tell it was superseded.
  connectEpoch: number;
  // Bumped by every deliberate navigation, so a slow open that finished late can tell it was superseded.
  navIntent: number;
  capsOk: boolean;
  authorized: AuthorizedConversation[];
  directories: Map<string, AuthorizedConversation>;
  pendingDms: Map<string, PendingDm>;
  composerTextByConversation: Map<string, string>;
  // Read markers the server pushed on this connection ("" for `*`), set synchronously so a first-sync
  // seed never jumps ahead of a server marker whose Dexie write is still in flight.
  serverMarkers: Map<string, string>;
}

export function createRuntimeState(): RuntimeState {
  return {
    db: null,
    outbox: null,
    sync: null,
    bridge: null,
    composer: null,
    socket: null,
    scope: null,
    roomId: null,
    currentScope: "",
    authenticatedAccountId: "",
    stopped: false,
    suspended: false,
    signingOut: false,
    projection: null,
    unreadProjection: null,
    connecting: Promise.resolve(),
    connectEpoch: 0,
    navIntent: 0,
    capsOk: true,
    authorized: [],
    directories: new Map(),
    pendingDms: new Map(),
    composerTextByConversation: new Map(),
    serverMarkers: new Map(),
  };
}
