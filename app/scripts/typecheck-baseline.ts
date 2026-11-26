// Fails only on type errors that are not in typecheck-baseline.txt.
// Line numbers are left out of the baseline so unrelated edits do not churn it.
// Run with --update after fixing errors to shrink the baseline.
import { resolve } from "node:path";

const appDir = resolve(import.meta.dir, "..");

const baselinePath = resolve(import.meta.dir, "../typecheck-baseline.txt");
const proc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "--pretty", "false"], { cwd: appDir, stdout: "pipe", stderr: "pipe" });
const output = proc.stdout.toString() + proc.stderr.toString();
const current = output.split("\n")
  .map((l) => l.match(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/))
  .filter((m): m is RegExpMatchArray => !!m)
  .map((m) => `${m[1]} ${m[2]} ${m[3].replaceAll(appDir, "<app>")}`)
  .sort();

if (!current.length && proc.exitCode !== 0) { console.error(output); process.exit(1); }

if (process.argv.includes("--update")) {
  await Bun.write(baselinePath, current.join("\n") + (current.length ? "\n" : ""));
  console.log(`Baseline holds ${current.length} errors`);
  process.exit(0);
}

const counts = new Map<string, number>();
for (const line of (await Bun.file(baselinePath).text()).split("\n").filter(Boolean)) counts.set(line, (counts.get(line) || 0) + 1);
const added: string[] = [];
for (const line of current) {
  const left = counts.get(line) || 0;
  if (left > 0) counts.set(line, left - 1); else added.push(line);
}
const fixed = [...counts.values()].reduce((a, b) => a + b, 0);
if (added.length) {
  console.error(`${added.length} new type errors:\n${added.join("\n")}`);
  process.exit(1);
}
console.log(`No new type errors (${current.length} in baseline${fixed ? `, ${fixed} fixed: run bun run typecheck:baseline to shrink it` : ""})`);
