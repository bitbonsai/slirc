import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const selfPath = "app/test/core-leak-guard.test.ts";

const forbidden: { label: string; pattern: RegExp }[] = [
  { label: "bb8", pattern: /\bbb8\b/i },
  { label: "cama-goby", pattern: /cama-goby/i },
  { label: "/home/mwolff", pattern: /\/home\/mwolff/i },
  { label: "/Users/mwolff", pattern: /\/Users\/mwolff/i },
  { label: "wolffserver", pattern: /wolffserver/i },
  { label: "HX4V85BM62", pattern: /HX4V85BM62/ },
  { label: "10.89.15.", pattern: /10\.89\.15\./ },
];

test("tracked text files in the core repo contain no internal hostnames, paths, or IDs", () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  }

  const files = listed.stdout.toString().split("\0").filter(Boolean);
  const violations: string[] = [];

  for (const relPath of files) {
    if (relPath === selfPath) continue;
    const raw = readFileSync(join(repoRoot, relPath));
    if (raw.includes(0)) continue; // skip binary files

    const lines = raw.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      for (const { label, pattern } of forbidden) {
        if (pattern.test(line)) {
          violations.push(`${relPath}:${index + 1} (${label})`);
        }
      }
    }
  }

  expect(violations).toEqual([]);
});
