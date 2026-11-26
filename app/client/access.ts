import { conversationId, foldIdentifier, scopeKey, type AccountScope, type Operation } from "@client/model.ts";
import { type AuthorizedConversation } from "@client/sync.ts";
import { DEV_CHANNEL } from "@client/protocol.ts";

export function defaultConversationIdFor(authorized: readonly AuthorizedConversation[]): string | null {
  const item = authorized.find((entry) => entry.kind === "room" && foldIdentifier(entry.wireTarget) === foldIdentifier(DEV_CHANNEL))
    ?? authorized.find((entry) => entry.kind === "room")
    ?? authorized.find((entry) => entry.kind === "dm");
  return item?.conversationId ?? null;
}

export function contactsWithoutDirects(contacts: readonly string[], directs: readonly { nick: string }[]): string[] {
  const existing = new Set(directs.map((direct) => foldIdentifier(direct.nick)));
  return contacts.filter((nick) => !existing.has(foldIdentifier(nick)));
}

// A cached direct row may only short-circuit a reopen while the last authoritative access set still
// lists its conversation. A row the server no longer authorizes (deleted or revoked) must fall
// through to a fresh POST instead of being replayed from local cache.
export function cachedDirectIsAuthorized(direct: { channel: string } | undefined, authorized: readonly AuthorizedConversation[]): boolean {
  return !!direct && authorized.some((entry) => entry.kind === "dm" && entry.wireTarget === direct.channel);
}

export function wireTargetForOperation(operation: Operation, authorized: readonly AuthorizedConversation[]): string | undefined {
  return authorized.find((item) => item.conversationId === operation.conversationId)?.wireTarget;
}

export function requiresLogoutConfirmation(draftCount: number, pendingCount: number, composerText = "", unsavedDrafts: Iterable<string> = []): boolean {
  return draftCount > 0 || pendingCount > 0 || !!composerText.trim() || [...unsavedDrafts].some((text) => text.trim());
}

export interface ThreadGrant {
  channel: string;
  conversationId: string;
  parent: string;
  parentLabel: string;
  title: string;
  root: string;
  rootNick: string;
  rootText: string;
  rootTime: string;
  lastActivity: number;
  createdBy: string;
}

const THREAD_CHANNEL = /^#t-[a-z0-9_-]{1,32}$/i;

export function authorizedThreads(me: unknown, conversations: readonly AuthorizedConversation[]): ThreadGrant[] {
  const body = me as { threads?: unknown; directs?: unknown } | null;
  const authorized = new Set(conversations.map((item) => foldIdentifier(item.wireTarget)));
  const labels = new Map<string, string>();
  for (const item of conversations) if (item.kind === "room") labels.set(foldIdentifier(item.wireTarget), item.wireTarget.replace(/^#/, ""));
  for (const value of Array.isArray(body?.directs) ? body.directs : []) {
    if (!value || typeof value !== "object") continue;
    const direct = value as { nick?: unknown; channel?: unknown };
    if (typeof direct.nick === "string" && typeof direct.channel === "string") labels.set(foldIdentifier(direct.channel), direct.nick);
  }
  const rows: ThreadGrant[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(body?.threads) ? body.threads : []) {
    if (!value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    const channel = typeof raw.channel === "string" ? raw.channel.trim() : "";
    const parent = typeof raw.parent === "string" ? raw.parent.trim() : "";
    if (!THREAD_CHANNEL.test(channel) || !parent || !authorized.has(foldIdentifier(parent)) || seen.has(foldIdentifier(channel))) continue;
    seen.add(foldIdentifier(channel));
    const rootText = typeof raw.rootText === "string" ? raw.rootText : "";
    rows.push({
      channel,
      conversationId: conversationId("thread", channel),
      parent,
      parentLabel: labels.get(foldIdentifier(parent)) ?? parent.replace(/^#/, ""),
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : rootText.trim() || channel,
      root: typeof raw.root === "string" ? raw.root : "",
      rootNick: typeof raw.rootNick === "string" ? raw.rootNick : "",
      rootText,
      rootTime: typeof raw.rootTime === "string" ? raw.rootTime : "",
      lastActivity: typeof raw.lastActivity === "number" ? raw.lastActivity : 0,
      createdBy: typeof raw.createdBy === "string" ? raw.createdBy : "",
    });
  }
  return rows;
}

export interface AccessGrant {
  scope: AccountScope;
  conversation: AuthorizedConversation;
  conversations: AuthorizedConversation[];
  threads: ThreadGrant[];
  // Server-declared role; used only to offer controls, never to grant authority.
  role: string;
}

export type AccessResult = ({ ok: true } & AccessGrant) | { ok: false; reason: string };

export const SIGN_IN_REASON = "Sign in to open the client.";

export function clientAccess(me: unknown, instance: string): AccessResult {
  const body = me as {
    authenticated?: unknown;
    accountId?: unknown;
    account?: unknown;
    nick?: unknown;
    channels?: unknown;
    directs?: unknown;
    accountDetails?: unknown;
  } | null;
  if (!body || body.authenticated !== true) return { ok: false, reason: SIGN_IN_REASON };
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  if (!accountId) return { ok: false, reason: "The server did not return a stable account id." };
  const account = typeof body.account === "string" && body.account.trim()
    ? body.account.trim()
    : typeof body.nick === "string"
      ? body.nick.trim()
      : "";
  if (!account) return { ok: false, reason: "The server did not return an IRC account." };
  const channels = Array.isArray(body.channels) ? body.channels.filter((c): c is string => typeof c === "string" && /^#[a-z0-9][a-z0-9_-]{0,63}$/i.test(c) && !/^#(?:t-|dm-)/i.test(c)) : [];
  const details = Array.isArray(body.accountDetails) ? body.accountDetails as { id?: unknown; nick?: unknown }[] : [];
  const peerIds = new Map(details.filter((item) => typeof item.id === "string" && typeof item.nick === "string").map((item) => [foldIdentifier(item.nick as string), item.id as string]));
  const conversations: AuthorizedConversation[] = channels.map((channel) => {
    const wireTarget = foldIdentifier(channel);
    return { conversationId: conversationId("room", wireTarget), wireTarget, kind: "room" };
  });
  for (const value of Array.isArray(body.directs) ? body.directs : []) {
    const direct = value as { nick?: unknown; channel?: unknown };
    const nick = typeof direct.nick === "string" ? direct.nick : "";
    const wireTarget = typeof direct.channel === "string" && /^#dm-[a-z0-9-]+$/i.test(direct.channel) ? direct.channel : "";
    const peerId = peerIds.get(foldIdentifier(nick));
    if (nick && wireTarget && peerId) conversations.push({ conversationId: conversationId("dm", peerId), wireTarget, kind: "dm" });
  }
  // Any account with at least one conversation may enter; #dev-test is only a preferred default room.
  if (!conversations.length) return { ok: false, reason: "Your account is not in any conversations yet." };
  const preferred = conversations.find((item) => item.kind === "room" && foldIdentifier(item.wireTarget) === foldIdentifier(DEV_CHANNEL))
    ?? conversations.find((item) => item.kind === "room")
    ?? conversations[0]!;
  let origin: string;
  try {
    const parsed = new URL(instance);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
    origin = parsed.origin;
  } catch {
    return { ok: false, reason: "Invalid instance origin." };
  }
  const scope: AccountScope = { instance: origin, accountId, account, caseMapping: "ascii" };
  return {
    ok: true,
    scope,
    conversation: preferred,
    conversations,
    threads: authorizedThreads(body, conversations),
    role: typeof (body as { role?: unknown }).role === "string" ? (body as { role: string }).role : "member",
  };
}

export function recoveryTargets(access: AccessResult, ownerScopeKey: string): AuthorizedConversation[] | null {
  if (!access.ok || scopeKey(access.scope) !== ownerScopeKey) return null;
  return [
    ...access.conversations,
    ...access.threads.map((thread) => ({ conversationId: thread.conversationId, wireTarget: thread.channel, kind: "thread" as const })),
  ];
}
