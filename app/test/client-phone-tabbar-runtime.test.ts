// The phone tab bar shows on the tab roots and More pages and steps aside in a conversation,
// where the composer takes its place. Browser APIs are shims; nothing connects.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { installBrowserShims } from "./support/browser-shims.ts";

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

test("the nav only renders where phoneTabBar allows it", async () => {
  const mobile = await Bun.file(new URL("../partials/mobile-navigation.html", import.meta.url)).text();
  // Match the nav's x-show value alone, whatever other attributes or line breaks the tag carries.
  const show = mobile.match(/<nav\b[^>]*\bclass="mobile-nav"[^>]*>/)?.[0].match(/\sx-show="([^"]*)"/)?.[1] ?? "";
  expect(show).toMatch(/&&\s*phoneTabBar\(\)/);
});
