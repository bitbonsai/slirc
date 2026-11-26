// Hovering waits before a tip shows; moving between triggers while one shows, or right after, doesn't.
import { expect, test } from "bun:test";
import { hoverDelay, TOOLTIP_DELAY_MS } from "@client/tooltips.ts";

test("a cold hover waits, a warm one shows at once", () => {
  expect(hoverDelay(10_000, false, 0)).toBe(TOOLTIP_DELAY_MS);
  expect(hoverDelay(10_000, true, 0)).toBe(0);
  expect(hoverDelay(10_000, false, 9_900)).toBe(0);
  expect(hoverDelay(10_000, false, 9_000)).toBe(TOOLTIP_DELAY_MS);
});
