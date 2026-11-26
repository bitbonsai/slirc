import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessInfo } from "../../../../shared/harnesses.ts";
import type { Env, Harness, Step } from "../types.ts";
import { onPath } from "../pi/module.ts";
import { compareVersions } from "../../version.ts";

// Claude Code loads Slirc as a plugin with a hooks module (a mod) and a listener child. The npm
// package carries them as a local marketplace in dist/claude. Install copies that folder to a
// stable place, adds it as the `slirc-agent` marketplace and turns `slirc@slirc-agent` on at
// Claude Code's local scope for the folder slirc-agent runs in (its .claude/settings.local.json,
// which git doesn't commit), with Claude Code's own CLI. Sessions in other folders load nothing.
// SLIRC_CLAUDE_SOURCE points at another marketplace folder in tests, SLIRC_FOLDER at the folder.

const MARKETPLACE = "slirc-agent";
const PLUGIN = `slirc@${MARKETPLACE}`;

// dist/claude next to the built CLI, or next to this file's package when run from source.
function bundled(env: Env): string {
  if (env.SLIRC_CLAUDE_SOURCE) return env.SLIRC_CLAUDE_SOURCE;
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "claude"), join(here, "..", "..", "..", "dist", "claude")].find((path) => existsSync(path)) ?? join(here, "claude");
}

const home = (env: Env) => env.HOME || homedir();
// The installed copy keeps its 3.1.0 folder name: Claude Code keys each folder's install on this
// marketplace path, so moving it would drop the plugin from every folder set up before.
const target = (env: Env) => join(env.XDG_DATA_HOME || join(home(env), ".local", "share"), "slirc-agent", "claude-code");
const configDir = (env: Env) => env.CLAUDE_CONFIG_DIR || join(home(env), ".claude");

// The folder whose Claude Code sessions get Slirc: where slirc-agent runs.
const folder = (env: Env) => { const path = env.SLIRC_FOLDER || process.cwd(); try { return realpathSync(path); } catch { return path; } };

function run(env: Env, args: string[]): string {
  const result = spawnSync("claude", args, { env, cwd: folder(env), encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return result.stdout;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? result.error?.message;
  throw new Error(`claude ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
}

const probe = (env: Env, args: string[]) => { try { return run(env, args); } catch { return undefined; } };

type Listed = { id: string; version?: string; enabled?: boolean; scope?: string; projectPath?: string };
function entries(env: Env): Listed[] {
  try { return (JSON.parse(probe(env, ["plugin", "list", "--json"]) ?? "[]") as Listed[]).filter((plugin) => plugin.id === PLUGIN); }
  catch { return []; }
}
// Ours for this folder, and the user-wide one an earlier slirc-agent 3.1 install added.
const here = (env: Env, list = entries(env)) => list.find((entry) => entry.scope === "local" && entry.projectPath === folder(env));
const userWide = (env: Env, list = entries(env)) => list.find((entry) => entry.scope === "user");

const marketplaceListed = (env: Env) => {
  try { return (JSON.parse(probe(env, ["plugin", "marketplace", "list", "--json"]) ?? "[]") as { name: string }[]).some((item) => item.name === MARKETPLACE); }
  catch { return false; }
};

// Managed settings that stop a person's mod from loading. The organization sets these, so the
// owner can only ask their admin; the plugin is never installed where it would sit there dead.
const BLOCKERS: Record<string, string> = {
  allowManagedModsOnly: "allows only mods your organization manages",
  allowManagedHooksOnly: "allows only hooks your organization manages",
  disableAllHooks: "turns hooks off",
};
function managedFiles(env: Env): string[] {
  const dirs = env.SLIRC_CLAUDE_MANAGED_DIR ? [env.SLIRC_CLAUDE_MANAGED_DIR]
    : process.platform === "darwin" ? ["/Library/Application Support/ClaudeCode"] : ["/etc/claude-code"];
  const files: string[] = [join(configDir(env), "remote-settings.json")];
  for (const dir of dirs) {
    files.push(join(dir, "managed-settings.json"));
    try { for (const name of readdirSync(join(dir, "managed-settings.d")).sort()) if (name.endsWith(".json")) files.push(join(dir, "managed-settings.d", name)); } catch {}
  }
  return files;
}
export function blockedBy(env: Env): string | undefined {
  for (const file of managedFiles(env)) {
    let settings: Record<string, unknown>;
    try { settings = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    const key = Object.keys(BLOCKERS).find((name) => settings[name] === true);
    if (key) return `Your organization's Claude Code settings (${key} in ${file}) ${BLOCKERS[key]}, so the Slirc plugin can't load. Ask your Claude Code admin to allow it, or use Pi with Slirc instead.`;
  }
  return undefined;
}

// Hooks modules (mods), which the plugin is, load from Claude Code 2.1.286 on. An older one would
// install the plugin and run none of it.
const MIN_CLAUDE = "2.1.286";
function tooOld(env: Env): string | undefined {
  const found = probe(env, ["--version"])?.trim().split(" ")[0];
  if (!found || !/^\d+\.\d+\.\d+/.test(found) || compareVersions(found, MIN_CLAUDE) >= 0) return undefined;
  return `Slirc needs Claude Code ${MIN_CLAUDE} or newer, and this is ${found}. Run claude update, then run this again.`;
}

// A plugin of someone else's named slirc in our marketplace's place.
function conflict(env: Env): string | undefined {
  const blocked = blockedBy(env) ?? tooOld(env);
  if (blocked) return blocked;
  const placed = join(target(env), ".claude-plugin", "marketplace.json");
  if (existsSync(target(env)) && !existsSync(placed)) return `${target(env)} exists but isn't the Slirc marketplace. Move it away, then run this again.`;
  return undefined;
}

// Copy the marketplace to its stable folder and record the runtime that runs the listener, so it
// works without Node on machines that have only Bun.
function place(env: Env): void {
  rmSync(target(env), { recursive: true, force: true });
  cpSync(bundled(env), target(env), { recursive: true });
  writeFileSync(join(target(env), "slirc", "runtime.json"), `${JSON.stringify({ exec: env.SLIRC_CLAUDE_RUNTIME || process.execPath })}\n`);
}

const claude: Harness = {
  ...harnessInfo.claude,
  // Claude Code keeps a personal /slirc skill or command and gives the plugin's the next name.
  localCommand(env, workspace) {
    const own = [join(configDir(env), "skills", "slirc"), join(configDir(env), "commands", "slirc.md")].some((path) => existsSync(path));
    const name = own ? "/slirc-connect" : "/slirc";
    return workspace ? `${name} ${workspace}` : name;
  },
  // Claude Code sets this for its Bash tool: the same id the mod reads with $.session.id().
  sessionKey: (env) => env.CLAUDECODE === "1" && env.CLAUDE_CODE_SESSION_ID ? env.CLAUDE_CODE_SESSION_ID : undefined,

  detect(env) {
    const found = onPath(env, "claude");
    const version = found ? probe(env, ["--version"])?.trim().split(" ")[0] : undefined;
    return { installed: found, inside: env.CLAUDECODE === "1", ...(version ? { version } : {}) };
  },

  status(env, version) {
    const blocked = conflict(env);
    if (blocked) return { state: "conflict", detail: blocked };
    const list = entries(env);
    const listed = here(env, list);
    if (!listed) return { state: "missing" };
    const current = listed.version === version && listed.enabled !== false && !userWide(env, list);
    return { state: current ? "current" : "outdated", ...(listed.version ? { version: listed.version } : {}) };
  },

  install(env, version) {
    const status = claude.status(env, version);
    if (status.state === "current" || status.state === "conflict") return [];
    const list = entries(env);
    const listed = here(env, list);
    const steps: Step[] = [];
    const placedVersion = (() => { try { return JSON.parse(readFileSync(join(target(env), "slirc", ".claude-plugin", "plugin.json"), "utf8")).version; } catch { return undefined; } })();
    if (placedVersion !== version) {
      steps.push({ doing: `copy the Slirc plugin to ${target(env)}`, apply: () => place(env) });
      if (!marketplaceListed(env)) steps.push({ doing: `claude plugin marketplace add ${target(env)}`, apply: () => { run(env, ["plugin", "marketplace", "add", target(env)]); } });
      else steps.push({ doing: `claude plugin marketplace update ${MARKETPLACE}`, apply: () => { run(env, ["plugin", "marketplace", "update", MARKETPLACE]); } });
    } else if (!marketplaceListed(env)) steps.push({ doing: `claude plugin marketplace add ${target(env)}`, apply: () => { run(env, ["plugin", "marketplace", "add", target(env)]); } });
    if (!listed) steps.push({ doing: `claude plugin install ${PLUGIN} --scope local (in ${folder(env)})`, apply: () => { run(env, ["plugin", "install", PLUGIN, "--scope", "local"]); } });
    else {
      if (listed.version !== version) steps.push({ doing: `claude plugin update ${PLUGIN} --scope local`, apply: () => { run(env, ["plugin", "update", PLUGIN, "--scope", "local"]); } });
      if (listed.enabled === false) steps.push({ doing: `claude plugin enable ${PLUGIN} --scope local`, apply: () => { run(env, ["plugin", "enable", PLUGIN, "--scope", "local"]); } });
    }
    // Once this folder has it, take back the user-wide switch-on 3.1.0 used, so other folders load nothing.
    if (userWide(env, list)) steps.push({ doing: `claude plugin uninstall ${PLUGIN} --scope user`, apply: () => { run(env, ["plugin", "uninstall", PLUGIN, "--scope", "user"]); } });
    return steps;
  },

  // Turns Slirc off for this folder. The marketplace and its copy go when no folder uses them.
  uninstall(env) {
    const list = entries(env);
    const steps: Step[] = [];
    const mine = list.filter((entry) => entry === here(env, list) || entry.scope === "user");
    for (const entry of mine) steps.push({ doing: `claude plugin uninstall ${PLUGIN} --scope ${entry.scope}`, apply: () => { run(env, ["plugin", "uninstall", PLUGIN, "--scope", String(entry.scope)]); } });
    if (mine.length === list.length) {
      if (marketplaceListed(env)) steps.push({ doing: `claude plugin marketplace remove ${MARKETPLACE}`, apply: () => { run(env, ["plugin", "marketplace", "remove", MARKETPLACE]); } });
      if (existsSync(join(target(env), ".claude-plugin", "marketplace.json"))) steps.push({ doing: `delete ${target(env)}`, apply: () => rmSync(target(env), { recursive: true, force: true }) });
    }
    return steps;
  },

  launch(host, env, extra) {
    return { bin: "claude", args: extra, env: { ...env, SLIRC_CONNECT: host } };
  },
};

export default claude;
