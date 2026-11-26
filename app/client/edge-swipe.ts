// Swipe from the left edge to go back, the way iPhone apps do. It works on phones in the iOS app
// and the Home Screen app, where WebKit offers no back gesture of its own; Safari keeps its own.
// The gesture presses whichever back arrow the screen shows, so it always does what that arrow
// does: a channel or DM back to its list, a reply thread back to its channel, a More page back to
// More. A screen with no back arrow (the tabs) ignores the swipe.
//
// Why not WKWebView's allowsBackForwardNavigationGestures: the arrows are app routes, not history
// steps. Some push a new entry (More pages call openMore), the router keeps its own cursor, and
// the shell's first entry is the workspace picker, so a history swipe could leave the workspace.

export const EDGE_PX = 20;
const SLOP_PX = 8;
const COMMIT_RATIO = 0.35;
const FLICK_PX = 40;
const FLICK_SPEED = 0.5; // px per ms

// Most specific first: the reply thread sits over its channel's header.
const BACK_CONTROLS = [".reply-thread-back", ".profile-back", "header .mobile-back"];

export type Swipe = { x0: number; y0: number; t0: number; dx: number; state: "pending" | "tracking" | "rejected" };

export function startSwipe(x: number, y: number, t: number): Swipe | null {
  return x <= EDGE_PX ? { x0: x, y0: y, t0: t, dx: 0, state: "pending" } : null;
}

// A swipe locks on once it moves mostly rightward past the slop; anything else hands the touch back
// to scrolling for the rest of its life.
export function moveSwipe(s: Swipe, x: number, y: number): Swipe {
  if (s.state === "rejected") return s;
  const dx = x - s.x0, dy = y - s.y0;
  if (s.state === "pending") {
    if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return s;
    return dx > Math.abs(dy) ? { ...s, dx: Math.max(0, dx), state: "tracking" } : { ...s, state: "rejected" };
  }
  return { ...s, dx: Math.max(0, dx) };
}

export function shouldCommit(s: Swipe, t: number, width: number): boolean {
  if (s.state !== "tracking") return false;
  const speed = s.dx / Math.max(1, t - s.t0);
  return s.dx >= width * COMMIT_RATIO || (s.dx >= FLICK_PX && speed >= FLICK_SPEED);
}

type El = { closest(selector: string): unknown; parentElement: El | null; scrollLeft?: number; scrollWidth?: number; clientWidth?: number };

// Text fields keep their own touches (caret moves, selection), an open dialog or sheet owns the
// screen, and a code block or table already scrolled sideways scrolls back instead.
export function startBlocked(target: El | null): boolean {
  if (!target) return true;
  if (target.closest("input, textarea, select, [contenteditable='true'], [contenteditable=''], dialog[open], .action-sheet")) return true;
  for (let el: El | null = target; el; el = el.parentElement) {
    if ((el.scrollLeft || 0) > 0 && (el.scrollWidth || 0) > (el.clientWidth || 0)) return true;
  }
  return false;
}

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type Control = { closest(selector: string): unknown; getBoundingClientRect(): Rect };
type Doc = { querySelectorAll(selector: string): ArrayLike<Control> };

// A closed panel can stay in the page, slid offscreen sideways and inert, as the reply thread does
// while it animates. Its back arrow still has a box, so a box alone would let it win and do nothing.
// Only the sideways position counts: with the keyboard up, an open thread's header can sit above
// the visible area and its arrow must still win.
function onScreen(el: Control, width: number): boolean {
  if (el.closest("[inert], [aria-hidden='true']")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.left < width;
}

export function backControl<T>(doc: Doc, width: number): T | null {
  for (const selector of BACK_CONTROLS) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      if (onScreen(el, width)) return el as T;
    }
  }
  return null;
}

export function edgeSwipeWanted(win: { Capacitor?: { isNativePlatform?: () => boolean }; navigator?: { standalone?: boolean } }): boolean {
  return !!win.Capacitor?.isNativePlatform?.() || win.navigator?.standalone === true;
}

// The page follows the finger by sliding <body>; on release it finishes the slide and presses the
// arrow, or springs back. Reduced motion skips the slide and only presses the arrow.
export function installEdgeSwipe(signal: AbortSignal): void {
  const body = document.body;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let swipe: Swipe | null = null;
  let target: HTMLElement | null = null;

  const slide = (dx: number, animate: boolean) => {
    if (reduced()) return;
    body.style.transition = animate ? "transform var(--dur-base) ease-out" : "none";
    body.style.transform = dx ? `translateX(${dx}px)` : "";
  };
  const reset = () => { body.style.transition = ""; body.style.transform = ""; };

  document.addEventListener("touchstart", (event) => {
    swipe = null; target = null;
    if (event.touches.length !== 1 || document.querySelector("dialog[open]")) return;
    const touch = event.touches[0];
    const start = startSwipe(touch.clientX, touch.clientY, event.timeStamp);
    if (!start || startBlocked(event.target as Element | null)) return;
    target = backControl<HTMLElement>(document, innerWidth);
    if (target) swipe = start;
  }, { signal, passive: true, capture: true });

  document.addEventListener("touchmove", (event) => {
    if (!swipe || event.touches.length !== 1) return;
    const touch = event.touches[0];
    swipe = moveSwipe(swipe, touch.clientX, touch.clientY);
    if (swipe.state === "rejected") { swipe = null; return; }
    if (swipe.state !== "tracking") return;
    event.preventDefault();
    slide(swipe.dx, false);
  }, { signal, passive: false, capture: true });

  const end = (event: TouchEvent) => {
    const s = swipe, back = target;
    swipe = null; target = null;
    if (!s || s.state !== "tracking" || !back) return;
    if (!shouldCommit(s, event.timeStamp, innerWidth)) { slide(0, true); setTimeout(reset, 250); return; }
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (reduced()) { back.click(); return; }
    slide(innerWidth, true);
    setTimeout(() => { back.click(); reset(); }, 200);
  };
  document.addEventListener("touchend", end, { signal, capture: true });
  document.addEventListener("touchcancel", () => { if (swipe?.state === "tracking") { slide(0, true); setTimeout(reset, 250); } swipe = null; target = null; }, { signal, capture: true });
}
