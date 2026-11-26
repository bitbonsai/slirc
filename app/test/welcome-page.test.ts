import "./fixture.ts";

import { afterEach, expect, test } from "bun:test";

// The page file resolves "./public" from the cwd.
process.chdir(new URL("..", import.meta.url).pathname);

const { app } = await import("../src/server.ts");

const saved = { APP_ORIGIN: process.env.APP_ORIGIN, APP_HOST: process.env.APP_HOST, SLIRC_IRC_HOST: process.env.SLIRC_IRC_HOST, SLIRC_IRC_PORT: process.env.SLIRC_IRC_PORT };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("/welcome serves the static first-steps page to anyone, not the app shell", async () => {
  const response = await app.request("/welcome");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-cache");
  const body = await response.text();
  expect(body).toContain("<title>Welcome - Slirc</title>");
  expect(body).not.toContain('x-data="client()"');
  // A computer is sent to Devices to add a phone; phones get the Home Screen step instead.
  expect(body).toContain('href="/settings"');
  expect(body).toContain('data-for="iphone"');
  expect(body).toContain('data-for="android"');
  expect(body).toContain('name="robots" content="noindex"');
  expect(body).not.toContain("—");
  expect(body).not.toContain("{{");
});

test("/welcome names this instance and its IRC server from config, never the request Host", async () => {
  delete process.env.APP_HOST;
  process.env.APP_ORIGIN = "https://ai-guild.slirc.app";
  process.env.SLIRC_IRC_HOST = "irc.ai-guild.slirc.app";
  process.env.SLIRC_IRC_PORT = "6697";
  const body = await (await app.request("/welcome", { headers: { Host: "evil.example" } })).text();
  expect(body).toContain("Open <strong>ai-guild.slirc.app</strong> in Safari");
  expect(body).toContain("<code>irc.ai-guild.slirc.app:6697</code>");
  expect(body).toContain('href="/agents"');
  // Only shipped harnesses are named as working.
  expect(body).toContain("<p>Pi, Claude Code, Codex and OpenCode work today. Open <strong>Agents</strong> for the one line to run");
  expect(body).toContain("More coding agents are coming.");
  expect(body).not.toContain("app.slirc.org");
  expect(body).not.toContain("evil.example");
});

// Runs the page's head script against a fake browser and returns the device it picked.
async function pickedDevice(win: { userAgent: string; maxTouchPoints?: number; standalone?: boolean; displayStandalone?: boolean; __slircNative?: unknown; Capacitor?: unknown }): Promise<string> {
  const body = await (await app.request("/welcome")).text();
  expect(body).toMatch(/<head>[\s\S]*?<script src="\/welcome\.js\?v=[^"]+"><\/script>/);
  const script = await Bun.file("./public/welcome.js").text();
  const root = { dataset: {} as Record<string, string> };
  const navigator = { userAgent: win.userAgent, maxTouchPoints: win.maxTouchPoints ?? 0, standalone: win.standalone };
  const matchMedia = (query: string) => ({ matches: query === "(display-mode: standalone)" && !!win.displayStandalone });
  new Function("navigator", "matchMedia", "document", "window", script)(navigator, matchMedia, { documentElement: root, addEventListener: () => {} }, { __slircNative: win.__slircNative, Capacitor: win.Capacitor });
  return root.dataset.device;
}

test("/welcome picks the first step per device, and the iOS shell counts as installed", async () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  expect(await pickedDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe("desktop");
  expect(await pickedDevice({ userAgent: iphone })).toBe("iphone");
  expect(await pickedDevice({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130.0 Mobile" })).toBe("android");
  expect(await pickedDevice({ userAgent: iphone, standalone: true })).toBe("installed");
  expect(await pickedDevice({ userAgent: iphone, Capacitor: { isNativePlatform: () => true } })).toBe("installed");
  expect(await pickedDevice({ userAgent: iphone, __slircNative: {} })).toBe("installed");
  expect(await pickedDevice({ userAgent: iphone, Capacitor: { isNativePlatform: () => false } })).toBe("iphone");
});

test("/welcome videos load lazily from the repo copy, one per platform step", async () => {
  const body = await (await app.request("/welcome")).text();
  expect(body).toContain('data-src="/media/a2hs-iphone.mp4"');
  expect(body).toContain('data-src="/media/a2hs-android.mp4"');
  expect(body).not.toMatch(/<video[^>]* src=/);
  expect(body.match(/<video[^>]*muted loop playsinline preload="none"/g)?.length).toBe(2);
  const video = await app.request("/media/a2hs-iphone.mp4");
  expect(video.status).toBe(200);
  expect(video.headers.get("content-type")).toBe("video/mp4");
});

test("/welcome drops the IRC card when the instance advertises no IRC server", async () => {
  process.env.APP_ORIGIN = "https://ai-guild.slirc.app";
  delete process.env.SLIRC_IRC_HOST;
  const body = await (await app.request("/welcome")).text();
  expect(body).not.toContain("data-irc");
  expect(body).not.toContain("{{");
});
