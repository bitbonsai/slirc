// The Settings toggle inside the Mac and iPhone apps, where permission comes from the system and
// not from the browser's Notification API.
import { expect, test } from "bun:test";
import { createSettingsPage } from "@client/settings-page.ts";

type Shell = { permission: "granted" | "denied" | "default"; afterPrompt: "granted" | "denied"; token?: string; prompts: number };

async function check(kind: "mac" | "ios", run: (env: ReturnType<typeof setup>) => Promise<void>, apns = true) {
  const names = ["window", "navigator", "fetch", "webkit", "Capacitor"];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  try { await run(setup(kind, apns)); }
  finally { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
}

function setup(kind: "mac" | "ios", apns: boolean) {
  const shell: Shell = { permission: "default", afterPrompt: "granted", token: "ab".repeat(32), prompts: 0 };
  const server = { preference: "all", devices: new Set<string>() };
  const calls: { path: string; method: string; body: any }[] = [];
  const answer = () => ({ permission: shell.permission, ...(shell.permission === "granted" && shell.token ? { token: shell.token, environment: "sandbox" } : {}) });
  const prompt = async () => { shell.prompts++; if (shell.permission === "default") shell.permission = shell.afterPrompt; return answer(); };
  // WKWebView has neither web push nor the Notification API.
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  if (kind === "mac") {
    Object.defineProperty(globalThis, "webkit", { configurable: true, value: { messageHandlers: { slircShell: {}, slircNotify: { postMessage: async (body: { action: string }) => body.action === "request" ? prompt() : answer() } } } });
  } else {
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true, isPluginAvailable: (name: string) => name === "SlircShell",
      Plugins: { SlircShell: { notificationStatus: async () => answer(), enableNotifications: prompt } } } });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (path: string, init?: RequestInit) => {
    const method = init?.method || "GET", body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method, body });
    if (path === "/push/native") { server.devices.add(body.token); server.preference = "all"; return new Response(null, { status: 204 }); }
    if (path === "/push/preference" && method === "POST") { server.preference = body.preference; return new Response(null, { status: 204 }); }
    const device = new URL(path, "https://x.test").searchParams.get("device");
    const hashes = await Promise.all([...server.devices].map(async (token) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, "0")).join("")));
    return Response.json({ preference: server.preference, ...(device !== null ? { subscribed: hashes.includes(device), apns } : {}) });
  } });
  const settings = createSettingsPage((value) => value, {
    core: { authenticated: true, account: "eve", greeting: true },
    session: { scope: () => ({ instance: "https://slirc.example.test", account: "eve", accountId: "eve-id" }), key: () => "eve-id", stopped: () => false, signingOut: () => false },
    nextTick: async () => {},
  });
  return { settings, shell, server, calls };
}

test("the Mac app asks the system on toggle, then turns the account's notifications on and off", () => check("mac", async ({ settings, shell, calls }) => {
  await settings.loadNotifications();
  expect(shell.prompts).toBe(0);
  expect(settings.notificationsOn()).toBe(false);
  expect(settings.notificationReady).toBe(true);
  await settings.toggleNotifications();
  expect(shell.prompts).toBe(1);
  expect(settings.notificationsOn()).toBe(true);
  expect(calls.at(-1)).toEqual({ path: "/push/preference", method: "POST", body: { accountId: "eve-id", preference: "all" } });
  await settings.toggleNotifications();
  expect(settings.notificationsOn()).toBe(false);
  expect(calls.at(-1)?.body.preference).toBe("none");
}));

test("notifications turned off in macOS block the toggle and point to System Settings", () => check("mac", async ({ settings, shell, calls }) => {
  shell.permission = "denied";
  await settings.loadNotifications();
  expect(settings.notificationsOn()).toBe(false);
  expect(settings.notificationHint()).toContain("System Settings");
  const count = calls.length;
  await settings.toggleNotifications();
  expect(calls).toHaveLength(count);
  expect(shell.prompts).toBe(0);
}));

test("a refused prompt leaves the Mac toggle off without saving anything", () => check("mac", async ({ settings, shell, calls }) => {
  shell.afterPrompt = "denied";
  await settings.loadNotifications();
  await settings.toggleNotifications();
  expect(settings.notificationsOn()).toBe(false);
  expect(calls.some((call) => call.method === "POST")).toBe(false);
}));

test("the iPhone app registers its device token with the account, and reads it back as On", () => check("ios", async ({ settings, server, calls }) => {
  await settings.loadNotifications();
  expect(settings.notificationsOn()).toBe(false);
  await settings.toggleNotifications();
  expect(calls.at(-1)).toEqual({ path: "/push/native", method: "POST", body: { accountId: "eve-id", token: "ab".repeat(32), environment: "sandbox" } });
  expect(server.devices.size).toBe(1);
  expect(settings.notificationsOn()).toBe(true);
  await settings.loadNotifications();
  expect(settings.notificationsOn()).toBe(true);
}));

test("an iPhone that gets no token from Apple shows an error instead of On", () => check("ios", async ({ settings, shell }) => {
  shell.token = undefined;
  await settings.loadNotifications();
  await settings.toggleNotifications();
  expect(settings.notificationsOn()).toBe(false);
  expect(settings.notificationError).not.toBe("");
}));

test("notifications turned off on the iPhone point to its Settings app", () => check("ios", async ({ settings, shell }) => {
  shell.permission = "denied";
  await settings.loadNotifications();
  expect(settings.notificationHint()).toContain("Settings");
  expect(settings.notificationsOn()).toBe(false);
}));

test("a workspace without APNs says iPhone notifications aren't set up and never prompts", () => check("ios", async ({ settings, shell }) => {
  await settings.loadNotifications();
  expect(settings.notificationStatus()).toBe("Unavailable");
  expect(settings.notificationHint()).toContain("set up");
  await settings.toggleNotifications();
  expect(shell.prompts).toBe(0);
}, false));
