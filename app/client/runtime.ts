// Account/session, authorization, navigation and durable message operations.
// Feature controllers below own transient UI state and DOM lifecycle.
import { createEmojiPicker } from "@client/emoji-picker.ts";
import { emojiText, emojiTextSegments } from "@client/emoji.ts";
import { createTranscript } from "@client/transcript.ts";
import { createPeekView } from "@client/peek.ts";
import { createGiphyPicker } from "@client/giphy-picker.ts";
import { createDevicePairing } from "@client/device-pairing.ts";
import { createSignIn } from "@client/sign-in.ts";
import { createPhoneOffer, dismissPhoneShortcut, phoneShortcutDismissed } from "@client/phone-offer.ts";
import { dismissInstallBanner, installBannerVisible, installEnv } from "@client/install-banner.ts";
import { createIphoneApp } from "@client/iphone-app.ts";
import { animateListHeight, filterWorkspaces, installWorkspaceKeys, savedWorkspaceCount, workspaceMark, workspaceRows, type WorkspaceFilter } from "@client/workspace-mark.ts";
import { savedWorkspaces, takeCarriedWorkspaces, workspaceLink } from "@client/workspace-list.ts";
import { createWorkspaceIcon } from "@client/workspace-icon.ts";
import { aboutLabel, canSwitchWorkspace, exposeWorkspaceDialog, inMacApp, openWorkspace, openWorkspaceLink, shellListsWorkspaces, shellVersion, shellWorkspaces, signedOut, switchWorkspace as switchShellWorkspace } from "@client/native-shell.ts";
import { createQrScanner } from "@client/qr-scanner.ts";
import { conversationId, foldIdentifier, scopeKey, type AccountScope, type Draft, type Message, type Operation } from "@client/model.ts";
import { inviteToken, mentionToken } from "@client/mentions.ts";
import { ClientDatabase } from "@client/db.ts";
import { type IrcMessage } from "@client/irc.ts";
import { buildMarkReadCommand, createSyncEngine, type AuthorizedConversation, type SyncEngine } from "@client/sync.ts";
import { SendRefusedError, createOutbox, type Outbox, type OutboxTransport } from "@client/outbox.ts";
import { badgeText, sidebarUnreadTotal, createConversationProjection, createUnreadProjection, firstReadMarker, newestServerTime, shouldMarkRead, type ConversationProjection, type UnreadProjection } from "@client/store.ts";
import { createNavigation, messageLinkLabel, NOTES_CONVERSATION_ID, parseRoute, sharedDmScreen, type HistoryAdapter, type Screen } from "@client/navigation.ts";
import { createNotes } from "@client/notes.ts";
import { createReplyThreadList, type ReplyThreadItem } from "@client/reply-thread-list.ts";
import { actionBody, channelLinks, closeUnclosedCodeFence, displaySegments, embedImageUrl, isActionText, youtubeId } from "@client/render.ts";

import { collapsesOlderGiphy, isOlderGiphy, messageBodyText, removeInlineMedia, splitInlineMedia, type InlineMedia } from "@client/media.ts";
import { kickNotice, parseKick, parseSlash, slashCommand, slashSelection, type SlashCommand, unknownCommandMessage } from "@client/commands.ts";
import { helpInsert, type HelpTopic } from "@client/help.ts";
import { createMediaSender, draftPhotos, pastedImages, type StagedMedia } from "@client/media-send.ts";
import { canCompressVideo, compressVideo, loadVideoEncoder } from "@client/video-compress.ts";
import { DEFAULT_REACTIONS, animatePhoneScreen, avatarUrl, canAdminEditBotMessage, canDeleteMessage, canEditMessage, draftNavigationItems, excludeStarred, fenceHtml, formatTime, historyAvailability, isGiphyUrl, lucideIcon, mountUrl, phoneScreenDirection, reactionChips, reactionTooltip, rememberAvatarVersions, routeFromMount, starredIdsFromStorage, visibleDraftNavigationItems } from "@client/presentation.ts";
import { commandPaletteStyle, createPopupOpener, giphyPanelStyle, placeMenuUnder, placePlusMenu } from "@client/popups.ts";
import { hideActiveTooltip } from "@client/tooltips.ts";
import { SIGN_IN_REASON, cachedDirectIsAuthorized, clientAccess, contactsWithoutDirects, defaultConversationIdFor, recoveryTargets, requiresLogoutConfirmation, type AccessGrant, type ThreadGrant, wireTargetForOperation } from "@client/access.ts";
import { DEV_CHANNEL, RelayBridge, bytesToBase64, randomId, reactionTagMessage, saslToken, serializeOperation, validateMultiline, validateText } from "@client/protocol.ts";
import { formatPairCode, normalizePairCode, pairRequestSummary, validSignInEmail } from "@client/pairing.ts";
import { adminDeletesOverIrc, enqueueThreadContext, expandedThreadParent, nestedThreads, pendingThreadFallbackText, threadAnnouncementDisplayText, threadForRoot, threadOperationId, threadGrantFromResponse, threadRootTextDiffers, threadSourceUrl, threadTitleFromText, threadsUnderParent, toggleCollapsedParent, type NestedThreads } from "@client/threads.ts";
import { broadcastParent, buildReplyIndex, replyThreadReplies, replyThreadRoot, replyThreadSummary, type ReplyThreadSummary } from "@client/reply-threads.ts";
import { Composer, queuedTextFor } from "@client/drafts.ts";
import { createProfilePage } from "@client/profile-page.ts";
import { createFounderWelcome, drainFounderWelcome, type WelcomeFeed, type WelcomeJob, type WelcomeOperation, type WelcomeOutcome } from "@client/founder-welcome.ts";
import { createSettingsPage } from "@client/settings-page.ts";
import { HELPER_NICKS, UPDATES_NICK, isDailyGreeting } from "../shared/service-bots.ts";
import { createGreetingNote } from "@client/greeting-note.ts";
import { createChannelsPage } from "@client/channels-page.ts";
import { createChannelDrag, orderChannels } from "@client/channel-order.ts";
import { createNewConversation } from "@client/new-conversation.ts";
import { createPolls, pollPrefill } from "@client/polls.ts";
import { createJobCards, isBotRow } from "@client/job-cards.ts";
import { createAddPrompts, mentionedHelpers, mentionedPeople } from "@client/add-prompts.ts";
import { createInvitationsPage } from "@client/invitations-page.ts";
import { createBulkInvite } from "@client/bulk-invite.ts";
import { createInvitationAccept } from "@client/invitation-accept.ts";
import { createAdmissionFounder, createAdmissionScreen } from "@client/admission.ts";
import { createIrcPage, normalizeIrcConnection } from "@client/irc-page.ts";
import { createAgentsPage, stashConnectToken } from "@client/agents-page.ts";
import { agentOfflineCard, agentOfflineFolded, createAgentBackToast, type AgentOfflineCard } from "@client/agent-offline.ts";
import { createAdminPage } from "@client/admin-page.ts";
import { isApplePlatform, isJumpShortcut, isWorkspacesShortcut, jumpRows, type JumpRow } from "@client/jump.ts";
import { embedMetaFromResponse, type EmbedMeta } from "@client/embed.ts";
import { isChannelSearchShortcut, searchConversation, searchNotes, type SearchKind } from "@client/search.ts";
import { recallStep, sentTexts, type Recall } from "@client/composer-history.ts";
import { createTypingIndicators, typingAccount, typingLine } from "@client/typing.ts";
import { createConversationMenu } from "@client/conversation-menu.ts";
import { createChannelSettings } from "@client/channel-settings.ts";
import { createDirectDelete } from "@client/direct-delete.ts";
import { createPeopleCard } from "@client/people-card.ts";
import { createPresence } from "@client/presence.ts";
import { createMediaView } from "@client/media-view.ts";
import { createMembersPanel, memberResponseApplies, membersPanelVisible } from "@client/members-panel.ts";
import { createLinksView } from "@client/links-view.ts";
import { addressIn } from "@client/links-query.ts";
import { createMessageActions } from "@client/message-actions.ts";
import { createMessageView } from "@client/message-view.ts";
import { createComposerEditor } from "@client/composer-editor.ts";
import { createLinkActions } from "@client/link-actions.ts";
import { createClientState, type ClientSession } from "@client/client-state.ts";
import { createView } from "@client/view.ts";
import { createRuntimeState } from "@client/core/runtime-state.ts";
import { createSearch } from "@client/features/search.ts";
import { createMediaUpload } from "@client/features/media-upload.ts";
import { createDrafts } from "@client/features/drafts.ts";
import { createSidebarLists } from "@client/features/sidebar-lists.ts";
import { createDirectMessages } from "@client/features/direct-messages.ts";
import { createUnread } from "@client/features/unread.ts";
import { agentFor, agentHeader, agentLabel, agentMention, agentNavRows, applyAgentUpdate, forgetAgent, isAgentNick, mergeAgents } from "@client/agent-roster.ts";
import { createReminderNotice, remindResult } from "@client/reminder-notice.ts";
import { createAutoRefresh, loadedBuild } from "@client/auto-refresh.ts";
import { CONNECTION_ERROR, createConnectionNotice } from "@client/connection-notice.ts";
import { createConnectingDim } from "@client/connecting-dim.ts";
import { cachedEmbeds, rememberEmbed } from "@client/embed-cache.ts";
import { installDialogKeys } from "@client/dialog-keys.ts";
import { edgeSwipeWanted, installEdgeSwipe } from "@client/edge-swipe.ts";

// One notice for a linked message that is missing, deleted or not readable, so a link never tells
// someone without access whether the message exists.
const LINK_MISSING = "That message isn't available.";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function socketUrl(): string {
  const scheme = location.protocol === "http:" ? "ws:" : "wss:";
  return `${scheme}//${location.host}/irc`;
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.json().catch(() => ({}));
}

export function createClient(Alpine: any) {
  const rs = createRuntimeState();
  // A workspace list carried from another workspace's dialog, before the router reads the fragment.
  takeCarriedWorkspaces();
  const instance = location.origin;
  const url = socketUrl();
  const root = document.documentElement;
  const lifecycle = new AbortController();
  // The dev server sets `slirc_phone=1` for ?phone=1; honor it on HTTPS too so the approved local
  // origin can show the phone layout. The client route is dev-gated, so this cannot leak to prod.
  const COARSE = matchMedia("(pointer: coarse)").matches || document.cookie.includes("slirc_phone=1");
  const isDesktop = !COARSE;

  let projection: ConversationProjection | null = null;
  let unread: UnreadProjection | null = null;
  // Immutable account id from the latest /auth/me, kept even when access is denied for zero
  // conversations. The join acceptance compares this instead of the mutable scope key.
  let painted = false;
  const paintWaiters: Array<() => void> = [];
  let reconnectTimer: number | null = null;
  // A dropped socket retries almost at once, then backs off. The delay resets only when a room goes
  // live, so a socket that opens and is refused still backs off instead of looping every 250 ms.
  const RECONNECT_FIRST_MS = 250;
  let reconnectDelay = RECONNECT_FIRST_MS;
  let connectEpoch = 0;
  // The latest connect run, so a live event can wait for it instead of superseding it mid-flight.
  let connecting: Promise<void> = Promise.resolve();
  // The socket is opened while /auth/me is still in flight, so the WebSocket upgrade overlaps it
  // (one round trip through a proxy like Cloudflare). Registration waits for /auth/me to name the
  // account. Only a browser that was signed in before pre-opens, so a sign-in page never knocks.
  let earlySocket: WebSocket | null = null;
  const SIGNED_IN_HINT = "slirc2-signed-in";
  function signedInHint(on?: boolean): boolean {
    try {
      if (on === true) localStorage.setItem(SIGNED_IN_HINT, "1");
      else if (on === false) localStorage.removeItem(SIGNED_IN_HINT);
      return localStorage.getItem(SIGNED_IN_HINT) === "1";
    } catch { return false; }
  }
  function dropEarlySocket(): void {
    earlySocket?.close();
    earlySocket = null;
  }
  let renderEpoch = 0;

  root.classList.add("booting");

  function setBooting(on: boolean): void {
    ui.booting = on;
    root.classList.toggle("booting", on);
  }

  // Boot is released by real state, not a timer: unauthenticated/denied/error the moment auth/me
  // answers, authenticated only after the cached projection can actually paint.
  function releaseBoot(): void {
    if (ui.booting) setBooting(false);
  }

  // After the shell reveals, put the caret in a visible composer so typing works without a click.
  // Never steal focus from an already-used control, a dialog, or a hidden composer, and never
  // scroll-jump (the browser still decides whether a phone keyboard is allowed).
  function maybeFocusComposer(force = false): void {
    if (!ui.authenticated || ui.profileRoute || ui.settingsRoute || ui.channelsRoute || ui.ircRoute || ui.agentsRoute || ui.adminRoute || ui.admissionRoute || ui.booting) return;
    if (!ui.isDesktop && ui.mobileNav !== null) return;
    if (document.querySelector("dialog[open]")) return;
    const active = document.activeElement;
    if (!force && active && active !== document.body && active !== document.documentElement) return;
    const input = document.querySelector<HTMLElement>("#input");
    if (!input || !input.getClientRects().length || getComputedStyle(input).visibility === "hidden") return;
    input.focus({ preventScroll: true });
  }

  function revealShell(): void {
    releaseBoot();
    maybeFocusComposer();
  }

  function applyChrome(): void {
    // Desktop-only rail class; the phone uses mobileNav instead.
    document.body.classList.toggle("rooms-docked", ui.isDesktop && ui.roomsOpen);
  }

  function paintNow(): void {
    if (painted) return;
    painted = true;
    for (const resolve of paintWaiters.splice(0)) resolve();
  }

  function whenPainted(ms = 1_200): Promise<void> {
    if (painted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      paintWaiters.push(resolve);
      globalThis.setTimeout(resolve, ms); // a slow/empty cache still reveals the shell
    });
  }

  const history: HistoryAdapter = {
    // navigation.ts routes are app-root; the client page lives at the root.
    push: (routeUrl, state) => window.history.pushState(state, "", mountUrl(routeUrl)),
    replace: (routeUrl, state) => window.history.replaceState(state, "", mountUrl(routeUrl)),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
  };
  const nav = createNavigation({ origin: instance, history });
  // A labelled link to a message here opens it in place instead of the link menu.
  const openMessageLink = (href: string) => {
    const screen = parseRoute(href, instance);
    if (!screen) return;
    rs.navIntent += 1;
    nav.open(screen);
  };
  const ui: any = Alpine.reactive(createClientState(isDesktop, COARSE));
  ui.view = createView(ui);
  const notes = createNotes(Alpine.reactive, { onChange: () => showNotes() });
  // The THREADS group in the sidebar: reply threads this person started or replied to.
  const replyThreads = createReplyThreadList(Alpine.reactive, {
    db: () => rs.db,
    conversationFor: (channel) => {
      const item = rs.authorized.find((entry) => entry.kind !== "thread" && foldIdentifier(entry.wireTarget) === foldIdentifier(channel));
      if (!item) return null;
      if (item.kind === "dm") {
        const nick = ui.directs.find((direct: { channel: string }) => foldIdentifier(direct.channel) === foldIdentifier(channel))?.nick;
        return nick ? { conversationId: item.conversationId, label: nick, nick } : null;
      }
      return { conversationId: item.conversationId, label: isGroupRoom(item.wireTarget) ? roomLabelFor(item.wireTarget) : `#${roomLabelFor(item.wireTarget)}` };
    },
    openRootId: () => ui.replyThreadRootId,
    show: (entry) => showReplyThread(entry),
    linkTitle: (url) => ui.embeds[url]?.title || (rs.scope ? cachedEmbeds(rs.scope.accountId)[url]?.title : undefined),
  });
  ui.installBanner = installBannerVisible(installEnv(window as never));
  ui.canSwitchWorkspace = canSwitchWorkspace(window as never);
  ui.workspace = workspaceMark(location.host, location.origin, document.querySelector<HTMLMetaElement>('meta[name="slirc-workspace-icon"]')?.content || "");
  const iphoneApp = createIphoneApp(ui, window);
  function shownSegments(text: string) {
    const canOpen = (channel: string) => (ui.channels as { wireTarget?: string }[]).some((item) => foldIdentifier(item.wireTarget ?? "") === foldIdentifier(channel));
    return displaySegments(threadAnnouncementDisplayText(text, instance), (part) => channelLinks(emojiTextSegments(part, emoji.custom), canOpen, instance), (href) => messageLinkLabel(href, instance, dmPeerNick));
  }
  // About names the client build from /api/version, and the app's own version inside the iOS shell.
  ui.aboutLabel = aboutLabel("", shellVersion(window as never));
  void fetch("/api/version", { cache: "no-store" }).then((response) => response.json())
    .then((body) => { ui.aboutLabel = aboutLabel(String(body?.version ?? ""), shellVersion(window as never)); })
    .catch(() => {});
  const { unreadCount, homeDot, threadsUnread, dmsDot, applyUnreadChrome, conversationOnScreen, scheduleMarkRead, cancelMarkRead, applyServerMarker, seedReadMarker } = createUnread({ state: rs, ui, isGroupRoom: (...args) => isGroupRoom(...args), wireSend: (...args) => wireSend(...args), transcript: () => transcript });
  const { dmPeerIds, provisioning, peerAccountIdFor, pendingIdForNick, pendingDirectRows, contactList, isLocallyEnqueueable, ensurePendingDirect, restorePendingDirects, retryPendingDirect, provisionDirect, openDirect } = createDirectMessages({ state: rs, ui, nav, connect: (...args) => connect(...args), openNotes: (...args) => openNotes(...args), refreshDrafts: (...args) => refreshDrafts(...args) });
  const { dmPeerNick, conversationIdForDm, isGroupRoom, groupList, roomLabelFor, channelList, saveChannelOrder, directList, agentList, headerTitle, headerSubtitle, activeChannelArchived, headerTooltip, starredItems, toggleStar, toggleMute, isOpenRoom } = createSidebarLists({ state: rs, ui, pendingDirectRows, applyUnreadChrome, menus: () => menus });
  const { refreshDrafts, updateDraftNavigation, draftWriter, draftsList, clearDraftFocus, focusLoadedDraft, openDraft, deleteDraft } = createDrafts({ state: rs, ui, nextTick: (...args) => nextTick(...args), editor: () => editor, openRoom: (...args) => openRoom(...args), openDirect: (...args) => openDirect(...args) });
  const { mediaSender, revokeMedia, pickMedia, removeMedia, cancelCompress, pasteMedia, onDragOver, onDragLeave, onDrop, restoreMediaDraft, sendMedia } = createMediaUpload({ state: rs, ui, emoji: () => emoji, editor: () => editor, transcript: () => transcript, refreshDrafts: (...args) => refreshDrafts(...args) });
  const { openJump, canSearchChannel, openChannelSearch, recallSent } = createSearch({ state: rs, ui, isDesktop, openPopup: (...args) => openPopup(...args), notes, library: () => library, polls: () => polls, isGroupRoom: (...args) => isGroupRoom(...args), isOpenRoom: (...args) => isOpenRoom(...args), unreadCount: (...args) => unreadCount(...args), roomLabelFor: (...args) => roomLabelFor(...args), conversationIdForDm: (...args) => conversationIdForDm(...args), contactList: (...args) => contactList(...args), activeChannelArchived: (...args) => activeChannelArchived(...args), offlineFolded: (...args) => offlineFolded(...args), replaceComposerText: (...args) => replaceComposerText(...args) });
  Object.assign(ui, {
    commandPaletteStyle: () => commandPaletteStyle(ui.isDesktop),
    giphyPanelStyle: () => giphyPanelStyle(ui.isDesktop),
    placePlusMenu,
    placeMenuUnder,
    fenceHtml,
    send,
    resend,
    cancel,
    canEdit,
    canDelete,
    quoteMessage,
    startEdit,
    cancelEdit,
    saveEdit,
    isEditing: () => !!ui.editingMessageId,
    redactFor,
    redactLabel,
    retryRedact,
    stateLabel,
    agentRequestLabel,
    canSend,
    formatTime,
    textSegments: shownSegments,
    // An agent's offline notice as a card, or null for every other line (see agent-offline.ts).
    agentOffline: offlineView,
    copyAgentCommand,
    // Link previews also cover links inside list items.
    linkSegments: (text: string) => shownSegments(text).flatMap((segment) => segment.parts ?? [segment]),
    openMessageLink,
    youtubeId,
    embedImageUrl,
    editingMedia,
    removeEditingMedia,
    draftsList,
    openDraft,
    deleteDraft,
    lucideIcon,
    pickMedia,
    pasteMedia,
    removeMedia,
    cancelCompress,
    onDragOver,
    onDragLeave,
    onDrop,
    reconnect,
    toggleRooms,
    openRoom,
    openHome,
    openProfile,
    openSettings,
    openChannels,
    openInvitations,
    openIrc,
    openAgents,
    openAdmin,
    isOpenRoom,
    openThreadParent,
    toggleThreads,
    threadNest,
    isExpanded,
    pickChannel,
    openJump,
    canSearchChannel,
    openChannelSearch,
    activeChannelArchived,
    threadForMessage,
    openThreadForMessage,
    threadRootTextDiffers,
    replyThreadSummaryFor,
    replyThreadBroadcastParent,
    openReplyThread,
    closeReplyThread,
    copyMessageLink,
    backFromReplyThread,
    activeReplyThreadRoot,
    activeReplyThreadReplies,
    sendReplyThread,
    replyThreadKeydown,
    reactionPresets: DEFAULT_REACTIONS,
    messageText: (message: Message | null | undefined) => messageBodyText(message && isActionText(message.text) ? actionBody(message.text) : String(message?.text ?? ""), instance, (href) => ui.embeds[href]?.kind === "image"),
    isAction: (message: Message | null | undefined) => !!message && isActionText(message.text),
    chooseReaction,
    reactionsReady,
    hideActiveTooltip,
    reactionChips: (message: Message | null) => (message ? reactionChips(ui.reactions, message.serverId) : []),
    reactionTooltip: (message: Message, emoji: string) => reactionTooltip(ui.reactions, message.serverId, emoji, ui.account),
    goBack,
    canGoBack,
    canGoForward,
    goForward,
    isGiphyUrl,
    avatarUrl: (nick: string) => personAvatarUrl(nick),
    mentionAgent: (nick: string) => agentMention(ui.agentProfiles, nick),
    agentAttached: (nick: string) => presence.agents[foldIdentifier(nick || "")] === true,
    avatarStatus: (nick: string) => presence.status(nick, foldIdentifier(nick || "") === foldIdentifier(ui.account) ? profile.profileSaved.availability : undefined, foldIdentifier(nick || "") === foldIdentifier(ui.account) ? profile.profileForm.badge : undefined),
    avatarStatusLabel: (nick: string) => presence.label(nick, foldIdentifier(nick || "") === foldIdentifier(ui.account) ? profile.profileSaved.availability : undefined, foldIdentifier(nick || "") === foldIdentifier(ui.account) ? profile.profileForm.badge : undefined),
    logout,
    openDirect,
    contactList,
    retryPendingDirect,
    openSticky: (id: string) => ircResetOpen(id) || autoRefresh.open(id) || reminderNotice.open(id),
    dismissSticky: (id: string) => ircResetDismiss(id) || autoRefresh.dismiss(id) || reminderNotice.dismiss(id),
    dismissAllStickies: () => reminderNotice.dismissAll(),
    starredItems,
    channelList,
    directList,
    agentList,
    headerTitle,
    headerSubtitle,
    headerTooltip,
    groupList,
    roomLabelFor,
    isStarred: (id: string) => ui.starred.includes(id),
    isMuted: (target: string) => ui.mutedRooms.includes(target),
    unreadCount,
    badgeText: (id: string) => badgeText(unreadCount(id)),
    threadsUnread,
    threadsBadge: () => badgeText(threadsUnread()),
    homeDot,
    dmsDot,
    // Phone tab bar: on the tab roots and More pages, never over a conversation, where the composer sits in its place.
    phoneTabBar: () => ui.view.showsTabBar,
    toggleMute,
    conversationIdForDm,
    toggleStar,
    openDms,
    openMore,
    formatPairCode,
    pairRequestSummary,
    normalizePairCode,
    validSignInEmail,
  });

  const signIn = createSignIn(Alpine.reactive, ui);
  const nextTick = (callback?: () => void) => Alpine.nextTick(callback);
  const session: ClientSession = { scope: () => rs.scope, key: () => rs.currentScope, stopped: () => rs.stopped, signingOut: () => rs.signingOut };
  // A DM the last grant does not list (closed here, or just started by the other person) got a
  // message; refresh the grant so it appears and its history loads. Known DMs need nothing.
  // Phone pairing by QR: the desktop card that shows a one-time code, and the phone's scanner.
  const phoneOffer = createPhoneOffer(Alpine.reactive, { onPhone: () => { ui.hasPhone = true; } });
  const scanner = createQrScanner(Alpine.reactive, { origin: () => location.origin, onSignedIn: () => { void connect(); }, navigate: (url) => { void openWorkspaceLink(url, window as never); } });
  const agentBack = createAgentBackToast();
  const pairing = createDevicePairing(Alpine.reactive, { core: ui, nextTick, session, suspended: () => rs.suspended, viewEpoch: () => renderEpoch, email: () => signIn.email,
    onOfferRedeemed: (data) => phoneOffer.redeemed(data),
    onNotes: () => { void notes.load(); },
    onReplyThreads: () => { void replyThreads.load(); },
    onPoll: (id) => polls.changed(id),
    onStreamReady: () => { polls.refreshAll(); void replyThreads.load(); },
    onDirect: (channel) => { if (!rs.authorized.some((item) => item.kind === "dm" && foldIdentifier(item.wireTarget) === foldIdentifier(channel))) void connect(); },
    // Another device (or person) changed this account's channels. Wait out a refresh already under
    // way, which may have read /auth/me before the change, then refresh only if the list disagrees.
    onChannels: (channel, member, deleted) => {
      if (deleted) { channelDeleted(channel); return; }
      void connecting.catch(() => {}).then(() => {
        if (rs.authorized.some((item) => item.kind !== "dm" && foldIdentifier(item.wireTarget) === foldIdentifier(channel)) !== member) void connect();
      });
    },
    onAgentPresence: (nick, attached) => {
      // A returning agent gets a toast, not a transcript line, and only while its DM is on screen.
      const viewing = !!ui.direct && foldIdentifier(String(ui.channel ?? "")) === foldIdentifier(nick);
      if (agentBack(foldIdentifier(nick), attached, viewing)) hint(`${agentLabel(ui.agentProfiles, nick)} is back online`);
      presence.setAgentAttached(nick, attached); agents.setPresence(nick, attached); refreshForAgent(nick);
    },
    onAgentPending: () => { if (ui.agentsRoute) void agents.load(); },
    onAgentConnectRequest: (data) => agents.showRequest(data),
    onAgentRequests: (data) => { ui.agentRequests = data?.accountId === rs.authenticatedAccountId ? data.requests : []; },
    onAgentRemoved: (nick) => {
      agents.dropRow(nick);
      presence.setAgentAttached(nick, false);
      ui.agentProfiles = forgetAgent(ui.agentProfiles, nick);
      leaveRemovedAgent(nick);
      void connect();
    },
    onAgentUpdated: (data) => {
      const known = isAgentNick(ui.agentProfiles, data.nick);
      const next = applyAgentUpdate(ui.agentProfiles, data);
      if (next) ui.agentProfiles = next;
      agents.applyUpdate(data);
      if (!known || !ui.directs.some((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(data.nick))) void connect();
    } });
  const welcome = createFounderWelcome(Alpine.reactive, {
    load: async () => {
      const response = await fetch("/api/welcome", { cache: "no-store", credentials: "same-origin" });
      // 404 means this account is not the founder: keep the control hidden.
      if (!response.ok) return null;
      const body = await response.json().catch(() => ({})) as { enabled?: unknown; pending?: unknown };
      return { enabled: body.enabled === true, pending: Number.isFinite(body.pending) ? Number(body.pending) : 0 };
    },
    save: async (enabled: boolean) => {
      const response = await fetch("/api/welcome", {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error("Could not save the setting.");
    },
    drain: drainWelcome,
  });
  const profile = createProfilePage(Alpine.reactive, { core: ui, nextTick, session, welcome, setName: (name) => { ui.me = name; } });
  const settings = createSettingsPage(Alpine.reactive, { core: ui, nextTick, session });
  const channelCreate = createChannelsPage(Alpine.reactive, { core: ui, session, connect, openRoom });
  const accountIdFor = (nick: string): string | undefined => ui.accountIds[foldIdentifier(nick)];
  // Your own picture follows the profile page's local version; everyone else uses the server's.
  // Agents draw their harness mark instead of an upload.
  const personAvatarUrl = (nick: string): string => avatarUrl(nick, foldIdentifier(nick) === foldIdentifier(ui.account) ? profile.avatarVersion : ui.avatarVersions[foldIdentifier(nick)], agentFor(ui.agentProfiles, nick)?.harness);
  // Poll cards and the create-poll dialog. A card belongs to a channel the transcript shows; the
  // dialog posts to the channel the composer is on, never a DM, thread or Notes.
  const roomWire = (item: AuthorizedConversation | undefined) => item?.kind === "room" ? item.wireTarget : null;
  const polls = createPolls(Alpine.reactive, {
    // Signed out on /open-chat, the peek payload carries the poll views itself (peek.ts).
    enabled: () => ui.helpers.includes("poll") || (!ui.authenticated && !!ui.peekRoom),
    me: () => ui.account,
    wireFor: (conversationId) => roomWire(rs.authorized.find((item) => item.conversationId === conversationId)) ?? (!ui.authenticated && ui.peekRoom && conversationId === ui.currentConversationId ? ui.peekRoom : null),
    composerChannel: () => ui.notesOpen || ui.activeThread ? null : roomWire(activeConversation()),
    nextTick,
  });
  // Job digest cards: only from a bot account listed in the open channel's members.
  const jobCards = createJobCards(Alpine.reactive, { isBot: (nick) => isBotRow(ui.roomMemberRows, nick) });
  const newConversation = createNewConversation(Alpine.reactive, { core: ui, session, nextTick, connect, openDirect: (nick, accountId) => {
    // People search supplies verified identity; registration enables the existing optimistic path.
    if (accountId) {
      ui.accountIds[foldIdentifier(nick)] = accountId;
      if (!ui.contacts.some((contact: string) => foldIdentifier(contact) === foldIdentifier(nick))) ui.contacts.push(nick);
    }
    return openDirect(nick);
  }, openRoom, accountIdFor, avatarUrl: personAvatarUrl });
  const invitationsPage = createInvitationsPage(Alpine.reactive, { core: ui, session });
  const bulkInvite = createBulkInvite(Alpine.reactive, { core: ui, session, nextTick });
  const destinationReachable = (result: { type?: string; channel?: string; nick?: string }): boolean => result.type === "direct"
    ? ui.directs.some((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(result.nick || ""))
    : rs.authorized.some((item) => item.kind !== "dm" && foldIdentifier(item.wireTarget) === foldIdentifier(result.channel || ""));
  const invitationAccept = createInvitationAccept(Alpine.reactive, {
    session,
    connect,
    openDirect,
    openRoom,
    goHome: () => openHome(),
    logout: () => logout(),
    authenticatedAccountId: () => rs.authenticatedAccountId,
    destinationReachable,
  });
  const admission = createAdmissionScreen(Alpine.reactive, {
    core: ui,
    session,
    connect,
    openDirect,
    openRoom,
    goHome: () => openHome(),
    logout: () => logout(),
    authenticatedAccountId: () => rs.authenticatedAccountId,
    destinationReachable,
  });
  const admissionFounder = createAdmissionFounder(Alpine.reactive, { core: ui, session });
  const irc = createIrcPage(Alpine.reactive, { core: ui, session, nextTick });
  const agents = createAgentsPage(Alpine.reactive, { core: ui, session, openDm: (nick) => { void openDirect(nick); },
    onRows: (rows) => { ui.agentProfiles = mergeAgents(ui.agentProfiles, rows, { owner: String(ui.account ?? ""), allAgents: true }); },
    onRemoved: (nick) => { ui.agentProfiles = forgetAgent(ui.agentProfiles, nick); leaveRemovedAgent(nick); void connect(); } });
  const adminStatus = createAdminPage(Alpine.reactive, { core: ui, session });
  const branding = createWorkspaceIcon(Alpine.reactive, { core: ui, session });
  // A fired reminder in the remind DM raises a sticky toast unless that DM is on screen.
  const connectionNotice = createConnectionNotice({
    show: (text) => { ui.error = text; },
    clear: () => { if (ui.error === CONNECTION_ERROR) ui.error = ""; },
  });
  // A deploy restarts the server: each reconnect compares the served build with this page's.
  const autoRefresh = createAutoRefresh({
    core: ui,
    loaded: loadedBuild(document),
    fetchVersion: () => fetch("/api/version", { cache: "no-store" }).then((response) => response.json()).then((body) => String(body?.version ?? "")),
    hidden: () => document.hidden,
    busy: () => Boolean(String(ui.composer ?? "").trim()) || Boolean(ui.editingMessageId) || Boolean(ui.media) || ui.mediaBusy || Boolean(ui.mediaCompress) || Boolean(ui.pendingThread)
      || scanner.open || document.querySelector("dialog[open]") !== null,
    reload: () => location.reload(),
    storage: (() => { try { return sessionStorage; } catch { return null; } })(),
  });
  const reminderNotice = createReminderNotice({ core: ui, origin: instance, onScreen: (id) => id === rs.roomId && conversationOnScreen(), open: (nick) => { void openDirect(nick); }, openLink: openMessageLink });
  // Ephemeral IRCv3 typing state over the live connection. The send path reuses the same socket,
  // capability, ownership and readiness gates as the outbox; nothing here is persisted or queued.
  const typing = createTypingIndicators(Alpine.reactive, {
    self: () => rs.scope?.account ?? "",
    isAuthorized: (id) => id === NOTES_CONVERSATION_ID || rs.directories.has(id),
    current: () => ui.currentConversationId,
    label: (account) => agentLabel(ui.agentProfiles, account),
    send: (value) => {
      if (rs.stopped || rs.signingOut || !ui.sendOwner) return;
      if (!rs.capsOk || !rs.roomId || rs.socket?.readyState !== WebSocket.OPEN) return;
      if (!(rs.sync?.isReady(rs.roomId) ?? false)) return;
      const item = rs.authorized.find((entry) => entry.conversationId === rs.roomId);
      if (item) wireSend(typingLine(item.wireTarget, value));
    },
  });
  const openPopup = createPopupOpener();
  const menus = createConversationMenu(Alpine.reactive, { core: ui, openPopup });
  const channelDrag = createChannelDrag(Alpine.reactive, {
    list: channelList,
    order: () => ui.channelOrder,
    setOrder: (ids) => { ui.channelOrder = ids; },
    saveOrder: (ids) => { saveChannelOrder(ids); },
    closeMenus: () => { menus.close(); },
    nextTick,
  });
  const channelPrefs = createChannelSettings(Alpine.reactive, { core: ui, nextTick, session, closeMenu: openPopup, onDeleted: (channel) => channelDeleted(channel) });
  const directDelete = createDirectDelete(Alpine.reactive, { core: ui, nextTick, session, authorized: () => rs.authorized, nav, connect, closeMenu: openPopup });
  const presence = createPresence(Alpine.reactive, wireSend);
  const people = createPeopleCard(Alpine.reactive, { core: ui, openPopup, sendWhois: (nick) => { if (rs.socket?.readyState !== WebSocket.OPEN) return false; rs.socket.send(`WHOIS ${nick}\r\n`); return true; }, activeChannel: () => activeConversation()?.wireTarget ?? "", openRoom, openDirect: (nick) => openDirect(nick, true), focusComposer: () => { void Alpine.nextTick(() => maybeFocusComposer(true)); }, conversations: () => rs.authorized, directs: () => ui.directs, channelDetails: () => ui.channelDetails, threads: () => ui.threads });
  // Right members rail: reads the runtime's one authorized fetch and the existing presence controller.
  const members = createMembersPanel(Alpine.reactive, {
    core: ui,
    canShow: () => membersPanelVisible({
      authenticated: ui.authenticated, stopped: rs.stopped,
      direct: ui.direct, threaded: !!ui.activeThread, channel: String(ui.channel ?? ""),
      route: ui.view.routed,
      authorized: !!rs.roomId && rs.directories.has(rs.roomId),
      publicRoom: ui.openRooms[String(ui.channel ?? "")] === true,
    }),
    request: () => loadRoomMembers(activeConversation(), rs.roomId),
    status: (nick) => presence.status(nick),
    label: (nick) => presence.label(nick),
    avatarUrl: personAvatarUrl,
    agent: (nick) => agentFor(ui.agentProfiles, nick),
    openProfile,
    openWhois: (nick) => people.openWhois(nick),
    focusToggle: () => document.querySelector<HTMLElement>(".members-toggle")?.focus(),
  });
  const mediaView = createMediaView(Alpine.reactive, { core: ui, nextTick, openPopup, session, origin: instance,
    autoCollapsed: (message) => collapsesOlderGiphy({ channel: String(ui.channel ?? ""), coarse: COARSE, open: isOpenRoom(String(ui.channel ?? "")), direct: !!ui.direct, thread: !!ui.activeThread }) && isOlderGiphy(transcript.displayedMessages(), message) });
  const transcript = createTranscript({ core: ui, nextTick, authorized: () => rs.authorized, stopped: () => rs.stopped, menuOpenId: () => actions.actionMessageId, linkOpen: () => !!links.linkPopup, closeLink: () => links.closeLinkPopup(false), onPinChange: (pinned) => { if (pinned) scheduleMarkRead(); }, hidden: (message) => polls.hidesTally(message) || offlineFolded(message), rememberEmbed: (url, meta) => { if (rs.scope) rememberEmbed(rs.scope.accountId, url, meta); } });
  const peek = createPeekView({ ui, polls, scrollToBottom: (force) => transcript.scrollToBottom(force), nextTick: (callback) => { void nextTick(callback); }, signedInBefore: () => signedInHint(), openRoom: (room) => nav.open({ kind: "room", room }, { replace: true }) });
  peek.start();
  const giphy = createGiphyPicker(Alpine.reactive, { core: ui, session, openPopup, roomId: () => rs.roomId, isAuthorized: (id) => id === NOTES_CONVERSATION_ID || rs.directories.has(id), queueConversationText, saveNote: (text) => notes.add(text) });
  const emoji = createEmojiPicker(Alpine.reactive, { core: ui, openPopup, nextTick, getCaret: () => {
    const input = document.querySelector<HTMLElement>("#input");
    return input ? editor.composerSelectionOffset(input) : ui.composer.length;
  }, insert: (row) => editor.chooseEmoji(row) });
  const editor = createComposerEditor(Alpine.reactive, { core: ui, nextTick, draftComposer: () => ui.pendingThread ? null : rs.composer, roomId: () => rs.roomId, rememberText: (text) => { if (rs.roomId && !ui.pendingThread) rs.composerTextByConversation.set(rs.roomId, text); }, updateDraftNavigation, send, cancelEdit, chooseCommand, closeGiphy: giphy.closeGiphy, moveGiphy: giphy.moveGiphy, giphy, onChatScroll: transcript.onChatScroll, scrollToBottom: transcript.scrollToBottom, coarse: COARSE, emoji, recallSent: (direction) => recallSent(direction), onActivity: (text) => { if (!ui.editingMessageId && !ui.pendingThread) typing.noteTyping(text); }, onBlur: () => typing.stopTyping(), answerAddPrompt: (key) => addPrompts.answer(ui.currentConversationId, key) });
  const actions = createMessageActions(Alpine.reactive, { core: ui, nextTick, openPopup, canEdit, canDelete, startEdit, quoteMessage, openThreadForMessage, chooseReaction, focusComposer: () => editor.focusComposer(), deleteMessage: confirmDelete, focusAfterDelete: maybeFocusComposer,
    messageLink, setReminder: runRemind, customEmoji: () => emoji.custom });
  const links = createLinkActions(Alpine.reactive, { core: ui, nextTick, openPopup, canEdit, startEdit, setComposerSelection: editor.setComposerSelection, displayOffsetAtSource: editor.displayOffsetAtSource });
  // Inline Add / Ignore notes for /invite @nick and helper mentions; desktop hands focus back to the composer.
  const addPrompts = createAddPrompts(Alpine.reactive, { session, self: () => String(ui.account ?? ""), nextTick, reveal: (force) => transcript.scrollToBottom(force),
    serverIdFor: (messageId) => ui.messages.find((message: Message) => message.id === messageId)?.serverId,
    restoreFocus: () => { if (!COARSE) maybeFocusComposer(); } });
  const greetingNote = createGreetingNote(Alpine.reactive, { core: ui, session });
  // The Links view of a channel that has the links helper in it.
  const library = createLinksView(Alpine.reactive, {
    core: ui,
    routed: () => ui.view.routed,
    post: async (text) => {
      if (!rs.roomId) throw new Error("Messaging is not ready yet. Reconnect and try again.");
      await queueConversationText(rs.roomId, text);
    },
    nextTick,
    desktop: () => isDesktop,
    readMarker: async () => {
      const id = ui.currentConversationId;
      const marker = rs.db && id ? await rs.db.readMarkers.get(id) : undefined;
      const time = marker ? Date.parse(marker.time) : NaN;
      return Number.isFinite(time) && time > 0 ? time : undefined;
    },
  });
  Object.assign(ui, { greetingNote, library });
  const messageView = createMessageView({ embeds: () => ui.embeds, linkSegments: ui.linkSegments, messageText: ui.messageText, isGiphyUrl, embedImageUrl, playerCard: mediaView.playerCard, isMediaError: mediaView.isMediaError, redactFor, stampedReaction: () => actions.stampedReaction });
  Object.assign(ui, { polls, jobCards, notes, replyThreads, openNotes, addPrompts, transcript, giphy, emoji, pairing, phoneOffer, scanner, signIn, profile, settings, channelCreate, newConversation, invitationsPage, bulkInvite, invitationAccept, admission, admissionFounder, irc, agents, adminStatus, branding, typing, members, menus, channelDrag, channelPrefs, directDelete, people, mediaView, messageView, actions, editor, links });

  // The router owns tab/detail screens on both shells; no second navigation stack.
  // A desktop tab with no conversation in the route still needs a real room behind it: reloading
  // /profile leaves no back entry, so its fallback Home tab lands on an authorized room or DM.
  function defaultConversationId(): string | null {
    return defaultConversationIdFor(rs.authorized);
  }
  let phoneAnimation: Animation | null = null;
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
    library.sync();
    if ((enteringSettings || enteringProfile) && ui.authenticated) settings.open();
    if (enteringIrc && ui.authenticated) irc.open();
    if (enteringAgents && ui.authenticated) agents.open();
    if (enteringAdmin && ui.authenticated) adminStatus.open();
    // Invitations carries the founder-only review section on the same page, so opening it also
    // loads admission requests for the instance owner.
    if (enteringInvitations && ui.authenticated) { invitationsPage.open(); if (ui.isFounder) admissionFounder.open(); }
    // The join info fetch is public, so load it before authentication is known; acceptance is a
    // real authenticated call later.
    if (screen.kind === "join") void invitationAccept.start(screen.token);
    // The admission screen never fetches on open; start() only reads the persisted attempt state.
    if (screen.kind === "admission") admission.start(screen.token, screen.destination);
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
    void transcript.loadEmbeds(ui.messages);
    void mediaView.loadUploadDims(ui.messages);
  }
  const unsubscribeNav = nav.$state.subscribe(applyNav);
  applyNav(nav.$state.get());
  let pendingInitialRoute = "";
  {
    // A pairing link (/agents#connect=…) opens the Allow card on Agents, after sign-in if need be.
    const connecting = stashConnectToken();
    const initialRoute = connecting ? "/agents" : routeFromMount(location.pathname, location.hash, location.search);
    const parsed = parseRoute(initialRoute, instance);
    pendingInitialRoute = parsed ? "" : initialRoute;
    const initial: Screen = parsed ?? { kind: "tab", tab: "home" };
    nav.open(initial, { replace: true });
  }
  window.addEventListener("popstate", (event) => {
    rs.navIntent += 1;
    nav.pop(routeFromMount(location.pathname, location.hash, location.search), event.state ?? undefined);
    // Safari already animates edge-back; do not fade the restored page a second time.
    transcript.noFade();
  }, { signal: lifecycle.signal });
  applyChrome();

  function stateLabel(message: Message): string {
    switch (message.state) {
      case "saving": return "saving";
      case "queued": return "queued";
      case "sending": return "sending";
      case "uncertain": return "uncertain — not retried";
      case "failed": return `failed${message.error ? `: ${message.error}` : ""}`;
      default: return "";
    }
  }

  function agentRequestLabel(message: Message): string {
    if (!message.serverId || message.deleted || message.state !== "confirmed" || foldIdentifier(message.authorAccount) !== foldIdentifier(ui.account)) return "";
    const conversation = rs.directories.get(message.conversationId);
    if (conversation?.kind !== "dm") return "";
    const direct = ui.directs.find((row: { channel: string }) => foldIdentifier(row.channel) === foldIdentifier(conversation.wireTarget));
    const agent = direct && agentFor(ui.agentProfiles, direct.nick);
    if (!agent || foldIdentifier(agent.owner) !== foldIdentifier(ui.account)) return "";
    return ui.agentRequests.find((row: { channel: string; messageId: string }) =>
      foldIdentifier(row.channel) === foldIdentifier(conversation.wireTarget) && row.messageId === message.serverId)?.state || "";
  }

  function canSend(): boolean {
    const hasContent = !!ui.composer.trim() || !!ui.media;
    return hasContent && ui.sendEnabled && rs.capsOk && !(rs.composer?.committing ?? false) && !ui.mediaBusy && !ui.mediaCompress;
  }

  // A live event about an agent this tab has never heard of (a fresh pairing) refreshes /auth/me
  // once, so its DM and profile show up without a reload.
  const agentRefreshes = new Set<string>();
  function refreshForAgent(nick: string): void {
    const key = foldIdentifier(nick);
    if (isAgentNick(ui.agentProfiles, nick) || agentRefreshes.has(key)) return;
    agentRefreshes.add(key);
    void connect();
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
    transcript.focus(rootId ?? serverId, { flash: !opens });
  }

  function selectConversation(id: string | null, focusMessageId?: string, focusThread = false): void {
    linkRun += 1;
    clearDraftFocus(id);
    // Leaving a conversation ends our own typing there; the target is still the previous roomId.
    if (rs.roomId !== id) { typing.stopTyping(); abandonPendingThread(); closeReplyThread(); }
    ui.currentConversationId = id;
    transcript.cancelConversationTransition();
    actions.closeActions();
    menus.starMenuId = ""; menus.navMenu = null; menus.copyFlyout = null;
    links.closeLinkPopup(false);
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
    library.sync();
    if (rs.roomId === id && rs.composer) { if (focusMessageId) void focusLinked(id!, focusMessageId, focusThread); focusLoadedDraft(id!); return; }
    transcript.prepare(rs.roomId, id, !ui.booting && ui.authenticated);
    if (rs.roomId && rs.composer) rs.composerTextByConversation.set(rs.roomId, rs.composer.text);
    rs.roomId = id;
    reminderNotice.viewed(id);
    projection?.select(id, focusMessageId);
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
    if (mediaView.lightbox) mediaView.closeLightbox();
    giphy.resetSearch(); ui.slashOpen = false;
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
        selectedComposer.load(draft); ui.composer = selectedComposer.text; editor.resizeComposer(); focusLoadedDraft(id!);
      });
    }
    // Desktop room switch lands the caret in the composer once the new room is on screen. A late
    // navigation invalidates this via transcript.version(), and the guards keep dialogs, Profile and
    // phone focus untouched.
    const focusVersion = transcript.version();
    void Alpine.nextTick(() => { if (ui.isDesktop && focusVersion === transcript.version() && rs.roomId === id) maybeFocusComposer(true); });
    scheduleMarkRead();
  }

  // A deleted channel leaves the grant on the next refresh. Whoever had it open lands on the
  // default channel (or the first one left) with a short notice; everyone else just loses the row.
  function channelDeleted(channel: string): void {
    const wasOpen = rs.authorized.some((item) => item.conversationId === rs.roomId && item.kind !== "dm" && foldIdentifier(item.wireTarget) === foldIdentifier(channel));
    void connecting.catch(() => {}).then(() => connect()).then(() => {
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
  // Bumped on every clear/navigation/account change; an in-flight member reply older than the current
  // generation is dropped so it cannot repopulate the rail after a disconnect or revoke.
  let memberEpoch = 0;

  function clearRoomMembers(): void {
    memberEpoch += 1;
    ui.roomMemberRows = []; ui.roomPendingInvitations = []; ui.roomMembers = []; ui.roomMembersOwner = "";
    ui.roomMembersPublic = false; ui.roomMembersLoading = false; ui.roomMembersError = "";
  }

  function loadRoomMembers(item: AuthorizedConversation | undefined, id: string | null): void {
    // No account scope yet (pre-connect reactivity): never fetch into an unauthenticated window.
    if (!rs.currentScope) { clearRoomMembers(); refreshPresence(); return; }
    if (!item || item.kind !== "room") { clearRoomMembers(); refreshPresence(); return; }
    const wire = item.wireTarget;
    const requestingScope = rs.currentScope;
    clearRoomMembers();
    const requestEpoch = memberEpoch;
    ui.roomMembersLoading = true;
    refreshPresence();
    void fetch(`/api/channels/${encodeURIComponent(wire)}/members`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) })
      .then(async (response) => ({ ok: response.ok, status: response.status, body: await response.json().catch(() => null) }))
      .then(({ ok, status, body }) => {
        if (!memberResponseApplies(
          { conversationId: id, scope: requestingScope, generation: requestEpoch },
          { conversationId: rs.roomId, scope: rs.currentScope, generation: memberEpoch, stopped: rs.stopped, authorized: !!rs.roomId && rs.directories.has(rs.roomId) },
        )) return;
        if (!ok) throw new Error(typeof body?.error === "string" ? body.error : `Could not load members (${status}).`);
        const rows: unknown[] = Array.isArray(body?.members) ? body.members : [];
        ui.roomMembersPublic = body?.public === true;
        ui.roomMembersOwner = typeof body?.owner === "string" ? body.owner : "";
        ui.roomPendingInvitations = Array.isArray(body?.pendingInvitations)
          ? body.pendingInvitations.filter((row: any) => row && typeof row.email === "string" && ["pending", "sending", "uncertain"].includes(row.status)) : [];
        ui.roomMemberRows = rows.filter((row): row is Record<string, unknown> => !!row && typeof (row as Record<string, unknown>).nick === "string")
          .map((row) => ({
            nick: String(row.nick),
            kind: typeof row.kind === "string" ? row.kind : "member",
            role: typeof row.role === "string" ? row.role : "member",
            machine: typeof row.machine === "string" ? row.machine : null,
            availability: typeof row.availability === "string" ? row.availability : "",
            badge: typeof row.badge === "string" ? row.badge : "",
          }));
        ui.roomMembers = ui.roomMemberRows.map((row) => row.nick);
        rememberAvatarVersions(ui.avatarVersions, rows);
        presence.setAvailability(rows as { nick: string; availability?: unknown; badge?: unknown; attached?: unknown }[]);
        ui.agentProfiles = mergeAgents(ui.agentProfiles, rows);
        ui.roomMembersLoading = false;
        refreshPresence();
      })
      .catch((error) => {
        if (!memberResponseApplies(
          { conversationId: id, scope: requestingScope, generation: requestEpoch },
          { conversationId: rs.roomId, scope: rs.currentScope, generation: memberEpoch, stopped: rs.stopped, authorized: !!rs.roomId && rs.directories.has(rs.roomId) },
        )) return;
        ui.roomMembersLoading = false;
        ui.roomMembersError = error instanceof Error && error.name === "TimeoutError" ? "Members took too long to load." : error instanceof Error ? error.message : "Could not load members.";
        ui.roomMemberRows = []; ui.roomPendingInvitations = []; ui.roomMembers = []; refreshPresence();
      });
  }

  function refreshPresence(): void {
    presence.watch([...ui.directs.map((item: { nick: string }) => item.nick), ...ui.contacts, ...ui.roomMembers]);
  }

  function openHome(): void { rs.navIntent += 1; nav.tab("home"); }
  function goBack(): void {
    rs.navIntent += 1;
    if (nav.canGoBack()) { nav.back(); transcript.noFade(); return; }
    nav.tab("home");
  }
  // Header chevrons read the mirrored router position; disabled when the stack has no step there.
  function canGoBack(): boolean { return historyAvailability(ui.navIndex, ui.navLength).back; }
  function canGoForward(): boolean { return historyAvailability(ui.navIndex, ui.navLength).forward; }
  function goForward(): void {
    rs.navIntent += 1;
    if (!canGoForward()) return;
    nav.forward();
    transcript.noFade();
  }
  function openDms(): void { rs.navIntent += 1; nav.tab("dms"); }
  function openMore(): void { rs.navIntent += 1; nav.tab("more"); }
  function openProfile(): void {
    rs.navIntent += 1;
    nav.open({ kind: "profile" });
    void welcome.load();
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
  // After the derived-password migration, people with password IRC clients, and admins with
  // managed bots, keep a sticky note until they make a new password or dismiss it.
  const IRC_RESET_NOTES = {
    "irc-reset-clients": { kind: "clients", text: "Your IRC password changed. Open IRC clients and copy the new one.", open: () => openIrc() },
    "irc-reset-bots": { kind: "bots", text: "Your bots' IRC passwords changed. Open Admin and press New password for each bot.", open: () => openAdmin() },
  } as const;
  type IrcResetId = keyof typeof IRC_RESET_NOTES;
  // Opened on this page: the note stays away until the next load, while the flag waits for a new password.
  const ircResetOpened = new Set<string>();
  function showIrcResetNotes(): void {
    const ids = (Object.keys(IRC_RESET_NOTES) as IrcResetId[]).filter((id) => ui.ircReset[IRC_RESET_NOTES[id].kind] && !ircResetOpened.has(id));
    ui.stickies = [...ids.map((id) => ({ id, text: IRC_RESET_NOTES[id].text, action: "Open", conversationId: "" })),
      ...ui.stickies.filter((item) => !(item.id in IRC_RESET_NOTES))];
  }
  function ircResetOpen(id: string): boolean {
    if (!(id in IRC_RESET_NOTES)) return false;
    ircResetOpened.add(id);
    ui.stickies = ui.stickies.filter((item) => item.id !== id);
    IRC_RESET_NOTES[id as IrcResetId].open();
    return true;
  }
  function ircResetDismiss(id: string): boolean {
    if (!(id in IRC_RESET_NOTES)) return false;
    const kind = IRC_RESET_NOTES[id as IrcResetId].kind;
    ui.stickies = ui.stickies.filter((item) => item.id !== id);
    ui.ircReset = { ...ui.ircReset, [kind]: false };
    void fetch("/api/irc/reset-notice", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) }).catch(() => {});
    return true;
  }
  const offlineCard = (message: Message) => agentOfflineCard(message, ui.direct ? String(ui.channel ?? "") : null, (nick) => isAgentNick(ui.agentProfiles, nick));
  // An agent's offline notice as a card, or null for every other line. A folded card (the agent
  // came back since) is left out of the transcript by offlineFolded. See agent-offline.ts.
  function offlineView(message: Message): AgentOfflineCard | null {
    return offlineCard(message);
  }
  function offlineFolded(message: Message): boolean {
    if (!offlineCard(message)) return false;
    const list = ui.messages as Message[];
    const at = list.findIndex((item) => item.id === message.id);
    const later = (at < 0 ? [] : list.slice(at + 1)).map((item) => ({ authorNick: item.authorNick, isCard: !!offlineCard(item) }));
    return agentOfflineFolded(message, later, presence.agents[foldIdentifier(message.authorNick)] === true);
  }

  // The resume command from an agent's offline card. The check mark shows for 1.5 s on that card.
  async function copyAgentCommand(message: Message): Promise<void> {
    const command = offlineCard(message)?.command;
    if (!command) return;
    try { await navigator.clipboard.writeText(command); } catch { return; }
    ui.copiedAgentCommand = message.id;
    setTimeout(() => { if (ui.copiedAgentCommand === message.id) ui.copiedAgentCommand = ""; }, 1_500);
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
    openPopup();
    window.dispatchEvent(new CustomEvent("slirc:help-open"));
  }

  // A thread started before an edit still belongs to the edited message.
  function threadForMessage(message: Message): ThreadGrant | undefined {
    const parent = currentParentWire();
    for (const id of [message.serverId, ...(message.chain ?? []).slice().reverse()]) {
      const thread = threadForRoot(ui.threads, parent, id);
      if (thread) return thread;
    }
    return undefined;
  }

  // Open the IRCv3 +reply thread panel inside the current channel or DM.
  async function openThreadForMessage(message: Message): Promise<void> {
    if (message.conversationId === NOTES_CONVERSATION_ID) return;
    actions.closeActions();
    const item = activeConversation();
    const parent = currentParentWire();
    if (!item || item.kind === "thread" || !parent || message.state !== "confirmed" || !message.serverId) {
      ui.threadError = "Threads start from a confirmed channel or DM message.";
      return;
    }
    openReplyThread(message);
  }

  function replyThreadSummaryFor(message: Message | null | undefined): ReplyThreadSummary | null {
    if (!message || ui.activeThread || ui.notesOpen) return null;
    return replyThreadSummary(buildReplyIndex(ui.messages), message);
  }

  function replyThreadBroadcastParent(message: Message | null | undefined): Message | null {
    if (!message || ui.activeThread || ui.notesOpen) return null;
    return broadcastParent(buildReplyIndex(ui.messages), message);
  }

  function openReplyThread(target: Message | string | null | undefined): void {
    const rootId = typeof target === "string" ? target : target?.serverId;
    if (!rootId || ui.activeThread || ui.notesOpen) return;
    actions.closeActions();
    if (members.open) members.dismiss();
    ui.replyThreadRootId = rootId;
    ui.replyThreadFaded = { ...ui.replyThreadFaded, [rootId]: true };
    ui.replyThreadError = "";
    void replyThreads.refresh();
    void Alpine.nextTick(() => {
      const focusInput = () => {
        if (ui.replyThreadRootId !== rootId) return;
        const stream = document.querySelector<HTMLElement>("#reply-thread-stream");
        if (stream) stream.scrollTop = stream.scrollHeight;
        document.querySelector<HTMLTextAreaElement>("#reply-thread-input")?.focus({ preventScroll: true });
      };
      focusInput();
      requestAnimationFrame(focusInput);
    });
  }

  // A row in the THREADS group: show its channel or DM, then the thread over it.
  function showReplyThread(entry: ReplyThreadItem): void {
    const item = rs.authorized.find((candidate) => candidate.kind !== "thread" && foldIdentifier(candidate.wireTarget) === foldIdentifier(entry.channel));
    if (!item) return;
    if (ui.currentConversationId !== item.conversationId) {
      if (item.kind === "dm" && entry.nick) void openDirect(entry.nick); else openRoom(item.wireTarget);
    }
    let tries = 0;
    const open = () => {
      if (ui.currentConversationId === item.conversationId) openReplyThread(entry.rootId);
      else if ((tries += 1) < 40) setTimeout(open, 50);
    };
    open();
  }

  function closeReplyThread(): void {
    ui.replyThreadRootId = "";
    ui.replyThreadDraft = "";
    ui.replyThreadBroadcast = false;
    ui.replyThreadError = "";
    document.body.classList.toggle("reply-thread-docked", false);
  }

  // Phone back arrow (and the iOS edge swipe that presses it): back to the channel, at the parent.
  function backFromReplyThread(): void {
    const rootId = ui.replyThreadRootId;
    closeReplyThread();
    if (rootId) transcript.focus(rootId);
  }

  function activeReplyThreadRoot(): Message | null {
    if (!ui.replyThreadRootId) return null;
    return replyThreadRoot(buildReplyIndex(ui.messages), ui.replyThreadRootId);
  }

  function activeReplyThreadReplies(): Message[] {
    if (!ui.replyThreadRootId) return [];
    return replyThreadReplies(buildReplyIndex(ui.messages), ui.replyThreadRootId);
  }

  function replyThreadKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeReplyThread();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendReplyThread();
    }
  }

  async function sendReplyThread(): Promise<void> {
    const root = activeReplyThreadRoot();
    const rootId = root?.serverId ?? ui.replyThreadRootId;
    if (!rootId || !rs.roomId || !rs.outbox || !rs.scope) return;
    const raw = String(ui.replyThreadDraft ?? "").trim();
    if (!raw) return;
    const wireText = emojiText(raw, emoji.custom);
    const check = wireText.includes("\n") ? validateMultiline(wireText.split("\n")) : validateText(wireText);
    if (!check.ok) {
      ui.replyThreadError = check.error ?? "Cannot send that reply.";
      return;
    }
    if (raw.includes("\n") && !rs.bridge?.enabled.has("draft/multiline")) {
      ui.replyThreadError = "This server cannot send multiline messages.";
      return;
    }
    ui.replyThreadError = "";
    const broadcast = !!ui.replyThreadBroadcast;
    try {
      await queueConversationText(rs.roomId, raw, { replyTo: rootId, broadcast });
      ui.replyThreadDraft = "";
      ui.replyThreadBroadcast = false;
      void Alpine.nextTick(() => {
        const stream = document.querySelector<HTMLElement>("#reply-thread-stream");
        if (stream) stream.scrollTop = stream.scrollHeight;
      });
    } catch (error) {
      ui.replyThreadError = error instanceof Error ? error.message : "Could not send reply.";
    }
  }

  // Back to the parent as it was: its label, and its draft with any thread text appended. Runs
  // while the parent is still selected, so `composer` is the parent's.
  function abandonPendingThread(): void {
    const pending = ui.pendingThread;
    if (!pending) return;
    ui.pendingThread = null;
    if (rs.roomId !== pending.conversationId) return;
    ui.roomLabel = pending.roomLabel;
    const text = pendingThreadFallbackText(pending.savedText, String(ui.composer ?? ""));
    ui.composer = text;
    if (text !== pending.savedText) rs.composer?.edit(text);
    rs.composerTextByConversation.set(pending.conversationId, text);
    editor.resizeComposer();
  }

  function reactionsReady(): boolean {
    // Alpine tracks reactive reads. Read phase, readyVersion, capsNote, the open conversation and
    // the message projection before the non-reactive capsOk/sync/socket guards, or a short-circuit
    // leaves the persistent picker buttons disabled after the open room turns ready.
    const phase = ui.phase;
    const tracked = [ui.readyVersion, ui.capsNote, ui.currentConversationId, ui.messages];
    void tracked;
    // Signed-out peek: chips stay pressable so a tap asks to sign in instead of doing nothing.
    if (!ui.authenticated && ui.peekRoom) return true;
    return phase === "live" && rs.capsOk && !!rs.roomId && (rs.sync?.isReady(rs.roomId) ?? false) && rs.socket?.readyState === WebSocket.OPEN;
  }

  // Online-first: send the TAGMSG on the live connection, report a refusal, and never paint a
  // count this tab did not receive back from the server. The committed event is the truth.
  function chooseReaction(message: Message, emoji: string): void {
    const item = activeConversation();
    const target = item?.wireTarget;
    actions.closeReactionPicker();
    if (!item || !target || !message || !message.serverId || message.state !== "confirmed") return;
    if (!reactionsReady()) { hint("Reactions need a live connection."); return; }
    const selected = reactionChips(ui.reactions, message.serverId).some((chip) => chip.emoji === emoji && chip.mine);
    try {
      // Taking a reaction back also clears it from the messages this one edited, where it may live.
      for (const id of selected ? [message.serverId, ...(message.chain ?? [])] : [message.serverId]) {
        rs.socket!.send(`${reactionTagMessage(target, id, emoji, selected)}\r\n`);
      }
      actions.stamp(`${message.serverId}:${emoji}`);
    } catch (error) {
      ui.sendError = error instanceof Error ? error.message : "Could not react.";
    }
  }

  function toggleRooms(): void {
    if (ui.isDesktop) {
      ui.roomsOpen = !ui.roomsOpen;
      applyChrome();
    } else {
      openHome();
    }
  }

  function resetAccountUi(): void {
    document.dispatchEvent(new CustomEvent("slirc:theme-account", { detail: { accountId: "" } }));
    transcript.cancelConversationTransition();
    // A pending first-contact DM belongs to the account that opened it; never carry it across.
    rs.pendingDms.clear(); provisioning.clear(); ui.pendingDm = false; ui.pendingDmState = ""; ui.pendingDmError = "";
    ui.authenticated = false;
    ui.workspaceChoices = [];
    ui.profileRoute = false;
    ui.settingsRoute = false;
    ui.channelsRoute = false;
    ui.invitationsRoute = false;
    ui.ircRoute = false;
    ui.agentsRoute = false;
    ui.adminRoute = false;
    iphoneApp.reset(); profile.resetProfile(); settings.reset(); channelCreate.reset(); newConversation.reset(); polls.reset(); jobCards.reset(); addPrompts.reset(); invitationsPage.reset(); bulkInvite.reset(); admission.reset(); admissionFounder.reset(); irc.reset(); agents.reset(); adminStatus.reset(); branding.reset(); typing.reset(); reminderNotice.reset(); welcome.reset(); welcomeDraining = false;
    ui.me = "";
    ui.account = "";
    notes.reset(); replyThreads.reset(); ui.notesOpen = false;
    ui.currentConversationId = null;
    ui.drafts = [];
    ui.isAdmin = false;
    ui.isFounder = false;
    ui.hasPhone = false;
    ui.greeting = true;
    ui.greetingNoteSeen = true;
    ui.threads = [];
    ui.activeThread = null;
    mediaView.reset(); menus.close(); channelDrag.reset(); directDelete.reset(); people.reset(); presence.reset();
    channelPrefs.closeChannelSettings();
    pairing.pairLookupDraft = "";
    ui.starred = []; ui.channelOrder = []; ui.mutedRooms = []; ui.channelDetails = []; ui.openRooms = {}; ui.ircConnection = null;
    ui.channels = []; ui.directs = []; ui.contacts = []; ui.agentProfiles = {}; ui.agentRequests = []; agentRefreshes.clear(); ui.accountIds = {}; clearRoomMembers(); members.reset(); document.body.classList.toggle("members-docked", false); ui.embeds = {};
    ui.messages = [];
    ui.composer = "";
    ui.consent = {};
    ui.reactions = {};
    ui.redactions = {};
    ui.unread = {}; applyUnreadChrome();
    actions.reset();
    ui.threadBusy = "";
    ui.pendingThread = null;
    ui.threadError = "";
    closeReplyThread();
    ui.sendEnabled = false;
    ui.sendOwner = false;
    ui.sendReason = "sending unavailable";
    ui.sendError = "";
    ui.draftNote = "";
    ui.capsNote = "";
    ui.error = "";
    editor.composerTall = false;
    ui.editingMessageId = "";
    ui.editServerId = "";
    ui.editConversationId = "";
    ui.editSavedText = "";
    ui.editSavedRevision = null;
    // A scope switch/teardown must not leave the media or Giphy UI stuck busy.
    ui.mediaBusy = false;
    mediaSender.cancelCompress();
    giphy.resetSearch();
    ui.mediaError = "";
    ui.media = null;
  }

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
    transcript.cancelConversationTransition();
    rs.stopped = true;
    renderEpoch += 1;
    pairing.clearPairRequest();
    try { await rs.outbox?.onDisconnected(); } catch { /* teardown still closes the sender */ }
    closeSocket();
    pairing.stop();
    rs.outbox?.stop();
    projection?.dispose();
    unread?.dispose(); unread = null; cancelMarkRead();
    const dead = rs.db;
    rs.db = null;
    rs.sync = null;
    rs.outbox = null;
    projection = null;
    rs.composer = null;
    rs.scope = null;
    rs.roomId = null;
    clearDraftFocus();
    rs.currentScope = "";
    rs.authenticatedAccountId = "";
    rs.composerTextByConversation.clear(); transcript.reset();
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

  // Completions (slash command, mention, help topic) replace the text and must leave the caret at
  // the end. Render now: left to the composer's x-effect, the re-render restores the old caret offset
  // ("/gi|phy ", "@remi|nd "), and this way it finds nothing to change.
  function replaceComposerText(text: string): void {
    ui.composer = text;
    if (!ui.pendingThread) rs.composer?.edit(text);
    editor.syncComposerEditor();
    editor.resizeComposer();
    const input = document.querySelector<HTMLElement>("#input");
    if (input) editor.focusComposerAtEnd(input);
    else editor.focusComposer();
  }

  function chooseCommand(command: SlashCommand): void {
    if (command.argument || ui.pendingThread) {
      replaceComposerText(slashSelection(command));
      return;
    }
    ui.composer = "";
    rs.composer?.edit("");
    void runSlash({ name: command.name, argument: "" });
  }

  function chooseCommandByName(name: string): void {
    const command = slashCommand(name);
    if (command) chooseCommand(command);
  }

  // Command and input feedback is an auto toast; connection and delivery errors stay in the banner.
  function hint(text: string): void {
    ui.note = text;
  }

  async function runSlash(input: { name: string; argument: string }): Promise<void> {
    switch (input.name) {
      case "help":
        openHelpDialog();
        return;
      case "reconnect":
        reconnect();
        return;
      case "leave":
        void logout();
        return;
      case "whois":
        if (!input.argument) { hint("Who should I look up? Try /whois nick."); return; }
        people.openWhois(input.argument.split(/\s+/)[0]!);
        return;
      case "giphy":
        if (!input.argument) { hint("Add a search term, like /giphy cats."); return; }
        await giphy.searchGiphy(input.argument);
        return;
      case "me":
        if (!input.argument) { hint("What should the action say? Try /me waves."); return; }
        if (!rs.roomId) { hint("Open a conversation first."); return; }
        try { await queueConversationText(rs.roomId, `\x01ACTION ${input.argument}\x01`); }
        catch (error) { ui.sendError = error instanceof Error ? error.message : "Could not send that action."; }
        return;
      case "msg":
        if (!input.argument) { hint("Who should I message? Try /msg nick hello."); return; }
        await runMsg(input.argument);
        return;
      case "invite": {
        const item = activeConversation();
        if (!item || item.kind !== "room" || isGroupRoom(item.wireTarget)) {
          hint("Open a channel to invite someone.");
          return;
        }
        const target = input.argument.trim().split(/\s+/)[0] ?? "";
        if (validSignInEmail(target)) { void addPrompts.offerEmail({ conversationId: item.conversationId, channel: item.wireTarget, email: target }); return; }
        if (!target) { hint("Who should I add? Try /invite @nick or /invite name@example.com."); return; }
        void addPrompts.offer({ conversationId: item.conversationId, channel: item.wireTarget, place: "channel", nick: target, announce: true });
        return;
      }
      case "kick":
        await runKick(input.argument);
        return;
      case "link": {
        const url = addressIn(input.argument);
        const target = rs.authorized.find((entry) => entry.kind === "room" && entry.wireTarget.toLowerCase() === ui.linksHome);
        if (!ui.linksHome || !ui.helpers.includes("links")) { hint(unknownCommandMessage(input.name)); return; }
        if (!url) { hint("Which link? Try /link https://example.com/article."); return; }
        if (!target) { hint(`Join ${ui.linksHome} to save links there.`); return; }
        try { await queueConversationText(target.conversationId, input.argument); ui.note = `Saved to ${ui.linksHome}.`; }
        catch (error) { ui.sendError = error instanceof Error ? error.message : "Could not save that link."; }
        return;
      }
      case "links": {
        if (!ui.linksHome || !ui.helpers.includes("links")) { hint(unknownCommandMessage(input.name)); return; }
        if (!rs.authorized.some((entry) => entry.kind === "room" && entry.wireTarget.toLowerCase() === ui.linksHome)) { hint(`Join ${ui.linksHome} to search links.`); return; }
        library.openWith(input.argument);
        openRoom(ui.linksHome);
        return;
      }
      case "threads":
        ui.threadCommandBusy = true;
        try { await runThreads(input.argument); }
        finally { ui.threadCommandBusy = false; }
        return;
      case "poll": {
        if (!ui.helpers.includes("poll")) { hint(unknownCommandMessage(input.name)); return; }
        // Bare `/poll` opens the dialog in a channel; elsewhere it explains where polls go.
        if (!input.argument) {
          if (polls.canCreate()) polls.openDialog(document.querySelector("#input"));
          else hint("Polls work in channels. Open one and try /poll again.");
          return;
        }
        // `/poll …` is the same as typing `@poll …`: it posts in the channel (a vote stays private), a
        // poll the helper would refuse opens the dialog, and the usual note offers to add @poll when
        // it isn't in the channel yet.
        ui.composer = `@poll ${input.argument}`;
        rs.composer?.edit(ui.composer);
        await send();
        return;
      }
      case "remind":
        if (!input.argument) { hint("When should I remind you? Try /remind in 20m stretch."); return; }
        await runRemind(input.argument);
        return;
      default:
        hint(unknownCommandMessage(input.name));
    }
  }

  // `/kick @nick [reason]`: the server checks admin rights, kicks on IRC, drops the invite exception
  // and the membership row. Then the channel gets an action line saying who was removed.
  async function runKick(argument: string): Promise<void> {
    if (!ui.isAdmin) { hint("Only admins can kick people from a channel."); return; }
    const item = activeConversation();
    if (!item || item.kind !== "room" || isGroupRoom(item.wireTarget)) { hint("Open a channel to kick someone."); return; }
    if (ui.openRooms[item.wireTarget] === true) { hint(`Everyone belongs to ${item.wireTarget}, so there's no one to kick.`); return; }
    const { nick, reason } = parseKick(argument);
    if (!nick) { hint("Who should I remove? Try /kick @nick reason."); return; }
    if (foldIdentifier(nick) === foldIdentifier(String(ui.account ?? ""))) { hint("You can't kick yourself."); return; }
    if (new TextEncoder().encode(reason).length > 200) { hint("Keep the reason under 200 characters."); return; }
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(item.wireTarget.replace(/^#/, ""))}/kick`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nick, reason }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        const error = typeof body.error === "string" ? body.error : "";
        hint(error === "member not found" ? `@${nick} isn't in ${item.wireTarget}.` : error === "invalid member" ? `Couldn't find @${nick}.` : error || "Could not kick that person.");
        return;
      }
    } catch {
      ui.sendError = "Could not reach the server to kick that person.";
      return;
    }
    if (rs.roomId === item.conversationId) loadRoomMembers(item, rs.roomId);
    try { await queueConversationText(item.conversationId, `\x01ACTION ${kickNotice(nick, item.wireTarget, reason)}\x01`); }
    catch { hint(`Removed ${nick} from ${item.wireTarget}.`); }
  }

  // Queue plain text to a captured conversation through the durable outbox. Used by the commands
  // and Giphy paths, which are not tied to the visible composer draft.
  async function queueConversationText(conversationId: string, text: string, options?: { replyTo?: string; broadcast?: boolean }): Promise<void> {
    if (!rs.outbox || !rs.scope) throw new Error("Messaging is not ready yet. Reconnect and try again.");
    const queued = queuedTextFor(conversationId, rs.scope.account, { text: emojiText(text, emoji.custom), revision: randomId() }, randomId(), Date.now(), undefined, undefined, options?.replyTo, options?.broadcast);
    await rs.outbox.enqueueText(queued);
  }

  // `/remind` sets the reminder through the app and shows remind's confirmation as a notice here.
  // The reminder itself fires in the remind DM, never in a channel. A list opens that DM instead.
  async function runRemind(argument: string, fireAt?: number): Promise<void> {
    try {
      const response = await fetch("/api/reminders", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Slirc-Remind": "1" },
        body: JSON.stringify({ text: argument, fireAt }),
      });
      const body = await response.json().catch(() => ({})) as { reply?: unknown; open?: unknown; error?: unknown };
      const result = response.ok ? remindResult(body) : null;
      const hasDirect = (nick: string) => ui.directs.some((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
      if (result && "open" in result) {
        if (!hasDirect(result.open)) await connect();
        await openDirect(result.open);
      } else if (result) {
        ui.note = result.note;
        // A first reminder opens the remind DM on the server; refresh the grant so it fires here live.
        if (!hasDirect("remind")) void connect();
      } else if (response.status === 400 && typeof body.error === "string") hint(body.error);
      else ui.sendError = typeof body.error === "string" ? body.error : "Could not set the reminder.";
    } catch {
      ui.sendError = "Could not reach the server to set the reminder.";
    }
  }

  async function runPollVote(channel: string, option: number): Promise<void> {
    try {
      const response = await fetch("/api/polls/vote", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Slirc-Poll": "1" },
        body: JSON.stringify({ channel, option }),
      });
      const body = await response.json().catch(() => ({})) as { reply?: unknown; error?: unknown };
      if (typeof body.reply === "string") hint(body.reply);
      else ui.sendError = typeof body.error === "string" ? body.error : "Could not count that vote.";
    } catch {
      ui.sendError = "Could not reach the server to count that vote.";
    }
  }

  // Absolute, so the link in a reminder also opens from an IRC client.
  function messageLink(message: Message, thread = false): string {
    const item = activeConversation();
    const wire = item?.wireTarget ?? "";
    const nick = item?.kind === "dm" ? (ui.directs.find((entry: any) => entry.channel === wire)?.nick ?? wire.replace(/^#dm-/, "")) : "";
    return new URL(threadSourceUrl(item?.kind === "dm" ? "dm" : "room", wire, nick, message.serverId ?? "", thread), location.origin).href;
  }

  // Copy link in the message menu. A message that starts a reply thread, or has its thread open, links to the thread.
  async function copyMessageLink(message: Message): Promise<void> {
    actions.closeActions();
    if (!message.serverId) return;
    const url = messageLink(message, !!replyThreadSummaryFor(message) || message.serverId === ui.replyThreadRootId);
    try { await navigator.clipboard.writeText(url); hint("Link copied"); }
    catch { hint("Could not copy the link."); }
  }

  async function runThreads(reply: string): Promise<void> {
    const item = activeConversation();
    const parent = currentParentWire();
    if (!item || item.kind === "thread" || !parent) {
      ui.threadError = "Open a room or DM to start a thread.";
      return;
    }
    const root = [...transcript.displayedMessages()].reverse().find((message: Message) => message.state === "confirmed" && message.serverId);
    if (!root) {
      ui.threadError = "Send a message first to start a thread.";
      return;
    }
    await openThreadForMessage(root);
    if (!reply.trim()) return;
    const thread = threadForRoot(ui.threads, parent, root.serverId);
    const conversation = thread && rs.authorized.find((entry) => entry.conversationId === thread.conversationId);
    if (conversation) {
      try { await queueConversationText(conversation.conversationId, reply.trim()); }
      catch { ui.sendError = "Could not save that thread reply. It is still in your box."; }
      return;
    }
    if (root.serverId && rs.roomId) {
      try { await queueConversationText(rs.roomId, reply.trim(), { replyTo: root.serverId }); }
      catch { ui.sendError = "Could not save that thread reply. It is still in your box."; }
    }
  }

  async function runMsg(argument: string): Promise<void> {
    const [rawNick, ...rest] = argument.split(/\s+/);
    const nick = (rawNick ?? "").replace(/^@/, "");
    const text = rest.join(" ").trim();
    if (!nick) { hint("Who should I message?"); return; }
    let direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
    if (!direct) {
      const contact = ui.contacts.some((item: string) => foldIdentifier(item) === foldIdentifier(nick));
      if (!contact) { hint(`No contact named @${nick}.`); return; }
      await openDirect(nick);
      if (!ui.authenticated) return;
      direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
    }
    if (!direct) { ui.sendError = `Could not open a direct message with @${nick}.`; return; }
    if (!text) return;
    const conversation = rs.authorized.find((item) => item.kind === "dm" && item.wireTarget === direct.channel);
    if (!conversation) { ui.sendError = `@${nick} is not reachable right now.`; return; }
    ui.sendError = "";
    try {
      await queueConversationText(conversation.conversationId, text);
      rs.navIntent += 1;
      nav.open({ kind: "dm", nick: direct.nick });
    } catch {
      ui.sendError = "Could not save that message. It is still in your box.";
    }
  }

  function reconnect(): void {
    if (rs.stopped || rs.signingOut || rs.suspended) return;
    ui.note = "Reconnecting…";
    reconnectDelay = RECONNECT_FIRST_MS;
    closeSocket();
    void connect();
  }

  // Pull-to-refresh (pull-refresh.ts). A socket can look open after the phone slept while the
  // server has long gone, so a PING round trip is what proves the link; without an answer, reconnect
  // (which re-syncs every conversation). With one, page anything newer for the open conversation.
  // Unread counts follow from the live stream the round trip just proved.
  const pongWaiters = new Map<string, () => void>();
  let pingSeq = 0;
  function notePong(line: string): void {
    if (!pongWaiters.size || !/^(?:@\S+ )?(?::\S+ )?PONG /.test(line)) return;
    const token = line.trimEnd().split(" ").at(-1)?.replace(/^:/, "") ?? "";
    pongWaiters.get(token)?.();
  }
  function pingServer(ms: number): Promise<boolean> {
    if (rs.socket?.readyState !== WebSocket.OPEN || !rs.sync?.isAuthenticated()) return Promise.resolve(false);
    const token = `slirc-pull-${++pingSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pongWaiters.delete(token); resolve(false); }, ms);
      pongWaiters.set(token, () => { clearTimeout(timer); pongWaiters.delete(token); resolve(true); });
      if (!wireSend(`PING ${token}`)) { clearTimeout(timer); pongWaiters.delete(token); resolve(false); }
    });
  }
  async function waitLive(ms: number, conversation: string | null): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (rs.stopped || rs.signingOut) return false;
      if (ui.phase === "live" && rs.socket?.readyState === WebSocket.OPEN && rs.sync?.isAuthenticated() && (!conversation || rs.sync.isReady(conversation))) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }
  async function pullRefresh(): Promise<"current" | "offline" | "failed"> {
    if (rs.stopped || rs.signingOut || rs.suspended || !ui.authenticated) return "failed";
    if (navigator.onLine === false) return "offline";
    const open = ui.mobileNav === null && rs.roomId && rs.authorized.some((item) => item.conversationId === rs.roomId) ? rs.roomId : null;
    if (!(await pingServer(4_000))) {
      reconnect();
      if (await waitLive(10_000, open)) return "current";
      return navigator.onLine === false ? "offline" : "failed";
    }
    if (!open || !rs.sync) return "current";
    const caught = await Promise.race([rs.sync.catchUp([open]), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000))]);
    return caught ? "current" : "failed";
  }

  // --- Lightbox ------------------------------------------------------------------------------

  function editingMedia(): InlineMedia[] {
    if (!ui.editingMessageId) return [];
    return ui.editAttachments.flatMap((line: string) => mediaView.messageMedia(line));
  }

  function removeEditingMedia(media: InlineMedia): void {
    if (!ui.editingMessageId) return;
    const next = removeInlineMedia(ui.editAttachments.join("\n"), media.href, instance);
    ui.editAttachments = next ? next.split("\n") : [];
  }

  // --- Delete (native REDACT) -----------------------------------------------------------------

  function redactFor(message: Message): { state: string; operationId: string } | null {
    return message.serverId ? ui.redactions[message.serverId] ?? null : null;
  }

  function redactLabel(message: Message): string {
    const entry = redactFor(message);
    if (!entry) return "";
    return entry.state === "queued" ? "deleting…" : entry.state === "sending" ? "deleting…" : entry.state === "uncertain" ? "delete uncertain" : "delete failed";
  }

  // Keyboard navigation inside the message menu. Handled keys stop propagation so the row's
  // ArrowUp/Down/Escape/e/t handlers cannot steal them; Tab is left to the browser so focus can
  // enter and leave the menu.
  function redactOperation(message: Message, reason: string): Operation {
    return {
      id: randomId(), messageId: "", conversationId: message.conversationId, kind: "redact", text: "",
      redactId: message.serverId, reason, state: "queued", createdAt: Date.now(),
    };
  }
  async function confirmDelete(message: Message | undefined): Promise<void> {
    if (message?.conversationId === NOTES_CONVERSATION_ID) {
      try { await notes.remove(message.serverId!); } catch (error) { ui.sendError = error instanceof Error ? error.message : "Could not delete the note."; }
      return;
    }
    if (!message || !rs.outbox || !rs.scope) return;
    // Frozen ownership/target checks; the row itself stays until the server REDACT lands.
    if (!canDelete(message) || !rs.authorized.some((entry) => entry.conversationId === message.conversationId)) {
      hint("That message can no longer be deleted.");
      return;
    }
    const operation: Operation = { ...redactOperation(message, isOwn(message) ? "deleted by author" : "deleted by admin"), kind: deleteKind(message) };
    try {
      await rs.outbox.enqueueRedact(operation);
    } catch {
      ui.sendError = "Could not queue the delete. The message is still here.";
    }
  }

  async function retryRedact(message: Message): Promise<void> {
    const entry = redactFor(message);
    if (!entry || !rs.outbox || !rs.scope || !canDelete(message)) return;
    try {
      if (entry.state === "uncertain") {
        await rs.outbox.resendUncertain(entry.operationId, { duplicateRiskAccepted: true });
      } else if (entry.state === "failed") {
        const previous = rs.db ? await rs.db.operations.get(entry.operationId) : undefined;
        // Someone else's message retries through the server's moderation route, which also covers an
        // admin whose IRC operator grant has not landed yet.
        const operation: Operation = { ...redactOperation(message, previous?.reason ?? "deleted by author"), kind: isOwn(message) ? "redact" : "admin-redact" };
        await rs.outbox.enqueueRedact(operation);
      }
    } catch {
      ui.sendError = "Could not retry the delete.";
    }
  }

  // --- Thread deletion -----------------------------------------------------------------------

  // A deleted thread leaves this client: its grant and conversation go, and an open view returns
  // to the parent. Runs for the person deleting and, through the KICK, for everyone else.
  function forgetThread(thread: ThreadGrant): void {
    const id = thread.conversationId;
    if (!ui.threads.some((item: ThreadGrant) => item.conversationId === id)) return;
    ui.threads = ui.threads.filter((item: ThreadGrant) => item.conversationId !== id);
    rs.authorized = rs.authorized.filter((item) => item.conversationId !== id);
    rs.directories.delete(id);
    rs.sync?.ensure(rs.authorized);
    if (rs.roomId !== id) return;
    const direct = ui.directs.find((entry: any) => foldIdentifier(entry.channel) === foldIdentifier(thread.parent));
    rs.navIntent += 1;
    nav.open(direct ? { kind: "dm", nick: direct.nick } : { kind: "room", room: thread.parent });
  }

  // --- Message editing -----------------------------------------------------------------------

  function isOwn(message: Message | null | undefined): boolean {
    return canEditMessage(message, ui.account);
  }

  // Helpers and updates post from bot accounts everywhere; a managed bot shows as a bot member row.
  // Agents are members of kind "agent", so they never match.
  const editableBotNicks: readonly string[] = [...HELPER_NICKS, UPDATES_NICK];
  function isEditableBot(nick: string): boolean {
    return editableBotNicks.includes(foldIdentifier(nick)) || isBotRow(ui.roomMemberRows, nick);
  }

  function isBotEdit(message: Message | null | undefined): boolean {
    return !isOwn(message) && canAdminEditBotMessage(message, !!ui.isAdmin, isEditableBot);
  }

  function canEdit(message: Message | null | undefined): boolean {
    return isOwn(message) || isBotEdit(message);
  }

  function canDelete(message: Message | null | undefined): boolean {
    return canDeleteMessage(message, ui.account, !!ui.isAdmin);
  }

  // The author deletes over IRC. So does an admin where they are a channel operator; elsewhere an
  // admin's delete goes through the server's moderation route.
  function deleteKind(message: Message): "redact" | "admin-redact" {
    if (isOwn(message)) return "redact";
    const conversation = rs.authorized.find((entry) => entry.conversationId === message.conversationId);
    return adminDeletesOverIrc(conversation, ui.threads) ? "redact" : "admin-redact";
  }

  // Quote uses the IRC-readable `> nick: text` shape, preserves the existing draft, and focuses
  // the composer. The resulting multiline text sends through the validated durable path.
  function quoteMessage(message: Message): void {
    if (ui.editingMessageId) return;
    const line = (message.text || "").split("\n")[0]!.slice(0, 140);
    const quote = `> ${message.authorNick}: ${line}\n`;
    const current = String(ui.composer ?? "");
    const next = current.startsWith(quote) ? current : quote + current;
    ui.composer = next;
    if (rs.roomId) rs.composerTextByConversation.set(rs.roomId, next);
    rs.composer?.edit(next);
    editor.resizeComposer();
    editor.focusComposer();
  }

  function startEdit(message: Message): void {
    if (!canEdit(message) || !message.serverId) return;
    if (ui.editingMessageId && ui.editServerId !== message.serverId) cancelEdit();
    // Freeze the target and remember the draft this edit replaces so Escape can put it back.
    ui.editSavedText = String(ui.composer ?? "");
    ui.editSavedRevision = rs.composer?.revision ?? null;
    const split = splitInlineMedia(message.text, instance);
    ui.editAttachments = split.attachments;
    ui.editingMessageId = message.id;
    ui.editServerId = message.serverId;
    ui.editConversationId = message.conversationId;
    ui.sendError = "";
    actions.actionMessageId = "";
    ui.composer = split.text;
    editor.resizeComposer();
    editor.focusComposer();
  }

  function endEdit(restoreSaved: boolean): void {
    if (restoreSaved) {
      ui.composer = ui.editSavedText;
      if (rs.composer) { rs.composer.text = ui.editSavedText; rs.composer.revision = ui.editSavedRevision; }
    }
    ui.editingMessageId = "";
    ui.editAttachments = [];
    ui.editServerId = "";
    ui.editConversationId = "";
    ui.editSavedRevision = null;
    ui.sendError = "";
    editor.resizeComposer();
  }

  function cancelEdit(): void {
    if (!ui.editingMessageId) return;
    endEdit(true);
  }

  async function saveEdit(): Promise<boolean> {
    if (ui.editConversationId === NOTES_CONVERSATION_ID) return saveNoteEdit();
    if (!rs.outbox || !rs.scope || !rs.db) return false;
    const targetId = ui.editConversationId;
    const targetServerId = ui.editServerId;
    const targetAccount = rs.scope.account;
    const targetScopeKey = rs.currentScope;
    const targetDb = rs.db;
    const targetOutbox = rs.outbox;
    if (!targetId || !targetServerId) return false;
    ui.composer = closeUnclosedCodeFence(String(ui.composer ?? ""));
    const body = String(ui.composer).trim();
    const text = emojiText([...(body ? [body] : []), ...ui.editAttachments].join("\n"), emoji.custom);
    const check = validateMultiline(text.split("\n"));
    if (!check.ok) { hint(check.error ?? "Cannot save that edit."); return false; }
    // Re-check against the live projection: the message may have been deleted, replaced, or the
    // room/account may have changed while the user typed.
    const message = ui.messages.find((item: Message) => item.serverId === targetServerId);
    const asBot = !!message && isBotEdit(message);
    if (!rs.directories.has(targetId) || !message || !(canEditMessage(message, targetAccount) || asBot)) {
      hint("That message can no longer be edited.");
      return false;
    }
    ui.sendError = "";
    if (asBot) return saveBotEdit(message, text);
    const queued = queuedTextFor(targetId, targetAccount, { text, revision: randomId() }, randomId(), Date.now(), undefined, targetServerId);
    try {
      await targetOutbox.enqueueText(queued);
    } catch {
      // Durable commit failed: keep the edit text and editing state so it is not silently lost.
      ui.sendError = "Could not save the edit. Your text is still here.";
      return false;
    }
    if (rs.db !== targetDb || rs.currentScope !== targetScopeKey || rs.scope?.account !== targetAccount) return false;
    // Restore the pre-edit draft so saving an edit never discards it.
    endEdit(true);
    editor.resizeComposer();
    transcript.scrollToBottom(true);
    return true;
  }

  // An admin's edit of a bot message goes out from the bot's account on the server. The replacement
  // and the original's REDACT then reach every client over IRC like any other edit.
  async function saveBotEdit(message: Message, text: string): Promise<boolean> {
    const conversation = rs.authorized.find((entry) => entry.conversationId === message.conversationId);
    if (!rs.scope || !conversation) { hint("That message can no longer be edited."); return false; }
    try {
      const response = await fetch("/api/messages/bot-edit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Slirc-Edit": "1" },
        body: JSON.stringify({ channel: conversation.wireTarget, msgid: message.serverId, bot: message.authorAccount || message.authorNick, text, accountId: rs.scope.accountId }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: unknown; error?: unknown };
      if (!response.ok || body.ok !== true) {
        ui.sendError = `Could not save the edit${typeof body.error === "string" ? `: ${body.error}` : ""}. Your text is still here.`;
        return false;
      }
    } catch {
      ui.sendError = "Could not save the edit. Your text is still here.";
      return false;
    }
    endEdit(true);
    editor.resizeComposer();
    return true;
  }

  // A note edit replaces the text in place; the pre-edit draft comes back, as with messages.
  async function saveNoteEdit(): Promise<boolean> {
    const id = ui.editServerId;
    const text = closeUnclosedCodeFence(String(ui.composer ?? "")).trim();
    if (!id || !text) return false;
    ui.sendError = "";
    try { await notes.save(id, text); } catch (error) {
      ui.sendError = error instanceof Error ? error.message : "Could not save the edit. Your text is still here.";
      return false;
    }
    if (ui.editServerId !== id) return true;
    endEdit(true);
    return true;
  }

  // A note never reaches IRC: no outbox, and the only slash command is /giphy, whose pick is saved
  // as a note. Any other slash text is kept as written. The draft clears only once saved.
  async function sendNote(): Promise<void> {
    const targetComposer = rs.composer;
    const targetDb = rs.db;
    if (!targetComposer || (!String(ui.composer ?? "").trim() && !ui.media)) return;
    const slash = ui.media ? null : parseSlash(String(ui.composer ?? ""));
    if (slash?.name === "giphy") {
      ui.composer = "";
      targetComposer.edit("");
      editor.resizeComposer();
      await runSlash(slash);
      return;
    }
    ui.sendError = "";
    // Staged photos upload with the save and join the body as URL lines, as a photo message does.
    const store = (text: string) => mediaSender.saveNote(async (urls) => { await notes.add([text, ...urls].filter(Boolean).join("\n")); });
    const saving = targetComposer.snapshot()
      ? targetComposer.commit(async (snapshot) => {
        await store(closeUnclosedCodeFence(snapshot.text).trim());
        // Only the revision this note was built from may be cleared; a newer edit survives.
        const draft = await targetDb?.drafts.get(NOTES_CONVERSATION_ID).catch(() => undefined);
        if (draft?.revision === snapshot.revision) await targetDb?.drafts.delete(NOTES_CONVERSATION_ID).catch(() => {});
      })
      : store("").then(() => true);
    const saved = await saving.catch((error) => {
      if (ui.notesOpen) ui.sendError = error instanceof Error ? error.message : "Could not save the note. It stays in the box.";
      return false;
    });
    if (!saved || rs.composer !== targetComposer) return;
    ui.composer = targetComposer.text;
    rs.composerTextByConversation.set(NOTES_CONVERSATION_ID, targetComposer.text);
    ui.draftNote = "";
    editor.resizeComposer();
    transcript.scrollToBottom(true);
  }

  async function send(): Promise<void> {
    if (ui.threadCommandBusy) return;
    // A thread still being created holds the reply; it sends from the thread once the server answers.
    if (ui.pendingThread) { if (String(ui.composer ?? "").trim()) ui.pendingThread.sendOnReady = true; return; }
    typing.stopTyping();
    // An active edit saves the replacement; it is never routed as a new message or a slash command.
    if (ui.editingMessageId) { await saveEdit(); return; }
    if (ui.notesOpen) { await sendNote(); return; }
    // Slash input never reaches the wire as literal text: a known command runs, an unknown one
    // reports locally.
    const slash = parseSlash(String(ui.composer ?? ""));
    if (slash) {
      // Running a command consumes the draft, exactly as pressing Enter on a message does.
      ui.composer = "";
      rs.composer?.edit("");
      editor.resizeComposer();
      await runSlash(slash);
      return;
    }
    // A message that starts with @remind is a private reminder, the same as /remind: it is not posted
    // in the conversation, and the confirmation shows as a notice.
    const remindAsk = /^@remind\b[\s,:]*([\s\S]*)$/i.exec(String(ui.composer ?? "").trim());
    if (remindAsk) {
      const request = remindAsk[1]!.trim();
      if (!request) { hint("When should I remind you? Try @remind in 20m stretch."); return; }
      ui.composer = "";
      rs.composer?.edit("");
      editor.resizeComposer();
      await runRemind(request);
      return;
    }
    // `@poll 2` is a vote. It goes to the server, not the channel, so only the voter sees the pick.
    const pollVote = /^@poll[\s,:]+#?(\d{1,2})\.?$/i.exec(String(ui.composer ?? "").trim());
    const voteRoom = activeConversation();
    if (pollVote && ui.helpers.includes("poll") && voteRoom?.kind === "room") {
      ui.composer = "";
      rs.composer?.edit("");
      editor.resizeComposer();
      await runPollVote(voteRoom.wireTarget, Number(pollVote[1]));
      return;
    }
    // A new poll the helper would refuse ("@poll lunch") is not sent: the New poll dialog opens with
    // what it said, at the first field to fix. Bare `@poll` opens it empty.
    const pollFix = ui.helpers.includes("poll") && polls.canCreate() ? pollPrefill(String(ui.composer ?? "")) : null;
    if (pollFix) {
      ui.composer = "";
      rs.composer?.edit("");
      editor.resizeComposer();
      polls.openDialog(document.querySelector("#input"), pollFix);
      return;
    }
    const draftText = String(ui.composer ?? "");
    const closedText = closeUnclosedCodeFence(draftText);
    if (closedText !== draftText) {
      ui.composer = closedText;
      rs.composer?.edit(closedText);
      if (rs.roomId) rs.composerTextByConversation.set(rs.roomId, closedText);
      if (rs.composer && rs.roomId) updateDraftNavigation({ conversationId: rs.roomId, revision: rs.composer.revision ?? "", text: closedText, updatedAt: Date.now() });
    }
    if (!rs.outbox || !rs.composer || !rs.roomId || !rs.scope) return;
    if (ui.media) { await sendMedia(); return; }
    const targetId = rs.roomId;
    const targetScope = rs.scope;
    const targetDb = rs.db;
    const targetScopeKey = rs.currentScope;
    const targetComposer = rs.composer;
    const targetOutbox = rs.outbox;
    const rawText = String(ui.composer ?? "");
    // A quote/caption is multiline; validate it as such so it reaches the durable multiline path
    // instead of failing the single-line control-character check.
    const wireText = emojiText(rawText, emoji.custom);
    const check = wireText.includes("\n") ? validateMultiline(wireText.split("\n")) : validateText(wireText);
    if (!check.ok) {
      hint(check.error ?? "Cannot send that.");
      return;
    }
    if (rawText.includes("\n") && !rs.bridge?.enabled.has("draft/multiline")) {
      hint("This server cannot send multiline messages.");
      return;
    }
    ui.sendError = "";
    let committedRevision = "";
    const messageId = randomId();
    const sent = await targetComposer.commit(async (snapshot) => {
      if (rs.stopped || rs.signingOut || rs.db !== targetDb || rs.scope !== targetScope || rs.currentScope !== targetScopeKey || !isLocallyEnqueueable(targetId)) throw new SendRefusedError("conversation is no longer authorized");
      committedRevision = snapshot.revision;
      const queued = queuedTextFor(targetId, targetScope.account, { ...snapshot, text: emojiText(snapshot.text, emoji.custom) }, messageId, Date.now());
      await targetOutbox.enqueueText(queued);
      await refreshDrafts(targetDb);
    }).catch(() => {
      if (rs.roomId === targetId && rs.db === targetDb && rs.scope === targetScope && rs.currentScope === targetScopeKey) ui.sendError = "Could not save your message. It stays in the box.";
      return false;
    });
    if (rs.db !== targetDb || rs.scope !== targetScope || rs.currentScope !== targetScopeKey) return;
    rs.composerTextByConversation.set(targetId, targetComposer.text);
    if (!sent) return;
    offerMentionPrompts(targetId, messageId, rawText);
    if (rs.roomId === targetId && rs.composer && rs.composer !== targetComposer && rs.composer.revision === committedRevision) {
      rs.composer.text = ""; rs.composer.revision = null; ui.composer = "";
    } else if (rs.composer === targetComposer && rs.roomId === targetId) {
      ui.composer = targetComposer.text;
    }
    if (rs.roomId === targetId) {
      rs.composerTextByConversation.set(targetId, rs.composer?.text ?? "");
      ui.draftNote = "";
      editor.resizeComposer();
      transcript.scrollToBottom(true);
    }
  }

  // A helper mentioned where it isn't a member gets an inline Add under the message. Its own DM is
  // where it already listens, so that never asks. A person gets the same note, in channels only.
  function offerMentionPrompts(conversationId: string, messageId: string, text: string): void {
    const item = rs.authorized.find((entry) => entry.conversationId === conversationId);
    if (!item) return;
    const peer = item.kind === "dm" ? ui.directs.find((direct: { channel: string }) => direct.channel === item.wireTarget)?.nick ?? "" : "";
    const place = item.kind === "dm" ? "dm" : item.kind === "thread" ? "thread" : isGroupRoom(item.wireTarget) ? "group" : "channel";
    const title = place === "group" ? ui.channelDetails.find((detail: { channel: string; topic?: string }) => detail.channel === item.wireTarget)?.topic : undefined;
    for (const nick of mentionedHelpers(text)) {
      // A helper this instance does not run never gets a note.
      if (foldIdentifier(peer) === nick || !ui.helpers.includes(nick)) continue;
      void addPrompts.offer({ conversationId, channel: item.wireTarget, place, title, nick, messageId, announce: false });
    }
    if (place !== "channel") return;
    for (const nick of mentionedPeople(text)) {
      void addPrompts.offer({ conversationId, channel: item.wireTarget, place, nick, messageId, announce: false, person: true });
    }
  }

  async function resend(operationId: string): Promise<void> {
    if (!rs.outbox || !ui.consent[operationId]) return;
    try {
      await rs.outbox.resendUncertain(operationId, { duplicateRiskAccepted: true });
    } catch (error) {
      ui.error = error instanceof Error ? error.message : "Could not resend.";
    }
  }

  async function cancel(operationId: string): Promise<void> {
    if (!rs.outbox) return;
    await rs.outbox.cancel(operationId).catch(() => {});
  }

  const transport: OutboxTransport = {
    sendText(operation: Operation): void {
      if (!rs.socket || rs.socket.readyState !== WebSocket.OPEN) throw new Error("socket not open");
      if (!rs.capsOk) throw new SendRefusedError("required IRC capabilities missing");
      const target = wireTargetForOperation(operation, rs.authorized);
      if (!target) throw new SendRefusedError("conversation is no longer authorized");
      // The tag carries the client correlation id; for multiline the batch id must ride every
      // constituent PRIVMSG (serializeOperation), or Ergo stores the lines as separate messages.
      for (const line of serializeOperation(operation, target, !!rs.bridge?.enabled.has("draft/multiline"))) {
        rs.socket.send(`${line}\r\n`);
      }
    },
    sendRedact(operation: Operation): void {
      if (!rs.socket || rs.socket.readyState !== WebSocket.OPEN) throw new Error("socket not open");
      if (!rs.capsOk) throw new SendRefusedError("required IRC capabilities missing");
      if (!rs.bridge?.enabled.has("draft/message-redaction")) throw new SendRefusedError("message redaction not supported by this server");
      if (!operation.redactId) throw new SendRefusedError("redact target missing");
      const target = wireTargetForOperation(operation, rs.authorized);
      if (!target) throw new SendRefusedError("conversation is no longer authorized");
      rs.socket.send(`@+slirc/cid=${operation.id} REDACT ${target} ${operation.redactId} :${operation.reason ?? ""}\r\n`);
    },
    async sendAdminRedact(operation: Operation): Promise<void> {
      if (!rs.scope) throw new SendRefusedError("no session");
      if (!operation.redactId) throw new SendRefusedError("redact target missing");
      const target = wireTargetForOperation(operation, rs.authorized);
      if (!target) throw new SendRefusedError("conversation is no longer authorized");
      // The server rechecks admin authority and only answers ok after the native REDACT ack.
      const response = await fetch("/api/messages/redact", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: target, msgid: operation.redactId, accountId: rs.scope.accountId, clientId: operation.id }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: unknown; gone?: unknown; error?: unknown };
      if (!response.ok || body.ok !== true) {
        throw new SendRefusedError(typeof body.error === "string" ? body.error : `Delete failed (${response.status})`);
      }
      // The server no longer has the message, so no REDACT echo will come: remove it here.
      if (body.gone === true && rs.db) {
        await rs.db.applyBatch({ conversationId: operation.conversationId, events: [{ type: "redaction", conversationId: operation.conversationId, serverId: operation.redactId }], complete: true });
      }
    },
  };

  function hooks() {
    return {
      onReady: (conversation: AuthorizedConversation) => {
        if (rs.stopped || rs.signingOut) return;
        ui.phase = "live";
        reconnectDelay = RECONNECT_FIRST_MS;
        ui.readyVersion += 1;
        // Only connection notes end here; a confirmation set just before a refresh stays.
        if (ui.note === "Reconnecting…") ui.note = "";
        connectionNotice.reset();
        void seedReadMarker(conversation);
        scheduleMarkRead();
        void rs.outbox?.notifyReady();
        void autoRefresh.check();
        // Readiness is the point at which a queued welcome DM can actually reach the wire.
        void drainWelcome();
        void welcome.load();
      },
      onRedactRefused: (msgid: string, reason: string) => {
        void rs.outbox?.rejectRedact(msgid, reason).catch(() => {});
      },
      onKicked: (conversation: AuthorizedConversation) => {
        if (rs.stopped || conversation.kind !== "thread") return;
        const thread = ui.threads.find((item: ThreadGrant) => item.conversationId === conversation.conversationId);
        if (thread) forgetThread(thread);
      },
      onUnready: () => {
        if (rs.stopped) return;
        ui.phase = "connecting";
        ui.readyVersion += 1;
      },
      onError: (_conversation: AuthorizedConversation | undefined, error: Error) => {
        if (!rs.stopped) ui.error = error.message;
      },
      onWhois: (message: IrcMessage) => {
        if (!rs.stopped) people.applyWhois(message);
      },
      onLive: (conversation: AuthorizedConversation, message: IrcMessage) => {
        if (rs.stopped || rs.signingOut) return;
        // Live only: history pages never reach this hook, so replay cannot invent typing state.
        if (message.command === "TAGMSG") typing.observeMessage(conversation.conversationId, message);
        else if (message.command === "PRIVMSG") typing.clear(conversation.conversationId, typingAccount(message));
        reminderNotice.observe(conversation, message);
      },
      onReadMarker: (conversation: AuthorizedConversation, timestamp: string) => {
        if (rs.stopped || rs.signingOut) return;
        rs.serverMarkers.set(conversation.conversationId, timestamp);
        void applyServerMarker(conversation, timestamp);
      },
    };
  }

  function wireSend(line: string): boolean {
    if (rs.socket?.readyState !== WebSocket.OPEN) return false;
    rs.socket.send(`${line}\r\n`);
    return true;
  }

  function registerBridge(nick: string): void {
    rs.bridge = new RelayBridge({
      nick,
      saslToken: saslToken(nick),
      send: (line) => {
        if (rs.socket?.readyState === WebSocket.OPEN) rs.socket.send(`${line}\r\n`);
      },
      push: (line) => { notePong(line); presence.feed(line); rs.sync?.push(line); },
      onCaps: (_enabled, missing) => {
        rs.capsOk = missing.length === 0;
        ui.capsNote = rs.capsOk ? "" : `Missing capabilities: ${missing.join(", ")}`;
      },
      onAuthFailed: (reason) => {
        ui.error = reason;
      },
    });
  }

  function scheduleReconnect(): void {
    if (rs.stopped || rs.suspended || rs.signingOut || reconnectTimer !== null) return;
    ui.phase = "connecting";
    const wait = reconnectDelay;
    reconnectDelay = Math.min(Math.max(reconnectDelay * 2, 2_000), 30_000);
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, wait) as unknown as number;
  }

  function openSocket(user: string): void {
    if (rs.socket) {
      const previous = rs.socket;
      rs.socket = null;
      previous.close();
    }
    presence.start(user);
    refreshPresence();
    rs.serverMarkers.clear();
    const early = earlySocket;
    earlySocket = null;
    if (early && early.readyState > WebSocket.OPEN) early.close();
    const ws = early && early.readyState <= WebSocket.OPEN ? early : new WebSocket(url);
    rs.socket = ws;
    registerBridge(user);
    ws.onopen = () => {
      if (rs.socket !== ws) return;
      rs.bridge?.onOpen();
    };
    if (ws.readyState === WebSocket.OPEN) rs.bridge?.onOpen();
    ws.onmessage = (event) => {
      if (rs.socket !== ws) return;
      rs.bridge?.feed(typeof event.data === "string" ? event.data : "");
    };
    ws.onclose = () => {
      if (rs.socket !== ws) return;
      rs.socket = null;
      typing.reset();
      clearRoomMembers();
      presence.disconnect();
      rs.sync?.onDisconnect();
      void rs.outbox?.onDisconnected();
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (rs.socket === ws && !rs.stopped && !rs.signingOut) connectionNotice.failed();
    };
  }

  function connect(): Promise<void> {
    return connecting = connectNow();
  }
  async function connectNow(): Promise<void> {
    if (rs.stopped || rs.suspended || rs.signingOut) return;
    const epoch = ++connectEpoch;
    const profileReadRevision = profile.revision();
    ui.phase = "connecting";
    if (!rs.socket && !earlySocket && signedInHint()) earlySocket = new WebSocket(url);
    let me: unknown;
    try {
      // Revalidate the session every reconnect, before the recovery list is published.
      me = await fetchJson("/auth/me");
    } catch {
      if (epoch !== connectEpoch || rs.stopped || rs.suspended || rs.signingOut) return;
      dropEarlySocket();
      connectionNotice.failed();
      releaseBoot(); // never a blank boot screen; the error itself waits out the grace period
      scheduleReconnect();
      return;
    }
    if (epoch !== connectEpoch || rs.stopped || rs.suspended || rs.signingOut) return;
    rs.authenticatedAccountId = typeof (me as { accountId?: unknown })?.accountId === "string" ? (me as { accountId: string }).accountId : "";
    reportTimeZone(rs.authenticatedAccountId);
    document.dispatchEvent(new CustomEvent("slirc:theme-account", {
      detail: { accountId: rs.authenticatedAccountId, theme: (me as { theme?: unknown })?.theme },
    }));
    const access = clientAccess(me, instance);
    signedInHint(access.ok);
    if (!access.ok) {
      transcript.cancelConversationTransition();
      renderEpoch += 1;
      transcript.reset();
      pairing.clearPairRequest();
      pairing.stop();
      closeSocket();
      void rs.outbox?.onDisconnected();
      rs.outbox?.stop();
      projection?.dispose();
      unread?.dispose(); unread = null; cancelMarkRead();
      rs.db?.close();
      rs.db = null; rs.sync = null; rs.outbox = null; projection = null; rs.composer = null; rs.scope = null; rs.roomId = null; rs.currentScope = "";
      rs.authorized = []; rs.directories.clear(); dmPeerIds.clear();
      rs.composerTextByConversation.clear(); transcript.reset();
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
        peek.signedOut(ui.signupOpen, openRoom);
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
    peek.stop();
    const key = scopeKey(access.scope);
    const changedAccount = key !== rs.currentScope;
    if (changedAccount) { people.reset(); channelDrag.reset(); rs.pendingDms.clear(); provisioning.clear(); iphoneApp.reset(); profile.resetProfile(); settings.reset(); channelCreate.reset(); newConversation.reset(); polls.reset(); jobCards.reset(); addPrompts.reset(); invitationsPage.reset(); admission.reset(); admissionFounder.reset(); irc.reset(); agents.reset(); adminStatus.reset(); branding.reset(); typing.reset(); reminderNotice.reset(); welcome.reset(); welcomeDraining = false; members.reset(); presence.reset(); clearRoomMembers(); ui.openRooms = {}; ui.ircConnection = null; ui.agentProfiles = {}; ui.agentRequests = []; agentRefreshes.clear(); }
    ui.authenticated = true;
    refreshWorkspaceChoices();
    pairing.clearPairRequest();
    ui.account = access.scope.account;
    ui.isAdmin = access.role === "admin";
    ui.isFounder = (me as any).isFounder === true;
    ui.hasPhone = (me as any).hasPhone === true;
    ui.phoneShortcutDismissed = phoneShortcutDismissed(rs.authenticatedAccountId);
    ui.greeting = (me as any).greeting !== false;
    ui.helpers = Array.isArray((me as any).helpers) ? (me as any).helpers.filter((nick: unknown): nick is string => typeof nick === "string") : [];
    ui.linksHome = typeof (me as any).linksHome === "string" ? (me as any).linksHome.toLowerCase() : "";
    ui.linksChannels = Array.isArray((me as any).linksChannels) ? (me as any).linksChannels.filter((name: unknown): name is string => typeof name === "string").map((name: string) => name.toLowerCase()) : [];
    library.sync();
    ui.greetingNoteSeen = (me as any).greetingNoteSeen !== false;
    ui.ircReset = { clients: (me as any).ircReset?.clients === true, bots: (me as any).ircReset?.bots === true };
    showIrcResetNotes();
    ui.me = profile.profileSaved.fullName || access.scope.account;
    // A read begun before/during a save cannot overwrite its newer successful result.
    if (changedAccount || (profileReadRevision === profile.revision() && !profile.profileSaving && !profile.badgeSaving)) profile.applyProfile((me as any).profile);
    // Thread rooms are trusted /auth/me rows, added as authorized conversations so reply reuses the
    // existing sender path. They stay out of the Channels list.
    rs.authorized = [
      ...access.conversations,
      ...access.threads.map((thread) => ({ conversationId: thread.conversationId, wireTarget: thread.channel, kind: "thread" as const })),
    ];
    rs.directories.clear(); dmPeerIds.clear();
    // A refreshed grant is authoritative: drop any typing state for a conversation it may have revoked.
    typing.clearAll();
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
    if (pendingInitialRoute && openChannelList.length) {
      const reparsed = parseRoute(pendingInitialRoute, instance, openChannelList);
      pendingInitialRoute = "";
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
    presence.setAvailability(Array.isArray((me as any).accountDetails) ? (me as any).accountDetails : []);
    ui.agentProfiles = mergeAgents(ui.agentProfiles, Array.isArray((me as any).accountDetails) ? (me as any).accountDetails : []);
    pairing.authorize(key);
    if (key !== rs.currentScope) await openScope(access);
    if (epoch !== connectEpoch || rs.stopped || rs.suspended || rs.signingOut) return;
    pairing.loadPending(key);
    void replyThreads.load();
    if (["settings", "profile"].includes(nav.$state.get().screen.kind)) settings.open();
    if (nav.$state.get().screen.kind === "irc") irc.open();
    if (nav.$state.get().screen.kind === "agents") agents.open();
    if (nav.$state.get().screen.kind === "admin") adminStatus.open();
    if (nav.$state.get().screen.kind === "invitations") invitationsPage.open();
    if (nav.$state.get().screen.kind === "invitations" && ui.isFounder) admissionFounder.open();
    rs.sync?.recover(rs.authorized);
    void notes.load();
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
    transcript.cancelConversationTransition();
    projection?.dispose();
    unread?.dispose(); unread = null; cancelMarkRead();
    renderEpoch += 1;
    transcript.reset();
    rs.composerTextByConversation.clear(); transcript.reset();
    ui.messages = []; ui.composer = ""; ui.direct = false; ui.drafts = [];
    // Account scope changed: staged photo bytes belong to the old scope's database.
    if (mediaView.lightbox) mediaView.closeLightbox();
    revokeMedia(ui.media); ui.media = null; ui.mediaError = "";
    ui.mediaBusy = false; mediaSender.cancelCompress();
    giphy.resetSearch(); ui.slashOpen = false;
    ui.mentionOpen = false;
    window.dispatchEvent(new CustomEvent("slirc:slash-reset"));
    window.dispatchEvent(new CustomEvent("slirc:mention-reset"));
    ui.editingMessageId = ""; ui.editAttachments = []; ui.editServerId = ""; ui.editConversationId = ""; ui.editSavedText = ""; ui.editSavedRevision = null;
    rs.outbox?.stop();
    rs.db?.close();
    painted = false;
    rs.scope = access.scope;
    rs.roomId = access.conversation.conversationId;
    clearDraftFocus();
    ui.currentConversationId = rs.roomId;
    rs.currentScope = scopeKey(access.scope);
    const accountDb = new ClientDatabase(access.scope);
    rs.db = accountDb;
    void restorePendingDirects(accountDb);
    mediaView.collapsedMedia = mediaView.loadCollapsedMedia(access.scope.accountId);
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
    projection = createConversationProjection(accountDb);
    projection.view.subscribe((view) => {
      if (rs.db !== accountDb || rs.stopped || view.conversationId !== rs.roomId) return;
      transcript.beforePaint(view);
      ui.messages = ui.notesOpen ? notesRows() : view.messages.filter((message) => message.authorNick !== "HistServ");
      greetingNote.consider(ui.messages);
      ui.reactions = view.reactions;
      ui.redactions = view.redactions;
      void transcript.loadEmbeds(transcript.displayedMessages());
      void mediaView.loadUploadDims(transcript.displayedMessages());
      if (view.error) ui.error = view.error;
      if (!view.loading) {
        paintNow();
        transcript.afterPaint(view, () => rs.db === accountDb && !rs.stopped && view.conversationId === rs.roomId);
      }
    });
    projection.select(rs.roomId);
    rs.serverMarkers.clear();
    unread = createUnreadProjection(accountDb, (message) => ui.greeting || !isDailyGreeting(message.authorAccount, message.text));
    unread.counts.subscribe((counts) => {
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

  // --- Founder welcome drain (client-driven) ------------------------------------------------
  // The server holds one job per newly verified human. This founder's own browser opens the real
  // DM and sends through the durable outbox. It may refresh the connection and reselect the
  // conversation behind Profile, but it never navigates to a route and never touches drafts. The
  // server claim is the cross-device mutex; the stable operation id refuses a duplicate local row
  // in the same browser.
  async function ensureWelcomeConversation(recipientNick: string, alive: () => boolean): Promise<string | null> {
    if (!alive()) return null;
    const find = () => {
      const direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(recipientNick));
      if (!direct) return null;
      const item = rs.authorized.find((entry) => entry.kind === "dm" && entry.wireTarget === direct.channel);
      return item?.conversationId ?? null;
    };
    const existing = find();
    if (existing) return existing;
    const direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(recipientNick));
    if (!direct) {
      const response = await fetch(`/api/dms/${encodeURIComponent(recipientNick)}`, { method: "POST", credentials: "same-origin" });
      if (!response.ok) return null;
    }
    // Refresh grants (and, for a new pair, join the DM) without navigating. The next drain pass
    // sees the authorized conversation; until then the claim is released for a safe retry.
    await connect();
    if (!alive()) return null;
    return find();
  }

  async function readWelcomeOperation(opId: string): Promise<WelcomeOperation | null> {
    if (!rs.db) return null;
    const operation = await rs.db.operations.get(opId);
    if (!operation) return null;
    const message = await rs.db.messages.get(operation.messageId);
    return { state: operation.state, serverId: message?.serverId ?? null };
  }

  async function waitWelcomeOutcome(opId: string, timeoutMs: number): Promise<WelcomeOutcome> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await readWelcomeOperation(opId);
      if (!current) return "timeout";
      if (current.state === "confirmed" || current.state === "failed" || current.state === "uncertain") return current;
      if (Date.now() >= deadline) return "timeout";
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  async function dropWelcomeOperation(opId: string): Promise<void> {
    const db = rs.db;
    if (!db) return;
    await db.transaction("rw", db.operations, db.messages, async () => {
      await db.operations.delete(opId);
      await db.messages.delete(opId);
    });
  }

  // The exact local record of the claim this browser owns. Keyed only by the server job id, whose
  // uniqueness comes from the one-per-recipient index.
  const welcomeClaimKey = (jobId: string) => `slirc2-fw-claim:${jobId}`;
  function readWelcomeClaim(jobId: string): string | null {
    try { return globalThis.localStorage?.getItem(welcomeClaimKey(jobId)) ?? null; } catch { return null; }
  }
  function rememberWelcomeClaim(jobId: string, claimId: string): void {
    try { globalThis.localStorage?.setItem(welcomeClaimKey(jobId), claimId); } catch { /* best effort */ }
  }
  function forgetWelcomeClaim(jobId: string): void {
    try { globalThis.localStorage?.removeItem(welcomeClaimKey(jobId)); } catch { /* best effort */ }
  }

  let welcomeDraining = false;
  async function drainWelcome(): Promise<void> {
    // Capture the starting account scope. Every closure refuses once the scope moves, so a drain
    // that outlives an account switch can never queue into the new account's database.
    if (welcomeDraining || !rs.outbox || !rs.scope || !rs.db || rs.stopped || rs.signingOut) return;
    const startDb = rs.db;
    const startScope = rs.scope;
    const startScopeKey = rs.currentScope;
    const alive = () => !rs.stopped && !rs.signingOut && rs.db === startDb && rs.scope === startScope && rs.currentScope === startScopeKey;
    welcomeDraining = true;
    const guard = <T>(run: () => Promise<T>): Promise<T> => {
      if (!alive()) return Promise.reject(new Error("account scope changed"));
      return run().then((value) => {
        if (!alive()) throw new Error("account scope changed");
        return value;
      });
    };
    try {
      await drainFounderWelcome({
        jobs: () => guard(async () => {
          const response = await fetch("/api/welcome/jobs", { cache: "no-store", credentials: "same-origin" });
          if (!response.ok) throw new Error(`welcome jobs failed (${response.status})`);
          const body = await response.json().catch(() => ({})) as { enabled?: unknown; jobs?: unknown };
          return { enabled: body.enabled === true, jobs: Array.isArray(body.jobs) ? body.jobs as WelcomeJob[] : [] } satisfies WelcomeFeed;
        }),
        claim: (jobId) => guard(async () => {
          const response = await fetch(`/api/welcome/jobs/${encodeURIComponent(jobId)}/claim`, { method: "POST", credentials: "same-origin" });
          if (response.status === 409) return null;
          if (!response.ok) throw new Error(`welcome claim failed (${response.status})`);
          const body = await response.json().catch(() => ({})) as { claimId?: unknown };
          return typeof body.claimId === "string" ? body.claimId : null;
        }),
        delivered: async (jobId, claimId, msgid) => {
          if (!alive()) throw new Error("account scope changed");
          const response = await fetch(`/api/welcome/jobs/${encodeURIComponent(jobId)}/delivered`, {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ claimId, msgid }),
          });
          if (!response.ok) throw new Error(`welcome delivered failed (${response.status})`);
        },
        release: async (jobId, claimId) => {
          if (!alive()) throw new Error("account scope changed");
          const response = await fetch(`/api/welcome/jobs/${encodeURIComponent(jobId)}/release`, {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ claimId }),
          });
          if (!response.ok) throw new Error(`welcome release failed (${response.status})`);
        },
        conversation: (nick) => guard(() => ensureWelcomeConversation(nick, alive)),
        readOperation: (opId) => guard(() => readWelcomeOperation(opId)),
        enqueue: async (conversationId, opId, text) => {
          if (!alive()) throw new Error("account scope changed");
          if (!rs.outbox || !rs.scope) throw new Error("sender not ready");
          // The revision is a send token, never a real draft: clearsDraft cannot match, so a
          // founder's open draft, selection or focus is untouched.
          const queued = queuedTextFor(conversationId, rs.scope.account, { text, revision: `welcome:${opId}` }, opId, Date.now());
          await rs.outbox.enqueueText(queued);
        },
        waitOutcome: (opId, timeoutMs) => guard(() => waitWelcomeOutcome(opId, timeoutMs)),
        drop: (opId) => guard(() => dropWelcomeOperation(opId)),
        readClaim: readWelcomeClaim,
        rememberClaim: rememberWelcomeClaim,
        forgetClaim: forgetWelcomeClaim,
        alive,
        owner: { nick: rs.scope?.account, name: ui.me },
      }, (message) => console.error("founder welcome:", message));
    } finally {
      welcomeDraining = false;
    }
  }

  function startSender(): void {
    if (!rs.db) return;
    const senderDb = rs.db;
    const senderScope = rs.currentScope;
    const scopedTransport: OutboxTransport = {
      sendText(operation): void {
        if (rs.db !== senderDb || rs.currentScope !== senderScope) throw new SendRefusedError("account scope changed");
        transport.sendText(operation);
      },
      sendRedact(operation): void {
        if (rs.db !== senderDb || rs.currentScope !== senderScope) throw new SendRefusedError("account scope changed");
        transport.sendRedact?.(operation);
      },
      sendAdminRedact(operation): Promise<void> {
        if (rs.db !== senderDb || rs.currentScope !== senderScope) throw new SendRefusedError("account scope changed");
        if (!transport.sendAdminRedact) throw new SendRefusedError("admin delete is not available");
        return Promise.resolve(transport.sendAdminRedact(operation));
      },
    };
    rs.outbox = createOutbox({
      db: senderDb,
      transport: scopedTransport,
      isReady: (id) => rs.sync?.isReady(id) ?? false,
      // Any tab may queue; only the lock owner sends. A queued op for a conversation this tab
      // never opened stalls here, so ask the page to discover and join it.
      onStalled: (conversationIds) => { void recoverQueuedTargets(conversationIds); },
    });
    // Do not await start(): a second tab may hold the sender lock, and waiting for acquisition
    // would stall the socket. Enqueueing is still allowed while this tab waits for the lock.
    void rs.outbox.start().then(applyOutboxStatus);
    applyOutboxStatus();
  }

  function applyOutboxStatus(): void {
    if (rs.stopped) return;
    const status = rs.outbox?.status();
    if (!status) return;
    // Sending is enabled for every tab: a follower commits durably and the lock owner transmits.
    ui.sendEnabled = status.sendingEnabled;
    ui.sendOwner = status.owner;
    ui.sendReason = status.sendingEnabled ? "" : (status.reason ?? "sending unavailable");
  }

  // The lock owner has queued work for a conversation it never opened (a new DM or thread a
  // follower created). Re-read the authoritative access list, adopt newly authorized
  // conversations into sync, and let the sender re-check. Never trust a DB row or BroadcastChannel
  // payload for a wire target, never rebuild the visible route, and never reconnect.
  let targetRefreshEpoch = 0;
  let targetRefreshing = false;
  let targetRefreshKey = "";
  let targetRefreshAt = 0;
  let targetRefreshBackoff = 2_000;
  async function recoverQueuedTargets(conversationIds: string[]): Promise<void> {
    if (rs.stopped || rs.suspended || rs.signingOut || !rs.outbox || !rs.sync || !rs.db || !rs.scope) return;
    const key = [...conversationIds].sort().join("|");
    if (targetRefreshing) return; // one refresh in flight; the next sweep re-signals any remaining target
    // A target the server keeps refusing must not turn every sweep into an endless /auth/me
    // loop: back off per unchanged target set, and reset as soon as the set changes.
    if (key === targetRefreshKey) {
      if (Date.now() - targetRefreshAt < targetRefreshBackoff) return;
      targetRefreshBackoff = Math.min(targetRefreshBackoff * 2, 30_000);
    } else {
      targetRefreshBackoff = 2_000;
    }
    const epoch = ++targetRefreshEpoch;
    const ownerScope = rs.currentScope;
    const ownerDb = rs.db;
    const ownerSync = rs.sync;
    const ownerOutbox = rs.outbox;
    targetRefreshing = true;
    targetRefreshKey = key;
    // Everything below must be re-checked after every await: identity, socket/scope epoch, and
    // lock ownership. Fetch directly so an explicit 401/403 can fail closed instead of being
    // treated as a transient error that leaves the old authorization in place.
    const current = (): boolean =>
      epoch === targetRefreshEpoch && !rs.stopped && !rs.suspended && !rs.signingOut &&
      rs.db === ownerDb && rs.sync === ownerSync && rs.outbox === ownerOutbox && rs.currentScope === ownerScope &&
      ownerOutbox.status().owner;
    try {
      let response: Response;
      try {
        response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
      } catch {
        return; // no answer: transient, the next sweep retries
      }
      if (!current()) return;
      if (response.status === 401 || response.status === 403) {
        // Session revoked/expired: fail closed rather than retrying with the old grants.
        ownerSync.ensure([]);
        return;
      }
      if (!response.ok) return;
      const me = await response.json().catch(() => null);
      if (!current()) return;
      const next = recoveryTargets(clientAccess(me, instance), ownerScope);
      if (!next) {
        // Denied, or the cookie moved to another account without this tab reconnecting. Never
        // adopt another scope's grants; unready so nothing queued reaches the wire.
        ownerSync.ensure([]);
        return;
      }
      rs.authorized = next;
      rs.directories.clear();
      for (const item of next) rs.directories.set(item.conversationId, item);
      ownerSync.ensure(next);
      void ownerOutbox.notifyReady();
    } catch {
      // Transient failure: the next sweep retries without disturbing the visible session.
    } finally {
      targetRefreshing = false;
      targetRefreshAt = Date.now();
    }
  }

  function closeSocket(): void {
    connectEpoch += 1;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = rs.socket;
    rs.socket = null;
    ws?.close();
    dropEarlySocket();
    typing.reset();
    clearRoomMembers();
    presence.disconnect();
    rs.sync?.onDisconnect();
  }

  // A frozen page must not retain the sender lock. Takeover recovers any interrupted write.
  function onPageHide(event: PageTransitionEvent): void {
    transcript.cancelConversationTransition();
    pairing.clearPairRequest();
    pairing.stop();
    closeSocket();
    void rs.outbox?.onDisconnected().catch(() => {});
    rs.outbox?.stop();
    connectionNotice.reset();
    if (event.persisted) {
      rs.suspended = true;
      return;
    }
    rs.stopped = true;
    projection?.dispose();
    unread?.dispose(); unread = null; cancelMarkRead();
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) signIn.restored();
    if (!event.persisted || !rs.suspended) return;
    rs.suspended = false;
    reconnectDelay = RECONNECT_FIRST_MS;
    startSender();
    void connect();
  }

  // Cmd+K on Apple keyboards, Ctrl+K elsewhere, from anywhere in the signed-in app. Another open
  // dialog keeps the keyboard; the palette's own shortcut toggles it closed.
  const applePlatform = isApplePlatform();
  window.addEventListener("keydown", (event) => {
    if (!isJumpShortcut(event, applePlatform) || !ui.authenticated) return;
    const open = document.querySelector("dialog[open]");
    if (open && open.id !== "jump-dialog") return;
    event.preventDefault();
    openJump();
  }, { signal: lifecycle.signal });
  window.addEventListener("keydown", (event) => {
    if (!isChannelSearchShortcut(event, applePlatform) || !canSearchChannel()) return;
    const open = document.querySelector("dialog[open]");
    if (open && open.id !== "channel-search-dialog") return;
    event.preventDefault();
    openChannelSearch();
  }, { signal: lifecycle.signal });
  window.addEventListener("slirc:channel-search-pick", (event) => {
    const detail = (event as CustomEvent<{ conversationId?: unknown; focusId?: unknown }>).detail;
    if (typeof detail?.conversationId !== "string" || typeof detail?.focusId !== "string") return;
    if (detail.conversationId !== rs.roomId) return;
    // Notes have no server ids to look up; every other hit takes the message-link path (replies open their thread).
    if (rs.roomId === NOTES_CONVERSATION_ID) transcript.focus(detail.focusId);
    else selectConversation(detail.conversationId, detail.focusId);
  }, { signal: lifecycle.signal });
  // Cmd+Option+O (Ctrl+Alt+O off Apple) opens the Workspaces dialog, also from the composer. The
  // Mac app's menu has the same key and calls SlircOpenWorkspaces, so there the page leaves it alone
  // and the dialog opens once.
  const macApp = inMacApp();
  window.addEventListener("keydown", (event) => {
    if (macApp || !isWorkspacesShortcut(event, applePlatform) || !ui.authenticated) return;
    event.preventDefault();
    const open = document.querySelector("dialog[open]");
    if (open || ui.workspaceDialog) return;
    ui.openWorkspaces();
  }, { signal: lifecycle.signal });
  window.addEventListener("slirc:jump-pick", (event) => {
    const row = (event as CustomEvent<{ row?: JumpRow }>).detail?.row;
    if (!row) return;
    if (row.kind === "channel" || row.kind === "group") openRoom(row.target);
    else void openDirect(row.target, true);
  }, { signal: lifecycle.signal });
  // Thread-picking is the one thing the dialog cannot do itself: the parent still owns routing.
  window.addEventListener("slirc:open-room", (event) => {
    const channel = (event as CustomEvent<{ channel?: unknown }>).detail?.channel;
    if (typeof channel === "string") openRoom(channel);
  }, { signal: lifecycle.signal });
  // Narrow coordination between the composer and the named panels. The panels own their selection,
  // the parent owns command definitions/dispatch and the durable Giphy send.
  window.addEventListener("slirc:slash-open", (event) => {
    ui.slashOpen = !!(event as CustomEvent<{ open?: unknown }>).detail?.open;
  }, { signal: lifecycle.signal });
  window.addEventListener("slirc:mention-open", (event) => {
    ui.mentionOpen = !!(event as CustomEvent<{ open?: unknown }>).detail?.open;
  }, { signal: lifecycle.signal });
  window.addEventListener("slirc:mention-pick", (event) => {
    const nick = (event as CustomEvent<{ nick?: unknown }>).detail?.nick;
    if (typeof nick !== "string" || !nick) return;
    const text = String(ui.composer ?? "");
    // An /invite pick fills in the command; Enter then runs it and shows the Add note.
    if (inviteToken(text) !== null) { replaceComposerText(`/invite @${nick} `); return; }
    const input = document.querySelector<HTMLElement>("#input");
    const caret = input ? editor.composerSelectionOffset(input) : text.length;
    const token = mentionToken(text, caret);
    if (!token) return;
    // Replace only the token at the caret, so text after it survives, and leave the caret after the nick.
    const after = text.slice(caret);
    const insert = "@" + nick + (after.startsWith(" ") ? "" : " ");
    const updated = text.slice(0, token.start) + insert + after;
    replaceComposerText(updated);
    if (input) editor.setComposerSelection(input, editor.displayOffsetAtSource(updated, token.start + insert.length));
    emoji.syncCaret();
  }, { signal: lifecycle.signal });
  window.addEventListener("slirc:help-pick", (event) => {
    const row = (event as CustomEvent<{ row?: HelpTopic }>).detail?.row;
    if (!row) return;
    if (row.url) { window.open(row.url, "_blank", "noopener,noreferrer"); return; }
    const insert = helpInsert(row);
    if (!insert) return;
    replaceComposerText(insert);
  }, { signal: lifecycle.signal });
  window.addEventListener("slirc:slash-run", (event) => {
    const name = (event as CustomEvent<{ name?: unknown }>).detail?.name;
    if (typeof name === "string") chooseCommandByName(name);
  }, { signal: lifecycle.signal });
  window.addEventListener("slirc:giphy-send", (event) => {
    void giphy.chooseGiphy((event as CustomEvent<{ preview?: unknown; url?: unknown; title?: unknown }>).detail as { preview: string; url: string; title: string });
  }, { signal: lifecycle.signal });

  // The rail and the dialog list the same rows: this workspace first, then the saved ones. A
  // browser keeps its own list; the Mac and iOS apps hand theirs over.
  function refreshWorkspaceChoices(): void {
    ui.workspaceChoices = workspaceRows(location.origin, [], ui.workspace);
    if (!canSwitchWorkspace()) { ui.workspaceChoices = workspaceRows(location.origin, savedWorkspaces(), ui.workspace); return; }
    void shellWorkspaces().then((saved) => { if (saved.length) ui.workspaceChoices = workspaceRows(location.origin, saved, ui.workspace); });
  }

  // A row in the workspace dialog. The app, or the browser, replaces this page with the workspace.
  function pickWorkspace(origin: string): void {
    if (origin === location.origin) { ui.workspaceDialog = false; return; }
    ui.workspaceBusy = true;
    const link = canSwitchWorkspace() ? undefined : workspaceLink(origin);
    void openWorkspace(origin, undefined, link).catch(() => {}).finally(() => { ui.workspaceBusy = false; ui.workspaceDialog = false; });
  }

  // Switch Workspace in the Mac app's menu opens the dialog while signed in, and its own picker otherwise.
  const hideWorkspaceDialog = exposeWorkspaceDialog(ui);
  lifecycle.signal.addEventListener("abort", hideWorkspaceDialog, { once: true });

  Object.assign(ui, {
    // Sidebar shortcut: straight to Devices with a code showing.
    addPhone(): void { openSettings(); void phoneOffer.show(); },
    dismissPhoneShortcut(): void { dismissPhoneShortcut(rs.authenticatedAccountId); ui.phoneShortcutDismissed = true; },
    dismissInstallBanner(): void { dismissInstallBanner(); ui.installBanner = false; },
    // The instance rail sits on the far left of the desktop layout, outside the channel sidebar.
    railVisible(): boolean { return ui.authenticated && ui.isDesktop; },
    // The shell loads its picker in place of this page; nothing here needs saving first.
    switchWorkspace(): void { void switchShellWorkspace().catch(() => {}); },
    // The workspace dialog: this workspace shows at once, the saved ones when they arrive.
    // An app build that can't list them opens its own picker, so no saved workspace looks lost.
    openWorkspaces(): void {
      if (!shellListsWorkspaces()) { void switchShellWorkspace().catch(() => {}); return; }
      Object.assign(ui, { workspaceAddress: "", workspaceError: "", workspaceBusy: false, workspaceDialog: true });
      refreshWorkspaceChoices();
    },
    closeWorkspaces(): void { if (!ui.workspaceBusy) ui.workspaceDialog = false; },
    pickWorkspace,
    workspaceCount(): number { return savedWorkspaceCount(ui.workspaceChoices); },
    workspaceFilter(): WorkspaceFilter { return filterWorkspaces(ui.workspaceChoices, ui.workspaceAddress); },
    animateListHeight,
    // Enter in the search field: the first match, or the typed address when nothing matches.
    openTypedWorkspace(): void {
      if (!String(ui.workspaceAddress).trim()) return;
      const { rows, open } = filterWorkspaces(ui.workspaceChoices, ui.workspaceAddress);
      if (!open) { if (rows[0]) pickWorkspace(rows[0].origin); return; }
      if (!open.origin) { ui.workspaceError = "That isn't a workspace address. Check the spelling."; return; }
      pickWorkspace(open.origin);
    },
    // The "Get the iPhone app" rows call this when they become visible, once per account.
    loadIphoneApp(account: string): void { void iphoneApp.load(account); },
    init(): void {
      installDialogKeys();
      const workspaceDialog = document.getElementById("workspace-dialog");
      const workspaceField = document.getElementById("workspace-address") as HTMLInputElement | null;
      if (workspaceDialog && workspaceField) installWorkspaceKeys(workspaceDialog, workspaceField);
      const connectingDim = createConnectingDim((on) => { document.body.classList.toggle("connecting-dim", on); });
      Alpine.effect(() => { connectingDim.set(ui.authenticated && ui.phase === "connecting"); });
      lifecycle.signal.addEventListener("abort", () => { connectingDim.set(false); });
      window.addEventListener("pagehide", onPageHide, { signal: lifecycle.signal });
      window.addEventListener("pageshow", onPageShow, { signal: lifecycle.signal });
      document.addEventListener("visibilitychange", scheduleMarkRead, { signal: lifecycle.signal });
      // A pairing code is a login while it lives and the scanner holds the camera: both end when the page hides.
      document.addEventListener("visibilitychange", () => { if (document.hidden) { phoneOffer.close(); scanner.hidden(); } }, { signal: lifecycle.signal });
      window.addEventListener("focus", scheduleMarkRead, { signal: lifecycle.signal });
      document.addEventListener("visibilitychange", () => autoRefresh.visibility(), { signal: lifecycle.signal });
      for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) document.addEventListener(name, () => autoRefresh.activity(), { signal: lifecycle.signal, capture: true, passive: true });
      if (!isDesktop && edgeSwipeWanted(window as never)) installEdgeSwipe(lifecycle.signal);
    },
    destroy(): void {
      openPopup();
      lifecycle.abort(); unsubscribeNav();
      phoneAnimation?.cancel(); phoneAnimation = null;
      rs.stopped = true; autoRefresh.stop(); closeSocket(); connectionNotice.reset(); rs.outbox?.stop(); projection?.dispose(); unread?.dispose(); unread = null; cancelMarkRead();
      pairing.stop(); phoneOffer.destroy(); scanner.destroy(); settings.destroy(); channelCreate.destroy(); newConversation.destroy(); addPrompts.destroy(); invitationsPage.destroy(); invitationAccept.destroy(); admission.destroy(); admissionFounder.destroy(); irc.destroy(); agents.destroy(); adminStatus.destroy(); branding.reset(); typing.destroy(); members.destroy(); channelDrag.reset(); document.body.classList.toggle("members-docked", false); transcript.reset();
    },
  });

  return { ui, transcript, peek, giphy, emoji, pairing, phoneOffer, scanner, signIn, profile, welcome, settings, channelCreate, newConversation, addPrompts, invitationsPage, bulkInvite, invitationAccept, admission, admissionFounder, irc, agents, adminStatus, typing, members, menus, channelDrag, channelPrefs, directDelete, people, mediaView, actions, editor, links,
    connect, onPageHide, onPageShow, openPopup, pullRefresh };
}
