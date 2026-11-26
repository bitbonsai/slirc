import { foldIdentifier } from "@client/model.ts";
import { type AvatarStatus } from "@client/presence.ts";
import { type ChannelMember, type ClientState } from "@client/client-state.ts";
import { agentSubtitle } from "@client/agent-roster.ts";

// Right-hand members rail for the current desktop room. It owns only panel state; the member list
// comes from the runtime's single authorized fetch (never a second membership source), and presence
// comes from the existing MONITOR-backed presence controller.
export type MembersPanelPresence = "online" | "away" | "offline";
export interface MembersPanelRow extends ChannelMember { owner: boolean; presence: AvatarStatus }
export interface MembersPanelGroup { presence: MembersPanelPresence; label: string; rows: MembersPanelRow[] }

// A member response is applied only while its request generation is still current and the room,
// account scope, teardown state and authorization all still match. This closes A→B→A and
// disconnect/revoke races where an older same-room reply could repopulate the rail.
export function memberResponseApplies(
  response: { conversationId: string | null; scope: string; generation: number },
  current: { conversationId: string | null; scope: string; generation: number; stopped: boolean; authorized: boolean },
): boolean {
  return !current.stopped && current.authorized
    && response.generation === current.generation
    && response.conversationId === current.conversationId
    && response.scope === current.scope;
}

// Rooms only (desktop rail, phone sheet): never a pair DM, a thread, a non-chat route, #help (whose
// presence stays private), or a configured open channel (the server keeps no member list for it), and
// only for a conversation still present in the current grant.
export function membersPanelVisible(state: {
  authenticated: boolean; stopped: boolean; direct: boolean; threaded: boolean;
  channel: string; route: boolean; authorized: boolean; publicRoom: boolean;
}): boolean {
  return state.authenticated && !state.stopped && !state.route && state.authorized
    && !state.direct && !state.threaded && !state.publicRoom
    && state.channel.startsWith("#") && state.channel.toLowerCase() !== "#help";
}

export function createMembersPanel(reactive: <T extends object>(value: T) => T, {
  core, canShow, request, status, label, avatarUrl, openProfile, openWhois, focusToggle, agent = () => undefined,
}: {
  core: Pick<ClientState, "account" | "roomMemberRows" | "roomMembersOwner" | "roomMembersPublic" | "roomMembersLoading" | "roomMembersError"> & { roomPendingInvitations?: { email: string; status: string }[] };
  canShow: () => boolean;
  request: () => void;
  status: (nick: string) => AvatarStatus;
  label: (nick: string) => string;
  avatarUrl: (nick: string) => string;
  /** The agent profile behind a member nick, for its `repo · model` line. */
  agent?: (nick: string) => { repo?: string; model?: string } | undefined;
  openProfile: () => void;
  openWhois: (nick: string) => void;
  /** On a user-initiated close, return focus to the header toggle that opened the rail. */
  focusToggle: () => void;
}) {
  // Local UI state only. Start closed; only the Members toggle opens the panel.
  const local = reactive({ open: false });

  function presenceBucket(value: AvatarStatus): MembersPanelPresence {
    if (value === "away") return "away";
    if (value === "offline" || value === "") return "offline";
    return "online";
  }

  const rank: Record<MembersPanelPresence, number> = { online: 0, away: 1, offline: 2 };

  function rows(): MembersPanelRow[] {
    const owner = foldIdentifier(String(core.roomMembersOwner ?? ""));
    return core.roomMemberRows
      .map((member) => ({ ...member, owner: owner !== "" && foldIdentifier(member.nick) === owner, presence: status(member.nick) }))
      .sort((a, b) => rank[presenceBucket(a.presence)] - rank[presenceBucket(b.presence)] || Number(b.owner) - Number(a.owner) || a.nick.localeCompare(b.nick));
  }

  function groups(): MembersPanelGroup[] {
    const all = rows();
    return (["online", "away", "offline"] as const)
      .map((presence) => ({ presence, label: presence[0].toUpperCase() + presence.slice(1), rows: all.filter((row) => presenceBucket(row.presence) === presence) }))
      .filter((group) => group.rows.length);
  }

  function count(): number { return core.roomMemberRows.length; }
  function countLabel(): string { const n = count(); return `${n} ${n === 1 ? "member" : "members"}`; }

  function emptyText(): string {
    if (core.roomMembersLoading) return "Loading members…";
    if (core.roomMembersError) return core.roomMembersError;
    // Open channels have no persisted member list; never fabricate a population.
    if (core.roomMembersPublic) return "Public room. Membership isn't listed.";
    return "Nobody here right now.";
  }

  function isSelf(nick: string): boolean {
    return foldIdentifier(nick) === foldIdentifier(String(core.account ?? ""));
  }

  function memberNote(row: MembersPanelRow): string {
    if (row.owner) return "Owner";
    if (row.kind === "agent") return agentSubtitle(agent(row.nick)) || row.machine || "Agent";
    if (row.kind === "bot") return "Bot";
    return presenceBucket(row.presence) === "away" ? "Away" : "";
  }

  function tooltip(row: MembersPanelRow): string {
    const note = memberNote(row);
    return note ? `${row.nick} · ${note}` : row.nick;
  }

  function openMember(row: MembersPanelRow): void {
    if (isSelf(row.nick)) openProfile();
    else openWhois(row.nick);
  }

  function error(): string { return core.roomMembersError; }

  function toggle(): void { if (!canShow()) return; local.open = !local.open; if (local.open) request(); }
  function close(): void { local.open = false; }
  // User-initiated collapse from the rail: close, then return focus to the header toggle.
  function dismiss(): void { close(); focusToggle(); }
  function reset(): void { local.open = false; }

  return Object.assign(local, {
    pendingInvitations: () => core.roomPendingInvitations ?? [],
    canShow, rows, groups, count, countLabel, emptyText, error, openMember, memberNote, tooltip,
    statusLabel: (row: MembersPanelRow) => label(row.nick),
    toggle, close, dismiss, reset, request,
    destroy: reset,
  });
}
