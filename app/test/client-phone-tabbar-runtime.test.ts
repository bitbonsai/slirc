// The phone tab bar shows on the tab roots and More pages and steps aside in a conversation,
// where the composer takes its place. Browser APIs are shims; nothing connects.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

function shims(origin: string): void {
  const location = new URL(`${origin}/`);
  const storage = new Map<string, string>();
  const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const history = { state: null, replaceState() {}, pushState() {} };
  Object.assign(globalThis, {
    location, history, matchMedia: media,
    window: Object.assign(new EventTarget(), { location, history, matchMedia: media, innerWidth: 390, innerHeight: 844 }),
    document: Object.assign(new EventTarget(), {
      title: "Slirc", cookie: "", visibilityState: "visible", hasFocus: () => true,
      documentElement: { classList: { add() {}, toggle() {} }, style: { setProperty() {} } },
      body: { classList: { toggle() {} } }, querySelector: () => null, querySelectorAll: () => [],
    }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    EventSource: class { addEventListener() {} close() {} },
    WebSocket: class { static OPEN = 1; readyState = 0; close() {} send() {} },
    fetch: (async () => Response.json({})) as unknown as typeof fetch,
  });
  Object.assign(window, { requestAnimationFrame, cancelAnimationFrame, localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true, userAgent: "tabbar-runtime-test" } });
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
