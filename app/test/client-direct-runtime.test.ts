// Real-runtime acceptance for closing and reopening a DM. Browser APIs are shims and the server
// is a fetch stub; this is not a visible-control or real-IRC test. It proves closed list state can
// reload, then reopen with existing local history intact.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { installBrowserShims } from "./support/browser-shims.ts";

const DM = { nick: "ada", channel: "#dm-ada-eve" };

function shims(origin: string): void {
  installBrowserShims({ origin, userAgent: "direct-runtime-test" });
}

function authBody(accountId: string, direct: boolean) {
  return {
    authenticated: true, account: "eve", accountId, nick: "eve",
    channels: ["#dev-test"], directs: direct ? [DM] : [], contacts: ["ada"],
    accountDetails: [{ nick: "eve", id: accountId }, { nick: "ada", id: "ada-id" }],
    profile: {}, role: "member", threads: [], channelDetails: [], openChannels: [],
  };
}

test("a closed DM stays hidden after reload and reopens with local history intact", async () => {
  const origin = "https://direct-runtime.test";
  shims(origin);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let closed = false;
  let created = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method || "GET";
    calls.push(`${method} ${path}`);
    if (path === "/auth/me") return Response.json(authBody("eve-close-id", created || !closed));
    if (path === "/api/dms/ada" && method === "DELETE") { closed = true; return new Response(null, { status: 204 }); }
    if (path === "/api/dms/ada" && method === "POST") { created = true; return Response.json({ channel: DM.channel, nick: "ada" }); }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const { conversationId } = await import("../client/model.ts");
  const { ClientDatabase } = await import("../client/db.ts");
  const dm = conversationId("dm", "ada-id");
  const seed = new ClientDatabase({ instance: origin, accountId: "eve-close-id", account: "eve" });
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    expect(client.ui.directs.map((item: { nick: string }) => item.nick)).toContain("ada");
    // Confirmed history is local under the immutable peer id and must survive Close DM.
    await seed.messages.add({ id: "old-1", conversationId: dm, authorAccount: "ada", authorNick: "ada", text: "old history", time: new Date().toISOString(), state: "confirmed" });
    expect(client.ui.contacts).not.toContain("ada");

    client.directDelete.directDeleteCandidate = "ada";
    await client.directDelete.closeDirect();
    await client.connect();

    expect(client.ui.directs).toHaveLength(0);
    expect(client.ui.contacts).toContain("ada");
    expect(await seed.messages.where("conversationId").equals(dm).count()).toBe(1);

    await client.ui.openDirect("ada");
    expect(calls).toContain("POST /api/dms/ada");
    expect(client.ui.direct).toBe(true);
    expect(client.ui.channel).toBe("ada");
    expect(await seed.messages.where("conversationId").equals(dm).count()).toBe(1);
  } finally {
    client.ui.destroy();
    await seed.delete();
    globalThis.fetch = originalFetch;
  }
}, 5000);

test("a stale local direct the server no longer authorizes is not reopened from cache", async () => {
  const origin = "https://direct-runtime.test";
  shims(origin);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let created = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method || "GET";
    calls.push(`${method} ${path}`);
    if (path === "/auth/me") return Response.json(authBody("eve-stale-id", created));
    if (path === "/api/dms/ada" && method === "POST") { created = true; return Response.json({ channel: DM.channel, nick: "ada" }); }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    expect(client.ui.directs).toHaveLength(0);
    // A stale local row can remain even when the server no longer authorizes its DM.
    client.ui.directs = [{ nick: "ada", channel: DM.channel }];

    await client.ui.openDirect("ada");
    expect(calls).toContain("POST /api/dms/ada");
    expect(client.ui.direct).toBe(true);
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

// A click on a Contact creates the DM server-side. If the reader navigates somewhere else while
// that POST is still in flight, the newer navigation wins (no yank), but the finished DM must still
// land in the local list, or the Contact lingers until reload. This is the reported no-op: the
// server had the DM, the browser never learned about it.
test("a superseded contact open still refreshes the DM list without stealing navigation", async () => {
  const origin = "https://direct-runtime.test";
  shims(origin);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let releasePost: (() => void) | null = null;
  let created = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method || "GET";
    calls.push(`${method} ${path}`);
    if (path === "/auth/me") return Response.json(authBody("eve-supersede-id", created));
    if (path === "/api/dms/ada" && method === "POST") {
      await new Promise<void>((resolve) => { releasePost = resolve; });
      created = true;
      return Response.json({ channel: DM.channel, nick: "ada" });
    }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    expect(client.ui.contacts).toContain("ada");
    expect(client.ui.directs).toHaveLength(0);
    const pending = client.ui.openDirect("ada");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.ui.directBusy).toBe("ada");
    // The reader switches rooms while the request is in flight; that navigation must win.
    client.ui.openRoom("#dev-test");
    expect(releasePost).not.toBeNull();
    releasePost!();
    await pending;
    expect(calls).toContain("POST /api/dms/ada");
    expect(client.ui.directs.map((item: { nick: string }) => item.nick)).toContain("ada");
    expect(client.ui.contacts).not.toContain("ada");
    // The yank to the new DM was skipped, so the reader stays where they navigated.
    expect(client.ui.direct).toBe(false);
    expect(client.ui.directBusy).toBe("");

    // A repeat click now reuses the authorized DM row instead of creating it again.
    await client.ui.openDirect("ada");
    expect(calls.filter((call) => call === "POST /api/dms/ada")).toHaveLength(1);
    expect(client.ui.direct).toBe(true);
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

// Someone who only posts in #open-chat is not a Contact. A stray tap must not create a DM the other
// side sees, but pressing Message on their card is a deliberate DM and goes to the server gate.
test("an open-channel poster opens a DM only from a deliberate Message press", async () => {
  const origin = "https://direct-runtime.test";
  shims(origin);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let created = false;
  const poster = { nick: "ahmed", channel: "#dm-ahmed-eve" };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method || "GET";
    calls.push(`${method} ${path}`);
    if (path === "/auth/me") return Response.json({
      ...authBody("eve-open-id", false), contacts: [], directs: created ? [poster] : [],
      accountDetails: [{ nick: "eve", id: "eve-open-id" }, ...(created ? [{ nick: "ahmed", id: "ahmed-id" }] : [])],
    });
    if (path === "/api/dms/ahmed" && method === "POST") { created = true; return Response.json(poster); }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    expect(client.ui.contacts).toHaveLength(0);
    await client.ui.openDirect("ahmed");
    expect(calls).not.toContain("POST /api/dms/ahmed");
    expect(client.ui.directs).toHaveLength(0);

    await client.people.messageMention("ahmed");
    expect(calls.filter((call) => call === "POST /api/dms/ahmed")).toHaveLength(1);
    expect(client.ui.directs.map((item: { nick: string }) => item.nick)).toEqual(["ahmed"]);
    expect(client.ui.direct).toBe(true);
    expect(client.ui.channel).toBe("ahmed");
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

// The other person messaged a DM this tab does not hold (closed here, or just started by them). The
// server's `direct` event refreshes the grant so it appears without a reload; a known DM costs nothing.
test("a direct event for a DM this tab does not hold refreshes the grant", async () => {
  const origin = "https://direct-runtime.test";
  shims(origin);
  const listeners = new Map<string, (event: { data: string }) => void>();
  (globalThis as any).EventSource = class { addEventListener(name: string, listener: (event: { data: string }) => void) { listeners.set(name, listener); } close() {} };
  const originalFetch = globalThis.fetch;
  let meCalls = 0;
  let reopened = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/auth/me") { meCalls += 1; return Response.json(authBody("eve-wake-id", reopened)); }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  try {
    await client.connect();
    expect(client.ui.directs).toHaveLength(0);
    expect(listeners.has("direct")).toBe(true);
    const before = meCalls;

    reopened = true;
    listeners.get("direct")!({ data: JSON.stringify({ channel: DM.channel }) });
    await settle();
    expect(meCalls).toBe(before + 1);
    expect(client.ui.directs.map((item: { nick: string }) => item.nick)).toEqual(["ada"]);
    expect(client.ui.contacts).not.toContain("ada");

    listeners.get("direct")!({ data: JSON.stringify({ channel: DM.channel.toUpperCase() }) });
    listeners.get("direct")!({ data: "not json" });
    await settle();
    expect(meCalls).toBe(before + 1);

    // The same stream flips an agent's presence dot; malformed events change nothing.
    listeners.get("agent-presence")!({ data: JSON.stringify({ nick: "Claude-MBP", attached: true }) });
    expect(client.ui.avatarStatus("claude-mbp")).toBe("online");
    listeners.get("agent-presence")!({ data: JSON.stringify({ nick: "claude-mbp", attached: "no" }) });
    expect(client.ui.avatarStatus("claude-mbp")).toBe("online");
    listeners.get("agent-presence")!({ data: JSON.stringify({ nick: "claude-mbp", attached: false }) });
    expect(client.ui.avatarStatus("claude-mbp")).toBe("offline");
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);
