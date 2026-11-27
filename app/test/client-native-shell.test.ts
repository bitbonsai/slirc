// "Switch workspace" belongs to the iOS shell and the Mac app. Browsers, the installed Home Screen
// app, iOS builds without the SlircShell plugin and Mac builds without the handler never see it.
import { expect, test } from "bun:test";
import { readShellState, readWorkspaceUnread, reportUnread, watchWorkspaceUnread, shellNotifications, showShellNotification } from "../client/native-shell.ts";
import { aboutLabel, canSwitchWorkspace, exposeWorkspaceDialog, openWorkspace, openWorkspaceLink, shellListsWorkspaces, shellOwnsStart, shellReady, shellVersion, shellWorkspaces, signedOut, switchWorkspace } from "../client/native-shell.ts";

const shell = (plugins: string[], calls: string[] = []) => ({
  Capacitor: {
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => plugins.includes(name),
    Plugins: { SlircShell: { switchWorkspace: async () => { calls.push("switchWorkspace"); } } },
  },
});

test("a browser or the Home Screen app cannot switch workspace", () => {
  expect(canSwitchWorkspace({})).toBe(false);
  expect(canSwitchWorkspace(globalThis as never)).toBe(false);
  // Capacitor's web runtime reports no native platform even if a page bundles it.
  expect(canSwitchWorkspace({ Capacitor: { isNativePlatform: () => false, isPluginAvailable: () => true } })).toBe(false);
});

test("a shell build without the SlircShell plugin cannot switch workspace", () => {
  expect(canSwitchWorkspace(shell([]))).toBe(false);
  expect(canSwitchWorkspace(shell(["Preferences"]))).toBe(false);
});

test("the shell with the plugin can switch workspace, and the call reaches it", async () => {
  const calls: string[] = [];
  const win = shell(["SlircShell"], calls);
  expect(canSwitchWorkspace(win)).toBe(true);
  await switchWorkspace(win);
  expect(calls).toEqual(["switchWorkspace"]);
});

const mac = (handlers: string[], calls: unknown[] = []) => ({
  webkit: {
    messageHandlers: Object.fromEntries(handlers.map((name) => [name, { postMessage: (body: unknown) => { calls.push([name, body]); } }])),
  },
});

test("a Mac app build without the switch handler cannot switch workspace", () => {
  expect(canSwitchWorkspace(mac([]))).toBe(false);
  expect(canSwitchWorkspace(mac(["slircShell"]))).toBe(false);
});

test("the Mac app with the switch handler can switch workspace, and the call reaches it", async () => {
  const calls: unknown[] = [];
  const win = mac(["slircShell", "slircSwitchWorkspace"], calls);
  expect(canSwitchWorkspace(win)).toBe(true);
  await switchWorkspace(win);
  expect(calls).toEqual([["slircSwitchWorkspace", null]]);
});

test("in the Mac app another workspace's link navigates, as in a browser", async () => {
  const link = "https://ai-guild.slirc.app/pair";
  const calls: unknown[] = [];
  const assigned: string[] = [];
  await openWorkspaceLink(link, { ...mac(["slircSwitchWorkspace"], calls), location: { assign: (url: string) => { assigned.push(url); } } });
  expect(assigned).toEqual([link]);
  expect(calls).toEqual([]);
});

test("signing out opens the Mac app's workspace prompt, and nothing elsewhere", () => {
  const calls: unknown[] = [];
  signedOut(mac(["slircShell", "slircSwitchWorkspace"], calls));
  // The Mac app drops that workspace's page, so the next sign-in starts from a fresh one.
  expect(calls).toEqual([["slircSwitchWorkspace", { signedOut: true }]]);
  const old: unknown[] = [];
  signedOut(mac(["slircShell"], old));
  expect(old).toEqual([]);
  const ios: string[] = [];
  signedOut(shell(["SlircShell"], ios));
  expect(ios).toEqual([]);
  expect(() => signedOut({})).not.toThrow();
});

test("switching outside the shell does nothing", async () => {
  await expect(switchWorkspace({})).resolves.toBeUndefined();
});

test("About names the client build, and the app version only inside the shell", () => {
  expect(shellVersion({})).toBeNull();
  expect(shellVersion({ SlircShellInfo: { version: 1, build: "1" } })).toBeNull();
  expect(shellVersion({ SlircShellInfo: { version: "1.0", build: "3" } })).toBe("iOS 1.0 (3)");
  expect(aboutLabel("", null)).toBe("Slirc 2");
  expect(aboutLabel("9f3c2a1b7d", null)).toBe("Slirc 2 · build 9f3c2a1");
  expect(aboutLabel("9f3c2a1b7d", "iOS 1.0 (3)")).toBe("Slirc 2 · build 9f3c2a1 · iOS 1.0 (3)");
  expect(aboutLabel("<b>", null)).toBe("Slirc 2");
});

test("another workspace's link goes through the picker in the shell and navigates in a browser", async () => {
  const link = "https://ai-guild.slirc.app/pair#o=" + "t".repeat(43);
  const passed: unknown[] = [];
  const assigned: string[] = [];
  const location = { assign: (url: string) => { assigned.push(url); } };
  await openWorkspaceLink(link, {
    location,
    Capacitor: {
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === "SlircShell",
      Plugins: { SlircShell: { switchWorkspace: async (options?: { link: string }) => { passed.push(options); } } },
    },
  });
  expect(passed).toEqual([{ link }]);
  expect(assigned).toEqual([]);
  await openWorkspaceLink(link, { location });
  expect(assigned).toEqual([link]);
});

test("the workspace dialog gets the app's saved workspaces, and none in a browser", async () => {
  expect(await shellWorkspaces({})).toEqual([]);
  expect(await shellWorkspaces({ SlircWorkspaces: ["https://a.slirc.app", 3, "https://b.slirc.app"] })).toEqual(["https://a.slirc.app", "https://b.slirc.app"]);
  const ios = (workspaces?: () => Promise<{ workspaces?: unknown }>) => ({
    Capacitor: { isNativePlatform: () => true, isPluginAvailable: (name: string) => name === "SlircShell", Plugins: { SlircShell: { workspaces } } },
  });
  expect(await shellWorkspaces(ios(async () => ({ workspaces: ["https://a.slirc.app"] })))).toEqual(["https://a.slirc.app"]);
  expect(await shellWorkspaces(ios())).toEqual([]);
  expect(await shellWorkspaces(ios(async () => { throw new Error("old build"); }))).toEqual([]);
});

test("an app build that can't list its saved workspaces skips the dialog for its own picker", () => {
  // TestFlight build 3 has SlircShell.switchWorkspace and no SlircShell.workspaces.
  expect(shellListsWorkspaces(shell(["SlircShell"]))).toBe(false);
  const ios = shell(["SlircShell"]);
  (ios.Capacitor.Plugins.SlircShell as Record<string, unknown>).workspaces = async () => ({ workspaces: [] });
  expect(shellListsWorkspaces(ios)).toBe(true);
  expect(shellListsWorkspaces(mac(["slircShell", "slircSwitchWorkspace"]))).toBe(false);
  expect(shellListsWorkspaces({ ...mac(["slircShell", "slircSwitchWorkspace"]), SlircWorkspaces: ["https://a.slirc.app"] })).toBe(true);
  expect(shellListsWorkspaces({})).toBe(true);
});

test("a workspace picked in the dialog goes to the iOS picker, the Mac app, or the browser", async () => {
  const origin = "https://xmiro.slirc.app";
  const passed: unknown[] = [];
  await openWorkspace(origin, {
    Capacitor: {
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === "SlircShell",
      Plugins: { SlircShell: { switchWorkspace: async (options?: { link: string }) => { passed.push(options); } } },
    },
  });
  expect(passed).toEqual([{ link: origin + "/" }]);
  const calls: unknown[] = [];
  await openWorkspace(origin, mac(["slircShell", "slircSwitchWorkspace"], calls));
  expect(calls).toEqual([["slircSwitchWorkspace", { open: origin }]]);
  const assigned: string[] = [];
  await openWorkspace(origin, { location: { assign: (url: string) => { assigned.push(url); } } });
  expect(assigned).toEqual([origin + "/"]);
});

// Slirc menu > Switch Workspace… in the Mac app calls window.SlircOpenWorkspaces() and shows its own
// picker unless the call returns true.
test("the Mac menu's Switch Workspace opens the web dialog only while signed in", () => {
  const listing = { ...mac(["slircShell", "slircSwitchWorkspace"]), SlircWorkspaces: ["https://a.slirc.app"] } as Record<string, unknown>;
  let opened = 0;
  const ui = { authenticated: false, workspaceDialog: false, openWorkspaces: () => { opened += 1; ui.workspaceDialog = true; } };
  const remove = exposeWorkspaceDialog(ui, listing);
  const ask = listing.SlircOpenWorkspaces as () => boolean;
  expect(ask()).toBe(false);
  expect(opened).toBe(0);
  ui.authenticated = true;
  expect(ask()).toBe(true);
  expect(ask()).toBe(true);
  expect(opened).toBe(1);
  remove();
  expect(listing.SlircOpenWorkspaces).toBeUndefined();
  // A Mac build that can't list its saved workspaces keeps its own picker.
  const old = mac(["slircShell", "slircSwitchWorkspace"]) as Record<string, unknown>;
  exposeWorkspaceDialog({ ...ui, workspaceDialog: false }, old);
  expect((old.SlircOpenWorkspaces as () => boolean)()).toBe(false);
});

test("only a shell build that can take a ready message owns the start screen, and ready reaches it", () => {
  const calls: string[] = [];
  const withReady = shell(["SlircShell"]);
  (withReady.Capacitor.Plugins.SlircShell as Record<string, unknown>).ready = async () => { calls.push("ready"); };
  expect(shellOwnsStart(withReady)).toBe(true);
  shellReady(withReady);
  expect(calls).toEqual(["ready"]);
  // An older app, a browser and the Mac app keep the page's own boot screen and send nothing.
  expect(shellOwnsStart(shell(["SlircShell"]))).toBe(false);
  expect(shellOwnsStart({})).toBe(false);
  expect(shellOwnsStart(mac(["slircShell", "slircSwitchWorkspace"]))).toBe(false);
  expect(() => shellReady({})).not.toThrow();
});

test("only Mac and iOS builds with the notification bridge offer native notifications", () => {
  expect(shellNotifications({})).toBeNull();
  expect(shellNotifications(shell(["SlircShell"]))).toBeNull();
  expect(shellNotifications({ webkit: { messageHandlers: { slircShell: {} } } } as never)).toBeNull();
  expect(shellNotifications({ webkit: { messageHandlers: { slircNotify: { postMessage: async () => ({}) } } } } as never)?.platform).toBe("mac");
  const ios = shell(["SlircShell"]) as any;
  ios.Capacitor.Plugins.SlircShell.notificationStatus = async () => ({});
  ios.Capacitor.Plugins.SlircShell.enableNotifications = async () => ({});
  expect(shellNotifications(ios)?.platform).toBe("ios");
});

test("the app's answer is read defensively", () => {
  expect(readShellState(null)).toEqual({ permission: "default" });
  expect(readShellState({ permission: "granted", token: "AB".repeat(32), environment: "production" })).toEqual({ permission: "granted", token: "ab".repeat(32), environment: "production" });
  expect(readShellState({ permission: "granted", token: "<script>", environment: "dev" })).toEqual({ permission: "granted" });
});

test("the Mac app gets each notification with a same-site route, except for the conversation on screen", () => {
  const posted: any[] = [];
  const win = { webkit: { messageHandlers: { slircNotify: { postMessage: async (body: unknown) => { posted.push(body); } } } } } as never;
  expect(showShellNotification({ title: "ada in #general", body: "hi", tag: "t", url: "/#general" }, win, () => false)).toBe(true);
  expect(posted.at(-1)).toEqual({ action: "show", title: "ada in #general", body: "hi", tag: "t", path: "/#general" });
  showShellNotification({ title: "x", body: "y", tag: "t", url: "https://elsewhere.test/" }, win, () => false);
  expect(posted.at(-1).path).toBe("/");
  showShellNotification({ title: "x", body: "y", tag: "t", url: "//elsewhere.test" }, win, () => false);
  expect(posted.at(-1).path).toBe("/");
  expect(showShellNotification({ title: "x", body: "y", tag: "t", url: "/dm/ada" }, win, (url) => url === "/dm/ada")).toBe(false);
  expect(showShellNotification({ body: "no title" }, win, () => false)).toBe(false);
  expect(showShellNotification({ title: "x", body: "y" }, {} as never, () => false)).toBe(false);
  expect(posted).toHaveLength(3);
});

test("a page reports its unread count to the Mac app, and only where the handler exists", () => {
  const sent: unknown[] = [];
  const mac = { webkit: { messageHandlers: { slircUnread: { postMessage: (body: unknown) => { sent.push(body); } } } } };
  reportUnread(3, mac as never);
  reportUnread(-2, mac as never);
  reportUnread(Number.NaN, mac as never);
  expect(sent).toEqual([{ count: 3 }, { count: 0 }, { count: 0 }]);
  expect(() => reportUnread(3, {})).not.toThrow();
  expect(() => reportUnread(3, { webkit: { messageHandlers: { slircSwitchWorkspace: { postMessage() {} } } } } as never)).not.toThrow();
});

test("the shell's unread counts keep only workspace origins with a positive count", () => {
  expect(readWorkspaceUnread({ "https://a.example.test": 4.9, "https://b.example.test": 0, "https://c.example.test": -1, "http://d.example.test": 2, "a.example.test": 2, "https://e.example.test": "5" }))
    .toEqual({ "https://a.example.test": 4 });
  expect(readWorkspaceUnread(null)).toEqual({});
  expect(readWorkspaceUnread([1, 2])).toEqual({});
});

test("the page reads the shell's counts at once and again on each update", () => {
  const listeners: (() => void)[] = [];
  const win: { SlircUnread?: unknown; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void } = {
    addEventListener: (_t, f) => { listeners.push(f); },
    removeEventListener: (_t, f) => { listeners.splice(listeners.indexOf(f), 1); },
  };
  const seen: Record<string, number>[] = [];
  const stop = watchWorkspaceUnread((counts) => seen.push(counts), win as never);
  win.SlircUnread = { "https://a.example.test": 2 };
  listeners.forEach((f) => f());
  stop();
  expect(listeners).toHaveLength(0);
  expect(seen).toEqual([{}, { "https://a.example.test": 2 }]);
  // A browser has no such events and nothing to read.
  expect(() => watchWorkspaceUnread(() => {}, {})()).not.toThrow();
});
