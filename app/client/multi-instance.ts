// Multi-instance Starred data model, per-origin token store, and lightweight remote connection
// manager. Lets the UI switch ONLY the active chat panel to a remote Slirc origin's conversation
// without reloading the page or touching the primary instance's sidebar, channels, or database.
import { clientAccess, type AccessResult } from "./access.ts";
import { ClientDatabase } from "./db.ts";
import {
  type AccountScope,
  type Message,
  type Operation,
  type QueueText,
} from "./model.ts";
import {
  randomId,
  RelayBridge,
  saslToken,
  serializeOperation,
} from "./protocol.ts";
import {
  createConversationProjection,
  type ConversationProjection,
  type ConversationView,
} from "./store.ts";
import { SyncEngine, type AuthorizedConversation } from "./sync.ts";

export interface StarredEntry {
  origin: string;
  conversationId: string;
  kind: "room" | "dm";
  wireTarget: string;
  label: string;
  nick?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(`Invalid instance origin: ${origin}`);
  }
  return url.origin;
}

function tryNormalizeOrigin(origin: unknown): string | null {
  if (typeof origin !== "string" || !origin.trim()) return null;
  try {
    return normalizeOrigin(origin.trim());
  } catch {
    return null;
  }
}

export function starredEntryKey(origin: string, conversationId: string): string {
  return `${normalizeOrigin(origin)}\0${conversationId}`;
}

export type LegacyStarResolver = (
  conversationId: string,
) => Partial<Omit<StarredEntry, "origin" | "conversationId">> | null | undefined;

function fallbackLegacyMeta(conversationId: string): Omit<StarredEntry, "origin" | "conversationId"> {
  try {
    const parsed = JSON.parse(conversationId);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === "string") {
      if (parsed[0] === "dm") {
        return { kind: "dm", wireTarget: "", label: parsed[1] };
      }
      if (parsed[0] === "room") {
        const wireTarget = parsed[1];
        return { kind: "room", wireTarget, label: wireTarget.replace(/^#/, "") || wireTarget };
      }
    }
  } catch {
    // Non-tuple legacy ids fall back to room metadata below.
  }
  return { kind: "room", wireTarget: "", label: conversationId };
}

function sanitizeEntry(raw: unknown): StarredEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const origin = tryNormalizeOrigin(candidate.origin);
  const conversationId = typeof candidate.conversationId === "string" ? candidate.conversationId.trim() : "";
  const kind = candidate.kind === "room" || candidate.kind === "dm" ? candidate.kind : null;
  const wireTarget = typeof candidate.wireTarget === "string" ? candidate.wireTarget : "";
  const label = typeof candidate.label === "string" ? candidate.label : "";
  const nick = typeof candidate.nick === "string" && candidate.nick.trim() ? candidate.nick.trim() : undefined;
  if (!origin || !conversationId || !kind) return null;
  return {
    origin,
    conversationId,
    kind,
    wireTarget,
    label: label || wireTarget.replace(/^#/, "") || nick || conversationId,
    ...(nick ? { nick } : {}),
  };
}

export function deduplicateStarred(entries: readonly StarredEntry[]): StarredEntry[] {
  const seen = new Set<string>();
  const result: StarredEntry[] = [];
  for (const entry of entries) {
    const clean = sanitizeEntry(entry);
    if (!clean) continue;
    const key = starredEntryKey(clean.origin, clean.conversationId);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

/**
 * Parses starred entries from storage, migrating legacy `string[]` (`slirc2-starred:<accountId>`)
 * into structured `StarredEntry[]` scoped to `defaultOrigin`, deduplicated by `(origin, conversationId)`.
 */
export function parseStarredEntries(
  raw: string | null,
  defaultOrigin: string,
  resolveLegacy?: LegacyStarResolver,
): StarredEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const normalizedDefault = tryNormalizeOrigin(defaultOrigin);
  const entries: StarredEntry[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      const conversationId = item.trim();
      if (!conversationId || !normalizedDefault) continue;
      const fallback = fallbackLegacyMeta(conversationId);
      const resolved = resolveLegacy?.(conversationId) ?? null;
      const kind = resolved?.kind === "dm" || resolved?.kind === "room" ? resolved.kind : fallback.kind;
      const wireTarget = typeof resolved?.wireTarget === "string" ? resolved.wireTarget : fallback.wireTarget;
      const nick = typeof resolved?.nick === "string" && resolved.nick.trim() ? resolved.nick.trim() : undefined;
      const label = typeof resolved?.label === "string" && resolved.label.trim()
        ? resolved.label.trim()
        : fallback.label;
      entries.push({
        origin: normalizedDefault,
        conversationId,
        kind,
        wireTarget,
        label,
        ...(nick ? { nick } : {}),
      });
      continue;
    }
    const clean = sanitizeEntry(item);
    if (clean) entries.push(clean);
  }
  return deduplicateStarred(entries);
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

export class MultiInstanceStore {
  readonly accountId: string;
  readonly primaryOrigin: string;
  readonly starredStorageKey: string;
  readonly tokensStorageKey: string;
  private readonly storage: StorageLike | null;

  constructor(accountId: string, primaryOrigin: string, storage: StorageLike | null = defaultStorage()) {
    if (!accountId.trim()) throw new Error("accountId required");
    this.accountId = accountId.trim();
    this.primaryOrigin = normalizeOrigin(primaryOrigin);
    this.starredStorageKey = `slirc2-starred:${this.accountId}`;
    this.tokensStorageKey = `slirc2-instance-tokens:${this.accountId}`;
    this.storage = storage;
  }

  private readItem(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private writeItem(key: string, value: string | null): void {
    try {
      if (value === null) this.storage?.removeItem(key);
      else this.storage?.setItem(key, value);
    } catch {
      // Unavailable storage keeps in-memory callers working.
    }
  }

  getStarred(resolveLegacy?: LegacyStarResolver): StarredEntry[] {
    return parseStarredEntries(this.readItem(this.starredStorageKey), this.primaryOrigin, resolveLegacy);
  }

  setStarred(entries: readonly StarredEntry[]): StarredEntry[] {
    const clean = deduplicateStarred(entries);
    this.writeItem(this.starredStorageKey, clean.length ? JSON.stringify(clean) : null);
    return clean;
  }

  hasStarred(origin: string, conversationId: string): boolean {
    const normalized = tryNormalizeOrigin(origin);
    if (!normalized) return false;
    return this.getStarred().some(
      (entry) => entry.origin === normalized && entry.conversationId === conversationId,
    );
  }

  addStarred(entry: StarredEntry, resolveLegacy?: LegacyStarResolver): StarredEntry[] {
    const clean = sanitizeEntry(entry);
    if (!clean) throw new Error("Invalid StarredEntry");
    const existing = this.getStarred(resolveLegacy);
    const key = starredEntryKey(clean.origin, clean.conversationId);
    const next = existing.some((item) => starredEntryKey(item.origin, item.conversationId) === key)
      ? existing.map((item) => (starredEntryKey(item.origin, item.conversationId) === key ? clean : item))
      : [...existing, clean];
    return this.setStarred(next);
  }

  removeStarred(origin: string, conversationId: string, resolveLegacy?: LegacyStarResolver): StarredEntry[] {
    const normalized = tryNormalizeOrigin(origin);
    if (!normalized) return this.getStarred(resolveLegacy);
    const next = this.getStarred(resolveLegacy).filter(
      (item) => !(item.origin === normalized && item.conversationId === conversationId),
    );
    return this.setStarred(next);
  }

  toggleStarred(
    entry: StarredEntry,
    resolveLegacy?: LegacyStarResolver,
  ): { starred: boolean; entries: StarredEntry[] } {
    const clean = sanitizeEntry(entry);
    if (!clean) throw new Error("Invalid StarredEntry");
    const existing = this.getStarred(resolveLegacy);
    const key = starredEntryKey(clean.origin, clean.conversationId);
    if (existing.some((item) => starredEntryKey(item.origin, item.conversationId) === key)) {
      return {
        starred: false,
        entries: this.setStarred(existing.filter((item) => starredEntryKey(item.origin, item.conversationId) !== key)),
      };
    }
    return {
      starred: true,
      entries: this.setStarred([...existing, clean]),
    };
  }

  private readTokens(): Record<string, string> {
    const raw = this.readItem(this.tokensStorageKey);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        const origin = tryNormalizeOrigin(key);
        if (origin && typeof value === "string" && value.trim()) {
          clean[origin] = value.trim();
        }
      }
      return clean;
    } catch {
      return {};
    }
  }

  private writeTokens(tokens: Record<string, string>): void {
    const entries = Object.entries(tokens);
    this.writeItem(this.tokensStorageKey, entries.length ? JSON.stringify(tokens) : null);
  }

  getToken(origin: string): string | null {
    const normalized = tryNormalizeOrigin(origin);
    if (!normalized) return null;
    return this.readTokens()[normalized] ?? null;
  }

  setToken(origin: string, token: string): void {
    const normalized = normalizeOrigin(origin);
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Bearer token required");
    const tokens = this.readTokens();
    tokens[normalized] = trimmed;
    this.writeTokens(tokens);
  }

  removeToken(origin: string): void {
    const normalized = tryNormalizeOrigin(origin);
    if (!normalized) return;
    const tokens = this.readTokens();
    if (!(normalized in tokens)) return;
    delete tokens[normalized];
    this.writeTokens(tokens);
  }

  listOrigins(): string[] {
    return Object.keys(this.readTokens());
  }

  clearTokens(): void {
    this.writeItem(this.tokensStorageKey, null);
  }
}

export type RemoteInstanceStatus = "idle" | "connecting" | "connected" | "auth-failed" | "disconnected";

export interface RemoteInstanceSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export interface RemoteInstanceClientOptions {
  origin: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  createWebSocket?: (url: string, protocols?: string | string[]) => RemoteInstanceSocket;
  onStatusChange?: (status: RemoteInstanceStatus) => void;
  onView?: (view: ConversationView) => void;
  onReady?: (conversation: AuthorizedConversation) => void;
  onError?: (error: Error) => void;
  namesProbeMs?: number;
}

const WS_OPEN = 1;

export function relayWebSocketUrl(origin: string): string {
  const url = new URL(normalizeOrigin(origin));
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${url.host}/irc`;
}

/**
 * Lightweight connection manager for a single remote Slirc instance.
 * Authenticates via Bearer token (never cookies), opens its own `(origin, accountId)`-scoped
 * ClientDatabase, syncs authorized conversations over the remote WebSocket relay, and exposes
 * conversation views and message sending without affecting the primary instance.
 */
export class RemoteInstanceClient {
  readonly origin: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly createWebSocket: (url: string, protocols?: string | string[]) => RemoteInstanceSocket;
  private readonly opts: RemoteInstanceClientOptions;

  status: RemoteInstanceStatus = "idle";
  scope: AccountScope | null = null;
  db: ClientDatabase | null = null;
  conversations: AuthorizedConversation[] = [];
  directs: { nick: string; channel: string }[] = [];
  accountDetails: unknown[] = [];

  private socket: RemoteInstanceSocket | null = null;
  private bridge: RelayBridge | null = null;
  private sync: SyncEngine | null = null;
  private projection: ConversationProjection | null = null;
  private viewUnsubscribe: (() => void) | null = null;
  private viewListeners = new Set<(view: ConversationView) => void>();
  private selectedConversationId: string | null = null;
  private selectedFocusServerId: string | undefined;
  private epoch = 0;

  constructor(options: RemoteInstanceClientOptions) {
    this.origin = normalizeOrigin(options.origin);
    if (!options.token.trim()) throw new Error("Bearer token required");
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.createWebSocket = options.createWebSocket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as RemoteInstanceSocket);
    this.opts = options;
    if (options.onView) this.viewListeners.add(options.onView);
  }

  private setStatus(next: RemoteInstanceStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.opts.onStatusChange?.(next);
  }

  private wireSend(line: string): boolean {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return false;
    this.socket.send(`${line}\r\n`);
    return true;
  }

  async connect(): Promise<AccessResult> {
    const runEpoch = ++this.epoch;
    this.setStatus("connecting");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}/auth/me`, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });
    } catch (error) {
      if (runEpoch !== this.epoch) return { ok: false, reason: "Connection superseded." };
      this.setStatus("disconnected");
      const err = error instanceof Error ? error : new Error("Failed to reach remote instance.");
      this.opts.onError?.(err);
      return { ok: false, reason: err.message };
    }

    if (runEpoch !== this.epoch) return { ok: false, reason: "Connection superseded." };
    if (!response.ok) {
      this.setStatus("auth-failed");
      return { ok: false, reason: `Remote auth failed (${response.status}).` };
    }

    const me = await response.json().catch(() => null);
    if (runEpoch !== this.epoch) return { ok: false, reason: "Connection superseded." };

    const access = clientAccess(me, this.origin);
    if (!access.ok) {
      this.setStatus("auth-failed");
      return access;
    }

    const allAuthorized: AuthorizedConversation[] = [
      ...access.conversations,
      ...access.threads.map((thread) => ({
        conversationId: thread.conversationId,
        wireTarget: thread.channel,
        kind: "thread" as const,
      })),
    ];

    this.conversations = allAuthorized;
    this.directs = Array.isArray((me as { directs?: unknown })?.directs)
      ? ((me as { directs: { nick: string; channel: string }[] }).directs)
      : [];
    this.accountDetails = Array.isArray((me as { accountDetails?: unknown })?.accountDetails)
      ? ((me as { accountDetails: unknown[] }).accountDetails)
      : [];

    const scopeChanged =
      !this.scope ||
      this.scope.instance !== access.scope.instance ||
      this.scope.accountId !== access.scope.accountId;

    if (scopeChanged) {
      this.closeProjection();
      this.db?.close();
      this.scope = access.scope;
      this.db = new ClientDatabase(access.scope);
      this.projection = createConversationProjection(this.db);
      this.viewUnsubscribe = this.projection.view.subscribe((view) => {
        for (const listener of this.viewListeners) listener(view);
      });
      if (this.selectedConversationId) {
        this.projection.select(this.selectedConversationId, this.selectedFocusServerId);
      }
      this.sync = new SyncEngine({
        db: this.db,
        send: (line) => this.wireSend(line),
        nick: access.scope.account,
        namesProbeMs: this.opts.namesProbeMs,
        hooks: {
          onReady: (conversation) => this.opts.onReady?.(conversation),
          onError: (_conversation, error) => this.opts.onError?.(error),
        },
      });
    }

    this.sync?.recover(allAuthorized);
    this.openSocket(access.scope.account, runEpoch);
    return access;
  }

  private openSocket(nick: string, runEpoch: number): void {
    this.closeSocket();
    const ws = this.createWebSocket(relayWebSocketUrl(this.origin), [`slirc-token.${this.token}`]);
    this.socket = ws;
    this.bridge = new RelayBridge({
      nick,
      saslToken: saslToken(nick),
      send: (line) => {
        if (this.socket === ws && ws.readyState === WS_OPEN) ws.send(`${line}\r\n`);
      },
      push: (line) => {
        if (this.socket !== ws || runEpoch !== this.epoch) return;
        this.sync?.push(line);
      },
      onAuthenticated: () => {
        if (this.socket === ws && runEpoch === this.epoch) this.setStatus("connected");
      },
      onAuthFailed: (reason) => {
        if (this.socket !== ws || runEpoch !== this.epoch) return;
        this.setStatus("auth-failed");
        this.opts.onError?.(new Error(reason));
      },
    });

    ws.onopen = () => {
      if (this.socket !== ws || runEpoch !== this.epoch) return;
      this.bridge?.onOpen();
    };
    if (ws.readyState === WS_OPEN) {
      this.bridge.onOpen();
    }
    ws.onmessage = (event) => {
      if (this.socket !== ws || runEpoch !== this.epoch) return;
      this.bridge?.feed(typeof event.data === "string" ? event.data : "");
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.sync?.onDisconnect();
      if (this.status !== "auth-failed") this.setStatus("disconnected");
    };
    ws.onerror = () => {
      if (this.socket !== ws || runEpoch !== this.epoch) return;
      this.opts.onError?.(new Error(`WebSocket error for ${this.origin}`));
    };
  }

  private closeSocket(): void {
    if (!this.socket) return;
    const prev = this.socket;
    this.socket = null;
    this.bridge = null;
    try {
      prev.close();
    } catch {
      // Ignore already-closed sockets.
    }
  }

  private closeProjection(): void {
    this.viewUnsubscribe?.();
    this.viewUnsubscribe = null;
    this.projection?.dispose();
    this.projection = null;
  }

  selectConversation(conversationId: string | null, focusServerId?: string): void {
    this.selectedConversationId = conversationId;
    this.selectedFocusServerId = focusServerId;
    this.projection?.select(conversationId, focusServerId);
  }

  subscribeView(listener: (view: ConversationView) => void): () => void {
    this.viewListeners.add(listener);
    if (this.projection) listener(this.projection.view.get());
    return () => {
      this.viewListeners.delete(listener);
    };
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    if (!this.db) return [];
    const rows = await this.db.messages
      .where("conversationId")
      .equals(conversationId)
      .filter((message) => !message.deleted)
      .toArray();
    return rows.sort((a, b) => (a.time === b.time ? a.id.localeCompare(b.id) : a.time.localeCompare(b.time)));
  }

  isReady(conversationId: string): boolean {
    return this.sync?.isReady(conversationId) ?? false;
  }

  async sendMessage(
    conversationId: string,
    text: string,
    options: { replyTo?: string; editOf?: string } = {},
  ): Promise<Operation> {
    if (!this.db || !this.scope) throw new Error("Remote instance is not connected");
    const conversation = this.conversations.find((item) => item.conversationId === conversationId);
    if (!conversation) throw new Error(`Conversation not authorized on ${this.origin}: ${conversationId}`);
    if (!this.socket || this.socket.readyState !== WS_OPEN) throw new Error(`Socket not open for ${this.origin}`);

    const operationId = randomId();
    const messageId = randomId();
    const now = Date.now();
    const operation: Operation = {
      id: operationId,
      messageId,
      conversationId,
      kind: "text",
      text,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.editOf ? { editOf: options.editOf } : {}),
      state: "queued",
      createdAt: now,
    };
    const multiline = this.bridge?.enabled.has("draft/multiline") ?? false;
    const lines = serializeOperation(operation, conversation.wireTarget, multiline);
    const send: QueueText = {
      message: {
        id: messageId,
        conversationId,
        clientId: operationId,
        authorAccount: this.scope.account,
        authorNick: this.scope.account,
        text,
        time: new Date(now).toISOString(),
        state: "queued",
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      },
      operation,
      draftRevision: `remote-${operationId}`,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.editOf ? { editOf: options.editOf } : {}),
    };
    await this.db.queueText(send);
    for (const line of lines) {
      if (!this.wireSend(line)) {
        throw new Error(`Failed to write IRC line to ${this.origin}`);
      }
    }
    return operation;
  }

  disconnect(): void {
    this.epoch += 1;
    this.closeSocket();
    this.sync?.onDisconnect();
    this.sync = null;
    this.closeProjection();
    this.db?.close();
    this.db = null;
    this.scope = null;
    this.setStatus("disconnected");
  }
}

export class RemoteInstanceManager {
  private readonly store: MultiInstanceStore;
  private readonly clients = new Map<string, RemoteInstanceClient>();
  private readonly defaults: Pick<RemoteInstanceClientOptions, "fetch" | "createWebSocket" | "namesProbeMs">;
  activeTarget: { origin: string; conversationId: string } | null = null;

  constructor(
    store: MultiInstanceStore,
    defaults: Pick<RemoteInstanceClientOptions, "fetch" | "createWebSocket" | "namesProbeMs"> = {},
  ) {
    this.store = store;
    this.defaults = defaults;
  }

  get(origin: string): RemoteInstanceClient | undefined {
    const normalized = tryNormalizeOrigin(origin);
    return normalized ? this.clients.get(normalized) : undefined;
  }

  async connect(
    origin: string,
    overrides: Partial<Omit<RemoteInstanceClientOptions, "origin" | "token">> = {},
  ): Promise<{ client: RemoteInstanceClient; access: AccessResult }> {
    const normalized = normalizeOrigin(origin);
    const token = this.store.getToken(normalized);
    if (!token) throw new Error(`No bearer token stored for ${normalized}`);
    let client = this.clients.get(normalized);
    if (!client) {
      client = new RemoteInstanceClient({
        origin: normalized,
        token,
        ...this.defaults,
        ...overrides,
      });
      this.clients.set(normalized, client);
    }
    const access = await client.connect();
    return { client, access };
  }

  async openConversation(
    origin: string,
    conversationId: string,
    overrides: Partial<Omit<RemoteInstanceClientOptions, "origin" | "token">> = {},
  ): Promise<{ client: RemoteInstanceClient; access?: AccessResult }> {
    const normalized = normalizeOrigin(origin);
    let client = this.clients.get(normalized);
    let access: AccessResult | undefined;
    if (!client || client.status === "idle" || client.status === "disconnected") {
      const result = await this.connect(normalized, overrides);
      client = result.client;
      access = result.access;
    }
    this.activeTarget = { origin: normalized, conversationId };
    client.selectConversation(conversationId);
    return { client, access };
  }

  disconnect(origin: string): void {
    const normalized = tryNormalizeOrigin(origin);
    if (!normalized) return;
    const client = this.clients.get(normalized);
    if (!client) return;
    client.disconnect();
    this.clients.delete(normalized);
    if (this.activeTarget?.origin === normalized) this.activeTarget = null;
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) client.disconnect();
    this.clients.clear();
    this.activeTarget = null;
  }
}
