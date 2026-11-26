import { expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../src/adapter-core.ts";
import { lastWorkspacePath, saveLastWorkspace } from "../../shared/workspace.ts";

// test/support/isolate-state.ts (preloaded) keeps tests off the real Slirc state.
const realLast = join(homedir(), ".local", "state", "slirc", "workspace");
const mtime = () => { try { return statSync(realLast).mtimeMs; } catch { return undefined; } };

test("state defaults to a temp dir, and writes under the real home are refused", () => {
  expect(lastWorkspacePath().startsWith(homedir() + "/.local")).toBe(false);
  expect(stateDir("pi").startsWith(homedir() + "/.local")).toBe(false);
  expect(process.env.PI_CODING_AGENT_DIR?.startsWith(join(homedir(), ".pi"))).toBe(false);
  expect(() => writeFileSync(realLast, "x")).toThrow("real Slirc state");
  const before = mtime();
  saveLastWorkspace("127.0.0.1:1", { HOME: homedir() });
  expect(mtime()).toBe(before);
});
