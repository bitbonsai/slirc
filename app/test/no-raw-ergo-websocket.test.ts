import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Browsers reach IRC through the app's /irc relay, which sends WEBIRC with the client IP.
// A direct proxy to Ergo's WebSocket listener hides that IP and shares per-IP limits.
const root = new URL("../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(root + path, "utf8");
const uncommented = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

test("Caddy does not proxy /webirc to Ergo", () => {
  const caddy = uncommented(read("caddy/example.caddy"));
  expect(caddy).not.toContain("/webirc");
  expect(caddy).not.toContain(":8067");
});

test("the example Ergo config has no WebSocket listener", () => {
  expect(uncommented(read("ergo/ergo.example.yaml"))).not.toMatch(/^\s*websocket:\s*true/m);
});

test("no Compose file publishes Ergo's WebSocket port", () => {
  for (const file of ["compose.yaml", "compose.local.yaml", "deploy/ergo.compose.yaml"]) {
    expect(uncommented(read(file))).not.toContain("8067");
  }
});
