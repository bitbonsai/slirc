import { conversationId, foldIdentifier, type Draft } from "@client/model.ts";
import { ClientDatabase } from "@client/db.ts";
import { draftNavigationItems, visibleDraftNavigationItems } from "@client/presentation.ts";
import type { createComposerEditor } from "@client/composer-editor.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface DraftsDeps {
  state: Pick<RuntimeState, "authorized" | "composer" | "composerTextByConversation" | "db" | "directories" | "pendingDms" | "roomId" | "stopped">;
  ui: Pick<ClientState, "composer" | "currentConversationId" | "directs" | "drafts" | "error" | "isDesktop" | "mobileNav" | "threads">;
  nextTick: (callback?: () => void) => unknown;
  editor: () => ReturnType<typeof createComposerEditor>;
  openRoom: (room?: string) => void;
  openDirect: (nick: string) => Promise<void>;
}

export function createDrafts(deps: DraftsDeps) {
  const { state: rs, ui, nextTick, editor, openRoom, openDirect } = deps;

  let focusDraftConversationId: string | null = null;

  async function refreshDrafts(expectedDb = rs.db): Promise<void> {
    if (!expectedDb) { ui.drafts = []; return; }
    try {
      const drafts = await expectedDb.drafts.toArray();
      if (rs.db === expectedDb && !rs.stopped) ui.drafts = draftNavigationItems(drafts, rs.authorized, ui.directs, ui.threads,
        [...rs.pendingDms].map(([conversationId, entry]) => ({ conversationId, nick: entry.nick })));
    } catch { /* Keep last visible rows; a later edit or navigation retries the read. */ }
  }

  function updateDraftNavigation(draft: Draft): void {
    const drafts: Draft[] = ui.drafts.filter((item: Draft) => item.conversationId !== draft.conversationId);
    if (draft.text.trim()) drafts.push(draft);
    ui.drafts = draftNavigationItems(drafts, rs.authorized, ui.directs, ui.threads,
      [...rs.pendingDms].map(([conversationId, entry]) => ({ conversationId, nick: entry.nick })));
  }

  function draftWriter(targetDb: ClientDatabase) {
    return {
      put: async (draft: Draft) => { await targetDb.drafts.put(draft); await refreshDrafts(targetDb); },
      delete: async (id: string) => { await targetDb.drafts.delete(id); await refreshDrafts(targetDb); },
    };
  }

  function draftsList(): (Draft & { label: string })[] {
    const hideActive = ui.isDesktop || ui.mobileNav === null;
    return visibleDraftNavigationItems(ui.drafts, ui.currentConversationId, hideActive);
  }

  // Drop a pending "focus this draft" request, unless it is for the conversation being opened.
  function clearDraftFocus(except?: string | null): void {
    if (focusDraftConversationId && focusDraftConversationId !== except) focusDraftConversationId = null;
  }

  function focusLoadedDraft(id: string): void {
    if (focusDraftConversationId !== id) return;
    void nextTick(() => {
      if (focusDraftConversationId !== id || rs.roomId !== id) return;
      const input = document.querySelector<HTMLElement>("#input");
      if (!input || !input.getClientRects().length) return;
      editor().focusComposerAtEnd(input);
      focusDraftConversationId = null;
    });
  }

  function openDraft(id: string): void {
    const conversation = rs.authorized.find((item) => item.conversationId === id);
    if (!conversation) return;
    focusDraftConversationId = id;
    if (conversation.kind === "dm") {
      const direct = ui.directs.find((item: any) => foldIdentifier(item.channel) === foldIdentifier(conversation.wireTarget));
      if (direct) void openDirect(direct.nick);
    } else openRoom(conversation.wireTarget);
    if (rs.roomId === id) focusLoadedDraft(id);
  }

  async function deleteDraft(id: string): Promise<void> {
    const targetDb = rs.db;
    if (!targetDb || !rs.directories.has(id)) return;
    try {
      if (rs.roomId === id && rs.composer) {
        const targetComposer = rs.composer;
        if (!await targetComposer.discard()) return;
        if (rs.db !== targetDb || rs.composer !== targetComposer) return;
        ui.composer = "";
        editor().resizeComposer();
      } else await targetDb.drafts.delete(id);
      rs.composerTextByConversation.delete(id);
      await refreshDrafts(targetDb);
    } catch {
      if (rs.db === targetDb) ui.error = "Could not delete this draft. It is still saved.";
    }
  }

  return { refreshDrafts, updateDraftNavigation, draftWriter, draftsList, clearDraftFocus, focusLoadedDraft, openDraft, deleteDraft };
}
