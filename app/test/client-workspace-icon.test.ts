// Admin > Branding crop step: the square stays inside the image at every zoom, drags move it the
// way the finger moves, and the saved square is the one on screen.
import { expect, test } from "bun:test";
import { clampCrop, cropSource, cropStyle, ICON_MAX_ZOOM, moveCrop, pickError } from "../client/workspace-icon.ts";

const wide = { width: 400, height: 200, zoom: 1, cx: 200, cy: 100 };

test("at zoom 1 the square spans the short side, centred", () => {
  expect(cropSource(wide)).toEqual({ sx: 100, sy: 0, side: 200 });
  expect(cropStyle(wide)).toBe("width:200.000%;height:100.000%;left:-50.000%;top:0.000%");
});

test("zoom stays between 1 and the maximum and the square never leaves the image", () => {
  expect(clampCrop({ ...wide, zoom: 0.2 }).zoom).toBe(1);
  expect(clampCrop({ ...wide, zoom: 99 }).zoom).toBe(ICON_MAX_ZOOM);
  expect(clampCrop({ ...wide, cx: -50, cy: 900 })).toMatchObject({ cx: 100, cy: 100 });
  const zoomed = clampCrop({ ...wide, zoom: 2, cx: 400, cy: 0 });
  expect(cropSource(zoomed)).toEqual({ sx: 300, sy: 0, side: 100 });
});

test("dragging right shows more of the left side, scaled to the viewport", () => {
  // A 200 px viewport over a 200 px square: one screen pixel is one image pixel.
  expect(moveCrop(wide, 40, 0, 200).cx).toBe(160);
  // Zoomed in 2x, the same drag moves half as far through the image.
  expect(moveCrop({ ...wide, zoom: 2 }, 40, 0, 200).cx).toBe(180);
  // Up and down are pinned on a landscape image at zoom 1.
  expect(moveCrop(wide, 0, 60, 200).cy).toBe(100);
});

test("only PNG, JPEG and WebP under 12 MB can be picked", () => {
  expect(pickError({ type: "image/png", size: 10 })).toBe("");
  expect(pickError({ type: "image/gif", size: 10 })).toContain("PNG, JPEG or WebP");
  expect(pickError({ type: "image/svg+xml", size: 10 })).toContain("PNG, JPEG or WebP");
  expect(pickError({ type: "image/jpeg", size: 13 * 1024 * 1024 })).toContain("12 MB");
});
