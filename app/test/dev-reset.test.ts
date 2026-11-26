// The reset guard must reject a production or mismatched target before any container
// stops or any volume is removed. The destructive path itself is not exercised here.
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LOCAL,
  evaluateReset,
  gatherFacts,
  runReset,
  type ContainerFacts,
  type MountFacts,
  type ResetFacts,
} from "../scripts/dev-reset.ts";

const checkout = "/srv/slirc";
const appMounts: MountFacts[] = [
  { type: "volume", name: LOCAL.appVolume, source: "/vol/slirc2-data/_data", destination: "/data" },
  { type: "volume", name: LOCAL.ergoApiVolume, source: "/vol/slirc2-ergo-api/_data", destination: "/run/secrets" },
  { type: "bind", name: "", source: join(checkout, "app"), destination: "/app" },
];
const ergoMounts: MountFacts[] = [
  { type: "volume", name: LOCAL.ergoDataVolume, source: "/vol/slirc2-ergo-data/_data", destination: "/ircd" },
  { type: "volume", name: LOCAL.ergoApiVolume, source: "/vol/slirc2-ergo-api/_data", destination: "/run/secrets" },
  { type: "bind", name: "", source: join(checkout, ".data/dev-slirc2/config/ergo.yaml"), destination: "/ircd/ircd.yaml" },
  { type: "bind", name: "", source: join(checkout, "ergo/ergo.motd"), destination: "/ircd/ergo.motd" },
];
const app: ContainerFacts = {
  project: LOCAL.project,
  configFiles: `deploy/app.compose.yaml,${join(checkout, ".data/dev-slirc2/app.override.yaml")}`,
  profile: "slirc2",
  networks: [LOCAL.network],
  mounts: appMounts,
};
const ergo: ContainerFacts = {
  project: LOCAL.ergoProject,
  configFiles: `deploy/ergo.compose.yaml,${join(checkout, ".data/dev-slirc2/ergo.override.yaml")}`,
  profile: null,
  networks: [LOCAL.network],
  mounts: ergoMounts,
};
const facts = (over: Partial<ResetFacts> = {}): ResetFacts => ({
  hostname: "devbox",
  checkout,
  prodContainers: [],
  prodNetwork: false,
  app,
  ergo,
  ...over,
});
const reasonText = (result: ReturnType<typeof evaluateReset>) =>
  result.ok ? "" : result.reasons.join(" | ");

describe("dev-reset guard", () => {
  test("accepts the verified local stack and nothing else", () => {
    expect(evaluateReset(facts())).toEqual({ ok: true });
  });

  test("refuses a production-looking hostname", () => {
    for (const hostname of ["beta", "beta-1", "slirc-prod", "production"]) {
      const result = evaluateReset(facts({ hostname }));
      expect(result.ok).toBe(false);
      expect(reasonText(result)).toContain("production");
    }
  });

  test("refuses when production containers or network are present", () => {
    expect(reasonText(evaluateReset(facts({ prodContainers: ["slirc-org"] })))).toContain("production container slirc-org");
    expect(reasonText(evaluateReset(facts({ prodNetwork: true })))).toContain("production network slirc-org");
  });

  test("refuses a mismatched dev marker, project, or network", () => {
    expect(reasonText(evaluateReset(facts({ app: { ...app, profile: null } })))).toContain("SLIRC_DEV_PROFILE");
    expect(reasonText(evaluateReset(facts({ app: { ...app, profile: "slirc" } })))).toContain("SLIRC_DEV_PROFILE");
    expect(reasonText(evaluateReset(facts({ app: { ...app, project: "slirc-org" } })))).toContain("compose project");
    expect(reasonText(evaluateReset(facts({ ergo: { ...ergo, networks: [LOCAL.network, "slirc-org"] } })))).toContain("not only slirc2");
  });

  test("refuses mismatched container mounts", () => {
    const productionVolume: MountFacts = { type: "volume", name: "slirc-org-data", source: "/vol/org", destination: "/data" };
    expect(reasonText(evaluateReset(facts({ app: { ...app, mounts: [...appMounts.slice(1), productionVolume] } })))).toContain("mounts");
    expect(reasonText(evaluateReset(facts({ ergo: { ...ergo, mounts: ergoMounts.map((mount) => mount.destination === "/ircd/ircd.yaml" ? { ...mount, source: join(homedir(), ".config/slirc/ergo.yaml") } : mount) } })))).toContain("mounts");
  });

  test("refuses a config file from the production path", () => {
    const prodConfig = join(homedir(), ".config", "slirc", "app.yaml");
    const result = evaluateReset(facts({ app: { ...app, configFiles: `deploy/app.compose.yaml,${prodConfig}` } }));
    expect(reasonText(result)).toContain("production path");
  });

  test("refuses when the local stack is not up to verify", () => {
    expect(reasonText(evaluateReset(facts({ app: null })))).toContain("not running");
    expect(reasonText(evaluateReset(facts({ ergo: null })))).toContain("not running");
  });
});

describe("dev-reset inspection", () => {
  test("parses podman's capitalised mount keys", () => {
    const rawApp = [{
      Name: LOCAL.appContainer,
      Config: { Labels: { "com.docker.compose.project": LOCAL.project, "com.docker.compose.project.config_files": app.configFiles }, Env: ["SLIRC_DEV_PROFILE=slirc2"] },
      Mounts: [
        { Type: "volume", Name: LOCAL.appVolume, Source: "/vol/data", Destination: "/data" },
        { Type: "volume", Name: LOCAL.ergoApiVolume, Source: "/vol/api", Destination: "/run/secrets" },
        { Type: "bind", Source: join(checkout, "app"), Destination: "/app" },
      ],
      NetworkSettings: { Networks: { [LOCAL.network]: {} } },
    }];
    const rawErgo = [{
      Name: LOCAL.ergoContainer,
      Config: { Labels: { "com.docker.compose.project": LOCAL.ergoProject, "com.docker.compose.project.config_files": ergo.configFiles }, Env: [] },
      Mounts: [
        { Type: "volume", Name: LOCAL.ergoDataVolume, Source: "/vol/ergo", Destination: "/ircd" },
        { Type: "volume", Name: LOCAL.ergoApiVolume, Source: "/vol/api", Destination: "/run/secrets" },
        { Type: "bind", Source: join(checkout, ".data/dev-slirc2/config/ergo.yaml"), Destination: "/ircd/ircd.yaml" },
        { Type: "bind", Source: join(checkout, "ergo/ergo.motd"), Destination: "/ircd/ergo.motd" },
      ],
      NetworkSettings: { Networks: { [LOCAL.network]: {} } },
    }];
    const exec = (command: string[]) => {
      const line = command.join(" ");
      if (line === `podman inspect ${LOCAL.appContainer}`) return { code: 0, stdout: JSON.stringify(rawApp), stderr: "" };
      if (line === `podman inspect ${LOCAL.ergoContainer}`) return { code: 0, stdout: JSON.stringify(rawErgo), stderr: "" };
      if (line === `podman container exists ${LOCAL.appContainer}` || line === `podman container exists ${LOCAL.ergoContainer}`) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    expect(evaluateReset(gatherFacts({ exec, log: () => {} }, checkout))).toEqual({ ok: true });
  });
});

describe("dev-reset ordering", () => {
  test("a rejected target never stops a container or removes a volume", () => {
    const commands: string[] = [];
    const code = runReset(
      { exec: (command) => { commands.push(command.join(" ")); return { code: 0, stdout: "", stderr: "" }; }, log: () => {} },
      { root: checkout, facts: facts({ hostname: "beta", prodContainers: ["slirc-org"] }) },
    );
    expect(code).toBe(1);
    expect(commands).toEqual([]);
  });

  test("a mismatched mount never reaches a destructive command", () => {
    const commands: string[] = [];
    const code = runReset(
      { exec: (command) => { commands.push(command.join(" ")); return { code: 0, stdout: "", stderr: "" }; }, log: () => {} },
      { root: checkout, facts: facts({ app: { ...app, profile: null } }) },
    );
    expect(code).toBe(1);
    expect(commands.some((command) => /dev-down|volume rm|just dev\b/.test(command))).toBe(false);
  });
});
