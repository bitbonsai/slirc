import { afterEach, expect, test } from "bun:test";
import { createChannelDrag, orderChannels, reorderChannelIds, targetDragIndex } from "@client/channel-order.ts";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
  else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete (globalThis as Record<string, unknown>).document;
  else globalThis.document = originalDocument;
});

test("orderChannels sorts known channels by saved order and appends new ones in original order", () => {
  const items = [
    { id: "room:feedback" },
    { id: "room:myarc" },
    { id: "room:issues" },
    { id: "room:discussions" },
  ];
  expect(orderChannels(items, [], (item) => item.id).map((item) => item.id)).toEqual([
    "room:feedback",
    "room:myarc",
    "room:issues",
    "room:discussions",
  ]);
  expect(orderChannels(items, ["room:discussions", "room:missing", "room:myarc", "room:discussions"], (item) => item.id).map((item) => item.id)).toEqual([
    "room:discussions",
    "room:myarc",
    "room:feedback",
    "room:issues",
  ]);
});

test("reorderChannelIds moves the visible item and preserves hidden starred IDs", () => {
  const visible = ["room:feedback", "room:myarc", "room:issues", "room:discussions"];
  const current = ["room:feedback", "room:starred", "room:myarc", "room:issues", "room:discussions"];
  expect(reorderChannelIds(visible, current, 3, 1)).toEqual([
    "room:feedback",
    "room:discussions",
    "room:myarc",
    "room:issues",
    "room:starred",
  ]);
  expect(reorderChannelIds(visible, current, 0, 2)).toEqual([
    "room:myarc",
    "room:issues",
    "room:feedback",
    "room:discussions",
    "room:starred",
  ]);
  expect(reorderChannelIds(visible, current, 1, 1)).toEqual(current);
  expect(reorderChannelIds(visible, current, -1, 1)).toEqual(current);
  expect(reorderChannelIds(visible, current, 1, 9)).toEqual(current);
});

test("targetDragIndex uses directional midpoints without oscillating on variable-height items", () => {
  // Channel 0 has expanded threads (height 120, mid 60); Channel 1 is compact (height 40, mid 140).
  const before = [{ top: 0, height: 120 }, { top: 120, height: 40 }];
  // Dragging item 1 upward across item 0's midpoint (60) moves it to index 0.
  expect(targetDragIndex(70, 1, before)).toBe(1);
  expect(targetDragIndex(59, 1, before)).toBe(0);
  // After swapping, item 1 is at 0..40 and item 0 is at 40..160 (mid 100). Same pointer Y=59 stays at 0.
  const afterUp = [{ top: 0, height: 40 }, { top: 40, height: 120 }];
  expect(targetDragIndex(59, 0, afterUp)).toBe(0);

  // Dragging tall item 0 downward across item 1's midpoint (140) moves it to index 1.
  expect(targetDragIndex(135, 0, before)).toBe(0);
  expect(targetDragIndex(145, 0, before)).toBe(1);
  // After swapping, item 1 is at 0..40 (mid 20) and item 0 is at 40..160. Same pointer Y=145 stays at 1.
  expect(targetDragIndex(145, 1, afterUp)).toBe(1);
});

function fakeWindow() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const win = {
    addEventListener(type: string, fn: (event: any) => void) {
      let set = listeners.get(type);
      if (!set) { set = new Set(); listeners.set(type, set); }
      set.add(fn);
    },
    removeEventListener(type: string, fn: (event: any) => void) {
      listeners.get(type)?.delete(fn);
    },
    emit(type: string, event: any) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  globalThis.window = win as unknown as Window & typeof globalThis;
  return win;
}

test("createChannelDrag distinguishes clicks from drags, reorders live, persists on drop, and supports Alt+Arrows", () => {
  const win = fakeWindow();
  const base = [
    { conversationId: "room:feedback" },
    { conversationId: "room:myarc" },
    { conversationId: "room:issues" },
    { conversationId: "room:discussions" },
  ];
  let order: string[] = [];
  const saved: string[][] = [];
  let menusClosed = 0;
  let focusedId = "";

  const list = () => orderChannels(base, order, (item) => item.conversationId);
  const queryItems = () => list().map((item, idx) => ({
    getAttribute: (name: string) => (name === "data-channel-id" ? item.conversationId : null),
    getBoundingClientRect: () => ({ top: idx * 40, height: 40 }),
    querySelector: () => ({ focus: () => { focusedId = item.conversationId; } }),
  })) as unknown as HTMLElement[];

  const drag = createChannelDrag((v) => v, {
    list,
    order: () => order,
    setOrder: (ids) => { order = ids; },
    saveOrder: (ids) => { saved.push([...ids]); },
    closeMenus: () => { menusClosed++; },
    nextTick: (cb) => { cb(); },
    queryItems,
  });

  // 1. Small movement (< 5px) is a normal click, not a drag.
  drag.pointerDown({ button: 0, pointerType: "mouse", pointerId: 1, clientY: 20, target: { closest: () => null } } as unknown as PointerEvent, "room:feedback");
  win.emit("pointermove", { pointerId: 1, clientY: 23 });
  expect(drag.draggingId).toBe("");
  win.emit("pointerup", { pointerId: 1, clientY: 23 });
  expect(drag.consumeClick()).toBe(false);
  expect(saved).toEqual([]);
  expect(win.listenerCount("pointermove")).toBe(0);

  // 2. Clicking the kebab button or touch pointer never starts a drag.
  drag.pointerDown({ button: 0, pointerType: "mouse", pointerId: 2, clientY: 20, target: { closest: (sel: string) => (sel === ".channel-kebab" ? {} : null) } } as unknown as PointerEvent, "room:feedback");
  expect(win.listenerCount("pointermove")).toBe(0);
  drag.pointerDown({ button: 0, pointerType: "touch", pointerId: 3, clientY: 20, target: { closest: () => null } } as unknown as PointerEvent, "room:feedback");
  expect(win.listenerCount("pointermove")).toBe(0);

  // 3. Dragging #discussions (index 3, y=120..160) up above #myarc (index 1, mid=60).
  drag.pointerDown({ button: 0, pointerType: "mouse", pointerId: 4, clientY: 140, target: { closest: () => null } } as unknown as PointerEvent, "room:discussions");
  win.emit("pointermove", { pointerId: 4, clientY: 130 });
  expect(drag.draggingId).toBe("room:discussions");
  expect(menusClosed).toBe(1);
  win.emit("pointermove", { pointerId: 4, clientY: 50 });
  expect(list().map((item) => item.conversationId)).toEqual([
    "room:feedback",
    "room:discussions",
    "room:myarc",
    "room:issues",
  ]);
  expect(saved).toEqual([]);
  win.emit("pointerup", { pointerId: 4, clientY: 50 });
  expect(drag.draggingId).toBe("");
  expect(saved).toEqual([["room:feedback", "room:discussions", "room:myarc", "room:issues"]]);
  expect(drag.consumeClick()).toBe(true);
  expect(drag.consumeClick()).toBe(false);
  expect(win.listenerCount("pointermove")).toBe(0);

  // 4. Keyboard Alt+ArrowUp moves the focused channel up, saves immediately, and keeps focus.
  let prevented = false;
  drag.keydown({
    key: "ArrowUp",
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault: () => { prevented = true; },
  } as unknown as KeyboardEvent, "room:discussions");
  expect(prevented).toBe(true);
  expect(list().map((item) => item.conversationId)).toEqual([
    "room:discussions",
    "room:feedback",
    "room:myarc",
    "room:issues",
  ]);
  expect(focusedId).toBe("room:discussions");
  expect(saved).toHaveLength(2);

  // 5. Reset clears active drag and detaches listeners.
  drag.pointerDown({ button: 0, pointerType: "mouse", pointerId: 5, clientY: 20, target: { closest: () => null } } as unknown as PointerEvent, "room:discussions");
  win.emit("pointermove", { pointerId: 5, clientY: 30 });
  expect(drag.draggingId).toBe("room:discussions");
  drag.reset();
  expect(drag.draggingId).toBe("");
  expect(win.listenerCount("pointermove")).toBe(0);
  expect(win.listenerCount("pointerup")).toBe(0);
});

test("createChannelDrag mounts a clamped floating ghost during drag and removes it on drop", () => {
  const win = fakeWindow();
  const bodyChildren: any[] = [];
  globalThis.document = {
    body: {
      appendChild(el: any) { bodyChildren.push(el); return el; },
    },
  } as unknown as Document;

  let kebabRemoved = false;
  const classes = new Set<string>(["channel-row", "is-dragging"]);
  const attrs: Record<string, string> = {};
  const clone = {
    style: {} as Record<string, string>,
    classList: {
      remove(name: string) { classes.delete(name); },
      add(name: string) { classes.add(name); },
    },
    setAttribute(name: string, value: string) { attrs[name] = value; },
    querySelectorAll(sel: string) {
      return sel === ".channel-kebab" ? [{ remove() { kebabRemoved = true; } }] : [];
    },
    remove() {
      const idx = bodyChildren.indexOf(clone);
      if (idx >= 0) bodyChildren.splice(idx, 1);
    },
  };
  const sourceRow = {
    getBoundingClientRect: () => ({ left: 14, top: 80, width: 220, height: 40 }),
    cloneNode: () => clone,
  };

  const base = [
    { conversationId: "room:feedback" },
    { conversationId: "room:myarc" },
    { conversationId: "room:issues" },
  ];
  let order: string[] = [];
  const list = () => orderChannels(base, order, (item) => item.conversationId);
  const queryItems = () => list().map((item, idx) => ({
    getAttribute: (name: string) => (name === "data-channel-id" ? item.conversationId : null),
    getBoundingClientRect: () => ({ top: idx * 40, height: 40 }),
  })) as unknown as HTMLElement[];

  const drag = createChannelDrag((v) => v, {
    list,
    order: () => order,
    setOrder: (ids) => { order = ids; },
    saveOrder: () => {},
    closeMenus: () => {},
    nextTick: (cb) => { cb(); },
    queryItems,
  });

  // Start dragging #issues (top=80, grabbed at y=100 -> offsetY=20).
  drag.pointerDown({ button: 0, pointerType: "mouse", pointerId: 1, clientY: 100, currentTarget: sourceRow, target: { closest: () => null } } as unknown as PointerEvent, "room:issues");
  expect(bodyChildren).toHaveLength(0);

  // Cross 5px threshold -> mounts ghost, removes kebab, sets aria-hidden and initial position.
  win.emit("pointermove", { pointerId: 1, clientY: 90 });
  expect(bodyChildren).toHaveLength(1);
  expect(kebabRemoved).toBe(true);
  expect(classes.has("channel-drag-ghost")).toBe(true);
  expect(classes.has("is-dragging")).toBe(false);
  expect(attrs["x-ignore"]).toBe("");
  expect(attrs["aria-hidden"]).toBe("true");
  expect(clone.style.left).toBe("14px");
  expect(clone.style.width).toBe("220px");
  expect(clone.style.transform).toBe("translate3d(0, 70px, 0)");

  // Dragging far above the list clamps to first.top - 6 (-6px).
  win.emit("pointermove", { pointerId: 1, clientY: -200 });
  expect(clone.style.transform).toBe("translate3d(0, -6px, 0)");

  // Dropping removes the ghost cleanly.
  win.emit("pointerup", { pointerId: 1, clientY: -200 });
  expect(bodyChildren).toHaveLength(0);
});
