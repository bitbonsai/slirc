import { emojiText } from "@client/emoji.ts";
import { conversationId, scopeKey } from "@client/model.ts";
import { NOTES_CONVERSATION_ID } from "@client/navigation.ts";
import { createMediaSender, draftPhotos, pastedImages, type StagedMedia } from "@client/media-send.ts";
import { canCompressVideo, compressVideo, loadVideoEncoder } from "@client/video-compress.ts";
import { bytesToBase64, randomId, validateMultiline } from "@client/protocol.ts";
import { queuedTextFor } from "@client/drafts.ts";
import type { createComposerEditor } from "@client/composer-editor.ts";
import type { createEmojiPicker } from "@client/emoji-picker.ts";
import type { createTranscript } from "@client/transcript.ts";
import type { ClientDatabase } from "@client/db.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface MediaUploadDeps {
  state: Pick<RuntimeState, "authorized" | "bridge" | "composer" | "composerTextByConversation" | "currentScope" | "db" | "directories" | "outbox" | "roomId" | "scope" | "stopped">;
  ui: Pick<ClientState, "composer" | "draftNote" | "dragActive" | "editingMessageId" | "media" | "mediaBusy" | "mediaCompress" | "mediaError" | "notesOpen" | "pendingDm" | "pendingThread">;
  emoji: () => ReturnType<typeof createEmojiPicker>;
  editor: () => ReturnType<typeof createComposerEditor>;
  transcript: () => ReturnType<typeof createTranscript>;
  refreshDrafts: (expectedDb?: ClientDatabase | null) => Promise<void>;
}

export function createMediaUpload(deps: MediaUploadDeps) {
  const { state: rs, ui, emoji, editor, transcript, refreshDrafts } = deps;

  async function uploadMedia({ channel, kind, mime, data, accountId, width, height }: { channel: string; kind: "image" | "video"; mime: string; data: string; accountId: string; width?: number; height?: number }): Promise<string> {
    const response = await fetch("/api/uploads", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, kind, mime, data, accountId, ...(width && height ? { width, height } : {}) }),
    });
    const body = await response.json().catch(() => ({})) as { url?: unknown; error?: unknown };
    if (!response.ok || typeof body.url !== "string") {
      throw new Error(typeof body.error === "string" ? body.error : `Upload failed (${response.status})`);
    }
    return body.url;
  }

  // A video's pixel size, read from its metadata so the message reserves the clip's frame before it
  // loads. The server never decodes videos; a clip that will not report a size still uploads.
  async function probeVideoDims(file: File): Promise<{ width: number; height: number } | null> {
    const url = URL.createObjectURL(file);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      const metadata = new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("video metadata failed"));
        timer = setTimeout(() => reject(new Error("video metadata timed out")), 4_000);
      });
      video.src = url;
      await metadata;
      return video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
  }

  // Shows the video being compressed as a chip with its percent, which its × cancels.
  async function compressStagedVideo(file: File, signal: AbortSignal): Promise<File | null> {
    const objectUrl = URL.createObjectURL(file);
    const mine = () => ui.mediaCompress?.objectUrl === objectUrl;
    ui.mediaCompress = { name: file.name || "video", objectUrl, percent: 0 };
    try {
      return await compressVideo(file, {
        signal,
        load: loadVideoEncoder,
        onProgress: (fraction) => {
          const percent = Math.min(99, Math.floor(fraction * 100));
          if (mine() && ui.mediaCompress!.percent !== percent) ui.mediaCompress = { ...ui.mediaCompress!, percent };
        },
      });
    } finally {
      if (mine()) ui.mediaCompress = null;
      URL.revokeObjectURL(objectUrl);
    }
  }

  // Media staging/sending controller. Accessors keep it reading the live scope, so a navigate or
  // account switch between awaits is observed rather than captured stale.
  const mediaSender = createMediaSender({
    scopeKey: () => (rs.scope ? rs.currentScope : null),
    accountId: () => rs.scope?.accountId ?? null,
    authorAccount: () => rs.scope?.account ?? null,
    roomId: () => rs.roomId,
    database: () => rs.db,
    outbox: () => rs.outbox,
    isAuthorized: (id) => id === NOTES_CONVERSATION_ID || rs.directories.has(id),
    wireChannel: (id) => rs.authorized.find((entry) => entry.conversationId === id)?.wireTarget,
    media: () => ui.media,
    setMedia: (media) => { ui.media = media; },
    busy: () => ui.mediaBusy,
    setBusy: (value) => { ui.mediaBusy = value; },
    setError: (message) => { ui.mediaError = message; },
    revoke: (objectUrl) => URL.revokeObjectURL(objectUrl),
    readBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
    videoDims: probeVideoDims,
    ...(canCompressVideo() ? { compressVideo: compressStagedVideo } : {}),
    upload: uploadMedia,
    encode: bytesToBase64,
    origin: () => location.origin,
    buildQueueText: ({ conversationId, author, text, draftRevision, mediaRevision, createdAt }) =>
      queuedTextFor(conversationId, author, { text: emojiText(text, emoji().custom), revision: draftRevision }, randomId(), createdAt, mediaRevision),
    caption: () => ({ text: String(ui.composer ?? "").trim(), revision: rs.composer?.revision ?? randomId() }),
    validateCaption: (text) => {
      if (text.includes("\n") && !rs.bridge?.enabled.has("draft/multiline")) throw new Error("This server cannot send a caption with a photo.");
      const check = validateMultiline(emojiText(text, emoji().custom).split("\n"));
      if (!check.ok) throw new Error(check.error ?? "Cannot send that caption.");
    },
    validateMessage: (text) => {
      if (text.includes("\n") && !rs.bridge?.enabled.has("draft/multiline")) throw new Error("This server cannot send several lines in one message.");
      const check = validateMultiline(emojiText(text, emoji().custom).split("\n"));
      if (!check.ok) throw new Error(check.error ?? "Cannot send that message.");
    },
    clearCaption: (revision) => {
      if (rs.composer && rs.composer.revision === revision) { rs.composer.text = ""; rs.composer.revision = null; ui.composer = ""; }
    },
    onSent: (conversationId) => {
      // Always clear the remembered draft for the recipient, even if the visible room moved on
      // mid-send; otherwise returning to the room resurrects an already-sent caption.
      rs.composerTextByConversation.set(conversationId, "");
      void refreshDrafts();
      if (rs.roomId !== conversationId) return;
      ui.draftNote = "";
      editor().resizeComposer();
      transcript().scrollToBottom(true);
    },
    randomId,
    now: () => Date.now(),
  });

  // The Giphy component owns the selection index; the composer forwards arrow intents as events.

  // --- Photo staging -------------------------------------------------------------------------

  function revokeMedia(media: StagedMedia | null): void {
    for (const photo of media?.photos ?? []) URL.revokeObjectURL(photo.objectUrl);
  }

  function pickMedia(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    addFiles(files);
  }

  async function removeMedia(index: number): Promise<void> {
    await mediaSender.remove(index);
  }

  function cancelCompress(): void {
    mediaSender.cancelCompress();
  }

  function pasteMedia(event: ClipboardEvent): void {
    addFiles(pastedImages(event.clipboardData));
  }

  // Picked, pasted and dropped images all land here and are staged, never auto-sent. A note
  // uploads them when it is saved. A pending DM has no membership yet, so it takes text only for
  // now, and editing a note stays text-only.
  function addFiles(files: File[]): void {
    if (files.length && !ui.pendingDm && !ui.pendingThread && !(ui.notesOpen && ui.editingMessageId)) void mediaSender.stage(files);
  }

  // Only file drags are ours; text dragged inside the composer keeps the browser's own drop.
  function carriesFiles(event: DragEvent): boolean {
    return [...(event.dataTransfer?.types ?? [])].includes("Files");
  }

  function onDragOver(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    // Offer the drop rather than letting the browser open the file over the app.
    event.preventDefault();
    ui.dragActive = true;
  }

  function onDragLeave(event: DragEvent): void {
    if (event.relatedTarget && (event.currentTarget as Node).contains(event.relatedTarget as Node)) return;
    ui.dragActive = false;
  }

  function onDrop(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    ui.dragActive = false;
    addFiles([...(event.dataTransfer?.files ?? [])]);
  }

  async function restoreMediaDraft(id: string): Promise<void> {
    const selectedDb = rs.db;
    if (!selectedDb) return;
    const draft = await selectedDb.mediaDrafts.get(id);
    if (rs.db !== selectedDb || rs.roomId !== id || rs.stopped) return;
    if (!draft) return; // nothing to restore; never clear a newer in-memory stage
    // A photo staged while the read was in flight wins.
    if (ui.media) return;
    const photos = draftPhotos(draft).map((photo) => ({ ...photo, objectUrl: URL.createObjectURL(new Blob([photo.bytes], { type: photo.mime })) }));
    if (photos.length) ui.media = { revision: draft.revision, photos };
  }

  async function sendMedia(): Promise<void> {
    // The controller owns capture/freeze/revalidate and the durable enqueue; the page only wires
    // its state in.
    await mediaSender.send();
  }

  return { mediaSender, revokeMedia, pickMedia, removeMedia, cancelCompress, pasteMedia, onDragOver, onDragLeave, onDrop, restoreMediaDraft, sendMedia };
}
