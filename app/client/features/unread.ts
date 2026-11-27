import { conversationId, foldIdentifier } from "@client/model.ts";
import { buildMarkReadCommand, type AuthorizedConversation } from "@client/sync.ts";
import { badgeText, sidebarUnreadTotal, firstReadMarker, newestServerTime, shouldMarkRead } from "@client/store.ts";
import { type ThreadGrant } from "@client/access.ts";
import { type RuntimeState } from "@client/core/runtime-state.ts";
import { type ClientState } from "@client/client-state.ts";
import { type createView } from "@client/view.ts";

export interface UnreadDeps {
  state: Pick<RuntimeState, "authorized" | "bridge" | "capsOk" | "db" | "directories" | "roomId" | "serverMarkers" | "signingOut" | "stopped" | "sync">;
  ui: Pick<ClientState, "directs" | "isDesktop" | "mobileNav" | "mutedRooms" | "threads" | "unread"> & { view: ReturnType<typeof createView> };
  isGroupRoom: (wireTarget: string) => boolean;
  wireSend: (line: string) => boolean;
  transcript: () => { isPinned(): boolean };
}

export function createUnread(deps: UnreadDeps) {
  const { state: rs, ui, isGroupRoom, wireSend, transcript } = deps;

  let markReadTimer: ReturnType<typeof setTimeout> | null = null;

  const baseTitle = document.title;

  let appBadge = -1; // unknown until the first apply, so a stale OS badge from last session clears

  // --- Unread counts ------------------------------------------------------------------------------
  // The unread projection counts rows after each local read marker. This tab moves the marker only
  // when the reader can see the newest message, then tells Ergo with MARKREAD so other sessions
  // follow. Without the cap, or when Ergo keeps no marker, counts stay per device.
  function mutedConversation(id: string): boolean {
    const item = rs.directories.get(id);
    if (!item) return false;
    if (item.kind === "dm") return ui.mutedRooms.includes(`dm:${id}`);
    if (item.kind === "thread") {
      // Threads have no mute of their own; they follow their channel or DM.
      const parent = ui.threads.find((entry: ThreadGrant) => entry.conversationId === id)?.parent;
      const owner = parent ? rs.authorized.find((entry) => entry.kind !== "thread" && foldIdentifier(entry.wireTarget) === foldIdentifier(parent)) : undefined;
      return owner ? mutedConversation(owner.conversationId) : false;
    }
    return ui.mutedRooms.includes(item.wireTarget);
  }

  function unreadCount(id: string): number {
    const count = (id && ui.unread[id]) || 0;
    return count && !mutedConversation(id) ? count : 0;
  }

  function unreadWhere(match: (item: AuthorizedConversation) => boolean): boolean {
    return Object.keys(ui.unread).some((id) => {
      const item = rs.directories.get(id);
      return !!item && match(item) && unreadCount(id) > 0;
    });
  }

  function homeDot(): boolean {
    return unreadWhere((item) => item.kind === "thread" || (item.kind === "room" && !isGroupRoom(item.wireTarget)));
  }

  // Unread in threads, for the Threads header while the section is collapsed.
  function threadsUnread(): number {
    return (ui.threads as ThreadGrant[]).reduce((sum, thread) => sum + unreadCount(thread.conversationId), 0);
  }

  function dmsDot(): boolean {
    return unreadWhere((item) => item.kind === "dm" || (item.kind === "room" && isGroupRoom(item.wireTarget)));
  }

  function applyUnreadChrome(): void {
    const total = sidebarUnreadTotal(ui.unread, (id) => rs.directories.has(id), unreadCount);
    document.title = total ? `(${badgeText(total)}) ${baseTitle}` : baseTitle;
    if (total === appBadge) return;
    appBadge = total;
    const app = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    (total ? app.setAppBadge?.(total) : app.clearAppBadge?.())?.catch(() => {});
  }

  function conversationOnScreen(): boolean {
    if (ui.view.routed) return false;
    return ui.isDesktop || ui.mobileNav === null;
  }

  function sendMarkRead(target: string, time: string): void {
    if (!rs.capsOk || !rs.bridge?.enabled.has("draft/read-marker")) return;
    wireSend(buildMarkReadCommand(target, time));
  }

  // Every trigger (new rows, selection, scroll to bottom, focus, readiness) funnels here; one check
  // runs a second after the first trigger, so a busy room sends at most one MARKREAD a second.
  function scheduleMarkRead(): void {
    if (markReadTimer !== null || rs.stopped || !rs.db) return;
    markReadTimer = setTimeout(() => { markReadTimer = null; void markRead(); }, 1_000);
  }

  function cancelMarkRead(): void {
    if (markReadTimer !== null) clearTimeout(markReadTimer);
    markReadTimer = null;
  }

  async function markRead(): Promise<void> {
    const targetDb = rs.db;
    const id = rs.roomId;
    const item = id ? rs.directories.get(id) : undefined;
    if (!targetDb || !id || !item || rs.stopped || rs.signingOut) return;
    try {
      const [newest, marker] = await Promise.all([newestServerTime(targetDb, id), targetDb.readMarkers.get(id)]);
      if (rs.db !== targetDb || rs.roomId !== id || rs.stopped) return;
      if (!shouldMarkRead({
        visible: document.visibilityState === "visible", focused: document.hasFocus(), onScreen: conversationOnScreen(),
        ready: rs.sync?.isReady(id) ?? false, pinned: transcript().isPinned(), newest, marker: marker?.time,
      })) return;
      if (await targetDb.advanceReadMarker(id, newest!) && rs.db === targetDb) sendMarkRead(item.wireTarget, newest!);
    } catch { /* counts stay; the next trigger retries */ }
  }

  // Newer server marker: another session read further. Older: this device read further, so catch
  // the server up. `*` keeps the local marker; Ergo without always-on forgets markers between
  // connections, and wiping local state then would reset every count on this device.
  async function applyServerMarker(conversation: AuthorizedConversation, time: string): Promise<void> {
    const targetDb = rs.db;
    if (!targetDb || !time) return;
    try {
      if (await targetDb.advanceReadMarker(conversation.conversationId, time)) return;
      const local = await targetDb.readMarkers.get(conversation.conversationId);
      if (rs.db === targetDb && !rs.stopped && local && Date.parse(local.time) > Date.parse(time)) sendMarkRead(conversation.wireTarget, local.time);
    } catch { /* a malformed marker changes nothing */ }
  }

  // First sync with no marker anywhere: start counting from the newest message, so a new device does
  // not light up with all of history. An empty conversation starts at the epoch, locally only. Help's
  // unread welcome DM is the exception (firstReadMarker).
  async function seedReadMarker(conversation: AuthorizedConversation): Promise<void> {
    const targetDb = rs.db;
    const id = conversation.conversationId;
    if (!targetDb || rs.serverMarkers.get(id)) return;
    try {
      if (await targetDb.readMarkers.get(id)) return;
      const newest = await newestServerTime(targetDb, id);
      if (rs.db !== targetDb || rs.stopped || rs.serverMarkers.get(id)) return;
      const peer = conversation.kind === "dm" ? ui.directs.find((item: any) => foldIdentifier(item.channel) === foldIdentifier(conversation.wireTarget))?.nick : undefined;
      // Only tell Ergo when it said it has none; a silent rejoin gave no answer either way.
      const first = firstReadMarker({ newest, peer, serverSaidNone: rs.serverMarkers.get(id) === "" });
      if (!await targetDb.advanceReadMarker(id, first.time)) return;
      if (first.tellServer && newest) sendMarkRead(conversation.wireTarget, newest);
    } catch { /* no marker means no count, never a wrong one */ }
  }

  return { unreadCount, homeDot, threadsUnread, dmsDot, applyUnreadChrome, conversationOnScreen, scheduleMarkRead, cancelMarkRead, applyServerMarker, seedReadMarker };
}
