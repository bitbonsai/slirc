import { test } from "bun:test";

// End-to-end proof for session-bound Codex agents, in agent-session-codex-proof.live.ts. It drives the
// real `codex` TUI inside tmux and takes about 20 s, so it stays out of the default run.
// SLIRC_AGENT_PROOFS=true or SLIRC_REQUIRE_CODEX=true runs it.
if (process.env.SLIRC_AGENT_PROOFS === "true" || process.env.SLIRC_REQUIRE_CODEX === "true") await import("./agent-session-codex-proof.live.ts");
else test.skip("Codex agent proof (set SLIRC_AGENT_PROOFS=true)", () => {});
