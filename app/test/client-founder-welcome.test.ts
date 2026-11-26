// Client-driven founder welcome drain. Fakes only; proves the claim/echo/uncertain/retry
// lifecycle, plus the stuck-claim, disabled, and account-scope corrections.
import { expect, test } from "bun:test";
import { createFounderWelcome, drainFounderWelcome, type FounderWelcomeDeps } from "../client/founder-welcome.ts";
import { founderWelcomeText } from "../shared/founder-welcome.ts";
import { queuedTextFor } from "../client/drafts.ts";
import { clearsDraft } from "../client/model.ts";

type Job = { id: string; recipientNick: string; state: "pending" | "claimed"; claimId: string | null };
type Op = { state: string; serverId: string | null };

function harness(options: {
  queue?: Job[];
  enabled?: boolean;
  ops?: Record<string, Op>;
  claims?: Record<string, string>;
  claimAvailable?: boolean;
  conversationId?: string | null;
  enqueueError?: Error | null;
  afterEnqueueState?: string;
  releaseThrows?: boolean;
  onRead?: () => void;
} = {}) {
  const calls: string[] = [];
  const delivered: { id: string; claimId: string; msgid: string | null }[] = [];
  const released: string[] = [];
  const dropped: string[] = [];
  const queue = options.queue ?? [];
  const ops = options.ops ?? {};
  const claims = options.claims ?? {};
  const deps: FounderWelcomeDeps = {
    jobs: async () => { calls.push("jobs"); return { enabled: options.enabled !== false, jobs: queue }; },
    claim: async (id) => { calls.push(`claim:${id}`); return options.claimAvailable === false ? null : "claim-1"; },
    delivered: async (id, claimId, msgid) => { calls.push(`delivered:${id}`); delivered.push({ id, claimId, msgid }); if (queue[0]) queue[0].state = "delivered"; },
    release: async (id) => {
      calls.push(`release:${id}`);
      if (options.releaseThrows) throw new Error("release failed");
      released.push(id);
    },
    conversation: async (nick) => {
      calls.push(`conversation:${nick}`);
      return options.conversationId === undefined ? "conv-1" : options.conversationId;
    },
    readOperation: async (opId) => { calls.push(`read:${opId}`); options.onRead?.(); return ops[opId] ?? null; },
    enqueue: async (_conversationId, opId) => {
      calls.push(`enqueue:${opId}`);
      if (options.enqueueError) throw options.enqueueError;
      ops[opId] = { state: options.afterEnqueueState ?? "confirmed", serverId: "m-1" };
    },
    waitOutcome: async (opId) => {
      calls.push(`wait:${opId}`);
      const op = ops[opId];
      if (!op || op.state === "queued" || op.state === "sending") return "timeout";
      return op;
    },
    drop: async (opId) => { calls.push(`drop:${opId}`); dropped.push(opId); delete ops[opId]; },
    readClaim: (jobId) => claims[jobId] ?? null,
    rememberClaim: (jobId, claimId) => { claims[jobId] = claimId; },
    forgetClaim: (jobId) => { delete claims[jobId]; },
    alive: () => true,
  };
  return { deps, calls, delivered, released, dropped, queue, ops, claims };
}

test("the welcome send uses a token revision that cannot clear a real draft", () => {
  const draft = { conversationId: "conv-1", revision: "draft-7", text: "unsent", updatedAt: 1 };
  const send = queuedTextFor("conv-1", "bitbonsai", { text: "welcome", revision: "welcome:fw-job-1" }, "fw-job-1", 1);
  expect(clearsDraft(draft, send)).toBe(false);
  expect(send.operation.id).toBe("fw-job-1");
  expect(send.message.clientId).toBe("fw-job-1");
});

test("an empty queue does only the read", async () => {
  const h = harness();
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual(["jobs"]);
});

test("a pending job claims, opens the real DM, enqueues, and delivers only on the echo", async () => {
  const h = harness({ queue: [{ id: "job-1", recipientNick: "ana", state: "pending", claimId: null }] });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual([
    "jobs",
    "read:fw-job-1",
    "claim:job-1",
    "conversation:ana",
    "enqueue:fw-job-1",
    "wait:fw-job-1",
    "delivered:job-1",
  ]);
  expect(h.delivered[0]).toEqual({ id: "job-1", claimId: "claim-1", msgid: "m-1" });
  // The local claim is cleared once delivery is proven.
  expect(h.claims["job-1"]).toBeUndefined();
});

test("a foreign claim with no local row is never duplicated", async () => {
  const h = harness({
    queue: [{ id: "job-1", recipientNick: "ana", state: "claimed", claimId: "other-device" }],
    claims: { "job-1": "our-claim" },
  });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual(["jobs", "read:fw-job-1"]);
});

test("our own persisted claim with no local row resumes after a crash or failed release", async () => {
  const h = harness({
    queue: [{ id: "job-1", recipientNick: "ana", state: "claimed", claimId: "claim-1" }],
    claims: { "job-1": "claim-1" },
  });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual(["jobs", "read:fw-job-1", "conversation:ana", "enqueue:fw-job-1", "wait:fw-job-1", "delivered:job-1"]);
  expect(h.delivered[0]).toEqual({ id: "job-1", claimId: "claim-1", msgid: "m-1" });
});

test("a failed release keeps the local claim and the next drain resumes", async () => {
  const first = harness({
    queue: [{ id: "job-1", recipientNick: "ana", state: "pending", claimId: null }],
    conversationId: null,
    releaseThrows: true,
  });
  await drainFounderWelcome(first.deps);
  expect(first.delivered).toHaveLength(0);
  expect(first.claims["job-1"]).toBe("claim-1");

  // Server truth after the failed release: still claimed by us. The persisted claim resumes it.
  const second = harness({
    queue: [{ id: "job-1", recipientNick: "ana", state: "claimed", claimId: "claim-1" }],
    claims: { ...first.claims },
  });
  await drainFounderWelcome(second.deps);
  expect(second.delivered).toHaveLength(1);
  expect(second.calls).toContain("enqueue:fw-job-1");
});

test("losing the claim race stops before any enqueue", async () => {
  const h = harness({ queue: [{ id: "job-1", recipientNick: "ana", state: "pending", claimId: null }], claimAvailable: false });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual(["jobs", "read:fw-job-1", "claim:job-1"]);
});

test("an unreachable conversation releases the claim instead of inventing a DM", async () => {
  const h = harness({ queue: [{ id: "job-1", recipientNick: "ana", state: "pending", claimId: null }], conversationId: null });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual(["jobs", "read:fw-job-1", "claim:job-1", "conversation:ana", "release:job-1"]);
  expect(h.delivered).toHaveLength(0);
  expect(h.claims["job-1"]).toBeUndefined();
});

test("an enqueue that wrote nothing releases the claim for a safe retry", async () => {
  const h = harness({
    queue: [{ id: "job-1", recipientNick: "ana", state: "pending", claimId: null }],
    enqueueError: new Error("duplicate local operation"),
  });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toContain("release:job-1");
  expect(h.delivered).toHaveLength(0);
  const retry = harness({ queue: [{ id: "job-1", recipientNick: "ana", state: "pending", claimId: null }] });
  await drainFounderWelcome(retry.deps);
  expect(retry.delivered).toHaveLength(1);
});

test("a resumed local row is not re-enqueued and a confirmed echo delivers it", async () => {
  const h = harness({
    queue: [{ id: "job-1", recipientNick: "ana", state: "claimed", claimId: "claim-1" }],
    ops: { "fw-job-1": { state: "confirmed", serverId: "m-9" } },
  });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual(["jobs", "read:fw-job-1", "delivered:job-1"]);
  expect(h.delivered[0]).toEqual({ id: "job-1", claimId: "claim-1", msgid: "m-9" });
});

test("an uncertain write keeps the claim and is never auto-retried", async () => {
  const h = harness({
    queue: [{ id: "job-1", recipientNick: "ana", state: "claimed", claimId: "claim-1" }],
    ops: { "fw-job-1": { state: "uncertain", serverId: null } },
  });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual(["jobs", "read:fw-job-1"]);
  expect(h.delivered).toHaveLength(0);
  expect(h.released).toHaveLength(0);
});

test("a not-yet-ready conversation times out but keeps the claim", async () => {
  const h = harness({
    queue: [{ id: "job-1", recipientNick: "ana", state: "pending", claimId: null }],
    afterEnqueueState: "queued",
  });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual(["jobs", "read:fw-job-1", "claim:job-1", "conversation:ana", "enqueue:fw-job-1", "wait:fw-job-1"]);
  expect(h.delivered).toHaveLength(0);
  expect(h.released).toHaveLength(0);
});

test("a refused send drops the local row and releases the claim", async () => {
  const h = harness({
    queue: [{ id: "job-1", recipientNick: "ana", state: "pending", claimId: null }],
    afterEnqueueState: "failed",
  });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual([
    "jobs",
    "read:fw-job-1",
    "claim:job-1",
    "conversation:ana",
    "enqueue:fw-job-1",
    "wait:fw-job-1",
    "drop:fw-job-1",
    "release:job-1",
  ]);
  expect(h.delivered).toHaveLength(0);
});

test("when the switch is off a confirmed row is acked but nothing is claimed or sent", async () => {
  // A job we already sent before turning off: ack the echo.
  const ack = harness({
    enabled: false,
    queue: [{ id: "job-1", recipientNick: "ana", state: "claimed", claimId: "claim-1" }],
    ops: { "fw-job-1": { state: "confirmed", serverId: "m-1" } },
  });
  await drainFounderWelcome(ack.deps);
  expect(ack.calls).toEqual(["jobs", "read:fw-job-1", "delivered:job-1"]);

  // A pending job must not be claimed or opened while off.
  const pending = harness({ enabled: false, queue: [{ id: "job-2", recipientNick: "ben", state: "pending", claimId: null }] });
  await drainFounderWelcome(pending.deps);
  expect(pending.calls).toEqual(["jobs", "read:fw-job-2"]);
  expect(pending.claims["job-2"]).toBeUndefined();

  // A claimed job with a failed local row must not be re-enqueued while off.
  const failed = harness({
    enabled: false,
    queue: [{ id: "job-3", recipientNick: "eve", state: "claimed", claimId: "claim-3" }],
    ops: { "fw-job-3": { state: "failed", serverId: null } },
  });
  await drainFounderWelcome(failed.deps);
  expect(failed.calls).toEqual(["jobs", "read:fw-job-3"]);
  expect(failed.dropped).toHaveLength(0);
});

test("a scope swap aborts the drain before claiming or enqueueing", async () => {
  const h = harness({ queue: [{ id: "job-1", recipientNick: "ana", state: "pending", claimId: null }] });
  let alive = true;
  h.deps.alive = () => alive;
  h.deps.readOperation = (async (opId: string) => { h.calls.push(`read:${opId}`); alive = false; return null; });
  await drainFounderWelcome(h.deps);
  expect(h.calls).toEqual(["jobs", "read:fw-job-1"]);
  expect(h.delivered).toHaveLength(0);
});

// --- Periodic heartbeat (F2) ----------------------------------------------------------------

function fakeTimers() {
  let handler: (() => void) | null = null;
  let setCalls = 0;
  let clearCalls = 0;
  return {
    setInterval: (h: () => void) => { setCalls++; handler = h; return 1; },
    clearInterval: () => { clearCalls++; handler = null; },
    tick: () => handler?.(),
    counts: () => ({ setCalls, clearCalls }),
  };
}

test("an enabled founder gets one periodic drain, cleared on reset and on disable", async () => {
  const timers = fakeTimers();
  let drains = 0;
  const welcome = createFounderWelcome((value) => value, {
    load: async () => ({ enabled: true, pending: 0 }),
    save: async () => {},
    drain: async () => { drains += 1; },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    periodMs: 50,
  });
  await welcome.load();
  expect(timers.counts()).toEqual({ setCalls: 1, clearCalls: 0 });
  expect(welcome.periodicActive()).toBe(true);
  timers.tick();
  expect(drains).toBe(2); // one immediate from load, one heartbeat

  await welcome.setEnabled(false);
  expect(timers.counts().clearCalls).toBe(1);
  expect(welcome.periodicActive()).toBe(false);
  timers.tick();
  expect(drains).toBe(2); // no drain after disable

  await welcome.setEnabled(true);
  expect(timers.counts().setCalls).toBe(2);
  welcome.reset();
  expect(welcome.periodicActive()).toBe(false);
});

test("a disabled or non-founder load never starts a heartbeat", async () => {
  const timers = fakeTimers();
  const welcome = createFounderWelcome((value) => value, {
    load: async () => ({ enabled: false, pending: 0 }),
    save: async () => {},
    drain: async () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  await welcome.load();
  expect(timers.counts().setCalls).toBe(0);

  const hidden = createFounderWelcome((value) => value, {
    load: async () => null,
    save: async () => {},
    drain: async () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  await hidden.load();
  expect(hidden.state.available).toBe(false);
  expect(timers.counts().setCalls).toBe(0);
});

test("founder welcome copy uses the configured owner identity without hardcoded names", () => {
  const named = founderWelcomeText({ nick: "ada", name: "Ada Lovelace" });
  expect(named).toContain("Ada Lovelace (@ada)");
  expect(named).not.toContain("Mauricio");
  expect(named).not.toContain("bitbonsai");
  const nickOnly = founderWelcomeText({ nick: "ada", name: "ada" });
  expect(nickOnly).toContain("I'm @ada, the owner of this instance.");
  const neutral = founderWelcomeText();
  expect(neutral).toContain("I run this Slirc instance.");
  expect(neutral).not.toContain("Mauricio");
});
