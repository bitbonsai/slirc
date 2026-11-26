// Pure fixture plan + guard for scripts/profile-thread-seed.ts.
//
// No database, network, or Ergo import lives here: the seed imports this before the guard
// so a non-isolated run is rejected before SQLite opens or IRC dials.

export const PROFILE_THREAD_SEED_VERSION = "v1";
export const PROFILE_THREAD_SAMPLE = {
  root: "Profile and device linking feedback",
  replies: [
    "photo is easier to change now — one tap on the picture",
    "six boxes make the code easier to type or paste",
    "good to keep this feedback in the thread, not the dm",
  ],
};

export function threadTitle(root: string): string {
  return root.replace(/\s+/g, " ").trim().slice(0, 60);
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

// Two factors, both explicit: the opt-in nothing sets automatically, and the isolated
// slirc2 profile flag the coordinator injects. Production sets neither.
export function profileThreadSeedGuard(env: Record<string, string | undefined>): GuardResult {
  if (env.SLIRC_PROFILE_THREAD_SEED !== "true") {
    return { ok: false, reason: "Sample thread seed requires the explicit opt-in SLIRC_PROFILE_THREAD_SEED=true" };
  }
  if (env.SLIRC_DEV_PROFILE !== "slirc2") {
    return { ok: false, reason: `Sample thread seed requires SLIRC_DEV_PROFILE=slirc2, got ${env.SLIRC_DEV_PROFILE || "(unset)"}` };
  }
  return { ok: true };
}

// One meta key per write. The value is a two-phase stamp: `sending` is written before the
// wire/provisioning call, `confirmed` after the echo/foreign-key success. A rerun skips a
// confirmed key silently and refuses to blind-retry a `sending` key.
export function threadStamp(kind: "root" | "child" | "reply", sender: string, index: number): string {
  return `profile-thread-seed:${PROFILE_THREAD_SEED_VERSION}:${kind}:${sender}:${index}`;
}
