import { type ClientSession } from "@client/client-state.ts";
import { workspaceIconUrl, type WorkspaceMark } from "@client/workspace-mark.ts";

// Admin > Branding: an admin picks an image, crops it to a fixed square (drag to move, zoom), and
// saves it as the workspace icon. The browser sends only the cropped square; the server checks the
// admin, re-encodes it to 64 and 256 px WebP and serves it from GET /api/workspace-icon.
//
// The crop is kept in image pixels: (cx, cy) is the centre of the square and `side` its edge, so a
// resized viewport never moves it. At zoom 1 the square spans the image's short side.

export const ICON_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const ICON_MAX_PICK_BYTES = 12 * 1024 * 1024;
export const ICON_OUTPUT = 512;
export const ICON_MAX_ZOOM = 4;

export interface Crop { width: number; height: number; zoom: number; cx: number; cy: number }

export const cropSide = (crop: Crop) => Math.min(crop.width, crop.height) / crop.zoom;

// Keeps the zoom in range and the square inside the image.
export function clampCrop(crop: Crop): Crop {
  const zoom = Math.min(ICON_MAX_ZOOM, Math.max(1, Number(crop.zoom) || 1));
  const half = Math.min(crop.width, crop.height) / zoom / 2;
  const cx = Math.min(crop.width - half, Math.max(half, crop.cx));
  const cy = Math.min(crop.height - half, Math.max(half, crop.cy));
  return { ...crop, zoom, cx, cy };
}

// Moves by a drag of (dx, dy) screen pixels in a viewport `view` pixels wide. Dragging right shows
// more of the left side, as with any photo crop.
export function moveCrop(crop: Crop, dx: number, dy: number, view: number): Crop {
  const scale = cropSide(crop) / (view || 1);
  return clampCrop({ ...crop, cx: crop.cx - dx * scale, cy: crop.cy - dy * scale });
}

// Where the image sits inside the square viewport, in percent of the viewport, so the markup needs
// no pixel sizes.
export function cropStyle(crop: Crop): string {
  const side = cropSide(crop);
  const pct = (value: number) => `${(value * 100).toFixed(3)}%`;
  return `width:${pct(crop.width / side)};height:${pct(crop.height / side)};left:${pct(0.5 - crop.cx / side)};top:${pct(0.5 - crop.cy / side)}`;
}

// The square to copy out of the original image.
export function cropSource(crop: Crop): { sx: number; sy: number; side: number } {
  const side = cropSide(crop);
  return { sx: crop.cx - side / 2, sy: crop.cy - side / 2, side };
}

export function pickError(file: { type: string; size: number }): string {
  if (!ICON_TYPES.includes(file.type)) return "Use a PNG, JPEG or WebP image.";
  if (!file.size) return "That file is empty.";
  if (file.size > ICON_MAX_PICK_BYTES) return "Choose an image under 12 MB.";
  return "";
}

const ICON_WRITE = { credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Slirc-Admin": "1" } } as const;

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function createWorkspaceIcon(reactive: <T extends object>(value: T) => T, { core, session }: {
  core: { authenticated: boolean; account: string; workspace: WorkspaceMark };
  session: ClientSession;
}) {
  const local = reactive({
    busy: "" as "" | "save" | "remove",
    error: "",
    note: "",
    src: "",
    crop: null as Crop | null,
  });
  let image: HTMLImageElement | null = null;
  let invoker: HTMLElement | null = null;
  let drag: { id: number; x: number; y: number; view: number } | null = null;

  // A new address makes this tab load the new icon at once; other tabs follow within a minute.
  // With no icon left the address is cleared, so nothing asks for one.
  function refreshMark(version: string): void {
    if (core.workspace.logo) return;
    if (!version) core.workspace.iconReady = false;
    core.workspace.icon = workspaceIconUrl("", version);
  }

  function closeCrop(): void {
    if (local.src) URL.revokeObjectURL(local.src);
    local.src = ""; local.crop = null; image = null; drag = null;
    void Promise.resolve().then(() => { if (invoker?.isConnected) invoker.focus(); invoker = null; });
  }

  async function pick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // Picking the same file again after Cancel must fire change.
    if (!file || local.busy) return;
    local.error = ""; local.note = "";
    const problem = pickError(file);
    if (problem) { local.error = problem; return; }
    const src = URL.createObjectURL(file);
    const picked = new Image();
    picked.src = src;
    try { await picked.decode(); } catch {
      URL.revokeObjectURL(src);
      local.error = "Could not read this image. Try a PNG, JPEG or WebP.";
      return;
    }
    invoker = input.closest("label") ?? input;
    image = picked;
    local.src = src;
    local.crop = clampCrop({ width: picked.naturalWidth, height: picked.naturalHeight, zoom: 1, cx: picked.naturalWidth / 2, cy: picked.naturalHeight / 2 });
  }

  function setZoom(value: unknown): void {
    if (local.crop) local.crop = clampCrop({ ...local.crop, zoom: Number(value) });
  }

  function pointerDown(event: PointerEvent): void {
    if (!local.crop || event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, view: target.clientWidth };
    event.preventDefault();
  }

  function pointerMove(event: PointerEvent): void {
    if (!drag || !local.crop || event.pointerId !== drag.id) return;
    local.crop = moveCrop(local.crop, event.clientX - drag.x, event.clientY - drag.y, drag.view);
    drag.x = event.clientX; drag.y = event.clientY;
  }

  function pointerUp(event: PointerEvent): void {
    if (drag?.id === event.pointerId) drag = null;
  }

  function wheel(event: WheelEvent): void {
    if (!local.crop) return;
    event.preventDefault();
    setZoom(local.crop.zoom * Math.exp(-event.deltaY / 400));
  }

  // Arrow keys move the image a twentieth of the square; + and - zoom.
  function keydown(event: KeyboardEvent): void {
    if (!local.crop) return;
    const view = (event.currentTarget as HTMLElement).clientWidth || 1;
    const step = view / 20;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) { local.crop = moveCrop(local.crop, moves[event.key]![0], moves[event.key]![1], view); event.preventDefault(); }
    else if (event.key === "+" || event.key === "=") { setZoom(local.crop.zoom * 1.1); event.preventDefault(); }
    else if (event.key === "-") { setZoom(local.crop.zoom / 1.1); event.preventDefault(); }
  }

  async function save(): Promise<void> {
    const crop = local.crop;
    const scope = session.scope();
    if (!crop || !image || local.busy || !scope || !core.authenticated) return;
    local.busy = "save"; local.error = "";
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = ICON_OUTPUT;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not prepare this image.");
      const { sx, sy, side } = cropSource(crop);
      context.imageSmoothingQuality = "high";
      context.drawImage(image, sx, sy, side, side, 0, 0, ICON_OUTPUT, ICON_OUTPUT);
      // Safari may not encode WebP; it hands back PNG instead, which the server also takes.
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
      if (!blob) throw new Error("Could not prepare this image.");
      const response = await fetch("/api/admin/workspace-icon", {
        ...ICON_WRITE, method: "POST", signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ mime: blob.type || "image/png", data: await base64(blob) }),
      });
      const body = await response.json().catch(() => ({})) as { error?: unknown; version?: unknown };
      if (session.scope()?.account !== scope.account) return;
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Could not save the icon (${response.status}).`);
      refreshMark(String(body.version || Date.now()));
      local.note = "Icon saved.";
      closeCrop();
    } catch (error) {
      local.error = error instanceof Error ? error.message : "Could not save the icon.";
    } finally {
      local.busy = "";
    }
  }

  async function remove(): Promise<void> {
    if (local.busy || !core.authenticated) return;
    local.busy = "remove"; local.error = ""; local.note = "";
    try {
      const response = await fetch("/api/admin/workspace-icon", { ...ICON_WRITE, method: "DELETE", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : "Could not remove the icon.");
      }
      refreshMark("");
      local.note = "Icon removed. The letter tile is back.";
    } catch (error) {
      local.error = error instanceof Error ? error.message : "Could not remove the icon.";
    } finally {
      local.busy = "";
    }
  }

  function reset(): void {
    if (local.src) URL.revokeObjectURL(local.src);
    Object.assign(local, { busy: "", error: "", note: "", src: "", crop: null });
    image = null; invoker = null; drag = null;
  }

  return Object.assign(local, {
    pick, setZoom, pointerDown, pointerMove, pointerUp, wheel, keydown, save, remove, reset,
    cancel: () => { if (!local.busy) closeCrop(); },
    style: () => (local.crop ? cropStyle(local.crop) : ""),
    maxZoom: ICON_MAX_ZOOM,
  });
}
