// Local-only destructive reset for the slirc2 dev stack.
//
// This is the only supported way to wipe local app/Ergo data. It is fail-closed: it
// positively verifies the fixed local targets by compose project, the internal dev
// marker, network and exact mounts; it refuses anything that looks like production (a
// `slirc-org` container or network, a beta/prod hostname, or a `~/.config/slirc` config
// path); and it removes only the three known volumes, after the stack is down and no
// container still references them. No name here comes from the environment, and no
// removal uses `--force` or swallows a failure, so a stray variable or a half-stopped
// stack cannot retarget or half-complete a delete.
//
// Run with `just reset` (alias `just dev-reset`). Importing this module runs nothing.

import { realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";

export const LOCAL = {
  appContainer: "slirc2-app",
  ergoContainer: "slirc2-ergo",
  project: "slirc2",
  ergoProject: "slirc2-ergo",
  network: "slirc2",
  appVolume: "slirc2-data",
  ergoDataVolume: "slirc2-ergo-data",
  ergoApiVolume: "slirc2-ergo-api",
  prodContainers: ["slirc-org", "slirc-org-ergo"],
  prodNetwork: "slirc-org",
} as const;

const PROD_CONFIG_DIR = resolve(homedir(), ".config", "slirc");

export interface MountFacts { type: string; name: string; source: string; destination: string }
export interface ContainerFacts {
  project: string;
  configFiles: string;
  profile: string | null;
  networks: string[];
  mounts: MountFacts[];
}
export interface ResetFacts {
  hostname: string;
  checkout: string;
  prodContainers: string[];
  prodNetwork: boolean;
  app: ContainerFacts | null;
  ergo: ContainerFacts | null;
}
export type ResetDecision = { ok: true } | { ok: false; reasons: string[] };

export function checkoutRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}

function realpathOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function isProductionConfig(path: string): boolean {
  const normalized = realpathOrSelf(resolve(path));
  const prod = realpathOrSelf(PROD_CONFIG_DIR);
  return normalized === prod || normalized.startsWith(`${prod}/`);
}

function configFiles(container: ContainerFacts): string[] {
  return container.configFiles.split(",").map((file) => file.trim()).filter(Boolean);
}

function mountSet(mounts: MountFacts[]): Set<string> {
  const set = new Set<string>();
  for (const mount of mounts) {
    const source = mount.type === "bind" ? realpathOrSelf(resolve(mount.source)) : mount.name;
    set.add(`${mount.type}|${source}|${mount.destination}`);
  }
  return set;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

// Wipe the local stack only when every fact matches the fixed local slirc2 stack. Any
// mismatch is reported as a reason and blocks the reset before a single container stops.
export function evaluateReset(facts: ResetFacts): ResetDecision {
  const reasons: string[] = [];
  if (/(^|[^a-z])(beta|prod(uction)?)([^a-z]|$)/i.test(facts.hostname)) reasons.push(`hostname ${JSON.stringify(facts.hostname)} looks like production`);
  for (const name of facts.prodContainers) reasons.push(`production container ${name} exists on this host`);
  if (facts.prodNetwork) reasons.push(`production network ${LOCAL.prodNetwork} exists on this host`);
  for (const container of [facts.app, facts.ergo]) {
    if (!container) continue;
    for (const file of configFiles(container)) {
      if (isProductionConfig(file)) reasons.push(`a container is configured from the production path ${file}`);
    }
  }

  if (!facts.app) reasons.push(`${LOCAL.appContainer} is not running; start the local stack first so it can be verified`);
  else {
    if (facts.app.project !== LOCAL.project) reasons.push(`${LOCAL.appContainer} belongs to compose project ${JSON.stringify(facts.app.project)}, not ${LOCAL.project}`);
    if (facts.app.profile !== LOCAL.project) reasons.push(`${LOCAL.appContainer} is missing the internal SLIRC_DEV_PROFILE=${LOCAL.project} marker`);
    if (!sameSet(new Set(facts.app.networks), new Set([LOCAL.network]))) reasons.push(`${LOCAL.appContainer} is attached to ${JSON.stringify(facts.app.networks)}, not only ${LOCAL.network}`);
    const override = `${facts.checkout}/.data/dev-slirc2/app.override.yaml`;
    if (!configFiles(facts.app).some((file) => realpathOrSelf(resolve(file)) === realpathOrSelf(override))) reasons.push(`${LOCAL.appContainer} was not started from ${override}`);
    const expected = new Set([
      `volume|${LOCAL.appVolume}|/data`,
      `volume|${LOCAL.ergoApiVolume}|/run/secrets`,
      `bind|${realpathOrSelf(resolve(facts.checkout, "app"))}|/app`,
    ]);
    const actual = mountSet(facts.app.mounts);
    if (!sameSet(actual, expected)) reasons.push(`${LOCAL.appContainer} mounts ${JSON.stringify([...actual])}, expected ${JSON.stringify([...expected])}`);
  }

  if (!facts.ergo) reasons.push(`${LOCAL.ergoContainer} is not running; start the local stack first so it can be verified`);
  else {
    if (facts.ergo.project !== LOCAL.ergoProject) reasons.push(`${LOCAL.ergoContainer} belongs to compose project ${JSON.stringify(facts.ergo.project)}, not ${LOCAL.ergoProject}`);
    if (!sameSet(new Set(facts.ergo.networks), new Set([LOCAL.network]))) reasons.push(`${LOCAL.ergoContainer} is attached to ${JSON.stringify(facts.ergo.networks)}, not only ${LOCAL.network}`);
    const override = `${facts.checkout}/.data/dev-slirc2/ergo.override.yaml`;
    if (!configFiles(facts.ergo).some((file) => realpathOrSelf(resolve(file)) === realpathOrSelf(override))) reasons.push(`${LOCAL.ergoContainer} was not started from ${override}`);
    const expected = new Set([
      `volume|${LOCAL.ergoDataVolume}|/ircd`,
      `volume|${LOCAL.ergoApiVolume}|/run/secrets`,
      `bind|${realpathOrSelf(resolve(facts.checkout, ".data/dev-slirc2/config/ergo.yaml"))}|/ircd/ircd.yaml`,
      `bind|${realpathOrSelf(resolve(facts.checkout, "ergo/ergo.motd"))}|/ircd/ergo.motd`,
    ]);
    const actual = mountSet(facts.ergo.mounts);
    if (!sameSet(actual, expected)) reasons.push(`${LOCAL.ergoContainer} mounts ${JSON.stringify([...actual])}, expected ${JSON.stringify([...expected])}`);
  }

  return reasons.length ? { ok: false, reasons } : { ok: true };
}

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (command: string[], cwd: string) => ExecResult;
export interface ResetIO { exec: Exec; log: (line: string) => void }

function parseContainer(stdout: string): ContainerFacts | null {
  const list = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const raw = list[0];
  if (!raw) return null;
  const config = (raw.Config ?? {}) as { Labels?: Record<string, string>; Env?: string[] };
  const labels = config.Labels ?? {};
  const env = config.Env ?? [];
  // `podman inspect` uses capitalised mount keys; normalise once so the guard reads one shape.
  const rawMounts = (raw.Mounts ?? []) as Array<{ Type?: string; Name?: string; Source?: string; Destination?: string }>;
  const mounts: MountFacts[] = rawMounts.map((mount) => ({
    type: mount.Type ?? "",
    name: mount.Name ?? "",
    source: mount.Source ?? "",
    destination: mount.Destination ?? "",
  }));
  const networks = Object.keys(((raw.NetworkSettings ?? {}) as { Networks?: Record<string, unknown> }).Networks ?? {});
  return {
    project: labels["com.docker.compose.project"] ?? "",
    configFiles: labels["com.docker.compose.project.config_files"] ?? "",
    profile: env.find((entry) => entry.startsWith("SLIRC_DEV_PROFILE="))?.slice("SLIRC_DEV_PROFILE=".length) ?? null,
    networks,
    mounts,
  };
}

function inspectContainer(io: ResetIO, cwd: string, name: string): ContainerFacts | null {
  if (io.exec(["podman", "container", "exists", name], cwd).code !== 0) return null;
  const inspected = io.exec(["podman", "inspect", name], cwd);
  if (inspected.code !== 0) return null;
  try { return parseContainer(inspected.stdout); } catch { return null; }
}

function containerExists(io: ResetIO, cwd: string, name: string): boolean {
  return io.exec(["podman", "container", "exists", name], cwd).code === 0;
}

export function gatherFacts(io: ResetIO, checkout: string): ResetFacts {
  return {
    hostname: hostname(),
    checkout,
    prodContainers: LOCAL.prodContainers.filter((name) => containerExists(io, checkout, name)),
    prodNetwork: io.exec(["podman", "network", "inspect", LOCAL.prodNetwork], checkout).code === 0,
    app: inspectContainer(io, checkout, LOCAL.appContainer),
    ergo: inspectContainer(io, checkout, LOCAL.ergoContainer),
  };
}

// Guard first, then stop, verify, remove, recreate. Every command is checked; the first
// failure aborts before the next destructive step.
export function runReset(io: ResetIO, options: { root?: string; facts?: ResetFacts } = {}): number {
  const root = options.root ?? checkoutRoot();
  const facts = options.facts ?? gatherFacts(io, root);
  const decision = evaluateReset(facts);
  if (!decision.ok) {
    for (const reason of decision.reasons) io.log(`dev-reset refused: ${reason}`);
    return 1;
  }

  const must = (command: string[], what: string): void => {
    const result = io.exec(command, root);
    if (result.code !== 0) throw new Error(`${what} failed (${command.join(" ")}): ${result.stderr.trim() || `exit ${result.code}`}`);
  };

  try {
    io.log("dev-reset: stopping the local stack");
    must(["just", "dev-down"], "stopping the local stack");

    for (const name of [LOCAL.appContainer, LOCAL.ergoContainer]) {
      if (!containerExists(io, root, name)) continue;
      const state = io.exec(["podman", "inspect", name, "--format", "{{.State.Status}}"], root).stdout.trim();
      if (state !== "exited") throw new Error(`${name} is ${state || "unknown"}, not stopped`);
    }

    for (const volume of [LOCAL.appVolume, LOCAL.ergoDataVolume, LOCAL.ergoApiVolume]) {
      const consumers = io.exec(["podman", "ps", "-a", "--filter", `volume=${volume}`, "--format", "{{.Names}}"], root).stdout.trim();
      if (consumers) throw new Error(`volume ${volume} is still used by ${consumers}`);
      if (io.exec(["podman", "volume", "exists", volume], root).code !== 0) { io.log(`dev-reset: volume ${volume} already absent`); continue; }
      must(["podman", "volume", "rm", volume], `removing ${volume}`);
    }

    io.log("dev-reset: recreating the local stack");
    must(["just", "dev"], "recreating the local stack");
    must(["just", "dev-seed"], "seeding dev fixtures");
    must(["just", "dev-seed", "--threads"], "seeding thread fixtures");
    must(["just", "dev-seed", "--bots"], "seeding bot fixtures");
  } catch (error) {
    io.log(`dev-reset aborted: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  io.log("dev-reset: local slirc2 data reset");
  return 0;
}

const defaultExec: Exec = (command, cwd) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

if (import.meta.main) {
  process.exit(runReset({ exec: defaultExec, log: (line) => console.log(line) }));
}
