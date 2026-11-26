import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compose rendering only: no up, build, pull or container access.
const dockerCompose = Bun.which("docker-compose");
const podmanCompose = Bun.which("podman-compose");
const deployDir = new URL("../../deploy/", import.meta.url).pathname;

function withScratch<T>(envFile: string, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "slirc-compose-"));
  try {
    writeFileSync(join(dir, "env"), envFile);
    writeFileSync(join(dir, "empty.env"), "");
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Sanitized child environment: no inherited channels or secrets, and an empty --env-file so
// the renderer cannot pick up a project `.env`. `shell` is the invoking environment's
// channel values, which must never reach the service.
function renderRaw(bin: string, file: string, args: string[], dir: string, shell: Record<string, string> = {}): string {
  const result = Bun.spawnSync([bin, "--env-file", join(dir, "empty.env"), "-f", join(deployDir, file), ...args], {
    cwd: dir,
    // The IRC key path is required by app.compose.yaml; a scratch path is enough to render.
    env: { PATH: process.env.PATH, HOME: dir, SLIRC_CONFIG_DIR: dir, SLIRC_IRC_KEY_PATH: join(dir, "irc-key"), ...shell },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`${bin} config failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

// docker-compose resolves env_file into the effective container environment.
function renderEffectiveEnv(file: string, envFile: string, shell: Record<string, string> = {}): Record<string, string> {
  if (!dockerCompose) throw new Error("docker-compose required");
  return withScratch(envFile, (dir) => {
    const services = JSON.parse(renderRaw(dockerCompose, file, ["config", "--format", "json"], dir, shell)).services;
    const service = Object.values(services)[0] as { environment?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(service.environment ?? {}).map(([key, value]) => [key, String(value)]));
  });
}

// podman-compose keeps env_file as a path instead of inlining it, so assert the retained
// path and the absence of channel overrides in the explicit environment.
function renderPodman(file: string, envFile: string, shell: Record<string, string> = {}): { dir: string; output: string } {
  if (!podmanCompose) throw new Error("podman-compose required");
  return withScratch(envFile, (dir) => ({ dir, output: renderRaw(podmanCompose, file, ["config"], dir, shell) }));
}

const keepsEnvFile = (output: string, dir: string) => output.split("\n").some((line) => line.trim() === `- ${dir}/env`);
const hasKey = (output: string, key: string) => new RegExp(`^\\s+${key}:`, "m").test(output);

describe.skipIf(!dockerCompose)("deploy compose configuration via docker-compose", () => {
  test("a public instance selects its mode and rooms in its own env", () => {
    const env = renderEffectiveEnv("app.compose.yaml", [
      "SLIRC_MODE=public_playground",
      "IRC_CHANNEL=#untitled",
      "OPEN_CHANNELS=#open-chat,#help",
    ].join("\n"), { SLIRC_MODE: "private_workspace", OPEN_CHANNELS: "" });
    expect(env.SLIRC_MODE).toBe("public_playground");
    expect(env.IRC_CHANNEL).toBe("#untitled");
    expect(env.OPEN_CHANNELS).toBe("#open-chat,#help");
  });
});

describe.skipIf(!podmanCompose)("deploy compose configuration via podman-compose", () => {
  test("a private tenant keeps its env file and gets no channel overrides", () => {
    const { dir, output } = renderPodman("app.compose.yaml", [
      "SLIRC_MODE=private_workspace",
      "IRC_CHANNEL=#tenant",
      "OPEN_CHANNELS=",
    ].join("\n"), { IRC_CHANNEL: "#shell", OPEN_CHANNELS: "#shell-wins", SLIRC_MODE: "public_playground" });
    expect(keepsEnvFile(output, dir)).toBe(true);
    expect(hasKey(output, "DB_PATH")).toBe(true);
    for (const key of ["SLIRC_MODE", "IRC_CHANNEL", "OPEN_CHANNELS"]) expect(hasKey(output, key)).toBe(false);
  });

  test("Ergo injects no SASL admission key", () => {
    const { output } = renderPodman("ergo.compose.yaml", "OWNER_NICK=tenant\n");
    expect(hasKey(output, "ERGO__ACCOUNTS__DEFAULT_USER_MODES")).toBe(true);
    expect(hasKey(output, "ERGO__ACCOUNTS__REQUIRE_SASL__ENABLED")).toBe(false);
  });
});
