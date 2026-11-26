import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import claudeCode from "./module.ts";
import { fakeClaude, type FakeClaude } from "../../../test/support/fake-claude.ts";
import { VERSION } from "../../version.ts";

let fake: FakeClaude;
afterEach(() => fake?.done());
const placed = (env: Record<string, string>) => join(env.XDG_DATA_HOME, "slirc-agent", "claude-code");
const apply = (env: Record<string, string>) => claudeCode.install(env, VERSION).forEach((step) => step.apply());

test("detect finds claude on PATH and knows when it runs inside Claude Code's shell", () => {
  fake = fakeClaude({ version: "2.1.326" });
  expect(claudeCode.detect(fake.env)).toEqual({ installed: true, inside: false, version: "2.1.326" });
  expect(claudeCode.detect({ ...fake.env, CLAUDECODE: "1" }).inside).toBe(true);
  expect(claudeCode.detect({ ...fake.env, PATH: "/usr/bin:/bin" })).toEqual({ installed: false, inside: false });
});

const folderOf = (env: Record<string, string>) => realpathSync(env.SLIRC_FOLDER);

test("install turns Slirc on for this folder only, and a second run changes nothing", () => {
  fake = fakeClaude();
  expect(claudeCode.status(fake.env, VERSION)).toEqual({ state: "missing" });
  const steps = claudeCode.install(fake.env, VERSION);
  expect(steps.map((step) => step.doing)).toEqual([
    `copy the Slirc plugin to ${placed(fake.env)}`,
    `claude plugin marketplace add ${placed(fake.env)}`,
    `claude plugin install slirc@slirc-agent --scope local (in ${folderOf(fake.env)})`,
  ]);
  steps.forEach((step) => step.apply());
  expect(existsSync(join(placed(fake.env), "slirc", "listener.js"))).toBe(true);
  expect(JSON.parse(readFileSync(join(placed(fake.env), "slirc", "runtime.json"), "utf8"))).toEqual({ exec: "/usr/bin/true" });
  expect(fake.plugins()).toEqual([{ id: "slirc@slirc-agent", version: VERSION, enabled: true, scope: "local", projectPath: folderOf(fake.env) }]);
  expect(claudeCode.status(fake.env, VERSION)).toEqual({ state: "current", version: VERSION });
  expect(claudeCode.install(fake.env, VERSION)).toEqual([]);
});

test("another folder is set up on its own, without copying again", () => {
  fake = fakeClaude();
  apply(fake.env);
  const other = join(fake.root, "other");
  mkdirSync(other);
  const env = { ...fake.env, SLIRC_FOLDER: other };
  expect(claudeCode.status(env, VERSION)).toEqual({ state: "missing" });
  expect(claudeCode.install(env, VERSION).map((step) => step.doing)).toEqual([`claude plugin install slirc@slirc-agent --scope local (in ${realpathSync(other)})`]);
  apply(env);
  expect(fake.plugins().map((plugin) => plugin.projectPath)).toEqual([folderOf(fake.env), realpathSync(other)]);
});

test("the user-wide switch-on from 3.1.0 is taken back once this folder has Slirc", () => {
  fake = fakeClaude();
  apply(fake.env);
  fake.addPlugin("slirc@slirc-agent", VERSION, { scope: "user" });
  expect(claudeCode.status(fake.env, VERSION).state).toBe("outdated");
  expect(claudeCode.install(fake.env, VERSION).map((step) => step.doing)).toEqual(["claude plugin uninstall slirc@slirc-agent --scope user"]);
  apply(fake.env);
  expect(fake.plugins().map((plugin) => plugin.scope)).toEqual(["local"]);
  expect(claudeCode.status(fake.env, VERSION).state).toBe("current");
});

test("an older plugin in this folder is updated in place, and a disabled one is turned back on", () => {
  fake = fakeClaude();
  fake.addPlugin("slirc@slirc-agent", "3.0.0", { enabled: false, scope: "local", projectPath: folderOf(fake.env) });
  expect(claudeCode.status(fake.env, VERSION)).toEqual({ state: "outdated", version: "3.0.0" });
  apply(fake.env);
  expect(fake.calls().filter((call) => /^plugin (marketplace add|update|enable|install)/.test(call)).map((call) => call.replace(placed(fake.env), "<dir>")))
    .toEqual(["plugin marketplace add <dir>", "plugin update slirc@slirc-agent --scope local", "plugin enable slirc@slirc-agent --scope local"]);
  expect(claudeCode.status(fake.env, VERSION)).toEqual({ state: "current", version: VERSION });
});

test("uninstall turns off this folder, and removes the marketplace only when no folder uses it", () => {
  fake = fakeClaude();
  fake.addPlugin("caveman@caveman", "1.0.0");
  apply(fake.env);
  const other = join(fake.root, "other");
  mkdirSync(other);
  apply({ ...fake.env, SLIRC_FOLDER: other });
  expect(claudeCode.uninstall(fake.env).map((step) => step.doing)).toEqual(["claude plugin uninstall slirc@slirc-agent --scope local"]);
  claudeCode.uninstall(fake.env).forEach((step) => step.apply());
  expect(existsSync(placed(fake.env))).toBe(true);
  const last = { ...fake.env, SLIRC_FOLDER: other };
  expect(claudeCode.uninstall(last).map((step) => step.doing)).toEqual([
    "claude plugin uninstall slirc@slirc-agent --scope local", "claude plugin marketplace remove slirc-agent", `delete ${placed(fake.env)}`,
  ]);
  claudeCode.uninstall(last).forEach((step) => step.apply());
  expect(fake.plugins().map((plugin) => plugin.id)).toEqual(["caveman@caveman"]);
  expect(existsSync(placed(fake.env))).toBe(false);
  expect(claudeCode.uninstall(last)).toEqual([]);
});

test("managed settings that block mods are a conflict that says who can lift it", () => {
  for (const [file, key] of [["managed-settings.json", "allowManagedModsOnly"], ["managed-settings.d/10-hooks.json", "allowManagedHooksOnly"]] as const) {
    fake = fakeClaude();
    mkdirSync(join(fake.env.SLIRC_CLAUDE_MANAGED_DIR, "managed-settings.d"), { recursive: true });
    writeFileSync(join(fake.env.SLIRC_CLAUDE_MANAGED_DIR, file), JSON.stringify({ [key]: true }));
    const status = claudeCode.status(fake.env, VERSION);
    expect(status.state).toBe("conflict");
    expect(status.detail).toContain(key);
    expect(status.detail).toContain("Ask your Claude Code admin");
    expect(claudeCode.install(fake.env, VERSION)).toEqual([]);
    fake.done();
  }
  fake = fakeClaude();
  mkdirSync(fake.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(join(fake.env.CLAUDE_CONFIG_DIR, "remote-settings.json"), JSON.stringify({ disableAllHooks: true }));
  expect(claudeCode.status(fake.env, VERSION).state).toBe("conflict");
});

test("a foreign folder where the marketplace goes is a conflict", () => {
  fake = fakeClaude();
  mkdirSync(placed(fake.env), { recursive: true });
  writeFileSync(join(placed(fake.env), "notes.txt"), "mine");
  const status = claudeCode.status(fake.env, VERSION);
  expect(status.state).toBe("conflict");
  expect(status.detail).toContain(placed(fake.env));
  expect(claudeCode.install(fake.env, VERSION)).toEqual([]);
});

test("launch starts claude with pairing armed for that one start", () => {
  fake = fakeClaude();
  expect(claudeCode.launch("calango.slirc.app", fake.env, ["--model", "x"])).toEqual({ bin: "claude", args: ["--model", "x"], env: { ...fake.env, SLIRC_CONNECT: "calango.slirc.app" } });
  expect(claudeCode.sessionCommand("calango")).toBe("/slirc calango");
  expect(claudeCode.sessionCommand("")).toBe("/slirc");
});

test("the CLI names /slirc-connect only where a personal /slirc skill or command holds the name", () => {
  fake = fakeClaude();
  expect(claudeCode.localCommand!(fake.env, "calango")).toBe("/slirc calango");
  mkdirSync(join(fake.env.CLAUDE_CONFIG_DIR, "skills", "slirc"), { recursive: true });
  expect(claudeCode.localCommand!(fake.env, "calango")).toBe("/slirc-connect calango");
  expect(claudeCode.localCommand!(fake.env, "")).toBe("/slirc-connect");
  expect(claudeCode.sessionCommand("calango")).toBe("/slirc calango");
});

test("a Claude Code too old for mods is a conflict that says how to update", () => {
  fake = fakeClaude({ version: "2.1.200" });
  const status = claudeCode.status(fake.env, VERSION);
  expect(status).toEqual({ state: "conflict", detail: "Slirc needs Claude Code 2.1.286 or newer, and this is 2.1.200. Run claude update, then run this again." });
  expect(claudeCode.install(fake.env, VERSION)).toEqual([]);
});
