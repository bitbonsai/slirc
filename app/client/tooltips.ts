
export const TOOLTIP_ID = "slirc-tooltip";

export function tooltipText(el: { getAttribute(name: string): string | null }): string {
  return (el.getAttribute("data-tooltip") || el.getAttribute("aria-label") || "").trim();
}

export function tooltipPlacement(
  trigger: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number; placement: "top" | "bottom" } {
  const gap = 6;
  const above = trigger.top - tip.height - gap;
  const placement: "top" | "bottom" = above >= margin ? "top" : "bottom";
  const top = Math.max(margin, Math.min(placement === "top" ? above : trigger.bottom + gap, viewport.height - tip.height - margin));
  const left = Math.max(margin, Math.min(trigger.left + trigger.width / 2 - tip.width / 2, viewport.width - tip.width - margin));
  return { left, top, placement };
}

type TooltipCleanup = () => void;

let tooltipNode: HTMLElement | null = null;

let tooltipTrigger: HTMLElement | null = null;

let tooltipCleanup: TooltipCleanup | null = null;

// Hover waits before a tip shows, so passing the pointer over the sidebar doesn't flash tips. Once
// one is showing, or just closed, moving to the next trigger shows its tip at once. Keyboard focus
// never waits.
export const TOOLTIP_DELAY_MS = 600;
const WARM_MS = 300;
let lastHiddenAt = 0;

export function hoverDelay(now: number, showing: boolean, hiddenAt: number): number {
  return showing || now - hiddenAt < WARM_MS ? 0 : TOOLTIP_DELAY_MS;
}

function tooltipSurface(): HTMLElement {
  if (tooltipNode?.isConnected) return tooltipNode;
  const el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.className = "slirc-tooltip";
  el.setAttribute("role", "tooltip");
  el.setAttribute("aria-hidden", "true");
  tooltipNode = el;
  return el;
}

function positionTooltip(trigger: HTMLElement): void {
  const el = tooltipNode;
  if (!el) return;
  const triggerRect = trigger.getBoundingClientRect();
  const tipRect = el.getBoundingClientRect();
  const pos = tooltipPlacement(triggerRect, { width: tipRect.width, height: tipRect.height }, { width: window.innerWidth, height: window.innerHeight });
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
  el.dataset.placement = pos.placement;
}

function hideTooltip(): void {
  if (tooltipTrigger) { tooltipTrigger.removeAttribute("aria-describedby"); lastHiddenAt = Date.now(); }
  tooltipTrigger = null;
  tooltipNode?.remove();
  tooltipCleanup?.();
  tooltipCleanup = null;
}

export function hideActiveTooltip(): void { hideTooltip(); }

function showTooltip(trigger: HTMLElement, text: string): void {
  if (!text) return;
  if (tooltipTrigger === trigger && tooltipNode?.isConnected) return;
  hideTooltip();
  const el = tooltipSurface();
  el.textContent = text;
  // Inside an open dialog the tip must live in the top layer too, or the dialog paints over it.
  const dialog = trigger.closest("dialog[open]") as HTMLDialogElement | null;
  (dialog ?? document.body).appendChild(el);
  trigger.setAttribute("aria-describedby", TOOLTIP_ID);
  tooltipTrigger = trigger;
  positionTooltip(trigger);
  const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") hideTooltip(); };
  const onScroll = (): void => positionTooltip(trigger);
  const onResize = (): void => hideTooltip();
  const onPointerDown = (event: PointerEvent): void => { if (!trigger.contains(event.target as Node)) hideTooltip(); };
  const onDialogClose = (): void => hideTooltip();
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  document.addEventListener("pointerdown", onPointerDown, true);
  dialog?.addEventListener("close", onDialogClose);
  tooltipCleanup = () => {
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("pointerdown", onPointerDown, true);
    dialog?.removeEventListener("close", onDialogClose);
  };
}

export function tooltipDirective(
  el: HTMLElement,
  _directive: unknown,
  { cleanup }: { cleanup: (callback: () => void) => void },
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => { clearTimeout(timer); timer = undefined; };
  const showNow = (): void => { cancel(); showTooltip(el, tooltipText(el)); };
  const hover = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    cancel();
    const wait = hoverDelay(Date.now(), !!tooltipNode?.isConnected, lastHiddenAt);
    if (!wait) return showNow();
    timer = setTimeout(showNow, wait);
  };
  const show = (): void => showNow();
  const hide = (): void => { cancel(); if (tooltipTrigger === el) hideTooltip(); };
  el.addEventListener("pointerenter", hover);
  el.addEventListener("pointerleave", hide);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hide);
  cleanup(() => {
    el.removeEventListener("pointerenter", hover);
    el.removeEventListener("pointerleave", hide);
    el.removeEventListener("focus", show);
    el.removeEventListener("blur", hide);
    hide();
  });
}
