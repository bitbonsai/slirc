import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A workspace is what people type: `calango` for calango.slirc.app, a full host such as
// chat.example.com or 100.64.0.5:9010 for a self-hosted instance, or nothing for app.slirc.org.

export const DEFAULT_HOST = "app.slirc.org";
const HOSTED = ".slirc.app";

type Env = Record<string, string | undefined>;

export function expandWorkspace(input?: string): string {
  const value = (input ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!value) return DEFAULT_HOST;
  const host = /[.:]/.test(value) || value === "localhost" ? value : `${value}${HOSTED}`;
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(host)) throw new Error(`"${input}" isn't a workspace name. Use the name on your Agents page, such as calango, or a host such as chat.example.com.`);
  return host;
}

// The shortest thing to type for a host: the inverse of expandWorkspace.
export function workspaceArg(host: string): string {
  const value = host.toLowerCase();
  if (value === DEFAULT_HOST) return "";
  if (value.endsWith(HOSTED) && !value.slice(0, -HOSTED.length).includes(".")) return value.slice(0, -HOSTED.length);
  return value;
}

// Loopback and private addresses (a dev stack on a Tailscale or LAN IP) speak plain HTTP; everything else HTTPS.
export function isPrivateHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/.test(name);
}

export function originFor(workspace?: string): string {
  const host = expandWorkspace(workspace);
  return new URL(`${isPrivateHost(host) ? "http" : "https"}://${host}`).origin;
}

// The workspace this computer last connected to, so a later `/slirc` needs no name.
export function lastWorkspacePath(env: Env = process.env): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "slirc", "workspace");
}

export function readLastWorkspace(env: Env = process.env): string | undefined {
  try { return readFileSync(lastWorkspacePath(env), "utf8").trim() || undefined; } catch { return undefined; }
}

export function saveLastWorkspace(host: string, env: Env = process.env): void {
  try {
    mkdirSync(dirname(lastWorkspacePath(env)), { recursive: true });
    writeFileSync(lastWorkspacePath(env), `${host}\n`);
  } catch {}
}
