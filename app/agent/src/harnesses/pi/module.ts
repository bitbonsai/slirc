import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { harnessInfo } from "../../../../shared/harnesses.ts";
import type { Env, Harness } from "../types.ts";

// Pi loads Slirc as a Pi package: `pi install npm:slirc-agent` adds it to Pi's settings, and the
// package's `pi.extensions` entry (./extension.ts, built to dist/pi-extension.js) runs inside every
// Pi session. SLIRC_PI_SOURCE swaps the npm source for a local folder in tests and development.

const NPM_SOURCE = "npm:slirc-agent";
const source = (env: Env) => env.SLIRC_PI_SOURCE || NPM_SOURCE;
const agentDir = (env: Env) => env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");

export function onPath(env: Env, bin: string): boolean {
  return (env.PATH ?? "").split(delimiter).some((dir) => {
    try { return dir !== "" && statSync(join(dir, bin)).isFile(); } catch { return false; }
  });
}

function run(env: Env, args: string[]): string {
  const result = spawnSync("pi", args, { env, encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return result.stdout;
  const lines = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("Warning:"));
  const detail = lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? result.error?.message;
  throw new Error(`pi ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
}

const probe = (env: Env, args: string[]) => { try { return run(env, args); } catch { return undefined; } };

// Right after a release npm can answer ETARGET for the new version for a little while. Tests
// shorten the wait.
export const npmRetry = { tries: 6, waitMs: 5_000 };
const pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// `pi install npm:slirc-agent@<version>` replaces any slirc-agent entry Pi has, and a failed one
// leaves it as it was, so an update never removes the working extension first.
function install(env: Env, target: string, version: string): void {
  for (let attempt = 1; ; attempt++) {
    try { run(env, ["install", target]); return; }
    catch (error) {
      if (!/ETARGET|notarget/i.test(error instanceof Error ? error.message : String(error))) throw error;
      if (attempt >= npmRetry.tries) throw new Error(`npm doesn't offer slirc-agent ${version} yet. That's a short delay npm has after each release. Wait a minute, then run this again.`);
      pause(npmRetry.waitMs);
    }
  }
}

// `pi list` prints each source, then its installed folder on the next line.
export function installedFolder(env: Env, listing = probe(env, ["list"]) ?? ""): string | undefined {
  const lines = listing.split("\n").map((line) => line.trim());
  const wanted = source(env);
  const local = existsSync(wanted) ? realpathSync(wanted) : undefined;
  for (let index = 0; index < lines.length - 1; index++) {
    const folder = lines[index + 1];
    const named = lines[index] === wanted || lines[index].startsWith(`${wanted}@`);
    const same = local !== undefined && existsSync(folder) && realpathSync(folder) === local;
    if (named || same) return folder;
  }
  return undefined;
}

function packageVersion(folder: string): string | undefined {
  try { return JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).version; } catch { return undefined; }
}

// A hand-made Slirc extension in Pi's extensions folder would load next to the package.
function conflict(env: Env): string | undefined {
  const dir = join(agentDir(env), "extensions");
  const found = ["slirc.ts", "slirc.js", "slirc"].map((name) => join(dir, name)).find((path) => existsSync(path));
  return found ? `${found} is another Slirc extension. Move it out of ${dir}, then run this again.` : undefined;
}

const pi: Harness = {
  ...harnessInfo.pi,
  // Pi's bash tool exports the session id (docs/environment-variables.md), Pi 1.5 on.
  sessionKey: (env) => env.PI_CODING_AGENT === "true" && env.PI_SESSION_ID ? env.PI_SESSION_ID : undefined,

  detect(env) {
    const installed = onPath(env, "pi");
    const version = installed ? probe(env, ["--version"])?.trim().split("\n").at(-1) : undefined;
    return { installed, inside: env.PI_CODING_AGENT === "true", ...(version ? { version } : {}) };
  },

  status(env, version) {
    const blocked = conflict(env);
    if (blocked) return { state: "conflict", detail: blocked };
    const folder = installedFolder(env);
    if (!folder) return { state: "missing" };
    const installed = packageVersion(folder);
    // A local source is whatever is in the folder; only npm versions can be behind.
    if (env.SLIRC_PI_SOURCE) return { state: "current", ...(installed ? { version: installed } : {}) };
    if (!installed || installed !== version) return { state: "outdated", ...(installed ? { version: installed } : {}) };
    return { state: "current", version: installed };
  },

  install(env, version) {
    const status = pi.status(env, version);
    if (status.state === "current" || status.state === "conflict") return [];
    // Pinning the exact version makes Pi fetch it even when npm's cache holds an older one.
    const target = env.SLIRC_PI_SOURCE ? resolve(env.SLIRC_PI_SOURCE) : `${NPM_SOURCE}@${version}`;
    return [{ doing: `pi install ${target}`, apply: () => install(env, target, version) }];
  },

  uninstall(env) {
    const listed = (probe(env, ["list"]) ?? "").split("\n").map((line) => line.trim()).find((line) => line === source(env) || line.startsWith(`${NPM_SOURCE}@`));
    return listed ? [{ doing: `pi remove ${listed}`, apply: () => { run(env, ["remove", listed]); } }] : [];
  },

  launch(host, env, extra) {
    return { bin: "pi", args: extra, env: { ...env, SLIRC_CONNECT: host } };
  },
};

export default pi;
