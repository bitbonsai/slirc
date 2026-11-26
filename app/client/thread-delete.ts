import { foldIdentifier } from "@client/model.ts";
import { type ThreadGrant } from "@client/access.ts";
import { canDeleteThread } from "@client/threads.ts";
import { type ClientSession, type ClientState } from "@client/client-state.ts";

// Deleting a whole thread: one menu item, one confirmation. The server removes the replies and the
// Ergo channel; `onDeleted` cleans up this client (the parent announcement and any open view).
export function createThreadDelete(reactive: <T extends object>(value: T) => T, { core, nextTick, session, closeMenu, onDeleted }: {
  core: Pick<ClientState, 'threads' | 'account' | 'isAdmin'>;
  nextTick: (callback?: () => void) => Promise<void>;
  session: ClientSession;
  closeMenu: () => void;
  onDeleted: (thread: ThreadGrant) => void;
}) {
  let invoker: HTMLElement | null = null;
  const local = reactive({
    threadDeleteCandidate: null as ThreadGrant | null,
    threadDeleteBusy: false,
    threadDeleteError: "",
  });
  const dialog = () => document.querySelector<HTMLDialogElement>("#delete-thread-dialog");
  const find = (channel: string) => core.threads.find((thread: ThreadGrant) => foldIdentifier(thread.channel) === foldIdentifier(channel)) ?? null;

  function canDelete(channel: string): boolean {
    return canDeleteThread(find(channel), core.account, !!core.isAdmin);
  }

  function reset(): void { dialog()?.close(); local.threadDeleteCandidate = null; local.threadDeleteBusy = false; local.threadDeleteError = ""; invoker = null; }

  function openThreadDelete(event: MouseEvent, channel: string): void {
    const thread = find(channel);
    if (!thread || !canDelete(channel)) return;
    invoker = event.currentTarget as HTMLElement;
    closeMenu();
    local.threadDeleteCandidate = thread; local.threadDeleteError = "";
    void nextTick(() => dialog()?.showModal());
  }

  function closeThreadDelete(): void {
    if (local.threadDeleteBusy) return;
    dialog()?.close();
    local.threadDeleteCandidate = null; local.threadDeleteError = "";
    if (invoker?.isConnected) invoker.focus();
    invoker = null;
  }

  async function deleteThread(): Promise<void> {
    const thread = local.threadDeleteCandidate;
    if (!thread || local.threadDeleteBusy) return;
    const deletingScope = session.key();
    local.threadDeleteBusy = true; local.threadDeleteError = "";
    try {
      const response = await fetch(`/api/threads/${encodeURIComponent(thread.channel.replace(/^#/, ""))}`, { method: "DELETE", credentials: "same-origin" });
      const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: string }).error || "Could not delete thread.");
      if (session.key() !== deletingScope || session.stopped()) return;
      dialog()?.close();
      local.threadDeleteCandidate = null;
      invoker = null;
      onDeleted(thread);
    } catch (error) {
      if (session.key() === deletingScope) local.threadDeleteError = error instanceof Error ? error.message : "Could not delete thread.";
    } finally {
      if (session.key() === deletingScope) local.threadDeleteBusy = false;
    }
  }

  return Object.assign(local, {
    canDelete,
    openThreadDelete,
    closeThreadDelete,
    deleteThread,
    reset,
    destroy: reset,
  });
}
