// Phone: dragging a message list down, or tapping it, puts the keyboard away. It covers the
// channel and an open reply thread. A drag counts only when it starts inside a list while one of
// the composers has focus, so scrolling with the keyboard closed and taps on controls do nothing.
const LISTS = "#chat, #reply-thread-stream";
const FIELDS = "#input, #reply-thread-input";
const CONTROLS = "button, a, input, textarea, summary, [contenteditable], .composer";
const DRAG_PX = 24;

type Doc = Pick<Document, "addEventListener" | "removeEventListener"> & { readonly activeElement: Element | null };

export function bindKeyboardDismiss(doc: Doc): () => void {
  let dragY: number | null = null;
  const field = (): HTMLElement | null => {
    const active = doc.activeElement as HTMLElement | null;
    return active?.matches?.(FIELDS) ? active : null;
  };
  const inList = (target: EventTarget | null): boolean => !!(target as Element | null)?.closest?.(LISTS);
  const start = (event: TouchEvent): void => {
    dragY = field() && event.touches.length === 1 && inList(event.target) ? event.touches[0]!.clientY : null;
  };
  const move = (event: TouchEvent): void => {
    if (dragY === null || event.touches[0]!.clientY - dragY < DRAG_PX) return;
    dragY = null;
    field()?.blur();
  };
  const tap = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (inList(target) && !target?.closest?.(CONTROLS)) field()?.blur();
  };
  doc.addEventListener("touchstart", start as EventListener, { passive: true });
  doc.addEventListener("touchmove", move as EventListener, { passive: true });
  doc.addEventListener("click", tap as EventListener);
  return () => {
    doc.removeEventListener("touchstart", start as EventListener);
    doc.removeEventListener("touchmove", move as EventListener);
    doc.removeEventListener("click", tap as EventListener);
  };
}
