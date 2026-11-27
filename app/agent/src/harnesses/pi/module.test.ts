import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pi, { npmRetry } from "./module.ts";
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
  expect(fake.calls().filter((call) => /^(install|remove)/.test(call))).toEqual(["install npm:slirc-agent@3.0.0"]);
});

test("an update installs over the old version and never removes it first", () => {
  fake = fakePi();
  fake.install("npm:slirc-agent@3.4.0");
  const steps = pi.install(fake.env, "3.5.0");
  expect(steps.map((step) => step.doing)).toEqual(["pi install npm:slirc-agent@3.5.0"]);
  steps.forEach((step) => step.apply());
  expect(fake.installed()).toEqual(["npm:slirc-agent@3.5.0"]);
  expect(fake.calls().some((call) => call.startsWith("remove"))).toBe(false);
});

test("a failed update leaves the working extension installed", () => {
  fake = fakePi({ broken: true });
  fake.install("npm:slirc-agent@3.4.0");
  const [step] = pi.install(fake.env, "3.5.0");
  expect(() => step.apply()).toThrow("pi install npm:slirc-agent@3.5.0 failed");
  expect(fake.installed()).toEqual(["npm:slirc-agent@3.4.0"]);
  expect(pi.status(fake.env, "3.5.0")).toEqual({ state: "outdated", version: "3.4.0" });
});

test("npm's delay right after a release is waited out, then named when it lasts", () => {
  const saved = { ...npmRetry };
  npmRetry.waitMs = 1;
  try {
    // ETARGET twice, then the version shows up.
    fake = fakePi({ notYet: 2 });
    fake.install("npm:slirc-agent@3.4.0");
    pi.install(fake.env, "3.5.0").forEach((step) => step.apply());
    expect(fake.installed()).toEqual(["npm:slirc-agent@3.5.0"]);
    expect(fake.calls().filter((call) => call.startsWith("install"))).toHaveLength(3);
    fake.done();
    // Still missing after every try: a plain message, and the old version still works.
    fake = fakePi({ notYet: 99 });
    fake.install("npm:slirc-agent@3.4.0");
    const [step] = pi.install(fake.env, "3.5.0");
    expect(() => step.apply()).toThrow("npm doesn't offer slirc-agent 3.5.0 yet. That's a short delay npm has after each release. Wait a minute, then run this again.");
    expect(fake.calls().filter((call) => call.startsWith("install"))).toHaveLength(npmRetry.tries);
    expect(fake.installed()).toEqual(["npm:slirc-agent@3.4.0"]);
  } finally { Object.assign(npmRetry, saved); }
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
