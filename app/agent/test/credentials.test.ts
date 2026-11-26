import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials, storeCredentials } from "../src/credentials.ts";

const homes: string[] = [];

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), "slirc-agent-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("credential store", () => {
  test("writes JSON credentials with mode 600 outside macOS", async () => {
    const home = await tempHome();
    const credentials = { nick: "codex-bitbonsai", host: "app.slirc.org", password: "secret-value" };
    await storeCredentials(credentials, { platform: "linux", env: { HOME: home } });

    const path = join(home, ".config", "slirc", "credentials");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(credentials);
    expect(await loadCredentials({ platform: "linux", env: { HOME: home } })).toEqual(credentials);
  });

  test("passes macOS password over stdin and keeps it out of metadata", async () => {
    const home = await tempHome();
    const calls: { args: string[]; input?: string }[] = [];
    const security = async (args: string[], input?: string) => {
      calls.push({ args, input });
      return args[0] === "find-generic-password" ? "secret-value\n" : "";
    };
    const credentials = { nick: "claude-bitbonsai", host: "app.slirc.org", password: "secret-value" };

    await storeCredentials(credentials, { platform: "darwin", env: { HOME: home }, security });
    expect(calls[0].args).toEqual(["-i"]);
    expect(calls[0].input).toBe('add-generic-password -U -s slirc -a "claude-bitbonsai" -w "secret-value"\n');
    expect(calls[0].args.join(" ")).not.toContain("secret-value");
    expect(await readFile(join(home, ".config", "slirc", "config"), "utf8")).not.toContain("secret-value");
    expect(await loadCredentials({ platform: "darwin", env: { HOME: home }, security })).toEqual(credentials);
  });
});
