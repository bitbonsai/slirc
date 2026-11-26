// The photo lightbox shows the whole picture: fit on open, as large as the window allows when filled,
// and real size (scroll or drag to pan) after a click.
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
