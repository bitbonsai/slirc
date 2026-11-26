// The Home strip that sends a phone browser to /welcome. It shows only in a phone browser, stays
// off after a dismissal on this device, and goes away for good once the client ran installed.
import { expect, test } from "bun:test";
import { dismissInstallBanner, installBannerVisible, installEnv, type InstallEnv } from "../client/install-banner.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function memory() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), map };
}
const env = (fields: Partial<InstallEnv>): InstallEnv => ({ userAgent: IPHONE, maxTouchPoints: 5, standalone: false, native: false, ...fields });

test("shows in an iPhone or Android browser, not on a computer", () => {
  expect(installBannerVisible(env({}), memory())).toBe(true);
  expect(installBannerVisible(env({ userAgent: ANDROID }), memory())).toBe(true);
  expect(installBannerVisible(env({ userAgent: MAC, maxTouchPoints: 0 }), memory())).toBe(false);
  // iPadOS reports a Mac user agent, with touch.
  expect(installBannerVisible(env({ userAgent: MAC, maxTouchPoints: 5 }), memory())).toBe(true);
});

test("a dismissal is kept on this device, without any account in the key", () => {
  const storage = memory();
  dismissInstallBanner(storage);
  expect(installBannerVisible(env({}), storage)).toBe(false);
  expect([...storage.map.keys()]).toEqual(["slirc:install-banner-dismissed"]);
});

test("an installed run hides the strip and keeps it off in the browser afterwards", () => {
  const storage = memory();
  expect(installBannerVisible(env({ standalone: true }), storage)).toBe(false);
  expect(installBannerVisible(env({}), storage)).toBe(false);
});

test("the iOS shell, standalone display mode and navigator.standalone count as installed", () => {
  const nav = { userAgent: IPHONE, maxTouchPoints: 5 };
  const matchMedia = () => ({ matches: false });
  expect(installEnv({ navigator: nav, matchMedia }).native).toBe(false);
  expect(installEnv({ navigator: nav, matchMedia, __slircNative: {} }).native).toBe(true);
  expect(installEnv({ navigator: nav, matchMedia, Capacitor: { isNativePlatform: () => true } }).native).toBe(true);
  // Capacitor's web fallback reports false and stays a browser.
  expect(installEnv({ navigator: nav, matchMedia, Capacitor: { isNativePlatform: () => false } }).native).toBe(false);
  const storage = memory();
  expect(installBannerVisible(installEnv({ navigator: nav, matchMedia, Capacitor: { isNativePlatform: () => true } }), storage)).toBe(false);
  expect(installBannerVisible(env({}), storage)).toBe(false);
  // Standalone display mode and iOS navigator.standalone both count as installed too.
  expect(installEnv({ navigator: { userAgent: ANDROID }, matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" }) }).standalone).toBe(true);
  expect(installEnv({ navigator: { userAgent: IPHONE, standalone: true }, matchMedia: () => ({ matches: false }) }).standalone).toBe(true);
});

test("blocked storage still shows the strip in a phone browser and never throws", () => {
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(installBannerVisible(env({}), blocked)).toBe(true);
  expect(installBannerVisible(env({ native: true }), blocked)).toBe(false);
  expect(() => dismissInstallBanner(blocked)).not.toThrow();
});
