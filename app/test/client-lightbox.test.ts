// The photo lightbox shows the whole picture: fit to the viewport on open, as large as the window
// allows when filled, and at real size (scroll or drag to pan) after a click. One rule set in
// style.css sizes it; a second set in the shell partial used to fight it and crop tall pictures.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMediaView } from "@client/media-view.ts";

const ORIGIN = "https://chat.example.test";
const PHOTO = { kind: "image", href: "/media/tall.png", alt: "Tall screenshot", url: "/media/tall.png" } as never;

const view = () => createMediaView((value) => value, {
  core: { embeds: {} } as never, nextTick: async () => {}, openPopup: () => {}, origin: ORIGIN,
  session: { scope: () => null } as never,
});

let realDocument: unknown;
beforeEach(() => {
  realDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { querySelector: () => null };
});
afterEach(() => { (globalThis as { document?: unknown }).document = realDocument; });

describe("lightbox zoom", () => {
  test("a photo opens at fit, a click shows real size, a second click fits again", () => {
    const media = view();
    media.openLightbox(PHOTO);
    expect(media.lightboxZoom).toBe(false);
    media.toggleLightboxZoom();
    expect(media.lightboxZoom).toBe(true);
    media.toggleLightboxZoom();
    expect(media.lightboxZoom).toBe(false);
  });

  test("players have no real-size mode", () => {
    const media = view();
    media.lightbox = { kind: "player", src: "https://www.youtube-nocookie.com/embed/x", url: "https://youtu.be/x" };
    media.toggleLightboxZoom();
    expect(media.lightboxZoom).toBe(false);
  });

  test("Escape steps back from real size, then from fill, then closes", () => {
    const media = view();
    media.openLightbox(PHOTO);
    media.lightboxMax = true;
    media.toggleLightboxZoom();
    media.escapeLightbox();
    expect([media.lightboxZoom, media.lightboxMax, media.lightbox !== null]).toEqual([false, true, true]);
    media.escapeLightbox();
    expect([media.lightboxZoom, media.lightboxMax, media.lightbox !== null]).toEqual([false, false, true]);
    media.escapeLightbox();
    expect(media.lightbox).toBeNull();
  });

  test("closing and reopening starts at fit again", () => {
    const media = view();
    media.openLightbox(PHOTO);
    media.toggleLightboxZoom();
    media.closeLightbox();
    media.openLightbox(PHOTO);
    expect(media.lightboxZoom).toBe(false);
  });

  test("a mouse drag pans the zoomed picture and its closing click does not zoom out", () => {
    const media = view();
    media.openLightbox(PHOTO);
    media.toggleLightboxZoom();
    const classes = new Set<string>();
    const box = { scrollLeft: 100, scrollTop: 400, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } };
    media.startLightboxPan({ pointerType: "mouse", button: 0, clientX: 300, clientY: 300, currentTarget: box } as never);
    expect(classes.has("panning")).toBe(true);
    dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 280, clientY: 200 }));
    expect([box.scrollLeft, box.scrollTop]).toEqual([120, 500]);
    dispatchEvent(new Event("pointerup"));
    expect(classes.has("panning")).toBe(false);
    dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 0, clientY: 0 }));
    expect([box.scrollLeft, box.scrollTop]).toEqual([120, 500]);
    media.toggleLightboxZoom(); // the click that ends the drag
    expect(media.lightboxZoom).toBe(true);
    media.toggleLightboxZoom(); // a real click
    expect(media.lightboxZoom).toBe(false);
  });

  test("touch and a picture at fit are left to the browser", () => {
    const media = view();
    media.openLightbox(PHOTO);
    const box = { scrollLeft: 0, scrollTop: 0, classList: { add: () => { throw new Error("panned at fit"); }, remove: () => {} } };
    media.startLightboxPan({ pointerType: "mouse", button: 0, clientX: 0, clientY: 0, currentTarget: box } as never);
    media.toggleLightboxZoom();
    media.startLightboxPan({ pointerType: "touch", button: 0, clientX: 0, clientY: 0, currentTarget: box } as never);
  });
});

describe("lightbox layout", () => {
  const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

  test("the shell partial carries no lightbox rules beyond the shared dialog fade", async () => {
    const style = (await read("../partials/index.html")).match(/<style>[\s\S]*?<\/style>/g)?.join("\n") ?? "";
    expect(style.match(/(?<!dialog)\.lightbox[-\w]*/g) ?? []).toEqual([]);
  });

  test("fit and fill size the picture in viewport units, never a percentage of the dialog", async () => {
    const css = await read("../public/style.css");
    const rules = css.split("\n").filter((line) => line.startsWith(".lightbox"));
    expect(rules.join("\n")).not.toContain("100%");
    expect(css).toContain(".lightbox-media img, .lightbox-media video { display: block; width: auto; height: auto; max-width: 92vw; max-height: calc(94dvh - var(--lightbox-bar)); object-fit: contain; }");
    expect(css).toContain(".lightbox.maximized .lightbox-media img, .lightbox.maximized .lightbox-media video, .lightbox.maximized .lightbox-media iframe { width: 100vw; height: calc(100dvh - var(--lightbox-bar)); max-width: none; max-height: none; aspect-ratio: auto; object-fit: contain; }");
  });

  test("real size scrolls in a full-window box at the picture's natural pixels", async () => {
    const css = await read("../public/style.css");
    expect(css).toContain(".lightbox.maximized[open], .lightbox.zoomed[open] { width: 100vw;");
    expect(css).toContain(".lightbox.zoomed .lightbox-media { display: flex; overflow: auto;");
    expect(css).toContain(".lightbox.zoomed .lightbox-media img { flex: none; margin: auto; width: auto; height: auto; max-width: none; max-height: none;");
    // The zoomed rule comes after fill, so it wins when both are on.
    expect(css.indexOf(".lightbox.zoomed .lightbox-media img {")).toBeGreaterThan(css.indexOf(".lightbox.maximized .lightbox-media img,"));
  });

  test("the picture and a zoom button toggle real size; the zoom icons exist", async () => {
    const partial = await read("../partials/media-lightbox.html");
    expect(partial).toContain(":class=\"{ maximized: mediaView.lightboxMax, zoomed: mediaView.lightboxZoom }\"");
    expect(partial).toContain('x-on:pointerdown="mediaView.startLightboxPan($event)"');
    expect(partial).toMatch(/<img [^>]*draggable="false" x-on:click="mediaView.toggleLightboxZoom\(\$event\)"/);
    expect(partial).toContain("x-show=\"mediaView.lightbox?.kind === 'image'\" :aria-label=\"mediaView.lightboxZoom ? 'Fit to window' : 'Actual size'\"");
    const sprite = await read("../public/icons/lucide/sprite.svg");
    expect(sprite).toContain('<symbol id="zoom-in"');
    expect(sprite).toContain('<symbol id="zoom-out"');
  });

  test("the page still allows pinch zoom", async () => {
    const head = await read("../partials/index.html");
    const viewport = head.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? "";
    expect(viewport).not.toMatch(/user-scalable|maximum-scale/);
  });
});
