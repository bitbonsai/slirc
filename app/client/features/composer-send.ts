import { emojiText } from "@client/emoji.ts";
import { conversationId, foldIdentifier, type Draft } from "@client/model.ts";
import { SendRefusedError } from "@client/outbox.ts";
import { NOTES_CONVERSATION_ID } from "@client/navigation.ts";
import { closeUnclosedCodeFence } from "@client/render.ts";
import { parseSlash } from "@client/commands.ts";
import { randomId, validateMultiline, validateText } from "@client/protocol.ts";
import { queuedTextFor } from "@client/drafts.ts";
import { pollPrefill, type createPolls } from "@client/polls.ts";
import { mentionedHelpers, mentionedPeople, type createAddPrompts } from "@client/add-prompts.ts";
import type { createComposerEditor } from "@client/composer-editor.ts";
import type { createMediaSender } from "@client/media-send.ts";
import type { createNotes } from "@client/notes.ts";
import type { createTranscript } from "@client/transcript.ts";
import type { createTypingIndicators } from "@client/typing.ts";
import type { createEmojiPicker } from "@client/emoji-picker.ts";
import type { createView } from "@client/view.ts";
import type { AuthorizedConversation } from "@client/sync.ts";
import type { ClientDatabase } from "@client/db.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface ComposerSendDeps {
  state: Pick<RuntimeState, "authorized" | "bridge" | "capsOk" | "composer" | "composerTextByConversation" | "currentScope" | "db" | "outbox" | "roomId" | "scope" | "signingOut" | "stopped">;
  ui: Pick<ClientState, "channelDetails" | "composer" | "consent" | "directs" | "draftNote" | "editingMessageId" | "error" | "helpers" | "media" | "mediaBusy" | "mediaCompress" | "notesOpen" | "pendingThread" | "sendEnabled" | "sendError" | "threadCommandBusy">;
  mediaSender: ReturnType<typeof createMediaSender>;
  notes: ReturnType<typeof createNotes>;
  editor: () => ReturnType<typeof createComposerEditor>;
  transcript: () => ReturnType<typeof createTranscript>;
  typing: () => ReturnType<typeof createTypingIndicators>;
  polls: () => ReturnType<typeof createPolls>;
  emoji: () => ReturnType<typeof createEmojiPicker>;
  addPrompts: () => ReturnType<typeof createAddPrompts>;
  runSlash: (input: { name: string; argument: string }) => Promise<void>;
  saveEdit: () => Promise<boolean>;
  hint: (text: string) => void;
  runRemind: (argument: string, fireAt?: number) => Promise<void>;
  activeConversation: () => AuthorizedConversation | undefined;
  runPollVote: (channel: string, option: number) => Promise<void>;
  updateDraftNavigation: (draft: Draft) => void;
  sendMedia: () => Promise<void>;
  isLocallyEnqueueable: (id: string) => boolean;
  refreshDrafts: (expectedDb?: ClientDatabase | null) => Promise<void>;
  isGroupRoom: (wireTarget: string) => boolean;
}

export function createComposerSend(deps: ComposerSendDeps) {
  const { state: rs, ui, mediaSender, notes, editor, transcript, typing, polls, emoji, addPrompts, runSlash, saveEdit, hint, runRemind, activeConversation, runPollVote, updateDraftNavigation, sendMedia, isLocallyEnqueueable, refreshDrafts, isGroupRoom } = deps;

  function canSend(): boolean {
    const hasContent = !!ui.composer.trim() || !!ui.media;
    return hasContent && ui.sendEnabled && rs.capsOk && !(rs.composer?.committing ?? false) && !ui.mediaBusy && !ui.mediaCompress;
  }

  // A note never reaches IRC: no outbox, and the only slash command is /giphy, whose pick is saved
  // as a note. Any other slash text is kept as written. The draft clears only once saved.
  async function sendNote(): Promise<void> {
    const targetComposer = rs.composer;
    const targetDb = rs.db;
    if (!targetComposer || (!String(ui.composer ?? "").trim() && !ui.media)) return;
    const slash = ui.media ? null : parseSlash(String(ui.composer ?? ""));
    if (slash?.name === "giphy") {
      ui.composer = "";
      targetComposer.edit("");
      editor().resizeComposer();
      await runSlash(slash);
      return;
    }
    ui.sendError = "";
    // Staged photos upload with the save and join the body as URL lines, as a photo message does.
    const store = (text: string) => mediaSender.saveNote(async (urls) => { await notes.add([text, ...urls].filter(Boolean).join("\n")); });
    const saving = targetComposer.snapshot()
      ? targetComposer.commit(async (snapshot) => {
        await store(closeUnclosedCodeFence(snapshot.text).trim());
        // Only the revision this note was built from may be cleared; a newer edit survives.
        const draft = await targetDb?.drafts.get(NOTES_CONVERSATION_ID).catch(() => undefined);
        if (draft?.revision === snapshot.revision) await targetDb?.drafts.delete(NOTES_CONVERSATION_ID).catch(() => {});
      })
      : store("").then(() => true);
    const saved = await saving.catch((error) => {
      if (ui.notesOpen) ui.sendError = error instanceof Error ? error.message : "Could not save the note. It stays in the box.";
      return false;
    });
    if (!saved || rs.composer !== targetComposer) return;
    ui.composer = targetComposer.text;
    rs.composerTextByConversation.set(NOTES_CONVERSATION_ID, targetComposer.text);
    ui.draftNote = "";
    editor().resizeComposer();
    transcript().scrollToBottom(true);
  }

  async function send(): Promise<void> {
    if (ui.threadCommandBusy) return;
    // A thread still being created holds the reply; it sends from the thread once the server answers.
    if (ui.pendingThread) { if (String(ui.composer ?? "").trim()) ui.pendingThread.sendOnReady = true; return; }
    typing().stopTyping();
    // An active edit saves the replacement; it is never routed as a new message or a slash command.
    if (ui.editingMessageId) { await saveEdit(); return; }
    if (ui.notesOpen) { await sendNote(); return; }
    // Slash input never reaches the wire as literal text: a known command runs, an unknown one
    // reports locally.
    const slash = parseSlash(String(ui.composer ?? ""));
    if (slash) {
      // Running a command consumes the draft, exactly as pressing Enter on a message does.
      ui.composer = "";
      rs.composer?.edit("");
      editor().resizeComposer();
      await runSlash(slash);
      return;
    }
    // A message that starts with @remind is a private reminder, the same as /remind: it is not posted
    // in the conversation, and the confirmation shows as a notice.
    const remindAsk = /^@remind\b[\s,:]*([\s\S]*)$/i.exec(String(ui.composer ?? "").trim());
    if (remindAsk) {
      const request = remindAsk[1]!.trim();
      if (!request) { hint("When should I remind you? Try @remind in 20m stretch."); return; }
      ui.composer = "";
      rs.composer?.edit("");
      editor().resizeComposer();
      await runRemind(request);
      return;
    }
    // `@poll 2` is a vote. It goes to the server, not the channel, so only the voter sees the pick.
    const pollVote = /^@poll[\s,:]+#?(\d{1,2})\.?$/i.exec(String(ui.composer ?? "").trim());
    const voteRoom = activeConversation();
    if (pollVote && ui.helpers.includes("poll") && voteRoom?.kind === "room") {
      ui.composer = "";
      rs.composer?.edit("");
      editor().resizeComposer();
      await runPollVote(voteRoom.wireTarget, Number(pollVote[1]));
      return;
    }
    // A new poll the helper would refuse ("@poll lunch") is not sent: the New poll dialog opens with
    // what it said, at the first field to fix. Bare `@poll` opens it empty.
    const pollFix = ui.helpers.includes("poll") && polls().canCreate() ? pollPrefill(String(ui.composer ?? "")) : null;
    if (pollFix) {
      ui.composer = "";
      rs.composer?.edit("");
      editor().resizeComposer();
      polls().openDialog(document.querySelector("#input"), pollFix);
      return;
    }
    const draftText = String(ui.composer ?? "");
    const closedText = closeUnclosedCodeFence(draftText);
    if (closedText !== draftText) {
      ui.composer = closedText;
      rs.composer?.edit(closedText);
      if (rs.roomId) rs.composerTextByConversation.set(rs.roomId, closedText);
      if (rs.composer && rs.roomId) updateDraftNavigation({ conversationId: rs.roomId, revision: rs.composer.revision ?? "", text: closedText, updatedAt: Date.now() });
    }
    if (!rs.outbox || !rs.composer || !rs.roomId || !rs.scope) return;
    if (ui.media) { await sendMedia(); return; }
    const targetId = rs.roomId;
    const targetScope = rs.scope;
    const targetDb = rs.db;
    const targetScopeKey = rs.currentScope;
    const targetComposer = rs.composer;
    const targetOutbox = rs.outbox;
    const rawText = String(ui.composer ?? "");
    // A quote/caption is multiline; validate it as such so it reaches the durable multiline path
    // instead of failing the single-line control-character check.
    const wireText = emojiText(rawText, emoji().custom);
    const check = wireText.includes("\n") ? validateMultiline(wireText.split("\n")) : validateText(wireText);
    if (!check.ok) {
      hint(check.error ?? "Cannot send that.");
      return;
    }
    if (rawText.includes("\n") && !rs.bridge?.enabled.has("draft/multiline")) {
      hint("This server cannot send multiline messages.");
      return;
    }
    ui.sendError = "";
    let committedRevision = "";
    const messageId = randomId();
    const sent = await targetComposer.commit(async (snapshot) => {
      if (rs.stopped || rs.signingOut || rs.db !== targetDb || rs.scope !== targetScope || rs.currentScope !== targetScopeKey || !isLocallyEnqueueable(targetId)) throw new SendRefusedError("conversation is no longer authorized");
      committedRevision = snapshot.revision;
      const queued = queuedTextFor(targetId, targetScope.account, { ...snapshot, text: emojiText(snapshot.text, emoji().custom) }, messageId, Date.now());
      await targetOutbox.enqueueText(queued);
      await refreshDrafts(targetDb);
    }).catch(() => {
      if (rs.roomId === targetId && rs.db === targetDb && rs.scope === targetScope && rs.currentScope === targetScopeKey) ui.sendError = "Could not save your message. It stays in the box.";
      return false;
    });
    if (rs.db !== targetDb || rs.scope !== targetScope || rs.currentScope !== targetScopeKey) return;
    rs.composerTextByConversation.set(targetId, targetComposer.text);
    if (!sent) return;
    offerMentionPrompts(targetId, messageId, rawText);
    if (rs.roomId === targetId && rs.composer && rs.composer !== targetComposer && rs.composer.revision === committedRevision) {
      rs.composer.text = ""; rs.composer.revision = null; ui.composer = "";
    } else if (rs.composer === targetComposer && rs.roomId === targetId) {
      ui.composer = targetComposer.text;
    }
    if (rs.roomId === targetId) {
      rs.composerTextByConversation.set(targetId, rs.composer?.text ?? "");
      ui.draftNote = "";
      editor().resizeComposer();
      transcript().scrollToBottom(true);
    }
  }

  // A helper mentioned where it isn't a member gets an inline Add under the message. Its own DM is
  // where it already listens, so that never asks. A person gets the same note, in channels only.
  function offerMentionPrompts(conversationId: string, messageId: string, text: string): void {
    const item = rs.authorized.find((entry) => entry.conversationId === conversationId);
    if (!item) return;
    const peer = item.kind === "dm" ? ui.directs.find((direct: { channel: string }) => direct.channel === item.wireTarget)?.nick ?? "" : "";
    const place = item.kind === "dm" ? "dm" : item.kind === "thread" ? "thread" : isGroupRoom(item.wireTarget) ? "group" : "channel";
    const title = place === "group" ? ui.channelDetails.find((detail: { channel: string; topic?: string }) => detail.channel === item.wireTarget)?.topic : undefined;
    for (const nick of mentionedHelpers(text)) {
      // A helper this instance does not run never gets a note.
      if (foldIdentifier(peer) === nick || !ui.helpers.includes(nick)) continue;
      void addPrompts().offer({ conversationId, channel: item.wireTarget, place, title, nick, messageId, announce: false });
    }
    if (place !== "channel") return;
    for (const nick of mentionedPeople(text)) {
      void addPrompts().offer({ conversationId, channel: item.wireTarget, place, nick, messageId, announce: false, person: true });
    }
  }

  async function resend(operationId: string): Promise<void> {
    if (!rs.outbox || !ui.consent[operationId]) return;
    try {
      await rs.outbox.resendUncertain(operationId, { duplicateRiskAccepted: true });
    } catch (error) {
      ui.error = error instanceof Error ? error.message : "Could not resend.";
    }
  }

  async function cancel(operationId: string): Promise<void> {
    if (!rs.outbox) return;
    await rs.outbox.cancel(operationId).catch(() => {});
  }

  return { canSend, send, resend, cancel };
}
