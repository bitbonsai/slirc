import { emojiText } from "@client/emoji.ts";
import { conversationId, foldIdentifier, type Message, type Operation } from "@client/model.ts";
import { NOTES_CONVERSATION_ID, type createNavigation } from "@client/navigation.ts";
import { closeUnclosedCodeFence } from "@client/render.ts";
import { removeInlineMedia, splitInlineMedia, type InlineMedia } from "@client/media.ts";
import { canAdminEditBotMessage, canDeleteMessage, canEditMessage } from "@client/presentation.ts";
import type { ThreadGrant } from "@client/access.ts";
import { randomId, validateMultiline } from "@client/protocol.ts";
import { adminDeletesOverIrc } from "@client/threads.ts";
import { queuedTextFor } from "@client/drafts.ts";
import { HELPER_NICKS, UPDATES_NICK } from "../../shared/service-bots.ts";
import { isBotRow } from "@client/job-cards.ts";
import type { createMediaView } from "@client/media-view.ts";
import type { createNotes } from "@client/notes.ts";
import type { createMessageActions } from "@client/message-actions.ts";
import type { createTranscript } from "@client/transcript.ts";
import type { createEmojiPicker } from "@client/emoji-picker.ts";
import type { createComposerEditor } from "@client/composer-editor.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface MessageEditDeps {
  state: Pick<RuntimeState, "authorized" | "composer" | "composerTextByConversation" | "currentScope" | "db" | "directories" | "navIntent" | "outbox" | "roomId" | "scope" | "sync">;
  ui: Pick<ClientState, "account" | "composer" | "directs" | "editAttachments" | "editConversationId" | "editSavedRevision" | "editSavedText" | "editServerId" | "editingMessageId" | "isAdmin" | "messages" | "redactions" | "roomMemberRows" | "sendError" | "threads">;
  instance: string;
  notes: ReturnType<typeof createNotes>;
  nav: ReturnType<typeof createNavigation>;
  hint: (text: string) => void;
  mediaView: () => ReturnType<typeof createMediaView>;
  actions: () => ReturnType<typeof createMessageActions>;
  transcript: () => ReturnType<typeof createTranscript>;
  emoji: () => ReturnType<typeof createEmojiPicker>;
  editor: () => ReturnType<typeof createComposerEditor>;
}

export function createMessageEdit(deps: MessageEditDeps) {
  const { state: rs, ui, instance, notes, nav, hint, mediaView, actions, transcript, emoji, editor } = deps;

  function editingMedia(): InlineMedia[] {
    if (!ui.editingMessageId) return [];
    return ui.editAttachments.flatMap((line: string) => mediaView().messageMedia(line));
  }

  function removeEditingMedia(media: InlineMedia): void {
    if (!ui.editingMessageId) return;
    const next = removeInlineMedia(ui.editAttachments.join("\n"), media.href, instance);
    ui.editAttachments = next ? next.split("\n") : [];
  }

  // --- Delete (native REDACT) -----------------------------------------------------------------

  function redactFor(message: Message): { state: string; operationId: string } | null {
    return message.serverId ? ui.redactions[message.serverId] ?? null : null;
  }

  function redactLabel(message: Message): string {
    const entry = redactFor(message);
    if (!entry) return "";
    return entry.state === "queued" ? "deleting…" : entry.state === "sending" ? "deleting…" : entry.state === "uncertain" ? "delete uncertain" : "delete failed";
  }

  // Keyboard navigation inside the message menu. Handled keys stop propagation so the row's
  // ArrowUp/Down/Escape/e/t handlers cannot steal them; Tab is left to the browser so focus can
  // enter and leave the menu.
  function redactOperation(message: Message, reason: string): Operation {
    return {
      id: randomId(), messageId: "", conversationId: message.conversationId, kind: "redact", text: "",
      redactId: message.serverId, reason, state: "queued", createdAt: Date.now(),
    };
  }

  async function confirmDelete(message: Message | undefined): Promise<void> {
    if (message?.conversationId === NOTES_CONVERSATION_ID) {
      try { await notes.remove(message.serverId!); } catch (error) { ui.sendError = error instanceof Error ? error.message : "Could not delete the note."; }
      return;
    }
    if (!message || !rs.outbox || !rs.scope) return;
    // Frozen ownership/target checks; the row itself stays until the server REDACT lands.
    if (!canDelete(message) || !rs.authorized.some((entry) => entry.conversationId === message.conversationId)) {
      hint("That message can no longer be deleted.");
      return;
    }
    const operation: Operation = { ...redactOperation(message, isOwn(message) ? "deleted by author" : "deleted by admin"), kind: deleteKind(message) };
    try {
      await rs.outbox.enqueueRedact(operation);
    } catch {
      ui.sendError = "Could not queue the delete. The message is still here.";
    }
  }

  async function retryRedact(message: Message): Promise<void> {
    const entry = redactFor(message);
    if (!entry || !rs.outbox || !rs.scope || !canDelete(message)) return;
    try {
      if (entry.state === "uncertain") {
        await rs.outbox.resendUncertain(entry.operationId, { duplicateRiskAccepted: true });
      } else if (entry.state === "failed") {
        const previous = rs.db ? await rs.db.operations.get(entry.operationId) : undefined;
        // Someone else's message retries through the server's moderation route, which also covers an
        // admin whose IRC operator grant has not landed yet.
        const operation: Operation = { ...redactOperation(message, previous?.reason ?? "deleted by author"), kind: isOwn(message) ? "redact" : "admin-redact" };
        await rs.outbox.enqueueRedact(operation);
      }
    } catch {
      ui.sendError = "Could not retry the delete.";
    }
  }

  // --- Thread deletion -----------------------------------------------------------------------

  // A deleted thread leaves this client: its grant and conversation go, and an open view returns
  // to the parent. Runs for the person deleting and, through the KICK, for everyone else.
  function forgetThread(thread: ThreadGrant): void {
    const id = thread.conversationId;
    if (!ui.threads.some((item: ThreadGrant) => item.conversationId === id)) return;
    ui.threads = ui.threads.filter((item: ThreadGrant) => item.conversationId !== id);
    rs.authorized = rs.authorized.filter((item) => item.conversationId !== id);
    rs.directories.delete(id);
    rs.sync?.ensure(rs.authorized);
    if (rs.roomId !== id) return;
    const direct = ui.directs.find((entry: any) => foldIdentifier(entry.channel) === foldIdentifier(thread.parent));
    rs.navIntent += 1;
    nav.open(direct ? { kind: "dm", nick: direct.nick } : { kind: "room", room: thread.parent });
  }

  // --- Message editing -----------------------------------------------------------------------

  function isOwn(message: Message | null | undefined): boolean {
    return canEditMessage(message, ui.account);
  }

  // Helpers and updates post from bot accounts everywhere; a managed bot shows as a bot member row.
  // Agents are members of kind "agent", so they never match.
  const editableBotNicks: readonly string[] = [...HELPER_NICKS, UPDATES_NICK];

  function isEditableBot(nick: string): boolean {
    return editableBotNicks.includes(foldIdentifier(nick)) || isBotRow(ui.roomMemberRows, nick);
  }

  function isBotEdit(message: Message | null | undefined): boolean {
    return !isOwn(message) && canAdminEditBotMessage(message, !!ui.isAdmin, isEditableBot);
  }

  function canEdit(message: Message | null | undefined): boolean {
    return isOwn(message) || isBotEdit(message);
  }

  function canDelete(message: Message | null | undefined): boolean {
    return canDeleteMessage(message, ui.account, !!ui.isAdmin);
  }

  // The author deletes over IRC. So does an admin where they are a channel operator; elsewhere an
  // admin's delete goes through the server's moderation route.
  function deleteKind(message: Message): "redact" | "admin-redact" {
    if (isOwn(message)) return "redact";
    const conversation = rs.authorized.find((entry) => entry.conversationId === message.conversationId);
    return adminDeletesOverIrc(conversation, ui.threads) ? "redact" : "admin-redact";
  }

  // Quote uses the IRC-readable `> nick: text` shape, preserves the existing draft, and focuses
  // the composer. The resulting multiline text sends through the validated durable path.
  function quoteMessage(message: Message): void {
    if (ui.editingMessageId) return;
    const line = (message.text || "").split("\n")[0]!.slice(0, 140);
    const quote = `> ${message.authorNick}: ${line}\n`;
    const current = String(ui.composer ?? "");
    const next = current.startsWith(quote) ? current : quote + current;
    ui.composer = next;
    if (rs.roomId) rs.composerTextByConversation.set(rs.roomId, next);
    rs.composer?.edit(next);
    editor().resizeComposer();
    editor().focusComposer();
  }

  function startEdit(message: Message): void {
    if (!canEdit(message) || !message.serverId) return;
    if (ui.editingMessageId && ui.editServerId !== message.serverId) cancelEdit();
    // Freeze the target and remember the draft this edit replaces so Escape can put it back.
    ui.editSavedText = String(ui.composer ?? "");
    ui.editSavedRevision = rs.composer?.revision ?? null;
    const split = splitInlineMedia(message.text, instance);
    ui.editAttachments = split.attachments;
    ui.editingMessageId = message.id;
    ui.editServerId = message.serverId;
    ui.editConversationId = message.conversationId;
    ui.sendError = "";
    actions().actionMessageId = "";
    ui.composer = split.text;
    editor().resizeComposer();
    editor().focusComposer();
  }

  function endEdit(restoreSaved: boolean): void {
    if (restoreSaved) {
      ui.composer = ui.editSavedText;
      if (rs.composer) { rs.composer.text = ui.editSavedText; rs.composer.revision = ui.editSavedRevision; }
    }
    ui.editingMessageId = "";
    ui.editAttachments = [];
    ui.editServerId = "";
    ui.editConversationId = "";
    ui.editSavedRevision = null;
    ui.sendError = "";
    editor().resizeComposer();
  }

  function cancelEdit(): void {
    if (!ui.editingMessageId) return;
    endEdit(true);
  }

  async function saveEdit(): Promise<boolean> {
    if (ui.editConversationId === NOTES_CONVERSATION_ID) return saveNoteEdit();
    if (!rs.outbox || !rs.scope || !rs.db) return false;
    const targetId = ui.editConversationId;
    const targetServerId = ui.editServerId;
    const targetAccount = rs.scope.account;
    const targetScopeKey = rs.currentScope;
    const targetDb = rs.db;
    const targetOutbox = rs.outbox;
    if (!targetId || !targetServerId) return false;
    ui.composer = closeUnclosedCodeFence(String(ui.composer ?? ""));
    const body = String(ui.composer).trim();
    const text = emojiText([...(body ? [body] : []), ...ui.editAttachments].join("\n"), emoji().custom);
    const check = validateMultiline(text.split("\n"));
    if (!check.ok) { hint(check.error ?? "Cannot save that edit."); return false; }
    // Re-check against the live projection: the message may have been deleted, replaced, or the
    // room/account may have changed while the user typed.
    const message = ui.messages.find((item: Message) => item.serverId === targetServerId);
    const asBot = !!message && isBotEdit(message);
    if (!rs.directories.has(targetId) || !message || !(canEditMessage(message, targetAccount) || asBot)) {
      hint("That message can no longer be edited.");
      return false;
    }
    ui.sendError = "";
    if (asBot) return saveBotEdit(message, text);
    const queued = queuedTextFor(targetId, targetAccount, { text, revision: randomId() }, randomId(), Date.now(), undefined, targetServerId);
    try {
      await targetOutbox.enqueueText(queued);
    } catch {
      // Durable commit failed: keep the edit text and editing state so it is not silently lost.
      ui.sendError = "Could not save the edit. Your text is still here.";
      return false;
    }
    if (rs.db !== targetDb || rs.currentScope !== targetScopeKey || rs.scope?.account !== targetAccount) return false;
    // Restore the pre-edit draft so saving an edit never discards it.
    endEdit(true);
    editor().resizeComposer();
    transcript().scrollToBottom(true);
    return true;
  }

  // An admin's edit of a bot message goes out from the bot's account on the server. The replacement
  // and the original's REDACT then reach every client over IRC like any other edit.
  async function saveBotEdit(message: Message, text: string): Promise<boolean> {
    const conversation = rs.authorized.find((entry) => entry.conversationId === message.conversationId);
    if (!rs.scope || !conversation) { hint("That message can no longer be edited."); return false; }
    try {
      const response = await fetch("/api/messages/bot-edit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Slirc-Edit": "1" },
        body: JSON.stringify({ channel: conversation.wireTarget, msgid: message.serverId, bot: message.authorAccount || message.authorNick, text, accountId: rs.scope.accountId }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: unknown; error?: unknown };
      if (!response.ok || body.ok !== true) {
        ui.sendError = `Could not save the edit${typeof body.error === "string" ? `: ${body.error}` : ""}. Your text is still here.`;
        return false;
      }
    } catch {
      ui.sendError = "Could not save the edit. Your text is still here.";
      return false;
    }
    endEdit(true);
    editor().resizeComposer();
    return true;
  }

  // A note edit replaces the text in place; the pre-edit draft comes back, as with messages.
  async function saveNoteEdit(): Promise<boolean> {
    const id = ui.editServerId;
    const text = closeUnclosedCodeFence(String(ui.composer ?? "")).trim();
    if (!id || !text) return false;
    ui.sendError = "";
    try { await notes.save(id, text); } catch (error) {
      ui.sendError = error instanceof Error ? error.message : "Could not save the edit. Your text is still here.";
      return false;
    }
    if (ui.editServerId !== id) return true;
    endEdit(true);
    return true;
  }

  return { redactFor, redactLabel, confirmDelete, retryRedact, forgetThread, canEdit, canDelete, quoteMessage, startEdit, cancelEdit, saveEdit, editingMedia, removeEditingMedia };
}
