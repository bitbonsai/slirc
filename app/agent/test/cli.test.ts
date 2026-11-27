import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "../src/version.ts";
import { fakePi, type FakePi } from "./support/fake-pi.ts";
import { fakeCodex } from "../src/harnesses/codex/fake-codex.ts";

// The built CLI (dist/ is tracked; root `bun run test` and `bun run agent:test` rebuild it once first), run the way npx and bunx run it: by Node, and by Bun when there is no Node. Each
// case runs under both. A fake Slirc answers /api/agent/version and a fake pi stands in for Pi.
const bin = resolve(import.meta.dir, "../dist/slirc-agent.js");
const runtimes = [["bun", process.execPath], ["node", Bun.which("node")]].filter((entry): entry is [string, string] => !!entry[1]);
if (!Bun.which("node") && process.env.CI) throw new Error("node is required for the CLI checks in CI");

let expected = VERSION;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => new URL(request.url).pathname === "/api/agent/version"
    ? Response.json({ version: expected, enabled: true, harnesses: [{ id: "pi", name: "Pi" }] }) : new Response("no", { status: 404 }) });
});
afterAll(() => server.stop(true));
let fake: FakePi | undefined;
afterEach(() => { fake?.done(); fake = undefined; expected = VERSION; });

// Async, so the fake server in this process can answer while the CLI waits on it.
async function cli(runtime: string, args: string[], env: Record<string, string>) {
  const child = Bun.spawn([runtime, bin, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}
const host = () => `127.0.0.1:${server.port}`;

for (const [name, runtime] of runtimes) {
  test(`${name}: --help and --version work with nothing installed`, async () => {
    const help = await cli(runtime, ["--help"], { PATH: "/usr/bin:/bin" });
    expect(help.code).toBe(0);
    expect(help.out).toContain("slirc-agent [workspace]");
    expect((await cli(runtime, ["--version"], { PATH: "/usr/bin:/bin" })).out.trim()).toBe(VERSION);
  });

  test(`${name}: no supported agent installed says where to get one`, async () => {
    const run = await cli(runtime, ["calango"], { PATH: "/usr/bin:/bin", HOME: "/nonexistent" });
    expect(run.code).toBe(1);
    expect(run.err.trim()).toBe("Slirc works with Pi, Claude Code, Codex and OpenCode today, and none is installed here. Install Pi from https://pi.dev, or Claude Code from https://claude.com/claude-code, or Codex from https://developers.openai.com/codex/cli, or OpenCode from https://opencode.ai, then run this again.");
  });

  test(`${name}: an unreachable workspace changes nothing and says what to check`, async () => {
    fake = fakePi();
    const run = await cli(runtime, ["127.0.0.1:1"], fake.env);
    expect(run.code).toBe(1);
    expect(run.err).toContain("Couldn't reach 127.0.0.1:1. Check the workspace name on your Agents page");
    expect(fake.installed()).toEqual([]);
  });

  test(`${name}: a workspace on a newer version prints the exact command for npx and bunx`, async () => {
    fake = fakePi();
    expected = "3.9.0";
    const run = await cli(runtime, [host()], fake.env);
    expect(run.code).toBe(1);
    expect(run.err.trim()).toBe(`${host()} uses slirc-agent 3.9.0 and this is ${VERSION}. Run npx slirc-agent@3.9.0 ${host()} (or bunx slirc-agent@3.9.0 ${host()}).`);
    expect(fake.installed()).toEqual([]);
  });

  test(`${name}: pasted into Pi, it sets up the extension and tells the owner what to type`, async () => {
    fake = fakePi();
    const run = await cli(runtime, [host()], { ...fake.env, PI_CODING_AGENT: "true" });
    expect(run.code).toBe(0);
    expect(run.out).toContain(`pi install npm:slirc-agent@${VERSION}`);
    expect(run.out).toContain(`type /reload, then /slirc ${host()}, and open the link it shows.`);
    expect(fake.installed()).toEqual([`npm:slirc-agent@${VERSION}`]);
    expect(fake.calls().some((call) => call.startsWith("launched"))).toBe(false);
    expect(readFileSync(join(fake.env.XDG_STATE_HOME, "slirc", "workspace"), "utf8").trim()).toBe(host());
    // Already set up: nothing to reload.
    const again = await cli(runtime, [host()], { ...fake.env, PI_CODING_AGENT: "true" });
    expect(again.out).toContain(`type /slirc ${host()} and open the link it shows.`);
    expect(fake.calls().filter((call) => call.startsWith("install"))).toHaveLength(1);
  });

  test(`${name}: an update that fails leaves the old extension working and says so`, async () => {
    fake = fakePi({ broken: true });
    fake.install("npm:slirc-agent@3.0.0");
    const run = await cli(runtime, [host()], { ...fake.env, PI_CODING_AGENT: "true" });
    expect(run.code).toBe(1);
    expect(run.out).toContain(`Pi: updating the Slirc extension from 3.0.0 to ${VERSION}.`);
    expect(run.out).not.toContain("pi remove");
    expect(run.err).toContain(`pi install npm:slirc-agent@${VERSION} failed`);
    expect(run.err).toContain("Nothing else changed. Fix that, then run this again.");
    expect(fake.installed()).toEqual(["npm:slirc-agent@3.0.0"]);
  });

  test(`${name}: in a plain terminal, it sets up and starts Pi with pairing armed`, async () => {
    fake = fakePi();
    const run = await cli(runtime, [host(), "--", "--model", "x"], fake.env);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`launched pi SLIRC_CONNECT=${host()} args=--model x`);
    expect(run.out).toContain(`Later sessions: type /slirc ${host()} in Pi.`);
  });

  test(`${name}: pasted into a Pi session, it arms that session to connect itself`, async () => {
    fake = fakePi();
    const inside = { ...fake.env, PI_CODING_AGENT: "true", PI_SESSION_ID: "0193-session-a" };
    const arm = join(fake.env.XDG_STATE_HOME, "slirc-agent", "pi", "arm", "0193-session-a.json");
    // First time: the extension isn't loaded yet, so reload, and the link shows right after. The
    // arm waits for the reloaded runtime, so an older one still loaded can't take it.
    const first = await cli(runtime, [host(), "k7f2q9xdpa3m"], inside);
    expect(first.code).toBe(0);
    // One line: the session connects by itself after the reload.
    expect(first.out).toBe("Slirc installed. Type /reload to finish.\n");
    const reloadArm = arm.replace(/\.json$/, ".reload.json");
    expect(existsSync(arm)).toBe(false);
    expect(JSON.parse(readFileSync(reloadArm, "utf8"))).toMatchObject({ host: host(), ticket: "k7f2q9xdpa3m" });
    expect(statSync(reloadArm).mode & 0o777).toBe(0o600);
    expect(statSync(join(arm, "..")).mode & 0o777).toBe(0o700);
    // Set up already: nothing to type.
    const again = await cli(runtime, [host()], inside);
    expect(again.out).toContain(`This Pi session is connecting to ${host()} by itself. A code shows in this session, not here: enter it on the Agents page in Slirc.`);
    expect(again.out).toContain("This command is done.");
    expect(again.out).not.toContain("/slirc");
    expect(JSON.parse(readFileSync(arm, "utf8")).ticket).toBeUndefined();
    // An older Pi gives its shell no session id: the typed command, as before.
    const old = await cli(runtime, [host()], { ...fake.env, PI_CODING_AGENT: "true" });
    expect(old.out).toContain(`type /slirc ${host()} and open the link it shows.`);
    expect(fake.calls().some((call) => call.startsWith("launched"))).toBe(false);
  });

  test(`${name}: pasted into Codex the first time, it says to open a new session and type slirc there`, async () => {
    const codex = fakeCodex();
    try {
      const thread = "01a1f5c4-8553-7df3-8c9a-72f286d9bef8";
      const env = { ...codex.env, CODEX_THREAD_ID: thread };
      const arm = join(codex.env.XDG_STATE_HOME, "slirc-agent", "codex", "arm");
      const first = await cli(runtime, [host()], env);
      expect(first.code).toBe(0);
      // The thread open now never loads the plugin, so no arm is left for it.
      expect(first.out).toContain(`In this Codex session, type /new, then slirc ${host()}, and open the link it shows.`);
      expect(existsSync(arm)).toBe(false);
      // Set up already: this thread pairs itself when the command's turn ends.
      const again = await cli(runtime, [host()], env);
      expect(again.out).toContain("This Codex session is connecting");
      expect(existsSync(join(arm, `${thread}.json`))).toBe(true);
    } finally { codex.done(); }
  });

  test(`${name}: pasted into OpenCode the first time, it says the plugin is loaded and there's nothing to reload`, async () => {
    // OpenCode's reply once told the owner to run opencode reload, which the CLI had already done.
    const root = mkdtempSync(join(tmpdir(), "slirc-cli-opencode-"));
    const bin = join(root, "bin");
    const source = join(root, "built");
    mkdirSync(bin, { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho "$*" >> "${root}/calls.log"\n[ "$1" = "--version" ] && echo "opencode v2.3.2"\nexit 0\n`);
    chmodSync(join(bin, "opencode"), 0o755);
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "slirc-agent-opencode", version: VERSION }));
    const env = { PATH: [bin, "/usr/bin", "/bin"].join(":"), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
      SLIRC_OPENCODE_SOURCE: source, OPENCODE: "1", OPENCODE_SESSION_ID: "ses_first" };
    const run = await cli(runtime, [host(), "k7f2q9xdpa3m"], env);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`Slirc is installed and loaded, so there's nothing to reload. This OpenCode session is connecting to ${host()} by itself.`);
    expect(run.out).not.toMatch(/^\s*opencode reload$/m);
    expect(readFileSync(join(root, "calls.log"), "utf8")).toContain("reload");
  });

  test(`${name}: a bad connect code is refused before anything changes`, async () => {
    fake = fakePi();
    const run = await cli(runtime, [host(), "no"], { ...fake.env, PI_CODING_AGENT: "true", PI_SESSION_ID: "s" });
    expect(run.code).toBe(1);
    expect(run.err).toContain("That isn't a connect code from your Agents page. Copy the command there again.");
    expect(fake.installed()).toEqual([]);
    expect(existsSync(join(fake.env.XDG_STATE_HOME, "slirc-agent", "pi", "arm"))).toBe(false);
  });

  test(`${name}: in a plain terminal, the connect code rides along with the launch`, async () => {
    fake = fakePi();
    const run = await cli(runtime, [host(), "k7f2q9xdpa3m"], fake.env);
    expect(run.out).toContain(`launched pi SLIRC_CONNECT=${host()} ticket=k7f2q9xdpa3m args=`);
    // A command copied from 3.2.0's page still works.
    const legacy = await cli(runtime, [host(), "--ticket", "k7f2q9xdpa3m"], fake.env);
    expect(legacy.out).toContain(`launched pi SLIRC_CONNECT=${host()} ticket=k7f2q9xdpa3m args=`);
  });

  test(`${name}: status and uninstall report and remove only what is ours`, async () => {
    fake = fakePi();
    fake.install("npm:slirc-agent", "2.4.1");
    expect((await cli(runtime, ["status"], fake.env)).out).toContain(`Pi 1.5.2: Slirc extension 2.4.1, ${VERSION} available (run slirc-agent install)`);
    expect((await cli(runtime, ["uninstall"], fake.env)).out).toContain("pi remove npm:slirc-agent");
    expect(fake.installed()).toEqual([]);
  });
}

test("the bundle has nothing npm-specific in it", () => {
  const source = readFileSync(bin, "utf8");
  expect(source).not.toMatch(/npm_config_|npm_execpath|_npx/);
  expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
});
