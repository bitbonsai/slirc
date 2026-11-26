import { expect, mock, test } from "bun:test";
import { bindKeyboardDismiss } from "@client/keyboard-dismiss.ts";

// A stand-in for the few DOM calls the helper makes: selectors are matched by id or class name.
function element(selector: string, parent: FakeElement | null = null) {
  const blur = mock(() => {});
  const self: FakeElement = {
    selector, parent, blur,
    matches: (list: string) => list.split(",").map((s) => s.trim()).includes(selector),
    closest: (list: string) => { for (let node: FakeElement | null = self; node; node = node.parent) if (node.matches(list)) return node; return null; },
  };
  return self;
}
type FakeElement = { selector: string; parent: FakeElement | null; blur: ReturnType<typeof mock>; matches(list: string): boolean; closest(list: string): FakeElement | null };

function fakeDocument() {
  const handlers = new Map<string, (event: unknown) => void>();
  const doc = {
    activeElement: null as FakeElement | null,
    addEventListener: (name: string, handler: (event: unknown) => void) => { handlers.set(name, handler); },
    removeEventListener: (name: string) => { handlers.delete(name); },
  };
  const fire = (name: string, event: unknown) => handlers.get(name)?.(event);
  const touch = (name: string, target: FakeElement, y: number) => fire(name, { target, touches: [{ clientY: y }] });
  return { doc, handlers, fire, touch };
}

const chat = element("#chat");
const row = element(".msg", chat);
const thread = element("#reply-thread-stream");
const reply = element(".reply-row", thread);

test("dragging the channel list down puts the channel composer's keyboard away", () => {
  const { doc, touch } = fakeDocument();
  const input = element("#input");
  doc.activeElement = input;
  bindKeyboardDismiss(doc as unknown as Document);
  touch("touchstart", row, 300);
  touch("touchmove", row, 310);
  expect(input.blur).not.toHaveBeenCalled();
  touch("touchmove", row, 330);
  expect(input.blur).toHaveBeenCalledTimes(1);
});

test("dragging a reply thread down puts the thread composer's keyboard away", () => {
  const { doc, touch } = fakeDocument();
  const input = element("#reply-thread-input");
  doc.activeElement = input;
  bindKeyboardDismiss(doc as unknown as Document);
  touch("touchstart", reply, 200);
  touch("touchmove", reply, 240);
  expect(input.blur).toHaveBeenCalledTimes(1);
});

test("dragging up, dragging outside a list, or dragging with no composer focused keeps the keyboard", () => {
  const { doc, touch } = fakeDocument();
  const input = element("#input");
  const header = element(".phone-header");
  doc.activeElement = input;
  bindKeyboardDismiss(doc as unknown as Document);
  touch("touchstart", row, 300);
  touch("touchmove", row, 200);
  touch("touchstart", header, 300);
  touch("touchmove", header, 400);
  doc.activeElement = element(".search");
  touch("touchstart", row, 300);
  touch("touchmove", row, 400);
  expect(input.blur).not.toHaveBeenCalled();
});

test("tapping a list closes the keyboard, tapping a button in it does not", () => {
  const { doc, fire } = fakeDocument();
  const input = element("#input");
  doc.activeElement = input;
  bindKeyboardDismiss(doc as unknown as Document);
  fire("click", { target: element("button", row) });
  expect(input.blur).not.toHaveBeenCalled();
  fire("click", { target: row });
  expect(input.blur).toHaveBeenCalledTimes(1);
});

test("the returned cleanup removes every listener", () => {
  const { doc, handlers } = fakeDocument();
  const stop = bindKeyboardDismiss(doc as unknown as Document);
  expect([...handlers.keys()].sort()).toEqual(["click", "touchmove", "touchstart"]);
  stop();
  expect(handlers.size).toBe(0);
});
