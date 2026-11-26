// Bare dev commands use slirc2 without a profile selector. Keep its existing names, ports and
// data volumes, and never read or copy ~/.config/slirc. Dry runs do not touch running services.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const devJust = readFileSync(join(repoRoot, "scripts", "just", "dev.just"), "utf8");
const just = Bun.which("just");

function dryRun(profile?: string, recipe = "dev"): string {
  const env = { ...process.env } as Record<string, string>;
  delete env.SLIRC_CONFIG_DIR;
  if (profile === undefined) delete env.SLIRC_DEV_PROFILE;
  else env.SLIRC_DEV_PROFILE = profile;
  const run = Bun.spawnSync(["just", "--dry-run", recipe], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return run.stdout.toString() + run.stderr.toString();
}

describe.skipIf(!just)("local dev stack", () => {
  test("bare dev commands inspect and seed the existing slirc2 containers", () => {
    expect(dryRun(undefined, "dev-status")).toContain("^slirc2-(app|ergo|landing)$");
    expect(dryRun(undefined, "dev-logs")).toContain("container=slirc2-app");
    expect(dryRun(undefined, "dev-seed")).toContain("podman exec slirc2-app");
  });

  test("bare just dev keeps slirc2 projects, network, volumes, ports and generated config", () => {
    const out = dryRun();
    for (const token of [
      'SLIRC_NETWORK="slirc2"',
      'SLIRC_APP_CONTAINER="slirc2-app"',
      'SLIRC_ERGO_CONTAINER="slirc2-ergo"',
      'SLIRC_APP_DATA_VOLUME="slirc2-data"',
      'SLIRC_ERGO_DATA_VOLUME="slirc2-ergo-data"',
      'SLIRC_ERGO_API_VOLUME="slirc2-ergo-api"',
      "172.30.16.0/24",
      "172.30.16.2",
      "$tailscale_ip:9110:8080",
      '127.0.0.1:9110:8080',
      'ERGO_TLS_BIND="127.0.0.1"',
      "9109",
      "6797",
    ]) {
      expect(out).toContain(token);
    }
    // Browsers use the app's /irc relay; Ergo publishes no WebSocket port.
    expect(out).not.toContain("ERGO_WS_PORT");
    // Config is generated from the tracked example and confined to the checkout's .data/.
    expect(out).toContain("cp ergo/ergo.example.yaml");
    expect(out).toContain(join(repoRoot, ".data", "dev-slirc2", "config"));
    // Channel-first fixtures: two real accounts, one private room, local helpers, no live providers.
    expect(out).toContain('OWNER_NICK=admin');
    expect(out).toContain('OPEN_CHANNELS: "#dev-open"');
    expect(out).toContain('"USERS_JSON=$admin_users"');
    expect(out).toContain("USERS_JSON: |-\n        $admin_users");
    expect(out).not.toContain("bitbonsai@example.test");
    // IRC passwords derive from a generated key, never a fixture password list.
    expect(out).not.toContain("IRC_PASSWORDS_JSON");
    expect(out).toContain('openssl rand -out "$config_dir/irc-key" 32');
    expect(out).toContain('"$config_dir/irc-key:/run/slirc-irc-key:ro"');
    expect(out).toContain('SEED_CHANNELS_JSON={"#dev-test":{"private":true,"members":["admin","eve"]}}');
    expect(out).toContain('SLIRC_HELPERS_ENABLED: "true"');
    for (const token of ["SLIRC_BOT_ENABLED=false", "SLIRC_HELPERS_ENABLED=true", "SLIRC_ROOM_AMBIENCE=false"]) {
      expect(out).toContain(token);
    }
    // Model keys pass through by name from .env when set, so the help bot answers locally. A value
    // never appears in the recipe or the override it writes.
    expect(out).toContain("for key in OPENROUTER_API_KEY TYPESAFE_API_KEY; do");
    expect(out).toContain('model_env+="      $key:"');
    expect(out).not.toMatch(/(OPENROUTER|TYPESAFE)_API_KEY[:=] *\S/);
    expect(out).not.toContain("GIPHY_API_KEY");
    expect(out).not.toContain("RESEND_API_KEY");
    // No legacy local-stack ports or subnet.
    expect(out).not.toContain(":9010");
    expect(out).not.toContain(":9009");
    expect(out).not.toContain("172.30.15");
  });

  test("fixture seed refuses non-local execution before creating a database", () => {
    const dir = mkdtempSync(join(tmpdir(), "slirc-client-gate-"));
    const database = join(dir, "should-not-exist.sqlite");
    try {
      const result = Bun.spawnSync([process.execPath, "app/scripts/client-seed.ts"], {
        cwd: repoRoot,
        env: { ...process.env, DB_PATH: database, APP_ORIGIN: "https://app.slirc.test", SLIRC_DEV_PROFILE: "" },
        stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Client seed requires the isolated local profile");
      expect(existsSync(database)).toBe(false);
      expect(dryRun()).toContain("bun scripts/client-seed.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty room seed stays empty without provisioning Eve", () => {
    const dir = mkdtempSync(join(tmpdir(), "slirc-empty-seed-"));
    const database = join(dir, "app.sqlite");
    try {
      for (let run = 0; run < 2; run++) {
        const result = Bun.spawnSync([process.execPath, "app/scripts/client-seed.ts"], {
          cwd: repoRoot,
          env: { DB_PATH: database, APP_ORIGIN: "http://localhost:9110", SLIRC_DEV_PROFILE: "slirc2", SEED_CHANNELS_JSON: "{}" },
          stdout: "pipe", stderr: "pipe",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
      }
      const db = new Database(database, { readonly: true });
      try {
        for (const table of ["accounts", "channels", "channel_members"]) {
          expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
      } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("seed admin email comes from .env and is required before config generation", () => {
    const setup = devJust.slice(devJust.indexOf('  admin_users="'), devJust.indexOf('  config_dir="'));
    expect(setup).toContain("SLIRC_DEV_ADMIN_EMAIL");
    for (const email of ["  Admin@domain.com  ", "o'brien@domain.com", "", "invalid", "one@domain.com\nOWNER_NICK=other"]) {
      const run = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", `${setup}\nprintf '%s' "$admin_users"`], {
        env: { ...process.env, SLIRC_DEV_ADMIN_EMAIL: email }, stdout: "pipe", stderr: "pipe",
      });
      if (email.includes("domain.com") && !email.includes("\n")) {
        expect(run.exitCode, run.stderr.toString()).toBe(0);
        expect(JSON.parse(run.stdout.toString())).toEqual({ admin: email.trim().toLowerCase(), eve: "eve@example.test" });
      } else {
        expect(run.exitCode).not.toBe(0);
        expect(run.stderr.toString()).toContain("Set SLIRC_DEV_ADMIN_EMAIL");
      }
    }
    const env = { ...process.env };
    delete env.SLIRC_DEV_ADMIN_EMAIL;
    const missing = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", setup], { env, stdout: "pipe", stderr: "pipe" });
    expect(missing.exitCode).not.toBe(0);
  });

  test("only macOS starts a VM; Linux reports Podman failures", () => {
    const startup = devJust.slice(devJust.indexOf('  if [ "$(uname -s)"'), devJust.indexOf('  podman image exists'));
    expect(startup).toContain("podman info");
    for (const [platform, ready, exitCode, startsVM] of [
      ["Linux", 0, 0, false],
      ["Linux", 1, 1, false],
      ["Darwin", 0, 0, false],
      ["Darwin", 1, 0, true],
    ] as const) {
      const run = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", `
        ready=${ready}
        uname() { echo ${platform}; }
        podman() {
          if [ "$1" = info ]; then return "$ready"; fi
          echo "$*"
          ready=0
        }
        ${startup}
      `], { stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(exitCode);
      expect(run.stdout.toString().includes("machine start")).toBe(startsVM);
    }
  });

  test("no wildcard or name-pattern process kills", () => {
    expect(devJust).not.toMatch(/\bpkill\b|\bpgrep\b|\bkillall\b|\bkill\s+-/);
  });
});
