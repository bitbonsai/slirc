import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Line limits that keep the server, runtime and stylesheet splits from growing back into one file.
// Each limit is today's largest file in the group plus modest headroom. A file that passes its limit
// should be split along the lines in ARCHITECTURE.md; raise a limit only with a reason.
const APP = join(import.meta.dir, "..");
const LIMITS: { dir: string; suffix: string; only?: string; max: number }[] = [
  { dir: "client", suffix: ".ts", only: "runtime.ts", max: 800 },
  { dir: "src", suffix: ".ts", only: "server.ts", max: 450 },
  { dir: "src/routes", suffix: ".ts", max: 750 },
  { dir: "client/core", suffix: ".ts", max: 550 },
  { dir: "client/features", suffix: ".ts", max: 400 },
  { dir: "styles", suffix: ".css", max: 320 },
];

const lineCount = (path: string) => readFileSync(path, "utf8").split("\n").length - 1;

test("source files stay under their line limit", () => {
  const over: string[] = [];
  for (const { dir, suffix, only, max } of LIMITS) {
    const names = readdirSync(join(APP, dir)).filter((name) => (only ? name === only : name.endsWith(suffix)));
    expect(names.length, `nothing found in ${dir}`).toBeGreaterThan(0);
    for (const name of names) {
      const count = lineCount(join(APP, dir, name));
      if (count > max) over.push(`${dir}/${name} has ${count} lines, limit ${max}`);
    }
  }
  expect(over).toEqual([]);
});
