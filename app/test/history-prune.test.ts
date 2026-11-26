// scripts/history-prune.ts against the fake Ergo: it must OPER before SAJOIN, delete only what its
// mode selects, and print Ergo's reason when a join is refused.
import "./fixture.ts";

import { afterEach, expect, test } from "bun:test";

const { startFakeIrc } = await import("./fake-irc.ts");

const HISTORY = [
  "@msgid=j1;time=2026-11-01T09:00:00.000Z :slirc-org-a1b2c3!u@h JOIN #calango",
  "@msgid=p1;account=ana;time=2026-11-01T09:01:00.000Z :ana!u@h PRIVMSG #calango :hello",
  "@msgid=j2;account=ana;time=2026-11-01T09:02:00.000Z :ana!u@h JOIN #calango",
  "@msgid=m1;time=2026-11-01T09:03:00.000Z :slirc-org!u@h MODE #calango +o ana",
];

let fake: ReturnType<typeof startFakeIrc> | null = null;
afterEach(() => { fake?.close(); fake = null; });

const prune = async (port: number, args: string[]) => {
  const proc = Bun.spawn([process.execPath, "scripts/history-prune.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, ERGO_HOST: "127.0.0.1", ERGO_PORT: String(port), ERGO_OPER_USER: "slirc-org", ERGO_OPER_PASS: "oper-pass", OPER_PERSISTENT: "0", DB_PATH: ":memory:" },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
};

test("prune opers first and deletes only the app's own events", async () => {
  fake = startFakeIrc(HISTORY);
  const result = await prune(fake.port, ["prune", "#calango"]);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  expect(fake.lines).toContain("OPER slirc-org oper-pass");
  expect(result.out).toContain("#calango: scanned 4 items, 2 app events to delete");
  expect(fake.lines.filter((line) => line.startsWith("PRIVMSG HistServ")).sort()).toEqual([
    "PRIVMSG HistServ :DELETE #calango j1", "PRIVMSG HistServ :DELETE #calango m1",
  ]);
});

test("the dry run lists and deletes nothing", async () => {
  fake = startFakeIrc(HISTORY);
  const result = await prune(fake.port, ["events", "#calango", "--dry-run"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("#calango: scanned 4 items, 3 events to delete");
  expect(result.out).toContain("would delete 2026-11-01T09:02:00.000Z JOIN ana");
  expect(fake.lines.some((line) => line.startsWith("PRIVMSG HistServ"))).toBe(false);
});

test("a refused join prints Ergo's reason, skips the channel and fails", async () => {
  fake = startFakeIrc(HISTORY);
  const result = await prune(fake.port, ["clear", "#gone", "--dry-run"]);
  expect(result.code).toBe(1);
  expect(result.out).toContain("#gone: could not join (403 #gone No such channel), skipped");
});
