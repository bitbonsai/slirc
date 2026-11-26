// Route selection, back stack, and saved scroll anchors. No IRC, no network, no DOM: the UI bridge
// owns history/popstate and the durable store owns drafts. Late JOIN/history/provisioning events have
// no path into this module — only explicit open/back/forward/pop calls select a screen.
//
// Route semantics (what `/`, `/dms` and the other URLs below open):
//   `/`, `/dms`, `/more`                         tabs
//   `/#room`                                     a room (a `#t-*` thread room is a room too)
//   `/?room=%23room&msg=<id>`                    a room focused on one message (deep link)
//   `/?room=%23room&msg=<id>&thread=1`           the same, with that message's reply thread open
//   `/dm/<nick>`                                 a DM (wire `#dm-*` stays server-owned metadata)
//   `/dm/<nick>?msg=<id>`                        a DM focused on one message; NOT a child thread
//   `/?room=%23dm-…&msg=<id>`                    a shared DM message link: the DM's channel is the
//                                                same for both people, so each opener resolves it
//   `/notes`                                     your private Notes (`/dm/<you>` lands here too)
// A thread is a distinct `#t-*` room selected as a room; thread metadata supplies its parentId and
// rootServerId, and this router only maps the route to a stable conversation id.
import { atom, type ReadableAtom } from "nanostores";
import { conversationId, type ScrollAnchor } from "./model.ts";

export type Tab = "home" | "dms" | "more";
export type Screen =
  | { kind: "tab"; tab: Tab }
  | { kind: "profile" }
  | { kind: "settings" }
  | { kind: "channels" }
  | { kind: "invitations" }
  | { kind: "join"; token: string }
  | { kind: "admission"; token: string; destination: "help" | "founder" }
  | { kind: "irc" }
  | { kind: "agents" }
  | { kind: "admin" }
  | { kind: "room"; room: string; focusMessageId?: string; thread?: true }
  | { kind: "dm"; nick: string; focusMessageId?: string; thread?: true }
  | { kind: "notes" };

export interface ConversationDirectory {
  /** Local metadata override for a room conversation id, including `#t-*` thread rooms. */
  roomConversationId?(room: string): string | undefined;
  /** Display nick -> immutable peer account id. Absent until local metadata knows the DM. */
  dmPeerAccountId?(nick: string): string | undefined;
}

export interface NavigationState {
  screen: Screen;
  conversationId: string | null; // resolved at selection; null until local metadata exists
  index: number;
  length: number;
}

export type ScrollAnchors = Record<string, ScrollAnchor>;

export interface HistoryAdapter {
  push(url: string, state: unknown): void;
  replace(url: string, state: unknown): void;
  back?(): void;
  forward?(): void;
}

export interface NavigationOptions {
  origin: string; // trusted app origin, e.g. "https://app.slirc.org"
  history?: HistoryAdapter;
  directory?: ConversationDirectory;
  initialScrollAnchors?: ScrollAnchors;
}

export interface Navigation {
  $state: ReadableAtom<NavigationState>;
  $scrollAnchors: ReadableAtom<ScrollAnchors>;
  open(screen: Screen, options?: { replace?: boolean }): NavigationState;
  tab(tab: Tab): NavigationState;
  back(): NavigationState | undefined;
  forward(): NavigationState | undefined;
  pop(url: string | URL, state?: { nav?: number }): NavigationState;
  canGoBack(): boolean;
  /** Swap metadata. Never selects or re-selects a screen. */
  setDirectory(directory: ConversationDirectory): void;
  /** Fill in the current conversation id after late metadata. Updates data, not the route. */
  refreshConversationId(): NavigationState;
  setScroll(anchor: ScrollAnchor): void;
  scrollFor(id?: string | null): ScrollAnchor | undefined;
  exportScrollAnchors(): ScrollAnchors;
  restoreScrollAnchors(anchors: ScrollAnchors): void;
}

// Notes live only in the app, never on IRC, so their conversation id has no kind prefix to collide with.
export const NOTES_CONVERSATION_ID = "notes";

const BAD_ESCAPE = /%(?![0-9a-fA-F]{2})/;
const CONTROL = /[\x00-\x1f\x7f]/;
const CHANNEL = /^#[a-z0-9][a-z0-9_-]{0,63}$/i; // a room name the URL may carry
const NICK = /^[a-z0-9][a-z0-9_-]{0,31}$/i; // same shape the `/dm/:nick` server route allows
const MESSAGE_ID = /^[a-z0-9_-]{1,512}$/i; // same shape linkedMessage() accepts
const JOIN_TOKEN = /^[A-Za-z0-9_-]{1,128}$/; // email-invite and copied room-link tokens
const ADMISSION_TOKEN = /^[A-Za-z0-9_-]{1,512}$/; // opaque admission capability, fragment-only

function trustedOrigin(origin: string): URL {
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error("Navigation origin must be an absolute URL"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Navigation origin must be a bare http(s) origin");
  return url;
}

const DEFAULT_PUBLIC_ROOMS = new Set(["open-chat", "help"]);

function matchesPublicRoom(slug: string, publicRooms?: Iterable<string>): boolean {
  if (!slug || slug.includes("/") || !CHANNEL.test(`#${slug}`)) return false;
  if (DEFAULT_PUBLIC_ROOMS.has(slug)) return true;
  if (!publicRooms) return false;
  for (const room of publicRooms) {
    if (room.trim().replace(/^#/, "").toLowerCase() === slug) return true;
  }
  return false;
}

// A raw untrusted string (a stored thread URL, a shared link) is safe only if it is same-origin,
// http(s), free of controls/malformed escapes/credentials, and one of the routes the app serves.
export function parseRoute(raw: string, origin: string, publicRooms?: Iterable<string>): Screen | null {
  const base = trustedOrigin(origin);
  if (typeof raw !== "string" || CONTROL.test(raw) || raw.includes("\\")) return null;
  const input = raw.trim();
  if (!input || input.startsWith("//") || BAD_ESCAPE.test(input)) return null;

  let url: URL;
  try {
    url = new URL(input, base);
  } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.origin !== base.origin || url.username || url.password) return null;

  const params = url.searchParams;
  const focus = params.get("msg");
  const roomParam = params.get("room");
  if (focus !== null && !MESSAGE_ID.test(focus)) return null;
  if (roomParam !== null && !CHANNEL.test(roomParam)) return null;
  const threadParam = params.get("thread");
  if (threadParam !== null && (threadParam !== "1" || focus === null)) return null;
  // The focused message, plus its reply thread when the link asks for it.
  const focused = focus === null ? {} : { focusMessageId: focus, ...(threadParam ? { thread: true as const } : {}) };

  const path = url.pathname.replace(/\/+$/, "") || "/";
  const hash = url.hash.slice(1);

  // A capability link keeps its token and requested destination in the fragment: they never reach
  // the server as a path, query or redirect target, and they must not be mistaken for a fragment
  // room. This screen takes precedence over the `/#room` parsing below. The approved email format is
  // `/admission#token=<base64url>&destination=help|founder`; any other destination falls back to help.
  if (path === "/admission") {
    if (focus !== null || roomParam !== null) return null;
    const capability = new URLSearchParams(hash);
    const token = capability.get("token") || "";
    if (token && !ADMISSION_TOKEN.test(token)) return null;
    const destination = capability.get("destination") === "founder" ? "founder" as const : "help" as const;
    return { kind: "admission", token, destination };
  }
  if (/#/.test(input) && !url.hash) return null; // empty or invalid fragment

  if (path === "/") {
    if (hash) {
      const room = `#${hash}`;
      if (!CHANNEL.test(room) || (roomParam !== null && roomParam !== room)) return null;
      return { kind: "room", room, ...focused };
    }
    if (roomParam !== null) {
      return { kind: "room", room: roomParam, ...focused };
    }
    if (focus !== null) return null; // a focused message needs a room to live in
    return { kind: "tab", tab: "home" };
  }
  if (path === "/dms" || path === "/more") {
    if (hash || focus !== null || roomParam !== null) return null;
    return { kind: "tab", tab: path.slice(1) as Tab };
  }
  // Account pages share the app router on phone and desktop. `/clients` is the IRC-clients page
  // (`/irc` is the WebSocket relay, so the page takes the docs' own client-guide slug).
  if (path === "/prelaunch") return { kind: "invitations" };
  if (path === "/notes") return hash || focus !== null || roomParam !== null ? null : { kind: "notes" };
  if (path === "/profile" || path === "/settings" || path === "/channels" || path === "/invitations" || path === "/clients" || path === "/agents" || path === "/admin") {
    if (hash || focus !== null || roomParam !== null) return null;
    if (path === "/clients") return { kind: "irc" };
    return { kind: path.slice(1) as "profile" | "settings" | "channels" | "invitations" | "agents" | "admin" };
  }
  if (path.startsWith("/dm/")) {
    const nick = path.slice(4);
    if (!NICK.test(nick) || roomParam !== null || hash) return null;
    return { kind: "dm", nick, ...focused };
  }
  // An invitation or copied room link keeps its token in the route so signup, verification and the
  // zero-conversation bootstrap all land back on the same acceptance screen.
  if (path.startsWith("/join/")) {
    const token = path.slice(6);
    if (!JOIN_TOKEN.test(token) || hash || focus !== null || roomParam !== null) return null;
    return { kind: "join", token };
  }
  // Public rooms have their own server URLs; accept them as room screens for deep links.
  const publicSlug = path.slice(1).toLowerCase();
  if (matchesPublicRoom(publicSlug, publicRooms)) {
    if (hash || roomParam !== null) return null;
    return { kind: "room", room: `#${publicSlug}`, ...focused };
  }
  return null;
}

export function routeUrl(screen: Screen): string {
  if (screen.kind === "tab") return screen.tab === "home" ? "/" : `/${screen.tab}`;
  if (screen.kind === "profile" || screen.kind === "settings" || screen.kind === "channels" || screen.kind === "invitations" || screen.kind === "agents" || screen.kind === "admin") return `/${screen.kind}`;
  if (screen.kind === "irc") return "/clients";
  if (screen.kind === "notes") return "/notes";
  if (screen.kind === "join") return `/join/${screen.token}`;
  if (screen.kind === "admission") {
    const capability = new URLSearchParams();
    if (screen.token) capability.set("token", screen.token);
    capability.set("destination", screen.destination);
    return `/admission#${capability.toString()}`;
  }
  const thread = screen.thread && screen.focusMessageId ? "&thread=1" : "";
  if (screen.kind === "dm") {
    return screen.focusMessageId ? `/dm/${screen.nick}?msg=${encodeURIComponent(screen.focusMessageId)}${thread}` : `/dm/${screen.nick}`;
  }
  return screen.focusMessageId
    ? `/?room=${encodeURIComponent(screen.room)}&msg=${encodeURIComponent(screen.focusMessageId)}${thread}`
    : `/#${screen.room.replace(/^#/, "")}`;
}

// Conversation ids are kind-scoped and nick-independent: a DM's identity is the peer account id, a
// room's (including a `#t-*` thread) folds IRC casemapping and may come from local metadata.
export function resolveConversationId(screen: Screen, directory: ConversationDirectory = {}): string | null {
  if (screen.kind === "tab" || screen.kind === "profile" || screen.kind === "settings" || screen.kind === "channels" || screen.kind === "invitations" || screen.kind === "join" || screen.kind === "admission" || screen.kind === "irc" || screen.kind === "agents" || screen.kind === "admin") return null;
  if (screen.kind === "notes") return NOTES_CONVERSATION_ID;
  if (screen.kind === "room") return directory.roomConversationId?.(screen.room) ?? conversationId("room", screen.room);
  const account = directory.dmPeerAccountId?.(screen.nick);
  return account ? conversationId("dm", account) : null;
}

const noopHistory: HistoryAdapter = { push() {}, replace() {} };

// A short label for a link to one message on this instance, such as "View in #demo"; null for any
// other URL, which keeps showing in full. A `#t-*` room is a thread.
// A shared DM link names the DM's channel. For a reader in that DM it opens as their DM with the
// other person; anyone else keeps the room screen, which matches nothing they can read.
export function sharedDmScreen(screen: Screen, dmPeer: (channel: string) => string | undefined): Screen | null {
  if (screen.kind !== "room" || !/^#dm-/i.test(screen.room)) return null;
  const nick = dmPeer(screen.room);
  if (!nick || !NICK.test(nick)) return null;
  return { kind: "dm", nick, ...(screen.focusMessageId ? { focusMessageId: screen.focusMessageId } : {}), ...(screen.thread ? { thread: true as const } : {}) };
}

// A `#dm-*` room is a DM; `dmPeer` names the reader's peer in it when the reader has that DM.
export function messageLinkLabel(href: string, origin: string, dmPeer?: (channel: string) => string | undefined): string | null {
  const screen = parseRoute(href, origin);
  const what = screen && "thread" in screen && screen.thread ? "View thread" : "View";
  if (screen?.kind === "room" && screen.focusMessageId && /^#dm-/i.test(screen.room)) {
    const peer = dmPeer?.(screen.room);
    return peer ? `${what} in DM with ${peer}` : `${what} in DM`;
  }
  if (screen?.kind === "room" && screen.focusMessageId) return /^#t-/i.test(screen.room) ? "View in thread" : `${what} in ${screen.room}`;
  if (screen?.kind === "dm" && screen.focusMessageId) return `${what} in DM with ${screen.nick}`;
  return null;
}

export function createNavigation(options: NavigationOptions): Navigation {
  const base = trustedOrigin(options.origin);
  const history = options.history ?? noopHistory;
  let directory: ConversationDirectory = options.directory ?? {};

  interface Entry { screen: Screen; url: string; conversationId: string | null }
  const stack: Entry[] = [];
  let cursor = -1;

  const $state = atom<NavigationState>({ screen: { kind: "tab", tab: "home" }, conversationId: null, index: -1, length: 0 });
  const $scrollAnchors = atom<ScrollAnchors>({ ...(options.initialScrollAnchors ?? {}) });

  const publish = () => $state.set(cursor < 0
    ? { screen: { kind: "tab", tab: "home" }, conversationId: null, index: -1, length: stack.length }
    : { screen: stack[cursor]!.screen, conversationId: stack[cursor]!.conversationId, index: cursor, length: stack.length });

  const select = (screen: Screen, kind: "push" | "replace"): NavigationState => {
    const valid = parseRoute(routeUrl(screen), base.origin);
    if (!valid) throw new Error("Invalid navigation screen");
    const entry: Entry = { screen: valid, url: routeUrl(valid), conversationId: resolveConversationId(valid, directory) };
    if (kind === "push") {
      stack.splice(cursor + 1);
      stack.push(entry);
      cursor = stack.length - 1;
      history.push(entry.url, { nav: cursor });
    } else {
      if (cursor < 0) { stack.push(entry); cursor = 0; } else stack[cursor] = entry;
      history.replace(entry.url, { nav: cursor });
    }
    publish();
    return $state.get();
  };

  const move = (next: number): NavigationState | undefined => {
    if (next < 0 || next >= stack.length) return undefined;
    if (next < cursor) history.back?.();
    else if (next > cursor) history.forward?.();
    cursor = next;
    publish();
    return $state.get();
  };

  return {
    $state,
    $scrollAnchors,
    open: (screen, opts) => select(screen, opts?.replace ? "replace" : "push"),
    tab: (tab) => select({ kind: "tab", tab }, "push"),
    back: () => move(cursor - 1),
    forward: () => move(cursor + 1),
    pop: (raw, state) => {
      const screen = parseRoute(String(raw), base.origin);
      if (!screen) return $state.get();
      const url = routeUrl(screen);
      // Browser entries can share a URL. Their saved position, not the first URL match,
      // determines back/forward. A load/foreground pop at the current URL is a no-op.
      const position = state?.nav;
      if (Number.isInteger(position) && stack[position!]?.url === url) {
        cursor = position!;
        publish();
        return $state.get();
      }
      if (stack[cursor]?.url === url) return $state.get();
      const matches = stack.flatMap((entry, index) => entry.url === url ? [index] : []);
      if (matches.length === 1) { cursor = matches[0]!; publish(); return $state.get(); }
      // A browser-initiated pop to a URL we did not record: adopt it in place, never append.
      return select(screen, "replace");
    },
    canGoBack: () => cursor > 0,
    setDirectory: (next) => { directory = next; },
    refreshConversationId: () => {
      if (cursor >= 0) stack[cursor]!.conversationId = resolveConversationId(stack[cursor]!.screen, directory);
      publish();
      return $state.get();
    },
    setScroll: (anchor) => {
      const id = $state.get().conversationId;
      if (!id || !MESSAGE_ID.test(anchor.messageId)) return;
      const offset = Number.isFinite(anchor.offset) ? anchor.offset : 0;
      $scrollAnchors.set({ ...$scrollAnchors.get(), [id]: { messageId: anchor.messageId, offset } });
    },
    scrollFor: (id = $state.get().conversationId) => (id ? $scrollAnchors.get()[id] : undefined),
    exportScrollAnchors: () => ({ ...$scrollAnchors.get() }),
    restoreScrollAnchors: (anchors) => $scrollAnchors.set({ ...$scrollAnchors.get(), ...anchors }),
  };
}
