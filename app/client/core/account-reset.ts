import type { createPeopleCard } from "@client/people-card.ts";
import type { createChannelDrag } from "@client/channel-order.ts";
import type { createIphoneApp } from "@client/iphone-app.ts";
import type { createProfilePage } from "@client/profile-page.ts";
import type { createSettingsPage } from "@client/settings-page.ts";
import type { createChannelsPage } from "@client/channels-page.ts";
import type { createNewConversation } from "@client/new-conversation.ts";
import type { createPolls } from "@client/polls.ts";
import type { createJobCards } from "@client/job-cards.ts";
import type { createAddPrompts } from "@client/add-prompts.ts";
import type { createInvitationsPage } from "@client/invitations-page.ts";
import type { createAdmissionScreen, createAdmissionFounder } from "@client/admission.ts";
import type { createIrcPage } from "@client/irc-page.ts";
import type { createAgentsPage } from "@client/agents-page.ts";
import type { createAdminPage } from "@client/admin-page.ts";
import type { createWorkspaceIcon } from "@client/workspace-icon.ts";
import type { createTypingIndicators } from "@client/typing.ts";
import type { createReminderNotice } from "@client/reminder-notice.ts";
import type { createFounderWelcome } from "@client/founder-welcome.ts";
import type { createMembersPanel } from "@client/members-panel.ts";
import type { createPresence } from "@client/presence.ts";
import type { createBulkInvite } from "@client/bulk-invite.ts";
import type { createNotes } from "@client/notes.ts";
import type { createReplyThreadList } from "@client/reply-thread-list.ts";
import type { createMediaView } from "@client/media-view.ts";
import type { createConversationMenu } from "@client/conversation-menu.ts";
import type { createDirectDelete } from "@client/direct-delete.ts";
import type { createChannelSettings } from "@client/channel-settings.ts";
import type { createDevicePairing } from "@client/device-pairing.ts";
import type { createMessageActions } from "@client/message-actions.ts";
import type { createComposerEditor } from "@client/composer-editor.ts";
import type { createGiphyPicker } from "@client/giphy-picker.ts";
import type { createTranscript } from "@client/transcript.ts";
import type { createMediaSender } from "@client/media-send.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface AccountResetDeps {
  state: Pick<RuntimeState, "pendingDms">;
  ui: Pick<ClientState, "account" | "accountIds" | "activeThread" | "adminRoute" | "agentProfiles" | "agentRequests" | "agentsRoute" | "authenticated" | "capsNote" | "channelDetails" | "channelOrder" | "channels" | "channelsRoute" | "composer" | "consent" | "contacts" | "currentConversationId" | "directs" | "draftNote" | "drafts" | "editConversationId" | "editSavedRevision" | "editSavedText" | "editServerId" | "editingMessageId" | "embeds" | "error" | "greeting" | "greetingNoteSeen" | "hasPhone" | "invitationsRoute" | "ircConnection" | "ircRoute" | "isAdmin" | "isFounder" | "me" | "media" | "mediaBusy" | "mediaError" | "messages" | "mutedRooms" | "notesOpen" | "openRooms" | "pendingDm" | "pendingDmError" | "pendingDmState" | "pendingThread" | "profileRoute" | "reactions" | "redactions" | "sendEnabled" | "sendError" | "sendOwner" | "sendReason" | "settingsRoute" | "starred" | "threadBusy" | "threadError" | "threads" | "unread" | "workspaceChoices">;
  provisioning: Map<string, Promise<void>>;
  agentRefreshes: Set<string>;
  stopWelcomeDrain: () => void;
  clearRoomMembers: () => void;
  applyUnreadChrome: () => void;
  closeReplyThread: () => void;
  controllers: () => { people: ReturnType<typeof createPeopleCard>; channelDrag: ReturnType<typeof createChannelDrag>; iphoneApp: ReturnType<typeof createIphoneApp>; profile: ReturnType<typeof createProfilePage>; settings: ReturnType<typeof createSettingsPage>; channelCreate: ReturnType<typeof createChannelsPage>; newConversation: ReturnType<typeof createNewConversation>; polls: ReturnType<typeof createPolls>; jobCards: ReturnType<typeof createJobCards>; addPrompts: ReturnType<typeof createAddPrompts>; invitationsPage: ReturnType<typeof createInvitationsPage>; admission: ReturnType<typeof createAdmissionScreen>; admissionFounder: ReturnType<typeof createAdmissionFounder>; irc: ReturnType<typeof createIrcPage>; agents: ReturnType<typeof createAgentsPage>; adminStatus: ReturnType<typeof createAdminPage>; branding: ReturnType<typeof createWorkspaceIcon>; typing: ReturnType<typeof createTypingIndicators>; reminderNotice: ReturnType<typeof createReminderNotice>; welcome: ReturnType<typeof createFounderWelcome>; members: ReturnType<typeof createMembersPanel>; presence: ReturnType<typeof createPresence>; bulkInvite: ReturnType<typeof createBulkInvite>; notes: ReturnType<typeof createNotes>; replyThreads: ReturnType<typeof createReplyThreadList>; mediaView: ReturnType<typeof createMediaView>; menus: ReturnType<typeof createConversationMenu>; directDelete: ReturnType<typeof createDirectDelete>; channelPrefs: ReturnType<typeof createChannelSettings>; pairing: ReturnType<typeof createDevicePairing>; actions: ReturnType<typeof createMessageActions>; editor: ReturnType<typeof createComposerEditor>; giphy: ReturnType<typeof createGiphyPicker>; transcript: ReturnType<typeof createTranscript>; mediaSender: ReturnType<typeof createMediaSender> };
}

export function createAccountReset(deps: AccountResetDeps) {
  const { state: rs, ui, provisioning, agentRefreshes, stopWelcomeDrain, clearRoomMembers, applyUnreadChrome, closeReplyThread, controllers } = deps;

  // A different account signed in on this page: everything one account owned starts empty.
  function resetForAccountChange(): void {
    const c = controllers();
    c.people.reset();
    c.channelDrag.reset();
    rs.pendingDms.clear();
    provisioning.clear();
    c.iphoneApp.reset();
    c.profile.resetProfile();
    c.settings.reset();
    c.channelCreate.reset();
    c.newConversation.reset();
    c.polls.reset();
    c.jobCards.reset();
    c.addPrompts.reset();
    c.invitationsPage.reset();
    c.admission.reset();
    c.admissionFounder.reset();
    c.irc.reset();
    c.agents.reset();
    c.adminStatus.reset();
    c.branding.reset();
    c.typing.reset();
    c.reminderNotice.reset();
    c.welcome.reset();
    stopWelcomeDrain();
    c.members.reset();
    c.presence.reset();
    clearRoomMembers();
    ui.openRooms = {};
    ui.ircConnection = null;
    ui.agentProfiles = {};
    ui.agentRequests = [];
    agentRefreshes.clear();
  }

  function resetAccountUi(): void {
    const c = controllers();
    document.dispatchEvent(new CustomEvent("slirc:theme-account", { detail: { accountId: "" } }));
    c.transcript.cancelConversationTransition();
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
    c.iphoneApp.reset(); c.profile.resetProfile(); c.settings.reset(); c.channelCreate.reset(); c.newConversation.reset(); c.polls.reset(); c.jobCards.reset(); c.addPrompts.reset(); c.invitationsPage.reset(); c.bulkInvite.reset(); c.admission.reset(); c.admissionFounder.reset(); c.irc.reset(); c.agents.reset(); c.adminStatus.reset(); c.branding.reset(); c.typing.reset(); c.reminderNotice.reset(); c.welcome.reset(); stopWelcomeDrain();
    ui.me = "";
    ui.account = "";
    c.notes.reset(); c.replyThreads.reset(); ui.notesOpen = false;
    ui.currentConversationId = null;
    ui.drafts = [];
    ui.isAdmin = false;
    ui.isFounder = false;
    ui.hasPhone = false;
    ui.greeting = true;
    ui.greetingNoteSeen = true;
    ui.threads = [];
    ui.activeThread = null;
    c.mediaView.reset(); c.menus.close(); c.channelDrag.reset(); c.directDelete.reset(); c.people.reset(); c.presence.reset();
    c.channelPrefs.closeChannelSettings();
    c.pairing.pairLookupDraft = "";
    ui.starred = []; ui.channelOrder = []; ui.mutedRooms = []; ui.channelDetails = []; ui.openRooms = {}; ui.ircConnection = null;
    ui.channels = []; ui.directs = []; ui.contacts = []; ui.agentProfiles = {}; ui.agentRequests = []; agentRefreshes.clear(); ui.accountIds = {}; clearRoomMembers(); c.members.reset(); document.body.classList.toggle("members-docked", false); ui.embeds = {};
    ui.messages = [];
    ui.composer = "";
    ui.consent = {};
    ui.reactions = {};
    ui.redactions = {};
    ui.unread = {}; applyUnreadChrome();
    c.actions.reset();
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
    c.editor.composerTall = false;
    ui.editingMessageId = "";
    ui.editServerId = "";
    ui.editConversationId = "";
    ui.editSavedText = "";
    ui.editSavedRevision = null;
    // A scope switch/teardown must not leave the media or Giphy UI stuck busy.
    ui.mediaBusy = false;
    c.mediaSender.cancelCompress();
    c.giphy.resetSearch();
    ui.mediaError = "";
    ui.media = null;
  }

  return { resetForAccountChange, resetAccountUi };
}
