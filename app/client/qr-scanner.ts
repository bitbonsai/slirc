// "Scan to sign in": the installed phone app reads the desktop's pairing QR with its own camera.
// On iOS a home-screen app has separate storage from Safari, so a Camera-app scan signs in Safari
// only; this is how the installed app gets in.
import { offerToken, otherWorkspacePairLink, redeemOffer } from "@client/phone-offer.ts";

type Decoder = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: string }) => { data: string } | null;

export type QrScannerDeps = {
  origin: () => string;
  // Called once the offer is redeemed and this browser holds a session.
  onSignedIn: () => void;
  redeem?: (token: string) => Promise<string>;
  // Opens another workspace's pair link. Defaults to location.assign.
  navigate?: (url: string) => void;
  camera?: () => Promise<MediaStream>;
  decoder?: () => Promise<Decoder>;
  // Pixels of the current video frame, or null while the camera warms up.
  frame?: (video: HTMLVideoElement) => { data: Uint8ClampedArray; width: number; height: number } | null;
  schedule?: (callback: () => void) => number;
  cancel?: (handle: number) => void;
};

const CAMERA_ERROR = "Camera unavailable. Link with a code instead.";
const DECODER_URL = "/vendor/jsqr.js";
// Decode about eight frames a second at reduced size: plenty for a QR, light on the battery.
const DECODE_INTERVAL_MS = 120;
const MAX_FRAME_SIDE = 720;

let decoderLoad: Promise<Decoder> | null = null;
// The decoder is a vendored same-origin script, fetched the first time the scanner opens.
function loadDecoder(): Promise<Decoder> {
  const ready = () => (globalThis as { jsQR?: Decoder }).jsQR;
  if (ready()) return Promise.resolve(ready() as Decoder);
  decoderLoad ??= new Promise<Decoder>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = DECODER_URL;
    script.onload = () => { const decode = ready(); if (decode) resolve(decode); else reject(new Error("decoder missing")); };
    script.onerror = () => { script.remove(); decoderLoad = null; reject(new Error("decoder failed to load")); };
    document.head.append(script);
  });
  return decoderLoad;
}

function openCamera(): Promise<MediaStream> {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) return Promise.reject(new Error("no camera API"));
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
}

let canvas: HTMLCanvasElement | null = null;
function videoFrame(video: HTMLVideoElement) {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
  canvas ??= document.createElement("canvas");
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

export function createQrScanner(reactive: <T extends object>(value: T) => T, deps: QrScannerDeps) {
  const redeem = deps.redeem ?? ((token: string) => redeemOffer(token));
  const camera = deps.camera ?? openCamera;
  const decoder = deps.decoder ?? loadDecoder;
  const frame = deps.frame ?? videoFrame;
  const schedule = deps.schedule ?? ((callback: () => void) => requestAnimationFrame(callback));
  const cancel = deps.cancel ?? ((handle: number) => cancelAnimationFrame(handle));
  let epoch = 0;
  let stream: MediaStream | null = null;
  let element: HTMLVideoElement | null = null;
  let pending: number | null = null;
  let lastDecode = 0;
  const navigate = deps.navigate ?? ((url: string) => location.assign(url));
  // elsewhere holds another workspace's pair link after one is scanned, so the panel can open it.
  const local = reactive({ open: false, starting: false, scanning: false, redeeming: false, error: "", elsewhere: "" });

  // Releases the camera. Called the moment a code is accepted, the panel is left, or the page hides.
  function release(): void {
    epoch += 1;
    if (pending !== null) cancel(pending);
    pending = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    if (element) { try { element.pause(); } catch {} element.srcObject = null; }
    element = null;
    local.starting = false; local.scanning = false;
  }

  function close(): void {
    release();
    local.open = false; local.redeeming = false; local.error = ""; local.elsewhere = "";
  }

  function openElsewhere(): void {
    const target = local.elsewhere;
    if (!target) return;
    close();
    navigate(target);
  }

  // A decoded QR value. This origin's pair link signs in here. Another workspace's pair link stops
  // the camera and names that workspace, since the code works only there. Anything else is ignored
  // and scanning goes on.
  async function decoded(text: unknown): Promise<boolean> {
    if (!local.open || !local.scanning || local.redeeming) return false;
    const token = offerToken(text, deps.origin());
    if (!token) {
      const other = otherWorkspacePairLink(text, deps.origin());
      if (!other) return false;
      release();
      local.elsewhere = other;
      local.error = `This code is for ${new URL(other).host}. Open that workspace to sign in there.`;
      return true;
    }
    release();
    local.redeeming = true;
    const failure = await redeem(token);
    if (!local.open) return true;
    local.redeeming = false;
    if (failure) { local.error = failure; return true; }
    close();
    deps.onSignedIn();
    return true;
  }

  function loop(decode: Decoder, current: number): void {
    if (current !== epoch || !element) return;
    const time = Date.now();
    if (time - lastDecode >= DECODE_INTERVAL_MS) {
      lastDecode = time;
      let found: { data: string } | null = null;
      try {
        const image = frame(element);
        if (image) found = decode(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
      } catch { found = null; }
      if (found?.data) { void decoded(found.data); if (current !== epoch) return; }
    }
    pending = schedule(() => loop(decode, current));
  }

  async function start(video: HTMLVideoElement | null | undefined): Promise<void> {
    if (local.starting || local.scanning || local.redeeming) return;
    release();
    const current = epoch;
    local.open = true; local.starting = true; local.error = ""; local.elsewhere = "";
    try {
      if (!video) throw new Error("no video element");
      const decode = await decoder();
      if (current !== epoch) return;
      const opened = await camera();
      if (current !== epoch) { for (const track of opened.getTracks()) track.stop(); return; }
      stream = opened; element = video;
      video.setAttribute("playsinline", "");
      video.muted = true;
      video.srcObject = opened;
      await video.play();
      if (current !== epoch) return;
      local.starting = false; local.scanning = true;
      lastDecode = 0;
      loop(decode, current);
    } catch {
      if (current !== epoch) return;
      release();
      local.error = CAMERA_ERROR;
    }
  }

  function hidden(): void {
    if (local.open) close();
  }

  return Object.assign(local, { start, close, decoded, openElsewhere, hidden, destroy: close });
}
