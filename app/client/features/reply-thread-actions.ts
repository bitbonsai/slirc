import { emojiText } from "@client/emoji.ts";
import { conversationId, foldIdentifier, type Message } from "@client/model.ts";
import type { ReplyThreadItem, createReplyThreadList } from "@client/reply-thread-list.ts";
import { validateMultiline, validateText } from "@client/protocol.ts";
import { pendingThreadFallbackText } from "@client/threads.ts";
import { broadcastParent, buildReplyIndex, replyThreadReplies, replyThreadRoot, replyThreadSummary, type ReplyThreadSummary } from "@client/reply-threads.ts";
import type { createMessageActions } from "@client/message-actions.ts";
import type { createMembersPanel } from "@client/members-panel.ts";
import type { createTranscript } from "@client/transcript.ts";
import type { createEmojiPicker } from "@client/emoji-picker.ts";
import type { createComposerEditor } from "@client/composer-editor.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface ReplyThreadActionsDeps {
  state: Pick<RuntimeState, "authorized" | "bridge" | "composer" | "composerTextByConversation" | "outbox" | "roomId" | "scope">;
  ui: Pick<ClientState, "activeThread" | "composer" | "currentConversationId" | "messages" | "notesOpen" | "pendingThread" | "replyThreadBroadcast" | "replyThreadDraft" | "replyThreadError" | "replyThreadFaded" | "replyThreadRootId" | "roomLabel">;
  nextTick: (callback?: () => void) => unknown;
  actions: () => ReturnType<typeof createMessageActions>;
  members: () => ReturnType<typeof createMembersPanel>;
  replyThreads: () => ReturnType<typeof createReplyThreadList>;
  transcript: () => ReturnType<typeof createTranscript>;
  emoji: () => ReturnType<typeof createEmojiPicker>;
  editor: () => ReturnType<typeof createComposerEditor>;
  openDirect: (nick: string) => Promise<void>;
  openRoom: (room?: string) => void;
  queueConversationText: (conversationId: string, text: string, options?: { replyTo?: string; broadcast?: boolean }) => Promise<void>;
}

export function createReplyThreadActions(deps: ReplyThreadActionsDeps) {
  const { state: rs, ui, nextTick, actions, members, replyThreads, transcript, emoji, editor, openDirect, openRoom, queueConversationText } = deps;

  function replyThreadSummaryFor(message: Message | null | undefined): ReplyThreadSummary | null {
    if (!message || ui.activeThread || ui.notesOpen) return null;
    return replyThreadSummary(buildReplyIndex(ui.messages), message);
  }

  function replyThreadBroadcastParent(message: Message | null | undefined): Message | null {
    if (!message || ui.activeThread || ui.notesOpen) return null;
    return broadcastParent(buildReplyIndex(ui.messages), message);
  }

  function openReplyThread(target: Message | string | null | undefined): void {
    const rootId = typeof target === "string" ? target : target?.serverId;
    if (!rootId || ui.activeThread || ui.notesOpen) return;
    actions().closeActions();
    if (members().open) members().dismiss();
    ui.replyThreadRootId = rootId;
    ui.replyThreadFaded = { ...ui.replyThreadFaded, [rootId]: true };
    ui.replyThreadError = "";
    void replyThreads().refresh();
    void nextTick(() => {
      const focusInput = () => {
        if (ui.replyThreadRootId !== rootId) return;
        const stream = document.querySelector<HTMLElement>("#reply-thread-stream");
        if (stream) stream.scrollTop = stream.scrollHeight;
        document.querySelector<HTMLTextAreaElement>("#reply-thread-input")?.focus({ preventScroll: true });
      };
      focusInput();
      requestAnimationFrame(focusInput);
    });
  }

  // A row in the THREADS group: show its channel or DM, then the thread over it.
  function showReplyThread(entry: ReplyThreadItem): void {
    const item = rs.authorized.find((candidate) => candidate.kind !== "thread" && foldIdentifier(candidate.wireTarget) === foldIdentifier(entry.channel));
    if (!item) return;
    if (ui.currentConversationId !== item.conversationId) {
      if (item.kind === "dm" && entry.nick) void openDirect(entry.nick); else openRoom(item.wireTarget);
    }
    let tries = 0;
    const open = () => {
      if (ui.currentConversationId === item.conversationId) openReplyThread(entry.rootId);
      else if ((tries += 1) < 40) setTimeout(open, 50);
    };
    open();
  }

  function closeReplyThread(): void {
    ui.replyThreadRootId = "";
    ui.replyThreadDraft = "";
    ui.replyThreadBroadcast = false;
    ui.replyThreadError = "";
    document.body.classList.toggle("reply-thread-docked", false);
  }

  // Phone back arrow (and the iOS edge swipe that presses it): back to the channel, at the parent.
  function backFromReplyThread(): void {
    const rootId = ui.replyThreadRootId;
    closeReplyThread();
    if (rootId) transcript().focus(rootId);
  }

  function activeReplyThreadRoot(): Message | null {
    if (!ui.replyThreadRootId) return null;
    return replyThreadRoot(buildReplyIndex(ui.messages), ui.replyThreadRootId);
  }

  function activeReplyThreadReplies(): Message[] {
    if (!ui.replyThreadRootId) return [];
    return replyThreadReplies(buildReplyIndex(ui.messages), ui.replyThreadRootId);
  }

  function replyThreadKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeReplyThread();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendReplyThread();
    }
  }

  async function sendReplyThread(): Promise<void> {
    const root = activeReplyThreadRoot();
    const rootId = root?.serverId ?? ui.replyThreadRootId;
    if (!rootId || !rs.roomId || !rs.outbox || !rs.scope) return;
    const raw = String(ui.replyThreadDraft ?? "").trim();
    if (!raw) return;
    const wireText = emojiText(raw, emoji().custom);
    const check = wireText.includes("\n") ? validateMultiline(wireText.split("\n")) : validateText(wireText);
    if (!check.ok) {
      ui.replyThreadError = check.error ?? "Cannot send that reply.";
      return;
    }
    if (raw.includes("\n") && !rs.bridge?.enabled.has("draft/multiline")) {
      ui.replyThreadError = "This server cannot send multiline messages.";
      return;
    }
    ui.replyThreadError = "";
    const broadcast = !!ui.replyThreadBroadcast;
    try {
      await queueConversationText(rs.roomId, raw, { replyTo: rootId, broadcast });
      ui.replyThreadDraft = "";
      ui.replyThreadBroadcast = false;
      void nextTick(() => {
        const stream = document.querySelector<HTMLElement>("#reply-thread-stream");
        if (stream) stream.scrollTop = stream.scrollHeight;
      });
    } catch (error) {
      ui.replyThreadError = error instanceof Error ? error.message : "Could not send reply.";
    }
  }

  // Back to the parent as it was: its label, and its draft with any thread text appended. Runs
  // while the parent is still selected, so `composer` is the parent's.
  function abandonPendingThread(): void {
    const pending = ui.pendingThread;
    if (!pending) return;
    ui.pendingThread = null;
    if (rs.roomId !== pending.conversationId) return;
    ui.roomLabel = pending.roomLabel;
    const text = pendingThreadFallbackText(pending.savedText, String(ui.composer ?? ""));
    ui.composer = text;
    if (text !== pending.savedText) rs.composer?.edit(text);
    rs.composerTextByConversation.set(pending.conversationId, text);
    editor().resizeComposer();
  }

  return { replyThreadSummaryFor, replyThreadBroadcastParent, openReplyThread, showReplyThread, closeReplyThread, backFromReplyThread, activeReplyThreadRoot, activeReplyThreadReplies, replyThreadKeydown, sendReplyThread, abandonPendingThread };
}
