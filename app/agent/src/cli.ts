import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { helpFor, parseArgs, type Command } from "./args.ts";
import { LEGACY, legacyUsage, runLegacy } from "./legacy.ts";
import { harnesses, type Harness } from "./harnesses/index.ts";
import type { Env } from "./harnesses/types.ts";
import { writeArm } from "./arm.ts";
import { compareVersions, VERSION } from "./version.ts";
import { expandWorkspace, originFor, readLastWorkspace, saveLastWorkspace, workspaceArg } from "./workspace.ts";

// The `slirc-agent` command. Everything here is harness-neutral: it reaches harnesses only
// through the registry. Runs the same under Node and Bun (npx or bunx), with no npm specifics.

export type Io = { out(line: string): void; err(line: string): void; tty: boolean; ask?(question: string): Promise<string> };

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

const defaultIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(question); } finally { rl.close(); }
  },
};

const offered = (unreleased: boolean) => harnesses.filter((harness) => harness.released || unreleased);
const names = (list: Harness[]) => list.map((harness) => harness.name).join(", ").replace(/, ([^,]*)$/, " and $1");

function chosen(id: string | undefined, unreleased: boolean): Harness[] {
  const list = offered(unreleased);
  if (!id) return list;
  const harness = list.find((item) => item.id === id);
  if (!harness) throw new CliError(`Slirc doesn't work with "${id}" yet. It works with ${names(list)} (--harness ${list.map((item) => item.id).join(" or ")}).`);
  return [harness];
}

// The workspace's own idea of which slirc-agent goes with it. A newer CLI is fine within the same
// major version; an older one is told exactly what to run.
async function checkWorkspace(host: string): Promise<void> {
  let response: Response;
  try { response = await fetch(`${originFor(host)}/api/agent/version`, { signal: AbortSignal.timeout(15_000) }); }
  catch { throw new CliError(`Couldn't reach ${host}. Check the workspace name on your Agents page and your connection, then try again.`); }
  if (response.status === 404) throw new CliError(`${host} runs an older Slirc that can't connect agents this way. Ask your Slirc admin to update it.`);
  const body = await response.json().catch(() => null) as { version?: string; enabled?: boolean; reason?: string } | null;
  if (!response.ok || typeof body?.version !== "string") throw new CliError(`${host} didn't answer like a Slirc workspace (HTTP ${response.status}). Check the workspace name on your Agents page.`);
  if (body.enabled === false) throw new CliError(body.reason || `Agents are turned off on ${host}.`);
  const arg = workspaceArg(host);
  const again = (runner: string) => `${runner} slirc-agent@${body.version}${arg ? ` ${arg}` : ""}`;
  const sameMajor = VERSION.split(".")[0] === body.version.split(".")[0];
  if (!sameMajor || compareVersions(VERSION, body.version) < 0) {
    throw new CliError(`${host} uses slirc-agent ${body.version} and this is ${VERSION}. Run ${again("npx")} (or ${again("bunx")}).`);
  }
}

async function pick(found: Harness[], io: Io): Promise<Harness> {
  if (found.length === 1) return found[0];
  if (!io.tty || !io.ask) throw new CliError(`Found ${names(found)}. Pick one with --harness ${found.map((item) => item.id).join(" or ")}.`);
  io.out("Which agent should connect?");
  found.forEach((harness, index) => io.out(`  ${index + 1}. ${harness.name}`));
  const answer = Number((await io.ask(`Number [1-${found.length}]: `)).trim());
  if (!Number.isInteger(answer) || answer < 1 || answer > found.length) throw new CliError("No agent picked. Nothing changed.");
  return found[answer - 1];
}

// Brings the adapter to this version. Returns what changed, or false for nothing.
function setUp(harness: Harness, env: Env, io: Io, dryRun: boolean): false | "installed" | "updated" {
  const status = harness.status(env, VERSION);
  if (status.state === "conflict") throw new CliError(status.detail ?? `Something is in the way of the Slirc extension for ${harness.name}.`);
  const steps = harness.install(env, VERSION);
  if (!steps.length) { io.out(`${harness.name}: Slirc extension ${status.version ?? VERSION} is set up.`); return false; }
  io.out(`${harness.name}: ${status.state === "missing" ? "adding" : `updating from ${status.version ?? "an older version"} to ${VERSION}`} the Slirc extension.`);
  for (const step of steps) {
    io.out(`  ${step.doing}`);
    if (dryRun) continue;
    try { step.apply(); }
    catch (error) { throw new CliError(`${error instanceof Error ? error.message : String(error)}\nNothing else changed. Fix that, then run this again.`); }
  }
  if (dryRun) { io.out("Dry run: nothing changed."); return false; }
  return status.state === "missing" ? "installed" : "updated";
}

const commandFor = (harness: Harness, env: Env, workspace: string) => harness.localCommand?.(env, workspace) ?? harness.sessionCommand(workspace);

function installedAmong(list: Harness[], env: Env): { inside?: Harness; found: Harness[] } {
  const detected = list.map((harness) => ({ harness, ...harness.detect(env) }));
  return { inside: detected.find((item) => item.inside)?.harness, found: detected.filter((item) => item.installed).map((item) => item.harness) };
}

function missing(list: Harness[]): CliError {
  const where = list.map((harness) => `${harness.name} from ${harness.homepage}`).join(", or ");
  return new CliError(`Slirc works with ${names(list)} today, and none is installed here. Install ${where}, then run this again.`);
}

async function connect(command: Extract<Command, { name: "connect" }>, env: Env, io: Io, launch: typeof start): Promise<number> {
  let host: string;
  try { host = command.workspace ? expandWorkspace(command.workspace) : readLastWorkspace(env) ?? expandWorkspace(""); }
  catch (error) { throw new CliError(error instanceof Error ? error.message : String(error)); }
  const list = chosen(command.harness, command.unreleased);
  const { inside, found } = installedAmong(list, env);
  const harness = inside ?? (found.length ? await pick(found, io) : undefined);
  if (!harness) throw missing(list);
  await checkWorkspace(host);
  const changed = setUp(harness, env, io, command.dryRun);
  if (command.dryRun) return 0;
  saveLastWorkspace(host, env);
  const typed = commandFor(harness, env, workspaceArg(host));
  if (inside === harness) {
    // We run inside the agent's shell, so the agent relays this to the owner. With a session key
    // the runtime in this session pairs by itself once it checks that the person asked for it.
    // A harness whose reload opens a new session can't take an arm left for this one.
    const key = changed && harness.reloadStartsNewSession ? undefined : harness.sessionKey?.(env);
    if (key) {
      try { writeArm(harness.id, key, { host, ...(command.ticket ? { ticket: command.ticket } : {}), reload: !!changed }, env); }
      catch (error) { throw new CliError(`Couldn't ask this ${harness.name} session to connect: ${error instanceof Error ? error.message : String(error)}. Type ${typed} in it instead.`); }
      // Said in plain words the agent relays as they are: the code shows in the session, never here.
      io.out(changed && harness.reloadHint
        ? `Slirc is ${changed}. Type ${harness.reloadHint}, then a code shows in this session: enter it on the Agents page in Slirc.`
        : `${changed ? `Slirc is ${changed} and loaded, so there's nothing to reload. ` : ""}Connecting this ${harness.name} session to ${host}. A code shows in this session in a few seconds: enter it on the Agents page in Slirc, or open the link shown with it.`);
      // The fallback is the CLI's own, so the agent relays it instead of guessing one.
      io.out(`If no code shows${changed && harness.reloadHint ? ` after ${harness.reloadHint}` : ""}, type ${typed}. Tell the owner these lines as they are.`);
      return 0;
    }
    io.out(changed
      ? `Slirc is set up. In this ${harness.name} session, type ${harness.reloadHint ? `${harness.reloadHint}, then ` : ""}${typed}, and open the link it shows.`
      : `Slirc is set up. In this ${harness.name} session, type ${typed} and open the link it shows.`);
    io.out(`Tell the owner to type those themselves: connecting can't be done for them.`);
    return 0;
  }
  io.out(`Starting ${harness.name}. Open the link it shows, then press Allow in Slirc.`);
  io.out(`Later sessions: type ${typed} in ${harness.name}${harness.perFolder ? " sessions started in this folder" : ""}.`);
  // The harness gets the ticket in its environment, which only this user can read. This process
  // waits as long as the harness runs and `ps` shows its arguments to everyone, so they're
  // replaced (Node rewrites them; bunx has already exec'd into it).
  const launched = harness.launch(host, command.ticket ? { ...env, SLIRC_CONNECT_TICKET: command.ticket } : env, command.extra);
  if (command.ticket) process.title = "slirc-agent";
  return launch(launched);
}

function start(launch: ReturnType<Harness["launch"]>): Promise<number> {
  return new Promise((done) => {
    const child = spawn(launch.bin, launch.args, { env: launch.env as NodeJS.ProcessEnv, stdio: "inherit" });
    child.on("error", (error) => { console.error(`Couldn't start ${launch.bin}: ${error.message}`); done(1); });
    child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

function manage(command: Extract<Command, { name: "install" | "uninstall" }>, env: Env, io: Io): number {
  const list = chosen(command.harness, command.unreleased);
  const { found } = installedAmong(list, env);
  if (!found.length) {
    if (command.name === "uninstall") { io.out("Nothing to remove: no agent Slirc works with is installed here."); return 0; }
    throw missing(list);
  }
  for (const harness of found) {
    if (command.name === "install") { setUp(harness, env, io, command.dryRun); continue; }
    const steps = harness.uninstall(env);
    if (!steps.length) { io.out(`${harness.name}: no Slirc extension to remove.`); continue; }
    io.out(`${harness.name}: removing the Slirc extension.`);
    for (const step of steps) { io.out(`  ${step.doing}`); if (!command.dryRun) step.apply(); }
  }
  if (command.name === "install" && !command.dryRun) {
    const last = readLastWorkspace(env);
    io.out(`Connect a session with ${found.map((harness) => commandFor(harness, env, last ? workspaceArg(last) : "<workspace>")).join(" or ")}.`);
  }
  return 0;
}

function status(unreleased: boolean, env: Env, io: Io): number {
  io.out(`slirc-agent ${VERSION}`);
  const last = readLastWorkspace(env);
  io.out(`Workspace: ${last ?? "none yet (run slirc-agent <workspace>)"}`);
  for (const harness of offered(unreleased)) {
    const detected = harness.detect(env);
    if (!detected.installed) { io.out(`${harness.name}: not installed (${harness.homepage})`); continue; }
    const adapter = harness.status(env, VERSION);
    const text = { missing: "no Slirc extension (run slirc-agent install)", current: `Slirc extension ${adapter.version ?? VERSION}`, outdated: `Slirc extension ${adapter.version ?? "unknown"}, ${VERSION} available (run slirc-agent install)`, conflict: adapter.detail ?? "conflict" }[adapter.state];
    io.out(`${harness.name}${detected.version ? ` ${detected.version}` : ""}: ${text}`);
  }
  return 0;
}

export async function run(argv: string[], env: Env = process.env, io: Io = defaultIo, launch = start): Promise<number> {
  if (LEGACY.includes(argv[0])) { await runLegacy(argv); return typeof process.exitCode === "number" ? process.exitCode : 0; }
  try {
    const command = parseArgs(argv);
    if (command.name === "help") { io.out(command.topic === "legacy" ? legacyUsage : helpFor(command.topic)); return 0; }
    if (command.name === "version") { io.out(VERSION); return 0; }
    if (command.name === "status") return status(command.unreleased, env, io);
    if (command.name === "install" || command.name === "uninstall") return manage(command, env, io);
    return await connect(command, env, io, launch);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return error instanceof CliError ? error.exitCode : 1;
  }
}
