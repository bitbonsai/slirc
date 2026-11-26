// Keys in the workspace dialog's list, shared with the Mac app's picker: a roving tabindex over
// the row buttons, arrows and Home/End between rows, Tab out to the address field and Open, and a
// typed letter to the field.
import { expect, test } from "bun:test";
import { installWorkspaceKeys, rowAfterKey } from "../client/workspace-mark.ts";

test("Up and Down wrap, Home and End jump, other keys leave the row", () => {
  expect(rowAfterKey("ArrowDown", 0, 3)).toBe(1);
  expect(rowAfterKey("ArrowDown", 2, 3)).toBe(0);
  expect(rowAfterKey("ArrowUp", 0, 3)).toBe(2);
  expect(rowAfterKey("Home", 2, 3)).toBe(0);
  expect(rowAfterKey("End", 0, 3)).toBe(2);
  expect(rowAfterKey("Enter", 1, 3)).toBe(-1);
  expect(rowAfterKey("ArrowDown", -1, 3)).toBe(-1);
});

// Just enough DOM for installWorkspaceKeys: elements that focus, carry a class list and a
// tabIndex, and a root that hands out its controls and dispatches keydown and focusin.
type Fake = { tag: string; row: boolean; tabIndex: number; disabled: boolean; classes: Set<string>; classList: { add(c: string): void; remove(c: string): void }; focus(): void; addEventListener(type: string, fn: () => void): void; getClientRects(): unknown[]; blur?: () => void };
function setup(rowCount: number) {
  const doc = { activeElement: null as Fake | null };
  const handlers: Record<string, ((event: unknown) => void)[]> = {};
  const make = (tag: string, row = false): Fake => {
    const el: Fake = {
      tag, row, tabIndex: 0, disabled: false, classes: new Set(),
      classList: { add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c) },
      focus() { doc.activeElement?.blur?.(); doc.activeElement = el; for (const fn of handlers.focusin || []) fn({ target: el }); },
      addEventListener(type, fn) { if (type === "blur") el.blur = () => { el.blur = undefined; fn(); }; },
      getClientRects: () => [1],
    };
    return el;
  };
  const rows = Array.from({ length: rowCount }, (_, i) => { const row = make("button", true); row.tabIndex = i === 0 ? 0 : -1; return row; });
  const field = make("input");
  const open = make("button");
  const root = {
    ownerDocument: doc,
    querySelectorAll: (selector: string) => (selector === ".workspace-row" ? rows : [...rows, field, open]),
    addEventListener: (type: string, fn: (event: unknown) => void) => { (handlers[type] ||= []).push(fn); },
  };
  installWorkspaceKeys(root as unknown as HTMLElement, field as unknown as HTMLInputElement);
  const press = (key: string, shiftKey = false) => {
    const event = { key, shiftKey, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
    for (const fn of handlers.keydown || []) fn(event);
    return event.defaultPrevented;
  };
  return { doc, rows, field, open, press };
}

test("arrows move focus between rows, keep one Tab stop and mark the row for WebKit", () => {
  const { doc, rows, press } = setup(3);
  rows[0]!.focus();
  expect(press("ArrowDown")).toBe(true);
  expect(doc.activeElement).toBe(rows[1]!);
  expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
  expect(rows[1]!.classes.has("kb-focus")).toBe(true);
  press("End");
  expect(doc.activeElement).toBe(rows[2]!);
  expect(rows[1]!.classes.has("kb-focus")).toBe(false);
  press("ArrowDown");
  expect(doc.activeElement).toBe(rows[0]!);
  press("ArrowUp");
  press("Home");
  expect(doc.activeElement).toBe(rows[0]!);
  expect(press("Enter")).toBe(false);
});

test("Tab goes from the list to the field and Open and back to the focused row", () => {
  const { doc, rows, field, open, press } = setup(3);
  rows[0]!.focus();
  press("ArrowDown");
  press("Tab");
  expect(doc.activeElement).toBe(field);
  press("Tab");
  expect(doc.activeElement).toBe(open);
  press("Tab");
  expect(doc.activeElement).toBe(rows[1]!);
  expect(rows[1]!.classes.has("kb-focus")).toBe(true);
  press("Tab", true);
  expect(doc.activeElement).toBe(open);
  open.disabled = true;
  field.focus();
  press("Tab");
  expect(doc.activeElement).toBe(rows[1]!);
  press("Tab", true);
  expect(doc.activeElement).toBe(field);
});

test("a typed letter in the list goes to the address field, Space stays on the row", () => {
  const { doc, rows, field, press } = setup(2);
  rows[1]!.focus();
  expect(press("a")).toBe(false);
  expect(doc.activeElement).toBe(field);
  rows[1]!.focus();
  press(" ");
  expect(doc.activeElement).toBe(rows[1]!);
  field.disabled = true;
  press("b");
  expect(doc.activeElement).toBe(rows[1]!);
});

test("Down and Up in the search field move into the list", () => {
  const { doc, rows, field, press } = setup(3);
  field.focus();
  expect(press("ArrowDown")).toBe(true);
  expect(doc.activeElement).toBe(rows[0]!);
  expect(rows[0]!.classes.has("kb-focus")).toBe(true);
  field.focus();
  press("ArrowUp");
  expect(doc.activeElement).toBe(rows[2]!);
});
