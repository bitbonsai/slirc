// Exercise the real runtime's denied -> first account scope -> invitation destination transition.
// Browser APIs are shims; this is not a visible-control or real IRC acceptance test.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

test("a zero-conversation invitee reaches the accepted DM through real runtime connect", async () => {
  const location = new URL("https://invitation-runtime.test/join/test-token");
  const storage = new Map<string, string>();
  const classes = new Set<string>();
  const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const history = { state: null, replaceState() {}, pushState() {} };
  Object.assign(globalThis, {
    location, history, matchMedia: media,
    window: Object.assign(new EventTarget(), { location, history, matchMedia: media, innerWidth: 1280, innerHeight: 900 }),
    document: Object.assign(new EventTarget(), {
      cookie: "", visibilityState: "visible", hasFocus: () => true,
      documentElement: { classList: { add: (name: string) => classes.add(name), toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name) }, style: { setProperty() {} } },
      body: { classList: { toggle() {} } }, querySelector: () => null, querySelectorAll: () => [],
    }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    EventSource: class { addEventListener() {} close() {} },
    WebSocket: class { static OPEN = 1; readyState = 0; close() {} send() {} },
  });
  Object.assign(window, { requestAnimationFrame, cancelAnimationFrame, localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true, userAgent: "runtime-test" } });
  const originalFetch = globalThis.fetch;
  let accepted = false;
  let authReads = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${init?.method || "GET"} ${path}`);
    if (path === "/auth/me") {
      authReads++;
      return Response.json({ authenticated: true, account: "invitee", accountId: "invite-runtime-account", channels: [],
        directs: accepted ? [{ nick: "inviter", channel: "#dm-invitee-inviter" }] : [],
        accountDetails: [{ nick: "inviter", id: "inviter-id" }], profile: {} });
    }
    if (path === "/api/join/test-token") {
      if (init?.method === "POST") {
        accepted = true;
        return Response.json({ type: "direct", nick: "inviter", channel: "#dm-invitee-inviter", accepted: true });
      }
      return Response.json({ destination: { type: "dm", channel: null }, requiresVerifiedEmail: true });
    }
    return Response.json({});
  }) as typeof fetch;
  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    await client.invitationAccept.start("test-token");
    expect(client.ui.authenticated).toBe(true);
    expect(client.ui.phase).toBe("denied");
    expect(client.ui.joinRoute).toBe(true);
    expect(client.ui.directs).toHaveLength(0);
    await client.invitationAccept.accept();
    expect(authReads).toBe(2);
    expect(client.invitationAccept.acceptError).toBe("");
    expect(client.invitationAccept.busy).toBe(false);
    expect(client.ui.joinRoute).toBe(false);
    expect(client.ui.direct).toBe(true);
    expect(client.ui.channel).toBe("inviter");
    expect(calls.filter((call) => call === "POST /api/join/test-token")).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("POST /api/dms/"))).toBe(false);
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);
