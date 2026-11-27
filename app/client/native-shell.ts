import { workspaceOrigin } from "@client/workspace-mark.ts";

// The iOS shell in native/ and the Mac app in desktop/ load this client from the workspace's own
// address, and both can return to their workspace picker. On iOS the SlircShell plugin offers
// switchWorkspace. The Mac app registers a slircSwitchWorkspace message handler; builds before it
// have only slircShell, so the handler itself is the test, not html.mac-shell. Browsers and the
// installed Home Screen app have neither, so "Switch workspace" shows only where the call works.
type Win = {
  webkit?: { messageHandlers?: { slircSwitchWorkspace?: { postMessage: (body: unknown) => void }; slircNotify?: { postMessage: (body: unknown) => Promise<unknown> }; slircUnread?: { postMessage: (body: unknown) => void } } };
  location?: { assign: (url: string) => void };
  SlircShellInfo?: { version?: unknown; build?: unknown };
  SlircWorkspaces?: unknown;
  SlircUnread?: unknown;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  SlircOpenWorkspaces?: () => boolean;
  Capacitor?: {
    isNativePlatform?: () => boolean;
    isPluginAvailable?: (name: string) => boolean;
    Plugins?: { SlircShell?: { ready?: () => Promise<unknown>; switchWorkspace?: (options?: { link: string }) => Promise<unknown>; workspaces?: () => Promise<{ workspaces?: unknown }>;
      notificationStatus?: () => Promise<unknown>; enableNotifications?: () => Promise<unknown> } };
  };
};

function iosShell(win: Win): boolean {
  return !!win.Capacitor?.isNativePlatform?.() && !!win.Capacitor?.isPluginAvailable?.("SlircShell");
}

// Any native Capacitor page is the iOS app, including builds from before the SlircShell plugin, so
// it never offers the iPhone app to itself.
export function inIosApp(win: Win = globalThis as Win): boolean {
  return !!win.Capacitor?.isNativePlatform?.();
}

// The iOS shell keeps its own mark over the page until the page says it has painted, so the page skips
// its boot screen. Shell builds from before SlircShell.ready have no such overlay and need the boot
// screen, so the method itself is the test. public/theme.js makes the same check to set html[data-shell].
export function shellOwnsStart(win: Win = globalThis as Win): boolean {
  return iosShell(win) && typeof win.Capacitor?.Plugins?.SlircShell?.ready === "function";
}

// Tells the shell the app is on screen, so it can take its overlay off. A no-op everywhere else.
export function shellReady(win: Win = globalThis as Win): void {
  if (shellOwnsStart(win)) void win.Capacitor?.Plugins?.SlircShell?.ready?.().catch(() => {});
}

function macShell(win: Win): boolean {
  return typeof win.webkit?.messageHandlers?.slircSwitchWorkspace?.postMessage === "function";
}

// Any Mac app build, including ones from before slircSwitchWorkspace. Its menu owns Cmd+Option+O.
export function inMacApp(win: Win = globalThis as Win): boolean {
  const handlers = win.webkit?.messageHandlers as Record<string, unknown> | undefined;
  return !!handlers && ("slircShell" in handlers || "slircSwitchWorkspace" in handlers);
}

export function canSwitchWorkspace(win: Win = globalThis as Win): boolean {
  return iosShell(win) || macShell(win);
}

export async function switchWorkspace(win: Win = globalThis as Win): Promise<void> {
  if (iosShell(win)) await win.Capacitor?.Plugins?.SlircShell?.switchWorkspace?.();
  else if (macShell(win)) win.webkit?.messageHandlers?.slircSwitchWorkspace?.postMessage(null);
}

// After a sign-out the Mac app asks which workspace to open, as on its first launch, so the next
// sign-in can be a different workspace. On iOS the sign-in screen's "Switch workspace" does that.
export function signedOut(win: Win = globalThis as Win): void {
  if (macShell(win)) win.webkit?.messageHandlers?.slircSwitchWorkspace?.postMessage({ signedOut: true });
}

// The shell's page script sets window.SlircShellInfo to the app's version and build number, such as
// "1.0" and "1". Null in a browser, the Home Screen app and shell builds from before it.
export function shellVersion(win: Win = globalThis as Win): string | null {
  const info = win.SlircShellInfo;
  return typeof info?.version === "string" && typeof info?.build === "string" ? `iOS ${info.version} (${info.build})` : null;
}

// The About row: the product, the client build as its first 7 characters, and the app's version
// inside the shell.
export function aboutLabel(clientVersion: string, shell: string | null): string {
  const build = /^[0-9a-f]{6,40}$/.test(clientVersion) ? `build ${clientVersion.slice(0, 7)}` : "";
  return ["Slirc 2", build, shell].filter(Boolean).join(" · ");
}

// Opens another workspace's link, such as its pairing link. Inside the iOS shell it goes through
// the picker, which saves that workspace and makes it the last used one, so the next launch opens
// it. iOS builds from before the link option show the picker instead. Elsewhere, the Mac app
// included, the page just navigates.
export async function openWorkspaceLink(url: string, win: Win = globalThis as Win): Promise<void> {
  if (iosShell(win)) await win.Capacitor?.Plugins?.SlircShell?.switchWorkspace?.({ link: url });
  else win.location?.assign(url);
}

// The workspaces the app has saved, for the workspace dialog. The Mac app's page script sets
// window.SlircWorkspaces; the iOS shell answers SlircShell.workspaces() from its picker's list.
// Browsers and the Home Screen app keep their own list (workspace-list.ts); older app builds know none.
export async function shellWorkspaces(win: Win = globalThis as Win): Promise<string[]> {
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  if (iosShell(win)) return strings((await win.Capacitor?.Plugins?.SlircShell?.workspaces?.().catch(() => null))?.workspaces);
  return strings(win.SlircWorkspaces);
}

// Whether the app can hand the workspace dialog its saved workspaces. iOS builds before
// SlircShell.workspaces, such as TestFlight build 3, and Mac builds before window.SlircWorkspaces
// can't, so the dialog would list only this workspace. Those open their own picker instead, which
// lists every saved one. A browser has nothing saved and always gets the dialog.
export function shellListsWorkspaces(win: Win = globalThis as Win): boolean {
  if (iosShell(win)) return typeof win.Capacitor?.Plugins?.SlircShell?.workspaces === "function";
  if (macShell(win)) return Array.isArray(win.SlircWorkspaces);
  return true;
}

// Unread across workspaces, for the instance rail. Only the Mac app can know it: it keeps one live
// page per workspace, so each page tells the app its own badge count (slircUnread) and the app
// hands every workspace's count back to the page on screen as window.SlircUnread, an object of
// origin to count, followed by a "slirc-unread" event. A browser, the Home Screen app and the iOS
// shell load one workspace at a time and can't read another origin's state, so they report and
// receive nothing. Builds from before slircUnread lack the handler and get null from this.
export function reportUnread(count: number, win: Win = globalThis as Win): void {
  const handler = win.webkit?.messageHandlers?.slircUnread;
  if (typeof handler?.postMessage === "function") handler.postMessage({ count: Math.max(0, Math.floor(count) || 0) });
}

// The shell's counts as a map of https origin to a count above zero. Anything else is dropped.
export function readWorkspaceUnread(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, count] of Object.entries(value)) {
    const origin = workspaceOrigin(key);
    if (origin && origin === key && typeof count === "number" && Number.isFinite(count) && count > 0) out[origin] = Math.floor(count);
  }
  return out;
}

// Calls onChange with the shell's counts now and on every update. Returns the function that stops it.
export function watchWorkspaceUnread(onChange: (counts: Record<string, number>) => void, win: Win = globalThis as Win): () => void {
  const read = () => onChange(readWorkspaceUnread(win.SlircUnread));
  read();
  win.addEventListener?.("slirc-unread", read);
  return () => win.removeEventListener?.("slirc-unread", read);
}

// The Mac app's Switch Workspace menu item calls window.SlircOpenWorkspaces() and shows its own
// picker unless that returns true. It returns true only once the dialog is open, so the sign-in
// screen, a page still loading, Mac builds that can't list their workspaces and web builds without
// this hook all get the picker. Returns the function that removes it again.
type DialogUi = { authenticated: boolean; workspaceDialog: boolean; openWorkspaces: () => void };
export function exposeWorkspaceDialog(ui: DialogUi, win: Win = globalThis as Win): () => void {
  const open = () => {
    if (!ui.authenticated || !shellListsWorkspaces(win)) return false;
    if (!ui.workspaceDialog) ui.openWorkspaces();
    return true;
  };
  win.SlircOpenWorkspaces = open;
  return () => { if (win.SlircOpenWorkspaces === open) delete win.SlircOpenWorkspaces; };
}

// Opens a workspace picked in the dialog. The iOS picker gets it as a link, checks the host and
// saves it. The Mac app checks it the same way and opens it in a new window; Mac builds from before
// that show their own prompt. A browser goes to browserLink, which carries its workspace list.
export async function openWorkspace(origin: string, win: Win = globalThis as Win, browserLink = origin + "/"): Promise<void> {
  if (iosShell(win)) await win.Capacitor?.Plugins?.SlircShell?.switchWorkspace?.({ link: origin + "/" });
  else if (macShell(win)) win.webkit?.messageHandlers?.slircSwitchWorkspace?.postMessage({ open: origin });
  else win.location?.assign(browserLink);
}

// Notifications inside the apps, where WKWebView has no web push or Notification API. The Mac app
// answers a slircNotify message handler and shows what the page hands it with the system's
// notifications; the iOS app's SlircShell plugin asks for permission and returns the APNs device
// token, which the server pushes to. Builds from before these have neither and get null, as do
// browsers, which keep web push.
export type ShellPermission = "granted" | "denied" | "default";
export type ShellNotificationState = { permission: ShellPermission; token?: string; environment?: "sandbox" | "production" };
export type ShellNotifications = { platform: "mac" | "ios"; status: () => Promise<ShellNotificationState>; request: () => Promise<ShellNotificationState> };

export function readShellState(value: unknown): ShellNotificationState {
  const raw = (value || {}) as Record<string, unknown>;
  const permission: ShellPermission = raw.permission === "granted" || raw.permission === "denied" ? raw.permission : "default";
  const token = typeof raw.token === "string" && /^[0-9a-f]{64,200}$/i.test(raw.token) ? raw.token.toLowerCase() : undefined;
  const environment = raw.environment === "sandbox" || raw.environment === "production" ? raw.environment : undefined;
  return { permission, ...(token ? { token } : {}), ...(environment ? { environment } : {}) };
}

export function shellNotifications(win: Win = globalThis as Win): ShellNotifications | null {
  const plugin = win.Capacitor?.Plugins?.SlircShell;
  if (iosShell(win) && typeof plugin?.notificationStatus === "function" && typeof plugin.enableNotifications === "function") {
    return { platform: "ios", status: async () => readShellState(await plugin.notificationStatus!()), request: async () => readShellState(await plugin.enableNotifications!()) };
  }
  const mac = win.webkit?.messageHandlers?.slircNotify;
  if (typeof mac?.postMessage === "function") {
    return { platform: "mac", status: async () => readShellState(await mac.postMessage({ action: "status" })), request: async () => readShellState(await mac.postMessage({ action: "request" })) };
  }
  return null;
}

// A notification the server sent this page's account (the "notify" event). The Mac app shows it;
// clicking it brings that workspace forward on its route. Skipped while the window has focus on
// that same conversation, which the person is already reading.
export type ShellNote = { title: string; body: string; tag: string; url: string };
export function showShellNotification(data: unknown, win: Win = globalThis as Win, focusedOn: (url: string) => boolean = onScreen): boolean {
  const note = data as Partial<ShellNote> | null;
  const mac = win.webkit?.messageHandlers?.slircNotify;
  if (typeof mac?.postMessage !== "function" || !note || typeof note.title !== "string" || typeof note.body !== "string") return false;
  const url = typeof note.url === "string" && note.url.startsWith("/") && !note.url.startsWith("//") ? note.url : "/";
  if (focusedOn(url)) return false;
  void Promise.resolve(mac.postMessage({ action: "show", title: note.title, body: note.body, tag: typeof note.tag === "string" ? note.tag : "", path: url })).catch(() => {});
  return true;
}

function onScreen(url: string): boolean {
  if (typeof document === "undefined" || !document.hasFocus() || url === "/") return false;
  return location.pathname + location.hash === url;
}
