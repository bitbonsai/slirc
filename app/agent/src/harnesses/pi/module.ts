import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { harnessInfo } from "../../../../shared/harnesses.ts";
import type { Env, Harness, Step } from "../types.ts";

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
    const steps: Step[] = [];
    const folder = installedFolder(env);
    if (status.state === "outdated" && folder) {
      const listed = (probe(env, ["list"]) ?? "").split("\n").map((line) => line.trim()).find((line) => line === NPM_SOURCE || line.startsWith(`${NPM_SOURCE}@`)) ?? NPM_SOURCE;
      steps.push({ doing: `pi remove ${listed}`, apply: () => { run(env, ["remove", listed]); } });
    }
    steps.push({ doing: `pi install ${target}`, apply: () => { run(env, ["install", target]); } });
    return steps;
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
