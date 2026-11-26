// Real createClient runtime shim for reaction-button readiness. Alpine re-runs a :disabled binding
// only when a reactive value it read changes, so the shim records reads and the test checks that
// the open room turning ready changes one of them. Browser APIs are shims. One file per process.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";

const sockets: any[] = [];
let reads: Array<[object, PropertyKey]> | null = null;

function installShims(): void {
  const location = new URL("https://reactions-ready.test/");
  const storage = new Map<string, string>();
  const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const history = { state: null, replaceState() {}, pushState() {} };
  Object.assign(globalThis, {
    location, history, matchMedia: media,
    window: Object.assign(new EventTarget(), { location, history, matchMedia: media, innerWidth: 1280, innerHeight: 900 }),
    document: Object.assign(new EventTarget(), {
      cookie: "", visibilityState: "visible", hasFocus: () => true,
      documentElement: { classList: { add() {}, toggle() {} }, style: { setProperty() {} } },
      body: { classList: { toggle() {}, add() {}, remove() {} } }, querySelector: () => null, querySelectorAll: () => [],
    }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    EventSource: class { addEventListener() {} close() {} },
    WebSocket: class { static OPEN = 1; readyState = 1; onopen: (() => void) | null = null; onmessage: ((event: unknown) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; constructor() { sockets.push(this); } close() {} send() {} },
  });
  Object.assign(window, { requestAnimationFrame, cancelAnimationFrame, localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true, userAgent: "runtime-test" } });
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; sockets.length = 0; });

async function boot(channels: string[]) {
  installShims();
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/auth/me") return Response.json({ authenticated: true, account: "alice", accountId: "acct-1", channels, directs: [], accountDetails: [], profile: {} });
    return Response.json({});
  }) as typeof fetch;
  const { createClient } = await import("../client/runtime.ts");
  // Stand-in for Alpine.reactive: records which properties a binding read.
  const reactive = (value: object) => new Proxy(value, { get(target, key, receiver) { reads?.push([target, key]); return Reflect.get(target, key, receiver); } });
  return createClient({ reactive, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 20)); };
const feed = (line: string) => sockets.at(-1)!.onmessage({ data: line });
// A self-JOIN echo, then an empty CHATHISTORY page once it is requested: the room turns ready.
async function joinAndSync(target: string, id: string): Promise<void> {
  feed(`:alice!u@h JOIN ${target}\r\n`); await settle();
  feed(`BATCH +${id} chathistory ${target}\r\nBATCH -${id}\r\n`); await settle();
}

// Evaluates like an Alpine effect and returns a check for whether any read value changed since.
function track(evaluate: () => boolean): { value: boolean; rerun: () => boolean } {
  reads = [];
  const value = evaluate();
  const seen = reads.map(([target, key]) => [target, key, (target as any)[key]] as const);
  reads = null;
  return { value, rerun: () => seen.some(([target, key, before]) => !Object.is((target as any)[key], before)) };
}

test("reaction buttons re-enable when the open room turns ready after another room went live", async () => {
  const client = await boot(["#dev-test", "#other"]);
  try {
    await client.connect(); await settle();
    feed(":srv 001 alice :welcome\r\n"); await joinAndSync("#other", "h1");
    expect(client.ui.phase).toBe("live");
    const binding = track(() => client.ui.reactionsReady());
    expect(binding.value).toBe(false);
    await joinAndSync("#dev-test", "h2");
    expect(client.ui.reactionsReady()).toBe(true);
    expect(binding.rerun()).toBe(true);
  } finally { client.ui.destroy(); }
});
