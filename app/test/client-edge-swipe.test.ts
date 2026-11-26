// The left-edge swipe presses the screen's back arrow. It starts only within 20 px of the edge, gives
// up on vertical or leftward moves, and leaves text fields, sheets and sideways-scrolled code alone.
import { expect, test } from "bun:test";
import { backControl, EDGE_PX, edgeSwipeWanted, moveSwipe, shouldCommit, startBlocked, startSwipe, type Swipe } from "../client/edge-swipe.ts";

const drag = (points: [number, number][], t0 = 0): Swipe | null => {
  const [first, ...rest] = points;
  let s = startSwipe(first[0], first[1], t0);
  for (const [x, y] of rest) if (s) s = moveSwipe(s, x, y);
  return s;
};

test("only a touch within 20 px of the left edge can start", () => {
  expect(EDGE_PX).toBe(20);
  expect(startSwipe(0, 300, 0)?.state).toBe("pending");
  expect(startSwipe(20, 300, 0)?.state).toBe("pending");
  expect(startSwipe(21, 300, 0)).toBeNull();
  expect(startSwipe(180, 300, 0)).toBeNull();
});

test("a rightward drag locks on and follows the finger", () => {
  const s = drag([[5, 300], [9, 301], [40, 305], [160, 310]])!;
  expect(s.state).toBe("tracking");
  expect(s.dx).toBe(155);
  // Dragging back past the start pins the page at the edge instead of sliding it left.
  expect(moveSwipe(s, 0, 310).dx).toBe(0);
});

test("a vertical scroll or a leftward move from the edge is rejected for good", () => {
  expect(drag([[5, 300], [8, 340]])!.state).toBe("rejected");
  expect(drag([[15, 300], [2, 302]])!.state).toBe("rejected");
  expect(drag([[5, 300], [8, 340], [200, 340]])!.state).toBe("rejected");
});

test("moves inside the slop stay undecided", () => {
  expect(drag([[5, 300], [10, 304]])!.state).toBe("pending");
});

test("release goes back past a third of the width or on a quick flick", () => {
  const far = drag([[5, 300], [150, 300]])!;
  expect(shouldCommit(far, 2000, 390)).toBe(true);
  const short = drag([[5, 300], [60, 300]])!;
  expect(shouldCommit(short, 2000, 390)).toBe(false);
  expect(shouldCommit(short, 80, 390)).toBe(true);
  const nudge = drag([[5, 300], [30, 300]])!;
  expect(shouldCommit(nudge, 10, 390)).toBe(false);
  expect(shouldCommit(drag([[5, 300], [8, 340]])!, 10, 390)).toBe(false);
});

type Node = { matches: string[]; parentElement: Node | null; scrollLeft?: number; scrollWidth?: number; clientWidth?: number };
const node = (matches: string[] = [], parent: Node | null = null, scroll: Partial<Node> = {}): Node & { closest(s: string): unknown } => {
  const n = { matches, parentElement: parent, ...scroll } as Node & { closest(s: string): unknown };
  n.closest = (selector: string) => {
    for (let el: Node | null = n; el; el = el.parentElement) if (el.matches.some((m) => selector.split(", ").includes(m))) return el;
    return null;
  };
  return n;
};

test("text fields, open dialogs and sheets keep their touches", () => {
  expect(startBlocked(node(["[contenteditable='true']"]))).toBe(true);
  expect(startBlocked(node([], node(["textarea"])))).toBe(true);
  expect(startBlocked(node([], node(["dialog[open]"])))).toBe(true);
  expect(startBlocked(node([], node([".action-sheet"])))).toBe(true);
  expect(startBlocked(null)).toBe(true);
  expect(startBlocked(node([], node([])))).toBe(false);
});

test("a code block scrolled sideways scrolls back instead of going back", () => {
  const pre = node([], node([]), { scrollLeft: 40, scrollWidth: 900, clientWidth: 360 });
  expect(startBlocked(node([], pre))).toBe(true);
  const atStart = node([], node([]), { scrollLeft: 0, scrollWidth: 900, clientWidth: 360 });
  expect(startBlocked(node([], atStart))).toBe(false);
});

const W = 402;
const box = (left: number, top = 60, width = 44, height = 44) => ({ left, top, width, height, right: left + width, bottom: top + height });
const control = (name: string, rect = box(8), shutOff = false) => ({
  name,
  getBoundingClientRect: () => rect,
  closest: (selector: string) => (shutOff && selector.includes("[inert]") ? {} : null),
});
const hidden = (name: string) => control(name, box(0, 0, 0, 0));

test("the visible back arrow wins, most specific first", () => {
  const page: Record<string, ReturnType<typeof control>[]> = {
    ".reply-thread-back": [hidden("thread")],
    ".profile-back": [hidden("agents"), control("profile")],
    "header .mobile-back": [control("header")],
  };
  const doc = { querySelectorAll: (s: string) => page[s] || [] };
  expect(backControl<{ name: string }>(doc, W)?.name).toBe("profile");
  page[".reply-thread-back"] = [control("thread")];
  expect(backControl<{ name: string }>(doc, W)?.name).toBe("thread");
  expect(backControl({ querySelectorAll: () => [hidden("x")] }, W)).toBeNull();
});

// Regression: More > Profile > swipe showed Profile again. The closed reply thread stays in the
// page, slid offscreen and inert, and its "Back to channel" arrow won over Profile's "Back to More".
test("a closed reply thread slid offscreen or inert does not take the swipe", () => {
  const page: Record<string, ReturnType<typeof control>[]> = {
    ".reply-thread-back": [control("thread", box(W + 8))],
    ".profile-back": [control("profile")],
  };
  const doc = { querySelectorAll: (s: string) => page[s] || [] };
  expect(backControl<{ name: string }>(doc, W)?.name).toBe("profile");
  page[".reply-thread-back"] = [control("thread", box(8), true)];
  expect(backControl<{ name: string }>(doc, W)?.name).toBe("profile");
  // Open, the thread sits over its channel and its arrow wins.
  page[".reply-thread-back"] = [control("thread", box(8))];
  expect(backControl<{ name: string }>(doc, W)?.name).toBe("thread");
});

// With the keyboard up the open thread's header scrolls above the visible area. The swipe still
// closes the thread instead of skipping past the channel to Home.
test("an open thread whose header sits above the keyboard-shrunk view still wins", () => {
  const page: Record<string, ReturnType<typeof control>[]> = {
    ".reply-thread-back": [control("thread", box(8, -120))],
    "header .mobile-back": [control("header", box(8, -120))],
  };
  const doc = { querySelectorAll: (s: string) => page[s] || [] };
  expect(backControl<{ name: string }>(doc, W)?.name).toBe("thread");
});

test("the gesture runs in the iOS app and the Home Screen app, not in Safari", () => {
  expect(edgeSwipeWanted({ Capacitor: { isNativePlatform: () => true } })).toBe(true);
  expect(edgeSwipeWanted({ navigator: { standalone: true } })).toBe(true);
  expect(edgeSwipeWanted({ navigator: { standalone: false } })).toBe(false);
  expect(edgeSwipeWanted({ Capacitor: { isNativePlatform: () => false } })).toBe(false);
  expect(edgeSwipeWanted({})).toBe(false);
});
