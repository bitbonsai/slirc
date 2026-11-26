// Auto refresh after a deploy: reload when nothing is lost, offer a toast otherwise, never loop.
import { expect, test } from "bun:test";
import { createAutoRefresh, loadedBuild, IDLE_MS, UPDATE_STICKY_ID, UPDATE_TEXT } from "../client/auto-refresh.ts";
import { type StickyNote } from "../client/reminder-notice.ts";
import { readFileSync } from "node:fs";

function make(options: { loaded?: string; served?: string; hidden?: boolean; busy?: boolean; storage?: Map<string, string> } = {}) {
  let clock = 1_000_000;
  const timers: { at: number; callback: () => void; id: number }[] = [];
  let nextId = 0;
  const state = { served: options.served ?? "new", hidden: options.hidden ?? false, busy: options.busy ?? false, reloads: 0, fetches: 0 };
  const store = options.storage ?? new Map<string, string>();
  const core = { stickies: [] as StickyNote[] };
  const refresh = createAutoRefresh({
    core,
    loaded: options.loaded ?? "old",
    fetchVersion: async () => { state.fetches += 1; return state.served; },
    hidden: () => state.hidden,
    busy: () => state.busy,
    reload: () => { state.reloads += 1; },
    storage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); }, removeItem: (key) => { store.delete(key); } },
    now: () => clock,
    setTimer: (callback, ms) => { const id = ++nextId; timers.push({ at: clock + ms, callback, id }); return id as never; },
    clearTimer: (id) => { const index = timers.findIndex((timer) => timer.id === (id as never)); if (index >= 0) timers.splice(index, 1); },
  });
  // Fake clock: runs every timer due by the new time, in order.
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > end) break;
      timers.shift();
      clock = due.at;
      due.callback();
    }
    clock = end;
  };
  return { refresh, state, store, core, advance, timers };
}

test("the loaded build comes from the versioned client.js address", () => {
  const doc = (src: string | null) => ({ querySelector: () => (src === null ? null : { getAttribute: () => src }) }) as never;
  expect(loadedBuild(doc("/client.js?v=ab12cd34"))).toBe("ab12cd34");
  expect(loadedBuild(doc("/client.js"))).toBe("");
  expect(loadedBuild(doc(null))).toBe("");
});

test("the same build does nothing", async () => {
  const t = make({ served: "old" });
  await t.refresh.check();
  expect(t.state.reloads).toBe(0);
  expect(t.core.stickies).toEqual([]);
});

test("a hidden tab reloads at once on a new build", async () => {
  const t = make({ hidden: true });
  await t.refresh.check();
  expect(t.state.reloads).toBe(1);
  expect(t.core.stickies).toEqual([]);
});

test("an idle page with nothing open reloads at once", async () => {
  const t = make();
  t.advance(IDLE_MS);
  await t.refresh.check();
  expect(t.state.reloads).toBe(1);
});

test("a page in use gets one toast, then reloads by itself once idle", async () => {
  const t = make();
  t.refresh.activity();
  await t.refresh.check();
  expect(t.state.reloads).toBe(0);
  expect(t.core.stickies).toEqual([{ id: UPDATE_STICKY_ID, text: UPDATE_TEXT, action: "Refresh", conversationId: "", icon: "refresh" }]);
  t.advance(IDLE_MS - 1);
  expect(t.state.reloads).toBe(0);
  t.refresh.activity();
  t.advance(IDLE_MS - 1);
  expect(t.state.reloads).toBe(0);
  t.advance(1);
  expect(t.state.reloads).toBe(1);
});

test("typed text, an open dialog or an upload holds the reload until it clears", async () => {
  const t = make({ busy: true });
  t.advance(IDLE_MS);
  await t.refresh.check();
  expect(t.state.reloads).toBe(0);
  expect(t.core.stickies).toHaveLength(1);
  t.advance(IDLE_MS * 3);
  expect(t.state.reloads).toBe(0);
  t.state.busy = false;
  t.advance(IDLE_MS);
  expect(t.state.reloads).toBe(1);
});

test("busy holds the reload even when the tab hides", async () => {
  const t = make({ busy: true });
  await t.refresh.check();
  t.state.hidden = true;
  t.refresh.visibility();
  expect(t.state.reloads).toBe(0);
  t.state.busy = false;
  t.refresh.visibility();
  expect(t.state.reloads).toBe(1);
});

test("one toast per build: a dismissed toast stays away on later reconnects", async () => {
  const t = make();
  t.refresh.activity();
  await t.refresh.check();
  expect(t.refresh.dismiss(UPDATE_STICKY_ID)).toBe(true);
  t.refresh.activity();
  await t.refresh.check();
  expect(t.core.stickies).toEqual([]);
  t.state.served = "newer";
  t.refresh.activity();
  await t.refresh.check();
  expect(t.core.stickies).toHaveLength(1);
});

test("Refresh on the toast reloads now, whatever the page is doing", async () => {
  const t = make({ busy: true });
  await t.refresh.check();
  expect(t.refresh.open("reminder-1")).toBe(false);
  expect(t.refresh.open(UPDATE_STICKY_ID)).toBe(true);
  expect(t.state.reloads).toBe(1);
  expect(t.core.stickies).toEqual([]);
});

test("a reload that comes back on the old build never reloads again", async () => {
  const storage = new Map<string, string>();
  const first = make({ hidden: true, storage });
  await first.refresh.check();
  expect(first.state.reloads).toBe(1);
  // The reloaded page still runs "old" while the server says "new".
  const second = make({ hidden: true, storage });
  await second.refresh.check();
  second.refresh.visibility();
  second.advance(IDLE_MS * 5);
  expect(second.state.reloads).toBe(0);
  expect(second.core.stickies).toHaveLength(1);
  expect(second.timers).toHaveLength(0);
});

test("a reload that lands on the new build clears the guard for the next deploy", async () => {
  const storage = new Map<string, string>([["slirc-update-reloaded-for", "new"]]);
  const landed = make({ loaded: "new", served: "new", storage });
  await landed.refresh.check();
  expect(storage.size).toBe(0);
  landed.state.served = "newer";
  landed.state.hidden = true;
  await landed.refresh.check();
  expect(landed.state.reloads).toBe(1);
});

test("returning to a hidden tab checks, and a failed or empty answer changes nothing", async () => {
  const t = make({ served: "" });
  t.refresh.visibility();
  await t.refresh.check();
  expect(t.state.fetches).toBe(1);
  expect(t.state.reloads).toBe(0);
  const off = make({ loaded: "" });
  await off.refresh.check();
  expect(off.state.fetches).toBe(0);
});

// The update toast is a dark HUD in both themes, like the Mac app's; reminder toasts keep the glass look.
test("the update toast alone gets the dark HUD look and the refresh icon", () => {
  const partial = readFileSync(new URL("../partials/toasts.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  const sprite = readFileSync(new URL("../public/icons/lucide/sprite.svg", import.meta.url), "utf8");
  expect(partial).toContain(`:class="item.icon === 'refresh' && 'hud'"`);
  expect(partial).toContain("sprite.svg#rotate-cw");
  expect(sprite).toContain('<symbol id="rotate-cw"');
  const hud = css.match(/^\.glass-toast\.hud \{([^}]*)\}/m)?.[1] ?? "";
  expect(hud).toContain("--brand: #a6e3a1");
  expect(hud).toContain("#11111b");
  expect(hud).toContain("color: var(--brand)");
});

// Rex's update pill: the moving copy is hidden from screen readers, which get one static copy through the
// region's aria-live; the text slides only by its overflow, pauses on hover and focus, and keeps scrolling under reduced motion.
test("the update toast scrolls its text like Rex's, with one static copy for screen readers", () => {
  const partial = readFileSync(new URL("../partials/toasts.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  expect(partial).toContain('<div class="toast-region" role="status" aria-live="polite"');
  expect(partial).toContain(`<span class="toast-marquee" :data-tooltip="item.text" x-tooltip x-show="item.icon === 'refresh'"><span class="sr-only" x-text="item.text"></span><span class="toast-marquee-track" aria-hidden="true" x-text="item.text"></span></span>`);
  expect(partial).toContain(`<button type="button" class="toast-close" aria-label="Dismiss update" x-show="item.icon === 'refresh'"`);
  expect(partial).toContain(`class="toast-action quiet" x-show="item.icon !== 'refresh'"`);
  expect(css).toMatch(/^\.toast-marquee-track \{[^}]*min-width: 100%;[^}]*animation: toast-marquee /m);
  expect(css).toContain("85%, 100% { margin-left: 100%; translate: -100%; }");
  expect(css).toContain(".glass-toast.hud:hover .toast-marquee-track, .glass-toast.hud:focus-within .toast-marquee-track { animation-play-state: paused; }");
  const close = css.match(/^\.toast-close \{([^}]*)\}/m)?.[1] ?? "";
  expect(close).toContain("background: none");
  expect(css).toContain(".toast-close:hover svg, .toast-close:focus-visible svg { scale: 1.2; }");
  const reduced = css.match(/^@media \(prefers-reduced-motion: reduce\) \{ \.toast-close svg \{(.*)$/m)?.[1] ?? "";
  expect(reduced).toContain("transition: none;");
  for (const line of css.split("\n").filter((l) => l.includes("prefers-reduced-motion"))) expect(line).not.toContain("toast-marquee");
});
