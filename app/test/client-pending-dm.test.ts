// Optimistic first-contact DM acceptance. Browser APIs are shims and the server is a fetch stub;
// this is not a visible-control or real-IRC test. It proves a Contact click opens a pending,
// locally writable conversation at once, that nothing reaches the wire before the server
// authorizes it, and that the pending state survives failure, reload and account switch.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { conversationId } from "../client/model.ts";
import { queuedTextFor } from "../client/drafts.ts";
import type { OutboxLockManager } from "../client/outbox.ts";
import { installBrowserShims } from "./support/browser-shims.ts";

const { ClientDatabase } = await import("../client/db.ts");
const { createOutbox } = await import("../client/outbox.ts");

const databases: ClientDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) { try { await db.delete(); } catch { /* already closed */ } }
});

function openDatabase(accountId: string, origin: string): ClientDatabase {
  const db = new ClientDatabase({ instance: origin, accountId, account: "eve" });
  databases.push(db);
  return db;
}

function shims(origin: string, path = "/", sent: string[] = []): void {
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    close() {}
    send(line: string) { sent.push(line); }
  }
  installBrowserShims({ origin, path, userAgent: "pending-dm-test", WebSocket: Socket });
}

function authBody(accountId: string, direct: boolean, contacts = ["clara"]) {
  const details = [{ nick: "eve", id: accountId }, ...contacts.map((nick) => ({ nick, id: `${nick}-id` }))];
  return {
    authenticated: true, account: "eve", accountId, nick: "eve",
    channels: ["#dev-test"], directs: direct ? [{ nick: "clara", channel: "#dm-clara-eve" }] : [], contacts,
    accountDetails: details,
    profile: {}, role: "member", threads: [], channelDetails: [], openChannels: [],
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a Contact click opens a pending DM at once, queues text locally, and stays on the newer route", async () => {
  const origin = "https://pending-dm.test";
  const sent: string[] = [];
  shims(origin, "/", sent);
  const originalFetch = globalThis.fetch;
  let releasePost: (() => void) | null = null;
  let created = false;
  let posts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method || "GET";
    if (path === "/auth/me") return Response.json(authBody("eve-pending", created));
    if (path === "/api/dms/clara" && method === "POST") {
      posts += 1;
      await new Promise<void>((resolve) => { releasePost = resolve; });
      created = true;
      return Response.json({ channel: "#dm-clara-eve", nick: "clara" });
    }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const dmId = conversationId("dm", "clara-id");
  const seed = openDatabase("eve-pending", origin);
  await seed.drafts.put({ conversationId: dmId, revision: "rev-1", text: "hi clara", updatedAt: Date.now() });
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    expect(client.ui.contacts).toContain("clara");
    expect(client.ui.directs).toHaveLength(0);

    const opening = client.ui.openDirect("clara");
    // Immediate pending view: no wait for the slow createDirectChannel.
    expect(client.ui.direct).toBe(true);
    expect(client.ui.channel).toBe("clara");
    expect(client.ui.pendingDm).toBe(true);
    expect(client.ui.pendingDmState).toBe("provisioning");
    // The row moves out of Contacts into Direct messages right away.
    expect(client.ui.contactList()).not.toContain("clara");
    expect(client.ui.directList().some((row: { pending?: boolean; nick: string }) => row.pending === true && row.nick === "clara")).toBe(true);

    // The durable draft is restored, and sending enqueues locally while the server has not authorized.
    await tick();
    expect(client.ui.composer).toBe("hi clara");
    await client.ui.send();
    const op = await seed.operations.where("conversationId").equals(dmId).first();
    expect(op?.state).toBe("queued");
    expect(await seed.drafts.get(dmId)).toBeUndefined(); // the send consumed its revision
    expect(sent.filter((line) => line.includes("PRIVMSG"))).toHaveLength(0);

    // A newer navigation wins; the finished DM still lands in the list.
    client.ui.openRoom("#dev-test");
    expect(client.ui.direct).toBe(false);
    releasePost!();
    await opening;
    expect(posts).toBe(1);
    expect(client.ui.direct).toBe(false);
    expect(client.ui.pendingDm).toBe(false);
    expect(client.ui.directs.map((item: { nick: string }) => item.nick)).toContain("clara");
    expect(client.ui.contacts).not.toContain("clara");
    // The optimistic local row and operation survive the hand-off.
    expect((await seed.operations.where("conversationId").equals(dmId).first())?.state).toBe("queued");
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

test("a failed first-contact creation keeps the draft and queued message, and retry reuses the pair", async () => {
  const origin = "https://pending-dm-fail.test";
  shims(origin);
  const originalFetch = globalThis.fetch;
  let fail = true;
  let created = false;
  let posts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method || "GET";
    if (path === "/auth/me") return Response.json(authBody("eve-retry", created));
    if (path === "/api/dms/clara" && method === "POST") {
      posts += 1;
      if (fail) return Response.json({ error: "could not start direct message" }, { status: 502 });
      created = true;
      return Response.json({ channel: "#dm-clara-eve", nick: "clara" });
    }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const dmId = conversationId("dm", "clara-id");
  const seed = openDatabase("eve-retry", origin);
  await seed.drafts.put({ conversationId: dmId, revision: "rev-1", text: "keep me", updatedAt: Date.now() });
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    await client.ui.openDirect("clara");
    expect(client.ui.pendingDm).toBe(true);
    expect(client.ui.pendingDmState).toBe("failed");
    expect(client.ui.pendingDmError).toContain("could not start direct message");
    expect(await seed.drafts.get(dmId)).toBeTruthy(); // the draft is never dropped on failure
    await tick();
    await client.ui.send();
    expect((await seed.operations.where("conversationId").equals(dmId).first())?.state).toBe("queued");

    fail = false;
    client.ui.retryPendingDirect();
    await waitFor(() => client.ui.pendingDm === false);
    expect(posts).toBe(2); // idempotent retry of the same pair, no second conversation
    expect(client.ui.directs.map((item: { nick: string }) => item.nick)).toContain("clara");
    expect((await seed.operations.where("conversationId").equals(dmId).first())?.state).toBe("queued");
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

test("a reload on a pending DM route restores the durable draft and queued message", async () => {
  const origin = "https://pending-dm-reload.test";
  shims(origin, "/dm/clara");
  const originalFetch = globalThis.fetch;
  let releasePost: (() => void) | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method || "GET";
    if (path === "/auth/me") return Response.json(authBody("eve-reload", false));
    if (path === "/api/dms/clara" && method === "POST") {
      await new Promise<void>((resolve) => { releasePost = resolve; });
      return Response.json({ channel: "#dm-clara-eve", nick: "clara" });
    }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const dmId = conversationId("dm", "clara-id");
  const seed = openDatabase("eve-reload", origin);
  await seed.drafts.put({ conversationId: dmId, revision: "rev-1", text: "reload draft", updatedAt: Date.now() });
  await seed.queueText(queuedTextFor(dmId, "eve", { text: "queued before reload", revision: "rev-2" }, "op-reload", Date.now()));
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    // The route alone recreates the optimistic conversation and resumes provisioning.
    expect(client.ui.pendingDm).toBe(true);
    expect(client.ui.direct).toBe(true);
    await tick();
    expect(client.ui.composer).toBe("reload draft");
    expect(await seed.messages.get("op-reload")).toBeTruthy();
    expect((await seed.operations.where("conversationId").equals(dmId).first())?.state).toBe("queued");
  } finally {
    releasePost?.();
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

test("a reload on another route restores a pending DM row and its draft label", async () => {
  const origin = "https://pending-dm-list.test";
  shims(origin, "/dms");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/auth/me") return Response.json(authBody("eve-list", false));
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const dmId = conversationId("dm", "clara-id");
  const seed = openDatabase("eve-list", origin);
  await seed.drafts.put({ conversationId: dmId, revision: "rev-list", text: "saved for Clara", updatedAt: Date.now() });
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    await waitFor(() => client.ui.directList().some((row: { conversationId: string; pending?: boolean }) => row.conversationId === dmId && row.pending));
    expect(client.ui.contactList()).not.toContain("clara");
    expect(client.ui.drafts.some((draft: { conversationId: string; label: string }) => draft.conversationId === dmId && draft.label === "clara")).toBe(true);
    expect(client.ui.pendingDm).toBe(false); // the list row is local state, not an authorized open conversation
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

test("an account switch drops pending DM state without leaking the previous account's private contact", async () => {
  const origin = "https://pending-dm-switch.test";
  shims(origin);
  const originalFetch = globalThis.fetch;
  let accountId = "eve-a";
  let contacts = ["clara"];
  let releasePost: (() => void) | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method || "GET";
    if (path === "/auth/me") return Response.json(authBody(accountId, false, contacts));
    if (path === "/api/dms/clara" && method === "POST") {
      await new Promise<void>((resolve) => { releasePost = resolve; });
      return Response.json({ channel: "#dm-clara-eve", nick: "clara" });
    }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect();
    const first = client.ui.openDirect("clara"); // held open: pending while we switch accounts
    expect(client.ui.pendingDm).toBe(true);

    accountId = "eve-b";
    contacts = ["dana"];
    await client.connect();
    expect(client.ui.pendingDm).toBe(false);
    expect(client.ui.directList().some((row: { pending?: boolean }) => row.pending === true)).toBe(false);
    expect(client.ui.contactList()).not.toContain("clara");
    expect(client.ui.contactList()).toContain("dana");

    releasePost!();
    await first; // the superseded request must not reopen or authorize the old scope's DM
    expect(client.ui.directs).toHaveLength(0);
    expect(client.ui.pendingDm).toBe(false);
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

// Minimal exclusive Web Locks: one holder, FIFO waiters.
function fakeLocks(): OutboxLockManager {
  let held = false;
  const waiters: Array<() => void> = [];
  return {
    request(_name, _options, callback) {
      return new Promise<void>((resolve) => {
        const run = () => {
          held = true;
          void Promise.resolve().then(callback).finally(() => {
            held = false;
            waiters.shift()?.();
            resolve();
          });
        };
        if (held) waiters.push(run); else run();
      });
    },
  };
}

test("a queued message for an unauthorized DM is transmitted exactly once when readiness arrives", async () => {
  const origin = "https://pending-dm-outbox.test";
  const db = openDatabase("eve-outbox", origin);
  const sent: string[] = [];
  let ready = false;
  const box = createOutbox({
    db,
    transport: { sendText: (operation) => { sent.push(operation.id); } },
    isReady: () => ready,
    locks: fakeLocks(),
    BroadcastChannelImpl: null,
  });
  try {
    await box.start();
    const dmId = conversationId("dm", "clara-id");
    await box.enqueueText(queuedTextFor(dmId, "eve", { text: "hello", revision: "rev-1" }, "op-1", Date.now()));
    await tick();
    // No server authorization yet: the local queue holds, the wire stays silent.
    expect(sent).toHaveLength(0);
    ready = true;
    await box.notifyReady();
    await tick();
    expect(sent).toEqual(["op-1"]);
    await box.notifyReady();
    await tick();
    expect(sent).toEqual(["op-1"]); // an in-flight op is never re-sent
  } finally {
    box.stop();
  }
}, 5000);
