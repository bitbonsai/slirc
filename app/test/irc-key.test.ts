import "./fixture.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ircPasswordFor, accountIrcPassword } = await import("../src/irc-key.ts");

test("same id and counter give the same password; a new counter or id gives another", () => {
  const a = ircPasswordFor("0123456789abcdef0123456789abcdef", 0);
  expect(a).toBe(ircPasswordFor("0123456789abcdef0123456789abcdef", 0));
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(ircPasswordFor("0123456789abcdef0123456789abcdef", 1)).not.toBe(a);
  expect(ircPasswordFor("fedcba9876543210fedcba9876543210", 0)).not.toBe(a);
  expect(() => ircPasswordFor("", 0)).toThrow();
  expect(() => ircPasswordFor("abc", -1)).toThrow();
});

test("a row derives from its counter; a row inserted without one counts as 0", () => {
  expect(accountIrcPassword({ account_id: "abc", irc_password_gen: null })).toBe(ircPasswordFor("abc", 0));
  expect(accountIrcPassword({ account_id: "abc", irc_password_gen: 2 })).toBe(ircPasswordFor("abc", 2));
});

async function derive(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "-e", `const { ircPasswordFor } = await import(${JSON.stringify(join(import.meta.dir, "../src/irc-key.ts"))}); console.log(ircPasswordFor("abc", 0));`], {
    env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { status: await child.exited, stdout: stdout.trim(), stderr };
}

test("outside tests the app refuses to run without a key file, and a new key gives other passwords", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slirc-irc-key-"));
  const missing = await derive({ NODE_ENV: "production", SLIRC_IRC_KEY_FILE: join(dir, "absent") });
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("is missing");
  writeFileSync(join(dir, "short"), Buffer.alloc(16, 1));
  expect((await derive({ NODE_ENV: "production", SLIRC_IRC_KEY_FILE: join(dir, "short") })).stderr).toContain("shorter than 32 bytes");
  writeFileSync(join(dir, "one"), Buffer.alloc(32, 1));
  writeFileSync(join(dir, "two"), Buffer.alloc(32, 2));
  const one = await derive({ NODE_ENV: "production", SLIRC_IRC_KEY_FILE: join(dir, "one") });
  const two = await derive({ NODE_ENV: "production", SLIRC_IRC_KEY_FILE: join(dir, "two") });
  expect(one.status).toBe(0);
  expect(one.stdout).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(two.stdout).not.toBe(one.stdout);
  expect(one.stdout).not.toBe(ircPasswordFor("abc", 0));
});

test("the server refuses to start without a key", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/server.ts")], {
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", OWNER_NICK: "admin", APP_ORIGIN: "https://app.example.test", DB_PATH: ":memory:", SLIRC_IRC_KEY_FILE: "/nonexistent/irc-key", ERGO_API_MOCK: "true", ERGO_OPER_USER: "slirc-org", PORT: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  const stderr = await new Response(child.stderr).text();
  clearTimeout(timer);
  expect(await child.exited).not.toBe(0);
  expect(stderr).toContain("IRC key file /nonexistent/irc-key is missing");
});
