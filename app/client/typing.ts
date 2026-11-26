import { type IrcMessage } from "@client/irc.ts";

// IRCv3 typing indicators over the existing live IRC connection. This module is deliberately
// ephemeral: nothing here touches Dexie, the outbox or the message/reaction stores, and it is only
// fed from the live hook, never from a chathistory page. The wire tag is the client-only `+typing`
// (values active/paused/done); `+draft/typing` is accepted on receive for draft-era peers.
export type TypingValue = "active" | "paused" | "done";

const TYPING_TAGS = ["+typing", "+draft/typing"] as const;
const TYPING_VALUES = new Set<string>(["active", "paused", "done"]);

// First tag wins, so a peer that sends both (as replies do) is read once, in spec order.
export function typingValue(tags: Record<string, string | undefined>): TypingValue | null {
  for (const tag of TYPING_TAGS) {
    const raw = tags[tag];
    if (raw === undefined) continue;
    return TYPING_VALUES.has(raw) ? raw as TypingValue : null;
  }
  return null;
}

export function typingLine(target: string, value: TypingValue): string {
  return `@+typing=${value} TAGMSG ${target}`;
}

export function typingAccount(message: IrcMessage): string {
  return String(message.tags.account ?? "").trim();
}

export interface TypingOptions {
  /** Immutable signed-in account; its own typing is never displayed. */
  self: () => string;
  /** Only conversations the current grant authorizes may carry typing state. */
  isAuthorized: (conversationId: string) => boolean;
  /** The visible conversation, read reactively so the row follows navigation. */
  current: () => string | null;
  /** Name to show for a typer: an agent's display name, else the account as is. */
  label?: (account: string) => string;
  /** Best-effort send; the runtime owns socket, capability, ownership and readiness gates. */
  send: (value: TypingValue) => void;
  ttlMs?: number;
  refreshMs?: number;
  idleMs?: number;
  maxTypers?: number;
  now?: () => number;
}

// Receiver and sender state in one cohesive owner. Receiver buckets expire on their own timers; the
// sender is throttled and only ever emits active/paused/done, never a body, draft or queued item.
export function createTypingIndicators(reactive: <T extends object>(value: T) => T, options: TypingOptions) {
  const self = options.self;
  const isAuthorized = options.isAuthorized;
  const current = options.current;
  const label = options.label ?? ((account: string) => account);
  const send = options.send;
  const ttlMs = options.ttlMs ?? 6_000;
  const refreshMs = options.refreshMs ?? 3_000;
  const idleMs = options.idleMs ?? 4_000;
  const maxTypers = options.maxTypers ?? 6;
  const now = options.now ?? (() => Date.now());

  let buckets = new Map<string, Map<string, number>>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let localState: "active" | "paused" | null = null;
  let lastActiveAt = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const local = reactive({ byConversation: {} as Record<string, string[]> });

  function timerKey(conversationId: string, account: string): string {
    return `${conversationId}\n${account}`;
  }

  function clearExpiry(conversationId: string, account: string): void {
    const key = timerKey(conversationId, account);
    const timer = expiryTimers.get(key);
    if (timer) { clearTimeout(timer); expiryTimers.delete(key); }
  }

  function publish(conversationId: string): void {
    const bucket = buckets.get(conversationId);
    const next = { ...local.byConversation };
    if (bucket?.size) next[conversationId] = [...bucket.keys()].reverse();
    else delete next[conversationId];
    local.byConversation = next;
  }

  function remove(conversationId: string, account: string): boolean {
    const bucket = buckets.get(conversationId);
    if (!bucket?.delete(account)) return false;
    clearExpiry(conversationId, account);
    if (!bucket.size) buckets.delete(conversationId);
    publish(conversationId);
    return true;
  }

  function expire(conversationId: string, account: string): void {
    // Only the current timer for this key can fire; a refresh clears the old one in armExpiry.
    clearExpiry(conversationId, account);
    const bucket = buckets.get(conversationId);
    if (bucket?.has(account)) remove(conversationId, account);
  }

  function armExpiry(conversationId: string, account: string): void {
    const key = timerKey(conversationId, account);
    const existing = expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    expiryTimers.set(key, setTimeout(() => expire(conversationId, account), ttlMs));
  }

  /** Apply one live typing value. Missing/unknown values, self and unauthorized targets are ignored. */
  function observe(conversationId: string, account: string, value: TypingValue | null): void {
    if (!value) return;
    const who = String(account || "").trim().toLowerCase();
    if (!who || who === String(self() || "").trim().toLowerCase()) return;
    if (!isAuthorized(conversationId)) return;
    if (value !== "active") { remove(conversationId, who); return; }
    let bucket = buckets.get(conversationId);
    if (!bucket) { bucket = new Map(); buckets.set(conversationId, bucket); }
    // Bound stale/spoofed senders: keep the most recent set and evict the oldest account.
    if (!bucket.has(who) && bucket.size >= maxTypers) {
      const oldest = bucket.keys().next().value;
      if (oldest !== undefined) { bucket.delete(oldest); clearExpiry(conversationId, oldest); }
    }
    bucket.delete(who);
    bucket.set(who, now() + ttlMs);
    armExpiry(conversationId, who);
    publish(conversationId);
  }

  function observeMessage(conversationId: string, message: IrcMessage): void {
    observe(conversationId, typingAccount(message), typingValue(message.tags));
  }

  /** An incoming message ends its author's typing state immediately. */
  function clear(conversationId: string, account: string): void {
    remove(conversationId, String(account || "").trim().toLowerCase());
  }

  function clearConversation(conversationId: string): void {
    const bucket = buckets.get(conversationId);
    if (!bucket) return;
    for (const account of bucket.keys()) clearExpiry(conversationId, account);
    buckets.delete(conversationId);
    publish(conversationId);
  }

  function clearAll(): void {
    for (const timer of expiryTimers.values()) clearTimeout(timer);
    expiryTimers.clear();
    buckets = new Map();
    local.byConversation = {};
  }

  function armIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (localState !== "active") return;
      localState = "paused";
      send("paused");
    }, idleMs);
  }

  function active(): void {
    const at = now();
    if (localState === "active" && at - lastActiveAt < refreshMs) { armIdle(); return; }
    lastActiveAt = at;
    localState = "active";
    armIdle();
    send("active");
  }

  /** Composer text: non-empty keeps us active (throttled), empty is a clean stop. */
  function noteTyping(text: string): void {
    if (String(text ?? "").trim()) active();
    else stopTyping();
  }

  /** User stopped: send done once, never repeat. */
  function stopTyping(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (localState === null) return;
    localState = null;
    lastActiveAt = 0;
    send("done");
  }

  /** Disconnect/account switch/teardown: drop received state without trying to send. */
  function reset(): void {
    stopLocal();
    clearAll();
  }

  // Drop local sender bookkeeping silently (used by reset; stopTyping would emit a wire line).
  function stopLocal(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    localState = null;
    lastActiveAt = 0;
  }

  function accounts(): string[] {
    const conversationId = current();
    return conversationId ? local.byConversation[conversationId] ?? [] : [];
  }

  function statusText(): string {
    const list = accounts().map(label);
    if (list.length === 0) return "";
    if (list.length === 1) return `${list[0]} is typing`;
    if (list.length === 2) return `${list[0]} and ${list[1]} are typing`;
    return `${list.length} people are typing`;
  }

  return Object.assign(local, {
    observe, observeMessage, clear, clearConversation, clearAll,
    noteTyping, stopTyping, reset, destroy: reset,
    accounts, statusText, label,
  });
}
