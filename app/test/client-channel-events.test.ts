// Real-runtime check for the `channels` live event. Browser APIs are shims and the server is a
// fetch stub. A channel made or left on another device refreshes the grant; a tab that already
// agrees with the event makes no request.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { installBrowserShims } from "./support/browser-shims.ts";

function shims(origin: string): void {
  installBrowserShims({ origin, userAgent: "channel-events-test" });
}

function authBody(channels: string[]) {
  return {
    authenticated: true, account: "eve", accountId: "eve-channels-id", nick: "eve",
    channels, directs: [], contacts: [],
    accountDetails: [{ nick: "eve", id: "eve-channels-id" }],
    profile: {}, role: "member", threads: [], channelDetails: [], openChannels: [],
  };
}

test("a channels event refreshes the list only when this tab disagrees", async () => {
  const origin = "https://channel-events.test";
  shims(origin);
  const listeners = new Map<string, (event: { data: string }) => void>();
  (globalThis as any).EventSource = class { addEventListener(name: string, listener: (event: { data: string }) => void) { listeners.set(name, listener); } close() {} };
  const originalFetch = globalThis.fetch;
  let meCalls = 0;
  let channels = ["#dev-test"];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/auth/me") { meCalls += 1; return Response.json(authBody(channels)); }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const listed = () => client.ui.channels.map((item: { wireTarget: string }) => item.wireTarget);
  try {
    await client.connect();
    expect(listed()).toEqual(["#dev-test"]);
    const before = meCalls;

    // Made on the phone: the desktop picks it up.
    channels = ["#dev-test", "#phone-made"];
    listeners.get("channels")!({ data: JSON.stringify({ channel: "#phone-made", member: true }) });
    await settle();
    expect(meCalls).toBe(before + 1);
    expect(listed()).toEqual(["#dev-test", "#phone-made"]);

    // Already known, or malformed: nothing to do.
    listeners.get("channels")!({ data: JSON.stringify({ channel: "#PHONE-MADE", member: true }) });
    listeners.get("channels")!({ data: JSON.stringify({ channel: "#gone", member: false }) });
    listeners.get("channels")!({ data: JSON.stringify({ channel: "#phone-made" }) });
    listeners.get("channels")!({ data: "not json" });
    await settle();
    expect(meCalls).toBe(before + 1);

    // Left elsewhere: it drops out here too.
    channels = ["#dev-test"];
    listeners.get("channels")!({ data: JSON.stringify({ channel: "#phone-made", member: false }) });
    await settle();
    expect(meCalls).toBe(before + 2);
    expect(listed()).toEqual(["#dev-test"]);
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

// The tab that made the change is mid-refresh when its own event lands. The event waits for that
// refresh instead of superseding it, so the caller still sees fresh access and no second read runs.
test("a channels event during a refresh waits for it", async () => {
  const origin = "https://channel-events-wait.test";
  shims(origin);
  const listeners = new Map<string, (event: { data: string }) => void>();
  (globalThis as any).EventSource = class { addEventListener(name: string, listener: (event: { data: string }) => void) { listeners.set(name, listener); } close() {} };
  const originalFetch = globalThis.fetch;
  let meCalls = 0;
  let channels = ["#dev-test"];
  let hold: (() => void) | null = null;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/auth/me") {
      meCalls += 1;
      const body = authBody(channels);
      if (hold === null && meCalls > 1) await new Promise<void>((resolve) => { hold = resolve; });
      return Response.json(body);
    }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  try {
    await client.connect();
    channels = ["#dev-test", "#made-here"];
    const own = client.connect();
    await settle();
    listeners.get("channels")!({ data: JSON.stringify({ channel: "#made-here", member: true }) });
    await settle();
    (hold as unknown as () => void)();
    await own;
    await settle();
    expect(client.ui.channels.map((item: { wireTarget: string }) => item.wireTarget)).toEqual(["#dev-test", "#made-here"]);
    expect(meCalls).toBe(2);
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);
