import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

test("phone tab bar sits inside the home-indicator inset, not above it", () => {
  const root = css.match(/:root \{ --safe-bottom:[^}]*\}/)?.[0] ?? "";
  expect(root).toContain("--safe-bottom: env(safe-area-inset-bottom, 0px)");
  expect(root).toContain("--nav-lift: max(.5rem, calc(var(--safe-bottom) - .75rem))");
  // No bar under the composer any more: it sits where the bar would.
  expect(root).toContain("--composer-bottom: calc(var(--kb, 0px) + var(--nav-lift))");
});

test("phone tab bar is a centred Signal-style glass capsule", () => {
  const nav = rule(".mobile-nav");
  expect(nav).toContain("border: 0");
  expect(nav).toContain("width: max-content");
  expect(nav).toContain("margin-inline: auto");
  expect(nav).toContain("grid-template-columns: repeat(3, 5.5rem)");
  expect(nav).toContain("backdrop-filter: var(--nav-glass)");
  expect(nav).toContain("-webkit-backdrop-filter: var(--nav-glass)");
  expect(css).toContain("--nav-glass: var(--blur-medium) saturate(1.6)");
  expect(rule(".mobile-nav button.active")).toContain("background: var(--nav-active)");
  // Quiet by design: inactive tabs are dimmed, the active one is white on a pill only a small step lighter than the capsule.
  expect(rule(".mobile-nav button")).toContain("color: var(--nav-ink)");
  expect(rule(".mobile-nav button .menu-icon")).toContain("filter: var(--nav-icon)");
  expect(rule(".mobile-nav button.active")).toContain("color: var(--nav-ink-active)");
  expect(rule(".mobile-nav button.active .menu-icon")).toContain("filter: var(--nav-icon-active)");
  expect(css).toContain("--nav-surface: rgb(49 50 68 / .28)");
  expect(css).toContain("--nav-active: rgb(255 255 255 / .06)");
});

test("phone tab targets stay at least 44px", () => {
  expect(rule(".mobile-nav button")).toContain("min-height: 2.75rem");
});

test("tab screens pad their scroll body by the bar height", () => {
  expect(css).toMatch(/\n\.mobile-screen-body \{ min-height: 0;[^}]*padding: 0 \.5rem calc\(var\(--nav-h\) \+ var\(--nav-lift\) \+ 1rem\); \}/);
});

test("every screen head shares one blur-only glass with no tint", () => {
  expect(css).toContain("--head-glass: var(--blur-medium);");
  expect(css).toContain("header, .mobile-screen-head { background: transparent; backdrop-filter: var(--head-glass); -webkit-backdrop-filter: var(--head-glass); }");
  // No per-screen head may paint its own fill or filter.
  const overrides = css.split("\n").filter((line) => /\.mobile-screen-head[^{]*\{[^}]*(background|backdrop-filter)/.test(line) && !line.startsWith("header, .mobile-screen-head {"));
  expect(overrides).toEqual([]);
});

test("the phone composer wears the tab bar's glass", () => {
  expect(css).toContain("  .composer { border-color: transparent; background: var(--nav-surface); box-shadow: var(--nav-edge); backdrop-filter: var(--nav-glass); -webkit-backdrop-filter: var(--nav-glass); }");
});
