export interface VerticalRect {
  top: number;
  height: number;
}

export function orderChannels<T>(items: readonly T[], order: readonly string[], id: (item: T) => string): T[] {
  if (!order.length || items.length < 2) return [...items];
  const rank = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    const key = order[i]!;
    if (!rank.has(key)) rank.set(key, i);
  }
  const indexed = items.map((item, index) => ({ item, index, pos: rank.get(id(item)) ?? Number.MAX_SAFE_INTEGER }));
  indexed.sort((a, b) => a.pos - b.pos || a.index - b.index);
  return indexed.map((entry) => entry.item);
}

export function reorderChannelIds(
  visibleIds: readonly string[],
  currentOrder: readonly string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= visibleIds.length || toIndex >= visibleIds.length) {
    return [...currentOrder];
  }
  const nextVisible = [...visibleIds];
  const [moved] = nextVisible.splice(fromIndex, 1);
  nextVisible.splice(toIndex, 0, moved!);
  const visibleSet = new Set(nextVisible);
  const preserved = currentOrder.filter((id) => !visibleSet.has(id));
  return [...nextVisible, ...preserved];
}

// Directional midpoint check prevents oscillation when neighbouring items have different heights
// (for example, a channel with expanded nested threads).
export function targetDragIndex(clientY: number, fromIndex: number, rects: readonly VerticalRect[]): number {
  if (fromIndex < 0 || fromIndex >= rects.length) return fromIndex;
  for (let i = 0; i < fromIndex; i++) {
    const rect = rects[i]!;
    if (clientY < rect.top + rect.height / 2) return i;
  }
  for (let i = rects.length - 1; i > fromIndex; i--) {
    const rect = rects[i]!;
    if (clientY > rect.top + rect.height / 2) return i;
  }
  return fromIndex;
}

export interface ChannelDragDeps {
  list: () => readonly { conversationId: string }[];
  order: () => readonly string[];
  setOrder: (ids: string[]) => void;
  saveOrder: (ids: readonly string[]) => void;
  closeMenus: () => void;
  nextTick: (callback: () => void) => unknown;
  queryItems?: () => readonly HTMLElement[];
}

export interface ChannelDragState {
  draggingId: string;
  pointerDown: (event: PointerEvent, conversationId: string) => void;
  consumeClick: () => boolean;
  keydown: (event: KeyboardEvent, conversationId: string) => void;
  reset: () => void;
}

const DRAG_THRESHOLD_PX = 5;

export function createChannelDrag(
  reactive: <T extends object>(value: T) => T,
  deps: ChannelDragDeps,
): ChannelDragState {
  let pending: { id: string; pointerId: number; startY: number; moved: boolean; row: HTMLElement | null } | null = null;
  let ghost: HTMLElement | null = null;
  let ghostOffsetY = 0;
  let ghostHeight = 0;
  let suppressClick = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;

  const queryItems = deps.queryItems ?? (() => [...document.querySelectorAll<HTMLElement>("#channel-list > .channel-item")]);

  function removeGhost(): void {
    ghost?.remove();
    ghost = null;
  }

  function positionGhost(clientY: number, rects: readonly VerticalRect[]): void {
    if (!ghost) return;
    let y = clientY - ghostOffsetY;
    if (rects.length > 0) {
      const first = rects[0]!;
      const last = rects[rects.length - 1]!;
      const minY = first.top - 6;
      const maxY = Math.max(minY, last.top + last.height - ghostHeight + 6);
      y = Math.max(minY, Math.min(maxY, y));
    }
    ghost.style.transform = `translate3d(0, ${Math.round(y)}px, 0)`;
  }

  function mountGhost(row: HTMLElement | null, startY: number, clientY: number, rects: readonly VerticalRect[]): void {
    if (!row || typeof document === "undefined" || !document.body || typeof row.cloneNode !== "function") return;
    const rect = row.getBoundingClientRect();
    ghostOffsetY = startY - rect.top;
    ghostHeight = rect.height;
    const clone = row.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".channel-kebab").forEach((el) => el.remove());
    clone.classList.remove("is-dragging");
    clone.classList.add("channel-drag-ghost");
    clone.setAttribute("x-ignore", "");
    clone.setAttribute("aria-hidden", "true");
    clone.style.left = `${rect.left}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    document.body.appendChild(clone);
    ghost = clone;
    positionGhost(clientY, rects);
  }

  function detach(): void {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerEnd);
    window.removeEventListener("blur", onWindowBlur);
  }

  function finishDrag(): void {
    detach();
    removeGhost();
    const wasActive = !!state.draggingId;
    const didMove = pending?.moved === true;
    pending = null;
    if (!wasActive) return;
    state.draggingId = "";
    if (didMove) deps.saveOrder(deps.order());
    suppressClick = true;
    if (suppressTimer !== null) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      suppressClick = false;
      suppressTimer = null;
    }, 0);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pending || event.pointerId !== pending.pointerId) return;
    const elements = queryItems();
    const rects = elements.map((el) => el.getBoundingClientRect());
    if (!state.draggingId) {
      if (Math.abs(event.clientY - pending.startY) < DRAG_THRESHOLD_PX) return;
      if (deps.list().length < 2) { finishDrag(); return; }
      state.draggingId = pending.id;
      deps.closeMenus();
      mountGhost(pending.row, pending.startY, event.clientY, rects);
    } else {
      positionGhost(event.clientY, rects);
    }
    const visibleIds = deps.list().map((item) => item.conversationId);
    const fromIndex = visibleIds.indexOf(pending.id);
    if (fromIndex < 0) { finishDrag(); return; }
    if (elements.length !== visibleIds.length) return;
    const toIndex = targetDragIndex(event.clientY, fromIndex, rects);
    if (toIndex !== fromIndex) {
      const next = reorderChannelIds(visibleIds, deps.order(), fromIndex, toIndex);
      deps.setOrder(next);
      pending.moved = true;
    }
  }

  function onPointerEnd(event: PointerEvent): void {
    if (!pending || event.pointerId !== pending.pointerId) return;
    finishDrag();
  }

  function onWindowBlur(): void {
    finishDrag();
  }

  function pointerDown(event: PointerEvent, conversationId: string): void {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const target = event.target as Element | null;
    if (target?.closest(".channel-kebab")) return;
    if (deps.list().length < 2) return;
    detach();
    removeGhost();
    pending = { id: conversationId, pointerId: event.pointerId, startY: event.clientY, moved: false, row: (event.currentTarget as HTMLElement | null) ?? null };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("blur", onWindowBlur);
  }

  function consumeClick(): boolean {
    if (!suppressClick) return false;
    suppressClick = false;
    if (suppressTimer !== null) { clearTimeout(suppressTimer); suppressTimer = null; }
    return true;
  }

  function keydown(event: KeyboardEvent, conversationId: string): void {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const visibleIds = deps.list().map((item) => item.conversationId);
    const fromIndex = visibleIds.indexOf(conversationId);
    if (fromIndex < 0) return;
    const toIndex = fromIndex + (event.key === "ArrowUp" ? -1 : 1);
    event.preventDefault();
    if (toIndex < 0 || toIndex >= visibleIds.length) return;
    const next = reorderChannelIds(visibleIds, deps.order(), fromIndex, toIndex);
    deps.setOrder(next);
    deps.saveOrder(next);
    void deps.nextTick(() => {
      const row = queryItems().find((el) => el.getAttribute("data-channel-id") === conversationId);
      row?.querySelector<HTMLElement>(".room")?.focus();
    });
  }

  function reset(): void {
    detach();
    removeGhost();
    pending = null;
    state.draggingId = "";
    suppressClick = false;
    if (suppressTimer !== null) { clearTimeout(suppressTimer); suppressTimer = null; }
  }

  const state = reactive<ChannelDragState>({
    draggingId: "",
    pointerDown,
    consumeClick,
    keydown,
    reset,
  });

  return state;
}
