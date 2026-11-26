// x-modal="open": the dialog is a modal while the expression is truthy. One place opens, closes and
// focuses every app dialog, so the dialog partials no longer carry their own showModal/close effect.
// data-modal-focus="<selector>" names the control that takes focus once the dialog is up; without
// it the browser's own initial focus applies.
type Dialog = HTMLDialogElement;

export function syncModal(dialog: Dialog, show: boolean, afterShow: (run: () => void) => void): void {
  if (show && !dialog.open) {
    dialog.showModal();
    const selector = dialog.getAttribute("data-modal-focus");
    if (selector) afterShow(() => dialog.querySelector<HTMLElement>(selector)?.focus());
  } else if (!show && dialog.open) dialog.close();
}

export function modalDirective(
  el: Dialog,
  { expression }: { expression: string },
  { Alpine, effect, evaluateLater }: {
    Alpine: { nextTick: (run: () => void) => void };
    effect: (run: () => void) => void;
    evaluateLater: (expression: string) => (done: (value: unknown) => void) => void;
  },
): void {
  const open = evaluateLater(expression);
  effect(() => open((value) => syncModal(el, !!value, Alpine.nextTick)));
}
