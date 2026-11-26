// Client-driven founder welcome. The server never sends as the founder; this module drains the
// server's one-per-recipient job queue through the normal authorized DM + durable outbox path.
// The server claim is the cross-device mutex; the stable operation id is the same-browser
// idempotency key. No transport bypass, no fabricated history, no human SASL credentials.
import { founderWelcomeText } from "../shared/founder-welcome.ts";

export type WelcomeJob = { id: string; recipientNick: string; state: "pending" | "claimed"; claimId: string | null };
export type WelcomeOperation = { state: string; serverId: string | null };
export type WelcomeOutcome = WelcomeOperation | "timeout";
export type WelcomeFeed = { enabled: boolean; jobs: WelcomeJob[] };

export interface FounderWelcomeDeps {
  jobs(): Promise<WelcomeFeed>;
  claim(jobId: string): Promise<string | null>;
  delivered(jobId: string, claimId: string, msgid: string | null): Promise<void>;
  release(jobId: string, claimId: string): Promise<void>;
  // Opens the real DM if needed and returns its authorized conversation id, or null while it is
  // not reachable yet. It may refresh the connection, but never navigates to a route.
  conversation(recipientNick: string): Promise<string | null>;
  readOperation(opId: string): Promise<WelcomeOperation | null>;
  enqueue(conversationId: string, opId: string, text: string): Promise<void>;
  // Observes the outbox row until it settles. Does not re-send; only reads durable state.
  waitOutcome(opId: string, timeoutMs: number): Promise<WelcomeOutcome>;
  drop(opId: string): Promise<void>;
  // Local per-browser record of the claim this device owns. It proves a claimed job with no local
  // operation row was never sent here, so a crash or failed release can resume instead of stalling.
  readClaim(jobId: string): string | null;
  rememberClaim(jobId: string, claimId: string): void;
  forgetClaim(jobId: string): void;
  // False once the account scope changed or the session stopped; the drain aborts without sending.
  alive?(): boolean;
  // Configured instance owner identity for the welcome copy.
  owner?: { nick?: string; name?: string };
}

export const WELCOME_OP_PREFIX = "fw-";
export function welcomeOperationId(jobId: string): string {
  return `${WELCOME_OP_PREFIX}${jobId}`;
}

// Empty result means "nothing to do". A throw from the list fetch is a transient server problem:
// leave the queue for the next attempt rather than reporting progress.
export async function drainFounderWelcome(deps: FounderWelcomeDeps, log: (message: string) => void = () => {}): Promise<void> {
  const alive = () => deps.alive?.() ?? true;
  if (!alive()) return;
  let feed: WelcomeFeed;
  try {
    feed = await deps.jobs();
  } catch {
    return;
  }
  if (!alive()) return;
  for (const job of feed.jobs) {
    if (!alive()) return;
    const opId = welcomeOperationId(job.id);
    let existing: WelcomeOperation | null = null;
    try {
      existing = await deps.readOperation(opId);
    } catch {
      continue;
    }
    if (!alive()) return;
    // A confirmed echo is the only proof of delivery, and it is acked even when the switch is off.
    if (existing?.state === "confirmed") {
      let claimId = job.claimId;
      if (!claimId) {
        try { claimId = await deps.claim(job.id); } catch { claimId = null; }
        if (claimId) deps.rememberClaim(job.id, claimId);
      }
      if (claimId && alive()) {
        try { await deps.delivered(job.id, claimId, existing.serverId); deps.forgetClaim(job.id); } catch { /* retry next drain */ }
      }
      continue;
    }
    // Off means no new claim, DM or enqueue. Already-sent rows were acked above.
    if (!feed.enabled) continue;
    // An uncertain write may already exist on the server. Never auto-retry; the founder resolves
    // it through the outbox's explicit duplicate-risk consent. Keep the claim.
    if (existing?.state === "uncertain") continue;
    // A refused row is safe to drop and try again.
    if (existing?.state === "failed") {
      try { await deps.drop(opId); } catch { continue; }
    }
    // Claimed with no local row means another device may be mid-send. Resume only our own
    // persisted claim; anything else stays untouched so two devices never both send.
    let claimId = job.claimId;
    if (job.state === "claimed" && !existing && (!claimId || deps.readClaim(job.id) !== claimId)) continue;
    if (!claimId) {
      try { claimId = await deps.claim(job.id); } catch { claimId = null; }
      if (!claimId) continue; // another tab or device won the claim
      deps.rememberClaim(job.id, claimId);
    }
    if (!alive()) return;
    if (!existing || existing.state === "failed") {
      const conversationId = await deps.conversation(job.recipientNick).catch(() => null);
      if (!alive()) return;
      if (!conversationId) {
        // Nothing was written, so returning the job to pending is safe. If the release fails the
        // local claim survives and the next drain resumes this same job instead of stalling.
        try { await deps.release(job.id, claimId); deps.forgetClaim(job.id); } catch { /* keep local claim */ }
        continue;
      }
      try {
        await deps.enqueue(conversationId, opId, founderWelcomeText(deps.owner));
      } catch (error) {
        log(error instanceof Error ? error.message : "welcome enqueue failed");
        try { await deps.release(job.id, claimId); deps.forgetClaim(job.id); } catch { /* keep local claim */ }
        continue;
      }
    }
    const outcome = await deps.waitOutcome(opId, 30_000);
    if (outcome === "timeout") continue; // keep the claim; the next drain resumes
    if (outcome.state === "confirmed") {
      try { await deps.delivered(job.id, claimId, outcome.serverId); deps.forgetClaim(job.id); } catch { /* retry next drain */ }
    } else if (outcome.state === "failed") {
      try { await deps.drop(opId); } catch { /* keep for a later retry */ }
      try { await deps.release(job.id, claimId); deps.forgetClaim(job.id); } catch { /* keep local claim */ }
    }
    // uncertain: keep both the outbox row and the claim for explicit resend
  }
}

export interface FounderWelcomeUi {
  available: boolean;
  enabled: boolean;
  busy: boolean;
  note: string;
  pending: number;
}

export interface FounderWelcomeOptions {
  // null when the signed-in account is not the founder; the control stays hidden.
  load(): Promise<{ enabled: boolean; pending: number } | null>;
  save(enabled: boolean): Promise<void>;
  drain(): Promise<void>;
  // Injectable for tests; defaults to the platform timers.
  setInterval?(handler: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
  periodMs?: number;
}

export function createFounderWelcome(reactive: <T extends object>(value: T) => T, options: FounderWelcomeOptions) {
  const state = reactive<FounderWelcomeUi>({ available: false, enabled: false, busy: false, note: "", pending: 0 });
  const setIntervalFn = options.setInterval ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const clearIntervalFn = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const periodMs = options.periodMs ?? 60_000;
  let timer: unknown = null;

  function stopPeriodic(): void {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  // While opted in, one heartbeat keeps draining on a healthy long-lived connection. The server
  // claim and the stable operation id make a repeated pass a no-op.
  function startPeriodic(): void {
    if (timer !== null) return;
    timer = setIntervalFn(() => {
      if (state.available && state.enabled) void options.drain().catch(() => {});
    }, periodMs);
  }

  async function load(): Promise<void> {
    const settings = await options.load().catch(() => null);
    // A non-founder is a 404: never show the control, never mention the queue.
    if (!settings) {
      state.available = false; state.pending = 0; state.note = ""; state.busy = false;
      stopPeriodic();
      return;
    }
    state.available = true;
    state.enabled = settings.enabled;
    state.pending = settings.pending;
    if (settings.enabled) {
      void options.drain().catch(() => {});
      startPeriodic();
    } else {
      stopPeriodic();
    }
  }

  function reset(): void {
    stopPeriodic();
    state.available = false; state.enabled = false; state.busy = false; state.note = ""; state.pending = 0;
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    if (!state.available || state.busy) return;
    state.busy = true;
    state.note = "";
    try {
      await options.save(enabled);
      state.enabled = enabled;
      if (enabled) {
        state.note = "On. New members who verify now get your welcome.";
        void options.drain().catch(() => {});
        startPeriodic();
      } else {
        state.note = "Off. New members are not queued.";
        stopPeriodic();
      }
    } catch (error) {
      state.note = error instanceof Error ? error.message : "Could not save the setting.";
    } finally {
      state.busy = false;
    }
  }

  return { state, load, setEnabled, reset, periodicActive: () => timer !== null };
}
