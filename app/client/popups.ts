export type OpenPopup = (close?: () => void) => void;

export function createPopupOpener(): OpenPopup {
  let closeCurrent: (() => void) | undefined;
  return (close) => {
    if (closeCurrent !== close) closeCurrent?.();
    closeCurrent = close;
  };
}

export function composerPopupPlacement(
  composer: { left: number; width: number; top: number },
  isDesktop: boolean,
  viewport: { width: number; height: number },
): { left: number | null; right: number | null; width: number | null; bottom: number } {
  const bottom = viewport.height - composer.top + 8;
  if (!isDesktop) return { left: 8, right: 8, width: null, bottom };
  const width = Math.min(composer.width, 384);
  const left = Math.max(8, Math.min(composer.left, viewport.width - width - 8));
  return { left, right: null, width, bottom };
}

export interface PopupTrigger { top: number; left: number; right: number; bottom: number }

export interface PopupSize { width: number; height: number }

export interface PopupViewport { top: number; left: number; right: number; bottom: number }

export interface PopupPlacement { top: number; left: number; maxHeight?: number }

export type PopupSide = "above" | "below";

export function popupAnchorName(id: string): string {
  const encoded = Array.from(String(id ?? ""), (char) => char.codePointAt(0)!.toString(16)).join("-");
  return `--slirc-popup-${encoded || "row"}`;
}

// WebKit reports full anchor support, but a fixed popup anchored to a button inside the scrolled
// transcript lands as far below the button as the transcript has scrolled. Seen in the macOS 26.7 system
// WebKit on 13 Nov 2026: menu 2355px under its button with `.chat` at scrollTop 2400. CSS.supports cannot
// see that, so WebKit (Safari, the Mac and iOS apps, every iOS browser) takes the pixel path.
export function supportsAnchorPositioning(
  css: { supports?: (property: string, value: string) => boolean } | undefined = globalThis.CSS as never,
  userAgent: string = globalThis.navigator?.userAgent ?? "",
): boolean {
  if (/AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent)) return false;
  return typeof css?.supports === "function"
    && css.supports("position-anchor", "--slirc-popup-x")
    && css.supports("top", "anchor(bottom)")
    && css.supports("position-try-fallbacks", "flip-inline");
}

export function anchorPopupStyle(anchorName: string, side: PopupSide): string {
  const block = side === "above"
    ? "top: auto; bottom: calc(anchor(top) + 6px);"
    : "top: calc(anchor(bottom) + 6px); bottom: auto;";
  return `position: fixed; position-anchor: ${anchorName}; position-try-fallbacks: flip-inline; ${block} left: anchor(left); right: auto;`;
}

export function usablePopupViewport(viewport: PopupViewport, composerTop?: number): PopupViewport {
  return composerTop === undefined ? viewport : { ...viewport, bottom: Math.min(viewport.bottom, composerTop - 8) };
}

export function popupSide(trigger: PopupTrigger, size: PopupSize, viewport: PopupViewport, gap = 6): PopupSide {
  const spaceBelow = viewport.bottom - trigger.bottom - gap;
  const spaceAbove = trigger.top - viewport.top - gap;
  return spaceBelow < size.height && spaceAbove > spaceBelow ? "above" : "below";
}

export function popupMaxHeight(trigger: PopupTrigger, size: PopupSize, viewport: PopupViewport, side: PopupSide, gap = 6): number | undefined {
  const available = Math.max(0, side === "above" ? trigger.top - viewport.top - gap : viewport.bottom - trigger.bottom - gap);
  return size.height > available ? Math.max(32, Math.floor(available)) : undefined;
}

export function placePopup(trigger: PopupTrigger, size: PopupSize, viewport: PopupViewport, gap = 6): PopupPlacement {
  const side = popupSide(trigger, size, viewport, gap);
  const flipAbove = side === "above";
  const spaceBelow = viewport.bottom - trigger.bottom - gap;
  const spaceAbove = trigger.top - viewport.top - gap;
  const available = Math.max(0, flipAbove ? spaceAbove : spaceBelow);
  const desiredTop = flipAbove ? trigger.top - gap - size.height : trigger.bottom + gap;
  const top = Math.max(viewport.top + 4, Math.min(desiredTop, viewport.bottom - Math.min(size.height, available) - 4));
  const left = Math.max(viewport.left + 4, Math.min(trigger.left, viewport.right - size.width - 4));
  return { top, left, maxHeight: popupMaxHeight(trigger, size, viewport, side, gap) };
}

export function visualViewportRect(): { top: number; left: number; right: number; bottom: number } {
  const vv = window.visualViewport;
  const viewport = vv
    ? { top: vv.offsetTop, left: vv.offsetLeft, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height }
    : { top: 0, left: 0, right: globalThis.innerWidth, bottom: globalThis.innerHeight };
  // The fixed composer overlays the bottom of the chat; viewport bounds alone let popups hide
  // behind it. Treat its top edge as the usable bottom boundary.
  const composer = document.querySelector<HTMLElement>("#composer");
  const top = composer && composer.getBoundingClientRect().height > 0 ? composer.getBoundingClientRect().top : undefined;
  return usablePopupViewport(viewport, top);
}

export function popupStyleFrom(placement: { left: number | null; right: number | null; width: number | null; bottom: number }): string {
  const parts = [`bottom: ${placement.bottom}px`];
  if (placement.left !== null) parts.push(`left: ${placement.left}px`);
  if (placement.right !== null) parts.push(`right: ${placement.right}px`);
  else parts.push("right: auto");
  parts.push(placement.width === null ? "width: auto" : `width: ${placement.width}px`);
  return parts.join("; ");
}

// The + menu is teleported to <body> (a child of the blurred composer cannot blur what is behind it),
// so it is placed by hand: left edge on the + button, bottom edge just above the composer.
export function plusMenuPlacement(button: { left: number }, composerTop: number, viewport: { width: number; height: number }, menuWidth = 168): { left: number; bottom: number } {
  const left = Math.max(8, Math.min(button.left, viewport.width - menuWidth - 8));
  return { left: Math.round(left), bottom: Math.round(viewport.height - composerTop + 6) };
}

// The thread panel's More menu is teleported to <body> for the same reason: right edge on the button,
// top edge just below it.
export function menuUnderPlacement(button: { right: number; bottom: number }, viewport: { width: number }): { right: number; top: number } {
  return { right: Math.max(8, Math.round(viewport.width - button.right)), top: Math.round(button.bottom + 4) };
}

export function placeMenuUnder(menu: HTMLElement | undefined, button: HTMLElement | undefined): void {
  if (!menu || !button) return;
  const place = menuUnderPlacement(button.getBoundingClientRect(), { width: globalThis.innerWidth });
  menu.style.right = `${place.right}px`;
  menu.style.top = `${place.top}px`;
}

export function placePlusMenu(menu: HTMLElement | undefined, button: HTMLElement | undefined): void {
  if (!menu || !button) return;
  const composer = button.closest<HTMLElement>(".composer") ?? button;
  const place = plusMenuPlacement(button.getBoundingClientRect(), composer.getBoundingClientRect().top, { width: globalThis.innerWidth, height: globalThis.innerHeight }, menu.offsetWidth || 168);
  menu.style.left = `${place.left}px`;
  menu.style.bottom = `${place.bottom}px`;
}

export function commandPaletteStyle(isDesktop: boolean): string {
  const composer = document.querySelector<HTMLElement>("#composer")?.getBoundingClientRect();
  if (!composer) return "display: none";
  return popupStyleFrom(composerPopupPlacement(composer, isDesktop, { width: globalThis.innerWidth, height: globalThis.innerHeight }));
}

export function giphyPanelStyle(isDesktop: boolean): string {
  const composer = document.querySelector<HTMLElement>("#composer")?.getBoundingClientRect();
  if (!composer) return "left: .5rem; right: .5rem; width: auto";
  return popupStyleFrom(composerPopupPlacement(composer, isDesktop, { width: globalThis.innerWidth, height: globalThis.innerHeight }));
}
