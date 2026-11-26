// Video compression before upload: which clips are re-encoded and to what size, and that every
// failure path hands back null so the original uploads instead.
import { expect, test } from "bun:test";
import { compressVideo, mp4Name, SMALL_VIDEO_BYTES, videoPlan, type EncodeVideo } from "@client/video-compress.ts";

const MB = 1024 * 1024;

test("a small clip within 720p goes up as it is", () => {
  expect(videoPlan({ size: SMALL_VIDEO_BYTES - 1, width: 1280, height: 720, duration: 5 })).toBeNull();
  expect(videoPlan({ size: 2 * MB, width: 720, height: 1280, duration: 5 })).toBeNull();
});

test("a 720p clip already near the target bitrate is not re-encoded", () => {
  // 30 s at about 2.8 Mbps total.
  expect(videoPlan({ size: 10 * MB, width: 1280, height: 720, duration: 30 })).toBeNull();
  // The same size in 10 s is about 8 Mbps: worth it, at the same dimensions.
  expect(videoPlan({ size: 10 * MB, width: 1280, height: 720, duration: 10 })).toEqual({ width: 1280, height: 720 });
});

test("bigger clips scale to a 1280 long edge and a 720 short edge, even, either way up", () => {
  expect(videoPlan({ size: 2 * MB, width: 1920, height: 1080, duration: 2 })).toEqual({ width: 1280, height: 720 });
  expect(videoPlan({ size: 90 * MB, width: 2160, height: 3840, duration: 30 })).toEqual({ width: 720, height: 1280 });
  // Square: the short edge rules.
  expect(videoPlan({ size: 20 * MB, width: 1080, height: 1080, duration: 10 })).toEqual({ width: 720, height: 720 });
  const odd = videoPlan({ size: 20 * MB, width: 1921, height: 1081, duration: 10 })!;
  expect(odd.width % 2).toBe(0);
  expect(odd.height % 2).toBe(0);
});

test("a clip with no readable dimensions is left alone", () => {
  expect(videoPlan({ size: 20 * MB, width: 0, height: 0, duration: 10 })).toBeNull();
});

const clip = new File([new Uint8Array(1000)], "IMG_0001.MOV", { type: "video/quicktime" });
const run = (encode: EncodeVideo | (() => never), extra: { supported?: boolean; signal?: AbortSignal; load?: () => Promise<EncodeVideo> } = {}) =>
  compressVideo(clip, { onProgress: () => {}, signal: extra.signal ?? new AbortController().signal, supported: extra.supported ?? true, load: extra.load ?? (async () => encode as EncodeVideo) });

test("a smaller result comes back as an MP4 named after the original", async () => {
  const out = await run(async () => new Blob([new Uint8Array(400)], { type: "video/mp4" }));
  expect(out?.type).toBe("video/mp4");
  expect(out?.name).toBe("IMG_0001.mp4");
  expect(out?.size).toBe(400);
  expect(mp4Name("")).toBe("video.mp4");
});

test("no support, a failed load, a failed or skipped encode, or a bigger result keeps the original", async () => {
  let loads = 0;
  expect(await run(async () => new Blob([new Uint8Array(1)]), { supported: false, load: async () => { loads += 1; return async () => null; } })).toBeNull();
  expect(loads).toBe(0); // no support means the encoder bundle is never fetched
  expect(await run(async () => null, { load: () => Promise.reject(new Error("offline")) })).toBeNull();
  expect(await run(() => { throw new Error("decoder"); })).toBeNull();
  expect(await run(async () => { throw new Error("encoder"); })).toBeNull();
  expect(await run(async () => null)).toBeNull();
  expect(await run(async () => new Blob([new Uint8Array(1000)]))).toBeNull();
  expect(await run(async () => new Blob([]))).toBeNull();
});

test("a cancel during the encode keeps nothing", async () => {
  const controller = new AbortController();
  const out = await run(async () => { controller.abort(); return new Blob([new Uint8Array(10)]); }, { signal: controller.signal });
  expect(out).toBeNull();
});
