// Durable text sender (stage 2E). No UI. Contract sources: .plans/slirc2.md "Contracts to
// settle" 4-7 and lane E, .plans/instant.md "Outbox", plus check C7.
//
// Rules this module holds:
// - enqueueText() calls db.queueText (message + operation + draft removal, one transaction) and
//   only resolves once that commit lands. Nothing is sent before the commit, and a failed commit
//   throws instead of reporting acceptance.
// - One sender per account scope, elected by Web Locks. No Locks API -> sending is disabled with
//   an explicit reason; there is deliberately no auto-leader fallback.
// - On takeover the sender re-reads the database, converts any persisted `sending` op to
//   `uncertain`, and does not replay it. A queued op only sends when sync's injected readiness
//   says the current connection is ready for that conversation.
// - Readiness is sync's truth, injected as isReady(conversationId): authenticated, access allowed,
//   joined, and complete history recovery applied. The outbox never guesses it; sync calls
//   notifyReady() when readiness changes and onDisconnected() when the connection drops.
// - `sending` + the message's `sending` are written atomically before the transport call. A
//   disconnect or any transport throw after a possible write is `uncertain`; only a proven
//   refusal (SendRefusedError) is `failed`. No timer retries anywhere.
// - Confirmation is db.applyBatch's job (atomic operation + message). This module never writes
//   `confirmed`, so a late echo wins over a racing throw.
// - BroadcastChannel carries nudge hints only; operation data is never accepted from it.
//
// ponytail: text only, single lock, no backoff/sweep. Add retry scheduling when a transport
// proves it needs one; explicit resend is the only retry path today.

import {
  deliveryState,
  scopeKey,
  type DeliveryEvent,
  type Operation,
  type QueueText,
  type SendState,
} from "./model.ts";
import type { ClientDatabase } from "./db.ts";

// Transport throws this to prove Ergo refused the message before accepting anything (e.g. a 4xx
// numeric). Anything else is uncertain: the write may have reached the server.
export class SendRefusedError extends Error {
  readonly refused = true;
  constructor(message = "send refused") {
    super(message);
    this.name = "SendRefusedError";
  }
}

function isRefused(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { refused?: unknown }).refused === true;
}

export interface OutboxTransport {
  // Resolves once the wire write happened, echo not required. Throws on failure.
  sendText(operation: Operation): void | Promise<void>;
  // kind "redact": removes a server msgid. Absent means redaction is disabled for this session.
  sendRedact?(operation: Operation): void | Promise<void>;
  // kind "admin-redact": an admin removing another author's message through the app API.
  sendAdminRedact?(operation: Operation): void | Promise<void>;
}

// The subset of navigator.locks this module uses. Real Web Locks satisfies it.
export interface OutboxLockManager {
  request(name: string, options: { mode: "exclusive" }, callback: () => Promise<void> | void): Promise<void>;
}

export interface OutboxStatus {
  owner: boolean;
  sendingEnabled: boolean;
  reason?: string;
}

// Sync owns readiness for the current connection: authenticated, access allowed, the conversation
// joined, and complete history recovery applied. One shot at a conversation, no connection token
// leaks into the outbox. The outbox calls this before every send and for explicit resends.
export interface OutboxReadiness {
  isReady(conversationId: string): boolean;
}

export interface Outbox {
  // Elects the sender. Resolves once the lock is held (or immediately when Locks is absent).
  start(): Promise<void>;
  stop(): void;
  enqueueText(send: QueueText): Promise<{ operationId: string }>;
  // Several sends in one durable transaction, sent in createdAt order.
  enqueueTexts(sends: readonly QueueText[]): Promise<{ operationIds: string[] }>;
  // Any tab may enqueue a redact; the lock owner transmits it.
  enqueueRedact(operation: Operation): Promise<{ operationId: string }>;
  rejectRedact(redactId: string, reason: string): Promise<void>;
  // Sync: readiness may have changed (recovery landed, room joined). Re-reads the database.
  notifyReady(): Promise<void>;
  // Sync: the current connection dropped. Turns in-flight `sending` into `uncertain`.
  onDisconnected(): Promise<void>;
  // Explicit resend of an uncertain op. Needs ready conversation plus duplicate-risk consent.
  resendUncertain(operationId: string, consent: { duplicateRiskAccepted: boolean }): Promise<void>;
  // Cancel keeps the row and its text as `failed`; content is never dropped.
  cancel(operationId: string): Promise<void>;
  flush(): Promise<void>;
  status(): OutboxStatus;
}

export interface OutboxOptions {
  db: ClientDatabase;
  transport: OutboxTransport;
  isReady: OutboxReadiness["isReady"];
  locks?: OutboxLockManager | null;
  BroadcastChannelImpl?: typeof BroadcastChannel | null;
  // The lock owner found queued work it cannot send: the conversation is not ready (unknown or
  // not yet recovered). A hint only — the handler must re-fetch authoritative server access; a
  // persisted row or BroadcastChannel payload never supplies a wire target. Fire-and-forget so
  // a handler that calls notifyReady() cannot re-enter this flush.
  onStalled?: (conversationIds: string[]) => void;
  // How often the lock owner re-reads the durable queue to catch a nudge it never received.
  sweepMs?: number;
}

function defaultLocks(): OutboxLockManager | null {
  return typeof navigator !== "undefined" && navigator.locks
    ? (navigator.locks as unknown as OutboxLockManager)
    : null;
}

function defaultBroadcast(): typeof BroadcastChannel | null {
  return typeof BroadcastChannel !== "undefined" ? BroadcastChannel : null;
}

export function createOutbox({
  db,
  transport,
  isReady,
  locks = defaultLocks(),
  BroadcastChannelImpl = defaultBroadcast(),
  onStalled,
  sweepMs = 2_000,
}: OutboxOptions): Outbox {
  const channelName = `slirc-outbox:${scopeKey(db.scope)}`;
  const bc = BroadcastChannelImpl ? new BroadcastChannelImpl(channelName) : null;

  let isOwner = false;
  let stopped = false;
  let started = false;
  let failure: string | undefined;
  let releaseLock: (() => void) | null = null;
  let flushing: Promise<void> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let acquireResolve: () => void = () => {};
  const acquired = new Promise<void>((resolve) => {
    acquireResolve = resolve;
  });

  // Atomic state move for one operation and its message. Returns false when the transition is
  // not legal from the current state, which is what protects a late confirmation from being
  // downgraded: `confirmed / disconnected` is not a transition, so nothing is written.
  async function transition(operationId: string, event: DeliveryEvent, error?: string): Promise<boolean> {
    return db.transaction("rw", db.operations, db.messages, async () => {
      const operation = await db.operations.get(operationId);
      if (!operation) return false;
      let next: SendState;
      try {
        next = deliveryState(operation.state, event);
      } catch {
        return false;
      }
      if (next === "saving") return false;
      const message = await db.messages.get(operation.messageId);
      await db.operations.put({ ...operation, state: next, error, attemptedAt: event === "begin-send" ? Date.now() : operation.attemptedAt });
      if (message) await db.messages.put({ ...message, state: next, error });
      return true;
    });
  }

  // Ergo answered a native REDACT with FAIL: the in-flight delete for that message failed, and the
  // row stays. Only `sending` redact operations move; a confirmed or queued one is left alone.
  async function rejectRedact(redactId: string, reason: string): Promise<void> {
    const pending = await db.operations.filter((op) => op.kind === "redact" && op.redactId === redactId && op.state === "sending").toArray();
    for (const operation of pending) await transition(operation.id, "rejected", reason);
  }

  // Persisted `sending` means the previous sender may have written to the wire without an echo.
  // It becomes uncertain and is never replayed; only an explicit resend can revive it.
  async function recoverSending(): Promise<void> {
    const inFlight = await db.operations.filter((op) => op.state === "sending").toArray();
    for (const operation of inFlight) {
      await transition(operation.id, "disconnected", "delivery uncertain");
    }
  }

  async function sendQueued(operationId: string): Promise<void> {
    // queued -> sending, message included, committed before the network call.
    const claimed = await transition(operationId, "begin-send");
    if (!claimed) return;
    const operation = await db.operations.get(operationId);
    if (!operation || operation.state !== "sending") return;
    // Database awaits can outlive the connection, lock holder, or access grant.
    if (stopped || !isOwner || !isReady(operation.conversationId)) {
      await transition(operationId, "disconnected", "delivery uncertain");
      return;
    }
    try {
      if (operation.kind === "redact") {
        if (!transport.sendRedact) throw new SendRefusedError("message redaction not supported by this server");
        await transport.sendRedact(operation);
      } else if (operation.kind === "admin-redact") {
        if (!transport.sendAdminRedact) throw new SendRefusedError("admin delete is not available");
        await transport.sendAdminRedact(operation);
      } else {
        await transport.sendText(operation);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "send failed";
      if (isRefused(error)) await transition(operationId, "rejected", message);
      else await transition(operationId, "disconnected", "delivery uncertain");
    }
  }

  async function flushOnce(): Promise<void> {
    if (!isOwner || stopped) return;
    const attempted = new Set<string>();
    for (;;) {
      if (!isOwner || stopped) return;
      // Re-read the database every pass: never trust an in-memory copy for send decisions.
      const operations = await db.operations.toArray();
      const queued = operations.filter((op) => op.state === "queued");
      const next = queued
        .filter((op) => isReady(op.conversationId))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) {
        // Ready work is exhausted, but some queued op targets a conversation this sender cannot
        // reach yet. Ask the page to discover/join it; it re-reads server access, never the row.
        const stalled = [...new Set(queued.filter((op) => !isReady(op.conversationId)).map((op) => op.conversationId))];
        if (stalled.length) signalStalled(stalled);
        return;
      }
      if (attempted.has(next.id)) return;
      attempted.add(next.id);
      await sendQueued(next.id);
    }
  }

  function flush(): Promise<void> {
    if (!flushing) flushing = flushOnce().finally(() => { flushing = null; });
    return flushing;
  }

  function backgroundFlush(): void {
    void flush().catch((error) => {
      failure = error instanceof Error ? error.message : String(error);
      stop();
    });
  }

  async function start(): Promise<void> {
    if (stopped) return;
    if (started) return acquired;
    started = true;
    if (!locks) {
      acquireResolve();
      return;
    }
    void locks.request(channelName, { mode: "exclusive" }, async () => {
      if (stopped) return;
      isOwner = true;
      const held = new Promise<void>((resolve) => { releaseLock = resolve; });
      try {
        await recoverSending();
        acquireResolve();
        if (!stopped) {
          // A follower's nudge can be dropped (backgrounded owner), so the owner also re-reads
          // the durable queue on a timer. The row stays authoritative; this is only a wake-up.
          if (sweepMs > 0) sweepTimer = setInterval(() => { if (isOwner && !stopped) backgroundFlush(); }, sweepMs);
          backgroundFlush();
        }
        await held;
      } finally {
        isOwner = false;
      }
    }).catch((error) => {
      failure = error instanceof Error ? error.message : String(error);
      stop();
    });
    await acquired;
  }

  function signalStalled(conversationIds: string[]): void {
    if (!onStalled) return;
    try { onStalled(conversationIds); } catch { /* recovery is the page's job; never break flushing */ }
  }

  function stop(): void {
    stopped = true;
    isOwner = false;
    if (sweepTimer !== null) { clearInterval(sweepTimer); sweepTimer = null; }
    bc?.close();
    const release = releaseLock;
    releaseLock = null;
    // Do not hand another tab the lock while this holder can still be writing.
    if (flushing) void flushing.then(() => release?.(), () => release?.());
    else release?.();
    acquireResolve();
  }

  async function enqueueText(send: QueueText): Promise<{ operationId: string }> {
    await enqueueTexts([send]);
    return { operationId: send.operation.id };
  }

  async function enqueueTexts(sends: readonly QueueText[]): Promise<{ operationIds: string[] }> {
    await db.queueTexts(sends); // atomic; throws on any failure, so acceptance is never premature
    try { bc?.postMessage({ type: "nudge" }); } catch { /* hint only; the row is already committed */ }
    if (isOwner) backgroundFlush();
    return { operationIds: sends.map((send) => send.operation.id) };
  }

  async function enqueueRedact(operation: Operation): Promise<{ operationId: string }> {
    await db.queueRedact(operation);
    try { bc?.postMessage({ type: "nudge" }); } catch { /* hint only; the row is already committed */ }
    if (isOwner) backgroundFlush();
    return { operationId: operation.id };
  }

  async function notifyReady(): Promise<void> {
    await flush();
  }

  async function onDisconnected(): Promise<void> {
    if (!isOwner) return; // A follower's socket says nothing about the sender's connection.
    const inFlight = await db.operations.filter((op) => op.state === "sending").toArray();
    for (const operation of inFlight) {
      await transition(operation.id, "disconnected", "delivery uncertain");
    }
  }

  async function resendUncertain(
    operationId: string,
    consent: { duplicateRiskAccepted: boolean },
  ): Promise<void> {
    if (!consent?.duplicateRiskAccepted) throw new Error("duplicate-risk consent required to resend");
    const existing = await db.operations.get(operationId);
    if (!existing) return;
    if (!isReady(existing.conversationId)) throw new Error("recovery not complete for this conversation");
    const changed = await db.transaction("rw", db.operations, db.messages, async () => {
      const operation = await db.operations.get(operationId);
      if (!operation || operation.state !== "uncertain") return false;
      const next = deliveryState(operation.state, "explicit-resend-after-recovery");
      const message = await db.messages.get(operation.messageId);
      await db.operations.put({ ...operation, state: next, error: undefined, attemptedAt: undefined });
      if (message) await db.messages.put({ ...message, state: next, error: undefined });
      return true;
    });
    if (changed) {
      try { bc?.postMessage({ type: "nudge" }); } catch { /* durable state remains authoritative */ }
      await flush();
    }
  }

  async function cancel(operationId: string): Promise<void> {
    const changed = await db.transaction("rw", db.operations, db.messages, async () => {
      const operation = await db.operations.get(operationId);
      if (!operation || operation.state === "confirmed") return false;
      const message = await db.messages.get(operation.messageId);
      const state = operation.state === "sending" || operation.state === "uncertain" ? "uncertain" : "failed";
      const error = state === "uncertain" ? "cancelled; delivery uncertain" : "cancelled";
      await db.operations.put({ ...operation, state, error });
      if (message) await db.messages.put({ ...message, state, error });
      return true;
    });
    if (changed) await flush();
  }

  function status(): OutboxStatus {
    if (!locks) {
      return {
        owner: false,
        sendingEnabled: false,
        reason: "Web Locks unavailable; sending disabled",
      };
    }
    return { owner: isOwner, sendingEnabled: !stopped && !failure, reason: failure };
  }

  if (bc) {
    bc.onmessage = (event: MessageEvent) => {
      // A nudge says "look again"; it never carries an operation to trust.
      if (!stopped && event.data?.type === "nudge" && isOwner) backgroundFlush();
    };
  }

  return {
    start,
    stop,
    enqueueText,
    enqueueTexts,
    enqueueRedact,
    rejectRedact,
    notifyReady,
    onDisconnected,
    resendUncertain,
    cancel,
    flush,
    status,
  };
}
