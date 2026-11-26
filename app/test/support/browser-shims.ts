// Browser globals for tests that run the real client runtime in Bun. Nothing connects: sockets and
// event sources do nothing unless a test passes its own classes. One call per test file.
export interface BrowserShimOptions {
  /** Page address, e.g. "https://unread.test/dm/ada". */
  url?: string;
  origin?: string;
  path?: string;
  width?: number;
  height?: number;
  userAgent?: string;
  EventSource?: unknown;
  WebSocket?: unknown;
  /** Replaces globalThis.fetch when given. */
  fetch?: unknown;
}

export function installBrowserShims(options: BrowserShimOptions = {}): { classes: Set<string>; storage: Map<string, string> } {
  const location = new URL(options.url ?? `${options.origin ?? "https://shim.test"}${options.path ?? "/"}`);
  const storage = new Map<string, string>();
  const classes = new Set<string>();
  const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const history = { state: null, replaceState() {}, pushState() {} };
  Object.assign(globalThis, {
    location, history, matchMedia: media,
    window: Object.assign(new EventTarget(), { location, history, matchMedia: media, innerWidth: options.width ?? 1280, innerHeight: options.height ?? 900 }),
    document: Object.assign(new EventTarget(), {
      title: "Slirc", cookie: "", hidden: false, visibilityState: "visible", hasFocus: () => true,
      documentElement: {
        classList: { add: (name: string) => classes.add(name), toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name) },
        style: { setProperty() {} },
      },
      body: { classList: { toggle() {}, add() {}, remove() {} } }, querySelector: () => null, querySelectorAll: () => [],
    }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    EventSource: options.EventSource ?? class { addEventListener() {} close() {} },
    WebSocket: options.WebSocket ?? class { static OPEN = 1; readyState = 0; close() {} send() {} },
  });
  Object.assign(window, { requestAnimationFrame, cancelAnimationFrame, localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true, userAgent: options.userAgent ?? "runtime-test" } });
  if (options.fetch) globalThis.fetch = options.fetch as typeof fetch;
  return { classes, storage };
}
