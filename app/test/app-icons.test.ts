// Every app icon is rendered from scripts/icons/app-icon.svg by scripts/build-icons.ts. The manifest
// once listed one tile as both "any" and "maskable", so Android cropped its rounded corners.
import { expect, test } from "bun:test";
import { icons } from "../../scripts/build-icons.ts";

const root = new URL("../../", import.meta.url).pathname;
const png = async (path: string) => {
  const bytes = new Uint8Array(await Bun.file(root + path).arrayBuffer());
  const view = new DataView(bytes.buffer);
  // IHDR: width, height, then colour type at byte 25 (2 = RGB, 6 = RGBA).
  return { width: view.getUint32(16), height: view.getUint32(20), alpha: bytes[25] === 6 };
};

test("each generated icon has its declared size, and the App Store ones have no alpha", async () => {
  for (const [path, size, , opaque] of icons) {
    const info = await png(path);
    expect([path, info.width, info.height]).toEqual([path, size, size]);
    if (opaque) expect([path, info.alpha]).toEqual([path, false]);
  }
});

test("the manifest keeps the rounded icon and the full-bleed maskable icon apart", async () => {
  const manifest = await Bun.file(root + "app/public/manifest.webmanifest").json();
  for (const icon of manifest.icons) {
    const [width, height] = icon.sizes.split("x").map(Number);
    expect(await png("app/public" + icon.src)).toMatchObject({ width, height });
    expect(icon.purpose ?? "any").not.toContain(" ");
  }
  const maskable = manifest.icons.find((icon: { purpose?: string }) => icon.purpose === "maskable");
  expect(maskable.src).toBe("/icons/icon-maskable-512.png");
  expect(icons.find(([path]) => path.endsWith(maskable.src))?.[2]).toBe("maskable");
});
