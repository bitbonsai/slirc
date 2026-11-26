import { test } from "bun:test";

// The Codex runtime against a fake Slirc and a fake codex, in runtime.live.ts. It starts about ten
// bun processes per case and waits on fixed pauses, so it takes 15 to 25 s and stays out of the
// default run. SLIRC_AGENT_PROOFS=true runs it.
if (process.env.SLIRC_AGENT_PROOFS === "true") await import("./runtime.live.ts");
else test.skip("Codex runtime (set SLIRC_AGENT_PROOFS=true)", () => {});
