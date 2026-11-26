import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import codex from "./module.ts";
import { fakeCodex, type FakeCodex } from "./fake-codex.ts";
import { forCodex, pairingCommand, unsupported } from "./shared.ts";
import { VERSION } from "../../version.ts";

let fake: FakeCodex;
afterEach(() => fake?.done());
const placed = (env: Record<string, string>) => join(env.XDG_DATA_HOME, "slirc-agent", "codex");
const apply = (env: Record<string, string>, version = VERSION) => codex.install(env, version).forEach((step) => step.apply());

test("detect finds codex on PATH and knows when it runs inside a Codex shell", () => {
  fake = fakeCodex({ version: "0.170.0" });
  expect(codex.detect(fake.env)).toEqual({ installed: true, inside: false, version: "0.170.0" });
  expect(codex.detect({ ...fake.env, CODEX_THREAD_ID: "01a1ef73-22d7-7e61-90ef-5cf508a89f58" }).inside).toBe(true);
  expect(codex.detect({ ...fake.env, PATH: "/usr/bin:/bin" })).toEqual({ installed: false, inside: false });
});

test("install adds the plugin from a local marketplace, and a second run changes nothing", () => {
  fake = fakeCodex();
  expect(codex.status(fake.env, VERSION)).toEqual({ state: "missing" });
  const steps = codex.install(fake.env, VERSION);
  expect(steps.map((step) => step.doing)).toEqual([
    `copy the Slirc plugin to ${placed(fake.env)}`,
    `codex plugin marketplace add ${placed(fake.env)}`,
    "codex plugin add slirc@slirc-agent",
  ]);
  steps.forEach((step) => step.apply());
  const plugin = join(placed(fake.env), "slirc");
  expect(existsSync(join(plugin, "slirc-codex.js"))).toBe(true);
  // Hooks and the MCP server run the bundled runtime by absolute path, and the tools skip approval.
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks.json"), "utf8")).hooks;
  expect(Object.keys(hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
  expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe(`'/usr/bin/true' '${join(plugin, "slirc-codex.js")}' hook UserPromptSubmit`);
  expect(JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { slirc: { command: "/usr/bin/true", args: [join(plugin, "slirc-codex.js"), "mcp"], env_vars: ["XDG_STATE_HOME"], default_tools_approval_mode: "approve" } } });
  expect(fake.plugins()).toEqual([{ pluginId: "slirc@slirc-agent", version: VERSION, enabled: true }]);
  expect(codex.status(fake.env, VERSION)).toEqual({ state: "current", version: VERSION });
  expect(codex.install(fake.env, VERSION)).toEqual([]);
});

test("an update copies the new version and adds it again over the old one", () => {
  fake = fakeCodex();
  apply(fake.env);
  const manifest = join(placed(fake.env), "slirc", ".codex-plugin", "plugin.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "3.0.0" }));
  expect(codex.status(fake.env, VERSION)).toEqual({ state: "outdated", version: VERSION });
  expect(codex.install(fake.env, VERSION).map((step) => step.doing)).toEqual([`copy the Slirc plugin to ${placed(fake.env)}`, "codex plugin add slirc@slirc-agent"]);
  apply(fake.env);
  expect(codex.status(fake.env, VERSION).state).toBe("current");
  expect(fake.marketplaces().length).toBe(1);
});

test("uninstall removes the plugin, the marketplace and the copy, and nothing else", () => {
  fake = fakeCodex();
  apply(fake.env);
  const other = join(fake.env.XDG_DATA_HOME, "slirc-agent", "claude-code");
  mkdirSync(other, { recursive: true });
  const steps = codex.uninstall(fake.env);
  expect(steps.map((step) => step.doing)).toEqual(["codex plugin remove slirc@slirc-agent", "codex plugin marketplace remove slirc-agent", `delete ${placed(fake.env)}`]);
  steps.forEach((step) => step.apply());
  expect(fake.plugins()).toEqual([]);
  expect(fake.marketplaces()).toEqual([]);
  expect(existsSync(placed(fake.env))).toBe(false);
  expect(existsSync(other)).toBe(true);
  expect(codex.uninstall(fake.env)).toEqual([]);
});

test("a Codex outside the tested range is a conflict that says what to do", () => {
  fake = fakeCodex({ version: "0.168.2" });
  const old = codex.status(fake.env, VERSION);
  expect(old.state).toBe("conflict");
  expect(old.detail).toContain("Update Codex");
  expect(codex.install(fake.env, VERSION)).toEqual([]);
  fake.done();
  fake = fakeCodex({ version: "0.173.0" });
  expect(codex.status(fake.env, VERSION).detail).toContain("npx slirc-agent@latest");
  expect(unsupported("0.169.0")).toBeUndefined();
  expect(unsupported("0.170.9")).toBeUndefined();
  expect(unsupported("0.172.0")).toBeUndefined();
});

test("a folder in the marketplace's place that isn't ours is a conflict", () => {
  fake = fakeCodex();
  mkdirSync(placed(fake.env), { recursive: true });
  expect(codex.status(fake.env, VERSION)).toMatchObject({ state: "conflict", detail: expect.stringContaining("isn't the Slirc marketplace") });
});

test("launch types the pairing command as the first prompt, after any extra arguments", () => {
  fake = fakeCodex();
  expect(codex.launch("calango.slirc.app", fake.env, ["--model", "gpt-5"])).toEqual({ bin: "codex", args: ["--model", "gpt-5", "slirc calango.slirc.app"], env: fake.env });
  // From a terminal with the Agents page's connect code: hooks never see slirc-agent's environment,
  // so the code rides in the typed prompt.
  const withCode = { ...fake.env, SLIRC_CONNECT_TICKET: "wSzGwHVg5htq" };
  expect(codex.launch("calango.slirc.app", withCode, []).args).toEqual(["slirc calango.slirc.app wSzGwHVg5htq"]);
  expect(codex.sessionCommand("calango")).toBe("slirc calango");
  expect(codex.sessionCommand("")).toBe("slirc");
});

test("only the whole prompt `slirc` or `slirc <workspace>` pairs", () => {
  expect(pairingCommand("slirc calango")).toEqual({ workspace: "calango" });
  expect(pairingCommand("  SLIRC localhost:9110 ")).toEqual({ workspace: "localhost:9110" });
  expect(pairingCommand("slirc")).toEqual({ workspace: "" });
  expect(pairingCommand("slirc calango.slirc.app wSzGwHVg5htq")).toEqual({ workspace: "calango.slirc.app", ticket: "wSzGwHVg5htq" });
  expect(pairingCommand("slirc calango wSzGw!Hg5htq")).toBeUndefined();
  expect(pairingCommand("slirc calango please")).toBeUndefined();
  expect(pairingCommand("connect to slirc calango")).toBeUndefined();
  expect(pairingCommand("/slirc calango")).toBeUndefined();
});

test("Slirc's shared messages name the command without its slash in Codex", () => {
  expect(forCodex("The link expired before anyone allowed it. Type /slirc again for a new one.")).toBe("The link expired before anyone allowed it. Type slirc again for a new one.");
  expect(forCodex("type /slirc in your session")).toBe("type slirc in your session");
  expect(forCodex("see https://x/slirc/docs and /slirc-connect")).toBe("see https://x/slirc/docs and /slirc-connect");
});

test("the slirc MCP server slirc-agent 2.x added is removed; one that isn't ours is a conflict", () => {
  fake = fakeCodex();
  apply(fake.env);
  fake.addServer("slirc", { type: "stdio", command: "npx", args: ["-y", "slirc-agent", "mcp", "codex"] });
  expect(codex.status(fake.env, VERSION).state).toBe("outdated");
  expect(codex.install(fake.env, VERSION).map((step) => step.doing)).toEqual(["codex mcp remove slirc (left by slirc-agent 2.x)"]);
  apply(fake.env);
  expect(fake.servers()).toEqual({});
  expect(codex.status(fake.env, VERSION).state).toBe("current");
  fake.addServer("slirc", { type: "stdio", command: "/usr/local/bin/my-slirc", args: [] });
  expect(codex.status(fake.env, VERSION)).toMatchObject({ state: "conflict", detail: expect.stringContaining("codex mcp remove slirc") });
});

test("the installed plugin's own slirc MCP server, which codex mcp get also lists, is no conflict", () => {
  // Codex 0.171 lists plugin servers under codex mcp get, so a second terminal run refused here.
  fake = fakeCodex();
  apply(fake.env);
  fake.addServer("slirc", { type: "stdio", command: process.execPath, args: [join(placed(fake.env), "slirc", "slirc-codex.js"), "mcp"] });
  expect(codex.status(fake.env, VERSION).state).toBe("current");
  expect(codex.install(fake.env, VERSION)).toEqual([]);
});
