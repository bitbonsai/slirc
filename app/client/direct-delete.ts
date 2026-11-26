import { foldIdentifier } from "@client/model.ts";
import { type AuthorizedConversation } from "@client/sync.ts";
import { type Navigation } from "@client/navigation.ts";
import { type ThreadGrant } from "@client/access.ts";
import { DEV_CHANNEL } from "@client/protocol.ts";
import { type ClientSession, type ClientState } from "@client/client-state.ts";

export function createDirectDelete(reactive: <T extends object>(value: T) => T, { core, nextTick, session, authorized, nav, connect, closeMenu }: {
  core: Pick<ClientState, 'channels' | 'directs' | 'mutedRooms' | 'starred' | 'threads'>;
  nextTick: (callback?: () => void) => Promise<void>;
  session: ClientSession;
  authorized: () => AuthorizedConversation[];
  nav: Navigation;
  connect: () => Promise<void>;
  closeMenu: () => void;
}) {
  let directDeleteInvoker: HTMLElement | null = null;
  const local = reactive({
    directDeleteCandidate: "",
    directDeleteBusy: false,
    directDeleteError: "",
  });
  function reset(): void { document.querySelector<HTMLDialogElement>("#delete-dm-dialog")?.close(); local.directDeleteCandidate = ""; local.directDeleteBusy = false; local.directDeleteError = ""; directDeleteInvoker = null; }
  function openDirectDelete(event: MouseEvent, nick: string): void {
    directDeleteInvoker = event.currentTarget as HTMLElement;
    closeMenu();
    local.directDeleteCandidate = nick; local.directDeleteError = "";
    void nextTick(() => document.querySelector<HTMLDialogElement>("#delete-dm-dialog")?.showModal());
  }

  function closeDirectDelete(): void {
    if (local.directDeleteBusy) return;
    document.querySelector<HTMLDialogElement>("#delete-dm-dialog")?.close();
    local.directDeleteCandidate = ""; local.directDeleteError = "";
    if (directDeleteInvoker?.isConnected) directDeleteInvoker.focus();
    directDeleteInvoker = null;
  }

  async function closeDirect(): Promise<void> {
    const nick = local.directDeleteCandidate;
    if (!nick || local.directDeleteBusy) return;
    const deletingScope = session.key();
    const direct = core.directs.find((item: any) => foldIdentifier(item.nick) === foldIdentifier(nick));
    const removedDirect = direct ? { ...direct } : null;
    local.directDeleteBusy = true; local.directDeleteError = "";
    // Hide optimistically; server stores this account-scoped preference for other devices.
    if (removedDirect) core.directs = core.directs.filter((item: any) => foldIdentifier(item.nick) !== foldIdentifier(nick));
    const screen = nav.$state.get().screen;
    const activeThread = screen.kind === "room" && direct && core.threads.some((thread: ThreadGrant) => foldIdentifier(thread.channel) === foldIdentifier(screen.room) && foldIdentifier(thread.parent) === foldIdentifier(direct.channel));
    const fallback = core.channels[0]?.wireTarget ?? DEV_CHANNEL;
    const navigatedAway = (screen.kind === "dm" && foldIdentifier(screen.nick) === foldIdentifier(nick)) || activeThread;
    if (navigatedAway) nav.open({ kind: "room", room: fallback });
    try {
      const response = await fetch(`/api/dms/${encodeURIComponent(nick)}`, { method: "DELETE", credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not delete conversation.");
      if (session.key() !== deletingScope || session.stopped()) return;
      document.querySelector<HTMLDialogElement>("#delete-dm-dialog")?.close();
      local.directDeleteCandidate = "";
      if (directDeleteInvoker?.isConnected) directDeleteInvoker.focus();
      directDeleteInvoker = null;
      void connect();
    } catch (error) {
      if (session.key() === deletingScope) {
        if (removedDirect && !core.directs.some((item: any) => foldIdentifier(item.nick) === foldIdentifier(nick))) core.directs = [...core.directs, removedDirect];
        const current = nav.$state.get().screen;
        if (navigatedAway && current.kind === "room" && foldIdentifier(current.room) === foldIdentifier(fallback)) nav.open(screen);
        local.directDeleteError = error instanceof Error ? error.message : "Could not close direct message.";
      }
    } finally {
      if (session.key() === deletingScope) local.directDeleteBusy = false;
    }
  }

  return Object.assign(local, {
    openDirectDelete,
    closeDirectDelete,
    closeDirect,
    reset,
    destroy: reset,
  });
}
