import { type StickyNote } from "@client/reminder-notice.ts";

// After a deploy the server restarts and every open page reconnects. Each reconnect, and each
// return of a hidden tab, asks /api/version which build the server now serves; there is no polling
// loop besides that. A different build reloads the page when that loses nothing, and otherwise
// offers a sticky "Refresh" toast and reloads by itself once the page is safe to leave.
export const UPDATE_STICKY_ID = "update";
export const UPDATE_TEXT = "Slirc has an update. Refresh to get the latest version.";
export const IDLE_MS = 30_000;
// The build a reload was made for, kept per tab. A reload that comes back on the old build (a
// proxy still holding it) finds its target here and stops; the toast's Refresh still works.
const TRIED_KEY = "slirc-update-reloaded-for";

type Timer = ReturnType<typeof setTimeout>;
export interface AutoRefreshDeps {
  core: { stickies: StickyNote[] };
  /** The build this page runs; empty turns the check off. */
  loaded: string;
  fetchVersion: () => Promise<string>;
  hidden: () => boolean;
  /** Typed text, an edit, an open dialog or sheet, a staged or uploading photo, the camera. */
  busy: () => boolean;
  reload: () => void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

// The build the shell loaded: the server addresses /client.js with the bundle's hash (versionShell).
export function loadedBuild(doc: Pick<Document, "querySelector">): string {
  const src = doc.querySelector<HTMLScriptElement>('script[src*="/client.js"]')?.getAttribute("src") ?? "";
  try { return new URL(src, "http://x").searchParams.get("v") ?? ""; } catch { return ""; }
}

export function createAutoRefresh(deps: AutoRefreshDeps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const read = (): string | null => { try { return deps.storage?.getItem(TRIED_KEY) ?? null; } catch { return null; } };
  const remember = (value: string | null) => {
    try { if (value) deps.storage?.setItem(TRIED_KEY, value); else deps.storage?.removeItem(TRIED_KEY); } catch {}
  };
  let pending = "";
  let offered = "";
  let lastInput = now();
  let timer: Timer | null = null;
  let checking: Promise<void> | null = null;

  const tried = () => pending !== "" && read() === pending;
  const safe = () => !deps.busy() && (deps.hidden() || now() - lastInput >= IDLE_MS);

  function go(): void {
    stopTimer();
    remember(pending);
    deps.reload();
  }
  function stopTimer(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  // Wakes when the idle window would end; while something is still in progress, looks again a
  // window later. Local checks only, and only while an update waits.
  function schedule(): void {
    stopTimer();
    if (!pending || tried()) return;
    const wait = Math.max(lastInput + IDLE_MS - now(), 0) || IDLE_MS;
    timer = setTimer(() => { timer = null; if (pending && !tried() && safe()) go(); else schedule(); }, wait);
  }
  // One toast per new build: dismissing it keeps it away until the server ships another one.
  function offer(): void {
    if (offered === pending) return;
    offered = pending;
    deps.core.stickies = [{ id: UPDATE_STICKY_ID, text: UPDATE_TEXT, action: "Refresh", conversationId: "", icon: "refresh" },
      ...deps.core.stickies.filter((item) => item.id !== UPDATE_STICKY_ID)];
  }
  function clearToast(): void {
    if (deps.core.stickies.some((item) => item.id === UPDATE_STICKY_ID)) {
      deps.core.stickies = deps.core.stickies.filter((item) => item.id !== UPDATE_STICKY_ID);
    }
  }

  async function run(): Promise<void> {
    if (!deps.loaded) return;
    const served = await deps.fetchVersion().catch(() => "");
    if (!served) return;
    if (served === deps.loaded) {
      pending = ""; remember(null); clearToast(); stopTimer();
      return;
    }
    pending = served;
    if (tried()) { offer(); return; }
    if (safe()) { go(); return; }
    offer();
    schedule();
  }
  // Reconnect and visibility can fire together; they share one request.
  function check(): Promise<void> {
    return checking ??= run().finally(() => { checking = null; });
  }

  return {
    check,
    /** Any input from the person restarts the idle window. */
    activity(): void {
      lastInput = now();
      if (pending) schedule();
    },
    visibility(): void {
      if (!deps.hidden()) { void check(); return; }
      if (pending && !tried() && safe()) go();
    },
    open(id: string): boolean {
      if (id !== UPDATE_STICKY_ID) return false;
      clearToast();
      if (pending) remember(pending);
      deps.reload();
      return true;
    },
    dismiss(id: string): boolean {
      if (id !== UPDATE_STICKY_ID) return false;
      clearToast();
      return true;
    },
    stop: stopTimer,
  };
}
