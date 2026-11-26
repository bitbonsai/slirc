import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnesses } from "../src/harnesses/index.ts";

// Every registered harness module keeps the contract in src/harnesses/types.ts. A new module is
// checked here the moment it is added to the registry.
for (const harness of harnesses) {
  test(`${harness.id}: identity, released flag and commands are well formed`, () => {
    expect(harness.id).toMatch(/^[a-z][a-z0-9-]{0,15}$/);
    expect(harness.name.trim()).toBe(harness.name);
    expect(typeof harness.released).toBe("boolean");
    expect(harness.homepage).toMatch(/^https:\/\//);
    expect(harness.sessionCommand("calango")).toContain("calango");
    expect(harness.sessionCommand("")).not.toContain("undefined");
    if (harness.reloadHint !== undefined) expect(harness.reloadHint).toBeTruthy();
  });

  test(`${harness.id}: with the harness absent, every check answers without throwing or changing anything`, () => {
    const home = mkdtempSync(join(tmpdir(), `slirc-contract-${harness.id}-`));
    const env = { PATH: "/nonexistent", HOME: home, XDG_STATE_HOME: join(home, "state") };
    try {
      expect(harness.detect(env)).toMatchObject({ installed: false, inside: false });
      expect(["missing", "conflict"]).toContain(harness.status(env, "3.0.0").state);
      expect(Array.isArray(harness.install(env, "3.0.0"))).toBe(true);
      expect(harness.uninstall(env)).toEqual([]);
      const launch = harness.launch("calango.slirc.app", env, ["--x"]);
      expect(typeof launch.bin).toBe("string");
      expect(launch.args).toContain("--x");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("ids are unique", () => {
  expect(new Set(harnesses.map((harness) => harness.id)).size).toBe(harnesses.length);
});
