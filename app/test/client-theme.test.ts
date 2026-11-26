import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const script = await Bun.file(new URL("../public/theme.js", import.meta.url)).text();
function browser(saved: string | null, dark = false, blocked = false) {
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  const documentListeners: Record<string, Function> = {}, windowListeners: Record<string, Function> = {};
  const system = { matches: dark, addEventListener: (_: string, callback: Function) => { systemChange = callback; } };
  let systemChange: Function;
  let themeColor = "";
  const saves: { url: string; body: unknown }[] = [];
  class Select { value = ""; hasAttribute(name: string) { return name === "data-theme-picker"; } }
  const select = new Select();
  const document = {
    documentElement: root,
    querySelector: () => ({ setAttribute: (_: string, value: string) => { themeColor = value; } }),
    querySelectorAll: () => [select],
    addEventListener: (event: string, callback: Function) => { documentListeners[event] = callback; },
  };
  runInNewContext(script, {
    document, HTMLSelectElement: Select,
    fetch: (url: string, options: { body: string }) => { saves.push({ url, body: JSON.parse(options.body) }); return Promise.reject(new Error("offline")); },
    window: { matchMedia: () => system, addEventListener: (event: string, callback: Function) => { windowListeners[event] = callback; } },
    localStorage: { getItem: () => { if (blocked) throw new Error("blocked"); return saved; }, setItem: (_: string, value: string) => { if (blocked) throw new Error("blocked"); saved = value; } },
  });
  return { root, select, saves,
    account: (accountId: string, theme?: string | null) => documentListeners["slirc:theme-account"]!({ detail: { accountId, theme } }),
    color: () => themeColor, saved: () => saved,
    choose: (value: string) => { select.value = value; documentListeners.change!({ target: select }); },
    system: (value: boolean) => { system.matches = value; systemChange!(); },
    storage: (value: string | null, key: string | null = "slirc-theme") => { saved = value; windowListeners.storage!({ key }); },
  };
}

test("system theme applies before DOM readiness; explicit choice persists and ignores OS changes", () => {
  const b = browser(null);
  expect(b.root.dataset.theme).toBe("light");
  expect(b.color()).toBe("#eff1f5");
  expect(b.select.value).toBe("system");
  b.system(true);
  expect(b.root.dataset.theme).toBe("dark");
  b.choose("light");
  expect(b.saved()).toBe("light");
  expect(b.root.style.colorScheme).toBe("light");
  b.system(true);
  expect(b.root.dataset.theme).toBe("light");
  b.choose("system");
  expect(b.root.dataset.theme).toBe("dark");
});

test("reload, cross-tab choice, invalid values, and blocked storage retain usable appearance", () => {
  expect(browser("dark").root.dataset.theme).toBe("dark");
  const b = browser("invalid", true);
  expect(b.root.dataset.themePreference).toBe("system");
  b.storage("light");
  expect(b.root.dataset.theme).toBe("light");
  expect(b.select.value).toBe("light");
  b.storage(null, null);
  expect(b.root.dataset.theme).toBe("dark");
  const blocked = browser("dark", false, true);
  blocked.choose("dark");
  expect(blocked.root.dataset.theme).toBe("dark");
  blocked.system(false);
  expect(blocked.root.dataset.theme).toBe("dark");
});

test("account theme overrides local first paint; theme saves are isolated and failure keeps local choice", async () => {
  const b = browser("dark");
  expect(b.root.dataset.theme).toBe("dark");
  b.account("immutable-id", "light");
  expect(b.root.dataset.theme).toBe("light");
  expect(b.saved()).toBe("light");
  expect(b.saves).toEqual([]);
  b.choose("dark");
  await Promise.resolve();
  expect(b.saves).toEqual([{ url: "/profile", body: { accountId: "immutable-id", theme: "dark" } }]);
  expect(b.root.dataset.theme).toBe("dark");
  expect(b.saved()).toBe("dark");
  b.account("");
  b.choose("light");
  expect(b.saves).toHaveLength(1);
  b.account("next-id", null);
  expect(b.root.dataset.themePreference).toBe("system");
});

test("a reconnect never reverts a theme chosen on this page", async () => {
  const b = browser("dark");
  b.account("immutable-id", "light");
  expect(b.root.dataset.theme).toBe("light");
  b.choose("dark");
  await Promise.resolve();
  // The save may have failed or still be in flight; the server replays its old value on reconnect.
  b.account("immutable-id", "light");
  expect(b.root.dataset.theme).toBe("dark");
  expect(b.saved()).toBe("dark");
});

function luminance(hex: string) {
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .reduce((sum, value, i) => sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i]!, 0);
}
function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
test("light text and lime labels retain normal-text contrast on their actual solid backgrounds", async () => {
  const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  const light = css.split(':root[data-theme="light"] {')[1]!.split("}")[0]!;
  const token = (name: string) => light.match(new RegExp(`--${name}: #([0-9a-f]{6});`))![1]!;
  for (const bg of [token("bg"), token("panel")]) {
    for (const fg of [token("text"), token("muted"), token("brand"), token("danger"), token("warning"), token("attention")]) expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  }
  for (const bg of ["a6e3a1", "c9edac", "bce994", "d9eedb"]) expect(contrast(token("text"), bg)).toBeGreaterThanOrEqual(4.5);
});
