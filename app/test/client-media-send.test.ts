// Executable regressions for the media staging/sending races: delayed pick across a room/account
// change, a duplicate send invocation, a caption edited during upload, conditional upload-URL
// persistence, the atomic media+caption consume inside db.queueText, and photo sets.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import type { AccountScope, QueueText } from "@client/model.ts";
import type { ClientDatabase } from "@client/db.ts";
import type { Outbox } from "@client/outbox.ts";
import type { StagedMedia } from "@client/media-send.ts";

const { ClientDatabase } = await import("@client/db.ts");
const { createMediaSender, draftPhotos, pastedImages, photoMessages, MAX_PHOTOS } = await import("@client/media-send.ts");
const { queuedTextFor } = await import("@client/drafts.ts");

const scopeA: AccountScope = { instance: "https://slirc.test", accountId: "acct-a", account: "alice" };
const scopeB: AccountScope = { instance: "https://slirc.test", accountId: "acct-b", account: "bob" };

const databases: ClientDatabase[] = [];
function open(scope: AccountScope): ClientDatabase {
  const db = new ClientDatabase(scope);
  databases.push(db);
  return db;
}
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() > until) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface Harness {
  deps: Parameters<typeof createMediaSender>[0];
  sent: QueueText[];
  errors: string[];
  sentTo: string[];
  uploads: number;
  media(): StagedMedia | null;
  setScope(scope: AccountScope, key: string): void;
  setRoom(room: string): void;
  setCaption(text: string, revision: string): void;
  resolveRead(bytes: Uint8Array): void;
  resolveUpload(url: string): void;
}

function harness(overrides: { read?: Promise<Uint8Array>; upload?: Promise<string>; uploadUrl?: (n: number) => string } = {}): Harness {
  const db = open(scopeA);
  const sent: QueueText[] = [];
  const errors: string[] = [];
  const sentTo: string[] = [];
  let media: StagedMedia | null = null;
  let busy = false;
  let idSeq = 0;
  let room = "room-conv";
  let scopeKey = "scope-a";
  let accountId = scopeA.accountId;
  let author = scopeA.account;
  let currentDb: ClientDatabase = db;
  let caption = { text: "cap", revision: "rev-text" };
  let uploads = 0;
  const authorized = new Set(["room-conv", "room-2", "notes"]);
  let readDeferred = deferred<Uint8Array>();
  let uploadDeferred = deferred<string>();

  const deps: Parameters<typeof createMediaSender>[0] = {
    scopeKey: () => scopeKey,
    accountId: () => accountId,
    authorAccount: () => author,
    roomId: () => room,
    database: () => currentDb,
    outbox: () => ({
      enqueueTexts: async (queued: QueueText[]) => { await currentDb.queueTexts(queued); sent.push(...queued); },
    }) as unknown as Outbox,
    isAuthorized: (id) => authorized.has(id),
    wireChannel: (id) => (id === "room-conv" ? "#dev" : id === "room-2" ? "#two" : undefined),
    media: () => media,
    setMedia: (next) => { media = next; },
    busy: () => busy,
    setBusy: (value) => { busy = value; },
    setError: (message) => { errors.push(message); },
    revoke: () => {},
    readBytes: () => overrides.read ?? Promise.resolve(new Uint8Array([1, 2, 3])),
    upload: async () => { uploads += 1; if (overrides.uploadUrl) return overrides.uploadUrl(uploads); return overrides.upload ?? uploadDeferred.promise; },
    encode: () => "AAAA",
    origin: () => "https://slirc.test",
    buildQueueText: ({ conversationId, author: who, text, draftRevision, mediaRevision, createdAt }) =>
      queuedTextFor(conversationId, who, { text, revision: draftRevision }, `op-${++idSeq}`, createdAt, mediaRevision),
    caption: () => caption,
    validateCaption: () => {},
    validateMessage: () => {},
    clearCaption: (revision) => { if (caption.revision === revision) caption = { text: "", revision: "" }; },
    onSent: (conversationId) => { sentTo.push(conversationId); },
    randomId: () => `rev-${++idSeq}`,
    now: () => 1000,
  };

  return {
    deps, sent, errors, sentTo,
    get uploads() { return uploads; },
    media: () => media,
    setScope: (scope, key) => { accountId = scope.accountId; author = scope.account; scopeKey = key; currentDb = open(scope); },
    setRoom: (next) => { room = next; },
    setCaption: (text, revision) => { caption = { text, revision }; },
    resolveRead: (bytes) => readDeferred.resolve(bytes),
    resolveUpload: (url) => uploadDeferred.resolve(url),
  };
}

const photo = new File([new Uint8Array([1, 2, 3])], "p.png", { type: "image/png" });

test("a delayed pick that crosses a room change is refused and writes no media draft", async () => {
  const read = deferred<Uint8Array>();
  const h = harness({ read: read.promise });
  const sender = createMediaSender(h.deps);
  const staging = sender.stage(photo);
  h.setRoom("room-2");
  read.resolve(new Uint8Array([1, 2, 3]));
  await staging;
  expect(h.media()).toBeNull();
  expect(h.errors.at(-1)).toContain("changed");
  expect(await (h.deps.database() as ClientDatabase).mediaDrafts.count()).toBe(0);
});

test("a delayed pick that crosses an account change writes only to the original scope and refuses", async () => {
  const read = deferred<Uint8Array>();
  const h = harness({ read: read.promise });
  const original = h.deps.database() as ClientDatabase;
  const sender = createMediaSender(h.deps);
  const staging = sender.stage(photo);
  h.setScope(scopeB, "scope-b");
  read.resolve(new Uint8Array([1, 2, 3]));
  await staging;
  expect(h.media()).toBeNull();
  expect(h.errors.at(-1)).toContain("changed");
  expect(await original.mediaDrafts.count()).toBe(0);
  expect(await (h.deps.database() as ClientDatabase).mediaDrafts.count()).toBe(0);
});

test("a completed send reports onSent for the recipient even after navigation", async () => {
  const h = harness();
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  const sending = sender.send();
  h.setRoom("room-2"); // user navigates away mid-upload; the recipient stays authorized
  h.resolveUpload("/uploads/nav?type=image");
  await sending;
  expect(h.sent).toHaveLength(1);
  expect(h.sentTo).toEqual(["room-conv"]);
});

test("a persist that completes after a room change does not stage into the new room", async () => {
  const putGate = deferred<void>();
  let putCalled = false;
  const h = harness({ read: Promise.resolve(new Uint8Array([1, 2, 3])) });
  const fakeDb = {
    mediaDrafts: {
      put: () => { putCalled = true; return putGate.promise; },
      get: async () => undefined,
    },
  } as unknown as ClientDatabase;
  h.deps.database = () => fakeDb;
  const sender = createMediaSender(h.deps);
  const staging = sender.stage(photo);
  await waitFor(() => putCalled);
  h.setRoom("room-2");
  putGate.resolve();
  await staging;
  expect(h.media()).toBeNull();
  expect(h.errors.at(-1)).toContain("changed");
});

test("a payload that only exceeds the wire limit after the URL is refused before enqueue", async () => {
  const h = harness({ upload: Promise.resolve("/uploads/u?type=image") });
  h.deps.validateMessage = (text) => { if (text.length > 30) throw new Error("Max bytes."); };
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  h.setCaption("caption long enough to pass alone", "rev-long");
  await sender.send();
  expect(h.uploads).toBe(1);
  expect(h.sent).toHaveLength(0);
  expect(h.errors.at(-1)).toContain("Max bytes");
  expect(h.media()).not.toBeNull();
});

test("a superseded send does not clear the newer send's busy state", async () => {
  const uploads = deferred<string>();
  const h = harness({ upload: uploads.promise });
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  const first = sender.send();
  expect(h.deps.busy()).toBe(true);
  h.deps.setBusy(false); // simulate the scope-switch reset that lets a new send start
  const second = sender.send();
  expect(h.deps.busy()).toBe(true);
  uploads.resolve("/uploads/one?type=image");
  await first;
  expect(h.deps.busy()).toBe(true);
  await second;
  expect(h.deps.busy()).toBe(false);
});

test("an unsendable caption is refused before upload and the photo stays staged", async () => {
  const h = harness();
  h.deps.validateCaption = (text) => { if (text.includes("\t")) throw new Error("No control characters."); };
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  h.setCaption("bad\tcaption", "rev-bad");
  await sender.send();
  expect(h.uploads).toBe(0);
  expect(h.sent).toHaveLength(0);
  expect(h.errors.at(-1)).toContain("control");
  expect(h.media()).not.toBeNull();
});

test("a repeated send while one is in flight uploads and enqueues once", async () => {
  const h = harness();
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  expect(h.media()).not.toBeNull();
  const first = sender.send();
  const second = sender.send(); // duplicate Enter before the disabled attribute paints
  h.resolveUpload("/uploads/abc123?type=image");
  await Promise.all([first, second]);
  expect(h.uploads).toBe(1);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]!.mediaRevision).toBeTruthy();
});

test("a caption edited during upload keeps the frozen text and preserves the newer draft", async () => {
  const h = harness();
  const db = h.deps.database() as ClientDatabase;
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  const stagedRevision = h.media()!.revision;
  h.setCaption("original", "rev-original");
  await db.drafts.put({ conversationId: "room-conv", revision: "rev-original", text: "original", updatedAt: 1 });
  const sending = sender.send();
  // User edits while the upload is in flight.
  h.setCaption("newer", "rev-newer");
  await db.drafts.put({ conversationId: "room-conv", revision: "rev-newer", text: "newer", updatedAt: 2 });
  h.resolveUpload("/uploads/xyz?type=image");
  await sending;
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]!.message.text.startsWith("original\n")).toBe(true);
  expect(h.sent[0]!.message.text).not.toContain("newer");
  // The frozen text draft is consumed; the newer one survives.
  expect(await db.drafts.get("room-conv")).toMatchObject({ revision: "rev-newer" });
  // The matching media draft is consumed in the same transaction.
  expect(await db.mediaDrafts.get("room-conv")).toBeUndefined();
  expect(stagedRevision).toBeTruthy();
});

test("an account change during upload refuses to enqueue and keeps the staged photo", async () => {
  const h = harness();
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  const staged = h.media();
  const sending = sender.send();
  h.setScope(scopeB, "scope-b");
  h.resolveUpload("/uploads/zzz?type=image");
  await sending;
  expect(h.sent).toHaveLength(0);
  expect(h.errors.at(-1)).toContain("Account changed");
  expect(h.media()).toBe(staged); // still staged (the old scope's copy is untouched by the refusal)
});

test("a newer photo staged during upload survives the older send's atomic consume", async () => {
  const h = harness({ read: Promise.resolve(new Uint8Array([1, 2, 3])) });
  const db = h.deps.database() as ClientDatabase;
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  const older = h.media()!;
  const sending = sender.send();
  // A second photo is staged while the first upload is in flight.
  await sender.stage(new File([new Uint8Array([4, 5, 6])], "newer.png", { type: "image/png" }));
  const newer = h.media()!;
  expect(newer.revision).not.toBe(older.revision);
  h.resolveUpload("/uploads/keep?type=image");
  await sending;
  // The older send's mediaRevision must not consume the newer draft or clear the newer preview.
  expect((await db.mediaDrafts.get("room-conv"))?.revision).toBe(newer.revision);
  expect(h.media()?.revision).toBe(newer.revision);
});

test("db.queueText consumes only a matching media revision and rolls back on a failed enqueue", async () => {
  const db = open(scopeA);
  await db.mediaDrafts.put({ conversationId: "room-conv", revision: "r1", name: "p", mime: "image/png", bytes: new Uint8Array([1]), updatedAt: 1 });
  await db.queueText(queuedTextFor("room-conv", "alice", { text: "cap", revision: "tr" }, "op-1", 1, "r1"));
  expect(await db.mediaDrafts.get("room-conv")).toBeUndefined();
  // A mismatched mediaRevision (newer photo) is preserved.
  await db.mediaDrafts.put({ conversationId: "room-conv", revision: "r2", name: "p", mime: "image/png", bytes: new Uint8Array([2]), updatedAt: 2 });
  await db.queueText(queuedTextFor("room-conv", "alice", { text: "cap2", revision: "tr2" }, "op-2", 2, "r1"));
  expect((await db.mediaDrafts.get("room-conv"))?.revision).toBe("r2");
  // A failed enqueue (duplicate message/operation id) aborts the whole transaction: the media
  // draft delete rolls back too, so the photo is still usable for a retry.
  await db.mediaDrafts.put({ conversationId: "room-conv", revision: "r3", name: "p", mime: "image/png", bytes: new Uint8Array([3]), updatedAt: 3 });
  await expect(db.queueText(queuedTextFor("room-conv", "alice", { text: "cap3", revision: "tr3" }, "op-1", 3, "r3"))).rejects.toThrow();
  expect((await db.mediaDrafts.get("room-conv"))?.revision).toBe("r3");
});

// Pasting into the composer stages an image through the same path as a picked file.
test("a paste stages every image it carries and leaves text-only pastes alone", async () => {
  const file = (name: string, type: string) => new File([new Uint8Array([1])], name, { type });
  const item = (value: File | null, kind = "file") => ({ kind, type: value?.type ?? "text/plain", getAsFile: () => value }) as unknown as DataTransferItem;
  const clip = (files: File[], items: DataTransferItem[] = []) => ({ files: files as unknown as FileList, items: items as unknown as DataTransferItemList });
  const shot = file("shot.png", "image/png");
  const second = file("two.jpg", "image/jpeg");
  expect(pastedImages(null)).toEqual([]);
  expect(pastedImages(clip([], [item(null, "string")]))).toEqual([]);
  expect(pastedImages(clip([shot]))).toEqual([shot]);
  // Some browsers expose a pasted screenshot only as a clipboard item.
  expect(pastedImages(clip([], [item(null, "string"), item(shot)]))).toEqual([shot]);
  // Several images: all of them, once each, in clipboard order.
  expect(pastedImages(clip([shot, second], [item(shot), item(second)]))).toEqual([shot, second]);
  expect(pastedImages(clip([file("notes.pdf", "application/pdf"), second]))).toEqual([second]);
  expect(pastedImages(clip([file("notes.pdf", "application/pdf")]))).toEqual([]);
});

const png = (name: string, bytes = [1, 2, 3]) => new File([new Uint8Array(bytes)], name, { type: "image/png" });

test("several picked photos stage as one set and send in one message under the caption", async () => {
  const h = harness({ uploadUrl: (n) => `/uploads/photo${n}?type=image` });
  const db = h.deps.database() as ClientDatabase;
  const sender = createMediaSender(h.deps);
  await sender.stage([png("a.png"), png("b.png")]);
  expect(h.media()!.photos.map((photo) => photo.name)).toEqual(["a.png", "b.png"]);
  expect(draftPhotos(await db.mediaDrafts.get("room-conv"))).toHaveLength(2);
  await sender.send();
  expect(h.uploads).toBe(2);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]!.message.text).toBe("cap\nhttps://slirc.test/uploads/photo1?type=image\nhttps://slirc.test/uploads/photo2?type=image");
  expect(await db.mediaDrafts.get("room-conv")).toBeUndefined();
  expect(h.media()).toBeNull();
});

test("a set that does not fit one message goes out one photo per message, in order, in one commit", async () => {
  const h = harness({ uploadUrl: (n) => `/uploads/photo${n}?type=image` });
  const db = h.deps.database() as ClientDatabase;
  // No draft/multiline here: only a single line fits.
  h.deps.validateMessage = (text) => { if (text.includes("\n")) throw new Error("This server cannot send several lines in one message."); };
  h.setCaption("", "rev-empty");
  const sender = createMediaSender(h.deps);
  await sender.stage([png("a.png"), png("b.png"), png("c.png")]);
  await sender.send();
  expect(h.errors.at(-1)).toBe("");
  expect(h.sent.map((queued) => queued.message.text)).toEqual([1, 2, 3].map((n) => `https://slirc.test/uploads/photo${n}?type=image`));
  const created = h.sent.map((queued) => queued.operation.createdAt);
  expect(created).toEqual([...created].sort((a, b) => a - b));
  expect(new Set(created).size).toBe(3);
  expect(await db.operations.count()).toBe(3);
  expect(await db.mediaDrafts.get("room-conv")).toBeUndefined();
});

test("the split keeps the caption with the first photo and refuses when any part does not fit", () => {
  const limit = (max: number) => (text: string) => { if (text.length > max) throw new Error("Max bytes."); };
  expect(photoMessages("hi", ["u1", "u2"], limit(100))).toEqual(["hi\nu1\nu2"]);
  expect(photoMessages("hi", ["u1", "u2"], limit(5))).toEqual(["hi\nu1", "u2"]);
  expect(() => photoMessages("a long caption", ["u1", "u2"], limit(5))).toThrow("Max bytes.");
  expect(() => photoMessages("a long caption", ["u1"], limit(5))).toThrow("Max bytes.");
});

test("a failed enqueue of a split set queues none of it and keeps every photo staged", async () => {
  const h = harness({ uploadUrl: (n) => `/uploads/photo${n}?type=image` });
  const db = h.deps.database() as ClientDatabase;
  h.deps.validateMessage = (text) => { if (text.includes("\n")) throw new Error("one line"); };
  h.setCaption("", "rev-empty");
  // The second message collides with an existing operation id, so the shared transaction aborts.
  h.deps.buildQueueText = ({ conversationId, author, text, draftRevision, mediaRevision, createdAt }) =>
    queuedTextFor(conversationId, author, { text, revision: draftRevision }, "op-x", createdAt, mediaRevision);
  const sender = createMediaSender(h.deps);
  await sender.stage([png("a.png"), png("b.png")]);
  await sender.send();
  expect(await db.operations.count()).toBe(0);
  expect(await db.messages.count()).toBe(0);
  expect(h.media()!.photos).toHaveLength(2);
  expect(draftPhotos(await db.mediaDrafts.get("room-conv")).map((photo) => photo.uploadedUrl)).toEqual([
    "https://slirc.test/uploads/photo1?type=image", "https://slirc.test/uploads/photo2?type=image",
  ]);
});

test("a later pick adds to the staged set, and removing one keeps the others and their uploads", async () => {
  const h = harness();
  const db = h.deps.database() as ClientDatabase;
  const sender = createMediaSender(h.deps);
  await sender.stage(png("a.png"));
  await sender.stage([png("b.png"), png("c.png")]);
  expect(h.media()!.photos.map((photo) => photo.name)).toEqual(["a.png", "b.png", "c.png"]);
  const before = h.media()!.revision;
  await sender.remove(1);
  expect(h.media()!.photos.map((photo) => photo.name)).toEqual(["a.png", "c.png"]);
  expect(h.media()!.revision).not.toBe(before);
  const stored = await db.mediaDrafts.get("room-conv");
  expect(stored?.revision).toBe(h.media()!.revision);
  expect(draftPhotos(stored).map((photo) => photo.name)).toEqual(["a.png", "c.png"]);
  await sender.remove(0);
  await sender.remove(0);
  expect(h.media()).toBeNull();
  expect(await db.mediaDrafts.get("room-conv")).toBeUndefined();
});

test("files past the per-message cap and unsupported files are refused with a reason; the rest stage", async () => {
  const h = harness();
  const sender = createMediaSender(h.deps);
  const many = Array.from({ length: MAX_PHOTOS + 2 }, (_, n) => png(`p${n}.png`));
  await sender.stage([new File(["x"], "clip.gif", { type: "image/gif" }), ...many]);
  expect(h.media()!.photos).toHaveLength(MAX_PHOTOS);
  expect(h.errors.at(-1)).toContain("GIF");
  await sender.stage(png("extra.png"));
  expect(h.media()!.photos).toHaveLength(MAX_PHOTOS);
  expect(h.errors.at(-1)).toContain(`Up to ${MAX_PHOTOS} photos`);
});

test("photos staged while a set is sending start a new set instead of joining the one in flight", async () => {
  const h = harness();
  const db = h.deps.database() as ClientDatabase;
  const sender = createMediaSender(h.deps);
  await sender.stage([png("a.png"), png("b.png")]);
  const sending = sender.send();
  await sender.stage(png("later.png"));
  expect(h.media()!.photos.map((photo) => photo.name)).toEqual(["later.png"]);
  h.resolveUpload("/uploads/same?type=image");
  await sending;
  expect(h.sent).toHaveLength(1);
  expect(h.media()!.photos.map((photo) => photo.name)).toEqual(["later.png"]);
  expect(draftPhotos(await db.mediaDrafts.get("room-conv")).map((photo) => photo.name)).toEqual(["later.png"]);
});

test("a single-photo draft stored before photo sets still restores", () => {
  const bytes = new Uint8Array([9]);
  expect(draftPhotos({ conversationId: "c", revision: "r", name: "old.png", mime: "image/png", bytes, uploadedUrl: "https://slirc.test/uploads/old", updatedAt: 1 }))
    .toEqual([{ name: "old.png", mime: "image/png", bytes, uploadedUrl: "https://slirc.test/uploads/old" }]);
  expect(draftPhotos(undefined)).toEqual([]);
});

test("a sent photo clears caption, photo and busy state before the next render", async () => {
  // Alpine renders on a microtask. Any await between clearing the caption, dropping the photo and
  // ending the busy state would paint a half-cleared composer that jumps before it settles.
  const h = harness({ upload: Promise.resolve("/uploads/one") });
  let atNextRender: { caption: string; media: StagedMedia | null; busy: boolean } | null = null;
  const clear = h.deps.clearCaption;
  h.deps.clearCaption = (revision) => {
    clear(revision);
    queueMicrotask(() => { atNextRender = { caption: h.deps.caption().text, media: h.media(), busy: h.deps.busy() }; });
  };
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  await sender.send();
  expect(h.sent).toHaveLength(1);
  expect(atNextRender).toEqual({ caption: "", media: null, busy: false });
});

test("uploading shows on the photo chips, not as a line that reflows the composer row", async () => {
  // A visible "Uploading photo…" paragraph sat in the composer's flex row beside the caption, so the
  // composer grew and the caption wrapped for the whole upload, then everything dropped at once.
  const html = await Bun.file(new URL("../partials/composer.html", import.meta.url)).text();
  expect(html).toMatch(/<p class="media-note sr-only" role="status"/);
  expect(html).toContain(`<div id="media-preview" class="media-preview" :class="mediaBusy && 'uploading'"`);
  const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  expect(css).toContain(".media-preview.uploading .media-chip::after");
  expect(css).toMatch(/\.composer > \.profile-error \{[^}]*flex-basis: 100%/);
});

test("the composer takes file drops itself and lets the picker choose several photos", async () => {
  // A file dropped on the composer used to reach the browser, which opened the image full size
  // over the app instead of staging it.
  const html = await Bun.file(new URL("../partials/composer.html", import.meta.url)).text();
  const form = html.slice(html.indexOf("<form"), html.indexOf(">", html.indexOf("<form")));
  expect(form).toContain('x-on:dragover="onDragOver($event)"');
  expect(form).toContain('x-on:drop="onDrop($event)"');
  expect(html).toMatch(/<input x-ref="mediaInput"[^>]*\smultiple[\s>]/);
});

test("saving a note uploads its staged photos to notes and stores caption plus URL lines once", async () => {
  const h = harness({ uploadUrl: (n) => `/uploads/note${n}` });
  h.setRoom("notes");
  const channels: string[] = [];
  const upload = h.deps.upload;
  h.deps.upload = (input) => { channels.push(input.channel); return upload(input); };
  const sender = createMediaSender(h.deps);
  await sender.stage([photo, photo]);
  expect(h.media()?.photos.length).toBe(2);
  const saved: string[] = [];
  await sender.saveNote(async (urls) => { saved.push(["hello", ...urls].join("\n")); });
  expect(channels).toEqual(["notes", "notes"]);
  expect(saved).toEqual(["hello\nhttps://slirc.test/uploads/note1\nhttps://slirc.test/uploads/note2"]);
  expect(h.media()).toBeNull();
  expect(await h.deps.database()!.mediaDrafts.get("notes")).toBeUndefined();
  expect(h.sent).toEqual([]);
});

test("a note that fails to save keeps its photos staged and reuses their uploads", async () => {
  const h = harness({ uploadUrl: (n) => `/uploads/note${n}` });
  h.setRoom("notes");
  const sender = createMediaSender(h.deps);
  await sender.stage(photo);
  await expect(sender.saveNote(async () => { throw new Error("Could not save the note."); })).rejects.toThrow("Could not save the note.");
  expect(h.media()?.photos.length).toBe(1);
  expect((await h.deps.database()!.mediaDrafts.get("notes"))?.photos?.[0]?.uploadedUrl).toBe("https://slirc.test/uploads/note1");
  const saved: string[][] = [];
  await sender.saveNote(async (urls) => { saved.push(urls); });
  expect(h.uploads).toBe(1);
  expect(saved).toEqual([["https://slirc.test/uploads/note1"]]);
  expect(h.media()).toBeNull();
});

const video = (name: string, size = 3) => new File([new Uint8Array(size)], name, { type: "video/quicktime" });

test("a picked video stages compressed when compression works, and as picked when it does not", async () => {
  const h = harness();
  h.deps.readBytes = async (file) => new Uint8Array(await file.arrayBuffer());
  h.deps.compressVideo = async (file) => new File([new Uint8Array(1)], file.name.replace(/\.MOV$/, ".mp4"), { type: "video/mp4" });
  const sender = createMediaSender(h.deps);
  await sender.stage(video("IMG_1.MOV"));
  expect(h.media()?.photos.map(({ name, mime, bytes }) => ({ name, mime, size: bytes.byteLength }))).toEqual([{ name: "IMG_1.mp4", mime: "video/mp4", size: 1 }]);

  for (const compress of [async () => null, async () => { throw new Error("encoder"); }]) {
    const fallback = harness();
    fallback.deps.readBytes = async (file) => new Uint8Array(await file.arrayBuffer());
    fallback.deps.compressVideo = compress;
    await createMediaSender(fallback.deps).stage(video("IMG_2.MOV"));
    expect(fallback.media()?.photos.map(({ name, mime }) => ({ name, mime }))).toEqual([{ name: "IMG_2.MOV", mime: "video/quicktime" }]);
    expect(fallback.errors.filter(Boolean)).toEqual([]);
  }
});

test("photos are never sent to the video compressor", async () => {
  const h = harness();
  let calls = 0;
  h.deps.compressVideo = async () => { calls += 1; return null; };
  await createMediaSender(h.deps).stage(photo);
  expect(calls).toBe(0);
  expect(h.media()?.photos).toHaveLength(1);
});

test("cancel drops the compressing video, keeps the rest of the pick, and a pick meanwhile is refused", async () => {
  const h = harness();
  const started = deferred<AbortSignal>();
  h.deps.compressVideo = (_file, signal) => { started.resolve(signal); return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null))); };
  const sender = createMediaSender(h.deps);
  const staging = sender.stage([video("IMG_3.MOV"), photo]);
  const signal = await started.promise;
  await sender.stage(photo);
  expect(h.errors.at(-1)).toContain("compressing");
  sender.cancelCompress();
  await staging;
  expect(signal.aborted).toBe(true);
  expect(h.media()?.photos.map((item) => item.name)).toEqual(["p.png"]);
  // Nothing is left compressing: the next pick stages.
  await sender.stage(photo);
  expect(h.media()?.photos).toHaveLength(2);
});

test("a video over the upload limit is taken at pick only where it can be compressed", async () => {
  const { MAX_VIDEO_BYTES } = await import("@client/media.ts");
  const big = { name: "IMG_4.MOV", type: "video/quicktime", size: MAX_VIDEO_BYTES + 1 } as File;
  const plain = harness();
  await createMediaSender(plain.deps).stage(big);
  expect(plain.errors.at(-1)).toBe("Videos must be under 30 MB.");
  const h = harness();
  h.deps.compressVideo = async () => new File([new Uint8Array(2)], "IMG_4.mp4", { type: "video/mp4" });
  await createMediaSender(h.deps).stage(big);
  expect(h.media()?.photos.map((item) => item.mime)).toEqual(["video/mp4"]);
  // A compression that fails leaves the original, which is still refused at the upload limit.
  const failed = harness();
  failed.deps.compressVideo = async () => null;
  failed.deps.readBytes = async () => new Uint8Array(MAX_VIDEO_BYTES + 1);
  await createMediaSender(failed.deps).stage(big);
  expect(failed.media()).toBeNull();
  expect(failed.errors.at(-1)).toBe("Videos must be under 30 MB.");
});
