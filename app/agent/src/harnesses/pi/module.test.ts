import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pi from "./module.ts";
import { fakePi, type FakePi } from "../../../test/support/fake-pi.ts";

let fake: FakePi;
afterEach(() => fake?.done());

test("detect finds pi on PATH and knows when it runs inside Pi's shell", () => {
  fake = fakePi({ version: "1.5.2" });
  expect(pi.detect(fake.env)).toEqual({ installed: true, inside: false, version: "1.5.2" });
  expect(pi.detect({ ...fake.env, PI_CODING_AGENT: "true" }).inside).toBe(true);
  expect(pi.detect({ ...fake.env, PATH: "/usr/bin:/bin" })).toEqual({ installed: false, inside: false });
});

test("install pins this version, and a second run changes nothing", () => {
  fake = fakePi();
  expect(pi.status(fake.env, "3.0.0")).toEqual({ state: "missing" });
  const steps = pi.install(fake.env, "3.0.0");
  expect(steps.map((step) => step.doing)).toEqual(["pi install npm:slirc-agent@3.0.0"]);
  steps.forEach((step) => step.apply());
  expect(pi.status(fake.env, "3.0.0")).toEqual({ state: "current", version: "3.0.0" });
  expect(pi.install(fake.env, "3.0.0")).toEqual([]);
});

test("a 2.x install is replaced, not doubled", () => {
  fake = fakePi();
  fake.install("npm:slirc-agent", "2.4.1");
  expect(pi.status(fake.env, "3.0.0")).toEqual({ state: "outdated", version: "2.4.1" });
  pi.install(fake.env, "3.0.0").forEach((step) => step.apply());
  expect(fake.installed()).toEqual(["npm:slirc-agent@3.0.0"]);
  expect(fake.calls().filter((call) => /^(install|remove)/.test(call))).toEqual(["remove npm:slirc-agent", "install npm:slirc-agent@3.0.0"]);
});

test("uninstall removes only the Slirc package", () => {
  fake = fakePi();
  fake.install("npm:pi-caveman", "1.0.0");
  fake.install("npm:slirc-agent@3.0.0");
  expect(pi.uninstall(fake.env).map((step) => step.doing)).toEqual(["pi remove npm:slirc-agent@3.0.0"]);
  pi.uninstall(fake.env).forEach((step) => step.apply());
  expect(fake.installed()).toEqual(["npm:pi-caveman"]);
  expect(pi.uninstall(fake.env)).toEqual([]);
});

test("a hand-made Slirc extension is a conflict that says where it is", () => {
  fake = fakePi();
  const dir = join(fake.env.PI_CODING_AGENT_DIR, "extensions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "slirc.ts"), "");
  const status = pi.status(fake.env, "3.0.0");
  expect(status.state).toBe("conflict");
  expect(status.detail).toContain(join(dir, "slirc.ts"));
  expect(pi.install(fake.env, "3.0.0")).toEqual([]);
});

test("launch starts pi with pairing armed for that one start", () => {
  fake = fakePi();
  expect(pi.launch("calango.slirc.app", fake.env, ["--model", "x"])).toEqual({ bin: "pi", args: ["--model", "x"], env: { ...fake.env, SLIRC_CONNECT: "calango.slirc.app" } });
  expect(pi.sessionCommand("calango")).toBe("/slirc calango");
  expect(pi.sessionCommand("")).toBe("/slirc");
});
