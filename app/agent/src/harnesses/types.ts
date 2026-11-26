// The contract every harness module implements. The core (CLI, pairing client, server, Agents page,
// docs) reads harnesses only through this type and the registry in ./index.ts, never by name.
// See ../../HARNESSES.md.

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

export type Harness = {
  id: string; // lowercase; agent names start with it, e.g. pi-3f2a
  name: string;
  released: boolean; // offered to people only when true
  homepage: string; // where to get the harness itself
  // What to type inside a session to pair it. `workspace` is "" for app.slirc.org.
  sessionCommand(workspace: string): string;
  // The command to type on this computer, when it can differ from sessionCommand (a personal
  // command of the same name, say). The CLI prints this one. Local checks only.
  localCommand?(env: Env, workspace: string): string;
  // True when setup covers only sessions started in the folder slirc-agent ran in.
  perFolder?: boolean;
  // True when a pasted command can't run inside the harness (Codex runs it in its sandbox without
  // network), so the Agents page and docs say to run it in a terminal, which starts the harness.
  terminalOnly?: boolean;
  // What to do after installing the adapter from inside a running session, before sessionCommand.
  // Left out when install already loads the adapter into running sessions.
  reloadHint?: string;
  // True when reloadHint starts a new session (Codex's /new), so the one in which slirc-agent ran
  // never loads the adapter. The CLI then tells the person to type sessionCommand after it.
  reloadStartsNewSession?: boolean;
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
