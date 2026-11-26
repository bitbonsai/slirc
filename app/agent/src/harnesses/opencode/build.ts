// Assembles dist/opencode: the folder `slirc-agent` copies to <config>/opencode/plugins/slirc/.
// index.js is the server half, tui.js the TUI half, and package.json names both for OpenCode.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const out = join(root, "dist", "opencode");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [entry, name] of [["plugin.ts", "index.js"], ["tui.ts", "tui.js"]]) {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, entry)], target: "node", outdir: out, naming: name });
  if (!built.success) { console.error(built.logs.join("\n")); process.exit(1); }
}
writeFileSync(join(out, "package.json"), `${JSON.stringify({
  name: "slirc-agent-opencode", version, private: true, type: "module", license: "MIT",
  description: "Slirc for OpenCode 2, installed by slirc-agent",
  main: "index.js", exports: { ".": "./index.js", "./tui": "./tui.js" },
}, null, 2)}\n`);
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
