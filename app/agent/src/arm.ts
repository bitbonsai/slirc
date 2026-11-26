import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./adapter-core.ts";
import { expandWorkspace } from "./workspace.ts";

// Arm files: `slirc-agent <workspace>` run inside a session asks that same session to pair. The
// CLI writes one file named after the session key; the runtime loaded in that session picks it up
// once, then checks that the person asked for it before pairing. See HARNESSES.md.
//
// The session key comes from the shell's environment, which the model can set, so the file also
// lists the processes above the CLI. A runtime takes it only when its own harness process is one
// of them: a command run in another session can't arm this one.
//
// When the CLI has just installed or updated the extension, the session must reload first, and
// the runtime still loaded may be older, with a consent check that doesn't know this command. So
// that arm is `<key>.reload.json`, which runtimes take only as they start, never after a tool.

type Env = Record<string, string | undefined>;
export type Arm = { host: string; ticket?: string; at: number; pids?: number[] };

export const ARM_TTL_MS = 10 * 60_000;
const KEY = /^[A-Za-z0-9_-]{1,128}$/;
export const validTicket = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
// Windows has no `ps`; there the file carries no processes and the runtime skips that check.
const checksProcesses = process.platform !== "win32";

export const armDir = (harness: string, env: Env = process.env) => join(stateDir(harness, env), "arm");
export const armPath = (harness: string, key: string, env: Env = process.env, reload = false) => {
  if (!KEY.test(key)) throw new Error("bad session key");
  return join(armDir(harness, env), `${key}${reload ? ".reload" : ""}.json`);
};

// The processes above this one, nearest first: the shell, the harness, up to the root.
export function ancestors(from = process.ppid): number[] {
  if (!checksProcesses) return [];
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
  const parent = new Map<number, number>();
  for (const line of (listed.stdout ?? "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && ppid >= 0) parent.set(pid, ppid);
  }
  const chain: number[] = [];
  for (let pid = from; pid > 0 && chain.length < 64 && !chain.includes(pid); pid = parent.get(pid) ?? 0) chain.push(pid);
  return chain;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

function parse(text: string, now: number): Arm | undefined {
  try {
    const raw = JSON.parse(text) as Partial<Arm>;
    if (typeof raw.host !== "string" || typeof raw.at !== "number" || now - raw.at > ARM_TTL_MS || raw.at > now + 60_000) return undefined;
    const pids = Array.isArray(raw.pids) ? raw.pids.filter((pid): pid is number => Number.isInteger(pid) && pid > 0) : undefined;
    return { host: expandWorkspace(raw.host), at: raw.at, ...(validTicket(raw.ticket) ? { ticket: raw.ticket } : {}), ...(pids ? { pids } : {}) };
  } catch { return undefined; }
}

// Private folder, private file, swapped in whole. A live arm from another session is kept: the
// first of its processes still running (that session's harness) must be above this CLI too.
export function writeArm(harness: string, key: string, arm: { host: string; ticket?: string; reload?: boolean }, env: Env = process.env, now = Date.now(), pids = ancestors()): string {
  const path = armPath(harness, key, env, arm.reload);
  mkdirSync(armDir(harness, env), { recursive: true, mode: 0o700 });
  let existing: Arm | undefined;
  try { existing = parse(readFileSync(path, "utf8"), now); } catch {}
  const owner = existing?.pids?.find(alive);
  if (owner !== undefined && !pids.includes(owner)) throw new Error("another session already asked to connect under this session's id");
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, JSON.stringify({ host: arm.host, ...(validTicket(arm.ticket) ? { ticket: arm.ticket } : {}), at: now, ...(checksProcesses ? { pids } : {}) })); }
  finally { closeSync(fd); }
  renameSync(temp, path);
  return path;
}

// One-shot pickup: the file is renamed away first, so of two runtimes racing only one gets it.
// `self` is the harness process the runtime runs in; an arm that doesn't list it is dropped.
// Expired or broken files are deleted and ignored. `starting`: the runtime is starting, so it
// takes the arm left for after a reload too.
export function takeArm(harness: string, key: string, env: Env = process.env, now = Date.now(), self = process.pid, starting = false): Arm | undefined {
  let paths: string[];
  try { paths = starting ? [armPath(harness, key, env), armPath(harness, key, env, true)] : [armPath(harness, key, env)]; } catch { return undefined; }
  let taken = "";
  for (const path of paths) {
    const name = `${path}.${randomBytes(6).toString("hex")}.taken`;
    try { renameSync(path, name); taken = name; break; } catch {}
  }
  if (!taken) return undefined;
  let text: string;
  try { text = readFileSync(taken, "utf8"); } catch { return undefined; }
  finally { rmSync(taken, { force: true }); }
  const arm = parse(text, now);
  if (!arm || (checksProcesses && !arm.pids?.includes(self))) return undefined;
  const { pids: _pids, ...rest } = arm;
  return rest;
}

// Turns Slirc itself delivers into the session carry a receipt; they never count as the person.
export const isDelivery = (text: string) => /Slirc delivery receipt: [0-9a-f-]{36}/.test(text);

const WORKSPACE = /^(?:https?:\/\/)?[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?\/?$/;
const VALUE = /^[A-Za-z0-9_-]{1,64}$/;

// Whether the person's own prompt is the command for this workspace, and nothing else: an
// optional runner (bunx, npx, pnpm dlx), `slirc-agent` with an optional @version, an optional
// `connect`, the workspace, an optional connect code after it, and the --harness option (or
// 3.2.0's --ticket). One line, no quotes, no prose, so a mention ("don't run slirc-agent
// calango") or a pasted log never counts. No workspace means app.slirc.org, as for the CLI; it
// must match the host the CLI armed.
export function consents(prompt: string | undefined, host: string): boolean {
  if (!prompt || isDelivery(prompt)) return false;
  const line = prompt.trim();
  if (/[\r\n]/.test(line)) return false;
  const words = line.split(/[ \t]+/);
  let index = words[0] === "bunx" || words[0] === "npx" ? 1 : words[0] === "pnpm" && words[1] === "dlx" ? 2 : 0;
  if (!/^slirc-agent(?:@[\w.-]+)?$/.test(words[index] ?? "")) return false;
  if (words[index + 1] === "connect") index++;
  const positional: string[] = [];
  for (index++; index < words.length; index++) {
    const word = words[index];
    if (word === "--ticket" || word === "--harness") { if (!VALUE.test(words[++index] ?? "")) return false; continue; }
    if (/^--(?:ticket|harness)=[A-Za-z0-9_-]{1,64}$/.test(word)) continue;
    positional.push(word);
  }
  const [workspace, code, ...rest] = positional;
  if (rest.length || (workspace !== undefined && !WORKSPACE.test(workspace)) || (code !== undefined && !validTicket(code))) return false;
  try { return expandWorkspace(workspace ?? "") === host; } catch { return false; }
}
