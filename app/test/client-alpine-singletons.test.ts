// Components registered as `() => client.x` return one shared object. Alpine defines its magics on that
// object at every mount, so a second mount of the same name throws "Cannot redefine property: $nextTick"
// and the shell never loads. This mounts each x-data of the assembled shell through the real Alpine, twice
// for the ones inside a template, since x-if and x-for remount their content on every toggle.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { installBrowserShims } from "./support/browser-shims.ts";

class FakeElement {
  nodeType = 1; tagName = "DIV"; nodeName = "DIV"; style = {}; dataset = {};
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  children: FakeElement[] = []; parentElement: FakeElement | null = null; parentNode: FakeElement | null = null;
  attributes: { name: string; value: string }[];
  constructor(attrs: Record<string, string> = {}) { this.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value })); }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { const siblings = this.parentElement?.children; return siblings?.[siblings.indexOf(this) + 1] ?? null; }
  hasAttribute(name: string) { return this.attributes.some((a) => a.name === name); }
  getAttribute(name: string) { return this.attributes.find((a) => a.name === name)?.value ?? null; }
  setAttribute() {} removeAttribute() {} addEventListener() {} removeEventListener() {} dispatchEvent() { return true; }
  closest() { return null; } matches() { return false; } querySelector() { return null; } querySelectorAll() { return []; }
  append(child: FakeElement) { child.parentElement = child.parentNode = this; this.children.push(child); }
}

async function mounts(): Promise<{ expression: string; repeated: boolean }[]> {
  const shell = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
  const found: { expression: string; repeated: boolean }[] = [];
  let templates = 0;
  await new HTMLRewriter()
    .on("template", { element(el) { templates++; el.onEndTag(() => { templates--; }); } })
    .on("[x-data]", { element(el) {
      const expression = el.getAttribute("x-data")!;
      if (/^[A-Za-z]\w*(\(.*\))?$/.test(expression)) found.push({ expression, repeated: templates > 0 }); // a registered component, not an inline object
    } })
    .transform(new Response(shell)).text();
  return found;
}

test("every shared component mounts once in the shell and never inside a template", async () => {
  installBrowserShims({ url: "https://singletons.test/" });
  Object.assign(globalThis, { MutationObserver: class { observe() {} disconnect() {} }, Element: FakeElement, Node: FakeElement, HTMLElement: FakeElement, ShadowRoot: class {} });
  Object.assign(window, { Element: FakeElement, MutationObserver: globalThis.MutationObserver });
  Object.assign(document, { readyState: "complete", createElement: () => new FakeElement(), getElementById: () => null });
  const Alpine = (await import("../public/vendor/alpine.js")).default as any;
  const { createClient } = await import("../client/runtime.ts");
  const { registerComponents } = await import("../client/main.ts");
  registerComponents(Alpine, createClient(Alpine));

  const list = await mounts();
  expect(list.length).toBeGreaterThan(10);
  const failures: string[] = [];
  for (const { expression, repeated } of list) {
    for (let i = 0; i < (repeated ? 2 : 1); i++) {
      const el = new FakeElement({ "x-data": expression });
      const root = new FakeElement();
      root.append(el);
      try { Alpine.initTree(root); } catch (error) { failures.push(`${expression}: ${(error as Error).message}`); break; }
    }
  }
  expect(failures).toEqual([]);
});
