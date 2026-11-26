import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../../adapter-core.ts";
import { armPath, consents, takeArm } from "../../arm.ts";
import { workspaceArg } from "../../workspace.ts";
import { boundMark, call, codexVersion, dir, pairingCommand, readLive, RECEIPT, unsupported, validId, type Live } from "./shared.ts";

// Slirc's Codex hooks. Codex runs each one as a command under its app-server daemon with the
// event as JSON on stdin, and reads the answer from stdout. They stay silent and cost one file
// check in sessions Slirc never connected.
//
// Pairing comes only from the person: a typed `slirc <workspace>` (or the `codex "slirc <host>"`
// that slirc-agent launches) is blocked before the model sees it, and the link shows as the block
// reason in the TUI. Neither the prompt nor the reason reaches the model or the rollout file.

type Env = Record<string, string | undefined>;
export type Payload = { session_id?: string; turn_id?: string; cwd?: string; model?: string; prompt?: string; source?: string; reason?: string; transcript_path?: string };
export type Output = { decision?: "block"; reason?: string; systemMessage?: string };

// The Codex app-server daemon among this hook's ancestors. Codex started with --no-daemon runs
// hooks under the TUI itself, and `codex queue` can't reach such a session.
export function findDaemon(env: Env, from = process.ppid): number | undefined {
  if (env.SLIRC_CODEX_DAEMON_PID) return Number(env.SLIRC_CODEX_DAEMON_PID) || undefined;
  let pid = from;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    let line: string;
    try { line = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim(); } catch { return undefined; }
    const [, parent, command] = /^(\d+)\s+(.*)$/.exec(line) ?? [];
    if (/\bcodex\b.*\bapp-server\b/.test(command ?? "")) return pid;
    pid = Number(parent);
  }
  return undefined;
}

const codexBin = (env: Env) => env.SLIRC_CODEX_BIN || "codex";

// The listener serving this thread, started now if need be. `wait` holds on until it answers.
export async function ensureListener(env: Env, payload: Payload, daemonPid: number, wait: boolean): Promise<Live | undefined> {
  const sessionId = payload.session_id!;
  const found = readLive(env, sessionId);
  if (found) return found;
  mkdirSync(dir(env), { recursive: true, mode: 0o700 });
  const log = openSync(join(dir(env), "listener.log"), "a", 0o600);
  const config = { sessionId, cwd: payload.cwd ?? "", model: payload.model ?? "", daemonPid, codex: codexBin(env) };
  const child = spawn(process.execPath, [process.argv[1], "listen", JSON.stringify(config)], { env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "ignore", log] });
  child.unref();
  if (!wait) return undefined;
  for (const end = Date.now() + 5_000; Date.now() < end;) {
    await new Promise((done) => setTimeout(done, 50));
    const live = readLive(env, sessionId);
    if (live) return live;
  }
  return undefined;
}

async function noticeOf(live: Live | undefined): Promise<Output> {
  if (!live) return {};
  const { notices } = await call(live, "/notices").catch(() => ({ notices: [] }));
  if (!notices?.length) return {};
  const text = notices.join(" ");
  return { systemMessage: /^Slirc\b/.test(text) ? text : `Slirc: ${text}` };
}

async function pair(env: Env, payload: Payload, workspace: string, ticket?: string): Promise<Output> {
  const block = (reason: string): Output => ({ decision: "block", reason });
  const daemonPid = findDaemon(env);
  if (!daemonPid) return block("This Codex session runs without Codex's shared background service, so Slirc can't reach it. Codex starts that way with --no-daemon, -c, --profile, --enable, --disable or --oss. Start codex without those options, then type slirc <workspace> again.");
  let version: string | undefined;
  try { version = codexVersion(execFileSync(codexBin(env), ["--version"], { encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 5_000 })); } catch {}
  const old = unsupported(version);
  if (old) return block(old);
  const live = await ensureListener(env, payload, daemonPid, true);
  if (!live) return block(`Slirc's listener didn't start. Its log is ${join(dir(env), "listener.log")}. Fix what it says, then type slirc <workspace> again.`);
  try { return block((await call(live, "/connect", { workspace, ...(ticket ? { ticket } : {}) }, 12_000)).text); }
  catch (error) { return block(`Slirc: ${errorText(error)}`); }
}

// The person's latest prompt in this thread, from the transcript Codex passes to every hook. The
// plugin may have been installed by that very prompt's turn, so no hook of ours saw it typed.
export function latestPrompt(path: string | undefined): string | undefined {
  if (!path) return undefined;
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 2_000_000);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return undefined; }
  for (const line of text.split("\n").reverse()) {
    let item: any;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item?.payload;
    if (item?.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") continue;
    const said = (payload.content ?? []).map((part: any) => part?.text ?? "").join("");
    // Codex adds its own context as user items in angle-bracket blocks.
    if (said.trimStart().startsWith("<")) continue;
    return said;
  }
  return undefined;
}

// `slirc-agent <workspace> [code]` that the model ran in this thread's shell left an arm file. It
// pairs when the turn ends, and the link shows then, in the TUI only.
async function fromArm(env: Env, payload: Payload): Promise<Output | undefined> {
  const sessionId = payload.session_id!;
  if (!existsSync(armPath("codex", sessionId, env)) && !existsSync(armPath("codex", sessionId, env, true))) return undefined;
  const daemonPid = findDaemon(env);
  // The shell tool runs under the daemon, so the arm lists it among the CLI's ancestors.
  const found = daemonPid ? takeArm("codex", sessionId, env, Date.now(), daemonPid, true) : undefined;
  if (!found) return undefined;
  const prompt = latestPrompt(payload.transcript_path);
  const typed = `slirc ${workspaceArg(found.host)}`.trim();
  if (!consents(prompt, found.host)) return { systemMessage: `Slirc: something ran slirc-agent for ${found.host}. To connect, type ${typed}.` };
  const live = await ensureListener(env, payload, daemonPid!, true);
  if (!live) return { systemMessage: `Slirc's listener didn't start. Its log is ${join(dir(env), "listener.log")}. Fix what it says, then type ${typed}.` };
  try { return { systemMessage: `Slirc: ${(await call(live, "/connect", { workspace: found.host, ...(found.ticket ? { ticket: found.ticket } : {}) }, 12_000)).text}` }; }
  catch (error) { return { systemMessage: `Slirc: ${errorText(error)}` }; }
}

export async function hook(event: string, payload: Payload, env: Env = process.env): Promise<Output> {
  const sessionId = payload.session_id;
  if (!validId(sessionId)) return {};
  const bound = () => existsSync(boundMark(env, sessionId));

  if (event === "UserPromptSubmit") {
    const typed = pairingCommand(payload.prompt);
    if (typed) return pair(env, payload, typed.workspace, typed.ticket);
    let live = readLive(env, sessionId);
    if (!live && bound()) {
      const daemonPid = findDaemon(env);
      if (daemonPid) live = await ensureListener(env, payload, daemonPid, false);
    }
    const receipt = RECEIPT.exec(String(payload.prompt ?? ""))?.[1];
    if (receipt && live) await call(live, "/started", { receipt, turnId: payload.turn_id, model: payload.model }).catch(() => undefined);
    // Typed by the person: the thread is open in a window, so a dormant listener comes back.
    else if (live) await call(live, "/active", { daemonPid: findDaemon(env) }).catch(() => undefined);
    return noticeOf(live);
  }
  if (event === "SessionStart") {
    // A thread Slirc allowed before reconnects by itself, on resume as on startup.
    const live = readLive(env, sessionId);
    if (live) await call(live, "/active", { daemonPid: findDaemon(env) }).catch(() => undefined);
    else if (bound()) {
      const daemonPid = findDaemon(env);
      if (daemonPid) await ensureListener(env, payload, daemonPid, false);
    }
    return {};
  }
  if (event === "Stop") {
    const armed = await fromArm(env, payload);
    if (armed) return armed;
    const live = readLive(env, sessionId);
    if (live && payload.turn_id) await call(live, "/settle", { turnId: payload.turn_id }).catch(() => undefined);
    return noticeOf(live);
  }
  if (event === "SessionEnd") {
    const live = readLive(env, sessionId);
    if (live) await call(live, "/detach", {}, 2_500).catch(() => undefined);
    return {};
  }
  return {};
}
