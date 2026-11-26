import { conversationId, foldIdentifier, type Message, type QueueText } from "@client/model.ts";
import { type AuthorizedConversation } from "@client/sync.ts";
import { messageLinkLabel, routeUrl, type Screen } from "@client/navigation.ts";
import { mountUrl } from "@client/presentation.ts";
import { type ThreadGrant } from "@client/access.ts";
import { queuedTextFor } from "@client/drafts.ts";

const THREAD_CHANNEL_FROM_API = /^#t-[a-z0-9]{6}$/i;

export function expandedThreadParent(activeThreadParent: string | undefined, activeWireTarget: string | undefined): string {
  return activeThreadParent || activeWireTarget || "";
}

// Channels whose rail threads the member folded by clicking the open channel again. Folded names.
export function toggleCollapsedParent(collapsed: readonly string[], parent: string): string[] {
  const folded = foldIdentifier(parent);
  return collapsed.includes(folded) ? collapsed.filter((entry) => entry !== folded) : [...collapsed, folded];
}

export function threadsUnderParent(threads: readonly ThreadGrant[], parent: string): ThreadGrant[] {
  if (!parent) return [];
  const folded = foldIdentifier(parent);
  return threads
    .filter((thread) => foldIdentifier(thread.parent) === folded)
    .sort((a, b) => b.lastActivity - a.lastActivity || a.channel.localeCompare(b.channel));
}

export interface NestedThreads { shown: ThreadGrant[]; overflow: number }

export function nestedThreads(threads: readonly ThreadGrant[], parent: string, limit = 2): NestedThreads {
  const all = threadsUnderParent(threads, parent);
  return { shown: all.slice(0, limit), overflow: Math.max(0, all.length - limit) };
}

export function filterThreadPalette(threads: readonly ThreadGrant[], query: string): ThreadGrant[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...threads];
  return threads.filter((thread) => thread.title.toLowerCase().includes(needle) || thread.channel.toLowerCase().includes(needle));
}

export function clampThreadIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

export function threadForRoot(threads: readonly ThreadGrant[], parent: string, root: string | undefined): ThreadGrant | undefined {
  if (!parent || !root) return undefined;
  const folded = foldIdentifier(parent);
  return threads.find((thread) => foldIdentifier(thread.parent) === folded && thread.root === root);
}

export function threadRootTextDiffers(title: string | undefined, rootText: string | undefined): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return normalize(rootText ?? "") !== normalize(title ?? "");
}

export function threadTitleFromText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 60);
}

// "Reply in thread" opens this view at once while the server creates the child channel. The
// composer is held off the parent's draft until then; `savedText` is that untouched draft.
export interface PendingThread {
  messageId: string;
  conversationId: string;
  title: string;
  parentLabel: string;
  rootText: string;
  roomLabel: string;
  savedText: string;
  sendOnReady: boolean;
}

// What the parent composer shows when a pending thread is abandoned (creation failed or the reader
// left): its own draft, then the text typed for the thread, so neither is lost.
export function pendingThreadFallbackText(savedText: string, typedText: string): string {
  return [savedText, typedText].filter((text) => text.trim()).join("\n");
}

export function threadGrantFromResponse(row: unknown, parentWire: string, parentLabel: string): ThreadGrant | null {
  const raw = (row ?? {}) as Record<string, unknown>;
  const channel = typeof raw.channel === "string" ? raw.channel.trim() : "";
  const parent = typeof raw.parent === "string" ? raw.parent.trim() : "";
  const root = typeof raw.root === "string" ? raw.root : "";
  if (!THREAD_CHANNEL_FROM_API.test(channel) || !parent || !root) return null;
  if (foldIdentifier(parent) !== foldIdentifier(parentWire)) return null;
  const rootText = typeof raw.rootText === "string" ? raw.rootText : "";
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : rootText.trim() || channel;
  return {
    channel,
    conversationId: conversationId("thread", channel),
    parent,
    parentLabel,
    title,
    root,
    rootNick: typeof raw.rootNick === "string" ? raw.rootNick : "",
    rootText,
    rootTime: typeof raw.rootTime === "string" ? raw.rootTime : "",
    lastActivity: typeof raw.lastActivity === "number" ? raw.lastActivity : Date.now(),
    createdBy: typeof raw.createdBy === "string" ? raw.createdBy : "",
  };
}

// A DM link names the DM's channel, which is the same for both people (`#dm-first-second` or its
// hash), not the peer's nick, which is the other person's own nick when they open it. The opener
// resolves the channel to their side of the DM. `nick` is the fallback for a DM without a channel.
export function threadSourceUrl(kind: "room" | "dm", parentWire: string, nick: string, messageServerId: string, replyThread = false): string {
  const thread = replyThread ? { thread: true as const } : {};
  const screen: Screen = kind === "dm" && !/^#dm-/i.test(parentWire)
    ? { kind: "dm", nick, focusMessageId: messageServerId, ...thread }
    : { kind: "room", room: parentWire, focusMessageId: messageServerId, ...thread };
  return mountUrl(routeUrl(screen));
}

// The link is absolute so it opens from an IRC client or a phone, and the web client shows it as
// a "View in" link like any other message link.
export function threadAnnouncementText(channel: string, sourceUrl: string, origin: string): string {
  return `↳ thread ${channel} — ${new URL(sourceUrl, origin).href}`;
}

// Announcements posted before the link was absolute end in a bare path, which no client turns into
// a link. For display, a bare path that is a message route on this instance becomes an absolute link.
const PATH_ANNOUNCEMENT = /^(↳ thread #t-\S+ — )(\/\S*)$/;
export function threadAnnouncementDisplayText(text: string, origin: string): string {
  const match = PATH_ANNOUNCEMENT.exec(text);
  if (!match || !messageLinkLabel(match[2]!, origin)) return text;
  return match[1]! + new URL(match[2]!, origin).href;
}

// The server makes admins IRC channel operators in channels and the threads under them, so Ergo
// accepts an admin's own REDACT there. DMs, private groups, threads under those, and a thread this
// client cannot place go through the server's moderation route instead.
export function adminDeletesOverIrc(conversation: AuthorizedConversation | undefined, threads: readonly Pick<ThreadGrant, "conversationId" | "parent">[]): boolean {
  if (!conversation || conversation.kind === "dm") return false;
  const channel = conversation.kind === "thread" ? threads.find((thread) => thread.conversationId === conversation.conversationId)?.parent : conversation.wireTarget;
  return !!channel && channel.startsWith("#") && !/^#(?:dm|g|t)-/i.test(channel);
}

export function threadRootContextText(nick: string, parentDisplay: string, rootText: string): string {
  return `↳ ${nick} in ${parentDisplay}\n${rootText}`;
}

export function threadOperationId(kind: "announce" | "root", channel: string): string {
  return `thread-${kind}:${channel}`;
}

export function isHiddenThreadAnnouncement(
  message: Message,
  threads: readonly ThreadGrant[],
  conversations: readonly AuthorizedConversation[],
  messages: readonly Message[],
): boolean {
  if (!message.clientId?.startsWith("thread-announce:") || message.state === "failed" || message.state === "uncertain") return false;
  const thread = threads.find((item) => threadOperationId("announce", item.channel) === message.clientId);
  if (!thread || (message.replyTo && message.replyTo !== thread.root)) return false;
  const parent = conversations.find((item) => item.kind !== "thread" && foldIdentifier(item.wireTarget) === foldIdentifier(thread.parent));
  return !!parent && message.conversationId === parent.conversationId &&
    messages.some((item) => item.conversationId === parent.conversationId && item.serverId === thread.root && item.state === "confirmed");
}

export function isDuplicateQueueError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : "";
  return name === "ConstraintError" || /already exists|ConstraintError/i.test(message);
}

export interface ThreadContextResult { error?: string }

export async function enqueueThreadContext(options: {
  db: { messages: { get(id: string): Promise<unknown> }; operations: { get(id: string): Promise<unknown> } };
  enqueue(send: QueueText): Promise<unknown>;
  account: string;
  parentConversationId: string;
  parentDisplay: string;
  channel: string;
  rootConversationId: string;
  rootNick: string;
  rootText: string;
  rootServerId: string;
  sourceUrl: string;
  origin: string;
  now?: () => number;
}): Promise<ThreadContextResult> {
  const now = options.now ?? Date.now;
  const entries: Array<{ conversationId: string; id: string; text: string; replyTo?: string }> = [
    { conversationId: options.parentConversationId, id: threadOperationId("announce", options.channel), text: threadAnnouncementText(options.channel, options.sourceUrl, options.origin), replyTo: options.rootServerId },
    { conversationId: options.rootConversationId, id: threadOperationId("root", options.channel), text: threadRootContextText(options.rootNick, options.parentDisplay, options.rootText) },
  ];
  const failures: string[] = [];
  for (const entry of entries) {
    if (await options.db.messages.get(entry.id) || await options.db.operations.get(entry.id)) continue;
    const send = queuedTextFor(entry.conversationId, options.account, { text: entry.text, revision: `ctx:${entry.id}` }, entry.id, now(), undefined, undefined, entry.replyTo);
    try {
      await options.enqueue(send);
    } catch (error) {
      if (isDuplicateQueueError(error)) continue;
      failures.push(error instanceof Error ? error.message : "could not queue context message");
    }
  }
  return failures.length ? { error: `Thread created, but its context messages could not be queued: ${failures.join("; ")}` } : {};
}
