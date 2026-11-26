// Media staging and sending controller. Owns the frozen-capture rules: the destination room,
// account scope, caption revision, and staged-media revision are read before the first await and
// revalidated after every one. Extracted from the Alpine page so the race/rollback paths get
// executable regressions with fake DB/outbox promises, not just helper round-trips.
//
// Durability: the media draft lives in the account-scoped Dexie database. The queued message
// consumes the matching original caption revision and the matching media revision in the same
// db.queueTexts transaction, so a crash cannot leave an enqueued photo offered again, and a newer
// edit or attachment is never wiped. Several photos either share one message or go out as one
// message each, all queued in that single transaction.

import type { ClientDatabase } from "./db.ts";
import type { Outbox } from "./outbox.ts";
import type { MediaDraft, MediaDraftPhoto, QueueText } from "./model.ts";
import { isVideoMime, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, pickAttachment } from "./media.ts";

// Photos one message can carry. Each photo is one URL line, so ten stay well under the wire
// limit with a caption; past that the composer refuses the extra files.
export const MAX_PHOTOS = 10;

// A paste can carry text and files together. Every image is staged like a picked file; the
// composer still inserts the text.
export function pastedImages(data: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] {
  if (!data) return [];
  const files = [...(data.files ?? [])];
  for (const item of data.items ?? []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && !files.includes(file)) files.push(file);
  }
  return files.filter((file) => file.type.startsWith("image/"));
}

// The photos a stored draft holds, including a single-photo row from before photo sets.
export function draftPhotos(draft: MediaDraft | undefined): MediaDraftPhoto[] {
  if (!draft) return [];
  if (draft.photos) return draft.photos;
  if (!draft.bytes || !draft.mime) return [];
  return [{ name: draft.name || "photo", mime: draft.mime, bytes: draft.bytes, ...(draft.uploadedUrl ? { uploadedUrl: draft.uploadedUrl } : {}) }];
}

// One message when the caption and every photo URL fit; otherwise one message per photo in order,
// the caption riding with the first. A single photo that does not fit is refused as before.
export function photoMessages(caption: string, urls: readonly string[], validate: (text: string) => void): string[] {
  const whole = [caption, ...urls].filter(Boolean).join("\n");
  try {
    validate(whole);
    return [whole];
  } catch (error) {
    if (urls.length < 2) throw error;
  }
  const split = urls.map((url, index) => (index === 0 ? [caption, url].filter(Boolean).join("\n") : url));
  for (const text of split) validate(text);
  return split;
}

export interface StagedPhoto {
  name: string;
  mime: string;
  bytes: Uint8Array;
  objectUrl: string;
  uploadedUrl?: string;
  width?: number;
  height?: number;
}

export interface StagedMedia {
  revision: string;
  photos: StagedPhoto[];
}

function storedPhotos(photos: readonly StagedPhoto[]): MediaDraftPhoto[] {
  return photos.map(({ name, mime, bytes, uploadedUrl, width, height }) => ({ name, mime, bytes, ...(uploadedUrl ? { uploadedUrl } : {}), ...(width && height ? { width, height } : {}) }));
}

export interface MediaSenderDeps {
  scopeKey(): string | null;
  accountId(): string | null;
  authorAccount(): string | null;
  roomId(): string | null;
  database(): ClientDatabase | null;
  outbox(): Outbox | null;
  isAuthorized(conversationId: string): boolean;
  wireChannel(conversationId: string): string | undefined;
  media(): StagedMedia | null;
  setMedia(media: StagedMedia | null): void;
  busy(): boolean;
  setBusy(value: boolean): void;
  setError(message: string): void;
  revoke(objectUrl: string): void;
  readBytes(file: File): Promise<Uint8Array>;
  // Re-encodes a picked video smaller before it is staged; null keeps the original. Absent where the
  // browser cannot encode video, and then a video over the upload limit is refused at pick.
  compressVideo?(file: File, signal: AbortSignal): Promise<File | null>;
  // A video's pixel size, which the server cannot read: it stores videos as sent. Used only to
  // reserve the frame before the clip arrives. Null when it cannot be read.
  videoDims?(file: File): Promise<{ width: number; height: number } | null>;
  // Uploads base64 to the server and resolves the server-relative URL. Throws on refusal.
  upload(input: { channel: string; kind: "image" | "video"; mime: string; data: string; accountId: string; width?: number; height?: number }): Promise<string>;
  encode(bytes: Uint8Array): string;
  origin(): string;
  // Builds the durable QueueText; injected so this module does not import the page.
  // `createdAt` orders the messages of a photo set that has to go out one photo per message.
  buildQueueText(input: { conversationId: string; author: string; text: string; draftRevision: string; mediaRevision: string; createdAt: number }): QueueText;
  // The frozen caption and its original draft revision.
  caption(): { text: string; revision: string };
  // Refuse a caption that the wire cannot carry (control chars, size, missing multiline cap).
  validateCaption(text: string): void;
  // Validate one complete message; a URL can push a caption that passed alone over the wire limit,
  // and several lines need draft/multiline.
  validateMessage(text: string): void;
  // Clear the in-memory caption only when it still holds the frozen revision; a newer edit stays.
  clearCaption(revision: string): void;
  // Called after a successful enqueue so the page can scroll/focus for the visible conversation.
  onSent(conversationId: string): void;
  randomId(): string;
  now(): number;
}

export interface MediaSender {
  stage(files: File | readonly File[]): Promise<void>;
  remove(index: number): Promise<void>;
  send(): Promise<void>;
  saveNote(save: (urls: string[]) => Promise<void>): Promise<void>;
  // Drops the video being compressed; the rest of its pick still stages.
  cancelCompress(): void;
}

export function createMediaSender(deps: MediaSenderDeps): MediaSender {
  // Monotonic across concurrent stage() calls so a slow file read cannot clobber a newer stage.
  let stageSeq = 0;
  // Monotonic across send() calls so a stale send's catch/finally cannot clobber a newer one.
  let sendSeq = 0;
  // A send waits for an in-flight stage: the stage is about to replace the set it would freeze.
  let staging = 0;
  // The compression in flight. A pick while it runs is refused: the older stage would lose to the
  // newer one and the video would vanish after its wait.
  let compressing: AbortController | null = null;

  async function stage(input: File | readonly File[]): Promise<void> {
    if (compressing) { deps.setError("Wait for the video to finish compressing, or cancel it."); return; }
    staging += 1;
    try { await stageFiles(Array.isArray(input) ? [...input] : [input as File]); }
    finally { staging -= 1; }
  }

  async function stageFiles(files: File[]): Promise<void> {
    deps.setError("");
    let refusal = "";
    const picked: { file: File; mime: string }[] = [];
    for (const file of files) {
      const check = pickAttachment(file, { compressible: Boolean(deps.compressVideo) });
      if (check.ok) picked.push({ file, mime: check.mime });
      else refusal ||= check.error;
    }
    if (!picked.length) { if (refusal) deps.setError(refusal); return; }
    // Capture the destination BEFORE the async file read; it must not retarget into a new room.
    const scopeKey = deps.scopeKey();
    const roomId = deps.roomId();
    const database = deps.database();
    const accountId = deps.accountId();
    if (!scopeKey || !roomId || !database || !accountId) { deps.setError("Open a conversation first."); return; }
    const seq = ++stageSeq;
    const read: Omit<StagedPhoto, "objectUrl">[] = [];
    try {
      for (const choice of picked) {
        let { file, mime } = choice;
        const video = isVideoMime(mime);
        if (video && deps.compressVideo) {
          const controller = new AbortController();
          compressing = controller;
          let smaller: File | null = null;
          try { smaller = await deps.compressVideo(file, controller.signal); } catch { smaller = null; }
          finally { compressing = null; }
          if (controller.signal.aborted) continue;
          if (smaller) { file = smaller; mime = smaller.type; }
        }
        const bytes = await deps.readBytes(file);
        if (bytes.byteLength > (video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) { refusal ||= video ? "Videos must be under 30 MB." : "Photos must be under 12 MB."; continue; }
        const dims = video && deps.videoDims ? await deps.videoDims(file).catch(() => null) : null;
        read.push({ name: file.name || (video ? "video" : "photo"), mime, bytes, ...(dims ?? {}) });
      }
    } catch {
      deps.setError("Could not read that file.");
      return;
    }
    if (seq !== stageSeq) return; // a newer stage won while this read was in flight
    if (deps.scopeKey() !== scopeKey || deps.roomId() !== roomId || deps.database() !== database) {
      deps.setError("The room changed before the photo was ready. Try again.");
      return;
    }
    // New photos join the staged set, except while that set is sending: the send owns it, so these
    // start a new set that the send's consume leaves alone.
    const previous = deps.busy() ? null : deps.media();
    const kept = previous?.photos ?? [];
    const room = MAX_PHOTOS - kept.length;
    if (read.length > room) refusal ||= `Up to ${MAX_PHOTOS} photos per message.`;
    const added = read.slice(0, Math.max(0, room)).map((photo) => ({ ...photo, objectUrl: URL.createObjectURL(new Blob([photo.bytes], { type: photo.mime })) }));
    if (!added.length) { if (refusal) deps.setError(refusal); return; }
    const revokeAdded = () => { for (const photo of added) deps.revoke(photo.objectUrl); };
    const revision = deps.randomId();
    const photos = [...kept, ...added];
    // Persist to the ORIGINAL scope's database. A quota/transaction failure refuses the stage
    // instead of leaving an in-memory photo that reload cannot restore.
    try {
      await database.mediaDrafts.put({ conversationId: roomId, revision, photos: storedPhotos(photos), updatedAt: deps.now() });
    } catch {
      revokeAdded();
      deps.setError("Could not save the photo for this chat.");
      return;
    }
    if (seq !== stageSeq) { revokeAdded(); return; }
    // Recheck AFTER the persist: the scope/room can change while the write is in flight, and a
    // stale staged photo must not appear in a new room or another account.
    if (deps.scopeKey() !== scopeKey || deps.accountId() !== accountId || deps.roomId() !== roomId || deps.database() !== database) {
      revokeAdded();
      deps.setError("The room changed before the photo was ready. Try again.");
      return;
    }
    const current = deps.media();
    if (current && current !== previous) for (const photo of current.photos) deps.revoke(photo.objectUrl);
    deps.setMedia({ revision, photos });
    if (refusal) deps.setError(refusal);
  }

  // Drop one staged photo. The rest keep their bytes and upload URLs under a new revision; the
  // stored row changes only while it still holds the set being edited.
  async function remove(index: number): Promise<void> {
    const current = deps.media();
    const photo = current?.photos[index];
    if (!current || !photo || deps.busy() || staging) return;
    deps.setError("");
    deps.revoke(photo.objectUrl);
    const photos = current.photos.filter((_, at) => at !== index);
    const next = photos.length ? { revision: deps.randomId(), photos } : null;
    deps.setMedia(next);
    const database = deps.database(), roomId = deps.roomId();
    if (!database || !roomId) return;
    try {
      await database.transaction("rw", database.mediaDrafts, async () => {
        const stored = await database.mediaDrafts.get(roomId);
        if (!stored || stored.revision !== current.revision) return;
        if (next) await database.mediaDrafts.put({ conversationId: roomId, revision: next.revision, photos: storedPhotos(photos), updatedAt: deps.now() });
        else await database.mediaDrafts.delete(roomId);
      });
    } catch { /* the in-memory removal already happened; a stale row is replaced on next stage */ }
  }

  function stillValid(captured: { scopeKey: string; accountId: string; roomId: string; database: ClientDatabase }): boolean {
    return deps.scopeKey() === captured.scopeKey
      && deps.accountId() === captured.accountId
      && deps.database() === captured.database
      && deps.isAuthorized(captured.roomId);
  }

  // Upload once and persist the URL conditionally to the matching media revision, so a later
  // enqueue retry (or reload) reuses it instead of re-uploading or losing it.
  async function uploadOnce(
    media: StagedMedia,
    index: number,
    channel: string,
    captured: { scopeKey: string; accountId: string; roomId: string; database: ClientDatabase },
  ): Promise<string> {
    const photo = media.photos[index]!;
    if (photo.uploadedUrl) return photo.uploadedUrl;
    const kind = isVideoMime(photo.mime) ? "video" : "image";
    const url = await deps.upload({ channel, kind, mime: photo.mime, data: deps.encode(photo.bytes), accountId: captured.accountId, ...(photo.width && photo.height ? { width: photo.width, height: photo.height } : {}) });
    if (!stillValid(captured)) throw new Error("Account changed. Reload before uploading a photo.");
    let absolute: URL;
    try { absolute = new URL(url, deps.origin()); } catch { throw new Error("Upload did not return a valid URL."); }
    if (absolute.origin !== new URL(deps.origin()).origin || !/^\/uploads\/[A-Za-z0-9_-]+$/.test(absolute.pathname)) {
      throw new Error("Upload did not return a valid URL.");
    }
    const withUrl = <T extends { uploadedUrl?: string }>(photos: T[]) => photos.map((item, at) => (at === index ? { ...item, uploadedUrl: absolute.href } : item));
    // Matching-read + conditional write in one Dexie transaction: another tab replacing the row
    // between a plain get and put would otherwise let a stale upload URL win.
    await captured.database.transaction("rw", captured.database.mediaDrafts, async () => {
      const current = await captured.database.mediaDrafts.get(captured.roomId);
      if (current && current.revision === media.revision) {
        await captured.database.mediaDrafts.put({ conversationId: current.conversationId, revision: current.revision, photos: withUrl(draftPhotos(current)), updatedAt: deps.now() });
      }
    });
    const staged = deps.media();
    if (staged?.revision === media.revision) deps.setMedia({ ...staged, photos: withUrl(staged.photos) });
    return absolute.href;
  }

  async function send(): Promise<void> {
    // Synchronous in-flight guard: a repeated Enter cannot start a second upload/enqueue even if
    // the disabled attribute has not painted yet.
    if (deps.busy() || staging) return;
    const media = deps.media();
    if (!media?.photos.length) return;
    const scopeKey = deps.scopeKey();
    const accountId = deps.accountId();
    const author = deps.authorAccount();
    const roomId = deps.roomId();
    const database = deps.database();
    const outbox = deps.outbox();
    if (!scopeKey || !accountId || !author || !roomId || !database || !outbox) return;
    const channel = deps.wireChannel(roomId);
    if (!channel) { deps.setError("This conversation is not ready for photos."); return; }
    // Freeze the caption and both revisions BEFORE the upload; a navigate/edit during the await
    // must not send newer text or a different attachment to this recipient.
    const captured = { scopeKey, accountId, roomId, database };
    const seq = ++sendSeq;
    deps.setBusy(true);
    deps.setError("");
    try {
      const caption = deps.caption();
      // Refuse an unsendable caption before uploading, so the UI never reports success and then
      // fails at the wire (control chars / size / missing draft/multiline).
      if (caption.text) deps.validateCaption(caption.text);
      const urls: string[] = [];
      for (let index = 0; index < media.photos.length; index++) {
        urls.push(await uploadOnce(media, index, channel, captured));
        if (!stillValid(captured)) throw new Error("Conversation is no longer available.");
      }
      // Validate every payload before enqueueing: the URLs can push the message over the wire
      // limit even when the caption alone passed.
      const texts = photoMessages(caption.text, urls, deps.validateMessage);
      const createdAt = deps.now();
      const queued = texts.map((text, index) => deps.buildQueueText({
        conversationId: roomId, author, text,
        // Every message names the frozen caption revision; the shared transaction clears it once.
        draftRevision: caption.revision,
        mediaRevision: media.revision,
        createdAt: createdAt + index,
      }));
      // One durable transaction consumes every message + operation + the original caption draft
      // + the matching media draft. A failed commit leaves the photos staged and reusable.
      await outbox.enqueueTexts(queued);
      if (!stillValid(captured)) return;
      // The durable transaction already consumed the matching drafts; clear the in-memory caption
      // only for the frozen revision, and the staged photos only for the frozen media revision.
      deps.clearCaption(caption.revision);
      const staged = deps.media();
      if (staged?.revision === media.revision) {
        for (const photo of staged.photos) deps.revoke(photo.objectUrl);
        deps.setMedia(null);
      }
      deps.onSent(roomId);
    } catch (error) {
      // A superseded send (account switch + new send) must not overwrite the newer error state.
      if (seq === sendSeq) deps.setError(error instanceof Error ? error.message : "Could not send the photo. It is still here.");
    } finally {
      // Only the latest send owns the busy flag; an older one must not clear a new in-flight send.
      if (seq === sendSeq) deps.setBusy(false);
    }
  }

  // A note has no outbox: upload the staged photos to the notes scope, let `save` store the note
  // with their URL lines, then drop the matching media draft. A failure keeps the photos staged,
  // and a photo that already uploaded reuses its URL on the next try.
  async function saveNote(save: (urls: string[]) => Promise<void>): Promise<void> {
    if (deps.busy() || staging) throw new Error("The photos are still getting ready. Try again.");
    const media = deps.media();
    if (!media?.photos.length) { await save([]); return; }
    const scopeKey = deps.scopeKey();
    const accountId = deps.accountId();
    const roomId = deps.roomId();
    const database = deps.database();
    if (!scopeKey || !accountId || !roomId || !database) throw new Error("Open Notes first.");
    const captured = { scopeKey, accountId, roomId, database };
    const seq = ++sendSeq;
    deps.setBusy(true);
    deps.setError("");
    try {
      const urls: string[] = [];
      for (let index = 0; index < media.photos.length; index++) urls.push(await uploadOnce(media, index, "notes", captured));
      await save(urls);
      await database.transaction("rw", database.mediaDrafts, async () => {
        const stored = await database.mediaDrafts.get(roomId);
        if (stored?.revision === media.revision) await database.mediaDrafts.delete(roomId);
      }).catch(() => { /* the note is saved; a stale row is replaced on next stage */ });
      const staged = deps.media();
      if (staged?.revision === media.revision) {
        for (const photo of staged.photos) deps.revoke(photo.objectUrl);
        deps.setMedia(null);
      }
    } finally {
      if (seq === sendSeq) deps.setBusy(false);
    }
  }

  function cancelCompress(): void { compressing?.abort(); }

  return { stage, remove, send, saveNote, cancelCompress };
}
