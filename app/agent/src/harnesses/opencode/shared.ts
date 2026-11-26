// Shared by both halves of the OpenCode plugin and by module.ts. Imports nothing, so the TUI half
// stays small and never loads the server half.

// The OpenCode releases this plugin was tested against. Outside it the plugin refuses and says why.
export const OPENCODE_RANGE = { min: "2.3.0", below: "2.4.0", label: "2.3" };

const parts = (value: string) => value.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
const older = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

// Undefined when `version` is supported, otherwise what the person should do.
export function unsupported(version: string | undefined): string | undefined {
  const found = parts(version ?? "");
  if (!found) return undefined;
  const shown = found.join(".");
  if (found[0] < 2) return `Slirc needs OpenCode 2, and this is ${shown}. Install OpenCode 2 with npm install -g @opencode/cli, then run this again.`;
  if (older(found, parts(OPENCODE_RANGE.min)!)) return `Slirc needs OpenCode ${OPENCODE_RANGE.min} or newer, and this is ${shown}. Run opencode upgrade, then run this again.`;
  if (!older(found, parts(OPENCODE_RANGE.below)!)) return `This Slirc supports OpenCode ${OPENCODE_RANGE.label}, and this is ${shown}. Run npx slirc-agent@latest to get a newer Slirc. If it still says this, OpenCode ${shown} isn't supported yet.`;
  return undefined;
}

// Standard Schema passthrough: OpenCode validates nothing, each handler checks its own input.
const any = { "~standard": { version: 1, vendor: "slirc", validate: (value: unknown) => ({ value }) } };

// Server half <-> TUI half. `presence` is each TUI's heartbeat with the sessions it has open,
// `connect` pairs a session the person launched through slirc-agent, and `notify` carries notices
// (the pairing link among them) to the TUI showing that session.
export const SLIRC_RPC = {
  id: "slirc",
  methods: { presence: { input: any, output: any }, connect: { input: any, output: any } },
  events: { notify: { schema: any } },
};

export type Presence = { tui: string; sessions: string[] };
export type Notice = { sessionID: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number };

// How often a TUI reports, and how long a report counts. A TUI that dies without saying goodbye
// takes its sessions offline after PRESENCE_TTL_MS.
export const PRESENCE_EVERY_MS = 5_000;
export const PRESENCE_TTL_MS = 15_000;
