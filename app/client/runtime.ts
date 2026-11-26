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
import { LINK_MISSING } from "@client/core/routing.ts";
import { createRuntimeState } from "@client/core/runtime-state.ts";
import { createRouting } from "@client/core/routing.ts";
import { createRoomMembers } from "@client/features/room-members.ts";
import { createConnection } from "@client/core/connection.ts";
import { createComposerSend } from "@client/features/composer-send.ts";
import { createOutboxSync } from "@client/core/outbox-sync.ts";
import { createWelcomeDrain } from "@client/features/welcome-drain.ts";
import { createSlashCommands } from "@client/features/slash-commands.ts";
import { createMessageEdit } from "@client/features/message-edit.ts";
import { createReplyThreadActions } from "@client/features/reply-thread-actions.ts";
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

  // Immutable account id from the latest /auth/me, kept even when access is denied for zero
  // conversations. The join acceptance compares this instead of the mutable scope key.
  let painted = false;
  const paintWaiters: Array<() => void> = [];
  // The latest connect run, so a live event can wait for it instead of superseding it mid-flight.
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
  const { replyThreadSummaryFor, replyThreadBroadcastParent, openReplyThread, showReplyThread, closeReplyThread, backFromReplyThread, activeReplyThreadRoot, activeReplyThreadReplies, replyThreadKeydown, sendReplyThread, abandonPendingThread } = createReplyThreadActions({ state: rs, ui, nextTick: (...args) => nextTick(...args), actions: () => actions, members: () => members, replyThreads: () => replyThreads, transcript: () => transcript, emoji: () => emoji, editor: () => editor, openDirect: (...args) => openDirect(...args), openRoom: (...args) => openRoom(...args), queueConversationText: (...args) => queueConversationText(...args) });
  const { redactFor, redactLabel, confirmDelete, retryRedact, forgetThread, canEdit, canDelete, quoteMessage, startEdit, cancelEdit, saveEdit, editingMedia, removeEditingMedia } = createMessageEdit({ state: rs, ui, instance, notes, nav, hint: (...args) => hint(...args), mediaView: () => mediaView, actions: () => actions, transcript: () => transcript, emoji: () => emoji, editor: () => editor });
  const { replaceComposerText, chooseCommand, chooseCommandByName, hint, runSlash, queueConversationText, runRemind, runPollVote, messageLink, copyMessageLink } = createSlashCommands({ state: rs, ui, nav, transcript: () => transcript, editor: () => editor, giphy: () => giphy, addPrompts: () => addPrompts, library: () => library, polls: () => polls, emoji: () => emoji, actions: () => actions, people: () => people, openHelpDialog: (...args) => openHelpDialog(...args), reconnect: (...args) => reconnect(...args), logout: (...args) => logout(...args), activeConversation: (...args) => activeConversation(...args), isGroupRoom: (...args) => isGroupRoom(...args), openRoom: (...args) => openRoom(...args), send: (...args) => send(...args), loadRoomMembers: (...args) => loadRoomMembers(...args), connect: (...args) => connect(...args), openDirect: (...args) => openDirect(...args), replyThreadSummaryFor: (...args) => replyThreadSummaryFor(...args), currentParentWire: (...args) => currentParentWire(...args), openThreadForMessage: (...args) => openThreadForMessage(...args) });
  const { drainWelcome, stopWelcomeDrain } = createWelcomeDrain({ state: rs, ui, connect: (...args) => connect(...args) });
  const { hooks, wireSend, startSender } = createOutboxSync({ state: rs, ui, instance, connectionNotice: () => connectionNotice, autoRefresh: () => autoRefresh, welcome: () => welcome, people: () => people, typing: () => typing, reminderNotice: () => reminderNotice, seedReadMarker: (...args) => seedReadMarker(...args), scheduleMarkRead: (...args) => scheduleMarkRead(...args), applyServerMarker: (...args) => applyServerMarker(...args), drainWelcome: (...args) => drainWelcome(...args), forgetThread: (...args) => forgetThread(...args), resetReconnectBackoff: (...args) => resetReconnectBackoff(...args) });
  const { canSend, send, resend, cancel } = createComposerSend({ state: rs, ui, mediaSender, notes, editor: () => editor, transcript: () => transcript, typing: () => typing, polls: () => polls, emoji: () => emoji, addPrompts: () => addPrompts, runSlash: (...args) => runSlash(...args), saveEdit: (...args) => saveEdit(...args), hint: (...args) => hint(...args), runRemind: (...args) => runRemind(...args), activeConversation: (...args) => activeConversation(...args), runPollVote: (...args) => runPollVote(...args), updateDraftNavigation: (...args) => updateDraftNavigation(...args), sendMedia: (...args) => sendMedia(...args), isLocallyEnqueueable: (...args) => isLocallyEnqueueable(...args), refreshDrafts: (...args) => refreshDrafts(...args), isGroupRoom: (...args) => isGroupRoom(...args) });
  const { signedInHint, preopenSocket, dropEarlySocket, reconnect, pullRefresh, resetReconnectBackoff, scheduleReconnect, openSocket, closeSocket } = createConnection({ state: rs, ui, url, presence: () => presence, typing: () => typing, connectionNotice: () => connectionNotice, connect: (...args) => connect(...args), wireSend: (...args) => wireSend(...args), refreshPresence: (...args) => refreshPresence(...args), clearRoomMembers: (...args) => clearRoomMembers(...args) });
  const { clearRoomMembers, loadRoomMembers, refreshPresence } = createRoomMembers({ state: rs, ui, members: () => members, presence: () => presence });
  const { cancelPhoneAnimation, applyNav, ownDm, openNotes, notesRows, showNotes, linkThread, selectConversation, channelDeleted, leaveRemovedAgent, openRoom, openHome, goBack, canGoBack, canGoForward, goForward, openDms, openMore, openProfile, openSettings, openChannels, openInvitations, openIrc, openAgents, openAdmin, toggleThreads, openThreadParent, activeConversation, currentParentWire, threadNest, isExpanded, pickChannel, openHelpDialog, toggleRooms } = createRouting({ state: rs, ui, isDesktop, nav, notes, transcript: () => transcript, mediaView: () => mediaView, typing: () => typing, actions: () => actions, menus: () => menus, links: () => links, reminderNotice: () => reminderNotice, giphy: () => giphy, editor: () => editor, openPopup: () => openPopup, welcome: () => welcome, pages: () => ({ settings, irc, agents, adminStatus, invitationsPage, admissionFounder, invitationAccept, admission, library }), nextTick: (...args) => nextTick(...args), hint: (...args) => hint(...args), dmPeerNick: (...args) => dmPeerNick(...args), pendingIdForNick: (...args) => pendingIdForNick(...args), openReplyThread: (...args) => openReplyThread(...args), clearDraftFocus: (...args) => clearDraftFocus(...args), abandonPendingThread: (...args) => abandonPendingThread(...args), closeReplyThread: (...args) => closeReplyThread(...args), cancelEdit: (...args) => cancelEdit(...args), focusLoadedDraft: (...args) => focusLoadedDraft(...args), draftWriter: (...args) => draftWriter(...args), loadRoomMembers: (...args) => loadRoomMembers(...args), restoreMediaDraft: (...args) => restoreMediaDraft(...args), revokeMedia: (...args) => revokeMedia(...args), maybeFocusComposer: (...args) => maybeFocusComposer(...args), scheduleMarkRead: (...args) => scheduleMarkRead(...args), connect: (...args) => connect(...args), applyChrome: (...args) => applyChrome(...args) });
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
      void rs.connecting.catch(() => {}).then(() => {
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

  const unsubscribeNav = nav.$state.subscribe(applyNav);
  applyNav(nav.$state.get());
  let pendingInitialRoute = "";
  {
    // A pairing link (/agents#connect=…) opens the Allow card on Agents, after sign-in if need be.
    const connectToken = stashConnectToken();
    const initialRoute = connectToken ? "/agents" : routeFromMount(location.pathname, location.hash, location.search);
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

  // A live event about an agent this tab has never heard of (a fresh pairing) refreshes /auth/me
  // once, so its DM and profile show up without a reload.
  const agentRefreshes = new Set<string>();
  function refreshForAgent(nick: string): void {
    const key = foldIdentifier(nick);
    if (isAgentNick(ui.agentProfiles, nick) || agentRefreshes.has(key)) return;
    agentRefreshes.add(key);
    void connect();
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
    iphoneApp.reset(); profile.resetProfile(); settings.reset(); channelCreate.reset(); newConversation.reset(); polls.reset(); jobCards.reset(); addPrompts.reset(); invitationsPage.reset(); bulkInvite.reset(); admission.reset(); admissionFounder.reset(); irc.reset(); agents.reset(); adminStatus.reset(); branding.reset(); typing.reset(); reminderNotice.reset(); welcome.reset(); stopWelcomeDrain();
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

  function connect(): Promise<void> {
    return rs.connecting = connectNow();
  }
  async function connectNow(): Promise<void> {
    if (rs.stopped || rs.suspended || rs.signingOut) return;
    const epoch = ++rs.connectEpoch;
    const profileReadRevision = profile.revision();
    ui.phase = "connecting";
    preopenSocket();
    let me: unknown;
    try {
      // Revalidate the session every reconnect, before the recovery list is published.
      me = await fetchJson("/auth/me");
    } catch {
      if (epoch !== rs.connectEpoch || rs.stopped || rs.suspended || rs.signingOut) return;
      dropEarlySocket();
      connectionNotice.failed();
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
      transcript.cancelConversationTransition();
      renderEpoch += 1;
      transcript.reset();
      pairing.clearPairRequest();
      pairing.stop();
      closeSocket();
      void rs.outbox?.onDisconnected();
      rs.outbox?.stop();
      rs.projection?.dispose();
      rs.unreadProjection?.dispose(); rs.unreadProjection = null; cancelMarkRead();
      rs.db?.close();
      rs.db = null; rs.sync = null; rs.outbox = null; rs.projection = null; rs.composer = null; rs.scope = null; rs.roomId = null; rs.currentScope = "";
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
    if (changedAccount) { people.reset(); channelDrag.reset(); rs.pendingDms.clear(); provisioning.clear(); iphoneApp.reset(); profile.resetProfile(); settings.reset(); channelCreate.reset(); newConversation.reset(); polls.reset(); jobCards.reset(); addPrompts.reset(); invitationsPage.reset(); admission.reset(); admissionFounder.reset(); irc.reset(); agents.reset(); adminStatus.reset(); branding.reset(); typing.reset(); reminderNotice.reset(); welcome.reset(); stopWelcomeDrain(); members.reset(); presence.reset(); clearRoomMembers(); ui.openRooms = {}; ui.ircConnection = null; ui.agentProfiles = {}; ui.agentRequests = []; agentRefreshes.clear(); }
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
    if (epoch !== rs.connectEpoch || rs.stopped || rs.suspended || rs.signingOut) return;
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
    rs.projection?.dispose();
    rs.unreadProjection?.dispose(); rs.unreadProjection = null; cancelMarkRead();
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
    rs.projection = createConversationProjection(accountDb);
    rs.projection.view.subscribe((view) => {
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
    rs.projection?.dispose();
    rs.unreadProjection?.dispose(); rs.unreadProjection = null; cancelMarkRead();
  }

  function onPageShow(event: PageTransitionEvent): void {
    if (event.persisted) signIn.restored();
    if (!event.persisted || !rs.suspended) return;
    rs.suspended = false;
    resetReconnectBackoff();
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
      cancelPhoneAnimation();
      rs.stopped = true; autoRefresh.stop(); closeSocket(); connectionNotice.reset(); rs.outbox?.stop(); rs.projection?.dispose(); rs.unreadProjection?.dispose(); rs.unreadProjection = null; cancelMarkRead();
      pairing.stop(); phoneOffer.destroy(); scanner.destroy(); settings.destroy(); channelCreate.destroy(); newConversation.destroy(); addPrompts.destroy(); invitationsPage.destroy(); invitationAccept.destroy(); admission.destroy(); admissionFounder.destroy(); irc.destroy(); agents.destroy(); adminStatus.destroy(); branding.reset(); typing.destroy(); members.destroy(); channelDrag.reset(); document.body.classList.toggle("members-docked", false); transcript.reset();
    },
  });

  return { ui, transcript, peek, giphy, emoji, pairing, phoneOffer, scanner, signIn, profile, welcome, settings, channelCreate, newConversation, addPrompts, invitationsPage, bulkInvite, invitationAccept, admission, admissionFounder, irc, agents, adminStatus, typing, members, menus, channelDrag, channelPrefs, directDelete, people, mediaView, actions, editor, links,
    connect, onPageHide, onPageShow, openPopup, pullRefresh };
}
