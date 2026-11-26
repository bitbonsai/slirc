// Cmd+Option+O (Ctrl+Alt+O off Apple) opens the Workspaces dialog on the web. The Mac app's menu
// owns the same key, so the page stays out of it there.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isWorkspacesShortcut } from "@client/jump.ts";
import { inMacApp } from "@client/native-shell.ts";

type Key = Parameters<typeof isWorkspacesShortcut>[0];
const key = (over: Partial<Key> = {}): Key => ({ code: "KeyO", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

test("Cmd+Option+O on Apple keyboards, Ctrl+Alt+O elsewhere", () => {
  expect(isWorkspacesShortcut(key({ metaKey: true, altKey: true }), true)).toBe(true);
  expect(isWorkspacesShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(true);
  expect(isWorkspacesShortcut(key({ ctrlKey: true, altKey: true }), true)).toBe(false);
  expect(isWorkspacesShortcut(key({ metaKey: true, altKey: true }), false)).toBe(false);
});

test("the physical O key counts, whatever Option types", () => {
  expect(isWorkspacesShortcut({ ...key({ metaKey: true, altKey: true }), key: "ø" } as Key, true)).toBe(true);
  expect(isWorkspacesShortcut(key({ code: "KeyP", metaKey: true, altKey: true }), true)).toBe(false);
});

test("other modifiers, AltGr and composition don't open it", () => {
  expect(isWorkspacesShortcut(key({ metaKey: true }), true)).toBe(false);
  expect(isWorkspacesShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
  expect(isWorkspacesShortcut(key({ metaKey: true, altKey: true, shiftKey: true }), true)).toBe(false);
  expect(isWorkspacesShortcut(key({ metaKey: true, altKey: true, isComposing: true }), true)).toBe(false);
  expect(isWorkspacesShortcut(key({ ctrlKey: true, altKey: true, getModifierState: (name) => name === "AltGraph" }), false)).toBe(false);
});

test("the Mac app is told apart from browsers, old builds included", () => {
  const post = { postMessage: () => {} };
  expect(inMacApp({})).toBe(false);
  expect(inMacApp({ webkit: { messageHandlers: {} } })).toBe(false);
  expect(inMacApp({ webkit: { messageHandlers: { slircSwitchWorkspace: post } } })).toBe(true);
  expect(inMacApp({ webkit: { messageHandlers: { slircShell: post } } } as never)).toBe(true);
});
