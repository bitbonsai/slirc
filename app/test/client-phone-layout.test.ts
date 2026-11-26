// Phone layout logic: the tab bar shows on the tab roots and More pages and steps aside in a
// conversation, where the composer takes its place. The More workspace row counts saved
// workspaces. Browser APIs are shims; nothing connects.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { installBrowserShims } from "./support/browser-shims.ts";
import { savedWorkspaceCount, workspaceChoices } from "@client/workspace-mark.ts";

function shims(origin: string): void {
  installBrowserShims({ origin, width: 390, height: 844, userAgent: "tabbar-runtime-test", fetch: async () => Response.json({}) });
}

test("phoneTabBar is on for tab roots and More pages, off in a conversation", async () => {
  shims("https://tabbar-runtime.test");
  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  const ui = client.ui as Record<string, unknown> & { phoneTabBar(): boolean };
  ui.mobileNav = null;
  expect(ui.phoneTabBar()).toBe(false);
  for (const tab of ["home", "dms", "more"]) {
    ui.mobileNav = tab;
    expect(ui.phoneTabBar()).toBe(true);
  }
  ui.mobileNav = null;
  for (const route of ["profileRoute", "settingsRoute", "channelsRoute", "invitationsRoute", "ircRoute", "agentsRoute", "adminRoute"]) {
    ui[route] = true;
    expect(ui.phoneTabBar()).toBe(true);
    ui[route] = false;
  }
  expect(ui.phoneTabBar()).toBe(false);
});

test("the saved workspace count ignores the hosted default and duplicates", () => {
  expect(savedWorkspaceCount(workspaceChoices("https://chat.example.com", []))).toBe(1);
  expect(savedWorkspaceCount(workspaceChoices("https://chat.example.com", ["https://two.example.com", "https://three.example.com", "https://two.example.com"]))).toBe(3);
  // A hosted workspace offers app.slirc.org in the dialog; nobody saved it, so it isn't counted.
  const hosted = workspaceChoices("https://team.slirc.app", []);
  expect(hosted.length).toBeGreaterThan(1);
  expect(savedWorkspaceCount(hosted)).toBe(1);
});
