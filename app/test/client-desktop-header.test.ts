// Every shell shares one conversation header: transparent with blur only, messages scrolling under it.
import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
const rule = (selector: string): string => css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m"))![1]!;

test("the base header is transparent with blur only", () => {
  const header = rule("header, .mobile-screen-head");
  expect(header).toContain("background: transparent;");
  expect(header).toContain("backdrop-filter: var(--head-glass);");
  expect(header).toContain("-webkit-backdrop-filter: var(--head-glass);");
  expect(header).not.toContain("--glass-chrome");
  expect(css).toMatch(/--head-glass: var\(--blur-medium\);/);
  expect(rule("header")).not.toContain("backdrop-filter");
});

test("the chat runs under the header and pads its content clear of it", () => {
  const chat = rule(".chat");
  expect(chat).toContain("inset: 0;");
  expect(chat).toContain("padding: calc(var(--header-h) + 1.5rem) ");
  expect(css).toContain(".notify-banner { position: sticky; top: 0;");
});

test("the phone block no longer repeats the header and chat offset rules", () => {
  const phone = css.slice(css.indexOf("@media (pointer: coarse) {\n  .reaction-tooltip"));
  const block = phone.slice(0, phone.indexOf("\n}\n"));
  expect(block).not.toMatch(/^  header \{ background/m);
  expect(block).not.toMatch(/^  \.chat \{ top: 0/m);
  expect(block).not.toMatch(/^  \.notify-banner \{ top/m);
});

test("the links view keeps starting below the header", () => {
  expect(css).toContain(".links-view { top: var(--header-h);");
});
