import { mock } from "bun:test";
import * as live from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Preloaded for every test file (bunfig.toml). Slirc keeps per-computer state under
// $XDG_STATE_HOME (or ~/.local/state) and ~/.pi/agent; product code falls back to the real home
// when a test forgets to point it elsewhere, which once rewrote the owner's last workspace. So each
// test file gets its own temp state, and writing under the real places throws.
// A plain copy: once node:fs is mocked below, the namespace would point at the wrappers.
const fs = { ...live };
const real = homedir();
const guarded = [join(real, ".local", "state", "slirc"), join(real, ".local", "state", "slirc-agent"), join(real, ".pi", "agent", "slirc")];
const root = fs.mkdtempSync(join(tmpdir(), "slirc-test-state-"));
process.env.XDG_STATE_HOME = join(root, "state");
process.env.PI_CODING_AGENT_DIR ??= join(root, "pi");
process.on("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

const refuse = (path: unknown) => {
  if (typeof path !== "string" && !(path instanceof URL)) return;
  const target = resolve(String(path instanceof URL ? path.pathname : path));
  const hit = guarded.find((dir) => target === dir || target.startsWith(`${dir}/`));
  if (hit) throw new Error(`test wrote real Slirc state at ${target}; point XDG_STATE_HOME or PI_CODING_AGENT_DIR at a temp dir`);
};
const wrap = <T extends (...args: any[]) => any>(fn: T, ...indexes: number[]) =>
  ((...args: any[]) => { for (const index of indexes) refuse(args[index]); return fn(...args); }) as T;
const writers = {
  writeFileSync: wrap(fs.writeFileSync, 0), appendFileSync: wrap(fs.appendFileSync, 0), mkdirSync: wrap(fs.mkdirSync, 0),
  openSync: ((path: any, flags?: any, ...rest: any[]) => { if (flags !== undefined && flags !== "r") refuse(path); return (fs.openSync as any)(path, flags, ...rest); }) as typeof fs.openSync,
  renameSync: wrap(fs.renameSync, 0, 1), rmSync: wrap(fs.rmSync, 0), unlinkSync: wrap(fs.unlinkSync, 0), cpSync: wrap(fs.cpSync, 1),
};
mock.module("node:fs", () => ({ ...fs, ...writers, default: { ...fs, ...writers } }));
mock.module("fs", () => ({ ...fs, ...writers, default: { ...fs, ...writers } }));
