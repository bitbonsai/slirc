import { conversationId, foldIdentifier } from "@client/model.ts";
import { queuedTextFor } from "@client/drafts.ts";
import { drainFounderWelcome, type WelcomeFeed, type WelcomeJob, type WelcomeOperation, type WelcomeOutcome } from "@client/founder-welcome.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface WelcomeDrainDeps {
  state: Pick<RuntimeState, "authorized" | "currentScope" | "db" | "outbox" | "scope" | "signingOut" | "stopped">;
  ui: Pick<ClientState, "directs" | "me">;
  connect: () => Promise<void>;
}

export function createWelcomeDrain(deps: WelcomeDrainDeps) {
  const { state: rs, ui, connect } = deps;

  // --- Founder welcome drain (client-driven) ------------------------------------------------
  // The server holds one job per newly verified human. This founder's own browser opens the real
  // DM and sends through the durable outbox. It may refresh the connection and reselect the
  // conversation behind Profile, but it never navigates to a route and never touches drafts. The
  // server claim is the cross-device mutex; the stable operation id refuses a duplicate local row
  // in the same browser.
  async function ensureWelcomeConversation(recipientNick: string, alive: () => boolean): Promise<string | null> {
    if (!alive()) return null;
    const find = () => {
      const direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(recipientNick));
      if (!direct) return null;
      const item = rs.authorized.find((entry) => entry.kind === "dm" && entry.wireTarget === direct.channel);
      return item?.conversationId ?? null;
    };
    const existing = find();
    if (existing) return existing;
    const direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(recipientNick));
    if (!direct) {
      const response = await fetch(`/api/dms/${encodeURIComponent(recipientNick)}`, { method: "POST", credentials: "same-origin" });
      if (!response.ok) return null;
    }
    // Refresh grants (and, for a new pair, join the DM) without navigating. The next drain pass
    // sees the authorized conversation; until then the claim is released for a safe retry.
    await connect();
    if (!alive()) return null;
    return find();
  }

  async function readWelcomeOperation(opId: string): Promise<WelcomeOperation | null> {
    if (!rs.db) return null;
    const operation = await rs.db.operations.get(opId);
    if (!operation) return null;
    const message = await rs.db.messages.get(operation.messageId);
    return { state: operation.state, serverId: message?.serverId ?? null };
  }

  async function waitWelcomeOutcome(opId: string, timeoutMs: number): Promise<WelcomeOutcome> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await readWelcomeOperation(opId);
      if (!current) return "timeout";
      if (current.state === "confirmed" || current.state === "failed" || current.state === "uncertain") return current;
      if (Date.now() >= deadline) return "timeout";
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  async function dropWelcomeOperation(opId: string): Promise<void> {
    const db = rs.db;
    if (!db) return;
    await db.transaction("rw", db.operations, db.messages, async () => {
      await db.operations.delete(opId);
      await db.messages.delete(opId);
    });
  }

  // The exact local record of the claim this browser owns. Keyed only by the server job id, whose
  // uniqueness comes from the one-per-recipient index.
  const welcomeClaimKey = (jobId: string) => `slirc2-fw-claim:${jobId}`;

  function readWelcomeClaim(jobId: string): string | null {
    try { return globalThis.localStorage?.getItem(welcomeClaimKey(jobId)) ?? null; } catch { return null; }
  }

  function rememberWelcomeClaim(jobId: string, claimId: string): void {
    try { globalThis.localStorage?.setItem(welcomeClaimKey(jobId), claimId); } catch { /* best effort */ }
  }

  function forgetWelcomeClaim(jobId: string): void {
    try { globalThis.localStorage?.removeItem(welcomeClaimKey(jobId)); } catch { /* best effort */ }
  }

  let welcomeDraining = false;

  // A signed-out or switched account abandons a drain that is still running.
  function stopWelcomeDrain(): void { welcomeDraining = false; }

  async function drainWelcome(): Promise<void> {
    // Capture the starting account scope. Every closure refuses once the scope moves, so a drain
    // that outlives an account switch can never queue into the new account's database.
    if (welcomeDraining || !rs.outbox || !rs.scope || !rs.db || rs.stopped || rs.signingOut) return;
    const startDb = rs.db;
    const startScope = rs.scope;
    const startScopeKey = rs.currentScope;
    const alive = () => !rs.stopped && !rs.signingOut && rs.db === startDb && rs.scope === startScope && rs.currentScope === startScopeKey;
    welcomeDraining = true;
    const guard = <T>(run: () => Promise<T>): Promise<T> => {
      if (!alive()) return Promise.reject(new Error("account scope changed"));
      return run().then((value) => {
        if (!alive()) throw new Error("account scope changed");
        return value;
      });
    };
    try {
      await drainFounderWelcome({
        jobs: () => guard(async () => {
          const response = await fetch("/api/welcome/jobs", { cache: "no-store", credentials: "same-origin" });
          if (!response.ok) throw new Error(`welcome jobs failed (${response.status})`);
          const body = await response.json().catch(() => ({})) as { enabled?: unknown; jobs?: unknown };
          return { enabled: body.enabled === true, jobs: Array.isArray(body.jobs) ? body.jobs as WelcomeJob[] : [] } satisfies WelcomeFeed;
        }),
        claim: (jobId) => guard(async () => {
          const response = await fetch(`/api/welcome/jobs/${encodeURIComponent(jobId)}/claim`, { method: "POST", credentials: "same-origin" });
          if (response.status === 409) return null;
          if (!response.ok) throw new Error(`welcome claim failed (${response.status})`);
          const body = await response.json().catch(() => ({})) as { claimId?: unknown };
          return typeof body.claimId === "string" ? body.claimId : null;
        }),
        delivered: async (jobId, claimId, msgid) => {
          if (!alive()) throw new Error("account scope changed");
          const response = await fetch(`/api/welcome/jobs/${encodeURIComponent(jobId)}/delivered`, {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ claimId, msgid }),
          });
          if (!response.ok) throw new Error(`welcome delivered failed (${response.status})`);
        },
        release: async (jobId, claimId) => {
          if (!alive()) throw new Error("account scope changed");
          const response = await fetch(`/api/welcome/jobs/${encodeURIComponent(jobId)}/release`, {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ claimId }),
          });
          if (!response.ok) throw new Error(`welcome release failed (${response.status})`);
        },
        conversation: (nick) => guard(() => ensureWelcomeConversation(nick, alive)),
        readOperation: (opId) => guard(() => readWelcomeOperation(opId)),
        enqueue: async (conversationId, opId, text) => {
          if (!alive()) throw new Error("account scope changed");
          if (!rs.outbox || !rs.scope) throw new Error("sender not ready");
          // The revision is a send token, never a real draft: clearsDraft cannot match, so a
          // founder's open draft, selection or focus is untouched.
          const queued = queuedTextFor(conversationId, rs.scope.account, { text, revision: `welcome:${opId}` }, opId, Date.now());
          await rs.outbox.enqueueText(queued);
        },
        waitOutcome: (opId, timeoutMs) => guard(() => waitWelcomeOutcome(opId, timeoutMs)),
        drop: (opId) => guard(() => dropWelcomeOperation(opId)),
        readClaim: readWelcomeClaim,
        rememberClaim: rememberWelcomeClaim,
        forgetClaim: forgetWelcomeClaim,
        alive,
        owner: { nick: rs.scope?.account, name: ui.me },
      }, (message) => console.error("founder welcome:", message));
    } finally {
      welcomeDraining = false;
    }
  }

  return { drainWelcome, stopWelcomeDrain };
}
