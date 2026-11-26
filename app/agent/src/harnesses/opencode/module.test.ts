import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import opencode, { pluginFolder } from "./module.ts";
import { unsupported } from "./shared.ts";

// A stand-in `opencode` on a fake PATH and config home. Only `--version` is ever called.
const roots: string[] = [];
function fake(version = "2.3.2") {
  const root = mkdtempSync(join(tmpdir(), "slirc-fake-opencode-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho "$*" >> "${root}/calls.log"\n[ "$1" = "--version" ] && echo "opencode v${version}"\n[ "$1" = "reload" ] && echo "Configuration reloaded"\nexit 0\n`);
  chmodSync(join(bin, "opencode"), 0o755);
  const source = join(root, "built");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "slirc-agent-opencode", version: "3.1.2" }));
  writeFileSync(join(source, "index.js"), "export default {}\n");
  writeFileSync(join(source, "tui.js"), "export default {}\n");
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(":"), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), SLIRC_OPENCODE_SOURCE: source };
  return { root, env, source, folder: pluginFolder(env), calls: () => (existsSync(join(root, "calls.log")) ? readFileSync(join(root, "calls.log"), "utf8") : "").split("\n").filter(Boolean) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const apply = (steps: { apply(): void }[]) => steps.forEach((step) => step.apply());

test("detect reads the version and knows when it runs in OpenCode's shell", () => {
  const { env } = fake();
  expect(opencode.detect(env)).toEqual({ installed: true, inside: false, version: "2.3.2" });
  expect(opencode.detect({ ...env, OPENCODE: "1" }).inside).toBe(true);
});

test("install copies the plugin folder and reloads OpenCode once, and a second install does nothing", () => {
  const { env, folder, calls } = fake();
  expect(opencode.status(env, "3.1.2")).toEqual({ state: "missing" });
  const steps = opencode.install(env, "3.1.2");
  expect(steps.map((step) => step.doing)).toEqual([`copy the Slirc plugin to ${folder}`, "reload OpenCode so it loads the plugin"]);
  apply(steps);
  expect(calls().filter((call) => call === "reload")).toHaveLength(1);
  expect(readFileSync(join(folder, "tui.js"), "utf8")).toContain("export default");
  expect(opencode.status(env, "3.1.2")).toEqual({ state: "current", version: "3.1.2" });
  expect(opencode.install(env, "3.1.2")).toEqual([]);
  expect(calls().filter((call) => call === "reload")).toHaveLength(1);
});

test("a failed reload says what to do next", () => {
  const { env, root } = fake();
  writeFileSync(join(root, "bin", "opencode"), `#!/bin/sh\n[ "$1" = "--version" ] && echo "opencode v2.3.2" && exit 0\nexit 1\n`);
  expect(() => apply(opencode.install(env, "3.1.2"))).toThrow("Quit OpenCode and start it again");
});

test("an older plugin is replaced whole, dropping files the new one doesn't have", () => {
  const { env, folder } = fake();
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "slirc-agent-opencode", version: "3.0.0" }));
  writeFileSync(join(folder, "old.js"), "");
  expect(opencode.status(env, "3.1.2")).toEqual({ state: "outdated", version: "3.0.0" });
  apply(opencode.install(env, "3.1.2"));
  expect(existsSync(join(folder, "old.js"))).toBe(false);
  expect(opencode.status(env, "3.1.2").state).toBe("current");
});

test("uninstall removes only our folder", () => {
  const { env, folder } = fake();
  const other = join(folder, "..", "someone-else");
  mkdirSync(other, { recursive: true });
  apply(opencode.install(env, "3.1.2"));
  expect(opencode.uninstall(env).map((step) => step.doing)).toEqual([`delete ${folder}`]);
  apply(opencode.uninstall(env));
  expect(existsSync(folder)).toBe(false);
  expect(existsSync(other)).toBe(true);
  expect(opencode.uninstall(env)).toEqual([]);
});

test("someone else's slirc plugin folder is a conflict, never overwritten", () => {
  const { env, folder } = fake();
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "index.js"), "mine");
  const status = opencode.status(env, "3.1.2");
  expect(status.state).toBe("conflict");
  expect(status.detail).toContain("Move it out of");
  expect(opencode.install(env, "3.1.2")).toEqual([]);
  expect(opencode.uninstall(env)).toEqual([]);
  expect(readFileSync(join(folder, "index.js"), "utf8")).toBe("mine");
});

test("the plugin folder slirc-agent 2.x wrote is replaced, not a conflict", () => {
  const { env, folder } = fake();
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "index.js"), 'const registry = globalThis[Symbol.for("slirc-agent.opencode.v2")];');
  writeFileSync(join(folder, "tui.js"), "");
  expect(opencode.status(env, "3.1.2")).toEqual({ state: "outdated", version: "2.x" });
  apply(opencode.install(env, "3.1.2"));
  expect(opencode.status(env, "3.1.2").state).toBe("current");
});

test("the session key is the OpenCode session the shell runs in", () => {
  const { env } = fake();
  expect(opencode.sessionKey!({ ...env, OPENCODE: "1", OPENCODE_SESSION_ID: "ses_abc" })).toBe("ses_abc");
  expect(opencode.sessionKey!({ ...env, OPENCODE_SESSION_ID: "ses_abc" })).toBeUndefined();
});

test("OpenCode 1.x and untested 2.x releases are refused with what to do", () => {
  for (const [version, says] of [["1.19.6", "Install OpenCode 2"], ["2.2.7", "opencode upgrade"], ["2.4.0", "npx slirc-agent@latest"]]) {
    const { env, folder } = fake(version);
    const status = opencode.status(env, "3.1.2");
    expect(status.state).toBe("conflict");
    expect(status.detail).toContain(says);
    expect(opencode.install(env, "3.1.2")).toEqual([]);
    expect(existsSync(folder)).toBe(false);
  }
  expect(unsupported("2.3.0")).toBeUndefined();
  expect(unsupported("2.3.9")).toBeUndefined();
  expect(unsupported(undefined)).toBeUndefined();
});

test("a missing bundle fails with what to do next", () => {
  const { env, source } = fake();
  rmSync(join(source, "package.json"));
  expect(() => apply(opencode.install(env, "3.1.2"))).toThrow("Reinstall slirc-agent");
});

test("launch starts the TUI with pairing armed and passes extra arguments", () => {
  const { env, calls } = fake();
  const launch = opencode.launch("calango.slirc.app", env, ["-c"]);
  expect(launch).toMatchObject({ bin: "opencode", args: ["-c"] });
  expect(launch.env.SLIRC_CONNECT).toBe("calango.slirc.app");
  expect(calls()).toEqual([]);
});
