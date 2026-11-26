// The + menu sits against its button, just above the composer, and stays inside the screen.
import { expect, test } from "bun:test";
import { plusMenuPlacement } from "@client/popups.ts";

test("plusMenuPlacement puts the menu on the + button, just above the composer", () => {
  expect(plusMenuPlacement({ left: 16 }, 780, { width: 390, height: 844 })).toEqual({ left: 16, bottom: 70 });
  // Never past the right edge or the left margin.
  expect(plusMenuPlacement({ left: 300 }, 700, { width: 390, height: 844 }, 168)).toEqual({ left: 214, bottom: 150 });
  expect(plusMenuPlacement({ left: 2 }, 700, { width: 390, height: 844 })).toEqual({ left: 8, bottom: 150 });
});
