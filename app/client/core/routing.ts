import { conversationId, foldIdentifier, type Message } from "@client/model.ts";
import type { AuthorizedConversation } from "@client/sync.ts";
import { NOTES_CONVERSATION_ID, sharedDmScreen, type Screen, type createNavigation } from "@client/navigation.ts";
import { animatePhoneScreen, historyAvailability, phoneScreenDirection } from "@client/presentation.ts";
import { defaultConversationIdFor, type ThreadGrant } from "@client/access.ts";
import { DEV_CHANNEL } from "@client/protocol.ts";
import { expandedThreadParent, nestedThreads, toggleCollapsedParent, type NestedThreads } from "@client/threads.ts";
import { buildReplyIndex } from "@client/reply-threads.ts";
import { Composer } from "@client/drafts.ts";
import type { createNotes } from "@client/notes.ts";
import type { createTranscript } from "@client/transcript.ts";
import type { createMediaView } from "@client/media-view.ts";
import type { createTypingIndicators } from "@client/typing.ts";
import type { createMessageActions } from "@client/message-actions.ts";
import type { createConversationMenu } from "@client/conversation-menu.ts";
import type { createLinkActions } from "@client/link-actions.ts";
import type { createReminderNotice } from "@client/reminder-notice.ts";
import type { createGiphyPicker } from "@client/giphy-picker.ts";
import type { createComposerEditor } from "@client/composer-editor.ts";
import type { createPopupOpener } from "@client/popups.ts";
import type { createFounderWelcome } from "@client/founder-welcome.ts";
import type { createSettingsPage } from "@client/settings-page.ts";
import type { createIrcPage } from "@client/irc-page.ts";
import type { createAgentsPage } from "@client/agents-page.ts";
import type { createAdminPage } from "@client/admin-page.ts";
import type { createInvitationsPage } from "@client/invitations-page.ts";
import type { createAdmissionFounder, createAdmissionScreen } from "@client/admission.ts";
import type { createInvitationAccept } from "@client/invitation-accept.ts";
import type { createLinksView } from "@client/links-view.ts";
import type { createView } from "@client/view.ts";
import type { ClientDatabase } from "@client/db.ts";
import type { StagedMedia } from "@client/media-send.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

// One notice for a linked message that is missing, deleted or not readable, so a link never tells
// someone without access whether the message exists.
export const LINK_MISSING = "That message isn't available.";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RoutingDeps {
  state: Pick<RuntimeState, "authorized" | "composer" | "composerTextByConversation" | "connecting" | "db" | "navIntent" | "pendingDms" | "projection" | "roomId" | "stopped" | "sync">;
  ui: Pick<ClientState, "account" | "activeThread" | "adminRoute" | "admissionRoute" | "admissionSignIn" | "admissionToken" | "agentsRoute" | "authenticated" | "booting" | "channel" | "channelsRoute" | "collapsedThreadParents" | "composer" | "currentConversationId" | "defaultChannel" | "direct" | "directs" | "draftNote" | "editingMessageId" | "invitationsRoute" | "ircRoute" | "isDesktop" | "isFounder" | "joinRoute" | "joinToken" | "me" | "media" | "mentionOpen" | "messages" | "mobileNav" | "navIndex" | "navLength" | "notesOpen" | "pendingDm" | "pendingDmError" | "pendingDmState" | "profileRoute" | "roomLabel" | "roomsOpen" | "sendError" | "settingsRoute" | "slashOpen" | "threadError" | "threadParentOpen" | "threads" | "threadsOpen">;
  isDesktop: boolean;
  nav: ReturnType<typeof createNavigation>;
  notes: ReturnType<typeof createNotes>;
  transcript: () => ReturnType<typeof createTranscript>;
  mediaView: () => ReturnType<typeof createMediaView>;
  typing: () => ReturnType<typeof createTypingIndicators>;
  actions: () => ReturnType<typeof createMessageActions>;
  menus: () => ReturnType<typeof createConversationMenu>;
  links: () => ReturnType<typeof createLinkActions>;
  reminderNotice: () => ReturnType<typeof createReminderNotice>;
  giphy: () => ReturnType<typeof createGiphyPicker>;
  editor: () => ReturnType<typeof createComposerEditor>;
  openPopup: () => ReturnType<typeof createPopupOpener>;
  welcome: () => ReturnType<typeof createFounderWelcome>;
  nextTick: (callback?: () => void) => unknown;
  hint: (text: string) => void;
  dmPeerNick: (channel: string) => string | undefined;
  pendingIdForNick: (nick: string) => string | null;
  openReplyThread: (target: Message | string | null | undefined) => void;
  clearDraftFocus: (except?: string | null) => void;
  abandonPendingThread: () => void;
  closeReplyThread: () => void;
  cancelEdit: () => void;
  focusLoadedDraft: (id: string) => void;
  draftWriter: (targetDb: ClientDatabase) => ConstructorParameters<typeof Composer>[1];
  loadRoomMembers: (item: AuthorizedConversation | undefined, id: string | null) => void;
  restoreMediaDraft: (id: string) => Promise<void>;
  revokeMedia: (media: StagedMedia | null) => void;
  maybeFocusComposer: (force?: boolean) => void;
  scheduleMarkRead: () => void;
  connect: () => Promise<void>;
  applyChrome: () => void;
  pages: () => { settings: ReturnType<typeof createSettingsPage>; irc: ReturnType<typeof createIrcPage>; agents: ReturnType<typeof createAgentsPage>; adminStatus: ReturnType<typeof createAdminPage>; invitationsPage: ReturnType<typeof createInvitationsPage>; admissionFounder: ReturnType<typeof createAdmissionFounder>; invitationAccept: ReturnType<typeof createInvitationAccept>; admission: ReturnType<typeof createAdmissionScreen>; library: ReturnType<typeof createLinksView> };
}

export function createRouting(deps: RoutingDeps) {
  const { state: rs, ui, isDesktop, nav, notes, transcript, mediaView, typing, actions, menus, links, reminderNotice, giphy, editor, openPopup, welcome, nextTick, hint, dmPeerNick, pendingIdForNick, openReplyThread, clearDraftFocus, abandonPendingThread, closeReplyThread, cancelEdit, focusLoadedDraft, draftWriter, loadRoomMembers, restoreMediaDraft, revokeMedia, maybeFocusComposer, scheduleMarkRead, connect, applyChrome, pages } = deps;

  // The router owns tab/detail screens on both shells; no second navigation stack.
  // A desktop tab with no conversation in the route still needs a real room behind it: reloading
  // /profile leaves no back entry, so its fallback Home tab lands on an authorized room or DM.
  function defaultConversationId(): string | null {
    return defaultConversationIdFor(rs.authorized);
  }

  let phoneAnimation: Animation | null = null;
  function cancelPhoneAnimation(): void { phoneAnimation?.cancel(); phoneAnimation = null; }

  function applyNav(state: { screen: Screen; index: number; length: number }): void {
    const screen = state.screen;
    const navigating = state.index !== ui.navIndex;
    const direction = phoneScreenDirection(ui.mobileNav, screen, state.index < ui.navIndex);
    const animate = navigating && !ui.isDesktop && !ui.booting && ui.authenticated;
    if (navigating) { phoneAnimation?.cancel(); phoneAnimation = null; }
    const page = screen.kind === "tab" ? screen.tab : screen.kind;
    const incoming = animate ? document.querySelector<HTMLElement>(screen.kind === "tab" || screen.kind === "profile" || screen.kind === "settings" || screen.kind === "channels" || screen.kind === "invitations" || screen.kind === "join" || screen.kind === "admission" || screen.kind === "irc" || screen.kind === "agents" || screen.kind === "admin" ? `[data-phone-screen="${page}"]` : "#chat") : null;
    const animation = animate ? animatePhoneScreen(incoming, matchMedia("(prefers-reduced-motion: reduce)").matches, direction) : null;
    if (animation) phoneAnimation = animation;
    ui.navIndex = state.index;
    ui.navLength = state.length;
    const enteringSettings = screen.kind === "settings" && !ui.settingsRoute;
    const enteringIrc = screen.kind === "irc" && !ui.ircRoute;
    const enteringProfile = screen.kind === "profile" && !ui.profileRoute;
    const enteringAgents = screen.kind === "agents" && !ui.agentsRoute;
    const enteringAdmin = screen.kind === "admin" && !ui.adminRoute;
    const enteringInvitations = screen.kind === "invitations" && !ui.invitationsRoute;
    ui.profileRoute = screen.kind === "profile";
    ui.settingsRoute = screen.kind === "settings";
    ui.channelsRoute = screen.kind === "channels";
    ui.invitationsRoute = screen.kind === "invitations";
    ui.ircRoute = screen.kind === "irc";
    ui.agentsRoute = screen.kind === "agents";
    ui.adminRoute = screen.kind === "admin";
    ui.joinRoute = screen.kind === "join";
    ui.joinToken = screen.kind === "join" ? screen.token : "";
    if (screen.kind !== "admission") ui.admissionSignIn = false;
    ui.admissionRoute = screen.kind === "admission";
    ui.admissionToken = screen.kind === "admission" ? screen.token : "";
    ui.mobileNav = !isDesktop && screen.kind === "tab" ? screen.tab : null;
    pages().library.sync();
    if ((enteringSettings || enteringProfile) && ui.authenticated) pages().settings.open();
    if (enteringIrc && ui.authenticated) pages().irc.open();
    if (enteringAgents && ui.authenticated) pages().agents.open();
    if (enteringAdmin && ui.authenticated) pages().adminStatus.open();
    // Invitations carries the founder-only review section on the same page, so opening it also
    // loads admission requests for the instance owner.
    if (enteringInvitations && ui.authenticated) { pages().invitationsPage.open(); if (ui.isFounder) pages().admissionFounder.open(); }
    // The join info fetch is public, so load it before authentication is known; acceptance is a
    // real authenticated call later.
    if (screen.kind === "join") void pages().invitationAccept.start(screen.token);
    // The admission screen never fetches on open; start() only reads the persisted attempt state.
    if (screen.kind === "admission") pages().admission.start(screen.token, screen.destination);
    if (animation) void nextTick(() => requestAnimationFrame(() => {
      if (phoneAnimation !== animation || rs.stopped || ui.booting || !ui.authenticated || ui.navIndex !== state.index) { animation.cancel(); return; }
      animation.play();
    }));
    if (!ui.authenticated || screen.kind === "profile" || screen.kind === "settings" || screen.kind === "channels" || screen.kind === "invitations" || screen.kind === "join" || screen.kind === "admission" || screen.kind === "irc" || screen.kind === "agents" || screen.kind === "admin") return;
    if (ownDm(screen)) { nav.open({ kind: "notes" }, { replace: true }); return; }
    const shared = sharedDmScreen(screen, dmPeerNick);
    if (shared) { nav.open(shared, { replace: true }); return; }
    if (screen.kind === "notes") { selectConversation(NOTES_CONVERSATION_ID); return; }
    const direct = screen.kind === "dm" ? ui.directs.find((item: any) => foldIdentifier(item.nick) === foldIdentifier(screen.nick)) : null;
    const pendingId = screen.kind === "dm" ? pendingIdForNick(screen.nick) : null;
    const target = screen.kind === "room"
      ? rs.authorized.find((item) => item.kind !== "dm" && foldIdentifier(item.wireTarget) === foldIdentifier(screen.room))
      : direct ? rs.authorized.find((item) => item.kind === "dm" && item.wireTarget === direct.channel) : undefined;
    const focusMessageId = screen.kind === "room" || screen.kind === "dm" ? screen.focusMessageId : undefined;
    // A link to a conversation this account cannot read says only that the message is not there.
    if (focusMessageId && !target && !pendingId && rs.authorized.length) hint(LINK_MISSING);
    selectConversation(target?.conversationId ?? pendingId ?? (isDesktop && screen.kind === "tab" ? defaultConversationId() : null), focusMessageId, linkThread(screen));
  }

  // Your own nick is not a DM: /dm/<you> (a link, or a tap on your own name) opens Notes.
  function ownDm(screen: Screen): boolean {
    return screen.kind === "dm" && !!ui.account && foldIdentifier(screen.nick) === foldIdentifier(ui.account);
  }

  function openNotes(): void { rs.navIntent += 1; nav.open({ kind: "notes" }); }

  // Open Notes shows the notes as its rows, so the menu, edit and delete find them like messages.
  function notesRows(): Message[] { return notes.messages(ui.account, ui.me || ui.account); }

  function showNotes(): void {
    if (!ui.notesOpen) return;
    ui.messages = notesRows();
    void transcript().loadEmbeds(ui.messages);
    void mediaView().loadUploadDims(ui.messages);
  }

  function linkThread(screen: Screen): boolean {
    return (screen.kind === "room" || screen.kind === "dm") && !!screen.thread;
  }

  // A linked message may be older than the cache: ask the server for the history around it once
  // the conversation is ready, then jump. A reply opens its thread at the root; so does a thread
  // link. Missing, deleted or unreadable shows the same short notice.
  let linkRun = 0;

  async function focusLinked(id: string, serverId: string, thread = false): Promise<void> {
    const run = ++linkRun;
    const current = () => run === linkRun && rs.roomId === id && !rs.stopped;
    const cached = await rs.db?.messages.where("[conversationId+serverId]").equals([id, serverId]).first().catch(() => undefined);
    let found = !!cached && cached.state === "confirmed" && !cached.deleted;
    if (!found && rs.authorized.some((entry) => entry.conversationId === id)) {
      for (let wait = 0; wait < 75 && current() && !rs.sync?.isReady(id); wait++) await sleep(200);
      let answer: boolean | null = null;
      for (let tries = 0; tries < 10 && current() && answer === null; tries++) {
        answer = rs.sync ? await rs.sync.around(id, serverId) : null;
        if (answer === null) await sleep(300);
      }
      found = answer === true;
    }
    if (!current()) return;
    if (!found) { hint(LINK_MISSING); return; }
    let message: Message | undefined;
    for (let wait = 0; wait < 20 && current() && !(message = ui.messages.find((item: Message) => item.serverId === serverId)); wait++) await sleep(100);
    if (!current() || !message) return;
    const rootId = buildReplyIndex(ui.messages).rootByMessageId.get(message.id);
    const opens = !!(rootId || thread);
    if (opens) openReplyThread(rootId ?? serverId);
    transcript().focus(rootId ?? serverId, { flash: !opens });
  }

  function selectConversation(id: string | null, focusMessageId?: string, focusThread = false): void {
    linkRun += 1;
    clearDraftFocus(id);
    // Leaving a conversation ends our own typing there; the target is still the previous roomId.
    if (rs.roomId !== id) { typing().stopTyping(); abandonPendingThread(); closeReplyThread(); }
    ui.currentConversationId = id;
    transcript().cancelConversationTransition();
    actions().closeActions();
    menus().starMenuId = ""; menus().navMenu = null; menus().copyFlyout = null;
    links().closeLinkPopup(false);
    const item = rs.authorized.find((entry) => entry.conversationId === id);
    const pending = id ? rs.pendingDms.get(id) : undefined;
    const thread = id ? ui.threads.find((entry: ThreadGrant) => entry.conversationId === id) : null;
    ui.threadParentOpen = thread?.parent ?? (item && item.kind !== "thread" ? item.wireTarget : "");
    // Leaving the message's conversation abandons the edit and restores the saved draft.
    if (ui.editingMessageId && rs.roomId !== id) cancelEdit();
    ui.threadError = "";
    // openScope may already have this composer's room selected before its visible identity is set.
    const direct = item?.kind === "dm" ? ui.directs.find((entry: any) => entry.channel === item.wireTarget) : null;
    ui.notesOpen = id === NOTES_CONVERSATION_ID;
    if (ui.notesOpen) void notes.load();
    ui.channel = ui.notesOpen ? "" : pending?.nick ?? direct?.nick ?? item?.wireTarget ?? DEV_CHANNEL;
    ui.roomLabel = ui.notesOpen ? "Notes" : pending?.nick ?? thread?.title ?? ui.channel;
    ui.activeThread = pending ? null : thread ?? null;
    ui.direct = pending ? true : item?.kind === "dm";
    ui.pendingDm = !!pending;
    ui.pendingDmState = pending?.state ?? "";
    ui.pendingDmError = pending?.error ?? "";
    // A channel with the links helper may open on its Links view.
    pages().library.sync();
    if (rs.roomId === id && rs.composer) { if (focusMessageId) void focusLinked(id!, focusMessageId, focusThread); focusLoadedDraft(id!); return; }
    transcript().prepare(rs.roomId, id, !ui.booting && ui.authenticated);
    if (rs.roomId && rs.composer) rs.composerTextByConversation.set(rs.roomId, rs.composer.text);
    rs.roomId = id;
    reminderNotice().viewed(id);
    rs.projection?.select(id, focusMessageId);
    const selectedDb = rs.db;
    rs.composer = id && selectedDb ? new Composer(id, draftWriter(selectedDb)) : null;
    const selectedComposer = rs.composer;
    if (selectedComposer) selectedComposer.onNote = (note) => {
      if (rs.db === selectedDb && rs.composer === selectedComposer && !rs.stopped) ui.draftNote = note;
    };
    ui.composer = ""; ui.messages = []; ui.sendError = "";
    showNotes();
    if (focusMessageId && id) void focusLinked(id, focusMessageId, focusThread);
    void loadRoomMembers(item, id);
    // A conversation switch closes any open lightbox; it belongs to the previous conversation.
    if (mediaView().lightbox) mediaView().closeLightbox();
    giphy().resetSearch(); ui.slashOpen = false;
    ui.mentionOpen = false;
    window.dispatchEvent(new CustomEvent("slirc:slash-reset"));
    window.dispatchEvent(new CustomEvent("slirc:mention-reset"));
    // Restore this conversation's staged photo from Dexie (or clear the previous one).
    if (id && selectedDb) void restoreMediaDraft(id);
    else { revokeMedia(ui.media); ui.media = null; }
    if (rs.composer && rs.composerTextByConversation.has(id!)) {
      const text = rs.composerTextByConversation.get(id!)!;
      if (text) rs.composer.edit(text);
      ui.composer = text;
      focusLoadedDraft(id!);
    } else if (selectedComposer && selectedDb) {
      void selectedDb.drafts.get(id!).then((draft) => {
        if (rs.roomId !== id || rs.composer !== selectedComposer || rs.db !== selectedDb || selectedComposer.revision !== null) return;
        selectedComposer.load(draft); ui.composer = selectedComposer.text; editor().resizeComposer(); focusLoadedDraft(id!);
      });
    }
    // Desktop room switch lands the caret in the composer once the new room is on screen. A late
    // navigation invalidates this via transcript.version(), and the guards keep dialogs, Profile and
    // phone focus untouched.
    const focusVersion = transcript().version();
    void nextTick(() => { if (ui.isDesktop && focusVersion === transcript().version() && rs.roomId === id) maybeFocusComposer(true); });
    scheduleMarkRead();
  }

  // A deleted channel leaves the grant on the next refresh. Whoever had it open lands on the
  // default channel (or the first one left) with a short notice; everyone else just loses the row.
  function channelDeleted(channel: string): void {
    const wasOpen = rs.authorized.some((item) => item.conversationId === rs.roomId && item.kind !== "dm" && foldIdentifier(item.wireTarget) === foldIdentifier(channel));
    void rs.connecting.catch(() => {}).then(() => connect()).then(() => {
      if (rs.stopped || !wasOpen) return;
      const rooms = rs.authorized.filter((item) => item.kind === "room");
      const landing = rooms.find((item) => foldIdentifier(item.wireTarget) === foldIdentifier(ui.defaultChannel)) ?? rooms[0];
      if (landing) openRoom(landing.wireTarget);
      hint(`${channel} was deleted.`);
    });
  }

  // Removing an agent deletes its DM and threads, so a page showing them moves to the default room.
  function leaveRemovedAgent(nick: string): void {
    const direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
    ui.directs = ui.directs.filter((item: { nick: string }) => foldIdentifier(item.nick) !== foldIdentifier(nick));
    const screen = nav.$state.get().screen;
    const inThread = screen.kind === "room" && !!direct && ui.threads.some((thread: ThreadGrant) => foldIdentifier(thread.channel) === foldIdentifier(screen.room) && foldIdentifier(thread.parent) === foldIdentifier(direct.channel));
    if (!(screen.kind === "dm" && foldIdentifier(screen.nick) === foldIdentifier(nick)) && !inThread) return;
    const rooms = rs.authorized.filter((item) => item.kind === "room" && !item.wireTarget.startsWith("#t-"));
    const landing = rooms.find((item) => foldIdentifier(item.wireTarget) === foldIdentifier(ui.defaultChannel)) ?? rooms[0];
    rs.navIntent += 1;
    nav.open({ kind: "room", room: landing?.wireTarget ?? DEV_CHANNEL });
    hint(`${nick} was removed.`);
  }

  function openRoom(room: string = DEV_CHANNEL): void {
    const item = rs.authorized.find((entry) => entry.kind !== "dm" && foldIdentifier(entry.wireTarget) === foldIdentifier(room));
    if (item) { rs.navIntent += 1; nav.open({ kind: "room", room: item.wireTarget }); }
  }

  function openHome(): void { rs.navIntent += 1; nav.tab("home"); }

  function goBack(): void {
    rs.navIntent += 1;
    if (nav.canGoBack()) { nav.back(); transcript().noFade(); return; }
    nav.tab("home");
  }

  // Header chevrons read the mirrored router position; disabled when the stack has no step there.
  function canGoBack(): boolean { return historyAvailability(ui.navIndex, ui.navLength).back; }

  function canGoForward(): boolean { return historyAvailability(ui.navIndex, ui.navLength).forward; }

  function goForward(): void {
    rs.navIntent += 1;
    if (!canGoForward()) return;
    nav.forward();
    transcript().noFade();
  }

  function openDms(): void { rs.navIntent += 1; nav.tab("dms"); }

  function openMore(): void { rs.navIntent += 1; nav.tab("more"); }

  function openProfile(): void {
    rs.navIntent += 1;
    nav.open({ kind: "profile" });
    void welcome().load();
  }

  function openSettings(): void {
    rs.navIntent += 1;
    nav.open({ kind: "settings" });
  }

  function openChannels(): void {
    rs.navIntent += 1;
    nav.open({ kind: "channels" });
  }

  function openInvitations(): void {
    rs.navIntent += 1;
    nav.open({ kind: "invitations" });
  }

  function openIrc(): void {
    rs.navIntent += 1;
    nav.open({ kind: "irc" });
  }

  function openAgents(): void {
    rs.navIntent += 1;
    nav.open({ kind: "agents" });
  }

  function openAdmin(): void {
    rs.navIntent += 1;
    nav.open({ kind: "admin" });
  }

  // Mention profiles open immediately; IRC details and app profiles load independently.
  function toggleThreads(): void { ui.threadsOpen = !ui.threadsOpen; }

  // Parent link keeps the router as the only navigation authority; a DM parent becomes a DM route.
  function openThreadParent(): void {
    const parent = ui.activeThread?.parent;
    if (!parent) return;
    const root = ui.activeThread?.root;
    rs.navIntent += 1;
    if (/^#dm-/i.test(parent)) {
      const direct = ui.directs.find((item: any) => foldIdentifier(item.channel) === foldIdentifier(parent));
      if (direct) { nav.open({ kind: "dm", nick: direct.nick, ...(root ? { focusMessageId: root } : {}) }); return; }
    }
    nav.open({ kind: "room", room: parent, ...(root ? { focusMessageId: root } : {}) });
  }

  function activeConversation(): AuthorizedConversation | undefined {
    return rs.authorized.find((item) => item.conversationId === rs.roomId);
  }

  // The parent whose threads are allowed to sit open in the rail. A selected thread keeps its
  // parent expanded; every other parent collapses.
  function currentParentWire(): string {
    if (ui.activeThread?.parent) return ui.activeThread.parent;
    const item = activeConversation();
    return item && item.kind !== "thread" ? item.wireTarget : "";
  }

  function expandedParent(): string {
    return ui.threadParentOpen || expandedThreadParent(ui.activeThread?.parent, currentParentWire());
  }

  // Two rows, then a "more" row that opens the full thread list in a dialog like the legacy client.
  function threadNest(parent: string): NestedThreads {
    return nestedThreads(ui.threads, parent);
  }

  // A folded channel stays folded while it is the open conversation; opening one of its threads
  // shows the list again. Phone rows have no fold control, so they ignore it.
  function isExpanded(parent: string): boolean {
    const open = expandedParent();
    if (!open || foldIdentifier(parent) !== foldIdentifier(open)) return false;
    return !(ui.isDesktop && !ui.activeThread && ui.collapsedThreadParents.includes(foldIdentifier(parent)));
  }

  // Desktop rail: clicking the open channel again folds or unfolds its threads; any other opens.
  function pickChannel(room: string): void {
    const item = activeConversation();
    if (item?.kind === "room" && foldIdentifier(item.wireTarget) === foldIdentifier(room) && threadNest(room).shown.length) {
      ui.collapsedThreadParents = toggleCollapsedParent(ui.collapsedThreadParents, room);
      return;
    }
    openRoom(room);
  }

  // `/help`: the help list in the same search palette as the thread picker.
  function openHelpDialog(): void {
    openPopup()();
    window.dispatchEvent(new CustomEvent("slirc:help-open"));
  }

  function toggleRooms(): void {
    if (ui.isDesktop) {
      ui.roomsOpen = !ui.roomsOpen;
      applyChrome();
    } else {
      openHome();
    }
  }

  return { cancelPhoneAnimation, applyNav, ownDm, openNotes, notesRows, showNotes, linkThread, selectConversation, channelDeleted, leaveRemovedAgent, openRoom, openHome, goBack, canGoBack, canGoForward, goForward, openDms, openMore, openProfile, openSettings, openChannels, openInvitations, openIrc, openAgents, openAdmin, toggleThreads, openThreadParent, activeConversation, currentParentWire, threadNest, isExpanded, pickChannel, openHelpDialog, toggleRooms };
}
