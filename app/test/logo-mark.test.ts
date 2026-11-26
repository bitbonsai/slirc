// The 20 Nov redesign replaced the gradient play-button mark with the speech bubble, but the boot
// screen, phone Home, service avatar and iOS launch screen kept showing the old one. Every mark
// file now comes from scripts/icons/app-icon.svg through scripts/build-icons.ts.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { marks } from "../../scripts/build-icons.ts";

const root = new URL("../../", import.meta.url).pathname;
const text = (path: string) => Bun.file(root + path).text();
const sha = async (path: string) => createHash("sha256").update(new Uint8Array(await Bun.file(root + path).arrayBuffer())).digest("hex").slice(0, 16);
// The first 16 hex digits of the September logo.webp, logo-light.webp and logo.png.
const OLD_RASTERS = ["c98461fe410278ed", "227c8489d4e62503", "8657be48532189f9"];

test("every vector mark draws the bubble from the master", async () => {
  const bubble = (await text("scripts/icons/app-icon.svg")).match(/<path d="(M45\.3957 43\.7024[^"]*)"/)![1];
  for (const [path] of marks.svg) expect([path, (await text(path)).includes(bubble)]).toEqual([path, true]);
});

test("the boot screen and phone Home show a regenerated raster mark", async () => {
  const shell = await text("app/partials/index.html");
  const boot = shell.match(/class="boot-screen"[^>]*><img src="([^"]+)"/)![1];
  const home = (await text("app/partials/mobile-navigation.html")).match(/class="home-brand"[^>]*>\s*<img src="([^"]+)"/)![1];
  for (const src of [boot, home]) {
    const path = `app/public${src}`;
    expect(marks.raster.map(([raster]) => raster)).toContain(path);
    expect(OLD_RASTERS).not.toContain(await sha(path));
  }
  for (const [path] of marks.raster) expect([path, OLD_RASTERS.includes(await sha(path))]).toEqual([path, false]);
});

test("the iOS shell's Opening view carries the same two raster marks as the web boot screen", async () => {
  for (const name of ["logo.webp", "logo-light.webp"]) expect([name, await sha(`native/www/${name}`)]).toEqual([name, await sha(`app/public/${name}`)]);
});

test("the iOS launch screen shows the bare mark at the boot screen's size, in light and dark", async () => {
  const set = "native/ios/App/App/Assets.xcassets/LaunchMark.imageset";
  const { images } = await Bun.file(`${root}${set}/Contents.json`).json();
  expect(images.length).toBe(6);
  const generated = marks.raster.map(([raster]) => raster);
  for (const { filename, scale } of images) {
    const path = `${set}/${filename}`;
    expect(generated).toContain(path);
    // A PNG states its width and height in the header: the mark is 7rem (112 pt) at every scale.
    const header = new DataView((await Bun.file(root + path).arrayBuffer()).slice(16, 24));
    const px = 112 * Number.parseInt(scale);
    expect([filename, header.getUint32(0), header.getUint32(4)]).toEqual([filename, px, px]);
  }
});
