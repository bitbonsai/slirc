# Adding a harness

A harness is a coding agent Slirc can connect to, such as Pi. Each one is a module: a folder under `src/harnesses/<id>/` that sets the harness up on someone's computer and carries Slirc requests into its sessions. Adding or changing a module never touches the others or the core.

Pi, Claude Code and Codex are the released harnesses. Read `src/harnesses/pi/` alongside this guide; it is the reference module.

Claude Code (`src/harnesses/claude/`) shows the other shape: a harness whose plugin code can't run Node. Its mod, a Claude Code plugin with a hooks module, starts `listener.ts` as a child process with `$.process.spawn`. The child runs `SessionClient`, writes JSON lines to the mod, and serves the mod's tool calls on a private Unix socket. `scripts/build-claude.ts` builds both into `dist/claude`, a local marketplace that `module.ts` installs with Claude Code's own CLI.

Codex (`src/harnesses/codex/`) runs its hooks and MCP servers under a shared app-server daemon, not the TUI. Its plugin's hooks start one listener per thread, which delivers requests with `codex queue`; the MCP server finds a thread's listener from `_meta.threadId` on each tool call. A thread outlives its TUI in the daemon, so the listener watches the TUI processes itself (`owners.ts`) to go offline when the window closes. `src/harnesses/codex/build.ts` builds `dist/codex`.

## How a module fits

```
src/harnesses/
  types.ts        the Harness interface
  index.ts        the registry of modules: export const harnesses = [pi]
  pi/
    module.ts     setup: detect, status, install, uninstall, launch
    extension.ts  runtime: runs inside Pi and talks to Slirc
    module.test.ts
```

The core owns everything that is the same for every harness:

- `src/cli.ts` runs `slirc-agent <workspace>`: it finds installed harnesses, checks the workspace's version, calls the module's `install` steps, and either starts the harness or says what to type in it.
- `src/adapter-core.ts` holds `SessionClient`: pairing, the binding secret and its private state file, attach and heartbeat, the event stream, accept, reply, fail and history.
- The server reads the data half of the registry, `app/shared/harnesses.ts`, never the modules (`app/src/agent-connect.ts`), to decide which harness ids it accepts and which ones the Agents page, `/welcome` and `/api/agent/version` offer.

A module owns two things:

1. Setup on the computer, in `module.ts`.
2. Delivery inside the harness, in a runtime file the harness loads (Pi's is `extension.ts`). It turns a Slirc request into a turn in the session and gives the model the `slirc_reply`, `slirc_send`, `slirc_delete`, `slirc_fail` and `slirc_history` tools.

## The interface

`src/harnesses/types.ts` is the contract. The first six fields below are the data half, `HarnessInfo` in `app/shared/harnesses.ts`; the server reads only those. Field by field:

- `id`: lowercase, short, stable. It is the protocol value the runtime sends and the start of the agent's nick, as in `pi-3f2a`.
- `name`: what people read, such as `Pi`.
- `released`: `false` until the checklist at the end passes. See "The released flag".
- `homepage`: where people get the harness itself. Shown when it isn't installed.
- `sessionCommand(workspace)`: what to type inside a session to pair it, such as `/slirc calango`. `workspace` is `""` for app.slirc.org.
- `reloadHint`, optional: what to type after installing from inside a running session, such as `/reload`. Leave it out when install already loads the adapter into running sessions, as OpenCode's does with `opencode reload`.
- `sessionKey(env)`, optional: the id of the session whose shell runs the CLI, read from the environment the harness gives its shell tool (Pi's `PI_SESSION_ID`, Claude Code's `CLAUDE_CODE_SESSION_ID`). Leave it out, or return `undefined`, when the harness doesn't say; the CLI then tells the person what to type.
- `detect(env)`: `{ installed, inside, version? }`. `inside` is true when this process runs in the harness's own shell (Pi sets `PI_CODING_AGENT=true`).
- `status(env, version)`: `missing`, `current`, `outdated` or `conflict`. A conflict carries `detail`: what is in the way and how to clear it.
- `install(env, version)`: the steps that bring the adapter to `version`. Empty when it is current or in conflict.
- `uninstall(env)`: the steps that remove what install added. Empty when there is nothing of ours.
- `launch(host, env, extra)`: how to start the harness in this terminal with pairing armed for that one start. `extra` is whatever followed `--` on the command line.

Rules every module keeps:

- `detect` and `status` read local state only. They never call the network or write files.
- Each step's `doing` is the exact command or file change, because the CLI prints it before running it.
- Steps are safe to repeat. A second `install` right after the first returns no steps.
- Touch only what the module created. Use the harness's own CLI when it has one (`pi install`, `pi remove`).
- Every error says what to do next.
- Nothing names a package, repo or marketplace that isn't published.

## Pairing comes from the person

Only the person at the keyboard may start pairing. Text the model reads, such as a file or a web page, could otherwise connect the session to a stranger's workspace, and a hostile workspace can press Allow on its own requests. Pairing starts from one of three things:

- A command the person types in the session (`/slirc`).
- The launch the CLI did for them: `slirc-agent <workspace>` in a terminal sets `SLIRC_CONNECT` (and `SLIRC_CONNECT_TICKET` when the command had a ticket) for that one start, and the runtime clears them.
- `slirc-agent <workspace>` pasted into the session as the person's own prompt. The model runs it, and the CLI, finding a `sessionKey`, writes an arm file for that session: `~/.local/state/slirc-agent/<harness>/arm/<key>.json`, holding `{ host, ticket?, at, pids }`, in a 0700 folder, mode 0600, written to a temp file and renamed into place. `pids` lists the processes above the CLI. The model can set the session key, so the runtime takes the file only when its own harness process is among them, and the CLI won't replace a live arm whose harness isn't above it. The runtime takes it with `takeArm` from `src/arm.ts`, which renames it away before reading, so it fires once even with two runtimes racing, and ignores it after 10 minutes. When the CLI has just installed or updated the extension, it names the file `<key>.reload.json` instead. Runtimes take that name only as they start (after `/reload` or `/reload-plugins`), never after a tool, so an older runtime still loaded can't take it and refuse a command shape it doesn't know.

Before pairing from an arm file, the runtime calls `consents(prompt, host)` with the person's own latest prompt in that session. It passes only when the whole prompt is the command: an optional runner (`bunx`, `npx`, `pnpm dlx`), `slirc-agent` with an optional `@version`, the workspace, an optional connect code after it, and the `--harness` option (or the `--ticket` option from 3.2.0), on one line. Quotes, prose and a second line all fail, so a mention or a negation never counts. The workspace must expand to the host the CLI armed; none means app.slirc.org, as for the CLI. A Slirc request delivered into the session never counts: its text carries a delivery receipt. When the check fails, nothing pairs, and the person gets a notice in the harness UI, which the model doesn't read, saying what to type to connect.

- Pi: the latest `input` event, when its `source` is `"interactive"` (the editor, `pi -p`). `sendUserMessage`, which Slirc's deliveries use, gives `"extension"` and an RPC client `"rpc"`; either replaces the person's prompt, so it never stands as consent. A pickup uses the prompt once. After `/reload` the new runtime has seen none, so it reads the newest user message on `ctx.sessionManager.getBranch()`. It takes the arm file on `tool_execution_end` of the bash tool, and once on `session_start`.
- Claude Code: a line the person submitted (`prompt.submit` with origin `composer`, not `isMeta`, not a slash command, no receipt), kept only by the next main-agent `turn.start` with the same text. `turn.start` alone isn't enough: its text is the newest user message that isn't a meta row, so a turn a background notice or hook starts repeats the person's earlier prompt, and any mod's `$.prompt.submit` is a user message too. A turn without a fresh submission, or with empty text, leaves no prompt, and a pickup uses it once. After `/reload-plugins` the module starts over, so it reads the newest user message of `$.session.messages()` that isn't a tool result. The mod checks for the arm file after the Bash tool returns (a `tool.call` hook on `Bash` that awaits `next`), on `turn.complete` and on `session.start`, and starts the listener only when one is there. The listener takes the file and checks consent.

The CLI never prints the link or code, and neither may a module. Never register a model tool that starts pairing, and never put the link or code in the model's context. Show them through the harness's own UI, like Pi's `ctx.ui.notify`.

A ticket, the connect code in the Agents page's copied command (`slirc-agent <workspace> <code>`; 3.2.0 copied `--ticket <code>`, which still works), rides in the arm file or `SLIRC_CONNECT_TICKET` and goes to `/api/agent/session/request`. It tells Slirc which signed-in person is waiting, so their page shows the Allow card by itself. When Slirc doesn't take it, the reply carries `connectCode: "expired"` and the session says the connect code expired. It grants nothing: the most a model can do with it is ask to pair with the person who copied it, who still presses Allow.

Pairing waits for Allow, which can take minutes, so don't block the session while it waits. Pi's `/slirc` handler starts `connect()` and returns at once, and the outcome arrives as a notice.

## A minimal module

A made-up harness called Echo, whose CLI is `echo-agent` and which loads plugins from `~/.echo/plugins/`:

```ts
// src/harnesses/echo/module.ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessInfo } from "../../../../shared/harnesses.ts";
import type { Harness } from "../types.ts";
import { onPath } from "../pi/module.ts";
import plugin from "../../../dist/echo-plugin.js" with { type: "text" };

const file = (env: Record<string, string | undefined>) => join(env.HOME || homedir(), ".echo", "plugins", "slirc.js");
const version = (path: string) => readFileSync(path, "utf8").match(/slirc-agent (\d+\.\d+\.\d+)/)?.[1];

const echo: Harness = {
  ...harnessInfo.echo, // the data half, from app/shared/harnesses.ts
  reloadHint: "/plugins reload",
  detect: (env) => ({ installed: onPath(env, "echo-agent"), inside: env.ECHO_AGENT === "1" }),
  status(env, wanted) {
    if (!existsSync(file(env))) return { state: "missing" };
    const found = version(file(env));
    return found === wanted ? { state: "current", version: found } : { state: "outdated", ...(found ? { version: found } : {}) };
  },
  install(env, wanted) {
    if (echo.status(env, wanted).state === "current") return [];
    return [{ doing: `write ${file(env)}`, apply: () => { mkdirSync(join(file(env), ".."), { recursive: true }); writeFileSync(file(env), plugin); } }];
  },
  uninstall: (env) => existsSync(file(env)) ? [{ doing: `delete ${file(env)}`, apply: () => rmSync(file(env)) }] : [],
  launch: (host, env, extra) => ({ bin: "echo-agent", args: extra, env: { ...env, SLIRC_CONNECT: host } }),
};

export default echo;
```

Then add it to the registry, and nowhere else. The registry has two halves: the data the server reads, and the module the CLI runs.

```ts
// app/shared/harnesses.ts: add an entry to harnessInfo and to harnessInfos
echo: { id: "echo", name: "Echo", released: false, homepage: "https://echo.example", sessionCommand: slashCommand },

// src/harnesses/index.ts
import echo from "./echo/module.ts";
export const harnesses: Harness[] = [pi, echo];
```

The runtime (`src/harnesses/echo/plugin.ts`, built to `dist/echo-plugin.js`) builds an `Adapter` and uses `SessionClient`:

```ts
const adapter: Adapter = {
  harness: "echo", version: VERSION, noun: "Echo session",
  deliver: async (prompt) => echo.queueUserTurn(prompt),
  notify: (message, level) => echo.toast(message, level),
};
const paired = await SessionClient.pair(adapter, statePath(stateDir("echo"), sessionId), { sessionId, sessionFile }, originFor(host), metadata, machine,
  (link) => echo.toast(`Slirc: open ${link.url} to connect this session, or enter ${link.code} under Agents in Slirc.`, "info"));
await paired?.client.attach();
```

Its tools call `client.reply(requestId, text)`, `client.fail(requestId, reason)` and `client.history(args)`. On startup it calls `SessionClient.resume` so a session allowed before reconnects by itself. Add the build line to `package.json` and the runtime entry point the harness needs (Pi reads `pi.extensions`).

## Testing

Three layers, all run by `bun run test` from the repository root.

1. **Module tests** next to the module, `src/harnesses/<id>/module.test.ts`. Run setup against a fake harness CLI on a fake `PATH` and `HOME`, never the real one. `test/support/fake-pi.ts` is the pattern: a shell script that records every call and keeps its state in a temp folder. Cover detect inside and outside, install from nothing, a second install doing nothing, an update from an older version, uninstall touching only your files, and a conflict with its message.
2. **The contract test**, `test/harness-contract.test.ts`, runs over every registered module. You get it for free once the module is in the registry.
   Cover `sessionKey`, and the runtime's pickup of an arm file: it pairs after a matching prompt and refuses after any other (`test/arm.test.ts` does this for Pi, `test/claude-listener.test.ts` for Claude Code).
3. **The real-agent proof.** Model it on `app/test/agent-session-pi-proof.test.ts`: the real harness binary, the real app with SQLite, a local fake model and an IRC protocol peer. It must show that `slirc-agent <workspace>` sets up the harness and starts it, that the link appears, that Allow binds that session only, that a DM from the owner gets one reply posted through `slirc_reply`, and that local turns post nothing. Skip it when the binary is missing, and fail when a `SLIRC_REQUIRE_<ID>=true` variable is set, as `test:agent-e2e` does for Pi.

`app/agent/test/cli.test.ts` runs the built CLI under Node and Bun. Run it again after touching the core.

## The released flag

`released` is the one switch for offering a harness. While it is `false`:

- The CLI skips it unless `--unreleased` is given. That flag is for contributors and isn't on the page.
- The Agents page, `/welcome` and `/api/agent/version` don't list it.
- The server still accepts its id, so a contributor can pair against a dev Slirc.
- The docs may name it only as coming. `app/test/agent-harness-list.test.ts` fails if a doc says otherwise.

## Before it is released

- [ ] Module tests and the contract test pass.
- [ ] The real-agent proof passes on macOS and Linux.
- [ ] Install, update and uninstall leave nothing behind that the module didn't create, and running install twice changes nothing.
- [ ] Every error message ends with what to do next.
- [ ] Pairing starts only from a typed command, the CLI launch, or an arm file that passes the consent check, and the link and code never reach the model.
- [ ] `app/docs/agents.md` names the harness as working, and its "Connect a session" steps cover it.
- [ ] Nothing refers to an unpublished package, repo or marketplace.
- [ ] `bun run test` passes from the repository root.
- [ ] Set `released: true`.
