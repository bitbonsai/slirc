import { type ClientState } from "@client/client-state.ts";
import { type Message } from "@client/model.ts";
import { type AuthorizedConversation } from "@client/sync.ts";
import { isActionText, textSegments } from "@client/render.ts";
import { embedMetaFromResponse, type EmbedMeta } from "@client/embed.ts";
import { dateDividerLabel, groupsWithPrevious, nearBottom } from "@client/presentation.ts";
import { isHiddenThreadAnnouncement } from "@client/threads.ts";
import { buildReplyIndex, isLegacyThreadAnnouncement } from "@client/reply-threads.ts";
import { isDailyGreeting } from "../shared/service-bots.ts";

export function createTranscript({ core, nextTick, authorized, stopped, linkOpen, closeLink, onPinChange, menuOpenId = () => "", hidden = () => false, rememberEmbed }: {
  core: Pick<ClientState, "messages" | "threads" | "embeds" | "currentConversationId" | "greeting" | "notesOpen" | "replyThreadRootId" | "replyThreadFaded">;
  nextTick: (callback?: () => void) => Promise<void>;
  authorized: () => AuthorizedConversation[];
  stopped: () => boolean;
  linkOpen: () => boolean;
  closeLink: () => void;
  // The id of the message whose action menu is open, or empty.
  menuOpenId?: () => string;
  onPinChange?: (pinned: boolean) => void;
  // Rows the transcript leaves out, such as a poll tally its live card already shows.
  hidden?: (message: Message) => boolean;
  // Keeps a fetched card so the next open of this conversation paints it with the rows.
  rememberEmbed?: (url: string, meta: EmbedMeta) => void;
}) {
  let pinnedToBottom = true;
  // scrollTop at the last scroll event or programmatic jump; tells a move up from a move down.
  let lastScrollTop = 0;
  // Only the person leaves the bottom. In WebKit, images that finish loading and rows leaving the
  // history window also fire scroll events that move scrollTop up. A move up unpins only shortly
  // after touch, wheel, pointer or key input.
  let lastInput = -Infinity;
  const noteInput = (): void => { lastInput = Date.now(); };
  const noteKey = (event: KeyboardEvent): void => {
    if (!(event.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]")) noteInput();
  };
  // A conversation left at the bottom reopens at the bottom, so only an unpinned position is kept.
  const rememberScroll = (id: string, top: number): void => {
    if (pinnedToBottom) scrollByConversation.delete(id); else scrollByConversation.set(id, top);
  };
  const setPinned = (value: boolean): void => {
    if (value === pinnedToBottom) return;
    pinnedToBottom = value;
    onPinChange?.(value);
  };
  let conversationAnimation: Animation | null = null;
  let switchVersion = 0;
  let fadeFor: string | null = null;
  let restoreScrollFor: string | null = null;
  const scrollByConversation = new Map<string, number>();
  const embedAttempts = new Map<string, number>();
  const embedInFlight = new Set<string>();
  let embedEpoch = 0;
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  let focusServerId: string | null = null;
  let focusTimer: ReturnType<typeof setTimeout> | null = null;
  const focusHighlightTimers = new Set<ReturnType<typeof setTimeout>>();
  async function loadEmbeds(messages: readonly Message[]): Promise<void> {
    const epoch = embedEpoch;
    const conversation = core.currentConversationId;
    const urls = new Set(messages.flatMap((message) => textSegments(message.text).flatMap((segment) => segment.href ? [segment.href] : [])));
    for (const url of urls) {
      if (embedAttempts.size >= 32 && !embedAttempts.has(url)) continue;
      const attempts = embedAttempts.get(url) ?? 0;
      const flightKey = `${epoch}:${url}`;
      if (attempts >= 2 || core.embeds[url] || embedInFlight.has(flightKey)) continue;
      embedAttempts.set(url, attempts + 1);
      embedInFlight.add(flightKey);
      try {
        const response = await fetch("/api/embed", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
        if (!response.ok) throw new Error(`Embed request failed (${response.status})`);
        const raw = await response.json() as Record<string, unknown>;
        if (epoch !== embedEpoch || stopped()) return;
        // Preserve title/image/site plus a sanitized oEmbed player, so supported providers can
        // be framed and unsupported ones fall back to the ordinary link.
        const meta = embedMetaFromResponse(raw);
        if (meta) {
          core.embeds = { ...core.embeds, [url]: meta };
          rememberEmbed?.(url, meta);
          // The preview card lands a paint later; a reader at the bottom would be left behind by
          // the row it grows, so the pinned view follows it down.
          if (pinnedToBottom) void nextTick(() => scrollToBottom(false));
        }
      } catch {
        if (attempts === 0 && epoch === embedEpoch && conversation === core.currentConversationId && !stopped()) {
          const timer = setTimeout(() => { retryTimers.delete(timer); if (epoch === embedEpoch && conversation === core.currentConversationId && !stopped()) void loadEmbeds(messages); }, 1200); retryTimers.add(timer);
        }
      } finally { embedInFlight.delete(flightKey); }
    }
  }

  function onChatScroll(): void {
    if (core.currentConversationId && restoreScrollFor === core.currentConversationId) return;
    const chat = document.querySelector<HTMLElement>("#chat");
    if (!chat) return;
    if (linkOpen()) closeLink();
    // Our own jump to the bottom reports its scroll event a frame later, often after the next row
    // has rendered, so the event sees a gap that nobody scrolled. Only a move up by the person that
    // leaves the bottom unpins; reaching the bottom pins again.
    const top = chat.scrollTop;
    const byPerson = Date.now() - lastInput < 1000;
    setPinned(nearBottom(chat.scrollHeight, top, chat.clientHeight) || (pinnedToBottom && (top >= lastScrollTop || !byPerson)));
    lastScrollTop = top;
    if (core.currentConversationId) rememberScroll(core.currentConversationId, top);
  }

  function scrollToBottom(force = false): void {
    if (!force && (!pinnedToBottom || (core.currentConversationId && restoreScrollFor === core.currentConversationId))) return;
    if (force) setPinned(true);
    const chat = document.querySelector<HTMLElement>("#chat");
    if (chat) { chat.scrollTop = chat.scrollHeight; lastScrollTop = chat.scrollTop; }
  }

  function displayedMessages(): Message[] {
    const replyIndex = buildReplyIndex(core.messages);
    return core.messages.filter((message: Message) => !isHiddenThreadAnnouncement(message, core.threads, authorized(), core.messages) && !isLegacyThreadAnnouncement(message)
      && !replyIndex.hiddenMessageIds.has(message.id)
      && (core.greeting || !isDailyGreeting(message.authorAccount, message.text)) && !hidden(message));
  }

  function continuesPrevious(message: Message, index: number): boolean {
    return groupsWithPrevious(displayedMessages(), index, message);
  }

  // The classes of one message row: grouped with the one above, still sending, menu or thread open,
  // an action line or a note.
  function messageClass(message: Message, index: number): (string | false)[] {
    const threadOpen = !!core.replyThreadRootId && message.serverId === core.replyThreadRootId;
    return [
      continuesPrevious(message, index) && "cont",
      (message.state === "saving" || message.state === "queued" || message.state === "sending") && "pending",
      menuOpenId() === message.id && "menu-open",
      threadOpen && "thread-open",
      !!core.replyThreadFaded[message.serverId as string] && "thread-fade",
      isActionText(message.text) && "action",
      core.notesOpen && "note",
    ];
  }

  function dateDivider(_message: Message, index: number): string {
    return dateDividerLabel(displayedMessages(), index);
  }

  function cancelFocus(): void {
    focusServerId = null;
    if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
    for (const timer of focusHighlightTimers) clearTimeout(timer);
    focusHighlightTimers.clear();
    for (const row of document.querySelectorAll<HTMLElement>("[data-message-id].focus-flash")) row.classList.remove("focus-flash");
  }

  // Jump to one message after the rows for its conversation have rendered. Retries are cancelled by
  // navigation/teardown via cancelFocus, so a stale jump never scrolls the next conversation.
  // flash: false only scrolls; a row whose thread opens is already marked by its .thread-open tint.
  function focus(serverId: string, { flash = true }: { flash?: boolean } = {}): void {
    cancelFocus();
    focusServerId = serverId;
    let attempts = 0;
    const attempt = (): void => {
      focusTimer = null;
      if (focusServerId !== serverId || stopped()) return;
      const message = core.messages.find((item: Message) => item.serverId === serverId || item.id === serverId);
      const row = message ? document.querySelector<HTMLElement>(`.msg[data-message-id="${CSS.escape(message.id)}"]`) : null;
      if (!row) {
        if (attempts++ < 20) focusTimer = setTimeout(attempt, 50);
        else focusServerId = null;
        return;
      }
      focusServerId = null;
      // The jump is ours, not a scroll by the person, so leave the bottom explicitly.
      setPinned(false);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
      if (!flash) return;
      row.classList.add("focus-flash");
      const timer = setTimeout(() => { focusHighlightTimers.delete(timer); row.classList.remove("focus-flash"); }, 2600);
      focusHighlightTimers.add(timer);
    };
    attempt();
  }

  function cancelConversationTransition(): void {
    cancelFocus();
    switchVersion += 1;
    conversationAnimation?.cancel();
    conversationAnimation = null;
    fadeFor = null;
  }

  function beforePaint(view: { loading: boolean; conversationId: string | null }): void {
      if (!view.loading && fadeFor && fadeFor === view.conversationId && !conversationAnimation
        && document.visibilityState === "visible" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        // Hold at zero before Alpine can paint the incoming rows. Starting after nextTick
        // otherwise shows one full-opacity frame, then blanks it to begin the fade.
        const chat = document.querySelector<HTMLElement>("#chat");
        conversationAnimation = chat?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: "ease-out" }) ?? null;
        if (conversationAnimation) { conversationAnimation.pause(); conversationAnimation.currentTime = 0; }
      }
  }

  function afterPaint(view: { conversationId: string | null }, current: () => boolean): void {
        const paintVersion = switchVersion;
        void nextTick().then(() => {
          if (paintVersion !== switchVersion || !current()) return;
          const chat = document.querySelector<HTMLElement>("#chat");
          if (focusServerId) {
            // focus() owns this jump; drop the remembered anchor so normal scrolling resumes.
            restoreScrollFor = null;
          } else if (chat && restoreScrollFor === core.currentConversationId) {
            chat.scrollTop = scrollByConversation.get(core.currentConversationId!) ?? chat.scrollHeight;
            lastScrollTop = chat.scrollTop;
            setPinned(nearBottom(chat.scrollHeight, chat.scrollTop, chat.clientHeight));
            restoreScrollFor = null;
          } else scrollToBottom(false);
          if (fadeFor && fadeFor === view.conversationId) {
            fadeFor = null;
            if (document.visibilityState === "visible" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) conversationAnimation?.play();
            else conversationAnimation?.cancel();
          }
        });
  }
  function prepare(previous: string | null, next: string | null, animate: boolean): void {
    const chat = document.querySelector<HTMLElement>("#chat");
    if (previous && chat && restoreScrollFor !== previous) rememberScroll(previous, chat.scrollTop);
    if (animate) fadeFor = next;
    restoreScrollFor = next;
  }
  function reset(): void {
    cancelConversationTransition(); restoreScrollFor = null;
    scrollByConversation.clear(); embedAttempts.clear(); embedInFlight.clear();
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear(); embedEpoch += 1; core.embeds = {};
  }
  return {
    loadEmbeds, onChatScroll, noteInput, noteKey, scrollToBottom, displayedMessages, continuesPrevious, messageClass, dateDivider, cancelConversationTransition, beforePaint, afterPaint, prepare, reset, focus,
    version: () => switchVersion,
    isPinned: () => pinnedToBottom,
    noFade: () => { fadeFor = null; },
    destroy: reset,
  };
}
