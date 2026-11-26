// On-device video compression before upload. The server stores videos as sent, so a 1080p or 4K
// iPhone clip went up at full size. This side decides whether a clip is worth re-encoding and runs
// the encoder, which lives in its own bundle (/video-encode.js, WebCodecs plus an MP4 muxer) so the
// chat client does not carry it until someone picks a video. Any failure uploads the original.

// About 720p: the long edge at most 1280 and the short edge at most 720.
export const TARGET_LONG_EDGE = 1280;
export const TARGET_SHORT_EDGE = 720;
export const VIDEO_BITRATE = 2_500_000;
export const MAX_FRAME_RATE = 30;
// A clip this small that already fits 720p goes up as it is.
export const SMALL_VIDEO_BYTES = 4 * 1024 * 1024;

export interface VideoFacts { size: number; width: number; height: number; duration: number }

// The output size for a clip, or null to upload it as it is: already small and within 720p, or within
// 720p at a bitrate the re-encode would not beat by much. Dimensions stay even for H.264.
export function videoPlan({ size, width, height, duration }: VideoFacts): { width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null;
  const long = Math.max(width, height), short = Math.min(width, height);
  const fits = long <= TARGET_LONG_EDGE && short <= TARGET_SHORT_EDGE;
  if (fits && size <= SMALL_VIDEO_BYTES) return null;
  if (fits && duration > 0 && (size * 8) / duration <= VIDEO_BITRATE * 1.25) return null;
  const scale = Math.min(1, TARGET_LONG_EDGE / long, TARGET_SHORT_EDGE / short);
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

// The lazy encoder bundle's one export. Resolves null when it decides to skip or cannot convert.
export type EncodeVideo = (file: Blob, options: { onProgress(fraction: number): void; signal: AbortSignal }) => Promise<Blob | null>;

// WebCodecs encoding is what the encoder bundle needs; Safari on iOS has it since 16.4.
export function canCompressVideo(scope: { VideoEncoder?: unknown; VideoDecoder?: unknown } = globalThis as never): boolean {
  return typeof scope.VideoEncoder === "function" && typeof scope.VideoDecoder === "function";
}

export function mp4Name(name: string): string {
  return `${(name || "video").replace(/\.[A-Za-z0-9]+$/, "")}.mp4`;
}

// The compressed clip as an MP4 file, or null to upload the original: no support, a skip, a failed
// load or encode, a cancel, or a result that is not smaller.
export async function compressVideo(
  file: File,
  options: { onProgress(fraction: number): void; signal: AbortSignal; load(): Promise<EncodeVideo>; supported?: boolean },
): Promise<File | null> {
  if (!(options.supported ?? canCompressVideo()) || options.signal.aborted) return null;
  try {
    const encode = await options.load();
    if (options.signal.aborted) return null;
    const out = await encode(file, { onProgress: options.onProgress, signal: options.signal });
    if (!out || options.signal.aborted || out.size === 0 || out.size >= file.size) return null;
    return new File([out], mp4Name(file.name), { type: "video/mp4" });
  } catch {
    return null;
  }
}

// The encoder bundle's address carries its content hash, which the shell gives in a meta tag, so a
// cached old bundle never pairs with new code.
export function loadVideoEncoder(): Promise<EncodeVideo> {
  const version = document.querySelector<HTMLMetaElement>('meta[name="slirc-video"]')?.content ?? "";
  const url = `/video-encode.js${/^[a-f0-9]{8}$/.test(version) ? `?v=${version}` : ""}`;
  return import(url).then((module: { encodeVideo: EncodeVideo }) => module.encodeVideo);
}
