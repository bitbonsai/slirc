import { expect, test } from "bun:test";

const handlers = new Map<string, (event: any) => void>();
const deleted: string[] = [];
let claimed = false;
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: {
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    skipWaiting() {},
    location: { origin: "https://app.slirc.org" },
    clients: { claim: async () => { claimed = true; } },
    registration: { showNotification: async (title: string, options: any) => { shown.push({ title, options }); } },
    navigator: { setAppBadge: async () => { badges += 1; } },
  },
});
const shown: { title: string; options: any }[] = [];
let badges = 0;
const windows: any[] = [];
const opened: string[] = [];
Object.defineProperty(globalThis, "clients", {
  configurable: true,
  value: { matchAll: async () => windows, openWindow: async (url: string) => { opened.push(url); } },
});
Object.defineProperty(globalThis, "caches", {
  configurable: true,
  value: {
    keys: async () => ["shell-vold", "shell-volder", "unrelated-cache"],
    delete: async (name: string) => { deleted.push(name); return true; },
  },
});
await import("../public/sw.js");

test("upgrade retires only legacy shell caches and never intercepts requests", async () => {
  let activation: Promise<void> | undefined;
  handlers.get("activate")!({ waitUntil: (task: Promise<void>) => { activation = task; } });
  await activation;
  expect(deleted).toEqual(["shell-vold", "shell-volder"]);
  expect(claimed).toBe(true);
  expect(handlers.has("fetch")).toBe(false);
  expect(handlers.has("push")).toBe(true);
  expect(handlers.has("notificationclick")).toBe(true);
});

const run = async (name: string, event: any) => {
  let task: Promise<unknown> | undefined;
  handlers.get(name)!({ ...event, waitUntil: (value: Promise<unknown>) => { task = value; } });
  await task;
};

test("a push shows the notification with its conversation link and marks the app icon", async () => {
  await run("push", { data: { json: () => ({ title: "ada in #general", body: "hi", tag: "t", url: "/#general" }) } });
  expect(shown.at(-1)).toEqual({ title: "ada in #general", options: { body: "hi", tag: "t", data: { url: "/#general" } } });
  expect(badges).toBe(1);
});

test("a push link that is not a path on this origin opens the root", async () => {
  for (const url of ["/\\evil.com", "//evil.com", "https://evil.com", "javascript:alert(1)", "https://evil.example/", "//evil.example/x", 7, undefined]) {
    await run("push", { data: { json: () => ({ title: "x", body: "y", url }) } });
    expect(shown.at(-1)!.options.data.url).toBe("/");
  }
  for (const url of ["/#general", "https://app.slirc.org/#t-abc"]) {
    await run("push", { data: { json: () => ({ title: "x", body: "y", url }) } });
    expect(shown.at(-1)!.options.data.url).toBe(url.replace("https://app.slirc.org", ""));
  }
});

test("tapping a notification opens its conversation in the open window, or a new one", async () => {
  const notification = (url: string) => ({ close() {}, data: { url } });
  await run("notificationclick", { notification: notification("/#general") });
  expect(opened).toEqual(["/#general"]);
  const calls: string[] = [];
  windows.push({ focus: async () => { calls.push("focus"); }, navigate: async (url: string) => { calls.push(url); } });
  await run("notificationclick", { notification: notification("/#t-abc") });
  expect(calls).toEqual(["focus", "/#t-abc"]);
  expect(opened).toEqual(["/#general"]);
});
