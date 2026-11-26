// "Get the iPhone app" shows only when /api/apps returns a TestFlight join link, and never inside
// the iOS app itself.
import { afterEach, expect, test } from "bun:test";
import { createIphoneApp } from "../client/iphone-app.ts";
import { inIosApp } from "../client/native-shell.ts";

const JOIN = "https://testflight.apple.com/join/AbC123xy";
const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
afterEach(() => { if (saved) Object.defineProperty(globalThis, "fetch", saved); });

function respond(make: () => Response) {
  const calls: string[] = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (path: string) => { calls.push(path); return make(); } });
  return calls;
}
const ios = { Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => false } };

test("a link from the API shows the row, fetched once per account", async () => {
  const calls = respond(() => Response.json({ testflight: JOIN }));
  const state = { iphoneAppUrl: "" };
  const app = createIphoneApp(state, {});
  await app.load("ivy");
  await app.load("ivy");
  expect(state.iphoneAppUrl).toBe(JOIN);
  expect(calls).toEqual(["/api/apps"]);
  app.reset();
  expect(state.iphoneAppUrl).toBe("");
});

test("null, a non-join link or an error keeps the row hidden", async () => {
  for (const make of [() => Response.json({ testflight: null }), () => Response.json({ testflight: "https://evil.example/join/x" }),
    () => Response.json({ error: "not signed in" }, { status: 401 }), () => new Response("nope", { status: 500 })]) {
    respond(make);
    const state = { iphoneAppUrl: "" };
    await createIphoneApp(state, {}).load("ivy");
    expect(state.iphoneAppUrl).toBe("");
  }
});

test("inside the iOS app the row stays hidden and nothing is fetched", async () => {
  const calls = respond(() => Response.json({ testflight: JOIN }));
  const state = { iphoneAppUrl: "" };
  await createIphoneApp(state, ios).load("ivy");
  expect(state.iphoneAppUrl).toBe("");
  expect(calls).toEqual([]);
  expect(inIosApp(ios)).toBe(true);
  expect(inIosApp({})).toBe(false);
  expect(inIosApp({ Capacitor: { isNativePlatform: () => false } })).toBe(false);
});

test("a failed request retries on the next open", async () => {
  let ok = false;
  const calls = respond(() => ok ? Response.json({ testflight: JOIN }) : new Response("", { status: 502 }));
  const state = { iphoneAppUrl: "" };
  const app = createIphoneApp(state, {});
  await app.load("ivy");
  ok = true;
  await app.load("ivy");
  expect(state.iphoneAppUrl).toBe(JOIN);
  expect(calls.length).toBe(2);
});
