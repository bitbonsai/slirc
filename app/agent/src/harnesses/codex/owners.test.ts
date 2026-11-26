import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexProcesses, isTui, owners, type Proc } from "./owners.ts";

const THREAD = "01a1ef73-22d7-7e61-90ef-5cf508a89f58";
const OTHER = "01a1ef76-7ac7-7812-aaa9-50e537b9cf21";
const proc = (pid: number, command: string, cwd = "/work"): Proc => ({ pid, argv: command.split(" "), cwd });

test("only interactive Codex windows count, not the daemon or other commands", () => {
  expect(isTui(["codex"])).toBe(true);
  expect(isTui(["/opt/homebrew/bin/codex", "--model", "gpt-5", "slirc calango"])).toBe(true);
  expect(isTui(["codex", "resume", THREAD])).toBe(true);
  expect(isTui(["/x/bin/codex", "app-server", "--listen", "unix://"])).toBe(false);
  expect(isTui(["codex", "queue", "--thread", THREAD])).toBe(false);
  expect(isTui(["codex", "--no-daemon"])).toBe(false);
  expect(isTui(["node", "codex"])).toBe(false);
});

test("a window that names the thread owns it; otherwise every window in its folder might", () => {
  const procs = [proc(1, "codex"), proc(2, `codex resume ${OTHER}`), proc(3, "codex", "/elsewhere"), proc(4, "codex app-server --listen unix://")];
  expect(owners(THREAD, "/work", procs)).toEqual([1]);
  expect(owners(THREAD, "/work", [...procs, proc(5, `codex resume ${THREAD}`, "/elsewhere")])).toEqual([5]);
  // Dormant, a new window in the same folder is another thread; only one that names it counts.
  expect(owners(THREAD, "/work", procs, false)).toEqual([]);
  expect(owners(THREAD, "/work", [proc(5, `codex resume ${THREAD}`)], false)).toEqual([5]);
});

test("lsof is asked only about windows, so the daemon alone needs no folder lookup", async () => {
  // Stand-ins named codex: the daemon (`codex app-server`) and a window (`codex window`), each a
  // script Bun runs. lsof is a script that logs what it was asked and answers with this folder.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "slirc-codex-owners-")));
  symlinkSync(process.execPath, join(dir, "codex"));
  for (const name of ["app-server", "window"]) writeFileSync(join(dir, name), "setInterval(() => {}, 1000);\n");
  const lsof = join(dir, "lsof");
  writeFileSync(lsof, `#!/bin/sh
echo "$*" >> '${dir}/lsof.log'
while [ $# -gt 0 ]; do [ "$1" = "-p" ] && pids=$2; shift; done
for p in $(echo "$pids" | tr , ' '); do echo "p$p"; echo "n${dir}"; done
`);
  chmodSync(lsof, 0o755);
  const start = (name: string) => spawn("./codex", [name], { cwd: dir, stdio: "ignore" });
  const asked = () => existsSync(join(dir, "lsof.log")) ? readFileSync(join(dir, "lsof.log"), "utf8") : "";
  const listed = async (pid: number) => {
    for (let tries = 0; tries < 50; tries++) {
      const found = (await codexProcesses(lsof))?.find((proc) => proc.pid === pid);
      if (found) return found;
      await Bun.sleep(100);
    }
  };
  const daemon = start("app-server");
  let window: ReturnType<typeof start> | undefined;
  try {
    expect(await listed(daemon.pid!)).toMatchObject({ argv: ["./codex", "app-server"] });
    expect(asked()).not.toContain(String(daemon.pid));
    window = start("window");
    expect((await listed(window.pid!))?.cwd).toBe(dir);
    if (process.platform !== "linux") expect(asked()).toContain(String(window.pid));
    expect(asked()).not.toContain(String(daemon.pid));
  } finally {
    daemon.kill();
    window?.kill();
  }
});
