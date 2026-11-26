// Assembles dist/codex: a local Codex marketplace holding the Slirc plugin, which `slirc-agent`
// copies to the owner's machine and installs with `codex plugin add`. The plugin's hooks.json and
// .mcp.json name the runtime by absolute path, so install writes them (see module.ts).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const out = join(root, "dist", "codex");
const plugin = join(out, "slirc");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const DESCRIPTION = "Connect this Codex session to a Slirc workspace: Slirc requests arrive as turns and the model replies with slirc_reply.";

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, ".agents", "plugins"), { recursive: true });
mkdirSync(join(plugin, ".codex-plugin"), { recursive: true });
writeFileSync(join(out, ".agents", "plugins", "marketplace.json"), `${JSON.stringify({
  name: "slirc-agent",
  plugins: [{ name: "slirc", source: { source: "local", path: "./slirc" } }],
}, null, 2)}\n`);
writeFileSync(join(plugin, ".codex-plugin", "plugin.json"), `${JSON.stringify({
  name: "slirc", version, description: DESCRIPTION, license: "MIT", homepage: "https://app.slirc.org/docs/agents",
  hooks: "./hooks.json", mcpServers: "./.mcp.json",
}, null, 2)}\n`);
cpSync(join(root, "LICENSE"), join(plugin, "LICENSE"));
const built = await Bun.build({ entrypoints: [join(import.meta.dir, "runtime.ts")], target: "node", outdir: plugin, naming: "slirc-codex.js" });
if (!built.success) { console.error(built.logs.join("\n")); process.exit(1); }
