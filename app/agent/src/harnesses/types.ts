// The contract every harness module implements. The core (CLI, pairing client, server, Agents page,
// docs) reads harnesses only through this type and the registry in ./index.ts, never by name.
// See ../../HARNESSES.md.

import type { HarnessInfo } from "../../../shared/harnesses.ts";

export type Env = Record<string, string | undefined>;

// One change to the owner's machine. `doing` is shown before anything runs, in the same words the
// change uses (the exact command, or the file it writes).
export type Step = { doing: string; apply(): void };

export type Detected = {
  installed: boolean; // the harness itself is on this machine
  inside: boolean; // this process runs inside the harness, e.g. its shell tool
  version?: string;
};

export type AdapterStatus = {
  state: "missing" | "current" | "outdated" | "conflict";
  version?: string; // installed adapter version, when known
  detail?: string; // for conflict: what is in the way and how to clear it
};

export type Launch = { bin: string; args: string[]; env: Env };

export type Harness = HarnessInfo & {
  // The command to type on this computer, when it can differ from sessionCommand (a personal
  // command of the same name, say). The CLI prints this one. Local checks only.
  localCommand?(env: Env, workspace: string): string;
  // The id of the session whose shell runs this process, from the environment the harness gives
  // its shell tool. The CLI arms pairing for that session under this key. Undefined outside a
  // session, or when the harness doesn't say. Local checks only.
  sessionKey?(env: Env): string | undefined;
  // Local checks only: no network, no changes.
  detect(env: Env): Detected;
  status(env: Env, version: string): AdapterStatus;
  // Changes that bring the adapter to `version`. Empty when status is current. Each step is safe to
  // repeat and touches only what the adapter owns.
  install(env: Env, version: string): Step[];
  uninstall(env: Env): Step[];
  // Start the harness in this terminal with pairing to `host` armed for that one launch.
  launch(host: string, env: Env, extra: string[]): Launch;
};
