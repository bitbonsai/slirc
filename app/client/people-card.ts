import { foldIdentifier } from "@client/model.ts";
import { type IrcMessage } from "@client/irc.ts";
import { avatarUrl, rememberAvatarVersions } from "@client/presentation.ts";
import { agentFor, type AgentProfiles } from "@client/agent-roster.ts";
import { type OpenPopup } from "@client/popups.ts";
import { type AuthorizedConversation } from "@client/sync.ts";
import { type ThreadGrant } from "@client/access.ts";
import { type ClientState } from "@client/client-state.ts";

// One shared-conversation row. `wireTarget` is always a conversation the viewer is already
// authorized to open; a WHOIS channel list is only ever used to intersect that set, never to add.
export interface SharedConversationRow {
  kind: "channel" | "dm" | "thread";
  conversationId: string;
  wireTarget: string;
  label: string;
  nick?: string;
  parentLabel?: string;
  people?: string[];
  extra?: number;
}

export interface SharedConversationInput {
  whoisChannels: readonly string[];
  conversations: readonly AuthorizedConversation[];
  directs: readonly { nick: string; channel: string }[];
  channelDetails: readonly { channel: string; topic?: string; isGroup?: boolean }[];
  groupMembers?: Readonly<Record<string, readonly string[]>>;
  threads: readonly ThreadGrant[];
  targetNick: string;
}

// Viewer-authorized conversations genuinely shared with the viewed person. The WHOIS channel list
// is a membership hint only: a name that is not in the viewer's authorized set is dropped, so an
// unrelated private room or DM partner never leaks. Group titles come from channel metadata;
// avatar names come from the existing authorized members endpoint, never topic text or channel IDs.
export function sharedConversations(input: SharedConversationInput): {
  channels: SharedConversationRow[];
  dms: SharedConversationRow[];
  threads: SharedConversationRow[];
} {
  const whois = new Set(input.whoisChannels.map((name) => foldIdentifier(name)));
  const target = foldIdentifier(input.targetNick);
  const authorizedTargets = new Set(input.conversations.map((item) => foldIdentifier(item.wireTarget)));
  const groupFor = (wire: string) => input.channelDetails.find((detail) => detail.isGroup === true && foldIdentifier(detail.channel) === foldIdentifier(wire));

  const channels = input.conversations
    .filter((item) => item.kind === "room" && !groupFor(item.wireTarget) && whois.has(foldIdentifier(item.wireTarget)))
    .map((item): SharedConversationRow => ({
      kind: "channel",
      conversationId: item.conversationId,
      wireTarget: item.wireTarget,
      label: item.wireTarget.replace(/^#/, ""),
    }));

  const dms: SharedConversationRow[] = [];
  for (const direct of input.directs) {
    if (foldIdentifier(direct.nick) !== target) continue;
    const conversation = input.conversations.find((item) => item.kind === "dm" && foldIdentifier(item.wireTarget) === foldIdentifier(direct.channel));
    if (!conversation) continue;
    dms.push({ kind: "dm", conversationId: conversation.conversationId, wireTarget: conversation.wireTarget, label: direct.nick, nick: direct.nick, people: [direct.nick] });
  }
  for (const item of input.conversations) {
    if (item.kind !== "room") continue;
    const detail = groupFor(item.wireTarget);
    if (!detail || !whois.has(foldIdentifier(item.wireTarget))) continue;
    const label = String(detail.topic || "").trim();
    // The topic is a display title, never a participant list. Omit unlabeled groups rather
    // than exposing their internal channel id.
    if (!label) continue;
    const names = input.groupMembers?.[foldIdentifier(item.wireTarget)] || [];
    dms.push({ kind: "dm", conversationId: item.conversationId, wireTarget: item.wireTarget, label,
      people: names.slice(0, 3), extra: Math.max(0, names.length - 3) });
  }

  const threads = input.threads
    .filter((thread) => authorizedTargets.has(foldIdentifier(thread.parent))
      && authorizedTargets.has(foldIdentifier(thread.channel))
      && whois.has(foldIdentifier(thread.channel)))
    .map((thread): SharedConversationRow => {
      const group = groupFor(thread.parent);
      return {
        kind: "thread",
        conversationId: thread.conversationId,
        wireTarget: thread.channel,
        label: thread.title,
        parentLabel: group?.topic || thread.parentLabel,
      };
    });

  return { channels, dms, threads };
}

export function createPeopleCard(reactive: <T extends object>(value: T) => T, { core, openPopup, sendWhois, activeChannel, openRoom, openDirect, conversations, directs, channelDetails, threads, focusComposer = () => {}, whoisTimeoutMs = 15_000 }: {
  core: Pick<ClientState, 'channel' | 'me' | 'account' | 'isAdmin'> & { avatarVersions?: Record<string, number>; agentProfiles?: AgentProfiles };
  openPopup: OpenPopup;
  sendWhois: (nick: string) => void | boolean;
  activeChannel: () => string;
  openRoom: (channel: string) => void;
  openDirect: (nick: string) => Promise<void>;
  conversations: () => readonly AuthorizedConversation[];
  directs: () => readonly { nick: string; channel: string }[];
  channelDetails: () => readonly { channel: string; topic?: string; isGroup?: boolean }[];
  threads: () => readonly ThreadGrant[];
  // Message CTA only: move the caret into the newly opened DM composer. Ordinary profile opens do not.
  focusComposer?: () => void;
  whoisTimeoutMs?: number;
}) {
  let whoisTimer: number | null = null;
  let groupMemberEpoch = 0;
  // Plain WHOIS has no request ID. Reopening an unfinished nick joins that lookup.
  // Completed replies are removed; this holds only outstanding protocol responses.
  const pendingWhois = new Map<string, Record<string, any>>();
  // HTTP responses apply only to the current open. WHOIS buffers publish at their own end numeric.
  let requestEpoch = 0;
  const local = reactive({
    whois: {} as Record<string, any>,
    whoisNick: "",
    groupMembers: {} as Record<string, string[]>,
    groupMemberState: {} as Record<string, "loading" | "ready" | "error">,
    // Admin-only "Remove member": one inline confirmation that names the person.
    removeConfirm: false,
    removeBusy: false,
    removeError: "",
  });
  function reset(): void { closeWhois(); pendingWhois.clear(); local.whois = {}; local.groupMembers = {}; local.groupMemberState = {}; }
  // core.me is the display name; only the account says who you are.
  function isMe(nick: string): boolean {
    return !!nick && foldIdentifier(nick) === foldIdentifier(core.account);
  }

  function openWhois(nick: string): void {
    if (!nick) return;
    const key = foldIdentifier(nick);
    openPopup(closeWhois);
    const epoch = ++requestEpoch;
    groupMemberEpoch++;
    local.groupMembers = {};
    local.groupMemberState = {};
    if (whoisTimer !== null) clearTimeout(whoisTimer);
    local.whoisNick = nick;
    local.removeConfirm = false; local.removeError = "";
    local.whois = { ...local.whois, [key]: { nick, loading: true, profileLoading: true } };
    whoisTimer = globalThis.setTimeout(() => {
      whoisTimer = null;
      if (requestEpoch !== epoch || foldIdentifier(local.whoisNick) !== key) return;
      local.whois = { ...local.whois, [key]: { ...local.whois[key], loading: false,
        error: "Couldn’t load shared conversations or IRC details. Try again." } };
    }, whoisTimeoutMs) as unknown as number;
    if (!pendingWhois.has(key)) {
      pendingWhois.set(key, { nick });
      if (sendWhois(nick) === false) {
        pendingWhois.delete(key);
        if (whoisTimer !== null) { clearTimeout(whoisTimer); whoisTimer = null; }
        local.whois = { ...local.whois, [key]: { ...local.whois[key], loading: false,
          error: "You’re offline. Reconnect and try again." } };
      }
    }
    void loadWhoisProfile(nick, epoch);
  }

  function closeWhois(): void {
    if (local.removeBusy) return;
    local.removeConfirm = false; local.removeError = "";
    requestEpoch++;
    groupMemberEpoch++;
    if (whoisTimer !== null) { clearTimeout(whoisTimer); whoisTimer = null; }
    local.whoisNick = "";
  }

  function whoisInfo(): any {
    return local.whois[foldIdentifier(local.whoisNick)] || null;
  }

  async function loadWhoisProfile(nick: string, epoch: number): Promise<void> {
    const key = foldIdentifier(nick);
    const settle = (profile: any, error = ""): void => {
      if (epoch !== requestEpoch || foldIdentifier(local.whoisNick) !== key) return;
      const entry = local.whois[key];
      if (!entry) return;
      local.whois = { ...local.whois, [key]: { ...entry, ...(profile ? { profile } : {}), profileLoading: false, profileError: error } };
    };
    try {
      const channel = activeChannel() || core.channel || "";
      const response = await fetch(`/profiles/${encodeURIComponent(nick)}?channel=${encodeURIComponent(channel)}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(whoisTimeoutMs) });
      const profile = await response.json().catch(() => null);
      if (response.ok && profile?.account && core.avatarVersions) rememberAvatarVersions(core.avatarVersions, [{ nick: profile.account, avatarVersion: profile.avatarVersion }]);
      settle(response.ok && profile?.account ? profile : null, response.ok ? "" : "Profile unavailable. Try again.");
    } catch { settle(null, "Profile unavailable. Try again."); }
  }

  // An agent's server avatar URL is an empty upload slot; its harness mark wins.
  function whoisAvatarUrl(): string {
    if (agentFor(core.agentProfiles, local.whoisNick)) return personAvatarUrl(local.whoisNick);
    return whoisInfo()?.profile?.avatarUrl || avatarUrl(local.whoisNick);
  }

  function personAvatarUrl(nick: string): string {
    return avatarUrl(nick, core.avatarVersions?.[foldIdentifier(nick)], agentFor(core.agentProfiles, nick)?.harness);
  }

  function whoisChannelList(): string[] {
    const raw = whoisInfo()?.channels as string | undefined;
    if (!raw) return [];
    // Ergo prefixes role markers (@ founder, + voice) before the channel name.
    return [...new Set(String(raw).split(/\s+/).map((name) => name.replace(/^[@+]+/, "")).filter(Boolean))];
  }

  function whoisShared(): { channels: SharedConversationRow[]; dms: SharedConversationRow[]; threads: SharedConversationRow[] } {
    if (whoisInfo()?.loading || whoisInfo()?.error) return { channels: [], dms: [], threads: [] };
    return sharedConversations({
      whoisChannels: whoisChannelList(),
      conversations: conversations(),
      directs: directs(),
      channelDetails: channelDetails(),
      groupMembers: local.groupMembers,
      threads: threads(),
      targetNick: local.whoisNick,
    });
  }

  function loadSharedGroupMembers(nick: string): void {
    const epoch = ++groupMemberEpoch;
    const key = foldIdentifier(nick);
    const sharedChannels = new Set(whoisChannelList().map(foldIdentifier));
    for (const item of conversations()) {
      const detail = channelDetails().find((entry) => entry.isGroup === true && foldIdentifier(entry.channel) === foldIdentifier(item.wireTarget));
      if (item.kind !== "room" || !detail || !sharedChannels.has(foldIdentifier(item.wireTarget))) continue;
      const wire = item.wireTarget;
      const wireKey = foldIdentifier(wire);
      local.groupMemberState = { ...local.groupMemberState, [wireKey]: "loading" };
      void fetch(`/api/channels/${encodeURIComponent(wire)}/members`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(whoisTimeoutMs) })
        .then(async (response) => response.ok ? response.json().catch(() => null) : null)
        .then((body) => {
          if (epoch !== groupMemberEpoch || foldIdentifier(local.whoisNick) !== key
            || !conversations().some((current) => current.kind === "room" && foldIdentifier(current.wireTarget) === foldIdentifier(wire))) return;
          if (!Array.isArray(body?.members)) throw new Error("Members unavailable");
          const members = body.members;
          const names = members.map((member: any) => typeof member?.nick === "string" ? member.nick : "").filter(Boolean);
          local.groupMembers = { ...local.groupMembers, [wireKey]: names };
          local.groupMemberState = { ...local.groupMemberState, [wireKey]: "ready" };
        }).catch(() => {
          if (epoch === groupMemberEpoch && foldIdentifier(local.whoisNick) === key) {
            local.groupMemberState = { ...local.groupMemberState, [wireKey]: "error" };
          }
        });
    }
  }

  function openShared(row: SharedConversationRow): void {
    closeWhois();
    if (row.kind === "dm" && row.nick) { void openDirect(row.nick); return; }
    openRoom(row.wireTarget);
  }

  function applyWhois(message: IrcMessage): void {
    const nick = message.params[1];
    if (!nick) return;
    const key = foldIdentifier(nick);
    const pending = pendingWhois.get(key);
    if (!pending) return;
    const trailing = message.params.at(-1) || "";
    if (message.command === "311") { pending.user = message.params[2]; pending.host = message.params[3]; pending.realname = trailing; }
    else if (message.command === "312") pending.server = message.params[2];
    else if (message.command === "319") pending.channels = [pending.channels, trailing].filter(Boolean).join(" ");
    else if (message.command === "330") pending.account = message.params[2];
    else if (message.command === "318" || message.command === "401" || message.command === "402") {
      pendingWhois.delete(key);
      // Timeout is an error, never a ready empty card that accepts late content.
      if (key !== foldIdentifier(local.whoisNick) || !whoisInfo()?.loading) return;
      if (whoisTimer !== null) { clearTimeout(whoisTimer); whoisTimer = null; }
      const error = message.command === "318" ? "" : "This person is offline or unavailable. Try again.";
      local.whois = { ...local.whois, [key]: { ...local.whois[key], ...(error ? {} : pending), loading: false, error } };
      if (!error) loadSharedGroupMembers(nick);
    }
  }

  function groupMembersState(wire: string): "loading" | "ready" | "error" {
    return local.groupMemberState[foldIdentifier(wire)] || "ready";
  }

  async function messageMention(nick: string): Promise<void> {
    closeWhois();
    await openDirect(nick);
    // The dialog is gone and the DM route is selected; move the caret into its composer.
    focusComposer();
  }

  // Humans only, never yourself or another admin; the server refuses both too.
  function canRemove(): boolean {
    const profile = whoisInfo()?.profile;
    return !!core.isAdmin && !!profile?.account && profile.kind === "human" && profile.role !== "admin" && !isMe(profile.account);
  }

  function removeName(): string {
    return whoisInfo()?.profile?.fullName || local.whoisNick;
  }

  async function removeMember(): Promise<void> {
    const nick = whoisInfo()?.profile?.account;
    if (!nick || !canRemove() || local.removeBusy) return;
    local.removeBusy = true; local.removeError = "";
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(nick)}`, { method: "DELETE", credentials: "same-origin" });
      const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: string }).error || "Could not remove this person.");
      local.removeBusy = false;
      closeWhois();
    } catch (error) {
      local.removeError = error instanceof Error ? error.message : "Could not remove this person.";
    } finally {
      local.removeBusy = false;
    }
  }

  return Object.assign(local, {
    canRemove,
    removeName,
    removeMember,
    isMe,
    openWhois,
    closeWhois,
    whoisInfo,
    whoisAvatarUrl,
    personAvatarUrl,
    groupMembersState,
    retryGroupMembers: () => { if (!whoisInfo()?.loading && !whoisInfo()?.error) loadSharedGroupMembers(local.whoisNick); },
    retryWhois: () => openWhois(local.whoisNick),
    whoisChannelList,
    whoisShared,
    openShared,
    applyWhois,
    messageMention,
    reset,
    destroy: reset,
  });
}
