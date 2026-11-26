import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessInfo } from "../../../../shared/harnesses.ts";
import type { Env, Harness, Step } from "../types.ts";
import { onPath } from "../pi/module.ts";
import { codexVersion, unsupported, validId } from "./shared.ts";

// Codex loads Slirc as a plugin from a local marketplace: hooks (pairing, turn start and end, the
// listener's start) and a stdio MCP server with the slirc_* tools, both running one bundled file.
// The npm package carries the marketplace in dist/codex. Install copies it to a stable folder,
// writes the plugin's hooks.json and .mcp.json with the runtime's absolute path, and adds it with
// Codex's own CLI. Codex plugins are user-wide, so every Codex session gets the hooks; only a
// session that types `slirc <workspace>` or that Slirc allowed before starts anything.
// SLIRC_CODEX_SOURCE points at another marketplace folder in tests.

const MARKETPLACE = "slirc-agent";
const PLUGIN = `slirc@${MARKETPLACE}`;
const EVENTS = { SessionStart: 5, UserPromptSubmit: 20, Stop: 5, SessionEnd: 3 } as const;

function bundled(env: Env): string {
  if (env.SLIRC_CODEX_SOURCE) return env.SLIRC_CODEX_SOURCE;
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, "codex"), join(here, "..", "..", "..", "dist", "codex")].find((path) => existsSync(path)) ?? join(here, "codex");
}

const home = (env: Env) => env.HOME || homedir();
const target = (env: Env) => join(env.XDG_DATA_HOME || join(home(env), ".local", "share"), "slirc-agent", "codex");
const pluginDir = (env: Env) => join(target(env), "slirc");

function run(env: Env, args: string[]): string {
  const result = spawnSync("codex", args, { env, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return result.stdout;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? result.error?.message;
  throw new Error(`codex ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
}
const probe = (env: Env, args: string[]) => { try { return run(env, args); } catch { return undefined; } };
const json = (text: string | undefined) => { try { return JSON.parse(text ?? ""); } catch { return undefined; } };

type Listed = { pluginId: string; version?: string; installed?: boolean; enabled?: boolean };
const entry = (env: Env): Listed | undefined =>
  (json(probe(env, ["plugin", "list", "--json"]))?.installed as Listed[] | undefined)?.find((plugin) => plugin.pluginId === PLUGIN && plugin.installed !== false);
const marketplaceListed = (env: Env) =>
  ((json(probe(env, ["plugin", "marketplace", "list", "--json"]))?.marketplaces ?? []) as { name: string }[]).some((item) => item.name === MARKETPLACE);
const placedVersion = (env: Env): string | undefined => json(existsSync(join(pluginDir(env), ".codex-plugin", "plugin.json")) ? readFileSync(join(pluginDir(env), ".codex-plugin", "plugin.json"), "utf8") : "")?.version;
const ours = (env: Env) => existsSync(join(target(env), ".agents", "plugins", "marketplace.json"));
// A `slirc` MCP server in the person's Codex config: slirc-agent 2.x added one that runs
// `slirc-agent mcp codex`, which 3.0 dropped. It would shadow the plugin's server of that name.
// `codex mcp get` also lists the installed plugin's own server, which runs our slirc-codex.js.
function oldServer(env: Env): "ours" | "foreign" | undefined {
  const server = json(probe(env, ["mcp", "get", "slirc", "--json"]));
  if (!server?.transport) return undefined;
  const words = [server.transport.command, ...(server.transport.args ?? [])].map(String);
  if (words.includes(join(pluginDir(env), "slirc-codex.js"))) return undefined;
  return words.some((word) => /(^|\/)slirc-agent(@|$)/.test(word)) ? "ours" : "foreign";
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

// Copy the marketplace and point the plugin's hooks and MCP server at the runtime that runs them,
// so they work without Node on machines that have only Bun.
function place(env: Env): void {
  rmSync(target(env), { recursive: true, force: true });
  cpSync(bundled(env), target(env), { recursive: true });
  const exec = env.SLIRC_CODEX_RUNTIME || process.execPath;
  const script = join(pluginDir(env), "slirc-codex.js");
  const hooks = Object.fromEntries(Object.entries(EVENTS).map(([event, timeout]) =>
    [event, [{ hooks: [{ type: "command", command: `${quote(exec)} ${quote(script)} hook ${event}`, timeout }] }]]));
  writeFileSync(join(pluginDir(env), "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);
  // The slirc_* tools post only to the room Slirc fixed for the request, or read it, so they run
  // without an approval prompt, like Pi's and Claude Code's. Codex starts MCP servers with a short
  // list of variables; XDG_STATE_HOME, when set, says where the listeners announce themselves.
  writeFileSync(join(pluginDir(env), ".mcp.json"), `${JSON.stringify({ mcpServers: { slirc: { command: exec, args: [script, "mcp"], env_vars: ["XDG_STATE_HOME"], default_tools_approval_mode: "approve" } } }, null, 2)}\n`);
}

function conflict(env: Env): string | undefined {
  const old = unsupported(codexVersion(probe(env, ["--version"])));
  if (old) return old;
  if (existsSync(target(env)) && !ours(env)) return `${target(env)} exists but isn't the Slirc marketplace. Move it away, then run this again.`;
  if (oldServer(env) === "foreign") return "Your Codex config has an MCP server named slirc that Slirc didn't add, and it would hide Slirc's. Remove it with codex mcp remove slirc, or give it another name, then run this again.";
  return undefined;
}

const codex: Harness = {
  ...harnessInfo.codex,
  // Codex gives its shell tool the thread id; the hooks read the same id as session_id.
  sessionKey: (env) => validId(env.CODEX_THREAD_ID) ? env.CODEX_THREAD_ID : undefined,

  detect(env) {
    const found = onPath(env, "codex");
    const version = found ? codexVersion(probe(env, ["--version"])) : undefined;
    return { installed: found, inside: !!env.CODEX_THREAD_ID, ...(version ? { version } : {}) };
  },

  status(env, version) {
    if (!onPath(env, "codex")) return { state: "missing" };
    const blocked = conflict(env);
    if (blocked) return { state: "conflict", detail: blocked };
    const listed = entry(env);
    if (!listed) return { state: "missing" };
    const current = listed.version === version && listed.enabled !== false && placedVersion(env) === version && existsSync(join(pluginDir(env), "hooks.json")) && !oldServer(env);
    return { state: current ? "current" : "outdated", ...(listed.version ? { version: listed.version } : {}) };
  },

  install(env, version) {
    const status = codex.status(env, version);
    if (status.state === "current" || status.state === "conflict" || !onPath(env, "codex")) return [];
    const steps: Step[] = [];
    if (oldServer(env) === "ours") steps.push({ doing: "codex mcp remove slirc (left by slirc-agent 2.x)", apply: () => { run(env, ["mcp", "remove", "slirc"]); } });
    if (placedVersion(env) !== version || !existsSync(join(pluginDir(env), "hooks.json"))) steps.push({ doing: `copy the Slirc plugin to ${target(env)}`, apply: () => place(env) });
    if (!marketplaceListed(env)) steps.push({ doing: `codex plugin marketplace add ${target(env)}`, apply: () => { run(env, ["plugin", "marketplace", "add", target(env)]); } });
    // `add` installs the version the marketplace holds now, over an older one, and turns it on.
    const listed = entry(env);
    if (!listed || listed.version !== version || listed.enabled === false || placedVersion(env) !== version) steps.push({ doing: `codex plugin add ${PLUGIN}`, apply: () => { run(env, ["plugin", "add", PLUGIN]); } });
    return steps;
  },

  uninstall(env) {
    const steps: Step[] = [];
    if (oldServer(env) === "ours") steps.push({ doing: "codex mcp remove slirc (left by slirc-agent 2.x)", apply: () => { run(env, ["mcp", "remove", "slirc"]); } });
    if (entry(env)) steps.push({ doing: `codex plugin remove ${PLUGIN}`, apply: () => { run(env, ["plugin", "remove", PLUGIN]); } });
    if (marketplaceListed(env)) steps.push({ doing: `codex plugin marketplace remove ${MARKETPLACE}`, apply: () => { run(env, ["plugin", "marketplace", "remove", MARKETPLACE]); } });
    if (ours(env)) steps.push({ doing: `delete ${target(env)}`, apply: () => rmSync(target(env), { recursive: true, force: true }) });
    return steps;
  },

  // Hooks run under the shared Codex daemon with the environment of whichever TUI started it, so
  // SLIRC_CONNECT wouldn't reach them. The launch types the pairing command as the first prompt
  // instead, which the UserPromptSubmit hook catches before the model sees it. The connect code
  // rides in that prompt for the same reason.
  launch(host, env, extra) {
    const ticket = env.SLIRC_CONNECT_TICKET;
    return { bin: "codex", args: [...extra, `slirc ${host}${ticket ? ` ${ticket}` : ""}`], env };
  },
};

export default codex;
