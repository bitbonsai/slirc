import { type Message } from "@client/model.ts";

const LEGACY_ANNOUNCEMENT_TEXT = /^↳ thread #t-[a-z0-9]{6}\b/i;

export interface ReplyThreadSummary {
  rootId: string;
  count: number;
  participants: string[];
  lastTime: string;
}

export interface ReplyIndex {
  byServerId: Map<string, Message>;
  rootByMessageId: Map<string, string>;
  repliesByRootId: Map<string, Message[]>;
  hiddenMessageIds: Set<string>;
}

export function isLegacyThreadAnnouncement(message: Message): boolean {
  if (message.clientId?.startsWith("thread-announce:")) return true;
  return LEGACY_ANNOUNCEMENT_TEXT.test(message.text);
}

// Build a per-conversation index of IRCv3 `+reply` threads from the currently loaded messages.
// Replies are flattened to their top-level root message (like Slack), even if an external IRC
// client replies to a child message. Messages whose root is present in the loaded window are
// hidden from the main timeline unless explicitly marked `broadcast` (+slirc/broadcast=1).
export function buildReplyIndex(messages: readonly Message[]): ReplyIndex {
  const byServerId = new Map<string, Message>();
  for (const message of messages) {
    if (message.deleted) continue;
    if (message.serverId) byServerId.set(message.serverId, message);
    for (const oldId of message.chain ?? []) {
      if (oldId && !byServerId.has(oldId)) byServerId.set(oldId, message);
    }
  }

  const rootByMessageId = new Map<string, string>();
  const repliesByRootId = new Map<string, Message[]>();
  const hiddenMessageIds = new Set<string>();

  for (const message of messages) {
    if (message.deleted || !message.replyTo || isLegacyThreadAnnouncement(message)) continue;
    // Walk up replyTo links to flatten multi-level replies to the top-level root.
    let targetId: string | undefined = message.replyTo;
    let rootMessage: Message | undefined;
    const seen = new Set<string>();
    for (let depth = 0; depth < 16 && targetId; depth += 1) {
      if (seen.has(targetId)) break;
      seen.add(targetId);
      const candidate = byServerId.get(targetId);
      if (!candidate) break;
      rootMessage = candidate;
      if (!candidate.replyTo || isLegacyThreadAnnouncement(candidate)) break;
      targetId = candidate.replyTo;
    }

    if (!rootMessage?.serverId) continue;
    // Never treat a message as a reply to itself.
    if (rootMessage.id === message.id) continue;

    const rootId = rootMessage.serverId;
    rootByMessageId.set(message.id, rootId);
    const list = repliesByRootId.get(rootId);
    if (list) list.push(message);
    else repliesByRootId.set(rootId, [message]);

    if (!message.broadcast) hiddenMessageIds.add(message.id);
  }

  return { byServerId, rootByMessageId, repliesByRootId, hiddenMessageIds };
}

export function replyThreadSummary(index: ReplyIndex, rootMessage: Message): ReplyThreadSummary | null {
  const rootId = rootMessage.serverId;
  if (!rootId) return null;
  const replies = index.repliesByRootId.get(rootId);
  if (!replies || replies.length === 0) return null;
  const participants: string[] = [];
  const seen = new Set<string>();
  for (const reply of replies) {
    const key = (reply.authorNick || reply.authorAccount || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    participants.push(reply.authorNick || reply.authorAccount);
    if (participants.length >= 4) break;
  }
  return {
    rootId,
    count: replies.length,
    participants,
    lastTime: replies[replies.length - 1]!.time,
  };
}

export function replyThreadReplies(index: ReplyIndex, rootId: string): Message[] {
  if (!rootId) return [];
  const root = index.byServerId.get(rootId);
  const key = root?.serverId ?? rootId;
  return index.repliesByRootId.get(key) ?? [];
}

export function replyThreadRoot(index: ReplyIndex, rootId: string): Message | null {
  if (!rootId) return null;
  return index.byServerId.get(rootId) ?? null;
}

export function broadcastParent(index: ReplyIndex, message: Message): Message | null {
  if (!message.broadcast) return null;
  const rootId = index.rootByMessageId.get(message.id);
  if (!rootId) return null;
  return index.byServerId.get(rootId) ?? null;
}
