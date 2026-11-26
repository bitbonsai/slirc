// Native message-photo normalization and upload authorization.
//
// Bun.Image sniffs the real container from the bytes; we never trust the declared
// MIME or a filename (untrusted strings are never used as paths or URLs). All
// supported stills are re-encoded to WebP so EXIF/GPS and unknown chunks do not
// survive the trip, alpha is retained, and orientation is applied before resize.

import { db } from "./db.ts";
import { channelInfo, isMember, isOpenChannel, normalized } from "./rooms.ts";

// Chosen for a phone photo, not an unbounded upload: a modern JPEG is ~2–8 MiB,
// so 12 MiB admits camera originals while bounding the pre-decode allocation.
// 50 MP is reasoned, not measured: a 2×50 MP burst would be ~400 MB of native
// buffers, so decode concurrency stays at 1 until the host is measured.
export const IMAGE_LIMITS = {
  maxOriginalBytes: 12 * 1024 * 1024,
  // Rejected after the header is read and before the pixel buffer is allocated.
  maxPixels: 50_000_000,
  maxEdge: 1600,
  quality: 82,
  fallbackQuality: 55,
  maxOutputBytes: 4 * 1024 * 1024,
  // Decode/encode runs off-thread; one job at a time keeps native peak bounded.
  maxConcurrentDecodes: 1,
} as const;

// Whole-request upload slots. Acquired before the body is buffered and held
// through read, normalize and write, so a burst of large/stalled requests cannot
// stack several request buffers in JS memory. The body read is abandoned after
// bodyReadTimeoutMs so a slow sender cannot hold a slot forever.
// `bodyReadTimeoutMs` is mutable as a test seam; production uses the default.
export const UPLOAD_LIMITS = {
  maxConcurrentUploads: 2,
  bodyReadTimeoutMs: 30_000,
};

let activeUploads = 0;

export async function withUploadSlot<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (activeUploads >= UPLOAD_LIMITS.maxConcurrentUploads) {
    throw new PhotoError(503, "Uploads are busy. Try again in a moment.");
  }
  activeUploads += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_LIMITS.bodyReadTimeoutMs);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    activeUploads -= 1;
  }
}

export class PhotoError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// One global slot pool, matching the single-process app server.
let activeDecodes = 0;

// The same pool for work that can wait, such as link thumbnails made in the background: it
// takes its turn behind uploads and other thumbnails and never fails for being busy.
const decodeTurns: (() => void)[] = [];
export async function withDecodeTurn<T>(work: () => Promise<T>): Promise<T> {
  while (activeDecodes >= IMAGE_LIMITS.maxConcurrentDecodes) await new Promise<void>((resolve) => decodeTurns.push(resolve));
  activeDecodes += 1;
  try {
    return await work();
  } finally {
    activeDecodes -= 1;
    decodeTurns.shift()?.();
  }
}

async function withDecodeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeDecodes >= IMAGE_LIMITS.maxConcurrentDecodes) {
    throw new PhotoError(503, "Image processing is busy. Try again in a moment.");
  }
  activeDecodes += 1;
  try {
    return await work();
  } finally {
    activeDecodes -= 1;
    decodeTurns.shift()?.();
  }
}

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}

// PNG: APNG carries acTL plus fcTL/fdAT frame chunks. Walk the chunk list
// instead of scanning raw bytes, so compressed image data can never be mistaken
// for a marker, and reject any frame chunk even without a valid acTL.
function pngAnimated(bytes: Uint8Array, view: DataView): boolean {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return true;
    if (type === "IEND") return false;
    const next = offset + 12 + length;
    if (next <= offset) return false;
    offset = next;
  }
  return false;
}

// WebP: RIFF chunks; animation is VP8X's A flag plus ANIM/ANMF chunks. Keep
// scanning past a non-animated VP8X so a crafted one cannot hide a later ANIM.
function webpAnimated(bytes: Uint8Array, view: DataView): boolean {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (type === "ANIM" || type === "ANMF") return true;
    if (type === "VP8X" && (bytes[offset + 8] & 0x02) !== 0) return true;
    const next = offset + 8 + size + (size & 1);
    if (next <= offset) return false;
    offset = next;
  }
  return false;
}

// GIF is not a supported photo input, so it is rejected before sniffing rather
// than flattened to a frame. Animated custom emoji use sniffAnimatedEmoji instead.
function hasAnimationMarker(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89 && startsWith(bytes.subarray(1), "PNG")) return pngAnimated(bytes, view);
  if (startsWith(bytes, "RIFF") && startsWith(bytes.subarray(8), "WEBP")) return webpAnimated(bytes, view);
  return false;
}

// Custom emoji may animate. Those bytes are stored as sent, never re-encoded, so
// this path admits only small animated files and reads size and frame count from
// the bytes. Stills keep going through normalizeUploadImage, which strips metadata.
export const ANIMATED_EMOJI_LIMITS = { maxBytes: 128 * 1024, maxEdge: 128, maxFrames: 50 } as const;

type AnimatedEmoji = { mime: "image/gif" | "image/png" | "image/webp"; width: number; height: number; frames: number };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// GIF: walk the block list and count image descriptors. Returns -1 when a block is
// unknown or cut off, so stray 0x2C bytes inside image data are never counted.
function gifFrames(bytes: Uint8Array): number {
  if (bytes.length < 13) return -1;
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * (1 << ((bytes[10] & 0x07) + 1));
  const skipSubBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset];
      offset += 1 + size;
      if (size === 0) return true;
    }
    return false;
  };
  let frames = 0;
  while (offset < bytes.length) {
    const block = bytes[offset];
    if (block === 0x3b) return frames;
    if (block === 0x21) {
      offset += 2;
      if (!skipSubBlocks()) return -1;
    } else if (block === 0x2c) {
      frames += 1;
      if (frames > ANIMATED_EMOJI_LIMITS.maxFrames) return frames;
      if (offset + 11 > bytes.length) return -1;
      const packed = bytes[offset + 9];
      offset += 10;
      if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));
      offset += 1; // LZW minimum code size
      if (!skipSubBlocks()) return -1;
    } else {
      return -1;
    }
  }
  // A missing trailer at a block boundary is common and harmless.
  return frames;
}

// APNG frames are fcTL chunks; animated WebP frames are ANMF chunks.
function countPngChunks(bytes: Uint8Array, view: DataView, wanted: string): number {
  let offset = 8;
  let count = 0;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === wanted) count += 1;
    if (type === "IEND") break;
    const next = offset + 12 + view.getUint32(offset);
    if (next <= offset) break;
    offset = next;
  }
  return count;
}

function countWebpChunks(bytes: Uint8Array, view: DataView, wanted: string): number {
  let offset = 12;
  let count = 0;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    if (type === wanted) count += 1;
    const size = view.getUint32(offset + 4, true);
    const next = offset + 8 + size + (size & 1);
    if (next <= offset) break;
    offset = next;
  }
  return count;
}

/** Sniff an animated GIF, APNG or animated WebP from its bytes; the declared MIME is never used. */
export function sniffAnimatedEmoji(bytes: Uint8Array): AnimatedEmoji {
  if (bytes.byteLength === 0) throw new PhotoError(400, "The image is empty.");
  if (bytes.byteLength > ANIMATED_EMOJI_LIMITS.maxBytes) throw new PhotoError(413, "Animated emoji must be under 128 KB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let found: AnimatedEmoji | null = null;
  if ((startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) && bytes.length >= 13) {
    // Logical screen size; browsers clip frames to it.
    found = { mime: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true), frames: gifFrames(bytes) };
  } else if (bytes.length >= 24 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte) && startsWith(bytes.subarray(12), "IHDR") && pngAnimated(bytes, view)) {
    found = { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20), frames: countPngChunks(bytes, view, "fcTL") };
  } else if (bytes.length >= 30 && startsWith(bytes, "RIFF") && startsWith(bytes.subarray(8), "WEBP") && startsWith(bytes.subarray(12), "VP8X") && webpAnimated(bytes, view)) {
    // VP8X canvas: 24-bit little-endian width and height, each stored minus one.
    found = {
      mime: "image/webp",
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      frames: countWebpChunks(bytes, view, "ANMF"),
    };
  }
  if (!found) throw new PhotoError(400, "Only animated GIF, PNG, or WebP files go here. Upload a still image as a normal photo first.");
  if (found.width < 1 || found.height < 1 || found.frames < 1) throw new PhotoError(400, "That file is not a readable image.");
  if (found.width > ANIMATED_EMOJI_LIMITS.maxEdge || found.height > ANIMATED_EMOJI_LIMITS.maxEdge) {
    throw new PhotoError(413, "Animated emoji must be at most 128×128 pixels.");
  }
  if (found.frames > ANIMATED_EMOJI_LIMITS.maxFrames) throw new PhotoError(413, "Animated emoji can have at most 50 frames.");
  return found;
}

function unsupportedMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === "ERR_IMAGE_FORMAT_UNSUPPORTED") {
    return "This image format is not supported on this server. Choose a JPEG, PNG, or WebP.";
  }
  return "That file is not a readable image.";
}

function photoErrorFromDecode(error: unknown): PhotoError {
  if (error instanceof PhotoError) return error;
  if ((error as { code?: string } | null)?.code === "ERR_IMAGE_TOO_MANY_PIXELS") {
    return new PhotoError(413, "That image has too many pixels.");
  }
  return new PhotoError(400, unsupportedMessage(error));
}

type NormalizedImage = { bytes: Uint8Array; mime: "image/webp"; width: number; height: number };

async function encodeWebp(bytes: Uint8Array, quality: number): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const image = new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels, autoOrient: true });
  const resized = image.resize(IMAGE_LIMITS.maxEdge, IMAGE_LIMITS.maxEdge, { fit: "inside", withoutEnlargement: true });
  const out = new Uint8Array(await resized.webp({ quality }).toBuffer());
  const width = resized.width;
  const height = resized.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PhotoError(400, "That file is not a readable image.");
  }
  return { bytes: out, width, height };
}

/**
 * Normalize an untrusted still to a bounded WebP. Throws PhotoError with an HTTP
 * status: 400 malformed/unsupported/animated, 413 over the pixel or output bound,
 * 503 when decode slots are saturated.
 */
export async function normalizeUploadImage(bytes: Uint8Array): Promise<NormalizedImage> {
  if (bytes.byteLength === 0) throw new PhotoError(400, "The image is empty.");
  if (bytes.byteLength > IMAGE_LIMITS.maxOriginalBytes) {
    throw new PhotoError(413, "Image must be under 12 MB.");
  }
  if (startsWith(bytes, "GIF8")) {
    throw new PhotoError(400, "GIF uploads are not supported. Send a JPEG, PNG, or WebP.");
  }
  if (hasAnimationMarker(bytes)) {
    throw new PhotoError(400, "Animated images are not supported. Send a still JPEG, PNG, or WebP.");
  }
  // The header read itself is bounded: Bun rejects over maxPixels before pixels allocate.
  let format: string;
  try {
    const meta = await withDecodeSlot(() => new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels, autoOrient: true }).metadata());
    format = String(meta.format || "").toLowerCase();
    const width = Number(meta.width);
    const height = Number(meta.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new PhotoError(400, "That file is not a readable image.");
    }
    if (width * height > IMAGE_LIMITS.maxPixels) throw new PhotoError(413, "That image has too many pixels.");
  } catch (error) {
    throw photoErrorFromDecode(error);
  }
  if (!["jpeg", "jpg", "png", "webp"].includes(format)) {
    throw new PhotoError(400, "Unsupported image format. Send a JPEG, PNG, or WebP.");
  }
  let encoded: { bytes: Uint8Array; width: number; height: number };
  try {
    encoded = await withDecodeSlot(() => encodeWebp(bytes, IMAGE_LIMITS.quality));
    // A 1600px still at q82 is normally well under the cap; one retry guarantees it.
    if (encoded.bytes.byteLength > IMAGE_LIMITS.maxOutputBytes) {
      encoded = await withDecodeSlot(() => encodeWebp(bytes, IMAGE_LIMITS.fallbackQuality));
    }
  } catch (error) {
    throw photoErrorFromDecode(error);
  }
  if (encoded.bytes.byteLength > IMAGE_LIMITS.maxOutputBytes) {
    throw new PhotoError(413, "That image is too detailed to store. Try a smaller one.");
  }
  return { bytes: encoded.bytes, mime: "image/webp", width: encoded.width, height: encoded.height };
}

// The workspace icon: an admin's square picture, stored as fixed WebP renditions. The client crops
// to a square before upload, so a non-square input is refused instead of being stretched. Each
// rendition is a fresh WebP encode, so EXIF, GPS and other metadata never survive.
export const WORKSPACE_ICON_LIMITS = { maxBytes: 2 * 1024 * 1024, sizes: [64, 256], quality: 85 } as const;

export async function workspaceIconRenditions(bytes: Uint8Array): Promise<{ size: number; bytes: Uint8Array }[]> {
  if (bytes.byteLength === 0) throw new PhotoError(400, "The image is empty.");
  if (bytes.byteLength > WORKSPACE_ICON_LIMITS.maxBytes) throw new PhotoError(413, "The icon must be under 2 MB.");
  if (startsWith(bytes, "GIF8") || hasAnimationMarker(bytes)) throw new PhotoError(400, "Use a still PNG, JPEG or WebP image.");
  let width: number, height: number, format: string;
  try {
    const meta = await withDecodeSlot(() => new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels, autoOrient: true }).metadata());
    format = String(meta.format || "").toLowerCase();
    width = Number(meta.width);
    height = Number(meta.height);
  } catch (error) {
    throw photoErrorFromDecode(error);
  }
  if (!["jpeg", "jpg", "png", "webp"].includes(format)) throw new PhotoError(400, "Use a PNG, JPEG or WebP image.");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new PhotoError(400, "That file is not a readable image.");
  if (width !== height) throw new PhotoError(400, "Crop the image to a square first.");
  const out: { size: number; bytes: Uint8Array }[] = [];
  try {
    for (const size of WORKSPACE_ICON_LIMITS.sizes) {
      const image = new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels, autoOrient: true }).resize(size, size, { fit: "fill" });
      out.push({ size, bytes: new Uint8Array(await withDecodeSlot(() => image.webp({ quality: WORKSPACE_ICON_LIMITS.quality }).toBuffer())) });
    }
  } catch (error) {
    throw photoErrorFromDecode(error);
  }
  return out;
}

/**
 * Current read access to an upload's destination channel. A thread child needs
 * both its own access (parent membership covers workspace children) and access
 * to the authoritative parent row, so deleting the parent or revoking the child
 * fails closed. Unknown associations and non-channel strings fail closed.
 */
export function canReadUploadChannel(nick: string | null, channel: string, depth = 0): boolean {
  if (depth > 4) return false;
  // Notes images belong to one account: `notes:<account id>`, readable only by that account.
  if (channel.startsWith("notes:")) {
    return !!nick && !!db.query("SELECT 1 FROM accounts WHERE nick = ? COLLATE NOCASE AND account_id = ?").get(nick, channel.slice(6));
  }
  const target = normalized(channel);
  if (!target.startsWith("#")) return false;
  if (isOpenChannel(target)) return true;
  const thread = db.query("SELECT parent FROM threads WHERE channel = ?").get(target) as { parent: string } | null;
  if (thread) {
    const info = channelInfo(target);
    // Workspace children inherit the parent; secret/direct/legacy need a child grant.
    const childAllowed = info?.visibility === "workspace" ? true : !!nick && isMember(nick, target);
    if (!childAllowed) return false;
    return canReadUploadChannel(nick, thread.parent, depth + 1);
  }
  return !!nick && isMember(nick, target);
}
