import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { stateDir } from "../../adapter-core.ts";
import { compareVersions } from "../../version.ts";

// What the Codex hooks, the MCP server and the listener share. All three run as children of the
// Codex app-server daemon, so they see the same environment and find each other through files in
// the Codex state folder, keyed by the thread id.

type Env = Record<string, string | undefined>;

// `codex queue` (the app-server's experimental thread/queue/add) was tested on these versions.
// Outside the range Slirc refuses instead of guessing.
export const MIN_CODEX = "0.169.0";
export const BELOW_CODEX = "0.173.0";
export const TESTED = "0.169 to 0.172";
export const supported = (version: string) => compareVersions(version, MIN_CODEX) >= 0 && compareVersions(version, BELOW_CODEX) < 0;
export function unsupported(version: string | undefined): string | undefined {
  if (!version || !/^\d+\.\d+\.\d+/.test(version) || supported(version)) return undefined;
  return compareVersions(version, MIN_CODEX) < 0
    ? `Slirc works with Codex ${TESTED}, and this is ${version}. Update Codex, then run this again.`
    : `Slirc is tested with Codex ${TESTED}, and this is ${version}. Run npx slirc-agent@latest to get a version that knows it.`;
}
export const codexVersion = (text: string | undefined) => text?.match(/(\d+\.\d+\.\d+)/)?.[1];

// A typed `slirc` or `slirc <workspace>`, the whole prompt. Codex rejects an unknown /slirc
// before any hook runs, so the command has no slash. When slirc-agent starts Codex from a terminal
// with the Agents page's connect code, that code follows the workspace.
export function pairingCommand(prompt: unknown): { workspace: string; ticket?: string } | undefined {
  const match = /^\s*slirc(?:\s+(\S+)(?:\s+([A-Za-z0-9_-]{8,64}))?)?\s*$/i.exec(String(prompt ?? ""));
  return match ? { workspace: match[1] ?? "", ...(match[2] ? { ticket: match[2] } : {}) } : undefined;
}

export const RECEIPT = /Slirc delivery receipt: ([0-9a-f-]{36})/;
export const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export const short = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

export const dir = (env: Env) => stateDir("codex", env as NodeJS.ProcessEnv);
export const boundMark = (env: Env, sessionId: string) => join(dir(env), "bound", sessionId);
export const liveFile = (env: Env, sessionId: string) => join(dir(env), "live", `${short(sessionId)}.json`);

export type Live = { socket: string; token: string; pid: number };
export function readLive(env: Env, sessionId: string): Live | undefined {
  try {
    const live = JSON.parse(readFileSync(liveFile(env, sessionId), "utf8")) as Live;
    return alive(live.pid) ? live : undefined;
  } catch { return undefined; }
}

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// One call to a listener's private socket. Errors from the listener come back as thrown Errors.
export function call(live: Live, route: string, body: unknown = {}, timeoutMs = 10_000): Promise<any> {
  return new Promise((done, fail) => {
    const req = request({ socketPath: live.socket, path: route, method: "POST", headers: { "content-type": "application/json", "x-slirc-token": live.token } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try {
          const value = JSON.parse(text || "{}");
          if (value.error) fail(new Error(value.error)); else done(value);
        } catch (error) { fail(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Slirc's listener did not answer in time.")));
    req.on("error", fail);
    req.end(JSON.stringify(body));
  });
}

// Slirc's shared messages say "type /slirc"; in Codex the command has no slash.
export const forCodex = (text: string) => text.replace(/(^|[\s("'`])\/slirc(?=[\s.,)"'`]|$)/g, "$1slirc");
