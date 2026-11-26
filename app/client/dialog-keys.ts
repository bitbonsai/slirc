// Keyboard moves inside open modal dialogs. Safari and the Mac app's WebKit view only Tab between
// text fields unless macOS keyboard navigation is turned on, so a confirm dialog's buttons were
// mouse-only. Tab and Shift+Tab cycle every control in the dialog; Left and Right move between
// the buttons of one action row.
const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

export function nextIndex(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

function controls(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) =>
    !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
}

export function installDialogKeys(doc: Document = document): void {
  doc.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const active = doc.activeElement as HTMLElement | null;
    const dialog = active?.closest("dialog[open]") ?? doc.querySelector("dialog[open]");
    if (!dialog) return;
    if (event.key === "Tab") {
      const items = controls(dialog);
      const target = items[nextIndex(items.indexOf(active!), items.length, event.shiftKey ? -1 : 1)];
      if (!target) return;
      event.preventDefault();
      target.focus();
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && active?.tagName === "BUTTON") {
      const row = active.parentElement;
      if (!row) return;
      const buttons = controls(row).filter((el) => el.tagName === "BUTTON");
      if (buttons.length < 2) return;
      const target = buttons[nextIndex(buttons.indexOf(active), buttons.length, event.key === "ArrowRight" ? 1 : -1)];
      event.preventDefault();
      target?.focus();
    }
  });
}
