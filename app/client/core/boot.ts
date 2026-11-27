import type { ClientState } from "@client/client-state.ts";
import { shellReady } from "@client/native-shell.ts";

export interface BootDeps {
  ui: Pick<ClientState, "adminRoute" | "admissionRoute" | "agentsRoute" | "authenticated" | "booting" | "channelsRoute" | "ircRoute" | "isDesktop" | "mobileNav" | "profileRoute" | "roomsOpen" | "settingsRoute">;
  root: HTMLElement;
}

export function createBoot(deps: BootDeps) {
  const { ui, root } = deps;

  let painted = false;

  const paintWaiters: Array<() => void> = [];

  root.classList.add("booting");

  // Inside the iOS shell its own overlay covers the page until this: the first release of boot, then
  // two frames so the shell and the cached transcript have really painted. Once per page load.
  let shellAnnounced = false;
  function announceShellReady(): void {
    if (shellAnnounced) return;
    shellAnnounced = true;
    const frame = globalThis.requestAnimationFrame;
    if (typeof frame === "function") frame(() => frame(() => shellReady()));
  }

  function setBooting(on: boolean): void {
    ui.booting = on;
    root.classList.toggle("booting", on);
    if (!on) announceShellReady();
  }

  // Boot is released by real state, not a timer: unauthenticated/denied/error the moment auth/me
  // answers, authenticated only after the cached projection can actually paint.
  function releaseBoot(): void {
    if (ui.booting) setBooting(false);
  }

  // After the shell reveals, put the caret in a visible composer so typing works without a click.
  // Never steal focus from an already-used control, a dialog, or a hidden composer, and never
  // scroll-jump (the browser still decides whether a phone keyboard is allowed).
  function maybeFocusComposer(force = false): void {
    if (!ui.authenticated || ui.profileRoute || ui.settingsRoute || ui.channelsRoute || ui.ircRoute || ui.agentsRoute || ui.adminRoute || ui.admissionRoute || ui.booting) return;
    if (!ui.isDesktop && ui.mobileNav !== null) return;
    if (document.querySelector("dialog[open]")) return;
    const active = document.activeElement;
    if (!force && active && active !== document.body && active !== document.documentElement) return;
    const input = document.querySelector<HTMLElement>("#input");
    if (!input || !input.getClientRects().length || getComputedStyle(input).visibility === "hidden") return;
    input.focus({ preventScroll: true });
  }

  function revealShell(): void {
    releaseBoot();
    maybeFocusComposer();
  }

  function applyChrome(): void {
    // Desktop-only rail class; the phone uses mobileNav instead.
    document.body.classList.toggle("rooms-docked", ui.isDesktop && ui.roomsOpen);
  }

  function resetPainted(): void { painted = false; }

  function paintNow(): void {
    if (painted) return;
    painted = true;
    for (const resolve of paintWaiters.splice(0)) resolve();
  }

  function whenPainted(ms = 1_200): Promise<void> {
    if (painted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      paintWaiters.push(resolve);
      globalThis.setTimeout(resolve, ms); // a slow/empty cache still reveals the shell
    });
  }

  return { setBooting, releaseBoot, maybeFocusComposer, revealShell, applyChrome, resetPainted, paintNow, whenPainted };
}
