import { test } from "bun:test";

// End-to-end proof for session-bound Pi agents, in agent-session-pi-proof.live.ts. It drives the real
// `pi` binary and takes about 20 s, so it stays out of the default run. SLIRC_AGENT_PROOFS=true or
// SLIRC_REQUIRE_PI=true (bun run test:agent-e2e) runs it.
if (process.env.SLIRC_AGENT_PROOFS === "true" || process.env.SLIRC_REQUIRE_PI === "true") await import("./agent-session-pi-proof.live.ts");
else test.skip("Pi agent proof (set SLIRC_AGENT_PROOFS=true)", () => {});
