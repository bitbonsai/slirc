// The video encoder bundle, served as /video-encode.js and loaded only when a video is staged.
// Mediabunny reads the MP4 or MOV, decodes and re-encodes with WebCodecs, and writes an MP4: H.264
// video at about 720p, 2.5 Mbps and at most 30 fps, audio copied when it is already AAC and encoded to AAC otherwise.
// Descriptive metadata (iPhone clips carry GPS) is not written, and extra tracks are dropped.
import { BlobSource, BufferTarget, Conversion, Input, MP4, Mp4OutputFormat, Output, QTFF } from "mediabunny";
import { MAX_FRAME_RATE, VIDEO_BITRATE, videoPlan, type EncodeVideo } from "./video-compress.ts";

export const encodeVideo: EncodeVideo = async (file, { onProgress, signal }) => {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF] });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const duration = await input.computeDuration().catch(() => 0);
    const plan = videoPlan({ size: file.size, width: track.displayWidth, height: track.displayHeight, duration });
    if (!plan || signal.aborted) return null;
    // 60 fps doubles the frames the bitrate has to cover; chat clips go out at 30 at most.
    const rate = await track.computePacketStats(120).then((stats) => stats.averagePacketRate).catch(() => 0);
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
    const conversion = await Conversion.init({
      input, output, tracks: "primary", tags: {}, showWarnings: false,
      video: { width: plan.width, height: plan.height, fit: "fill", codec: "avc", bitrate: VIDEO_BITRATE, forceTranscode: true, ...(rate > MAX_FRAME_RATE + 1 ? { frameRate: MAX_FRAME_RATE } : {}) },
      audio: { codec: "aac" },
    });
    // A dropped audio or video track means a worse clip than the original: send the original.
    const audio = await input.getPrimaryAudioTrack();
    const kept = (wanted: { id: number } | null) => !wanted || conversion.utilizedTracks.some((used) => used.id === wanted.id);
    if (!conversion.isValid || !kept(track) || !kept(audio)) return null;
    conversion.onProgress = (fraction) => onProgress(fraction);
    const cancel = () => { void conversion.cancel(); };
    signal.addEventListener("abort", cancel, { once: true });
    try { await conversion.execute(); }
    finally { signal.removeEventListener("abort", cancel); }
    return target.buffer ? new Blob([target.buffer], { type: "video/mp4" }) : null;
  } finally {
    input.dispose();
  }
};
