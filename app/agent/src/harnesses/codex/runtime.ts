import { readFileSync } from "node:fs";
import { errorText } from "../../adapter-core.ts";
import { hook } from "./hook.ts";
import { main, type Config } from "./listener.ts";
import { serve } from "./mcp.ts";
import { forCodex } from "./shared.ts";

// The one file the Slirc Codex plugin runs, built to dist/codex/slirc/slirc-codex.js:
//   slirc-codex.js hook <Event>   a Codex hook, event JSON on stdin, answer on stdout
//   slirc-codex.js mcp            the stdio MCP server
//   slirc-codex.js listen <json>  the listener for one thread, started by a hook

const [mode, arg] = process.argv.slice(2);

if (mode === "hook") {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  // A hook never stops Codex: anything unexpected answers nothing.
  hook(String(arg), payload).then(
    (output) => {
      for (const key of ["reason", "systemMessage"] as const) if (output[key]) output[key] = forCodex(output[key]!);
      if (Object.keys(output).length) process.stdout.write(JSON.stringify(output));
      process.exit(0);
    },
    () => process.exit(0),
  );
} else if (mode === "mcp") {
  serve().then(() => process.exit(0));
} else if (mode === "listen") {
  let config: Config;
  try { config = JSON.parse(arg ?? ""); if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(config.sessionId))) throw new Error("bad session id"); }
  catch { console.error("slirc listener: expected one JSON argument with sessionId, cwd, model and daemonPid"); process.exit(2); }
  main(config).catch((error) => { console.error(`Slirc listener stopped: ${errorText(error)}`); process.exit(1); });
} else {
  console.error("slirc-codex: expected hook <Event>, mcp or listen <json>");
  process.exit(2);
}
