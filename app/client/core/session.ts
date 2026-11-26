import { phoneShortcutDismissed } from "@client/phone-offer.ts";
import { signedOut } from "@client/native-shell.ts";
import { conversationId, foldIdentifier, scopeKey, type Message } from "@client/model.ts";
import { ClientDatabase } from "@client/db.ts";
import { createSyncEngine, type AuthorizedConversation } from "@client/sync.ts";
import { createConversationProjection, createUnreadProjection } from "@client/store.ts";
import { NOTES_CONVERSATION_ID, parseRoute, sharedDmScreen, type createNavigation, type Screen } from "@client/navigation.ts";
import { rememberAvatarVersions, starredIdsFromStorage } from "@client/presentation.ts";
import { SIGN_IN_REASON, clientAccess, contactsWithoutDirects, requiresLogoutConfirmation, type AccessGrant } from "@client/access.ts";
import { Composer } from "@client/drafts.ts";
import { isDailyGreeting } from "../../shared/service-bots.ts";
import { normalizeIrcConnection, type createIrcPage } from "@client/irc-page.ts";
import { LINK_MISSING } from "@client/core/routing.ts";
import { mergeAgents } from "@client/agent-roster.ts";
import { cachedEmbeds } from "@client/embed-cache.ts";
import type { createTranscript } from "@client/transcript.ts";
import type { createDevicePairing } from "@client/device-pairing.ts";
import type { createProfilePage } from "@client/profile-page.ts";
import type { createConnectionNotice } from "@client/connection-notice.ts";
import type { createPeekView } from "@client/peek.ts";
import type { createLinksView } from "@client/links-view.ts";
import type { createTypingIndicators } from "@client/typing.ts";
import type { createPresence } from "@client/presence.ts";
import type { createReplyThreadList } from "@client/reply-thread-list.ts";
import type { createSettingsPage } from "@client/settings-page.ts";
import type { createAgentsPage } from "@client/agents-page.ts";
import type { createAdminPage } from "@client/admin-page.ts";
import type { createInvitationsPage } from "@client/invitations-page.ts";
import type { createAdmissionFounder } from "@client/admission.ts";
import type { createNotes } from "@client/notes.ts";
import type { createMediaView } from "@client/media-view.ts";
import type { createGiphyPicker } from "@client/giphy-picker.ts";
import type { createGreetingNote } from "@client/greeting-note.ts";
import type { createSignIn } from "@client/sign-in.ts";
import type { createMediaSender, StagedMedia } from "@client/media-send.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.json().catch(() => ({}));
}

export interface SessionDeps {
  state: Pick<RuntimeState, "authenticatedAccountId" | "authorized" | "composer" | "composerTextByConversation" | "connectEpoch" | "connecting" | "currentScope" | "db" | "directories" | "outbox" | "pendingDms" | "pendingInitialRoute" | "projection" | "renderEpoch" | "roomId" | "scope" | "serverMarkers" | "signingOut" | "socket" | "stopped" | "suspended" | "sync" | "unreadProjection">;
  ui: Pick<ClientState, "account" | "accountIds" | "admissionRoute" | "agentProfiles" | "authenticated" | "avatarVersions" | "channelDetails" | "channelOrder" | "channels" | "composer" | "contacts" | "currentConversationId" | "defaultChannel" | "direct" | "directs" | "draftNote" | "drafts" | "editAttachments" | "editConversationId" | "editSavedRevision" | "editSavedText" | "editServerId" | "editingMessageId" | "embeds" | "error" | "greeting" | "greetingNoteSeen" | "hasPhone" | "helpers" | "ircConnection" | "ircReset" | "isAdmin" | "isFounder" | "joinRoute" | "linksChannels" | "linksHome" | "me" | "media" | "mediaBusy" | "mediaError" | "mentionOpen" | "messages" | "mutedRooms" | "note" | "notesOpen" | "openRooms" | "phase" | "phoneShortcutDismissed" | "reactions" | "redactions" | "signupOpen" | "slashOpen" | "starred" | "threads" | "unread">;
  instance: string;
  nav: ReturnType<typeof createNavigation>;
  dmPeerIds: Map<string, string>;
  provisioning: Map<string, Promise<void>>;
  closeSocket: () => void;
  cancelMarkRead: () => void;
  clearDraftFocus: (except?: string | null) => void;
  resetAccountUi: () => void;
  setBooting: (on: boolean) => void;
  applyChrome: () => void;
  preopenSocket: () => void;
  dropEarlySocket: () => void;
  releaseBoot: () => void;
  scheduleReconnect: () => void;
  signedInHint: (on?: boolean) => boolean;
  resetForAccountChange: () => void;
  refreshWorkspaceChoices: () => void;
  showIrcResetNotes: () => void;
  clearRoomMembers: () => void;
  ensurePendingDirect: (nick: string) => string | null;
  peerAccountIdFor: (nick: string) => string | undefined;
  ownDm: (screen: Screen) => boolean;
  dmPeerNick: (channel: string) => string | undefined;
  pendingIdForNick: (nick: string) => string | null;
  hint: (text: string) => void;
  selectConversation: (id: string | null, focusMessageId?: string, focusThread?: boolean) => void;
  linkThread: (screen: Screen) => boolean;
  loadRoomMembers: (item: AuthorizedConversation | undefined, id: string | null) => void;
  activeConversation: () => AuthorizedConversation | undefined;
  openSocket: (user: string) => void;
  whenPainted: (ms?: number) => Promise<void>;
  revealShell: () => void;
  provisionDirect: (nick: string, id: string) => Promise<void>;
  revokeMedia: (media: StagedMedia | null) => void;
  resetPainted: () => void;
  restorePendingDirects: (targetDb: ClientDatabase) => Promise<void>;
  refreshDrafts: (expectedDb?: ClientDatabase | null) => Promise<void>;
  wireSend: (line: string) => boolean;
  hooks: () => Parameters<typeof createSyncEngine>[0]["hooks"];
  notesRows: () => Message[];
  paintNow: () => void;
  applyUnreadChrome: () => void;
  scheduleMarkRead: () => void;
  draftWriter: (targetDb: ClientDatabase) => ConstructorParameters<typeof Composer>[1];
  restoreMediaDraft: (id: string) => Promise<void>;
  startSender: () => void;
  resetReconnectBackoff: () => void;
  controllers: () => { transcript: ReturnType<typeof createTranscript>; pairing: ReturnType<typeof createDevicePairing>; profile: ReturnType<typeof createProfilePage>; connectionNotice: ReturnType<typeof createConnectionNotice>; peek: ReturnType<typeof createPeekView>; library: ReturnType<typeof createLinksView>; typing: ReturnType<typeof createTypingIndicators>; irc: ReturnType<typeof createIrcPage>; presence: ReturnType<typeof createPresence>; replyThreads: ReturnType<typeof createReplyThreadList>; settings: ReturnType<typeof createSettingsPage>; agents: ReturnType<typeof createAgentsPage>; adminStatus: ReturnType<typeof createAdminPage>; invitationsPage: ReturnType<typeof createInvitationsPage>; admissionFounder: ReturnType<typeof createAdmissionFounder>; notes: ReturnType<typeof createNotes>; mediaView: ReturnType<typeof createMediaView>; giphy: ReturnType<typeof createGiphyPicker>; greetingNote: ReturnType<typeof createGreetingNote>; signIn: ReturnType<typeof createSignIn>; mediaSender: ReturnType<typeof createMediaSender> };
}

export function createSession(deps: SessionDeps) {
  const { state: rs, ui, instance, nav, dmPeerIds, provisioning, closeSocket, cancelMarkRead, clearDraftFocus, resetAccountUi, setBooting, applyChrome, preopenSocket, dropEarlySocket, releaseBoot, scheduleReconnect, signedInHint, resetForAccountChange, refreshWorkspaceChoices, showIrcResetNotes, clearRoomMembers, ensurePendingDirect, peerAccountIdFor, ownDm, dmPeerNick, pendingIdForNick, hint, selectConversation, linkThread, loadRoomMembers, activeConversation, openSocket, whenPainted, revealShell, provisionDirect, revokeMedia, resetPainted, restorePendingDirects, refreshDrafts, wireSend, hooks, notesRows, paintNow, applyUnreadChrome, scheduleMarkRead, draftWriter, restoreMediaDraft, startSender, resetReconnectBackoff, controllers } = deps;

  async function logout(): Promise<void> {
    if (rs.signingOut) return;
    rs.signingOut = true;
    let pending = 0;
    let drafts = 0;
    try {
      if (rs.db) [pending, drafts] = await Promise.all([
        rs.db.operations.filter((operation) => operation.state !== "confirmed").count(),
        rs.db.drafts.filter((draft) => !!draft.text.trim()).count(),
      ]);
    } catch {
      ui.error = "Could not check local drafts and messages. They are still here; try again.";
      rs.signingOut = false;
      if (!rs.socket || rs.socket.readyState === WebSocket.CLOSED) void connect();
      return;
    }
    if (requiresLogoutConfirmation(drafts, pending, String(ui.composer || ""), rs.composerTextByConversation.values()) && !window.confirm("Sign out and remove drafts from every room and unconfirmed messages? Messages may not have reached the server.")) {
      rs.signingOut = false;
      if (!rs.socket || rs.socket.readyState === WebSocket.CLOSED) void connect();
      return;
    }
    try {
      const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(`Sign-out failed (${response.status})`);
    } catch {
      ui.error = "Could not sign out. Your messages and draft are still here. Try again when connected.";
      rs.signingOut = false;
      if (!rs.socket || rs.socket.readyState === WebSocket.CLOSED) void connect();
      return;
    }
    controllers().transcript.cancelConversationTransition();
    rs.stopped = true;
    rs.renderEpoch += 1;
    controllers().pairing.clearPairRequest();
    try { await rs.outbox?.onDisconnected(); } catch { /* teardown still closes the sender */ }
    closeSocket();
    controllers().pairing.stop();
    rs.outbox?.stop();
    rs.projection?.dispose();
    rs.unreadProjection?.dispose(); rs.unreadProjection = null; cancelMarkRead();
    const dead = rs.db;
    rs.db = null;
    rs.sync = null;
    rs.outbox = null;
    rs.projection = null;
    rs.composer = null;
    rs.scope = null;
    rs.roomId = null;
    clearDraftFocus();
    rs.currentScope = "";
    rs.authenticatedAccountId = "";
    rs.composerTextByConversation.clear(); controllers().transcript.reset();
    resetAccountUi();
    setBooting(false);
    ui.phase = "signin";
    ui.note = "";
    if (dead) {
      dead.close();
      try { await dead.delete(); }
      catch { ui.note = "Signed out, but local cache could not be cleared."; }
    }
    // closeSocket invalidated the old connect epoch; the signed-out page can pair again.
    rs.stopped = false;
    rs.signingOut = false;
    applyChrome();
    signedOut(window as never);
  }

  // Command definitions and dispatch stay here; the slash component only reports which name was
  // chosen and owns its own highlight/dismissal.
  // @remind reads times on the asker's clock: tell the server this browser's zone once per account
  // and zone. Best effort; a failure only means reminders use the instance default.
  function reportTimeZone(accountId: string): void {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!accountId || !zone) return;
    const key = `slirc-time-zone:${accountId}`;
    try { if (localStorage.getItem(key) === zone) return; } catch { /* storage blocked: just send */ }
    void fetch("/api/time-zone", {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Slirc-Time-Zone": "1" },
      body: JSON.stringify({ timeZone: zone }),
    }).then((response) => { if (response.ok) try { localStorage.setItem(key, zone); } catch { /* ignore */ } }).catch(() => {});
  }

  function connect(): Promise<void> {
    return rs.connecting = connectNow();
  }

  async function connectNow(): Promise<void> {
    if (rs.stopped || rs.suspended || rs.signingOut) return;
    const epoch = ++rs.connectEpoch;
    const profileReadRevision = controllers().profile.revision();
    ui.phase = "connecting";
    preopenSocket();
    let me: unknown;
    try {
      // Revalidate the session every reconnect, before the recovery list is published.
      me = await fetchJson("/auth/me");
    } catch {
      if (epoch !== rs.connectEpoch || rs.stopped || rs.suspended || rs.signingOut) return;
      dropEarlySocket();
      controllers().connectionNotice.failed();
      releaseBoot(); // never a blank boot screen; the error itself waits out the grace period
      scheduleReconnect();
      return;
    }
    if (epoch !== rs.connectEpoch || rs.stopped || rs.suspended || rs.signingOut) return;
    rs.authenticatedAccountId = typeof (me as { accountId?: unknown })?.accountId === "string" ? (me as { accountId: string }).accountId : "";
    reportTimeZone(rs.authenticatedAccountId);
    document.dispatchEvent(new CustomEvent("slirc:theme-account", {
      detail: { accountId: rs.authenticatedAccountId, theme: (me as { theme?: unknown })?.theme },
    }));
    const access = clientAccess(me, instance);
    signedInHint(access.ok);
    if (!access.ok) {
      controllers().transcript.cancelConversationTransition();
      rs.renderEpoch += 1;
      controllers().transcript.reset();
      controllers().pairing.clearPairRequest();
      controllers().pairing.stop();
      closeSocket();
      void rs.outbox?.onDisconnected();
      rs.outbox?.stop();
      rs.projection?.dispose();
      rs.unreadProjection?.dispose(); rs.unreadProjection = null; cancelMarkRead();
      rs.db?.close();
      rs.db = null; rs.sync = null; rs.outbox = null; rs.projection = null; rs.composer = null; rs.scope = null; rs.roomId = null; rs.currentScope = "";
      rs.authorized = []; rs.directories.clear(); dmPeerIds.clear();
      rs.composerTextByConversation.clear(); controllers().transcript.reset();
      resetAccountUi();
      if (!(me as { authenticated?: unknown })?.authenticated) {
        ui.authenticated = false;
        ui.account = "";
        ui.me = "";
        ui.phase = "signin";
        ui.signupOpen = (me as { signup?: unknown })?.signup === true;
        // An invitation or admission link is opened signed out on purpose: its own screen says
        // what to do, so "Sign in to open the client." would be a wrong instruction there.
        ui.note = ui.joinRoute || ui.admissionRoute ? "" : access.reason;
        const openRoom = typeof (me as { openRoom?: unknown })?.openRoom === "string" ? (me as { openRoom: string }).openRoom : undefined;
        controllers().peek.signedOut(ui.signupOpen, openRoom);
      } else {
        ui.authenticated = true;
        ui.phase = "denied";
        ui.error = access.reason;
      }
      releaseBoot();
      return;
    }
    // Signed in now: a sign-in prompt left from before joining or signing in is stale.
    if (ui.note === SIGN_IN_REASON) ui.note = "";
    controllers().peek.stop();
    const key = scopeKey(access.scope);
    const changedAccount = key !== rs.currentScope;
    if (changedAccount) resetForAccountChange();
    ui.authenticated = true;
    refreshWorkspaceChoices();
    controllers().pairing.clearPairRequest();
    ui.account = access.scope.account;
    ui.isAdmin = access.role === "admin";
    ui.isFounder = (me as any).isFounder === true;
    ui.hasPhone = (me as any).hasPhone === true;
    ui.phoneShortcutDismissed = phoneShortcutDismissed(rs.authenticatedAccountId);
    ui.greeting = (me as any).greeting !== false;
    ui.helpers = Array.isArray((me as any).helpers) ? (me as any).helpers.filter((nick: unknown): nick is string => typeof nick === "string") : [];
    ui.linksHome = typeof (me as any).linksHome === "string" ? (me as any).linksHome.toLowerCase() : "";
    ui.linksChannels = Array.isArray((me as any).linksChannels) ? (me as any).linksChannels.filter((name: unknown): name is string => typeof name === "string").map((name: string) => name.toLowerCase()) : [];
    controllers().library.sync();
    ui.greetingNoteSeen = (me as any).greetingNoteSeen !== false;
    ui.ircReset = { clients: (me as any).ircReset?.clients === true, bots: (me as any).ircReset?.bots === true };
    showIrcResetNotes();
    ui.me = controllers().profile.profileSaved.fullName || access.scope.account;
    // A read begun before/during a save cannot overwrite its newer successful result.
    if (changedAccount || (profileReadRevision === controllers().profile.revision() && !controllers().profile.profileSaving && !controllers().profile.badgeSaving)) controllers().profile.applyProfile((me as any).profile);
    // Thread rooms are trusted /auth/me rows, added as authorized conversations so reply reuses the
    // existing sender path. They stay out of the Channels list.
    rs.authorized = [
      ...access.conversations,
      ...access.threads.map((thread) => ({ conversationId: thread.conversationId, wireTarget: thread.channel, kind: "thread" as const })),
    ];
    rs.directories.clear(); dmPeerIds.clear();
    // A refreshed grant is authoritative: drop any typing state for a conversation it may have revoked.
    controllers().typing.clearAll();
    clearRoomMembers();
    for (const item of rs.authorized) rs.directories.set(item.conversationId, item);
    const accountDetails = Array.isArray((me as any).accountDetails) ? (me as any).accountDetails : [];
    ui.accountIds = Object.fromEntries(accountDetails
      .filter((entry: any) => typeof entry?.nick === "string" && typeof entry?.id === "string")
      .map((entry: any) => [foldIdentifier(entry.nick), entry.id]));
    rememberAvatarVersions(ui.avatarVersions, accountDetails);
    for (const direct of (me as any).directs || []) {
      const peer = accountDetails.find((entry: any) => foldIdentifier(entry.nick) === foldIdentifier(direct.nick));
      if (peer?.id) dmPeerIds.set(foldIdentifier(direct.nick), peer.id);
    }
    // A reload or deep link on a DM route for a not-yet-authorized contact recreates the optimistic
    // conversation from the same immutable peer id, so its draft and queued text come back and
    // provisioning resumes; an already-authorized DM returns null here and uses the real grant.
    const bootScreen = nav.$state.get().screen;
    if (bootScreen.kind === "dm") ensurePendingDirect(bootScreen.nick);
    nav.setDirectory({
      roomConversationId: (room) => rs.authorized.find((item) => item.kind !== "dm" && foldIdentifier(item.wireTarget) === foldIdentifier(room))?.conversationId,
      dmPeerAccountId: (nick) => peerAccountIdFor(nick),
    });
    nav.refreshConversationId();
    ui.threads = access.threads;
    ui.channelDetails = Array.isArray((me as any).channelDetails) ? (me as any).channelDetails : [];
    // Boot-time visibility from the authoritative configured list, before any room is selected.
    const openChannelList = (Array.isArray((me as any).openChannels) ? (me as any).openChannels : [])
      .filter((channel: unknown): channel is string => typeof channel === "string" && channel.startsWith("#"));
    ui.openRooms = Object.fromEntries(openChannelList.map((channel: string) => [channel, true]));
    if (rs.pendingInitialRoute && openChannelList.length) {
      const reparsed = parseRoute(rs.pendingInitialRoute, instance, openChannelList);
      rs.pendingInitialRoute = "";
      if (reparsed && nav.$state.get().screen.kind === "tab" && nav.$state.get().screen.tab === "home") {
        nav.open(reparsed, { replace: true });
      }
    }
    ui.defaultChannel = typeof (me as any).defaultChannel === "string" ? (me as any).defaultChannel.toLowerCase() : "";
    ui.ircConnection = normalizeIrcConnection((me as any).irc);
    ui.channels = rs.authorized.filter((item) => item.kind === "room" && !item.wireTarget.startsWith("#t-"));
    ui.directs = ((me as any).directs || []).filter((direct: any) => rs.authorized.some((item) => item.kind === "dm" && item.wireTarget === direct.channel));
    ui.contacts = Array.isArray((me as any).contacts)
      ? contactsWithoutDirects((me as any).contacts.filter((nick: unknown): nick is string => typeof nick === "string" && foldIdentifier(nick) !== foldIdentifier(access.scope.account)), ui.directs)
      : [];
    controllers().presence.setAvailability(Array.isArray((me as any).accountDetails) ? (me as any).accountDetails : []);
    ui.agentProfiles = mergeAgents(ui.agentProfiles, Array.isArray((me as any).accountDetails) ? (me as any).accountDetails : []);
    controllers().pairing.authorize(key);
    if (key !== rs.currentScope) await openScope(access);
    if (epoch !== rs.connectEpoch || rs.stopped || rs.suspended || rs.signingOut) return;
    controllers().pairing.loadPending(key);
    void controllers().replyThreads.load();
    if (["settings", "profile"].includes(nav.$state.get().screen.kind)) controllers().settings.open();
    if (nav.$state.get().screen.kind === "irc") controllers().irc.open();
    if (nav.$state.get().screen.kind === "agents") controllers().agents.open();
    if (nav.$state.get().screen.kind === "admin") controllers().adminStatus.open();
    if (nav.$state.get().screen.kind === "invitations") controllers().invitationsPage.open();
    if (nav.$state.get().screen.kind === "invitations" && ui.isFounder) controllers().admissionFounder.open();
    rs.sync?.recover(rs.authorized);
    void controllers().notes.load();
    if (ownDm(nav.$state.get().screen)) nav.open({ kind: "notes" }, { replace: true });
    const shared = sharedDmScreen(nav.$state.get().screen, dmPeerNick);
    if (shared) nav.open(shared, { replace: true });
    const screen = nav.$state.get().screen;
    const pendingId = screen.kind === "dm" ? pendingIdForNick(screen.nick) : null;
    const direct = screen.kind === "dm" ? ui.directs.find((item: any) => foldIdentifier(item.nick) === foldIdentifier(screen.nick)) : null;
    const selected = screen.kind === "room"
      ? rs.authorized.find((item) => item.kind !== "dm" && foldIdentifier(item.wireTarget) === foldIdentifier(screen.room))
      : direct ? rs.authorized.find((item) => item.kind === "dm" && item.wireTarget === direct.channel) : undefined;
    const focusMessageId = screen.kind === "room" || screen.kind === "dm" ? screen.focusMessageId : undefined;
    if (focusMessageId && !selected && !pendingId) hint(LINK_MISSING);
    selectConversation(screen.kind === "notes" ? NOTES_CONVERSATION_ID : selected?.conversationId ?? pendingId ?? access.conversation.conversationId, selected || pendingId ? focusMessageId : undefined, linkThread(screen));
    // selectConversation can early-return for the already-selected conversation, so make sure the
    // first authorized members fetch runs after the account scope exists.
    loadRoomMembers(activeConversation(), rs.roomId);
    openSocket(access.scope.account);
    // Reveal as soon as the cached room can paint; IRC recovery continues behind the shell.
    void whenPainted().then(revealShell);
    // A pending conversation resumed by a reload resumes its server-side creation. A provisioning
    // pass already in flight from this tab owns the id, so this cannot start a second POST.
    if (pendingId) {
      const entry = rs.pendingDms.get(pendingId);
      if (entry?.state === "provisioning" && !provisioning.has(pendingId)) void provisionDirect(entry.nick, pendingId);
    }
  }

  // One sync engine per opened scope, so a revalidated account change cannot keep another scope's
  // database. Account-switch UI is deferred, but the scope guard is not.
  async function openScope(access: AccessGrant): Promise<void> {
    controllers().transcript.cancelConversationTransition();
    rs.projection?.dispose();
    rs.unreadProjection?.dispose(); rs.unreadProjection = null; cancelMarkRead();
    rs.renderEpoch += 1;
    controllers().transcript.reset();
    rs.composerTextByConversation.clear(); controllers().transcript.reset();
    ui.messages = []; ui.composer = ""; ui.direct = false; ui.drafts = [];
    // Account scope changed: staged photo bytes belong to the old scope's database.
    if (controllers().mediaView.lightbox) controllers().mediaView.closeLightbox();
    revokeMedia(ui.media); ui.media = null; ui.mediaError = "";
    ui.mediaBusy = false; controllers().mediaSender.cancelCompress();
    controllers().giphy.resetSearch(); ui.slashOpen = false;
    ui.mentionOpen = false;
    window.dispatchEvent(new CustomEvent("slirc:slash-reset"));
    window.dispatchEvent(new CustomEvent("slirc:mention-reset"));
    ui.editingMessageId = ""; ui.editAttachments = []; ui.editServerId = ""; ui.editConversationId = ""; ui.editSavedText = ""; ui.editSavedRevision = null;
    rs.outbox?.stop();
    rs.db?.close();
    resetPainted();
    rs.scope = access.scope;
    rs.roomId = access.conversation.conversationId;
    clearDraftFocus();
    ui.currentConversationId = rs.roomId;
    rs.currentScope = scopeKey(access.scope);
    const accountDb = new ClientDatabase(access.scope);
    rs.db = accountDb;
    void restorePendingDirects(accountDb);
    controllers().mediaView.collapsedMedia = controllers().mediaView.loadCollapsedMedia(access.scope.accountId);
    // Cards seen before paint with the rows instead of landing one by one after them.
    ui.embeds = cachedEmbeds(access.scope.accountId);
    try {
      ui.starred = starredIdsFromStorage(localStorage.getItem(`slirc2-starred:${access.scope.accountId}`));
      ui.channelOrder = starredIdsFromStorage(localStorage.getItem(`slirc2-channel-order:${access.scope.accountId}`));
      const muted = localStorage.getItem(`slirc2-muted:${access.scope.accountId}`);
      ui.mutedRooms = muted === null ? ["#open-chat", "#help"] : starredIdsFromStorage(muted);
    } catch { ui.starred = []; ui.channelOrder = []; ui.mutedRooms = ["#open-chat", "#help"]; }
    void refreshDrafts(accountDb);
    rs.sync = createSyncEngine({ db: accountDb, send: wireSend, nick: access.scope.account, hooks: hooks() });
    rs.projection = createConversationProjection(accountDb);
    rs.projection.view.subscribe((view) => {
      if (rs.db !== accountDb || rs.stopped || view.conversationId !== rs.roomId) return;
      controllers().transcript.beforePaint(view);
      ui.messages = ui.notesOpen ? notesRows() : view.messages.filter((message) => message.authorNick !== "HistServ");
      controllers().greetingNote.consider(ui.messages);
      ui.reactions = view.reactions;
      ui.redactions = view.redactions;
      void controllers().transcript.loadEmbeds(controllers().transcript.displayedMessages());
      void controllers().mediaView.loadUploadDims(controllers().transcript.displayedMessages());
      if (view.error) ui.error = view.error;
      if (!view.loading) {
        paintNow();
        controllers().transcript.afterPaint(view, () => rs.db === accountDb && !rs.stopped && view.conversationId === rs.roomId);
      }
    });
    rs.projection.select(rs.roomId);
    rs.serverMarkers.clear();
    rs.unreadProjection = createUnreadProjection(accountDb, (message) => ui.greeting || !isDailyGreeting(message.authorAccount, message.text));
    rs.unreadProjection.counts.subscribe((counts) => {
      if (rs.db !== accountDb || rs.stopped) return;
      ui.unread = counts;
      applyUnreadChrome();
      scheduleMarkRead();
    });
    rs.composer = new Composer(rs.roomId, draftWriter(accountDb));
    const scopeComposer = rs.composer;
    rs.composer.onNote = (note) => {
      if (rs.stopped || rs.db !== accountDb || rs.composer !== scopeComposer) return;
      if (note === "") {
        if (!ui.draftNote || ui.draftNote === "Draft not saved") ui.draftNote = "";
      } else {
        ui.draftNote = note;
      }
    };
    const draft = await accountDb.drafts.get(rs.roomId);
    if (rs.db !== accountDb || rs.stopped || rs.suspended || rs.signingOut) return;
    // Navigation may have replaced the composer while the draft was loading.
    scopeComposer.load(draft);
    if (rs.composer === scopeComposer && draft) ui.composer = scopeComposer.text;
    // Restore the staged photo for this conversation; a reload or account scope change must not
    // lose pending bytes.
    if (rs.roomId === access.conversation.conversationId) void restoreMediaDraft(access.conversation.conversationId);
    startSender();
  }

  // A frozen page must not retain the sender lock. Takeover recovers any interrupted write.
  function onPageHide(event: PageTransitionEvent): void {
    controllers().transcript.cancelConversationTransition();
    controllers().pairing.clearPairRequest();
    controllers().pairing.stop();
    closeSocket();
    void rs.outbox?.onDisconnected().catch(() => {});
    rs.outbox?.stop();
    controllers().connectionNotice.reset();
    if (event.persisted) {
      rs.suspended = true;
      return;
    }
    rs.stopped = true;
    rs.projection?.dispose();
    rs.unreadProjection?.dispose(); rs.unreadProjection = null; cancelMarkRead();
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) controllers().signIn.restored();
    if (!event.persisted || !rs.suspended) return;
    rs.suspended = false;
    resetReconnectBackoff();
    startSender();
    void connect();
  }

  return { logout, connect, onPageHide, onPageShow };
}
