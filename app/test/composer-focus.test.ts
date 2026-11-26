// Desktop with a reply thread docked: only one composer looks active. The focused composer wins, and the
// thread composer wins when neither has focus. Rules hang off body.reply-thread-docked, which the panel
// sets only on desktop, so phones and the channel-only view keep the normal look.
import { expect, test } from "bun:test";

const css = (await Bun.file(new URL("../public/style.css", import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
const panel = await Bun.file(new URL("../partials/reply-thread-panel.html", import.meta.url)).text();

function declarationsFor(selector: string): string {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules
    .filter(([, selectors]) => selectors.split(",").map((s) => s.trim()).includes(selector))
    .map(([, , body]) => body)
    .join(";");
}

test("the docked-thread class is desktop-only", () => {
  expect(panel).toContain("document.body.classList.toggle('reply-thread-docked', isDesktop && open)");
});

test("the channel composer is muted unless it has focus while the thread is docked", () => {
  const muted = declarationsFor("body.reply-thread-docked .composer:not(:focus-within) .composer-send:not(:disabled)");
  expect(muted).toContain("background: var(--secondary-fill)");
  expect(muted).toContain("color: var(--muted)");
  expect(declarationsFor("body.reply-thread-docked .composer:focus-within")).toContain("var(--brand)");
});

test("the thread composer is active by default and muted while the channel composer has focus", () => {
  expect(declarationsFor("body.reply-thread-docked .reply-composer-box")).toContain("var(--brand)");
  const muted = declarationsFor("body.reply-thread-docked:has(#composer:focus-within) .reply-send-btn:not(:disabled)");
  expect(muted).toContain("background: var(--secondary-fill)");
  expect(muted).toContain("color: var(--muted)");
  expect(declarationsFor("body.reply-thread-docked:has(#composer:focus-within) .reply-composer-box")).toContain("var(--line)");
});
