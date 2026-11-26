// Signed-out view of #open-chat in the real app shell. The server answers only for the public room
// on the public playground (src/peek.ts); anywhere else the request is a 404 and the normal sign-in
// card stays. The payload feeds the shared transcript state (messages, reactions, poll views, link
// previews, avatar versions) so the room renders exactly as it does signed in. There is no IRC or
// WebSocket connection; any control that needs an account opens the sign-in card instead.
import { type ClientState } from "@client/client-state.ts";
import { embedMetaFromResponse, type EmbedMeta } from "@client/embed.ts";
import { conversationId, type Message } from "@client/model.ts";
import { type ReactionMap } from "@client/store.ts";
import { type PollView } from "@client/polls.ts";

export type PeekMessage = {
  id: string; time: string; nick: string; text: string; action?: boolean;
  replyTo?: string; poll?: { id: number; kind: "card" | "tally" };
  reactions?: { emoji: string; count: number; accounts: string[] }[];
};
export type PeekPayload = {
  channel: string; messages: PeekMessage[];
  polls?: Record<string, unknown>; embeds?: Record<string, unknown>; avatars?: Record<string, unknown>;
};

export const PEEK_REFRESH_MS = 30_000;
// A focus or tab switch reads again only when the last answer is older than the server's cache.
const PEEK_STALE_MS = 15_000;

// The public room's own address, as /<slug> or the app's room URL /#<slug>; the server
// refuses every other channel. Read when this module loads, before the router canonicalizes it.
const PEEK_ROOM_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function peekRoomSlug(openRoom?: string): string {
  const slug = (openRoom || "").trim().replace(/^#/, "").toLowerCase();
  return PEEK_ROOM_SLUG.test(slug) ? slug : "open-chat";
}

export function peekPath(pathname: string, hash = "", openRoom = "#open-chat"): string {
  const slug = peekRoomSlug(openRoom);
  const path = pathname.replace(/\/+$/, "") || "/";
  return path.toLowerCase() === `/${slug}` || (path === "/" && hash.toLowerCase() === `#${slug}`) ? slug : "";
}
// The bare root lands on the room too, but only on the public playground, which /auth/me tells
// (its signed-out answer carries `signup` and `openRoom`). A root with a query (a device pairing
// code, a failed magic link) or a fragment keeps the sign-in card.
export function rootPeekPath(pathname: string, hash: string, search: string, playground: boolean, openRoom = "#open-chat"): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  return playground && path === "/" && (!hash || hash === "#") && (!search || search === "?") ? peekRoomSlug(openRoom) : "";
}
// Read at load too: the router drops a pairing code or an unconfigured open-room path from the
// address before /auth/me answers.
const initialLocation = typeof location === "undefined"
  ? { pathname: "", hash: "", search: "" }
  : { pathname: location.pathname, hash: location.hash, search: location.search };
const landing = peekPath(initialLocation.pathname, initialLocation.hash);

const MSGID = /^[A-Za-z0-9_-]{1,64}$/;

// One payload to the transcript's own model. Ids are stable across refreshes so rows keep their DOM.
export function peekState(body: PeekPayload) {
  const conversation = conversationId("room", body.channel);
  const messages: Message[] = [];
  const reactions: ReactionMap = {};
  const cards = new Set<number>();
  body.messages.forEach((m, index) => {
    if (!m || typeof m.nick !== "string" || typeof m.text !== "string" || typeof m.time !== "string") return;
    const serverId = typeof m.id === "string" && MSGID.test(m.id) ? m.id : undefined;
    const poll = m.poll && Number.isInteger(m.poll.id) && (m.poll.kind === "card" || m.poll.kind === "tally") ? { id: m.poll.id, kind: m.poll.kind } : undefined;
    if (poll?.kind === "card") cards.add(poll.id);
    messages.push({
      id: `peek:${serverId ?? `${m.time}:${index}`}`,
      conversationId: conversation,
      ...(serverId ? { serverId } : {}),
      ...(typeof m.replyTo === "string" && MSGID.test(m.replyTo) ? { replyTo: m.replyTo } : {}),
      authorAccount: m.nick,
      authorNick: m.nick,
      text: m.action ? `\x01ACTION ${m.text}\x01` : m.text,
      time: m.time,
      state: "confirmed",
      ...(poll ? { poll } : {}),
    });
    if (serverId && Array.isArray(m.reactions)) {
      const chips = m.reactions.filter((r) => r && typeof r.emoji === "string" && Number.isInteger(r.count) && r.count > 0)
        .map((r) => ({ emoji: r.emoji, count: r.count, mine: false, accounts: Array.isArray(r.accounts) ? r.accounts.filter((a): a is string => typeof a === "string") : [] }));
      if (chips.length) reactions[serverId] = chips;
    }
  });
  const polls: Record<number, PollView | "missing"> = {};
  for (const id of cards) {
    const view = body.polls?.[id] as PollView | undefined;
    polls[id] = view && typeof view === "object" && view.id === id && Array.isArray(view.options) ? { ...view, mine: [], canClose: false } : "missing";
  }
  const embeds: Record<string, EmbedMeta> = {};
  for (const [url, raw] of Object.entries(body.embeds ?? {})) {
    const meta = embedMetaFromResponse(raw);
    if (meta && /^https?:\/\//.test(url)) embeds[url] = meta;
  }
  const avatars: Record<string, number> = {};
  for (const [nick, version] of Object.entries(body.avatars ?? {})) if (typeof version === "number" && version > 0) avatars[nick.toLowerCase()] = version;
  return { conversation, messages, reactions, polls, embeds, avatars };
}

// A control inside the read-only shell that needs an account. Links, the media viewer and the
// shell's own chrome (sidebar toggle, sign-in bar) still work.
const elementOf = (target: EventTarget | null): Element | null => (typeof Element !== "undefined" && target instanceof Element ? target : null);

export function needsAccount(target: EventTarget | null): boolean {
  const el = elementOf(target);
  if (!el || !el.closest("#chat, header, .peek-rooms")) return false;
  if (el.closest("[data-peek-ok], .message-media, a[href]")) return false;
  return !!el.closest("button, [role='button'], [role='menuitem'], input, select, textarea, .mention");
}

export function createPeekView(deps: {
  ui: Pick<ClientState, "peekRoom" | "peekSignIn" | "peekPending" | "authenticated" | "booting" | "messages" | "reactions" | "embeds" | "avatarVersions" | "channel" | "direct" | "roomLabel" | "currentConversationId" | "openRooms" | "activeThread" | "notesOpen" | "sendReason">;
  polls: { prime(views: Record<number, PollView | "missing">): void };
  scrollToBottom(force?: boolean): void;
  nextTick(callback: () => void): void;
  signedInBefore(): boolean;
  // The bare root became the room: show its screen (on a phone the root is the Home tab).
  openRoom?(channel: string): void;
  fetcher?: typeof fetch;
}) {
  const { ui } = deps;
  const request = deps.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let name = "";
  let loadedAt = 0;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let listening = false;
  let stopped = false;
  let last: PeekPayload | null = null;

  const active = () => !stopped && !ui.authenticated;

  function apply(body: PeekPayload): void {
    if (!active()) return;
    const first = !ui.peekRoom;
    const state = peekState(body);
    deps.polls.prime(state.polls);
    ui.embeds = { ...ui.embeds, ...state.embeds };
    ui.avatarVersions = state.avatars;
    ui.reactions = state.reactions;
    ui.channel = body.channel;
    ui.direct = false;
    ui.roomLabel = "";
    ui.activeThread = null;
    ui.notesOpen = false;
    ui.openRooms = { [body.channel]: true };
    // Signed out has no composer, so its "sending unavailable" reason is not news here.
    ui.sendReason = "";
    ui.currentConversationId = state.conversation;
    ui.messages = state.messages;
    ui.peekRoom = body.channel;
    deps.nextTick(() => deps.scrollToBottom(first));
  }

  async function read(): Promise<void> {
    if (!name || !active()) return;
    try {
      const response = await request(`/api/peek/${name}`, { headers: { Accept: "application/json" }, credentials: "same-origin" });
      if (!response.ok) return;
      const body = await response.json() as PeekPayload;
      if (typeof body?.channel !== "string" || !Array.isArray(body.messages)) return;
      loadedAt = Date.now();
      last = body;
      apply(body);
    } catch {}
  }

  function refresh(): Promise<void> {
    return inFlight ??= read().finally(() => { inFlight = null; ui.peekPending = false; });
  }

  function onVisible(): void {
    if (!document.hidden && active() && ui.peekRoom && Date.now() - loadedAt >= PEEK_STALE_MS) void refresh();
  }

  function listen(): void {
    if (listening || typeof document === "undefined") return;
    listening = true;
    timer = setInterval(() => { if (!document.hidden) void refresh(); }, PEEK_REFRESH_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    // Capture runs before any row or header handler, so nothing that needs an account fires.
    document.addEventListener("click", gate, true);
    document.addEventListener("touchstart", gateTouch, { capture: true, passive: true });
    document.addEventListener("keydown", gateKey, true);
  }

  function gate(event: Event): void {
    if (!active() || !ui.peekRoom || ui.peekSignIn || !needsAccount(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    signIn();
  }
  // A long press on a row would open the message sheet; a signed-out press does nothing there.
  function gateTouch(event: Event): void {
    if (!active() || !ui.peekRoom) return;
    const el = elementOf(event.target);
    if (el?.closest("#chat .msg") && !el.closest("a[href], .message-media")) event.stopImmediatePropagation();
  }

  // Typing is posting: a printable key anywhere in the room (a focused row's shortcuts included)
  // opens sign-in, the way it would land in the composer when signed in. Fields keep their keys.
  function gateKey(event: KeyboardEvent): void {
    if (!active() || !ui.peekRoom || ui.peekSignIn || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key.length !== 1 || event.key === " ") return;
    const el = elementOf(event.target);
    if (el?.closest("input, textarea, select, [contenteditable], dialog, .auth-modal")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    signIn();
  }

  // The sign-in card opens over the room with the email field ready.
  function signIn(): void {
    ui.peekSignIn = true;
    deps.nextTick(() => {
      if (typeof document === "undefined") return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      document.querySelector<HTMLInputElement>(".auth-card input[type='email']")?.focus();
    });
  }

  return {
    // Called at boot: a signed-out landing on /open-chat reads the room alongside /auth/me, so the
    // shell paints as soon as both answer. A browser that was signed in before waits for /auth/me.
    start(): void {
      if (!landing || deps.signedInBefore()) return;
      name = landing;
      ui.peekPending = true;
      void refresh();
    },
    // /auth/me said nobody is signed in; `playground` is its public-playground signup flag and
    // `openRoom` is the instance's configured public room (defaulting to #open-chat).
    signedOut(playground = false, openRoom?: string): void {
      const slug = peekRoomSlug(openRoom);
      const direct = peekPath(initialLocation.pathname, initialLocation.hash, slug)
        || (typeof location === "undefined" ? "" : peekPath(location.pathname, location.hash, slug));
      const fromRoot = rootPeekPath(initialLocation.pathname, initialLocation.hash, initialLocation.search, playground, slug);
      const target = direct || fromRoot;
      if (!target || stopped) {
        name = "";
        ui.peekPending = false;
        return;
      }
      if (target !== name) {
        name = target;
        last = null;
        inFlight = null;
      }
      if (playground && (fromRoot || initialLocation.pathname.replace(/\/+$/, "").toLowerCase() === `/${target}`)) {
        deps.openRoom?.(`#${target}`);
      }
      listen();
      // Signing out resets the shared transcript state; an answer that landed first is drawn again.
      if (last) { ui.peekRoom = ""; apply(last); } else if (!inFlight) { ui.peekPending = true; void refresh(); }
    },
    // Signed in: the normal app takes over the same state.
    stop(): void {
      stopped = true;
      ui.peekRoom = "";
      ui.peekSignIn = false;
      ui.peekPending = false;
      if (timer) clearInterval(timer);
      timer = null;
      if (listening) {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", onVisible);
        document.removeEventListener("click", gate, true);
        document.removeEventListener("touchstart", gateTouch, true);
        document.removeEventListener("keydown", gateKey, true);
      }
      listening = false;
    },
    refresh,
    signIn,
    keepReading(): void { ui.peekSignIn = false; },
  };
}
