// Real single-call thread creation (POST /api/threads without `channel`): the server provisions the
// Ergo child and every SQLite row before it answers, idempotently per (parent, root), and fails
// closed when the caller's parent access is gone or a helper fails.
import "./fixture.ts";

import { beforeEach, describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { createDirectConversation } = await import("../src/rooms.ts");
const { createThread, THREAD_NAME } = await import("../src/threads.ts");

type CreateCall = { channel: string; owner: string; visibility: string; members: string[] };
type ThreadDeps = {
  channelExists: (channel: string) => Promise<boolean>;
  createThreadChannel: (channel: string, owner: string, visibility: "workspace" | "secret", members: string[]) => Promise<void>;
  unregisterChannel: (channel: string) => Promise<void>;
};

function fakeDeps(overrides: Partial<ThreadDeps> = {}) {
  const calls = { exists: [] as string[], create: [] as CreateCall[], unregister: [] as string[] };
  const deps: ThreadDeps = {
    channelExists: async (channel: string) => { calls.exists.push(channel); return false; },
    createThreadChannel: async (channel, owner, visibility, members) => { calls.create.push({ channel, owner, visibility, members }); },
    unregisterChannel: async (channel) => { calls.unregister.push(channel); },
    ...overrides,
  };
  return { calls, deps };
}

const channelsOf = (channel: string) => db.query("SELECT channel, owner, visibility FROM channels WHERE channel = ?").get(channel) as { channel: string; owner: string; visibility: string } | null;
const membersOf = (channel: string) => (db.query("SELECT nick FROM channel_members WHERE channel = ? ORDER BY nick").all(channel) as { nick: string }[]).map((row) => row.nick);

beforeEach(() => {
  db.query("DELETE FROM threads").run();
  db.query("DELETE FROM channel_members").run();
  db.query("DELETE FROM channels").run();
  db.query("DELETE FROM direct_conversations").run();
  db.query("DELETE FROM meta WHERE key LIKE 'thread-provision:%'").run();
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#room', 'eve', 'secret', 1), ('#work', 'eve', 'workspace', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#room', 'eve'), ('#room', 'frank'), ('#work', 'eve')").run();
});

describe("single-call thread creation", () => {
  test("a public parent gets a workspace child and no secret grants", async () => {
    const { deps, calls } = fakeDeps();
    const result = await createThread("eve", { parent: "#help", root: "root-1", title: "  Hello   world " }, deps);
    expect(result.status).toBe(201);
    const channel = result.thread!.channel;
    expect(channel).toMatch(THREAD_NAME);
    expect(result.thread!.parent).toBe("#help");
    expect(result.thread!.title).toBe("Hello world");
    expect(result.thread!.createdBy).toBe("eve");
    expect(calls.create).toEqual([{ channel, owner: "eve", visibility: "workspace", members: ["eve"] }]);
    expect(channelsOf(channel)).toEqual({ channel, owner: "eve", visibility: "workspace" });
    expect(membersOf(channel)).toEqual(["eve"]);
  });

  test("a workspace parent gets a workspace child", async () => {
    const { deps, calls } = fakeDeps();
    const result = await createThread("eve", { parent: "#work", root: "root-2", title: "Work thread" }, deps);
    expect(result.status).toBe(201);
    expect(calls.create[0].visibility).toBe("workspace");
  });

  test("a secret parent gets a secret child granted to all parent members", async () => {
    const { deps, calls } = fakeDeps();
    const result = await createThread("eve", { parent: "#room", root: "root-3", title: "Private" }, deps);
    expect(result.status).toBe(201);
    const channel = result.thread!.channel;
    expect(calls.create).toEqual([{ channel, owner: "eve", visibility: "secret", members: ["eve", "frank"] }]);
    expect(channelsOf(channel)!.visibility).toBe("secret");
    expect(membersOf(channel)).toEqual(["eve", "frank"]);
  });

  test("a DM display nick resolves through the stored mapping and grants both people", async () => {
    const direct = createDirectConversation("eve", "bob", "eve");
    const { deps, calls } = fakeDeps();
    const result = await createThread("eve", { parent: "bob", root: "root-4", title: "DM thread" }, deps);
    expect(result.status).toBe(201);
    const channel = result.thread!.channel;
    expect(result.thread!.parent).toBe(direct.channel);
    expect(calls.create[0].visibility).toBe("secret");
    expect(new Set(calls.create[0].members)).toEqual(new Set(["eve", "bob"]));
  });

  test("a name that already has an IRC channel is never adopted", async () => {
    const { deps, calls } = fakeDeps();
    let first = true;
    deps.channelExists = async (channel: string) => { calls.exists.push(channel); const taken = first; first = false; return taken; };
    const result = await createThread("eve", { parent: "#room", root: "root-12", title: "Collide" }, deps);
    expect(result.status).toBe(201);
    expect(calls.exists).toHaveLength(2);
    expect(calls.create[0].channel).toBe(calls.exists[1]);
    expect(calls.create[0].channel).not.toBe(calls.exists[0]);
  });

  test("retrying the same parent/root returns the row without provisioning again", async () => {
    const { deps, calls } = fakeDeps();
    const first = await createThread("eve", { parent: "#room", root: "root-5", title: "Once" }, deps);
    const second = await createThread("frank", { parent: "#room", root: "root-5", title: "Once" }, deps);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.thread!.channel).toBe(first.thread!.channel);
    expect(calls.create).toHaveLength(1);
  });

  test("two simultaneous requests create one child", async () => {
    const { deps, calls } = fakeDeps();
    const [a, b] = await Promise.all([
      createThread("eve", { parent: "#room", root: "root-6", title: "Race" }, deps),
      createThread("frank", { parent: "#room", root: "root-6", title: "Race" }, deps),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.thread!.channel).toBe(b.thread!.channel);
    expect(calls.create).toHaveLength(1);
    expect((db.query("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count).toBe(1);
  });

  test("the provisioning limiter is charged once, not on an idempotent retry", async () => {
    const { deps, calls } = fakeDeps();
    let reserved = 0;
    const reserve = () => { reserved += 1; return true; };
    const first = await createThread("eve", { parent: "#room", root: "root-13", title: "Once" }, deps, reserve);
    const second = await createThread("eve", { parent: "#room", root: "root-13", title: "Once" }, deps, reserve);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(reserved).toBe(1);
    expect(calls.create).toHaveLength(1);
    const denied = await createThread("eve", { parent: "#room", root: "root-14", title: "Two" }, deps, () => false);
    expect(denied.status).toBe(429);
  });

  test("a non-member, a thread channel, and a DM wire channel are refused", async () => {
    const { deps, calls } = fakeDeps();
    expect((await createThread("mallory", { parent: "#room", root: "r", title: "t" }, deps)).status).toBe(403);
    expect((await createThread("eve", { parent: "#t-abcd12", root: "r", title: "t" }, deps)).status).toBe(404);
    expect((await createThread("eve", { parent: "#dm-eve-bob", root: "r", title: "t" }, deps)).status).toBe(404);
    expect((await createThread("eve", { parent: "#nosuch", root: "r", title: "t" }, deps)).status).toBe(404);
    expect(calls.create).toHaveLength(0);
  });

  test("revoked parent access during provisioning aborts and cleans up", async () => {
    const base = fakeDeps();
    const deps: ThreadDeps = {
      ...base.deps,
      createThreadChannel: async (channel, owner, visibility, members) => {
        base.calls.create.push({ channel, owner, visibility, members });
        db.query("DELETE FROM channel_members WHERE channel = '#room' AND nick = 'eve'").run();
      },
    };
    const result = await createThread("eve", { parent: "#room", root: "root-7", title: "Revoked" }, deps);
    expect(result.status).toBe(403);
    const channel = base.calls.create[0].channel;
    expect(base.calls.unregister).toEqual([channel]);
    expect(channelsOf(channel)).toBeNull();
    expect((db.query("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count).toBe(0);
  });

  test("a helper failure after channel creation unregisters the child and reports no success", async () => {
    const { deps, calls } = fakeDeps({ createThreadChannel: async () => { throw Object.assign(new Error("TRANSFER failed"), { registered: true }); } });
    const result = await createThread("eve", { parent: "#room", root: "root-8", title: "Fail" }, deps);
    expect(result.status).toBe(500);
    expect(calls.unregister).toEqual([calls.exists[0]]);
    expect((db.query("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM channels WHERE channel LIKE '#t-%'").get() as { count: number }).count).toBe(0);
  });

  test("an 'already registered' refusal is not adopted or unregistered", async () => {
    const { deps, calls } = fakeDeps({ createThreadChannel: async () => { throw Object.assign(new Error("already registered"), { registered: false }); } });
    const result = await createThread("eve", { parent: "#room", root: "root-15", title: "Taken" }, deps);
    expect(result.status).toBe(500);
    expect(calls.unregister).toEqual([]);
  });

  test("a failure inside the real create helper is not cleaned up as if we owned the channel", async () => {
    // The injected helper throws before it resolves, so the operation cannot claim the channel was
    // created; the fake's own unregister is never called.
    const { deps, calls } = fakeDeps({ createThreadChannel: async () => { throw new Error("REGISTER failed"); } });
    const result = await createThread("eve", { parent: "#room", root: "root-9", title: "Fail" }, deps);
    expect(result.status).toBe(500);
    expect(calls.unregister).toEqual([]);
  });

  test("a legacy metadata-only row under the same root fails closed", async () => {
    db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-legacy', '#room', 'root-10', 'Legacy', '', 'eve', 1, 1)").run();
    const { deps, calls } = fakeDeps();
    const result = await createThread("eve", { parent: "#room", root: "root-10", title: "Retry" }, deps);
    expect(result.status).toBe(403);
    expect(result.error).toBe("thread not found");
    expect(calls.create).toHaveLength(0);
  });

  test("two rows for one parent/root are contaminated and refused", async () => {
    db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-aaaaaa', '#room', 'root-11', 'A', '', 'eve', 1, 1), ('#t-bbbbbb', '#room', 'root-11', 'B', '', 'eve', 1, 1)").run();
    const { deps } = fakeDeps();
    const result = await createThread("eve", { parent: "#room", root: "root-11", title: "x" }, deps);
    expect(result.status).toBe(409);
  });

  test("a canonical #dm-* wire parent resolves through the mapping", async () => {
    const direct = createDirectConversation("eve", "bob", "eve");
    const { deps, calls } = fakeDeps();
    const result = await createThread("eve", { parent: direct.channel, root: "root-wire", title: "Wire DM" }, deps);
    expect(result.status).toBe(201);
    expect(result.thread!.parent).toBe(direct.channel);
    expect(calls.create[0].visibility).toBe("secret");
    expect(new Set(calls.create[0].members)).toEqual(new Set(["eve", "bob"]));
  });

  test("a foreign or unknown #dm-* parent is denied without provisioning", async () => {
    createDirectConversation("eve", "bob", "eve");
    const foreign = createDirectConversation("carol", "dave", "carol");
    const { deps, calls } = fakeDeps();
    expect((await createThread("eve", { parent: foreign.channel, root: "r", title: "t" }, deps)).status).toBe(404);
    expect((await createThread("eve", { parent: "#dm-nobody", root: "r", title: "t" }, deps)).status).toBe(404);
    expect(calls.create).toHaveLength(0);
    expect(calls.exists).toHaveLength(0);
  });

  test("a contaminated #dm-* mapping is denied, not echoed", async () => {
    const direct = createDirectConversation("eve", "bob", "eve");
    db.query("INSERT INTO channel_members (channel, nick) VALUES (?, 'mallory')").run(direct.channel);
    const { deps, calls } = fakeDeps();
    expect((await createThread("eve", { parent: direct.channel, root: "r", title: "t" }, deps)).status).toBe(404);
    expect(calls.create).toHaveLength(0);
  });

  test("a caller queued behind a creation cannot get a workspace child after losing the parent", async () => {
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#work', 'frank')").run();
    const { deps, calls } = fakeDeps();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const startedWatch = new Promise<void>((resolve) => { started = resolve; });
    const slowDeps: ThreadDeps = {
      ...deps,
      createThreadChannel: async (channel, owner, visibility, members) => { calls.create.push({ channel, owner, visibility, members }); started(); await gate; },
    };
    const eve = createThread("eve", { parent: "#work", root: "root-queue", title: "Queued" }, slowDeps);
    await startedWatch;
    db.query("DELETE FROM channel_members WHERE channel = '#work' AND nick = 'frank'").run();
    const frank = createThread("frank", { parent: "#work", root: "root-queue", title: "Queued" }, slowDeps);
    release();
    const [a, b] = await Promise.all([eve, frank]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(403);
  });

  test("a DM retargeted during provisioning does not get a child under the stale parent", async () => {
    const direct = createDirectConversation("eve", "bob", "eve");
    const base = fakeDeps();
    const deps: ThreadDeps = {
      ...base.deps,
      createThreadChannel: async (channel, owner, visibility, members) => {
        base.calls.create.push({ channel, owner, visibility, members });
        db.query("UPDATE direct_conversations SET channel = '#dm-other' WHERE channel = ?").run(direct.channel);
      },
    };
    const result = await createThread("eve", { parent: direct.channel, root: "root-retarget", title: "Retarget" }, deps);
    expect(result.status).toBe(403);
    expect(base.calls.unregister).toEqual([base.calls.create[0].channel]);
  });

  test("a member revoked while provisioning fails closed and tears the child down", async () => {
    const base = fakeDeps();
    const deps: ThreadDeps = {
      ...base.deps,
      createThreadChannel: async (channel, owner, visibility, members) => {
        base.calls.create.push({ channel, owner, visibility, members });
        db.query("DELETE FROM channel_members WHERE channel = '#room' AND nick = 'frank'").run();
      },
    };
    const result = await createThread("eve", { parent: "#room", root: "root-drift", title: "Drift" }, deps);
    expect(result.status).toBe(409);
    expect(base.calls.unregister).toEqual([base.calls.create[0].channel]);
    expect((db.query("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count).toBe(0);
  });

  test("an uncertain helper failure keeps a reservation and blocks a second orphan", async () => {
    let attempts = 0;
    const { deps, calls } = fakeDeps({ createThreadChannel: async () => { attempts += 1; throw Object.assign(new Error("timeout"), { uncertain: true }); } });
    const first = await createThread("eve", { parent: "#room", root: "root-unc", title: "Unc" }, deps);
    expect(first.status).toBe(503);
    const reserved = (db.query("SELECT value FROM meta WHERE key LIKE 'thread-provision:%root-unc'").get() as { value: string } | null)?.value;
    expect(reserved).toBeTruthy();
    deps.channelExists = async (channel: string) => { calls.exists.push(channel); return channel === reserved; };
    const second = await createThread("eve", { parent: "#room", root: "root-unc", title: "Unc" }, deps);
    expect(second.status).toBe(503);
    expect(attempts).toBe(1);
  });

  test("a definite failure clears the reservation so a retry can mint a fresh child", async () => {
    const { deps } = fakeDeps({ createThreadChannel: async () => { throw Object.assign(new Error("nope"), { registered: false, uncertain: false }); } });
    expect((await createThread("eve", { parent: "#room", root: "root-def", title: "D" }, deps)).status).toBe(500);
    expect(db.query("SELECT 1 FROM meta WHERE key LIKE 'thread-provision:%root-def'").get()).toBeNull();
    expect((await createThread("eve", { parent: "#room", root: "root-def", title: "D" }, deps)).status).toBe(500);
  });

  test("an unregister failure keeps the reservation and does not claim cleanup", async () => {
    const { deps } = fakeDeps({
      createThreadChannel: async () => { throw Object.assign(new Error("transfer failed"), { registered: true, uncertain: false }); },
      unregisterChannel: async () => { throw new Error("unregister failed"); },
    });
    const result = await createThread("eve", { parent: "#room", root: "root-unreg", title: "U" }, deps);
    expect(result.status).toBe(503);
    expect(db.query("SELECT 1 FROM meta WHERE key LIKE 'thread-provision:%root-unreg'").get()).not.toBeNull();
  });

  test("root and title are validated before any provisioning", async () => {
    const { deps, calls } = fakeDeps();
    expect((await createThread("eve", { parent: "#room", title: "no root" }, deps)).status).toBe(400);
    expect((await createThread("eve", { parent: "#room", root: "r" }, deps)).status).toBe(400);
    expect((await createThread("eve", { parent: "#room", root: "a".repeat(513), title: "t" }, deps)).status).toBe(400);
    expect((await createThread("eve", { parent: "#room", root: "bad\nroot", title: "t" }, deps)).status).toBe(400);
    expect(calls.create).toHaveLength(0);
    expect(calls.exists).toHaveLength(0);
  });
});
