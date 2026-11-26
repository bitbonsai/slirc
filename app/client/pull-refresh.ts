// Pull-to-refresh on the phone Home, DMs and More screens and the conversation view. A downward pull from the very top of
// a scroller drags the Slirc logo with resistance; past PULL_THRESHOLD a release runs a cheap
// catch-up (live connection check plus newer history for the open conversation). When it is caught
// up the logo pops and leaves; offline or unreachable gets a short note first. Never a page reload.
//
// Gestures it leaves alone: a touch near either screen edge (the iOS swipe back), a touch while the
// composer has focus (dragging the list down puts the keyboard away), and any pull that does not
// start at scrollTop 0, so reading back through history never turns into a refresh.

export const PULL_THRESHOLD = 64;
// The chip never travels further than this, however far the finger goes.
export const PULL_MAX = 96;
// Where the chip rests while the catch-up runs.
export const PULL_HOLD = 52;
// A touch this close to the left or right edge belongs to the system back swipe.
export const EDGE_GUARD = 24;
// Movement before the gesture decides between a pull and anything else.
const SLOP = 8;
// A caught-up pull ends with a short pop of the logo before the chip leaves. A problem keeps its
// note on screen long enough to read.
export const DONE_MS = 260;
export const RESULT_MS = 1400;

export type PullResult = "current" | "offline" | "failed";
export type PullState = "idle" | "pulling" | "refreshing" | PullResult;

// Rubber band: close to 1:1 at first, stiffening towards PULL_MAX. About 115 px of finger travel
// reaches the threshold.
export function pullOffset(dy: number): number {
  if (!(dy > 0)) return 0;
  return PULL_MAX * (1 - Math.exp(-dy / 105));
}

export function pullLabel(state: PullState): string {
  if (state === "offline") return "You're offline";
  if (state === "failed") return "Couldn't reach Slirc";
  return "";
}

interface Scroller {
  scrollTop: number;
  addEventListener(type: string, listener: (event: any) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: any) => void, options?: EventListenerOptions): void;
}

export interface PullGestureDeps {
  scroller: Scroller;
  refresh: () => Promise<PullResult>;
  /** Phone layout only; checked at the start of every touch. */
  enabled: () => boolean;
  render: (state: PullState, offset: number) => void;
  /** Viewport width for the edge guard. */
  width?: () => number;
  /** The composer has focus: the downward drag belongs to the keyboard. */
  typing?: () => boolean;
  wait?: (ms: number) => Promise<void>;
}

export function createPullGesture(deps: PullGestureDeps) {
  const width = deps.width ?? (() => globalThis.innerWidth ?? 0);
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let state: PullState = "idle";
  let start: { x: number; y: number } | null = null;
  let engaged = false;
  let offset = 0;

  const set = (next: PullState, value: number): void => { state = next; offset = value; deps.render(next, value); };
  const reset = (): void => { start = null; engaged = false; };

  function touchstart(event: TouchEvent): void {
    reset();
    if (state !== "idle" || !deps.enabled() || event.touches.length !== 1) return;
    if (deps.scroller.scrollTop > 0 || deps.typing?.()) return;
    const touch = event.touches[0]!;
    if (touch.clientX < EDGE_GUARD || touch.clientX > width() - EDGE_GUARD) return;
    start = { x: touch.clientX, y: touch.clientY };
  }

  function touchmove(event: TouchEvent): void {
    if (!start || event.touches.length !== 1) { if (engaged) cancel(); return; }
    const touch = event.touches[0]!;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!engaged) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      // Sideways, upwards, or the list has moved: not a pull, and it stays that way until lift.
      if (dy <= 0 || Math.abs(dx) > dy || deps.scroller.scrollTop > 0) { start = null; return; }
      engaged = true;
    }
    // Hold the list still while the chip follows the finger, instead of the native bounce.
    if (event.cancelable) event.preventDefault();
    set("pulling", pullOffset(dy));
  }

  function touchend(): void {
    const pulled = engaged ? offset : 0;
    reset();
    if (state !== "pulling") return;
    if (pulled >= PULL_THRESHOLD) void run();
    else set("idle", 0);
  }

  function cancel(): void {
    reset();
    if (state === "pulling") set("idle", 0);
  }

  async function run(): Promise<void> {
    set("refreshing", PULL_HOLD);
    let result: PullResult;
    try { result = await deps.refresh(); } catch { result = "failed"; }
    set(result, PULL_HOLD);
    await wait(result === "current" ? DONE_MS : RESULT_MS);
    set("idle", 0);
  }

  deps.scroller.addEventListener("touchstart", touchstart, { passive: true });
  deps.scroller.addEventListener("touchmove", touchmove, { passive: false });
  deps.scroller.addEventListener("touchend", touchend, { passive: true });
  deps.scroller.addEventListener("touchcancel", cancel, { passive: true });
  return {
    state: () => state,
    destroy(): void {
      deps.scroller.removeEventListener("touchstart", touchstart);
      deps.scroller.removeEventListener("touchmove", touchmove);
      deps.scroller.removeEventListener("touchend", touchend);
      deps.scroller.removeEventListener("touchcancel", cancel);
    },
  };
}

// One fresh object per mount (Home, DMs and the conversation each mount their own chip). The chip
// sits next to its scroller: `list` finds the phone screen body beside it, `chat` the #chat it is in.
export function pullRefreshComponent(target: "list" | "chat", deps: { refresh: () => Promise<PullResult>; enabled: () => boolean }) {
  let gesture: ReturnType<typeof createPullGesture> | null = null;
  return {
    pullState: "idle" as PullState,
    pullOffset: 0,
    init(this: any): void {
      const el = this.$el as HTMLElement;
      const scroller = target === "chat" ? el.closest<HTMLElement>(".chat") : el.parentElement?.querySelector<HTMLElement>(".mobile-screen-body");
      if (!scroller) return;
      gesture = createPullGesture({
        scroller,
        refresh: deps.refresh,
        enabled: deps.enabled,
        typing: () => !!document.activeElement?.closest?.(".composer"),
        render: (state, offset) => { this.pullState = state; this.pullOffset = offset; },
      });
    },
    destroy(): void { gesture?.destroy(); gesture = null; },
    pullLabel(this: any): string { return pullLabel(this.pullState); },
    pullArmed(this: any): boolean { return this.pullState === "pulling" && this.pullOffset >= PULL_THRESHOLD; },
    pullStyle(this: any): string {
      return `--pull: ${this.pullOffset.toFixed(1)}px; --pull-progress: ${Math.min(this.pullOffset / PULL_THRESHOLD, 1).toFixed(3)}`;
    },
  };
}
