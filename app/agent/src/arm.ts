import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./adapter-core.ts";
import { expandWorkspace } from "../../shared/workspace.ts";

// Arm files: `slirc-agent <workspace>` run inside a session asks that same session to pair. The
// CLI writes one file named after the session key; the runtime loaded in that session picks it up
// once, then checks that the person asked for it before pairing. See HARNESSES.md.
//
// The file only says "now". The runtime pairs with the workspace and connect code of the person's
// own latest prompt, never the file's, and that prompt counts once. So the file doesn't need to
// come from this session's own shell: a run the model backgrounded (its parent shell gone), a run
// repeated, or one from another session under this session's key can only make this session do
// what its person asked.
//
// When the CLI has just installed or updated the extension, the session must reload first, and
// the runtime still loaded may be older, with a consent check that doesn't know this command. So
// that arm is `<key>.reload.json`, which runtimes take only as they start, never after a tool.

type Env = Record<string, string | undefined>;
export type Arm = { host: string; ticket?: string; at: number };

export const ARM_TTL_MS = 10 * 60_000;
const KEY = /^[A-Za-z0-9_-]{1,128}$/;
export const validTicket = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);

export const armDir = (harness: string, env: Env = process.env) => join(stateDir(harness, env), "arm");
export const armPath = (harness: string, key: string, env: Env = process.env, reload = false) => {
  if (!KEY.test(key)) throw new Error("bad session key");
  return join(armDir(harness, env), `${key}${reload ? ".reload" : ""}.json`);
};

function parse(text: string, now: number): Arm | undefined {
  try {
    const raw = JSON.parse(text) as Partial<Arm>;
    if (typeof raw.host !== "string" || typeof raw.at !== "number" || now - raw.at > ARM_TTL_MS || raw.at > now + 60_000) return undefined;
    return { host: expandWorkspace(raw.host), at: raw.at, ...(validTicket(raw.ticket) ? { ticket: raw.ticket } : {}) };
  } catch { return undefined; }
}

// Private folder, private file, swapped in whole.
export function writeArm(harness: string, key: string, arm: { host: string; ticket?: string; reload?: boolean }, env: Env = process.env, now = Date.now()): string {
  const path = armPath(harness, key, env, arm.reload);
  mkdirSync(armDir(harness, env), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, JSON.stringify({ host: arm.host, ...(validTicket(arm.ticket) ? { ticket: arm.ticket } : {}), at: now })); }
  finally { closeSync(fd); }
  renameSync(temp, path);
  return path;
}

// One-shot pickup: the file is renamed away first, so of two runtimes racing only one gets it.
// Expired or broken files are deleted and ignored. `starting`: the runtime is starting, so it
// takes the arm left for after a reload too.
export function takeArm(harness: string, key: string, env: Env = process.env, now = Date.now(), starting = false): Arm | undefined {
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
  return parse(text, now);
}

// Turns Slirc itself delivers into the session carry a receipt; they never count as the person.
export const isDelivery = (text: string) => /Slirc delivery receipt: [0-9a-f-]{36}/.test(text);

const WORKSPACE = /^(?:https?:\/\/)?[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?\/?$/;
const VALUE = /^[A-Za-z0-9_-]{1,64}$/;

// What the person's own prompt asks for when it is the command and nothing else: an optional
// runner (bunx, npx, pnpm dlx), `slirc-agent` with an optional @version, an optional `connect`,
// the workspace, an optional connect code after it, and the --harness option (or 3.2.0's
// --ticket). One line, no quotes, no prose, so a mention ("don't run slirc-agent calango") or a
// pasted log never counts. No workspace means app.slirc.org, as for the CLI.
export function connectCommand(prompt: string | undefined): { host: string; ticket?: string } | undefined {
  if (!prompt || isDelivery(prompt)) return undefined;
  const line = prompt.trim();
  if (/[\r\n]/.test(line)) return undefined;
  const words = line.split(/[ \t]+/);
  let index = words[0] === "bunx" || words[0] === "npx" ? 1 : words[0] === "pnpm" && words[1] === "dlx" ? 2 : 0;
  if (!/^slirc-agent(?:@[\w.-]+)?$/.test(words[index] ?? "")) return undefined;
  if (words[index + 1] === "connect") index++;
  const positional: string[] = [];
  let ticket: string | undefined;
  for (index++; index < words.length; index++) {
    const word = words[index];
    if (word === "--ticket" || word === "--harness") {
      const value = words[++index] ?? "";
      if (!VALUE.test(value)) return undefined;
      if (word === "--ticket") ticket = value;
      continue;
    }
    const option = /^--(ticket|harness)=([A-Za-z0-9_-]{1,64})$/.exec(word);
    if (option) { if (option[1] === "ticket") ticket = option[2]; continue; }
    positional.push(word);
  }
  const [workspace, code, ...rest] = positional;
  if (rest.length || (workspace !== undefined && !WORKSPACE.test(workspace)) || (code !== undefined && !validTicket(code))) return undefined;
  ticket = code ?? ticket;
  if (ticket !== undefined && !validTicket(ticket)) ticket = undefined;
  try { return { host: expandWorkspace(workspace ?? ""), ...(ticket ? { ticket } : {}) }; } catch { return undefined; }
}

// Whether the person's own prompt is the command for this workspace; it must match the host the
// CLI armed.
export const consents = (prompt: string | undefined, host: string): boolean => connectCommand(prompt)?.host === host;
