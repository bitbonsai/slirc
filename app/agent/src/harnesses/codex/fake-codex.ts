import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in `codex` on PATH for the Codex module and runtime tests. It answers the plugin
// commands the module runs, keeps marketplaces and plugins in a file, reads plugin versions from
// the added marketplace folder, records `codex queue` messages, and logs every call. Nothing here
// touches the real Codex.
export type FakeCodex = {
  root: string; env: Record<string, string>; calls(): string[]; queued(): { thread: string; message: string }[];
  plugins(): { pluginId: string; version: string; enabled: boolean }[]; marketplaces(): { name: string; root: string }[];
  addServer(name: string, transport: { type: string; command: string; args: string[] }): void; servers(): Record<string, unknown>; done(): void;
};

const handler = `
const fs = require("fs"), path = require("path");
const [db, log, version] = process.argv.slice(2, 5);
const args = process.argv.slice(5);
fs.appendFileSync(log, args.join(" ") + "\\n");
const state = JSON.parse(fs.readFileSync(db, "utf8"));
const save = () => fs.writeFileSync(db, JSON.stringify(state));
const fail = (text) => { console.error(text); process.exit(1); };
const [a, b, c, d] = args;
if (a === "--version") console.log("codex-cli " + version);
else if (a === "plugin" && b === "list") console.log(JSON.stringify({ installed: state.plugins.map((p) => ({ ...p, installed: true })), available: [] }));
else if (a === "plugin" && b === "marketplace" && c === "list") console.log(JSON.stringify({ marketplaces: state.marketplaces }));
else if (a === "plugin" && b === "marketplace" && c === "add") {
  const name = JSON.parse(fs.readFileSync(path.join(d, ".agents", "plugins", "marketplace.json"), "utf8")).name;
  if (state.marketplaces.some((m) => m.name === name)) fail("marketplace already added");
  state.marketplaces.push({ name, root: d }); save();
}
else if (a === "plugin" && b === "marketplace" && c === "remove") { state.marketplaces = state.marketplaces.filter((m) => m.name !== d); save(); }
else if (a === "plugin" && b === "add") {
  const [name, market] = c.split("@");
  const m = state.marketplaces.find((x) => x.name === market) || fail("no such marketplace");
  const manifest = JSON.parse(fs.readFileSync(path.join(m.root, name, ".codex-plugin", "plugin.json"), "utf8"));
  state.plugins = state.plugins.filter((p) => p.pluginId !== c).concat({ pluginId: c, version: manifest.version, enabled: true }); save();
}
else if (a === "plugin" && b === "remove") { state.plugins = state.plugins.filter((p) => p.pluginId !== c); save(); }
else if (a === "mcp" && b === "get") { const server = state.mcp && state.mcp[c]; if (server) console.log(JSON.stringify({ name: c, transport: server })); else { console.error("Error: No MCP server named '" + c + "' found."); } }
else if (a === "mcp" && b === "remove") { if (state.mcp) delete state.mcp[c]; save(); }
else if (a === "queue") {
  if (process.env.FAKE_CODEX_QUEUE_FAIL) fail("thread not found");
  state.queued.push({ thread: args[args.indexOf("--thread") + 1], message: args[args.indexOf("--message") + 1] }); save();
  console.log("Queued message");
}
else console.log("launched codex args=" + args.join(" "));
`;

export function fakeCodex(options: { version?: string } = {}): FakeCodex {
  const root = mkdtempSync(join(tmpdir(), "slirc-fake-codex-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const db = join(root, "state.json");
  const log = join(root, "calls.log");
  writeFileSync(db, JSON.stringify({ plugins: [], marketplaces: [], queued: [] }));
  writeFileSync(log, "");
  writeFileSync(join(root, "handler.cjs"), handler);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "handler.cjs")}" "${db}" "${log}" "${options.version ?? "0.170.0"}" "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  const env = {
    PATH: [bin, "/usr/bin", "/bin"].join(":"), HOME: home, XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"),
    CODEX_HOME: join(home, ".codex"), SLIRC_CODEX_RUNTIME: "/usr/bin/true",
  };
  const read = () => JSON.parse(readFileSync(db, "utf8"));
  return {
    root, env,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    queued: () => read().queued,
    plugins: () => read().plugins,
    marketplaces: () => read().marketplaces,
    addServer(name, transport) { const state = read(); state.mcp = { ...(state.mcp ?? {}), [name]: transport }; writeFileSync(db, JSON.stringify(state)); },
    servers: () => read().mcp ?? {},
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}
