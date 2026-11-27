import { type AccountScope, type Draft, type Message } from "@client/model.ts";
import { type AuthorizedConversation } from "@client/sync.ts";
import { type ReactionMap } from "@client/store.ts";
import { type EmbedMeta } from "@client/embed.ts";
import { type StagedMedia } from "@client/media-send.ts";
import { type ThreadGrant } from "@client/access.ts";
import { type PendingThread } from "@client/threads.ts";
import { DEV_CHANNEL } from "@client/protocol.ts";
import { type StickyNote } from "@client/reminder-notice.ts";
import { type AgentProfiles } from "@client/agent-roster.ts";
import { type WorkspaceChoice, type WorkspaceMark } from "@client/workspace-mark.ts";
import { readRailExpanded } from "@client/workspace-list.ts";

// One channel-members row as returned by GET /api/channels/:channel/members. Presence is separate.
export interface ChannelMember {
  nick: string;
  kind: string;
  role: string;
  machine: string | null;
  availability: string;
  badge: string;
}

// Shared account and conversation projection. Feature-only state belongs to its component.
export function createClientState(isDesktop: boolean, coarse: boolean) {
  return {
    phase: "loading",
    // Id of the agent offline card whose command was just copied, for its check mark.
    copiedAgentCommand: "",
    authenticated: false,
    booting: true,
    isDesktop,
    roomsOpen: !coarse,
    mobileNav: null as "home" | "dms" | "more" | null,
    note: "",
    // A toast that waits for the person to act; separate from the timed `note`.
    stickies: [] as StickyNote[],
    error: "",
    me: "",
    account: "",
    isAdmin: false,
    // Router history position, mirrored for the header chevrons. Not a second navigation stack:
    // applyNav writes these straight from the router's own index/length.
    navIndex: -1,
    navLength: 0,
    profileRoute: false,
    notesOpen: false,
    settingsRoute: false,
    channelsRoute: false,
    invitationsRoute: false,
    isFounder: false,
    // Whether this account has a phone session; until then the sidebar offers "Add your phone".
    hasPhone: false,
    phoneShortcutDismissed: false,
    // Phone browser, not installed: Home shows a strip linking to /welcome (install-banner.ts).
    installBanner: false,
    // Inside the iOS shell and the Mac app, the profile and sign-in screens offer "Switch workspace" (native-shell.ts).
    canSwitchWorkspace: false,
    // The sidebar's workspace mark, from this page's host (workspace-mark.ts).
    workspace: { name: "", letter: "", color: "", logo: "" } as WorkspaceMark,
    // The workspace dialog, opened from the sidebar mark or the phone's More screen (workspace-mark.ts).
    workspaceDialog: false,
    workspaceChoices: [] as WorkspaceChoice[],
    // The instance rail folds all but a few workspaces; remembered per device (workspace-mark.ts railWorkspaces).
    railExpanded: readRailExpanded(),
    workspaceAddress: "",
    workspaceError: "",
    workspaceBusy: false,
    aboutLabel: "Slirc 2",
    // TestFlight link for "Get the iPhone app", loaded when More or desktop Devices opens (iphone-app.ts).
    iphoneAppUrl: "",
    // Helper nicks this instance runs, from /auth/me. /remind is offered only when remind runs.
    helpers: [] as string[],
    // The links library: its home channel and this member's channels that offer a Links view.
    linksHome: "",
    linksChannels: [] as string[],
    // Settings > G'day greeting, from /auth/me. Off hides the welcome helper's daily gif for this person.
    greeting: true,
    // The one-time note under the first greeting; true until /auth/me says otherwise, so it never flashes.
    greetingNoteSeen: true,
    // Notes from the derived IRC password migration: password clients or managed bots need the new one.
    ircReset: { clients: false, bots: false },
    joinRoute: false,
    joinToken: "",
    // Signed-out preview of #open-chat on the public playground (peek.ts). Set only
    // once the server returned messages; peekSignIn shows the sign-in card over it.
    peekRoom: "",
    peekSignIn: false,
    // A signed-out /open-chat read in flight: the sign-in card waits for it instead of flashing.
    peekPending: false,
    // The public playground signs up new addresses, so its sign-in form also asks a newcomer's name.
    signupOpen: false,
    admissionRoute: false,
    admissionToken: "",
    admissionSignIn: false,
    ircRoute: false,
    agentsRoute: false,
    adminRoute: false,
    channel: DEV_CHANNEL,
    direct: false,
    roomLabel: "",
    currentConversationId: null as string | null,
    activeThread: null as ThreadGrant | null,
    channels: [] as AuthorizedConversation[],
    threads: [] as ThreadGrant[],
    threadsOpen: false,
    threadParentOpen: "",
    collapsedThreadParents: [] as string[],
    draftsOpen: true,
    starredOpen: true,
    channelsOpen: true,
    dmsOpen: true,
    agentsOpen: true,
    peopleOpen: true,
    // Contacts start collapsed; the person opens them when they want the list.
    contactsOpen: false,
    starred: [] as string[],
    channelOrder: [] as string[],
    mutedRooms: [] as string[],
    channelDetails: [] as { channel: string; owner: string; visibility: string; topic: string; isGroup?: boolean; archived?: boolean }[],
    drafts: [] as (Draft & { label: string })[],
    reactions: {} as ReactionMap,
    // Unread rows per conversation id, from the unread projection. Absent means zero.
    unread: {} as Record<string, number>,
    redactions: {} as Record<string, { state: string; operationId: string }>,
    threadBusy: "",
    pendingThread: null as PendingThread | null,
    threadCommandBusy: false,
    threadError: "",
    // IRCv3 +reply thread panel: open on a root message's serverId inside the current channel/DM.
    replyThreadRootId: "",
    // Rows that have had their thread open, so only they carry the highlight's fade; other rows stay instant.
    replyThreadFaded: {} as Record<string, true>,
    replyThreadDraft: "",
    replyThreadBroadcast: false,
    replyThreadError: "",
    directs: [] as { nick: string; channel: string }[],
    contacts: [] as string[],
    // Known agent accounts by folded nick: harness, display name, repo, model and owner.
    agentProfiles: {} as AgentProfiles,
    agentRequests: [] as { channel: string; messageId: string; state: "Queued" | "Working" }[],
    accountIds: {} as Record<string, string>,
    avatarVersions: {} as Record<string, number>,
    embeds: {} as Record<string, EmbedMeta>,
    directBusy: "",
    // A first-contact DM the server has not authorized yet. Pending is local enqueue permission
    // only; `authorized`/`directories` still gate the wire, so no fake room is ever minted.
    pendingDm: false,
    pendingDmVersion: 0,
    pendingDmState: "" as "" | "provisioning" | "failed",
    pendingDmError: "",
    capsNote: "",
    // Bumped on every per-room readiness change. phase is one flag for all rooms, so the open room
    // turning ready while another already made phase "live" is a no-op write Alpine never sees.
    readyVersion: 0,
    sendEnabled: false,
    sendOwner: false,
    sendReason: "",
    sendError: "",
    draftNote: "",
    composer: "",
    editingMessageId: "",
    editAttachments: [] as string[],
    editServerId: "",
    editConversationId: "",
    editSavedText: "",
    editSavedRevision: null as string | null,
    // Coordination flag only: the slash component owns index/dismissed and reports openness so the
    // composer's ArrowUp behavior matches the visible list.
    slashOpen: false,
    mentionOpen: false,
    roomMembers: [] as string[],
    roomMemberRows: [] as ChannelMember[],
    roomPendingInvitations: [] as { email: string; status: string }[],
    roomMembersOwner: "",
    roomMembersPublic: false,
    roomMembersLoading: false,
    roomMembersError: "",
    openRooms: {} as Record<string, boolean>,
    // The instance's default channel (lowercase); people land here when their open channel is deleted.
    defaultChannel: "",
    // Server-advertised IRC connection for generated client configs. Never holds credentials.
    ircConnection: null as null | { host: string; port: number; tls: boolean; allowSelfSigned: boolean; local: boolean },
    media: null as null | StagedMedia,
    mediaBusy: false,
    // The video being compressed before it stages, with its preview and progress.
    mediaCompress: null as null | { name: string; objectUrl: string; percent: number },
    mediaError: "",
    dragActive: false,
    messages: [] as Message[],
    consent: {} as Record<string, boolean>,

  };
}
export type ClientState = ReturnType<typeof createClientState>;
export type ClientSession = {
  scope: () => AccountScope | null;
  key: () => string;
  stopped: () => boolean;
  signingOut: () => boolean;
};
