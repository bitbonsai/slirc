// A phone browser gets a one-line strip on Home that links to /welcome, where the Home Screen
// steps and videos live. Both flags are kept on this device, never on the account: dismissing it
// here says nothing about another phone. Once the client has run installed (Home Screen app or the
// iOS shell), the strip stays off for good. iOS keeps a Home Screen app's storage apart from
// Safari, so there that mark only reaches the installed copy; Android browsers share it.
export type InstallEnv = { userAgent: string; maxTouchPoints: number; standalone: boolean; native: boolean };

const DISMISSED = "slirc:install-banner-dismissed";
const RAN_INSTALLED = "slirc:ran-installed";

type Win = {
  navigator?: { userAgent?: string; maxTouchPoints?: number; standalone?: boolean };
  matchMedia?: (query: string) => { matches: boolean };
  __slircNative?: unknown;
  Capacitor?: { isNativePlatform?: () => boolean };
};

export function installEnv(win: Win = globalThis as Win): InstallEnv {
  const nav = win.navigator || {};
  return {
    userAgent: nav.userAgent || "",
    maxTouchPoints: nav.maxTouchPoints || 0,
    standalone: nav.standalone === true || !!win.matchMedia?.("(display-mode: standalone)").matches,
    // The iOS shell puts Capacitor's bridge on every workspace host it opens.
    native: !!win.__slircNative || !!win.Capacitor?.isNativePlatform?.(),
  };
}

// Same rule as /welcome: iPadOS reports a Mac user agent, so a touch Mac counts.
export function isPhoneBrowser(env: InstallEnv): boolean {
  return /Android|iPhone|iPod|iPad/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

// Decides whether to show the strip, and records an installed run so it never comes back.
export function installBannerVisible(env: InstallEnv, storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): boolean {
  const installed = env.standalone || env.native;
  try {
    if (installed) { storage?.setItem(RAN_INSTALLED, "1"); return false; }
    if (!isPhoneBrowser(env)) return false;
    return storage?.getItem(DISMISSED) !== "1" && storage?.getItem(RAN_INSTALLED) !== "1";
  } catch {
    // Storage blocked: show it, and a dismissal lasts for this page only.
    return !installed && isPhoneBrowser(env);
  }
}

export function dismissInstallBanner(storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(DISMISSED, "1"); } catch { /* private mode: hidden for this page only */ }
}
