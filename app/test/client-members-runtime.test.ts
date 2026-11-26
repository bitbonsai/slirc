// Real createClient runtime shim for the members rail lifecycle: the authorized fetch, and the
// request-generation guard against disconnect, revocation and A->B->A races. Browser APIs are shims;
// this is not a visible-control or real IRC acceptance test. One file per process.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";

type MemberCall = { channel: string; resolve: (body: unknown, status?: number) => void; reject: (error: unknown) => void };
const memberCalls: MemberCall[] = [];
const sockets: any[] = [];
let channels = ["#dev-test"];
let openChannels: string[] = [];
let channelDetails: unknown[] = [];

const rows = (channel: string, nicks: string[]) => ({ channel, owner: nicks[0] ?? null, members: nicks.map((nick) => ({ nick, kind: "human", role: "member", machine: null, availability: "", badge: "" })) });

function installShims(): void {
  const location = new URL("https://members-runtime.test/");
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

function meBody(): unknown {
  return {
    authenticated: true, account: "alice", accountId: "acct-1", channels,
    openChannels,
    channelDetails,
    directs: [{ nick: "bob", channel: "#dm-alice-bob" }],
    accountDetails: [
      { nick: "alice", id: "acct-1", kind: "human", owner: null, availability: "", badge: "available" },
      { nick: "bob", id: "bob-id", kind: "human", owner: null, availability: "", badge: "available", avatarVersion: 11 },
    ],
    profile: {},
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; memberCalls.length = 0; sockets.length = 0; });

async function boot(list: string[], open: string[] = [], details: unknown[] = []) {
  channels = list;
  openChannels = open;
  channelDetails = details;
  installShims();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/auth/me") return Response.json(meBody());
    if (url.includes("/members")) {
      const channel = decodeURIComponent(url.match(/channels\/([^/]+)\/members/)?.[1] ?? "");
      return await new Promise<Response>((resolve, reject) => { memberCalls.push({ channel, resolve: (body, status = 200) => resolve(Response.json(body, { status })), reject }); });
    }
    return Response.json({});
  }) as typeof fetch;
  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  return client;
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const resolveMember = (index: number, body: unknown, status = 200) => memberCalls[index]!.resolve(body, status);
const nicks = (client: Awaited<ReturnType<typeof boot>>) => client.ui.roomMemberRows.map((row) => row.nick);

test("an authorized room loads its members through the runtime", async () => {
  const client = await boot(["#dev-test"]);
  try {
    await client.connect(); await settle();
    expect(client.ui.members.canShow()).toBe(true);
    expect(memberCalls).toHaveLength(1);
    expect(memberCalls[0]!.channel).toBe("#dev-test");
    resolveMember(0, rows("#dev-test", ["alice", "bob"])); await settle();
    expect(nicks(client)).toEqual(["alice", "bob"]);
  } finally { client.ui.destroy(); }
});

test("other people's avatars use the version from account details and member rows", async () => {
  const client = await boot(["#dev-test"]);
  try {
    await client.connect(); await settle();
    expect(client.ui.avatarUrl("Bob")).toBe("/avatars/Bob?v=11");
    expect(client.ui.avatarUrl("carol")).toBe("/avatars/carol");
    const body = rows("#dev-test", ["alice", "bob", "carol"]);
    resolveMember(0, { ...body, members: body.members.map((row) => row.nick === "carol" ? { ...row, avatarVersion: 23 } : row) }); await settle();
    expect(client.ui.avatarUrl("carol")).toBe("/avatars/carol?v=23");
  } finally { client.ui.destroy(); }
});

test("an older same-room reply from an A->B->A navigation is dropped", async () => {
  const client = await boot(["#dev-test", "#other"]);
  try {
    await client.connect(); await settle();
    resolveMember(0, rows("#dev-test", ["alice"])); await settle();
    const base = memberCalls.length;
    client.ui.members.request(); // A1
    client.ui.openRoom("#other"); await settle(); // B
    client.ui.openRoom("#dev-test"); await settle(); // A2
    expect(memberCalls[base]!.channel).toBe("#dev-test");
    expect(memberCalls[base + 1]!.channel).toBe("#other");
    expect(memberCalls[base + 2]!.channel).toBe("#dev-test");
    resolveMember(base + 1, rows("#other", ["alice", "bob"])); await settle(); // B reply, no longer current
    resolveMember(base + 2, rows("#dev-test", ["alice", "carol"])); await settle(); // newest A
    resolveMember(base, rows("#dev-test", ["alice", "stale"])); await settle(); // older A -> dropped
    expect(nicks(client)).toEqual(["alice", "carol"]);
  } finally { client.ui.destroy(); }
});

test("a member fetch that times out stops loading and offers a retry", async () => {
  const client = await boot(["#dev-test"]);
  try {
    await client.connect(); await settle();
    expect(client.ui.roomMembersLoading).toBe(true);
    memberCalls[0]!.reject(new DOMException("The operation timed out.", "TimeoutError")); await settle();
    expect(client.ui.roomMembersLoading).toBe(false);
    expect(client.ui.members.error()).toBe("Members took too long to load.");
    client.ui.members.request(); await settle();
    resolveMember(1, rows("#dev-test", ["alice", "bob"])); await settle();
    expect(nicks(client)).toEqual(["alice", "bob"]);
    expect(client.ui.members.error()).toBe("");
  } finally { client.ui.destroy(); }
});

test("a delayed reply after a socket disconnect cannot repopulate the rail", async () => {
  const client = await boot(["#dev-test"]);
  try {
    await client.connect(); await settle();
    resolveMember(0, rows("#dev-test", ["alice"])); await settle();
    const base = memberCalls.length;
    client.ui.members.request(); await settle(); // pending on a later generation
    sockets.at(-1)?.onclose?.(); await settle(); // socket drops: rows cleared, generation bumped
    expect(nicks(client)).toEqual([]);
    resolveMember(base, rows("#dev-test", ["alice", "stale"])); await settle();
    expect(nicks(client)).toEqual([]);
    expect(client.ui.roomMembersError).toBe("");
  } finally { client.ui.destroy(); }
});

test("a newer same-room reply wins over an older one, for success and error", async () => {
  const client = await boot(["#dev-test"]);
  try {
    await client.connect(); await settle();
    resolveMember(0, rows("#dev-test", ["alice"])); await settle();
    let base = memberCalls.length;
    client.ui.members.request(); // newer
    client.ui.members.request(); // newest
    resolveMember(base + 1, rows("#dev-test", ["alice", "bob"])); await settle(); // newest succeeds
    resolveMember(base, { error: "stale failure" }, 502); await settle(); // older failure must not win
    expect(nicks(client)).toEqual(["alice", "bob"]);
    expect(client.ui.roomMembersError).toBe("");

    base = memberCalls.length;
    client.ui.members.request(); // older
    client.ui.members.request(); // newest, will fail
    resolveMember(base + 1, { error: "fresh failure" }, 502); await settle();
    resolveMember(base, rows("#dev-test", ["alice", "carol"])); await settle(); // older success must not win
    expect(client.ui.roomMembersError).toBe("fresh failure");
    expect(nicks(client)).toEqual([]);
  } finally { client.ui.destroy(); }
});

test("open/secret icons come from /auth/me metadata before any member fetch", async () => {
  const client = await boot(["#dev-open", "#dev-test"], ["#dev-open"], [{ channel: "#dev-test", owner: "alice", visibility: "secret", topic: "", isGroup: false }]);
  try {
    await client.connect(); await settle();
    expect(client.ui.isOpenRoom("#dev-open")).toBe(true); // configured open, no SQLite channel row
    expect(client.ui.isOpenRoom("#dev-test")).toBe(false); // secret stays locked
    const base = memberCalls.length;
    client.ui.openRoom("#dev-open"); await settle();
    resolveMember(base, { channel: "#dev-open", owner: null, public: true, members: [] }); await settle();
    expect(client.ui.isOpenRoom("#dev-open")).toBe(true); // a member fetch never flips visibility
    expect(client.ui.isOpenRoom("#dev-test")).toBe(false);
    // A refreshed /auth/me without the open list removes the stale marking.
    openChannels = [];
    await client.connect(); await settle();
    expect(client.ui.isOpenRoom("#dev-open")).toBe(false);
  } finally { client.ui.destroy(); }
});

test("the members toggle hides in configured open channels and shows in workspace and secret rooms", async () => {
  const client = await boot(["#dev-open", "#work", "#dev-test"], ["#dev-open"], [
    { channel: "#work", owner: "alice", visibility: "workspace", topic: "", isGroup: false },
    { channel: "#dev-test", owner: "alice", visibility: "secret", topic: "", isGroup: false },
  ]);
  try {
    await client.connect(); await settle();
    client.ui.openRoom("#dev-open"); await settle();
    expect(client.ui.members.canShow()).toBe(false);
    client.ui.members.toggle();
    expect(client.ui.members.open).toBe(false);
    client.ui.openRoom("#work"); await settle();
    expect(client.ui.members.canShow()).toBe(true);
    client.ui.openRoom("#dev-test"); await settle();
    expect(client.ui.members.canShow()).toBe(true);
  } finally { client.ui.destroy(); }
});

test("a workspace channel reads open from channelDetails, and a visibility change updates it", async () => {
  const client = await boot(["#work"], [], [{ channel: "#work", owner: "alice", visibility: "workspace", topic: "", isGroup: false }]);
  try {
    await client.connect(); await settle();
    expect(client.ui.isOpenRoom("#work")).toBe(true);
    client.ui.channelDetails = client.ui.channelDetails.map((detail: any) => detail.channel === "#work" ? { ...detail, visibility: "secret" } : detail);
    expect(client.ui.isOpenRoom("#work")).toBe(false);
  } finally { client.ui.destroy(); }
});

test("a stored secret channel stays locked even when the configured open list names it", async () => {
  const client = await boot(["#dev-open", "#dev-test"], ["#dev-open", "#dev-test"], [{ channel: "#dev-test", owner: "alice", visibility: "secret", topic: "", isGroup: false }]);
  try {
    await client.connect(); await settle();
    expect(client.ui.isOpenRoom("#dev-test")).toBe(false); // row says secret; the open list cannot override it
    expect(client.ui.isOpenRoom("#dev-open")).toBe(true); // no row, configured open
    // Only a settings change (channelDetails update) opens it.
    client.ui.channelDetails = client.ui.channelDetails.map((detail: any) => detail.channel === "#dev-test" ? { ...detail, visibility: "workspace" } : detail);
    expect(client.ui.isOpenRoom("#dev-test")).toBe(true);
  } finally { client.ui.destroy(); }
});

test("the header drops the # for a private channel and keeps it for an open one", async () => {
  const client = await boot(["#dev-test", "#dev-open"], ["#dev-open"]);
  const ui = client.ui as any;
  try {
    await client.connect(); await settle();
    Object.assign(ui, { direct: false, notesOpen: false, activeThread: null, channel: "#dev-test", roomLabel: "#dev-test" });
    expect(ui.headerTitle()).toBe("dev-test");
    Object.assign(ui, { channel: "#dev-open", roomLabel: "#dev-open" });
    expect(ui.headerTitle()).toBe("#dev-open");
    Object.assign(ui, { channel: "#dev-test", roomLabel: "#release", activeThread: { title: "#release" } });
    expect(ui.headerTitle()).toBe("#release");
  } finally { client.ui.destroy(); }
});
