import { expect, test } from "bun:test";
import { createSettingsPage } from "@client/settings-page.ts";

async function check(run: (env: ReturnType<typeof setup>) => Promise<void>) {
  const saved = ["window", "navigator", "fetch"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  try { await run(setup()); }
  finally { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
}

function setup() {
  const state = { accountId: "eve-id", permission: "granted", subscribed: true, registered: true, preference: "all", fail: false, unsubscribed: 0, prompts: 0 };
  const calls: { path: string; method: string; body: any }[] = [];
  let pending: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
  const subscription = { endpoint: "https://push.example.test/local-fixture", toJSON: () => ({ endpoint: "https://push.example.test/local-fixture", keys: { p256dh: "fixture", auth: "fixture" } }), unsubscribe: async () => { state.unsubscribed++; return true; } };
  const notifications = { get permission() { return state.permission; }, requestPermission: async () => { state.prompts++; state.permission = "granted"; return "granted"; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { Notification: notifications, PushManager: {} } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => state.subscribed ? subscription : null, subscribe: async () => subscription } }) } } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (path: string, init?: RequestInit) => {
    const method = init?.method || "GET", body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method, body });
    if (pending) return pending(path, init);
    if (state.fail) return Response.json({ error: "Local fixture failure" }, { status: 503 });
    if (method !== "GET") return new Response(null, { status: 204 });
    if (path === "/push/public-key") return Response.json({ publicKey: "AA" });
    if (path === "/api/sessions") return Response.json([
      { id: "a".repeat(64), device: "Chrome · local fixture", current: true, createdAt: 1 },
      { id: "b".repeat(64), device: "Firefox · local fixture", current: false, createdAt: 2 },
    ]);
    return Response.json({ preference: state.preference, subscribed: state.registered });
  } });
  const core = { authenticated: true, account: "eve", greeting: true };
  const settings = createSettingsPage((value) => value, {
    core,
    session: { scope: () => ({ instance: "https://slirc.example.test", account: "eve", accountId: state.accountId }), key: () => state.accountId, stopped: () => false, signingOut: () => false },
    nextTick: async () => {},
  });
  return { settings, state, calls, core, intercept: (fn: typeof pending) => { pending = fn; } };
}

test("notifications persist Off without unsubscribing, then enable with the immutable account", () => check(async ({ settings, state, calls }) => {
  await settings.loadNotifications();
  expect(settings.notificationsOn()).toBe(true);
  await settings.toggleNotifications();
  expect(settings.notificationStatus()).toBe("Off");
  expect(calls.at(-1)).toEqual({ path: "/push/preference", method: "POST", body: { accountId: "eve-id", preference: "none" } });
  expect(state.unsubscribed).toBe(0);
  await settings.toggleNotifications();
  expect(settings.notificationsOn()).toBe(true);
  expect(calls.at(-1)?.body.accountId).toBe("eve-id");
}));

test("another account's browser subscription is not reported as On or silently reassigned", () => check(async ({ settings, state, calls }) => {
  state.registered = false;
  await settings.loadNotifications();
  expect(settings.notificationsOn()).toBe(false);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
}));

test("permission is prompted only by toggle; blocked and unsupported browsers cannot enable", () => check(async ({ settings, state, calls }) => {
  state.permission = "default"; state.subscribed = false;
  await settings.loadNotifications();
  expect(state.prompts).toBe(0);
  await settings.toggleNotifications();
  expect(state.prompts).toBe(1);
  expect(settings.notificationsOn()).toBe(true);
  state.permission = "denied";
  await settings.loadNotifications();
  expect(settings.notificationStatus()).toBe("Blocked");
  const count = calls.length;
  await settings.toggleNotifications();
  expect(calls).toHaveLength(count);
  Reflect.deleteProperty(window, "PushManager");
  await settings.loadNotifications();
  expect(settings.notificationStatus()).toBe("Unavailable");
}));

test("failed writes preserve On and failed new subscriptions are cleaned up", () => check(async ({ settings, state, intercept }) => {
  await settings.loadNotifications(); state.fail = true;
  await settings.toggleNotifications();
  expect(settings.notificationsOn()).toBe(true);
  expect(settings.notificationError).toBe("Local fixture failure");
  state.fail = false; state.subscribed = false;
  await settings.loadNotifications();
  intercept(async (path) => path === "/push/public-key" ? Response.json({ publicKey: "AA" }) : Response.json({ error: "Local fixture failure" }, { status: 503 }));
  await settings.toggleNotifications();
  expect(state.unsubscribed).toBe(1);
  // Existing permission does not make a failed API save look successful.
  expect(settings.notificationsOn()).toBe(false);
  expect(settings.notificationBusy).toBe(false);
}));

test("late notification reads cannot restore state after account reset", () => check(async ({ settings, state, intercept }) => {
  Reflect.deleteProperty(window, "PushManager");
  let finish!: (response: Response) => void;
  intercept(() => new Promise((resolve) => { finish = resolve; }));
  const reading = settings.loadNotifications();
  settings.reset(); state.accountId = "another-account";
  finish(Response.json({ preference: "all" })); await reading;
  expect(settings.subscribed).toBe(false);
  expect(settings.notificationReady).toBe(false);
  expect(settings.notificationLoading).toBe(false);
}));

test("sessions keep Current first, cancel sends nothing, confirmation only revokes other sessions", () => check(async ({ settings, calls }) => {
  await settings.loadSessions();
  expect(settings.sessions[0]?.current).toBe(true);
  const button = {} as HTMLElement;
  settings.askSignOut("a".repeat(64), button);
  expect(settings.signOutTarget).toBeNull();
  settings.askSignOut(null, button); settings.closeSignOut();
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
  settings.askSignOut(null, button); await settings.confirmSignOut();
  expect(calls.at(-1)?.path).toBe(`/api/sessions/${"b".repeat(64)}?other=1`);
  expect(settings.sessions).toHaveLength(1);
  expect(settings.sessions[0]?.current).toBe(true);
  expect(settings.signOutTarget).toBeNull();
}));

test("the G'day greeting setting saves per account and flips only after the server accepts it", () => check(async ({ settings, state, calls, core }) => {
  await settings.toggleGreeting();
  expect(calls.at(-1)).toEqual({ path: "/profile", method: "PATCH", body: { accountId: "eve-id", greeting: false } });
  expect(core.greeting).toBe(false);
  state.fail = true;
  await settings.toggleGreeting();
  expect(calls.at(-1)?.body).toEqual({ accountId: "eve-id", greeting: true });
  expect(core.greeting).toBe(false);
  expect(settings.greetingError).toBe("Local fixture failure");
  expect(settings.greetingBusy).toBe(false);
}));
