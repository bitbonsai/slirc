import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAll } from "../scripts/build-docs.ts";

const script = readFileSync(join(import.meta.dir, "..", "public", "docs", "app-back.js"), "utf8");

type Env = { href?: string; native?: boolean; capacitor?: boolean; coarsePhone?: boolean; cookie?: string; referrer?: string };

function run(env: Env) {
  const classes = new Set<string>();
  let onClick: ((event: { preventDefault(): void }) => void) | null = null;
  const link = { href: env.href || "/more", addEventListener: (_: string, fn: typeof onClick) => { onClick = fn; } };
  const bar = { hidden: true, querySelector: () => link };
  const went: number[] = [];
  const document = {
    cookie: env.cookie || "",
    referrer: env.referrer || "",
    getElementById: (id: string) => (id === "app-back" ? bar : null),
    documentElement: { classList: { add: (name: string) => classes.add(name) } },
  };
  const window = { __slircNative: env.native ? {} : undefined, Capacitor: env.capacitor ? { isNativePlatform: () => true } : undefined };
  const matchMedia = () => ({ matches: !!env.coarsePhone });
  const history = { state: { docsDepth: 2 }, go: (n: number) => went.push(n) };
  const replaced: string[] = [];
  const location = { href: "https://chat.example.com/docs", origin: "https://chat.example.com", replace: (url: string) => replaced.push(url) };
  new Function("window", "document", "matchMedia", "history", "location", script)(window, document, matchMedia, history, location);
  return { shown: !bar.hidden && classes.has("docs-in-app"), click: () => { let prevented = false; onClick?.({ preventDefault: () => { prevented = true; } } as never); return { prevented, went, replaced }; } };
}

test("docs pages carry a hidden back bar to the app's More tab", () => {
  for (const html of Object.values(renderAll({ DOCS_APP_ORIGIN: "https://chat.example.com" }))) {
    expect(html).toContain('<div class="app-back" id="app-back" hidden><a class="app-back-link" href="https://chat.example.com/more" aria-label="Back to Slirc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 4 12l7 7"/></svg>Back</a></div>');
    expect(html).toContain('src="/docs/app-back.js?v=');
  }
});

test("back bar shows in the iOS shell and on phones, not on desktop", () => {
  expect(run({ capacitor: true }).shown).toBe(true);
  expect(run({ native: true }).shown).toBe(true);
  expect(run({ coarsePhone: true }).shown).toBe(true);
  expect(run({ cookie: "a=1; slirc_phone=1" }).shown).toBe(true);
  expect(run({}).shown).toBe(false);
});

test("on a phone, back goes past docs page swaps when the app opened the docs, else follows the link", () => {
  expect(run({ coarsePhone: true, referrer: "https://chat.example.com/more" }).click()).toEqual({ prevented: true, went: [-3], replaced: [] });
  expect(run({ coarsePhone: true, referrer: "https://chat.example.com/docs/agents" }).click()).toEqual({ prevented: false, went: [], replaced: [] });
  expect(run({ coarsePhone: true }).click()).toEqual({ prevented: false, went: [], replaced: [] });
});

// Regression: in the iOS shell, history.go(-1) restored the app page from WebKit's back/forward
// cache, WebKit reported the restore as a cancelled load, and Capacitor's errorPath dropped the
// person on the workspace picker with "couldn't reach your workspace".
test("in the iOS shell, back replaces the page with this origin's More tab and never touches history", () => {
  for (const env of [{ capacitor: true }, { native: true }]) {
    expect(run({ ...env, referrer: "https://chat.example.com/more" }).click()).toEqual({ prevented: true, went: [], replaced: ["https://chat.example.com/more"] });
    expect(run({ ...env }).click()).toEqual({ prevented: true, went: [], replaced: ["https://chat.example.com/more"] });
    expect(run({ ...env, href: "https://app.slirc.org/more" }).click()).toEqual({ prevented: true, went: [], replaced: ["https://chat.example.com/more"] });
  }
});

test("in the iOS shell, back returns to the app page that opened the docs, else More", () => {
  expect(run({ capacitor: true, referrer: "https://chat.example.com/agents" }).click()).toEqual({ prevented: true, went: [], replaced: ["https://chat.example.com/agents"] });
  expect(run({ capacitor: true, referrer: "https://chat.example.com/?room=%23dev&msg=42#x" }).click()).toEqual({ prevented: true, went: [], replaced: ["https://chat.example.com/?room=%23dev&msg=42#x"] });
  expect(run({ capacitor: true, referrer: "https://chat.example.com/docs/agents" }).click()).toEqual({ prevented: true, went: [], replaced: ["https://chat.example.com/more"] });
  expect(run({ capacitor: true, referrer: "https://evil.example/agents" }).click()).toEqual({ prevented: true, went: [], replaced: ["https://chat.example.com/more"] });
});
