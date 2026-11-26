import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandKind, configuredOpenChannels, configuredOwnerNick, ergoOperUser, slircMode } from "../src/config.ts";
import { configuredAppOrigin } from "../src/request-security.ts";

describe("instance config", () => {
  test("requires an explicit IRC oper account", () => {
    const previous = process.env.ERGO_OPER_USER;
    delete process.env.ERGO_OPER_USER;
    expect(ergoOperUser).toThrow("ERGO_OPER_USER required");
    process.env.ERGO_OPER_USER = "  slirc-org  ";
    expect(ergoOperUser()).toBe("slirc-org");
    if (previous === undefined) delete process.env.ERGO_OPER_USER;
    else process.env.ERGO_OPER_USER = previous;
  });
});

// Set exact values, keep `undefined` meaning "not in the environment", then restore.
function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.keys(values).map((key) => [key, process.env[key]] as const);
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("instance mode", () => {
  test("defaults to private_workspace when unset, never from the host", () => {
    withEnv({ SLIRC_MODE: undefined, APP_HOST: "app.slirc.org", APP_ORIGIN: "https://app.slirc.org" }, () => {
      expect(slircMode()).toBe("private_workspace");
      expect(configuredOpenChannels(undefined)).toEqual([]);
      expect(configuredOpenChannels("")).toEqual([]);
    });
  });

  test("accepts the two exact modes", () => {
    withEnv({ SLIRC_MODE: "private_workspace" }, () => expect(slircMode()).toBe("private_workspace"));
    withEnv({ SLIRC_MODE: " public_playground " }, () => expect(slircMode()).toBe("public_playground"));
  });

  test("rejects an explicit mode that names something else", () => {
    for (const value of ["", "   ", "public", "Public_Playground", "private", "true"]) {
      withEnv({ SLIRC_MODE: value }, () => {
        expect(() => slircMode()).toThrow("SLIRC_MODE must be private_workspace or public_playground");
      });
    }
  });

  test("public playground normalizes its explicit rooms", () => {
    withEnv({ SLIRC_MODE: "public_playground" }, () => {
      expect(configuredOpenChannels("#Open-Chat, #help ,, ")).toEqual(["#open-chat", "#help"]);
      expect(configuredOpenChannels("")).toEqual([]);
      expect(configuredOpenChannels(undefined)).toEqual([]);
    });
  });
});

// The mode wiring lives at rooms.ts module load, so prove it there: a helper-only check
// would pass even if the app still read OPEN_CHANNELS directly.
describe("rooms module load", () => {
  const appDir = new URL("..", import.meta.url).pathname;

  function loadRooms(env: Record<string, string>) {
    const dbPath = join(tmpdir(), `slirc-mode-${process.pid}-${Math.random().toString(16).slice(2)}.sqlite`);
    const result = Bun.spawnSync([process.execPath, "-e", 'const m = await import("./src/rooms.ts"); console.log(JSON.stringify(m.openChannels))'], {
      cwd: appDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DB_PATH: dbPath, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  test("fails on a private instance that lists public channels", () => {
    const result = loadRooms({ SLIRC_MODE: "private_workspace", OPEN_CHANNELS: "#help" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("OPEN_CHANNELS must be empty in private_workspace mode");
  });

  test("publishes the normalized rooms on a public playground", () => {
    const result = loadRooms({ SLIRC_MODE: "public_playground", OPEN_CHANNELS: "#open-chat, #help" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('["#open-chat","#help"]');
  });

  test("boots a private instance with no open channels", () => {
    const result = loadRooms({ SLIRC_MODE: "private_workspace" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("[]");
  });
});

describe("SLIRC_BRAND", () => {
  test("defaults to org when unset, even in private_workspace mode", () => {
    withEnv({ SLIRC_BRAND: undefined, SLIRC_MODE: "private_workspace" }, () => {
      expect(brandKind()).toBe("org");
    });
  });

  test("accepts slirc.org, org, slirc.app, and app (case-insensitive, trimmed)", () => {
    for (const value of ["slirc.org", "org", " SLIRC.ORG ", "ORG"]) {
      withEnv({ SLIRC_BRAND: value }, () => expect(brandKind()).toBe("org"));
    }
    for (const value of ["slirc.app", "app", " SLIRC.APP ", "APP"]) {
      withEnv({ SLIRC_BRAND: value }, () => expect(brandKind()).toBe("app"));
    }
  });

  test("rejects invalid values", () => {
    for (const value of ["", "   ", "hosted", "custom", "slirc"]) {
      withEnv({ SLIRC_BRAND: value }, () => {
        expect(() => brandKind()).toThrow("SLIRC_BRAND must be slirc.org, org, slirc.app, or app");
      });
    }
  });
});

describe("required origin and owner settings", () => {
  test("configuredAppOrigin requires APP_ORIGIN or APP_HOST", () => {
    expect(() => configuredAppOrigin({})).toThrow("APP_ORIGIN or APP_HOST required");
    expect(() => configuredAppOrigin({ APP_ORIGIN: "not a url" })).toThrow("APP_ORIGIN or APP_HOST required");
    expect(configuredAppOrigin({ APP_HOST: "chat.example.com" })).toBe("https://chat.example.com");
    expect(configuredAppOrigin({ APP_ORIGIN: "https://chat.example.com/path" })).toBe("https://chat.example.com");
    expect(configuredAppOrigin({ APP_ORIGIN: "http://127.0.0.1:9110" })).toBe("http://127.0.0.1:9110");
  });

  test("configuredOwnerNick requires OWNER_NICK or ADMIN_NICK", () => {
    expect(() => configuredOwnerNick({})).toThrow("OWNER_NICK required");
    expect(configuredOwnerNick({ OWNER_NICK: "  Alice " })).toBe("alice");
    expect(configuredOwnerNick({ ADMIN_NICK: "Admin" })).toBe("admin");
  });

  test("accounts module requires OWNER_NICK outside test mode and never hardcodes Mauricio", () => {
    const appDir = new URL("..", import.meta.url).pathname;
    const dbPath = join(tmpdir(), `slirc-owner-${process.pid}-${Math.random().toString(16).slice(2)}.sqlite`);
    try {
      const missing = Bun.spawnSync([process.execPath, "-e", "await import(\"./src/accounts.ts\")"], {
        cwd: appDir,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, DB_PATH: dbPath, NODE_ENV: "production" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr.toString()).toContain("OWNER_NICK required");

      const seeded = Bun.spawnSync([process.execPath, "-e", `
        const { db } = await import("./src/db.ts");
        await import("./src/accounts.ts");
        console.log(JSON.stringify(db.query("SELECT account, full_name FROM profiles WHERE account = 'alice'").get()));
      `], {
        cwd: appDir,
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME, DB_PATH: dbPath, NODE_ENV: "production",
          OWNER_NICK: "alice", USERS_JSON: JSON.stringify({ alice: "alice@example.test" }),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(seeded.exitCode, seeded.stderr.toString()).toBe(0);
      expect(JSON.parse(seeded.stdout.toString().trim())).toEqual({ account: "alice", full_name: "alice" });
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
    }
  });
});
