import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The design page's token tables are hand-written. Every literal value they quote for a
// --token must match app/public/style.css, so a token change cannot leave the page behind.
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const page = readFileSync(new URL("../docs/design.md", import.meta.url), "utf8");

function block(selector: RegExp): Map<string, string> {
  const start = css.search(selector);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const tokens = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) if (!tokens.has(m[1]!)) tokens.set(m[1]!, m[2]!.trim());
  return tokens;
}

const dark = block(/^:root \{/m);
const light = new Map([...dark, ...block(/^:root\[data-theme="light"\] \{\n  --nav-surface/m)]);

test("design page token values match style.css", () => {
  const rows = [...page.matchAll(/<tr><td><code>(--[a-z0-9-]+)<\/code><\/td><td>(?:<code>([^<]+)<\/code>)?[^]*?<\/td>(?:<td>(?:<code>([^<]+)<\/code>)?[^]*?<\/td>)?<td>/g)];
  let checked = 0;
  for (const [, token, first, second] of rows) {
    if (!dark.has(token!)) continue;
    if (first) { expect(dark.get(token!), token).toBe(first); checked++; }
    if (second && light.get(token!) !== dark.get(token!)) { expect(light.get(token!), token + " light").toBe(second); checked++; }
  }
  expect(checked).toBeGreaterThan(30);
});

test("design page numbers for pull-to-refresh and video compression match the code", async () => {
  const { PULL_THRESHOLD, EDGE_GUARD } = await import("../client/pull-refresh.ts");
  const { MAX_VIDEO_SOURCE_BYTES } = await import("../client/media.ts");
  const root = readFileSync(new URL("../../design.md", import.meta.url), "utf8");
  for (const doc of [page, root]) {
    expect(doc).toContain(`past ${PULL_THRESHOLD}px`);
    expect(doc).toContain(`within ${EDGE_GUARD}px`);
    expect(doc).toContain(`up to ${MAX_VIDEO_SOURCE_BYTES / 1024 / 1024} MB`);
  }
  expect(page).toContain(`<code>--z-pull-indicator</code> (${css.match(/--z-pull-indicator:\s*(\d+)/)?.[1]})`);
});

test("design page states the phone tab bar height from style.css", () => {
  const navH = css.match(/--nav-h:\s*([^;]+);/)?.[1];
  expect(navH).toBeDefined();
  expect(page.includes("<code>--nav-h: " + navH + "</code>"), "design.md should state --nav-h: " + navH).toBe(true);
});
