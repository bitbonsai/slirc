// x-modal opens and closes a dialog as its expression changes and focuses the named control once.
import { expect, test } from "bun:test";
import { modalDirective, syncModal } from "@client/modal.ts";

function dialog(focus: string | null = null) {
  const focused: string[] = [];
  const el = {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    getAttribute: (name: string) => (name === "data-modal-focus" ? focus : null),
    querySelector: (selector: string) => ({ focus: () => focused.push(selector) }),
  };
  return { el: el as unknown as HTMLDialogElement, focused };
}

test("a truthy value opens the dialog and a falsy one closes it", () => {
  const { el } = dialog();
  syncModal(el, true, (run) => run());
  expect(el.open).toBe(true);
  syncModal(el, true, (run) => run());
  expect(el.open).toBe(true);
  syncModal(el, false, (run) => run());
  expect(el.open).toBe(false);
});

test("focus moves to the named control only when the dialog opens", () => {
  const { el, focused } = dialog(".dialog-close");
  syncModal(el, true, (run) => run());
  syncModal(el, true, (run) => run());
  expect(focused).toEqual([".dialog-close"]);
});

test("a dialog without a named control takes no focus", () => {
  const { el, focused } = dialog();
  syncModal(el, true, (run) => run());
  expect(focused).toEqual([]);
});

test("the directive follows its expression", () => {
  const { el } = dialog();
  let value: unknown = false;
  const rerun: (() => void)[] = [];
  modalDirective(el, { expression: "open" }, {
    Alpine: { nextTick: (run) => run() },
    effect: (run) => { rerun.push(run); run(); },
    evaluateLater: () => (done) => done(value),
  });
  expect(el.open).toBe(false);
  value = {};
  rerun[0]!();
  expect(el.open).toBe(true);
  value = null;
  rerun[0]!();
  expect(el.open).toBe(false);
});
