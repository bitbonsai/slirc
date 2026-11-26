import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env, Harness } from "../types.ts";
import { onPath } from "../pi/module.ts";
import { unsupported } from "./shared.ts";

// OpenCode 2 loads Slirc as a local plugin folder, <config>/opencode/plugins/slirc/, which it
// reads for both halves: index.js runs in the background service, tui.js in each TUI. Install
// copies dist/opencode there. `opencode plugin add` takes only npm or git specs, and the npm
// package doesn't carry the plugin until it ships, so the folder is the documented local path.
// SLIRC_OPENCODE_SOURCE points at another built folder in tests.

const PACKAGE = "slirc-agent-opencode";

function bundled(env: Env): string {
  if (env.SLIRC_OPENCODE_SOURCE) return env.SLIRC_OPENCODE_SOURCE;
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "opencode"), join(here, "..", "..", "..", "dist", "opencode")].find((path) => existsSync(path)) ?? join(here, "opencode");
}

const configHome = (env: Env) => env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
export const pluginFolder = (env: Env) => join(configHome(env), "opencode", "plugins", "slirc");

const manifest = (folder: string): { name?: string; version?: string } | undefined => {
  try { return JSON.parse(readFileSync(join(folder, "package.json"), "utf8")); } catch { return undefined; }
};

// `opencode --version` prints "opencode v2.3.2".
function version(env: Env): string | undefined {
  if (!onPath(env, "opencode")) return undefined;
  const result = spawnSync("opencode", ["--version"], { env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0 ? result.stdout.trim().match(/v?(\d+\.\d+\.\d+\S*)/)?.[1] : undefined;
}

// slirc-agent 2.x wrote index.js and tui.js to the same folder, with no package.json. It is ours
// to replace; anything else there is someone else's.
function legacy(folder: string): boolean {
  if (existsSync(join(folder, "package.json"))) return false;
  try { return readFileSync(join(folder, "index.js"), "utf8").includes("slirc-agent.opencode.v2"); } catch { return false; }
}

function conflict(env: Env): string | undefined {
  const refused = unsupported(version(env));
  if (refused) return refused;
  const folder = pluginFolder(env);
  if (existsSync(folder) && manifest(folder)?.name !== PACKAGE && !legacy(folder)) return `${folder} is another plugin named slirc. Move it out of ${dirname(folder)}, then run this again.`;
  return undefined;
}

const opencode: Harness = {
  id: "opencode",
  name: "OpenCode",
  released: true,
  homepage: "https://opencode.ai",
  sessionCommand: (workspace) => workspace ? `/slirc ${workspace}` : "/slirc",
  // No reloadHint: install ends with `opencode reload`, which loads the plugin into the running
  // service and TUI.

  // OpenCode gives its shell tool OPENCODE_SESSION_ID. Every session's shell runs under the one
  // background service, so the arm file's process check can't tell sessions apart here; the
  // consent check on that session's own latest prompt still has to pass.
  sessionKey: (env) => env.OPENCODE === "1" && env.OPENCODE_SESSION_ID ? env.OPENCODE_SESSION_ID : undefined,

  detect(env) {
    const found = version(env);
    return { installed: onPath(env, "opencode"), inside: env.OPENCODE === "1", ...(found ? { version: found } : {}) };
  },

  status(env, wanted) {
    const blocked = conflict(env);
    if (blocked) return { state: "conflict", detail: blocked };
    if (legacy(pluginFolder(env))) return { state: "outdated", version: "2.x" };
    const installed = manifest(pluginFolder(env))?.version;
    if (!installed) return { state: "missing" };
    return { state: installed === wanted ? "current" : "outdated", version: installed };
  },

  install(env, wanted) {
    const status = opencode.status(env, wanted);
    if (status.state === "current" || status.state === "conflict") return [];
    const folder = pluginFolder(env);
    return [{
      doing: `copy the Slirc plugin to ${folder}`,
      apply: () => {
        const source = bundled(env);
        const found = manifest(source)?.version;
        if (manifest(source)?.name !== PACKAGE) throw new Error(`The Slirc plugin for OpenCode is missing from ${source}. Reinstall slirc-agent, then run this again.`);
        if (found !== wanted && !env.SLIRC_OPENCODE_SOURCE) throw new Error(`The bundled OpenCode plugin is ${found}, not ${wanted}. Reinstall slirc-agent, then run this again.`);
        mkdirSync(dirname(folder), { recursive: true });
        rmSync(folder, { recursive: true, force: true });
        cpSync(source, folder, { recursive: true });
      },
    }, {
      // A running service picks up a changed plugin it already knows, but not a new one, until
      // reloaded. Reload also starts the service when none runs, as opening OpenCode would.
      doing: "reload OpenCode so it loads the plugin",
      apply: () => {
        const result = spawnSync("opencode", ["reload"], { env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
        if (result.status !== 0) throw new Error("opencode reload failed. Quit OpenCode and start it again, then type /slirc in a session.");
      },
    }];
  },

  uninstall(env) {
    const folder = pluginFolder(env);
    return manifest(folder)?.name === PACKAGE || legacy(folder) ? [{ doing: `delete ${folder}`, apply: () => rmSync(folder, { recursive: true, force: true }) }] : [];
  },

  // The TUI half reads SLIRC_CONNECT once and pairs the first session the person opens.
  launch(host, env, extra) {
    return { bin: "opencode", args: extra, env: { ...env, SLIRC_CONNECT: host } };
  },
};

export default opencode;
