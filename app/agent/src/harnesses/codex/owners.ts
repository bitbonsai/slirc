import { execFile } from "node:child_process";
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { basename } from "node:path";

// Which Codex TUI windows show a thread. Codex keeps a thread loaded in its daemon after the TUI
// closes and fires no hook when it goes, and the daemon has no way to ask who is watching a
// thread. So the listener looks at processes: a TUI whose arguments name the thread (`codex resume
// <id>`) owns it; failing that, every TUI in the thread's folder might. Erring that way keeps a
// session online a little longer, never offline while its window is open.

export type Proc = { pid: number; argv: string[]; cwd?: string };

// Codex commands that aren't an interactive TUI.
const NOT_TUI = new Set(["app-server", "exec", "e", "queue", "plugin", "mcp", "mcp-server", "login", "logout", "debug", "sandbox", "apply", "a",
  "completion", "features", "doctor", "update", "cloud", "exec-server", "archive", "delete", "unarchive", "review", "help", "remote-control", "app"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isTui = (argv: string[]) => basename(argv[0] ?? "") === "codex" && !NOT_TUI.has(argv.slice(1).find((arg) => !arg.startsWith("-")) ?? "")
  && !argv.includes("--no-daemon");

// `byFolder` false: only TUIs that name the thread, which is what a reopen looks like.
export function owners(threadId: string, cwd: string, procs: Proc[], byFolder = true): number[] {
  const tuis = procs.filter((proc) => isTui(proc.argv));
  const named = tuis.filter((proc) => proc.argv.includes(threadId));
  if (named.length || !byFolder) return named.map((proc) => proc.pid);
  const folder = real(cwd);
  // A TUI that names another thread shows that one.
  return tuis.filter((proc) => !proc.argv.some((arg) => UUID.test(arg) && arg !== threadId) && proc.cwd && real(proc.cwd) === folder).map((proc) => proc.pid);
}

const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };

// This user's processes named codex, with their folders. Undefined when ps itself fails, so a
// broken check never takes a session offline.
// Run without blocking: the listener answers hooks and tool calls meanwhile.
const output = (bin: string, args: string[], timeout = 5_000) => new Promise<{ ok: boolean; out: string }>((done) =>
  execFile(bin, args, { encoding: "utf8", timeout }, (error, stdout) => done({ ok: !error, out: String(stdout ?? "") })));

// `lsof` is the macOS lookup; tests pass a stand-in.
export async function codexProcesses(lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof"): Promise<Proc[] | undefined> {
  const listed = await output("ps", ["-xo", "pid=,command="]);
  if (!listed.ok) return undefined;
  const listing = listed.out;
  const procs = listing.split("\n").map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((match): match is RegExpExecArray => !!match)
    .map(([, pid, command]) => ({ pid: Number(pid), argv: command.split(/\s+/) }))
    .filter((proc) => basename(proc.argv[0]) === "codex");
  // Only windows need a folder. With none open (the daemon alone, after the last window closed)
  // there's nothing to look up, so a slow lsof can't keep a closed session online.
  const tuis = procs.filter((proc) => isTui(proc.argv));
  if (!tuis.length) return procs;
  // Linux keeps each folder in /proc. macOS has lsof, in /usr/sbin, which a daemon's PATH may lack.
  if (process.platform === "linux") {
    for (const proc of tuis) { try { proc.cwd = readlinkSync(`/proc/${proc.pid}/cwd`); } catch {} }
    return procs;
  }
  // lsof exits 1 when one of the processes is already gone, with the others' answers on stdout.
  // It can take over 10 s on a loaded Mac (0.3 s idle), so it gets longer than ps.
  const { out } = await output(lsof, ["-a", "-d", "cwd", "-p", tuis.map((proc) => proc.pid).join(","), "-Fpn"], 20_000);
  if (!out) return undefined;
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) { const proc = tuis.find((item) => item.pid === pid); if (proc) proc.cwd = line.slice(1); }
  }
  // No folder for any window means lsof couldn't tell (a timeout under load): unknown, not gone.
  if (!tuis.some((proc) => proc.cwd)) return undefined;
  return procs;
}
