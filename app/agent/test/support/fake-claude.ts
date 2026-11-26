import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in `claude` on PATH for harness module tests. It answers the plugin commands the Claude
// Code module runs, keeps marketplaces and plugins in a file, reads the version from the added
// marketplace folder, and logs every call. Nothing here touches the real Claude Code.
export type FakeClaude = {
  root: string; env: Record<string, string>; calls(): string[];
  plugins(): { id: string; version: string; enabled: boolean; scope: string; projectPath?: string }[]; marketplaces(): { name: string; path: string }[];
  addPlugin(id: string, version: string, options?: { enabled?: boolean; scope?: string; projectPath?: string }): void; done(): void;
};

const handler = `
const fs = require("fs"), path = require("path");
const [db, log, version] = process.argv.slice(2, 5);
const args = process.argv.slice(5);
fs.appendFileSync(log, args.join(" ") + "\\n");
const state = JSON.parse(fs.readFileSync(db, "utf8"));
const save = () => fs.writeFileSync(db, JSON.stringify(state));
const fromMarket = (name) => { const m = state.marketplaces.find((x) => x.name === name); return JSON.parse(fs.readFileSync(path.join(m.path, ".claude-plugin", "marketplace.json"), "utf8")); };
const fail = (text) => { console.error(text); process.exit(1); };
const [a, b, c] = args;
if (a === "--version") console.log(version + " (Claude Code)");
else if (a === "plugin" && b === "list") console.log(JSON.stringify(state.plugins));
else if (a === "plugin" && b === "marketplace" && c === "list") console.log(JSON.stringify(state.marketplaces));
else if (a === "plugin" && b === "marketplace" && c === "add") { const dir = args[3]; const name = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), "utf8")).name; state.marketplaces.push({ name, path: dir }); save(); }
else if (a === "plugin" && b === "marketplace" && c === "update") { if (!state.marketplaces.some((x) => x.name === args[3])) fail("no such marketplace"); }
else if (a === "plugin" && b === "marketplace" && c === "remove") { state.marketplaces = state.marketplaces.filter((x) => x.name !== args[3]); save(); }
else if (a === "plugin" && ["install", "update", "enable", "uninstall"].includes(b)) {
  const at = args.indexOf("--scope");
  const scope = at >= 0 ? args[at + 1] : "user";
  const projectPath = scope === "user" ? undefined : fs.realpathSync(process.cwd());
  const same = (p) => p.id === c && p.scope === scope && p.projectPath === projectPath;
  if (b === "uninstall") state.plugins = state.plugins.filter((p) => !same(p));
  else if (b === "enable") state.plugins.forEach((p) => { if (same(p)) p.enabled = true; });
  else {
    const [name, market] = c.split("@");
    const entry = fromMarket(market).plugins.find((p) => p.name === name) || fail("not in marketplace");
    state.plugins = state.plugins.filter((p) => !same(p)).concat({ id: c, version: entry.version, enabled: true, scope, ...(projectPath ? { projectPath } : {}) });
  }
  save();
}
else console.log("launched claude SLIRC_CONNECT=" + (process.env.SLIRC_CONNECT || "") + " args=" + args.join(" "));
`;

export function fakeClaude(options: { version?: string } = {}): FakeClaude {
  const root = mkdtempSync(join(tmpdir(), "slirc-fake-claude-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const db = join(root, "state.json");
  const log = join(root, "calls.log");
  writeFileSync(db, JSON.stringify({ plugins: [], marketplaces: [] }));
  writeFileSync(log, "");
  writeFileSync(join(root, "handler.cjs"), handler);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "handler.cjs")}" "${db}" "${log}" "${options.version ?? "2.1.326"}" "$@"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const env = {
    PATH: [bin, "/usr/bin", "/bin"].join(":"), HOME: home, XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"), SLIRC_FOLDER: project, SLIRC_CLAUDE_MANAGED_DIR: join(root, "managed"), SLIRC_CLAUDE_RUNTIME: "/usr/bin/true",
  };
  const read = () => JSON.parse(readFileSync(db, "utf8"));
  return {
    root, env,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    plugins: () => read().plugins,
    marketplaces: () => read().marketplaces,
    addPlugin(id, version, options = {}) { const state = read(); state.plugins.push({ id, version, enabled: options.enabled ?? true, scope: options.scope ?? "user", ...(options.projectPath ? { projectPath: options.projectPath } : {}) }); writeFileSync(db, JSON.stringify(state)); },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}
