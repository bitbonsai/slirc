// What the server, the Agents page and the docs need to know about each harness: names, who is
// offered which, and what to type to pair. Data only. The code that detects, installs and launches
// a harness lives in agent/src/harnesses/<id>/ and spreads its entry from here, so the server needs
// nothing from the agent package. Adding a harness: see app/agent/HARNESSES.md.

export type HarnessInfo = {
  id: string; // lowercase; agent names start with it, e.g. pi-3f2a
  name: string;
  released: boolean; // offered to people only when true
  homepage: string; // where to get the harness itself
  // What to type inside a session to pair it. `workspace` is "" for app.slirc.org.
  sessionCommand(workspace: string): string;
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
};

const slashCommand = (workspace: string) => (workspace ? `/slirc ${workspace}` : "/slirc");

export const harnessInfo = {
  pi: {
    id: "pi",
    name: "Pi",
    released: true,
    homepage: "https://pi.dev",
    sessionCommand: slashCommand,
    reloadHint: "/reload",
  },
  claude: {
    id: "claude",
    name: "Claude Code",
    released: true,
    homepage: "https://claude.com/claude-code",
    sessionCommand: slashCommand,
    reloadHint: "/reload-plugins",
    perFolder: true,
  },
  codex: {
    id: "codex",
    name: "Codex",
    released: true,
    homepage: "https://developers.openai.com/codex/cli",
    // Pasted into Codex, the command runs in Codex's sandbox without asking, and bunx or npx can't
    // download there. From a terminal it sets up Codex and starts it with the pairing typed.
    terminalOnly: true,
    // Codex refuses an unknown /command before any hook sees it, so Slirc's has no slash.
    sessionCommand: (workspace: string) => (workspace ? `slirc ${workspace}` : "slirc"),
    // A thread open while the plugin is installed gets neither its hooks nor its tools. A new one
    // in the same TUI gets both.
    reloadHint: "/new",
    reloadStartsNewSession: true,
  },
  // No reloadHint for OpenCode: install ends with `opencode reload`, which loads the plugin into
  // the running service and TUI.
  opencode: {
    id: "opencode",
    name: "OpenCode",
    released: true,
    homepage: "https://opencode.ai",
    sessionCommand: slashCommand,
  },
} satisfies Record<string, HarnessInfo>;

// Order is the picker order.
export const harnessInfos: HarnessInfo[] = [harnessInfo.pi, harnessInfo.claude, harnessInfo.codex, harnessInfo.opencode];

// Ids a release used before a rename. slirc-agent 3.1.0 sent `claude-code`; it now means `claude`.
const LEGACY_IDS: Record<string, string> = { "claude-code": "claude" };
export const canonicalHarness = (id: string) => LEGACY_IDS[id] ?? id;

export const releasedHarnessInfos = () => harnessInfos.filter((harness) => harness.released);
export const harnessInfoById = (id: string) => harnessInfos.find((harness) => harness.id === canonicalHarness(id));
