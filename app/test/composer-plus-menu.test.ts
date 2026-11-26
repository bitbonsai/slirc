// The composer wears backdrop-filter glass, and a backdrop-filter on an ancestor is a backdrop root:
// a blurred child samples only the composer's own pixels, so the + menu showed the messages behind it
// sharp and hard to read. The menu is teleported to <body> and placed against the + button instead.
import { expect, test } from "bun:test";
import { plusMenuPlacement } from "@client/popups.ts";

const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();

function composerForm(): string {
  const start = html.indexOf('<form x-data="composerEditor"');
  return html.slice(start, html.indexOf("</form>", start));
}

test("the + menu is teleported out of the blurred composer to <body>", () => {
  const form = composerForm();
  const menu = form.indexOf('class="composer-plus-menu"');
  expect(menu).toBeGreaterThan(-1);
  const template = form.lastIndexOf("<template", menu);
  expect(form.slice(template, menu)).toMatch(/^<template x-teleport="body">\s*<div $/);
  expect(form.indexOf("</template>", menu)).toBeGreaterThan(menu);
  // Exactly one copy, so Alpine's teleport is the only thing that puts it in the page.
  expect(html.split('class="composer-plus-menu"').length).toBe(2);
});

test("the teleported + menu keeps its keyboard and dismissal handlers", () => {
  const form = composerForm();
  const tag = form.slice(form.indexOf('<div class="composer-plus-menu"'), form.indexOf(">", form.indexOf('<div class="composer-plus-menu"')));
  for (const handler of ["x-on:click.outside", "x-on:keydown.escape", "x-on:keydown.tab", "x-on:keydown.arrow-down", "x-on:keydown.arrow-up", 'x-ref="plusMenu"']) expect(tag).toContain(handler);
  expect(tag).toContain("placePlusMenu($el, $refs.plus)");
  // The composer slides with the phone keyboard; the menu follows when that transition ends.
  expect(html.slice(html.indexOf('<form x-data="composerEditor"'), html.indexOf(">", html.indexOf('<form x-data="composerEditor"')))).toContain("placePlusMenu($refs.plusMenu, $refs.plus)");
});

test("the + menu is fixed to the viewport and keeps the glass blur", () => {
  const rule = css.slice(css.indexOf(".composer-plus-menu { position: fixed"));
  expect(rule.slice(0, rule.indexOf("}"))).toContain("z-index: var(--z-floating)");
  const glass = css.slice(css.indexOf(".poll-menu, .composer-plus-menu {"));
  expect(glass.slice(0, glass.indexOf("}"))).toContain("backdrop-filter: var(--glass-filter)");
  expect(css).not.toContain("bottom: calc(100% + .4rem); left: .25rem");
});

test("plusMenuPlacement puts the menu on the + button, just above the composer", () => {
  expect(plusMenuPlacement({ left: 16 }, 780, { width: 390, height: 844 })).toEqual({ left: 16, bottom: 70 });
  // Never past the right edge or the left margin.
  expect(plusMenuPlacement({ left: 300 }, 700, { width: 390, height: 844 }, 168)).toEqual({ left: 214, bottom: 150 });
  expect(plusMenuPlacement({ left: 2 }, 700, { width: 390, height: 844 })).toEqual({ left: 8, bottom: 150 });
});
