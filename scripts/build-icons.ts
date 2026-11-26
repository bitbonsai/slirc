// Renders every app icon and logo mark from scripts/icons/app-icon.svg. Run from the repo root: bun scripts/build-icons.ts
// Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick).
//
// Four layouts come out of the one master:
// - full: the master edge to edge. iOS rounds it itself.
// - maskable: the master shrunk to 84% on the same background, so the mark stays inside the PWA
//   safe circle (radius 40%) when Android masks it.
// - tile: macOS grid, a 824 px rounded tile centred on a transparent 1024 canvas. Also the PWA "any" icon.
// - mac: the bare mark with no tile, fit inside the same 824 px grid box on a transparent 1024
//   canvas. The Mac app's icon for macOS before 26. iPhone and web keep the opaque tile.
// - glass: the mark without its inner-shadow filters in a 760 px box on a transparent 1024 canvas,
//   the one layer of desktop/Slirc/AppIcon.icon. macOS 26 and later draw that Icon Composer icon in
//   Liquid Glass on their own light or dark tile, and in the Clear and Tinted icon styles.
// - favicon: the master cropped closer so the mark reads at 16 px, with rounded corners.
import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const master = await Bun.file(`${root}scripts/icons/app-icon.svg`).text();
const body = master.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
// The mark alone, in the org wordmark's units (x 0 to 51, y 19 to 72.4): the master without its
// comment, background and placement.
const darkMark = body.replace(/<!--[\s\S]*?-->\n?/, "").replace(/<rect width="1024" height="1024"[^>]*\/>\n?/, "").replace(/<g transform="[^"]*">\n?/, "").replace(/<\/g>\s*$/, "");

type Layout = "full" | "maskable" | "tile" | "mac" | "glass" | "favicon";
const layouts: Record<Layout, string> = {
  full: master,
  maskable: `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<rect width="1024" height="1024" fill="#11111b"/>
<svg x="82" y="82" width="860" height="860" viewBox="0 0 1024 1024">${body}</svg>
</svg>`,
  tile: `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<defs><clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185.4"/></clipPath></defs>
<g clip-path="url(#tile)"><svg x="100" y="100" width="824" height="824" viewBox="0 0 1024 1024">${body}</svg></g>
</svg>`,
  mac: `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<svg x="100" y="100" width="824" height="824" viewBox="0 18.6 51 54">${darkMark}</svg>
</svg>`,
  glass: `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<svg x="132" y="132" width="760" height="760" viewBox="0 18.6 51 54">${darkMark.replace(/ filter="url\(#[^)]*\)"/g, "")}</svg>
</svg>`,
  favicon: `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<defs><clipPath id="tile"><rect width="1024" height="1024" rx="225"/></clipPath></defs>
<g clip-path="url(#tile)"><svg width="1024" height="1024" viewBox="80 80 864 864">${body}</svg></g>
</svg>`,
};

// [output path from the repo root, size in px, layout, opaque]
export const icons: [string, number, Layout, boolean][] = [
  ["app/public/icons/favicon-16.png", 16, "favicon", false],
  ["app/public/icons/favicon-32.png", 32, "favicon", false],
  ["app/public/icons/apple-touch-icon.png", 180, "full", true],
  ["app/public/icons/icon-192.png", 192, "tile", false],
  ["app/public/icons/icon-512.png", 512, "tile", false],
  ["app/public/icons/icon-maskable-512.png", 512, "maskable", true],
  ["landing/favicon-16.png", 16, "favicon", false],
  ["landing/favicon-32.png", 32, "favicon", false],
  ["landing/apple-touch-icon.png", 180, "full", true],
  ["native/assets/icon-only.png", 1024, "full", true],
  ["native/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", 1024, "full", true],
  ...[16, 32, 128, 256, 512].flatMap((size): [string, number, Layout, boolean][] => [
    [`desktop/Slirc/Assets.xcassets/AppIcon.appiconset/icon_${size}x${size}.png`, size, "mac", false],
    [`desktop/Slirc/Assets.xcassets/AppIcon.appiconset/icon_${size}x${size}@2x.png`, size * 2, "mac", false],
  ]),
  ["desktop/Slirc/AppIcon.icon/Assets/mark.png", 1024, "glass", false],
];

// The bare mark without the tile. Old pages, emails and the landing site link these names, so they
// keep them. "square" pads the mark to a square; "tight" fits its outline, for avatars and the
// phone nav, which fit it with object-fit: contain.
type Theme = "dark" | "light";
export const marks = {
  svg: [
    ["app/public/logo.svg", "dark", "square"],
    ["landing/logo.svg", "dark", "square"],
    ["landing/img/ui/logo.svg", "dark", "square"],
    ["app/public/icons/slirc.svg", "dark", "tight"],
    ["app/public/icons/slirc-light.svg", "light", "tight"],
    ["app/public/icons/ui/nav-home.svg", "dark", "tight"],
    ["app/public/icons/ui/nav-home-light.svg", "light", "tight"],
  ] as [string, Theme, "square" | "tight"][],
  raster: [
    ["app/public/logo.webp", 384, "dark"],
    ["app/public/logo-light.webp", 384, "light"],
    ["app/public/logo.png", 192, "dark"],
    ["landing/slirc-mark.png", 512, "dark"],
    // The iOS launch screen mark: the boot screen's size, 7rem (112 pt), in the three scales.
    ...([["light", ""], ["dark", "-dark"]] as [Theme, string][]).flatMap(([theme, tag]): [string, number, Theme][] =>
      [1, 2, 3].map((scale): [string, number, Theme] => [`native/ios/App/App/Assets.xcassets/LaunchMark.imageset/mark${tag}@${scale}x.png`, 112 * scale, theme])),
  ] as [string, number, Theme][],
  // The iOS launch screen's top glow, the part of the page's --bg-glow that shows on a phone: a 1088 x 384 pt
  // slice (3x), the 34rem radial gradient centred 10rem above the top edge. Everything outside it is flat --bg.
  glow: [
    ["native/ios/App/App/Assets.xcassets/LaunchGlow.imageset/glow.png", "#ffffff", "#eff1f5"],
    ["native/ios/App/App/Assets.xcassets/LaunchGlow.imageset/glow-dark.png", "#1e1e2e", "#11111b"],
  ] as [string, string, string][],
};

if (import.meta.main) {
  const out = process.argv[2] ?? root;
  const sources: Partial<Record<Layout, string>> = {};
  for (const layout of Object.keys(layouts) as Layout[]) {
    sources[layout] = `/tmp/slirc-icon-${layout}.svg`;
    await Bun.write(sources[layout]!, layouts[layout]);
  }
  for (const [path, size, layout, opaque] of icons) {
    const target = `${out}/${path}`;
    mkdirSync(dirname(target), { recursive: true });
    await $`rsvg-convert -w ${size} -h ${size} ${sources[layout]!} -o ${target}`;
    // App Store icons must have no alpha channel.
    if (opaque) await $`magick ${target} -background "#11111b" -alpha remove -alpha off ${target}`;
  }
  // The Icon Composer document around the glass layer. No fill, so macOS picks its own light or dark tile.
  await Bun.write(`${out}/desktop/Slirc/AppIcon.icon/icon.json`, JSON.stringify({
    groups: [{
      name: "Mark",
      layers: [{ name: "Mark", "image-name": "mark.png", glass: true }],
      shadow: { kind: "neutral", opacity: 0.5 },
      specular: true,
      translucency: { enabled: false, value: 0.5 },
    }],
    "supported-platforms": { squares: ["macOS"] },
  }, null, 2) + "\n");
  // A real .ico holding the 16 and 32 px favicons.
  await $`magick ${out}/landing/favicon-16.png ${out}/landing/favicon-32.png ${out}/landing/favicon.ico`;
  // The bare mark (boot screen, phone Home, logged-in page, landing favicon): the master without its
  // tile, cropped square around the bubble. The light mark comes from the light org wordmark.
  // Both sources are cut to the mark's own units (x 0 to 51, y 19 to 72.4, as in the org wordmark).
  const viewBoxes = { square: "-6.5 13.7 64 64", tight: "0 18.6 51 54" };
  const unwrap = (svg: string) => svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const markBodies: Record<Theme, string> = {
    dark: darkMark,
    light: unwrap(await Bun.file(`${root}app/public/brand-org-light.svg`).text()).replace(/<g clip-path="url\(#clip0_[^"]*\)">[\s\S]*?<\/g>\n?/, ""),
  };
  const mark = (theme: Theme, crop: keyof typeof viewBoxes) => {
    const [, , w, h] = viewBoxes[crop].split(" ").map(Number);
    return `<svg width="${w * 8}" height="${h * 8}" viewBox="${viewBoxes[crop]}" fill="none" xmlns="http://www.w3.org/2000/svg">\n${markBodies[theme]}\n</svg>\n`;
  };
  for (const [path, theme, crop] of marks.svg) await Bun.write(`${out}/${path}`, mark(theme, crop));
  for (const [path, from, to] of marks.glow) {
    mkdirSync(dirname(`${out}/${path}`), { recursive: true });
    await $`magick -size 3264x1152 -define gradient:center=1632,-480 -define gradient:radii=1632,1632 radial-gradient:${from}-${to} ${out}/${path}`;
  }
  for (const [path, size, theme] of marks.raster) {
    const target = `${out}/${path}`;
    mkdirSync(dirname(target), { recursive: true });
    const png = path.endsWith(".png") ? target : "/tmp/slirc-mark.png";
    await Bun.write(`/tmp/slirc-mark-${theme}.svg`, mark(theme, "square"));
    await $`rsvg-convert -w ${size} -h ${size} /tmp/slirc-mark-${theme}.svg -o ${png}`;
    if (png !== target) await $`magick ${png} -quality 92 ${target}`;
  }
  console.log(`${icons.length + 1} icons and ${marks.svg.length + marks.raster.length} marks written`);
}
