export type Command =
  | { name: "connect"; workspace: string; harness?: string; ticket?: string; unreleased: boolean; dryRun: boolean; extra: string[] }
  | { name: "install" | "uninstall"; harness?: string; unreleased: boolean; dryRun: boolean }
  | { name: "status"; unreleased: boolean }
  | { name: "help"; topic?: string }
  | { name: "version" };

export const usage = `Connect a coding agent to Slirc.

Usage:
  slirc-agent [workspace] [code]
                              set up the agent if needed and connect it (the usual command)
  slirc-agent install         set up the agent without connecting
  slirc-agent uninstall       remove what install set up
  slirc-agent status          show what is set up on this computer
  slirc-agent --version

A workspace is the name on your Agents page: calango means calango.slirc.app. Give a full host,
such as chat.example.com, for a self-hosted Slirc. Leave it out for app.slirc.org. The connect
code comes with the command on your Agents page and lets that page show the Allow card by itself.

Run it in a terminal and it starts your agent ready to connect. Paste it into your agent and it
sets things up and connects that same session: the link shows there.

Options:
  --harness <id>    pick the agent when more than one is installed (pi, claude, codex or opencode)
  --dry-run         show what would change, change nothing
  -- <args>         pass the rest to the agent when it starts, e.g. -- --model sonnet
  -h, --help        this help; also slirc-agent <command> --help

Works with Pi, Claude Code, Codex and OpenCode today. Docs: https://app.slirc.org/docs/agents
Agents paired before 3.0: slirc-agent help legacy`;

const topics: Record<string, string> = {
  install: `Usage: slirc-agent install [--harness <id>] [--dry-run]

Adds the Slirc extension to your agent, or updates it to this version. Nothing else on the
computer changes. Each change is printed before it runs.`,
  uninstall: `Usage: slirc-agent uninstall [--harness <id>] [--dry-run]

Removes the Slirc extension from your agent. Agents already in Slirc stay there; remove them
under Agents in Slirc.`,
  status: `Usage: slirc-agent status

Lists the agents Slirc works with, whether each is installed, and whether its Slirc extension is
current. Changes nothing.`,
};

export function helpFor(topic?: string): string {
  return (topic && topics[topic]) || usage;
}

// A connect code from the Agents page. Internally (and to the server) it is still a ticket.
const validCode = (value: string) => /^[A-Za-z0-9_-]{8,64}$/.test(value);
const BAD_CODE = "That isn't a connect code from your Agents page. Copy the command there again.";

function parseFlags(input: string[], allowWorkspace: boolean) {
  let harness: string | undefined;
  let ticket: string | undefined;
  let unreleased = false;
  let dryRun = false;
  let help = false;
  const positional: string[] = [];
  let extra: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const arg = input[index];
    if (arg === "--") { extra = input.slice(index + 1); break; }
    if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--unreleased") unreleased = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--harness") {
      harness = input[++index];
      if (!harness || harness.startsWith("-")) throw new Error("--harness needs a value, such as --harness pi");
    } else if (arg.startsWith("--harness=")) harness = arg.slice(10);
    else if (allowWorkspace && (arg === "--ticket" || arg.startsWith("--ticket="))) {
      ticket = arg === "--ticket" ? input[++index] : arg.slice(9);
      if (!ticket) throw new Error(BAD_CODE);
    }
    // A connect code can start with "-" (older Slirc minted those). In the code slot, after the
    // workspace, one that looks like a code is the code, not an option.
    else if (allowWorkspace && positional.length === 1 && !arg.startsWith("--") && validCode(arg)) positional.push(arg);
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}. Run slirc-agent --help to see the options${allowWorkspace && validCode(arg) ? `, or give a connect code as --ticket=${arg}` : ""}.`);
    else positional.push(arg);
  }
  // Two positionals are the workspace and the connect code. `--ticket`, from 3.2.0's copied
  // command, still works.
  if (positional.length > (allowWorkspace ? 2 : 0)) throw new Error(allowWorkspace ? "Give a workspace name and, from your Agents page, a connect code: slirc-agent calango <code>." : "This command takes no workspace name.");
  if (positional[1] !== undefined) {
    if (ticket !== undefined) throw new Error(BAD_CODE);
    ticket = positional[1];
  }
  if (ticket !== undefined && !validCode(ticket)) throw new Error(BAD_CODE);
  return { harness, ticket, unreleased, dryRun, help, workspace: positional[0] ?? "", extra };
}

export function parseArgs(argv: string[]): Command {
  const [first, ...rest] = argv;
  if (first === "--version" || first === "-v") return { name: "version" };
  if (first === "help") return { name: "help", topic: rest[0] };
  if (first === "install" || first === "uninstall" || first === "status") {
    const flags = parseFlags(rest, false);
    if (flags.help) return { name: "help", topic: first };
    if (first === "status") return { name: "status", unreleased: flags.unreleased };
    return { name: first, unreleased: flags.unreleased, dryRun: flags.dryRun, ...(flags.harness ? { harness: flags.harness } : {}) };
  }
  // `connect` is accepted for people used to the 2.x command.
  const flags = parseFlags(first === "connect" ? rest : argv, true);
  if (flags.help) return { name: "help" };
  if (/^\d{6}$/.test(flags.workspace)) throw new Error("Slirc no longer gives out six-digit codes. Run slirc-agent <workspace>, using the workspace name on your Agents page.");
  return { name: "connect", workspace: flags.workspace, unreleased: flags.unreleased, dryRun: flags.dryRun, extra: flags.extra, ...(flags.harness ? { harness: flags.harness } : {}), ...(flags.ticket ? { ticket: flags.ticket } : {}) };
}
