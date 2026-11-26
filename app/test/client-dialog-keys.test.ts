import { expect, test } from "bun:test";
import { nextIndex } from "@client/dialog-keys.ts";

test("Tab order wraps both ways and starts at an end when nothing is focused", () => {
  expect(nextIndex(0, 2, 1)).toBe(1);
  expect(nextIndex(1, 2, 1)).toBe(0);
  expect(nextIndex(0, 2, -1)).toBe(1);
  expect(nextIndex(-1, 3, 1)).toBe(0);
  expect(nextIndex(-1, 3, -1)).toBe(2);
  expect(nextIndex(0, 0, 1)).toBe(-1);
});
