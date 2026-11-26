// Guards isolated boot fixtures: opt-in must reject before DB open, fixture rooms stay labelled,
// and resume never replays an uncertain send.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_CHANNEL,
  BOOT_CHANNEL_TOPIC,
  BOOT_OPEN_CHANNEL_TOPIC,
  bootChannelMessages,
  bootOpenMessages,
  bootDirectMessages,
  bootSeedGuard,
  messageStamp,
  resumeAction,
  trackMembership,
} from "../scripts/boot-fixtures.ts";

const repoRoot = join(import.meta.dir, "..", "..");

describe("boot fixture plan", () => {
  test("fixture status is labelled once in the room topic, not on every line", () => {
    expect(BOOT_CHANNEL_TOPIC).toContain("Fixture room");
    expect(BOOT_OPEN_CHANNEL_TOPIC).toContain("local fixture data");
    const everyLine = [
      ...bootChannelMessages.map((message) => message.text),
      ...bootOpenMessages.map((message) => message.text),
      ...bootDirectMessages.flatMap((dm) => dm.lines.map((line) => line.text)),
    ];
    expect(everyLine.some((line) => line.includes("[local fixture]"))).toBe(false);
  });

  test("stamps are unique per room, sender and index", () => {
    const keys = [
      messageStamp("channel", BOOT_CHANNEL, "eve", 0),
      messageStamp("channel", BOOT_CHANNEL, "eve", 1),
      messageStamp("channel", BOOT_CHANNEL, "ben", 0),
      messageStamp("dm", "eve", "peer", 0),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("resume policy never blindly replays an uncertain send", () => {
    expect(resumeAction(null)).toBe("send");
    expect(resumeAction({ status: "confirmed", at: 1 })).toBe("skip");
    expect(resumeAction({ status: "sending", at: 1 })).toBe("warn");
  });

  test("membership tracker recognises an always-on autojoin and ignores other people", () => {
    const channels = new Set<string>();
    // Ben joining does not make eve a member.
    trackMembership(channels, "eve", { command: "JOIN", prefix: "ben!u@h", params: ["#dm-bitbonsai-eve"] });
    expect(channels.has("#dm-bitbonsai-eve")).toBe(false);
    // Eve's own JOIN during connect is the autojoin ensureJoin must recognise.
    trackMembership(channels, "eve", { command: "JOIN", prefix: "eve!u@h", params: ["#dm-bitbonsai-eve"] });
    expect(channels.has("#dm-bitbonsai-eve")).toBe(true);
    trackMembership(channels, "eve", { command: "PART", prefix: "eve!u@h", params: ["#dm-bitbonsai-eve"] });
    expect(channels.has("#dm-bitbonsai-eve")).toBe(false);
    trackMembership(channels, "eve", { command: "JOIN", prefix: "eve!u@h", params: ["#dev-test"] });
    trackMembership(channels, "eve", { command: "KICK", prefix: "oper!u@h", params: ["#dev-test", "eve"] });
    expect(channels.has("#dev-test")).toBe(false);
  });
});

describe("boot seed guard", () => {
  test("requires both explicit flags", () => {
    expect(bootSeedGuard({}).ok).toBe(false);
    expect(bootSeedGuard({ SLIRC_BOOT_SEED: "true" }).ok).toBe(false);
    expect(bootSeedGuard({ SLIRC_DEV_PROFILE: "slirc2" }).ok).toBe(false);
    expect(bootSeedGuard({ SLIRC_BOOT_SEED: "true", SLIRC_DEV_PROFILE: "default" }).ok).toBe(false);
    expect(bootSeedGuard({ SLIRC_BOOT_SEED: "true", SLIRC_DEV_PROFILE: "slirc2" }).ok).toBe(true);
  });
});

test("guard rejects before creating a database", () => {
  const dir = mkdtempSync(join(tmpdir(), "slirc-boot-gate-"));
  const database = join(dir, "should-not-exist.sqlite");
  try {
    const result = Bun.spawnSync([process.execPath, "app/scripts/boot-seed.ts"], {
      cwd: repoRoot,
      // Opt-in set, profile flag deliberately absent: the run must die before touching SQLite.
      env: { ...process.env, DB_PATH: database, SLIRC_BOOT_SEED: "true", SLIRC_DEV_PROFILE: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("SLIRC_DEV_PROFILE=slirc2");
    expect(existsSync(database)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
