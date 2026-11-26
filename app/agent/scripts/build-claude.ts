// Assembles dist/claude: a local Claude Code marketplace holding the Slirc plugin (the mod
// and its listener), which `slirc-agent` copies to the owner's machine and installs from.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist", "claude");
const plugin = join(out, "slirc");
const source = join(root, "src", "harnesses", "claude");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, ".claude-plugin"), { recursive: true });
cpSync(join(source, "mod"), plugin, { recursive: true });
const manifest = JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
cpSync(join(root, "LICENSE"), join(plugin, "LICENSE"));
writeFileSync(join(out, ".claude-plugin", "marketplace.json"), `${JSON.stringify({
  name: "slirc-agent",
  owner: { name: "Slirc", url: "https://slirc.org" },
  plugins: [{ name: "slirc", source: "./slirc", version, description: manifest.description }],
}, null, 2)}\n`);
const built = await Bun.build({ entrypoints: [join(source, "listener.ts")], target: "node", outdir: plugin, naming: "listener.js" });
if (!built.success) { console.error(built.logs.join("\n")); process.exit(1); }
