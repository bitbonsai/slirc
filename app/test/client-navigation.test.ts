import { describe, expect, test } from "bun:test";
import { conversationId, type Draft } from "../client/model.ts";
import {
  createNavigation,
  messageLinkLabel,
  parseRoute,
  sharedDmScreen,
  resolveConversationId,
  routeUrl,
  type ConversationDirectory,
  type HistoryAdapter,
  type ScrollAnchors,
  type Screen,
} from "../client/navigation.ts";

const ORIGIN = "https://app.slirc.org";
const THREAD_ROOM = "#t-abc";

const dm = (nick: string, focusMessageId?: string): Screen => ({ kind: "dm", nick, focusMessageId });
const room = (name: string, focusMessageId?: string): Screen => ({ kind: "room", room: name, focusMessageId });

const directory: ConversationDirectory = {
  dmPeerAccountId: (nick) => (nick === "Alice" ? "acct-alice" : undefined),
  // Thread metadata (parentId/rootServerId) resolves the child `#t-*` room in the store; the router
  // only consumes the resulting stable id.
  roomConversationId: (name) => (name === THREAD_ROOM ? conversationId("thread", "dm:acct-alice:srv-1") : undefined),
};

function recorder() {
  const pushes: string[] = [];
  const replaces: string[] = [];
  let backs = 0;
  const history: HistoryAdapter = {
    push: (url) => pushes.push(url),
    replace: (url) => replaces.push(url),
    back: () => { backs += 1; },
  };
  return { history, pushes, replaces, backs: () => backs };
}

describe("route parsing matches the shipped URL format and stays inside the app", () => {
  test("tabs, rooms, DMs, message focus, and thread rooms parse and round-trip", () => {
    const cases: Screen[] = [
      { kind: "tab", tab: "home" },
      { kind: "tab", tab: "dms" },
      { kind: "tab", tab: "more" },
      { kind: "profile" },
      { kind: "settings" },
      { kind: "channels" },
      { kind: "invitations" },
      { kind: "irc" },
      { kind: "agents" },
      { kind: "admin" },
      { kind: "join", token: "invite-token" },
      room("#untitled"),
      room("#help"),
      dm("Alice"),
      room("#untitled", "srv-1"), // parent-message focus, not a thread route
      dm("Alice", "srv-1"), // DM parent focus, not a child thread
      room(THREAD_ROOM),
    ];
    for (const screen of cases) {
      const url = routeUrl(screen);
      expect(parseRoute(url, ORIGIN)).toEqual(screen);
      expect(parseRoute(new URL(url, ORIGIN).href, ORIGIN)).toEqual(screen);
    }
    expect(routeUrl(room("#untitled"))).toBe("/#untitled");    expect(routeUrl(room("#untitled", "srv-1"))).toBe("/?room=%23untitled&msg=srv-1");
    expect(routeUrl(dm("Alice"))).toBe("/dm/Alice");
    expect(routeUrl(dm("Alice", "srv-1"))).toBe("/dm/Alice?msg=srv-1");
    expect(routeUrl(room(THREAD_ROOM))).toBe("/#t-abc");
    expect(routeUrl({ kind: "profile" })).toBe("/profile");
    expect(parseRoute("/profile", ORIGIN)).toEqual({ kind: "profile" });
    expect(parseRoute("/channels", ORIGIN)).toEqual({ kind: "channels" });
    expect(parseRoute("/prelaunch", ORIGIN)).toEqual({ kind: "invitations" });
    expect(parseRoute("/prelaunch/extra", ORIGIN)).toBeNull();
    expect(routeUrl({ kind: "channels" })).toBe("/channels");
    expect(parseRoute("/clients", ORIGIN)).toEqual({ kind: "irc" });
    expect(routeUrl({ kind: "irc" })).toBe("/clients");
    expect(parseRoute("/agents", ORIGIN)).toEqual({ kind: "agents" });
    expect(routeUrl({ kind: "agents" })).toBe("/agents");
    expect(parseRoute("/admin", ORIGIN)).toEqual({ kind: "admin" });
    expect(routeUrl({ kind: "admin" })).toBe("/admin");
    expect(resolveConversationId({ kind: "settings" })).toBeNull();
    expect(resolveConversationId({ kind: "channels" })).toBeNull();
    expect(resolveConversationId({ kind: "irc" })).toBeNull();
    expect(resolveConversationId({ kind: "agents" })).toBeNull();
    expect(resolveConversationId({ kind: "admin" })).toBeNull();
    expect(routeUrl({ kind: "join", token: "invite-token" })).toBe("/join/invite-token");
    expect(parseRoute("/join/invite-token", ORIGIN)).toEqual({ kind: "join", token: "invite-token" });
    expect(resolveConversationId({ kind: "join", token: "invite-token" })).toBeNull();
    expect(parseRoute("/open-chat", ORIGIN)).toEqual(room("#open-chat"));
    expect(parseRoute("/feedback", ORIGIN)).toBeNull();
    expect(parseRoute("/feedback", ORIGIN, ["#feedback"])).toEqual(room("#feedback"));
    expect(parseRoute("/feedback?msg=srv-1", ORIGIN, ["#feedback"])).toEqual(room("#feedback", "srv-1"));
    expect(parseRoute("/unknown", ORIGIN, ["#feedback"])).toBeNull();
    expect(parseRoute("/?msg=srv-1#untitled", ORIGIN)).toEqual(room("#untitled", "srv-1"));
  });

  test("unsafe, foreign, lookalike, and malformed URLs are rejected", () => {
    const rejected = [
      "//evil.example/#untitled", // protocol-relative
      "//app.slirc.org/#untitled",
      "\\\\app.slirc.org/#untitled",
      "/dm/Alice#untitled",
      "https://evil.example/#untitled",
      "https://app.slirc.org.evil.example/#untitled", // lookalike origin
      "https://app.slirc.org@evil.example/#untitled", // userinfo hides real host
      "https://user:pass@app.slirc.org/#untitled",
      "http://app.slirc.org/#untitled", // scheme downgrade
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://app.slirc.org/abc",
      "/dm/%ZZ",
      "/dm/Alice%",
      "/?room=%",
      "/#bad%2",
      "/#bad room",
      "/#",
      "/#untitled\n",
      "/dm/Alice\nmore",
      "/?msg=srv-1", // focus without a room to live in
      "/?room=%23untitled&msg=%00",
      "/?room=Alice", // `?room=` must be a channel; a DM uses /dm/<nick>
      "/dm/a%2Fb", // encoded slash must not smuggle a path segment
      "/dm/Alice?room=%23x", // room param is not part of a DM route
      "/dm/" + "a".repeat(33), // nick length
      "/unknown",
      "/settings#x",
      "/settings/extra",
      "/settings?room=%23untitled",
      "/channels#x",
      "/channels/extra",
      "/channels?room=%23untitled",
      "/clients#x",
      "/clients/extra",
      "/clients?room=%23untitled",
      "/agents#x",
      "/agents/extra",
      "/agents?room=%23untitled",
      "/profile#x",
      "/profile/extra",
      "/profile?room=%23untitled",
      "/join/",
      "/join/bad token",
      "/join/a/b",
      "/join/invite-token#x",
      "/pair/482917",
      "/docs/agents",
      "",
    ];
    for (const raw of rejected) expect(parseRoute(raw, ORIGIN)).toBeNull();
  });

  test("conversation ids are kind-scoped, not nick-scoped", () => {
    expect(resolveConversationId(dm("Alice"), directory)).toBe(conversationId("dm", "acct-alice"));
    expect(resolveConversationId(dm("Alice"), directory)).not.toBe(conversationId("dm", "Alice"));
    expect(resolveConversationId(dm("Alice"), {})).toBeNull(); // unknown peer account: no invented id
    expect(resolveConversationId(room("#Room"), {})).toBe(conversationId("room", "#room"));
    expect(resolveConversationId(room(THREAD_ROOM), directory)).toBe(conversationId("thread", "dm:acct-alice:srv-1"));
    expect(resolveConversationId(room(THREAD_ROOM), directory)).not.toBe(resolveConversationId(dm("Alice"), directory));
  });

  test("?msg= focuses a parent message and never selects a separate conversation", () => {
    const focusedRoom = room("#untitled", "srv-1");
    const focusedDm = dm("Alice", "srv-1");
    expect(resolveConversationId(focusedRoom, directory)).toBe(resolveConversationId(room("#untitled"), directory));
    expect(resolveConversationId(focusedDm, directory)).toBe(resolveConversationId(dm("Alice"), directory));
    expect((parseRoute("/?room=%23untitled&msg=srv-1", ORIGIN) as { focusMessageId?: string }).focusMessageId).toBe("srv-1");
  });
});

describe("explicit navigation is deterministic", () => {
  test("Profile is a routed detail: no conversation, back returns to its source", () => {
    const rec = recorder();
    const nav = createNavigation({ origin: ORIGIN, history: rec.history, directory });
    nav.open({ kind: "tab", tab: "home" }, { replace: true });
    nav.open(room("#untitled"));
    nav.open({ kind: "profile" });
    expect(nav.$state.get().screen).toEqual({ kind: "profile" });
    expect(nav.$state.get().conversationId).toBeNull();
    expect(rec.pushes.at(-1)).toBe("/profile");
    expect(nav.back()?.screen).toEqual(room("#untitled"));
    expect(resolveConversationId({ kind: "profile" }, directory)).toBeNull();
  });

  test("More is a first-class tab with no conversation and a normal back step", () => {
    const rec = recorder();
    const nav = createNavigation({ origin: ORIGIN, history: rec.history, directory });
    nav.open({ kind: "tab", tab: "home" }, { replace: true });
    nav.open(room("#untitled"));
    nav.back();
    const more = nav.tab("more");
    expect(more.screen).toEqual({ kind: "tab", tab: "more" });
    expect(more.conversationId).toBeNull();
    expect(rec.pushes.at(-1)).toBe("/more");
    expect(nav.canGoBack()).toBe(true);
    expect(nav.back()?.screen).toEqual({ kind: "tab", tab: "home" });
  });

  test("open/back/forward/pop select screens and never replay an event", () => {
    const rec = recorder();
    const nav = createNavigation({ origin: ORIGIN, history: rec.history, directory });

    nav.open({ kind: "tab", tab: "home" }, { replace: true });
    nav.open(dm("Alice"));
    const thread = room(THREAD_ROOM);
    nav.open(thread);
    expect(rec.pushes).toEqual(["/dm/Alice", "/#t-abc"]);
    expect(nav.canGoBack()).toBe(true);

    expect(nav.back()?.screen).toEqual(dm("Alice"));
    expect(nav.back()?.screen).toEqual({ kind: "tab", tab: "home" });
    expect(nav.back()).toBeUndefined();
    expect(rec.backs()).toBe(2);

    expect(nav.forward()?.screen).toEqual(dm("Alice"));
    expect(nav.pop(routeUrl(thread)).screen).toEqual(thread); // browser back into a recorded entry
    expect(nav.$state.get().index).toBe(2);

    // A pop to an unrecorded same-origin URL adopts it in place instead of appending.
    const before = rec.pushes.length;
    expect(nav.pop("/dms").screen).toEqual({ kind: "tab", tab: "dms" });
    expect(rec.pushes.length).toBe(before);
    expect(nav.pop("https://evil.example/#x").screen).toEqual({ kind: "tab", tab: "dms" });
  });

  test("repeated URL entries use browser position and forward updates the browser", () => {
    let forwarded = 0;
    const nav = createNavigation({ origin: ORIGIN, directory, history: { push() {}, replace() {}, back() {}, forward() { forwarded++; } } });
    nav.open(dm("Alice"));
    nav.open(room(THREAD_ROOM));
    nav.open(dm("Alice"));
    nav.open(room("#other"));
    nav.back();
    nav.pop("/dm/Alice", { nav: 2 });
    expect(nav.$state.get().index).toBe(2);
    expect(nav.back()?.screen).toEqual(room(THREAD_ROOM));
    nav.pop("/#t-abc", { nav: 1 });
    expect(nav.forward()?.screen).toEqual(dm("Alice"));
    expect(forwarded).toBe(1);
    nav.pop("/dm/Alice", { nav: 2 });
    expect(nav.$state.get().index).toBe(2);
    expect(() => nav.open({ kind: "room", room: "#bad room" })).toThrow();
    expect(nav.$state.get().index).toBe(2);
  });

  test("late metadata never navigates; identity refresh is not a route change", () => {
    const rec = recorder();
    const nav = createNavigation({ origin: ORIGIN, history: rec.history });
    nav.open(dm("Alice"));

    const seen: Screen[] = [];
    const unsubscribe = nav.$state.subscribe((state) => seen.push(state.screen));
    const pushes = rec.pushes.length;
    const replaces = rec.replaces.length;

    nav.setDirectory(directory);
    expect(rec.pushes.length).toBe(pushes);
    expect(rec.replaces.length).toBe(replaces);
    expect(nav.$state.get().screen).toEqual(dm("Alice"));
    expect(nav.$state.get().conversationId).toBeNull();

    nav.refreshConversationId();
    expect(nav.$state.get().conversationId).toBe(conversationId("dm", "acct-alice"));
    expect(rec.pushes.length).toBe(pushes);
    expect(nav.$state.get().length).toBe(1);
    expect(seen.every((screen) => JSON.stringify(screen) === JSON.stringify(dm("Alice")))).toBe(true);
    unsubscribe();

    // No JOIN/history/provisioning callback exists to select a screen.
    const api = nav as unknown as Record<string, unknown>;
    for (const method of ["onJoin", "onHistory", "onProvisioned", "onMessage", "selectRoom", "setActiveTarget"]) {
      expect(typeof api[method]).toBe("undefined");
    }
  });
});

describe("DM -> thread -> back keeps scroll anchors and draft identity per conversation", () => {
  test("each conversation keeps its own anchor and draft identity", () => {
    const nav = createNavigation({ origin: ORIGIN, directory });
    nav.open({ kind: "tab", tab: "home" }, { replace: true });
    nav.open(dm("Alice"));
    const dmId = nav.$state.get().conversationId!;
    expect(dmId).toBe(conversationId("dm", "acct-alice"));

    const draft: Draft = { conversationId: dmId, revision: "edit-1", text: "half typed", updatedAt: 1 };
    nav.setScroll({ messageId: "dm-msg-9", offset: 41 });
    expect(nav.scrollFor()).toEqual({ messageId: "dm-msg-9", offset: 41 });

    nav.open(room(THREAD_ROOM));
    const threadId = nav.$state.get().conversationId!;
    expect(threadId).not.toBe(dmId);
    nav.setScroll({ messageId: "thread-msg-1", offset: 7 });

    nav.back();
    expect(nav.$state.get().screen).toEqual(dm("Alice"));
    expect(nav.$state.get().conversationId).toBe(dmId);
    expect(nav.scrollFor()).toEqual({ messageId: "dm-msg-9", offset: 41 });
    expect(nav.scrollFor(threadId)).toEqual({ messageId: "thread-msg-1", offset: 7 });
    expect(nav.$state.get().conversationId).toBe(draft.conversationId);

    nav.setScroll({ messageId: "", offset: 5 }); // invalid anchor cannot overwrite
    expect(nav.scrollFor()).toEqual({ messageId: "dm-msg-9", offset: 41 });
  });

  test("offline reload restores the thread route, anchor, and draft keying", () => {
    const first = createNavigation({ origin: ORIGIN, directory });
    first.open({ kind: "tab", tab: "home" }, { replace: true });
    first.open(dm("Alice"));
    const dmId = first.$state.get().conversationId!;
    first.setScroll({ messageId: "dm-msg-9", offset: 41 });
    const thread = room(THREAD_ROOM, "srv-1");
    first.open(thread);
    const threadId = first.$state.get().conversationId!;
    first.setScroll({ messageId: "root-1", offset: 7 });
    const persisted: ScrollAnchors = first.exportScrollAnchors();
    const deepLink = routeUrl(thread);

    // Reload while offline: no network, only the persisted anchors and the URL.
    const reloaded = createNavigation({ origin: ORIGIN, directory, initialScrollAnchors: persisted });
    const parsed = parseRoute(deepLink, ORIGIN)!;
    reloaded.open(parsed, { replace: true });
    expect(reloaded.$state.get().screen).toEqual(thread);
    expect(reloaded.$state.get().conversationId).toBe(threadId);
    expect(reloaded.scrollFor()).toEqual({ messageId: "root-1", offset: 7 });
    expect(reloaded.scrollFor(dmId)).toEqual({ messageId: "dm-msg-9", offset: 41 });
    const draft: Draft = { conversationId: reloaded.$state.get().conversationId!, revision: "edit-2", text: "thread reply", updatedAt: 2 };
    expect(draft.conversationId).toBe(threadId);
    expect(reloaded.canGoBack()).toBe(false);
  });
});

describe("Profile/channel/DM transitions and direct entry", () => {
  test("channel -> Profile -> channel and channel -> DM keep one back/forward stack", () => {
    const rec = recorder();
    const nav = createNavigation({ origin: ORIGIN, history: rec.history, directory });
    nav.open({ kind: "tab", tab: "home" }, { replace: true });
    nav.open(room("#untitled"));
    nav.open({ kind: "profile" });
    // Profile opens over the channel; its conversation id is null but the stack keeps the room.
    expect(nav.$state.get().screen).toEqual({ kind: "profile" });
    expect(nav.$state.get().conversationId).toBeNull();
    expect(nav.back()?.screen).toEqual(room("#untitled"));
    expect(nav.canGoBack()).toBe(true);
    expect(nav.forward()?.screen).toEqual({ kind: "profile" });
    // From Profile, opening a DM is a normal push on the same stack.
    nav.open(dm("Alice"));
    expect(nav.back()?.screen).toEqual({ kind: "profile" });
    expect(nav.back()?.screen).toEqual(room("#untitled"));
  });

  test("DM -> Profile -> back restores the DM conversation", () => {
    const nav = createNavigation({ origin: ORIGIN, directory });
    nav.open({ kind: "tab", tab: "home" }, { replace: true });
    nav.open(dm("Alice"));
    const dmId = nav.$state.get().conversationId;
    nav.open({ kind: "profile" });
    expect(nav.back()?.screen).toEqual(dm("Alice"));
    expect(nav.$state.get().conversationId).toBe(dmId);
  });

  test("direct entry to /profile is a single replace entry with no back step", () => {
    const rec = recorder();
    const nav = createNavigation({ origin: ORIGIN, history: rec.history, directory });
    const parsed = parseRoute("/profile", ORIGIN)!;
    nav.open(parsed, { replace: true });
    expect(rec.replaces).toEqual(["/profile"]);
    expect(rec.pushes).toEqual([]);
    expect(nav.canGoBack()).toBe(false);
    expect(nav.$state.get()).toMatchObject({ index: 0, length: 1, conversationId: null });
    // The bridge's documented fallback for a direct entry is the Home tab, not a silent no-op.
    expect(nav.tab("home").screen).toEqual({ kind: "tab", tab: "home" });
  });
});

describe("message and thread links", () => {
  test("a thread link round-trips and keeps its room and message", () => {
    const link = { kind: "room", room: "#untitled", focusMessageId: "srv-1", thread: true } as Screen;
    expect(routeUrl(link)).toBe("/?room=%23untitled&msg=srv-1&thread=1");
    expect(parseRoute(routeUrl(link), ORIGIN)).toEqual(link);
    expect(parseRoute("/dm/Alice?msg=srv-1&thread=1", ORIGIN)).toEqual({ kind: "dm", nick: "Alice", focusMessageId: "srv-1", thread: true });
    expect(parseRoute(`${ORIGIN}/?room=%23untitled&msg=srv-1`, ORIGIN)).toEqual(room("#untitled", "srv-1"));
  });

  test("a thread flag without a message, or with another value, is not a route", () => {
    for (const raw of ["/?room=%23untitled&thread=1", "/#untitled?thread=1", "/?room=%23untitled&msg=srv-1&thread=yes", "/dm/Alice?thread=1"]) {
      expect(parseRoute(raw, ORIGIN)).toBeNull();
    }
  });

  test("links to messages here get a short label; thread links say so", () => {
    expect(messageLinkLabel(`${ORIGIN}/?room=%23untitled&msg=srv-1`, ORIGIN)).toBe("View in #untitled");
    expect(messageLinkLabel(`${ORIGIN}/?room=%23untitled&msg=srv-1&thread=1`, ORIGIN)).toBe("View thread in #untitled");
    expect(messageLinkLabel("https://elsewhere.test/?room=%23untitled&msg=srv-1", ORIGIN)).toBeNull();
  });
});

describe("shared DM links", () => {
  test("a DM link names the DM channel, and each reader sees their own peer in the label", () => {
    const href = `${ORIGIN}/?room=%23dm-ada-ben&msg=srv-1`;
    expect(parseRoute(href, ORIGIN)).toEqual(room("#dm-ada-ben", "srv-1"));
    const peers: Record<string, Record<string, string>> = { ada: { "#dm-ada-ben": "ben" }, ben: { "#dm-ada-ben": "ada" } };
    expect(messageLinkLabel(href, ORIGIN, (channel) => peers.ada![channel])).toBe("View in DM with ben");
    expect(messageLinkLabel(href, ORIGIN, (channel) => peers.ben![channel])).toBe("View in DM with ada");
    // Someone outside the DM gets no name from the link.
    expect(messageLinkLabel(href, ORIGIN, () => undefined)).toBe("View in DM");
    expect(messageLinkLabel(`${href}&thread=1`, ORIGIN)).toBe("View thread in DM");
  });

  test("each person in the DM opens the same link as their own DM with the other", () => {
    const shared = parseRoute(`${ORIGIN}/?room=%23dm-ada-ben&msg=srv-1&thread=1`, ORIGIN)!;
    expect(sharedDmScreen(shared, () => "ben")).toEqual({ kind: "dm", nick: "ben", focusMessageId: "srv-1", thread: true });
    expect(sharedDmScreen(shared, () => "ada")).toEqual({ kind: "dm", nick: "ada", focusMessageId: "srv-1", thread: true });
    expect(sharedDmScreen(shared, () => undefined)).toBeNull(); // not in the DM: no access
    expect(sharedDmScreen(room("#general", "srv-1"), () => "ben")).toBeNull();
  });
});
