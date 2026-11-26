import { foldIdentifier, type Draft, type Message } from "@client/model.ts";
import { type AuthorizedConversation } from "@client/sync.ts";
import { type ReactionMap } from "@client/store.ts";
import { parseRoute, routeUrl, type Screen, type Tab } from "@client/navigation.ts";
import { glow } from "../public/vendor/nueglow.js";
import { giphySide, isGiphyHost } from "@client/media.ts";
import { type ThreadGrant } from "@client/access.ts";
import { HELPER_NICKS as HELPERS, SERVICE_NICK, UPDATES_NICK } from "../shared/service-bots.ts";

// The served page names the sprite's current version, so a new icon is never looked for in an
// old cached sprite.
const spriteVersion = typeof document === "undefined" ? "" : document.querySelector<HTMLMetaElement>('meta[name="slirc-sprite"]')?.content || "";
const LUCIDE_SPRITE = `/icons/lucide/sprite.svg${/^[a-f0-9]{8}$/.test(spriteVersion) ? `?v=${spriteVersion}` : ""}`;

// First-party helper bots and the instance service nick get local marks, exactly as the legacy client
// drew them: no upload, no initial letter, and the same per-helper colour.
const SERVICE_AVATAR_NICK = SERVICE_NICK;
const SERVICE_AVATAR = "/icons/slirc.svg";
const HELPER_NICKS = new Set<string>(HELPERS);
const HELPER_COLORS: Record<string, string> = { help: "#41F79B", remind: "#fab387", poll: "#cba6f7", welcome: "#89dceb", [UPDATES_NICK]: "#f9e2af" };
const AGENT_AVATARS: Record<string, string> = {
  aider: "/icons/agents/aider.svg",
  claude: "/icons/agents/claude.svg",
  codex: "/icons/agents/codex.svg",
  gemini: "/icons/agents/gemini.svg",
  pi: "/icons/agents/pi.svg",
  kimi: "/icons/agents/kimi.svg",
  opencode: "/icons/agents/opencode.svg",
};
const GENERIC_AGENT_AVATAR = "/icons/agents/agent.svg";
const BOT_MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><g transform="translate(2.15 1.7) scale(.9)"><path fill="__COLOR__" d="M29.011 15.7747C29.011 8.63731 23.3406 3.26374 15.956 3.26374C8.6259 3.26374 3.26374 8.5845 3.26374 15.7747C3.26374 17.7011 3.50648 19.2221 4.01734 20.5326C4.52398 21.8321 5.32849 23.0118 6.57174 24.2092C6.94519 24.569 7.07499 24.9937 7.12313 25.2628C7.17204 25.5363 7.16209 25.7872 7.14438 25.9693C7.10899 26.3332 7.01082 26.7131 6.91348 27.0374C6.71686 27.6925 6.40158 28.5089 6.1404 29.2157C6.04617 29.4707 5.95783 29.7151 5.87727 29.9463C6.1862 29.7793 6.51786 29.592 6.86426 29.391C7.62182 28.9512 8.48247 28.4295 9.14987 28.0661C9.48616 27.8831 9.84164 27.7017 10.1652 27.5753C10.3247 27.513 10.5311 27.442 10.7566 27.4007C10.9324 27.3685 11.3827 27.3007 11.8725 27.5059C13.3689 28.133 14.7199 28.2857 16.6813 28.2857C23.956 28.2857 29.011 23.0207 29.011 15.7747ZM32.2747 15.7747C32.2747 24.7514 25.8295 31.5495 16.6813 31.5495C14.835 31.5495 13.2165 31.4271 11.49 30.8472C11.1351 30.7281 11.0455 30.75 10.7102 30.9325C10.0914 31.2694 9.35411 31.7195 8.5025 32.2138C7.70025 32.6795 6.80423 33.1796 6.0253 33.5011C5.64385 33.6585 5.19255 33.8151 4.74085 33.8737C4.35734 33.9234 3.50229 33.963 2.83523 33.2961C2.28393 32.7448 2.19609 32.0502 2.18539 31.661C2.1736 31.2323 2.24581 30.7987 2.32987 30.4279C2.49945 29.68 2.8056 28.825 3.07923 28.0846C3.37249 27.291 3.62938 26.6258 3.78751 26.0989C3.79242 26.0826 3.79646 26.0665 3.80096 26.0511C2.53528 24.7284 1.6009 23.3192 0.976713 21.7182C0.276179 19.9214 0 17.9712 0 15.7747C0 6.74234 6.8633 0 15.956 0C24.9944 0 32.2747 6.68954 32.2747 15.7747Z"/><path fill="__COLOR__" d="M9.02324 12.4746C9.03751 11.0941 10.1681 9.98585 11.5486 10C12.9293 10.0143 14.0375 11.1458 14.0232 12.5264L14.0008 14.6719C13.9865 16.0524 12.8558 17.1605 11.4754 17.1465C10.0949 17.1322 8.98675 16.0015 9.00078 14.6211L9.02324 12.4746Z"/><path fill="__COLOR__" d="M19.0232 12.4746C19.0375 11.0941 20.1681 9.98585 21.5486 10C22.9293 10.0143 24.0375 11.1458 24.0232 12.5264L24.0008 14.6719C23.9865 16.0524 22.8558 17.1605 21.4754 17.1465C20.0949 17.1322 18.9868 16.0015 19.0008 14.6211L19.0232 12.4746Z"/></g></svg>';

export function botAvatarUrl(nick: string): string {
  const key = String(nick || "").toLowerCase();
  const color = HELPER_COLORS[key] || "#a6e3a1";
  return `data:image/svg+xml,${encodeURIComponent(BOT_MARK.replaceAll("__COLOR__", color))}`;
}

// A known agent draws its harness mark, else its nick prefix's (`pi-a143`), else the generic agent
// glyph. `harness` undefined means the nick is not known to be an agent, so only the prefix counts.
export function agentAvatarUrl(nick: string, harness?: string): string {
  const key = String(nick || "").toLowerCase();
  const known = harness === undefined ? "" : AGENT_AVATARS[harness.trim().toLowerCase()] || "";
  const prefixed = key.includes("-") ? AGENT_AVATARS[key.split("-", 1)[0]!] || "" : "";
  return known || prefixed || (harness === undefined ? "" : GENERIC_AGENT_AVATAR);
}

export function lucideIcon(name: string): string {
  const safe = /^[a-z0-9-]+$/.test(name) ? name : "";
  if (!safe) return "";
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="${LUCIDE_SPRITE}#${safe}"></use></svg>`;
}

export function phoneScreenDirection(from: Tab | null, to: Screen, back: boolean): -1 | 1 {
  if (to.kind !== "tab") return back ? -1 : 1;
  if (!from) return -1;
  const tabs: Tab[] = ["home", "dms", "more"];
  return tabs.indexOf(to.tab) < tabs.indexOf(from) ? -1 : 1;
}

export function animatePhoneScreen(screen: HTMLElement | null, reducedMotion: boolean, direction: -1 | 1 = 1): Animation | null {
  if (reducedMotion) return null;
  const animation = screen?.animate?.([
    { opacity: 0, transform: `translateX(${direction * 8}px)` },
    { opacity: 1, transform: "translateX(0)" },
  ], { duration: 250, easing: "ease-out" }) ?? null;
  // Hold before Alpine shows the screen, so no opaque frame can precede the fade.
  if (animation) { animation.pause(); animation.currentTime = 0; }
  return animation;
}

export function isGiphyUrl(href: string | undefined | null): boolean {
  return !!href && isGiphyHost(href);
}

export function historyAvailability(index: number, length: number): { back: boolean; forward: boolean } {
  return { back: index > 0, forward: index >= 0 && index < length - 1 };
}

export interface GiphyResult { preview: string; url: string; title: string; width?: number; height?: number }

export function giphyResultsFrom(body: unknown, limit = 12): GiphyResult[] {
  const gifs = body && typeof body === "object" && Array.isArray((body as { gifs?: unknown }).gifs)
    ? (body as { gifs: unknown[] }).gifs
    : [];
  return gifs
    .filter((gif): gif is GiphyResult => !!gif && typeof gif === "object"
      && typeof (gif as GiphyResult).url === "string" && typeof (gif as GiphyResult).preview === "string")
    .slice(0, limit)
    .map((gif) => {
      const width = giphySide(gif.width), height = giphySide(gif.height);
      const { width: _w, height: _h, ...rest } = gif;
      return width && height ? { ...rest, width, height } : rest;
    });
}

export function hasMoreRight(scrollLeft: number, scrollWidth: number, clientWidth: number, epsilon = 1): boolean {
  if (!(scrollWidth > clientWidth)) return false;
  return scrollWidth - clientWidth - scrollLeft > epsilon;
}

export function giphyPickerIntent(
  event: { key: string; isComposing?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  count: number,
): "pick" | "close" | "prev" | "next" | "ignore" | null {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "Escape") return "close";
  if (event.key === "ArrowRight") return count > 0 ? "next" : "ignore";
  if (event.key === "ArrowLeft") return count > 0 ? "prev" : "ignore";
  if (event.key === "Enter") return count > 0 ? "pick" : "ignore";
  return null;
}

export function lightboxEscapeAction(maximized: boolean): "restore" | "close" {
  return maximized ? "restore" : "close";
}

export function starredIdsFromStorage(value: string | null): string[] {
  try {
    const ids = JSON.parse(value ?? "null");
    return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
  } catch { return []; }
}

export function excludeStarred<T>(items: readonly T[], starred: readonly string[], id: (item: T) => string): T[] {
  return items.filter((item) => !starred.includes(id(item)));
}

export function collapsedMediaFromStorage(value: string | null): Record<string, true> {
  try {
    const ids = JSON.parse(value || "[]");
    return Array.isArray(ids)
      ? Object.fromEntries(ids.filter((id): id is string => typeof id === "string").map((id) => [id, true as const]))
      : {};
  } catch { return {}; }
}

export function formatTime(time: string): string {
  const date = new Date(time);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function avatarUrl(nick: string, version?: number, harness?: string): string {
  const account = String(nick || "").trim();
  if (!account) return "";
  const key = account.toLowerCase();
  if (key === SERVICE_AVATAR_NICK) return SERVICE_AVATAR;
  if (HELPER_NICKS.has(key) || key === UPDATES_NICK) return botAvatarUrl(key);
  const agent = agentAvatarUrl(key, harness);
  if (agent) return agent;
  // A version names one photo, so the browser caches it for good; bare URLs revalidate within minutes.
  return `/avatars/${encodeURIComponent(account)}${version ? `?v=${version}` : ""}`;
}

// Server rows (account details, room members, profiles) carry each person's avatarVersion. Keep the
// latest per folded nick so every avatar of that person uses the same versioned URL.
export function rememberAvatarVersions(into: Record<string, number>, rows: unknown[]): void {
  for (const row of rows) {
    const { nick, avatarVersion } = (row ?? {}) as { nick?: unknown; avatarVersion?: unknown };
    if (typeof nick === "string" && typeof avatarVersion === "number" && Number.isFinite(avatarVersion)) into[foldIdentifier(nick)] = avatarVersion;
  }
}

export function messageDateLabel(time: string, now: Date = new Date()): string {
  const date = new Date(time);
  if (Number.isNaN(date.valueOf())) return "";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

export function dateDividerLabel(messages: readonly Message[], index: number, now: Date = new Date()): string {
  const message = messages[index];
  if (!message) return "";
  const prev = index > 0 ? messages[index - 1] : undefined;
  if (prev && new Date(prev.time).toDateString() === new Date(message.time).toDateString()) return "";
  return messageDateLabel(message.time, now);
}

function sameAuthor(a: Message, b: Message): boolean {
  return (a.authorAccount || a.authorNick) === (b.authorAccount || b.authorNick);
}

export function groupsWithPrevious(messages: readonly Message[], index: number, message: Message = messages[index]!): boolean {
  if (index <= 0 || !message) return false;
  const prev = messages[index - 1];
  // An agent's offline card stands alone, so the line after it starts its own author row.
  if (!prev || prev.notice === "agent-offline" || !sameAuthor(prev, message)) return false;
  if (dateDividerLabel(messages, index) !== "") return false;
  const delta = Math.abs(Date.parse(message.time) - Date.parse(prev.time));
  return Number.isFinite(delta) && delta < 5 * 60_000;
}

export function enterSends(event: { key: string; shiftKey?: boolean; isComposing?: boolean; isDesktop: boolean }, insideCodeFence = false): boolean {
  return !insideCodeFence && event.isDesktop && event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function nearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 80): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export function canEditMessage(message: { authorAccount?: string; authorNick?: string; state: string; serverId?: string; deleted?: boolean } | null | undefined, account: string): boolean {
  if (!message || !message.serverId || message.state !== "confirmed" || message.deleted) return false;
  const author = message.authorAccount || message.authorNick || "";
  return foldIdentifier(author) === foldIdentifier(account);
}

// An admin may edit a message a bot posted (the instance helpers and managed bots), never a
// person's or an agent's. The server checks it again against the account table and Ergo's history.
export function canAdminEditBotMessage(message: { authorAccount?: string; authorNick?: string; state: string; serverId?: string; deleted?: boolean } | null | undefined, isAdmin: boolean, isBot: (nick: string) => boolean): boolean {
  if (!isAdmin || !message || !message.serverId || message.state !== "confirmed" || message.deleted) return false;
  const author = message.authorAccount || message.authorNick || "";
  return !!author && isBot(author);
}

export function canDeleteMessage(message: { authorAccount?: string; authorNick?: string; state: string; serverId?: string; deleted?: boolean } | null | undefined, account: string, isAdmin: boolean): boolean {
  if (!message || !message.serverId || message.state !== "confirmed" || message.deleted) return false;
  if (isAdmin) return true;
  const author = message.authorAccount || message.authorNick || "";
  return foldIdentifier(author) === foldIdentifier(account);
}

export function nextMessageIndex(index: number, count: number, key: "ArrowUp" | "ArrowDown"): number | "composer" | "stay" {
  const next = index + (key === "ArrowUp" ? -1 : 1);
  if (next < 0) return "stay";
  if (next >= count) return "composer";
  return next;
}

export function composerArrowUpTarget(state: {
  isDesktop: boolean;
  key: string;
  isComposing: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  text: string;
  menuOpen: boolean;
}): boolean {
  return state.isDesktop && state.key === "ArrowUp" && !state.isComposing
    && !state.ctrlKey && !state.metaKey && !state.altKey && !state.shiftKey
    && !state.menuOpen && state.text === "";
}

// Alt+Up / Alt+Down with no other modifier and no open list recall sent messages. Distinct from
// composerArrowUpTarget: plain Up selects the newest message, Alt+Up refills the composer.
export function composerRecallDirection(state: {
  key: string; isComposing: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; menuOpen: boolean;
}): -1 | 1 | 0 {
  if (!state.altKey || state.isComposing || state.ctrlKey || state.metaKey || state.shiftKey || state.menuOpen) return 0;
  return state.key === "ArrowUp" ? -1 : state.key === "ArrowDown" ? 1 : 0;
}

export function mountUrl(routeUrl: string): string {
  return routeUrl;
}

export function routeFromMount(pathname: string, hash: string, search = ""): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  const fragment = hash && hash !== "#" ? hash : "";
  const query = search && search !== "?" ? search : "";
  // A `#/…` fragment is a root subroute alias: the server redirects it to the root before the
  // client reads it, so it must canonicalize here.
  if (fragment.startsWith("#/")) return `${fragment.slice(1)}${query}`;
  return `${path}${query}${fragment}`;
}

export function signInNext(raw: string, origin: string): string {
  const screen = parseRoute(raw, origin);
  if (!screen) return "/";
  const path = routeUrl(screen).split(/[?#]/)[0] || "/";
  return /^\/[a-zA-Z0-9._/-]*$/.test(path) && !path.startsWith("//") ? path : "/";
}

export function visibleDraftNavigationItems<T extends { conversationId: string }>(items: readonly T[], activeConversationId: string | null, hideActive: boolean): T[] {
  return items.filter((item) => !(hideActive && item.conversationId === activeConversationId));
}

export function draftNavigationItems(
  drafts: readonly Draft[],
  conversations: readonly AuthorizedConversation[],
  directs: readonly { channel: string; nick: string }[],
  threads: readonly ThreadGrant[],
  pendingDms: readonly { conversationId: string; nick: string }[] = [],
): (Draft & { label: string })[] {
  const labels = new Map<string, string>();
  for (const conversation of conversations) {
    const direct = conversation.kind === "dm" ? directs.find((item) => foldIdentifier(item.channel) === foldIdentifier(conversation.wireTarget)) : undefined;
    const thread = conversation.kind === "thread" ? threads.find((item) => item.conversationId === conversation.conversationId) : undefined;
    labels.set(conversation.conversationId, direct?.nick ?? thread?.title ?? conversation.wireTarget);
  }
  for (const pending of pendingDms) if (!labels.has(pending.conversationId)) labels.set(pending.conversationId, pending.nick);
  return drafts
    .filter((draft) => !!draft.text.trim() && labels.has(draft.conversationId))
    .map((draft) => ({ ...draft, label: labels.get(draft.conversationId)! }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface ReactionChip { emoji: string; count: number; mine: boolean }

export function reactionChips(reactions: ReactionMap, messageServerId: string | undefined): ReactionChip[] {
  if (!messageServerId) return [];
  return (reactions[messageServerId] ?? []).map(({ emoji, count, mine }) => ({ emoji, count, mine }));
}

export function reactionTooltip(reactions: ReactionMap, messageServerId: string | undefined, emoji: string, account: string): string {
  const reaction = messageServerId ? reactions[messageServerId]?.find((item) => item.emoji === emoji) : undefined;
  if (!reaction) return "";
  const names = reaction.accounts.map((name) => foldIdentifier(name) === foldIdentifier(account) ? "you" : name);
  return `${emoji} ${reaction.count} · ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names)}`;
}

export const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "🔥", "👀", "👏", "🙌", "🦄", "💩"] as const;

export function fenceHtml(segment: { code?: string; lang?: string }): string {
  return glow((segment.code ?? "").split("\n"), segment.lang || undefined);
}
