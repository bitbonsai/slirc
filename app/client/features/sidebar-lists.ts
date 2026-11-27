import { conversationId, foldIdentifier } from "@client/model.ts";
import type { AuthorizedConversation } from "@client/sync.ts";
import { excludeStarred } from "@client/presentation.ts";
import { orderChannels } from "@client/channel-order.ts";
import { agentHeader, agentLabel, agentNavRows, isAgentNick } from "@client/agent-roster.ts";
import type { createConversationMenu } from "@client/conversation-menu.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface SidebarListsDeps {
  state: Pick<RuntimeState, "authorized" | "scope">;
  ui: Pick<ClientState, "account" | "activeThread" | "agentProfiles" | "channel" | "channelDetails" | "channelOrder" | "channels" | "direct" | "directs" | "mutedRooms" | "notesOpen" | "openRooms" | "pendingDmVersion" | "roomLabel" | "starred"> & { avatarStatusLabel: (nick: string) => string };
  pendingDirectRows: () => { nick: string; channel: string; conversationId: string; pending: true }[];
  applyUnreadChrome: () => void;
  menus: () => ReturnType<typeof createConversationMenu>;
}

export function createSidebarLists(deps: SidebarListsDeps) {
  const { state: rs, ui, pendingDirectRows, applyUnreadChrome, menus } = deps;

  function dmPeerNick(channel: string): string | undefined {
    return (ui.directs as { channel?: string; nick?: string }[]).find((entry) => foldIdentifier(entry.channel ?? "") === foldIdentifier(channel))?.nick;
  }

  function conversationIdForDm(channel: string): string {
    return rs.authorized.find((entry) => entry.kind === "dm" && foldIdentifier(entry.wireTarget) === foldIdentifier(channel))?.conversationId ?? "";
  }

  function isGroupRoom(wireTarget: string): boolean {
    return ui.channelDetails.some((detail: { channel: string; isGroup?: boolean }) => detail.channel === wireTarget && detail.isGroup === true);
  }

  // Groups are ordinary secret rooms authorized for messaging and routes, but they belong under
  // DMs (desktop and phone), never duplicated in the Channels list. The marker comes from
  // /auth/me channelDetails, not from the channel name.
  function groupList(): AuthorizedConversation[] {
    return excludeStarred(ui.channels.filter((item: AuthorizedConversation) => isGroupRoom(item.wireTarget)), ui.starred, (item: AuthorizedConversation) => item.conversationId);
  }

  function roomLabelFor(wireTarget: string): string {
    const detail = ui.channelDetails.find((entry: { channel: string; topic?: string; isGroup?: boolean }) => entry.channel === wireTarget);
    if (detail?.isGroup && detail.topic) return detail.topic;
    return wireTarget.replace(/^#/, "");
  }

  function channelList(): AuthorizedConversation[] {
    return orderChannels(
      excludeStarred(ui.channels.filter((item: AuthorizedConversation) => !isGroupRoom(item.wireTarget)), ui.starred, (item: AuthorizedConversation) => item.conversationId),
      ui.channelOrder,
      (item: AuthorizedConversation) => item.conversationId,
    );
  }

  function saveChannelOrder(ids: readonly string[]): void {
    if (!rs.scope) return;
    const key = `slirc2-channel-order:${rs.scope.accountId}`;
    try { if (ids.length) localStorage.setItem(key, JSON.stringify(ids)); else localStorage.removeItem(key); } catch { /* unavailable storage keeps order for this session */ }
  }

  // Agent DMs live in the Agents section, not here.
  function directList(): any[] {
    void ui.pendingDmVersion;
    const people = ui.directs.filter((item: { nick: string }) => !isAgentNick(ui.agentProfiles, item.nick));
    return [...pendingDirectRows(), ...excludeStarred(people, ui.starred, (item: any) => conversationIdForDm(item.channel))];
  }

  function agentList(): { nick: string; label: string; channel: string }[] {
    return agentNavRows(ui.agentProfiles, ui.directs, String(ui.account ?? ""), (channel) => ui.starred.includes(conversationIdForDm(channel)));
  }

  // A direct DM with a known agent shows its session name and `harness · nick`. Threads and
  // ordinary DMs keep the names they already had.
  function agentDirectHeader(): { title: string; subtitle: string } | null {
    if (!ui.direct || ui.activeThread) return null;
    const nick = String(ui.channel ?? "");
    return isAgentNick(ui.agentProfiles, nick) ? agentHeader(ui.agentProfiles, nick) : null;
  }

  function headerTitle(): string {
    const label = agentDirectHeader()?.title || ui.roomLabel || String(ui.channel ?? "").replace(/^#/, "");
    // A private channel's lock stands in for the "#"; open channels keep it.
    const privateRoom = !ui.direct && !ui.notesOpen && !ui.activeThread && label === ui.channel && !isOpenRoom(ui.channel);
    return privateRoom ? label.replace(/^#/, "") : label;
  }

  function headerSubtitle(): string {
    return agentDirectHeader()?.subtitle ?? (activeChannelArchived() ? "Archived · read only" : "");
  }

  // The open channel is archived: the composer gives way to a read-only bar. DMs, threads and Notes
  // are never archived.
  function activeChannelArchived(): boolean {
    if (ui.direct || ui.activeThread || ui.notesOpen) return false;
    const channel = foldIdentifier(String(ui.channel ?? ""));
    return ui.channelDetails.some((detail: { channel: string; archived?: boolean }) => detail.archived === true && foldIdentifier(detail.channel) === channel);
  }

  function headerTooltip(): string {
    if (!ui.direct) return "";
    const agent = agentDirectHeader();
    const presence = ui.avatarStatusLabel(String(ui.channel ?? ""));
    return [agent ? agent.title : String(ui.channel ?? ""), agent?.subtitle, presence].filter(Boolean).join(" · ");
  }

  function starredItems(): { conversationId: string; kind: "room" | "dm"; wireTarget: string; label: string; nick?: string }[] {
    return ui.starred.flatMap((conversationId: string) => {
      const item = rs.authorized.find((entry) => entry.conversationId === conversationId);
      if (!item || (item.kind !== "room" && item.kind !== "dm")) return [];
      const direct = item.kind === "dm" ? ui.directs.find((entry: any) => foldIdentifier(entry.channel) === foldIdentifier(item.wireTarget)) : null;
      if (item.kind === "dm" && !direct) return [];
      return [{ conversationId, kind: item.kind, wireTarget: item.wireTarget, label: direct ? agentLabel(ui.agentProfiles, direct.nick) : roomLabelFor(item.wireTarget), nick: direct?.nick }];
    });
  }

  function toggleStar(conversationId: string): void {
    const next = ui.starred.includes(conversationId) ? ui.starred.filter((id: string) => id !== conversationId) : [...ui.starred, conversationId];
    ui.starred = next;
    menus().starMenuId = ""; menus().navMenu = null; menus().copyFlyout = null;
    if (!rs.scope) return;
    const key = `slirc2-starred:${rs.scope.accountId}`;
    try { if (next.length) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key); } catch { /* unavailable storage keeps state for this session */ }
  }

  function toggleMute(target: string): void {
    ui.mutedRooms = ui.mutedRooms.includes(target) ? ui.mutedRooms.filter((room: string) => room !== target) : [...ui.mutedRooms, target];
    if (!rs.scope) return;
    try { localStorage.setItem(`slirc2-muted:${rs.scope.accountId}`, JSON.stringify(ui.mutedRooms)); } catch { /* mute state lasts for this session */ }
    applyUnreadChrome();
  }

  // People for the `@` picker: current room members first, then contacts. Only rooms have members;
  // DMs and threads fall back to contacts.
  // A stored channel row is authoritative: a channel the server marks secret stays locked even if
  // its name appears in the configured open list, and only a settings change updates that row. The
  // configured list is the fallback for open channels that have no row at all (like #dev-open).
  function isOpenRoom(room: string): boolean {
    const detail = ui.channelDetails.find((entry: { channel: string; visibility?: string }) => entry.channel === room);
    if (detail) return detail.visibility === "workspace";
    return ui.openRooms[room] === true;
  }

  return { dmPeerNick, conversationIdForDm, isGroupRoom, groupList, roomLabelFor, channelList, saveChannelOrder, directList, agentList, headerTitle, headerSubtitle, activeChannelArchived, headerTooltip, starredItems, toggleStar, toggleMute, isOpenRoom };
}
