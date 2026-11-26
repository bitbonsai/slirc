# slirc-agent

`slirc-agent` connects a coding-agent session to Slirc. The session gets its own agent name and a direct message with you, and acts only on your messages. Pi, Claude Code, Codex and OpenCode 2.3 work today.

## Connect

Copy the command from your Agents page in Slirc. It names your workspace and ends with a connect code:

```sh
bunx slirc-agent@latest calango Xk3fP9qLm2aB
# or
npx slirc-agent@latest calango Xk3fP9qLm2aB
```

The connect code lasts two minutes and only tells Slirc whose Agents page to show the request on. Without it, `slirc-agent calango` still works, and you open the link the session shows.

Paste it into a running Pi, Claude Code or OpenCode session as your own message and let the agent run it. It sets up Slirc for that agent (`pi install npm:slirc-agent@<version>` for Pi; for Claude Code, the Slirc plugin for that folder in `.claude/settings.local.json`; for Codex, the Slirc plugin with `codex plugin add`; for OpenCode, the plugin folder `~/.config/opencode/plugins/slirc` and `opencode reload`) and connects that same session. If Slirc was already set up, the link and code show in the session when the command ends. The first time, type `/reload` in Pi or `/reload-plugins` in Claude Code, and they show right after. OpenCode needs nothing typed. Slirc connects the session only when your own latest message held `slirc-agent` and the same workspace, so an agent that runs it on its own connects nothing.

Run it in a terminal instead and it sets up the agent and starts it in that folder, ready to connect. Codex needs this: pasted into Codex, the command runs in Codex's sandbox, which can't download it. From a terminal, Codex starts with `slirc <workspace>` and the connect code already typed.

The session shows a link and an 8-character code, in two groups of four. With the command from the Agents page, the page shows the request by itself. Otherwise open the link, or type the code under Agents in Slirc. Press Allow. Nothing connects until you do.

Every later session on that computer: paste the command again, or type `/slirc calango` (`/slirc` once the computer knows the workspace). If you already have your own `/slirc` command in Claude Code, the Slirc command is `/slirc-connect calango`. A session you allowed before reconnects by itself. To resume a Claude Code session, run `claude --resume <id>` in its folder. It reconnects without pairing again. An OpenCode session is online only while an OpenCode window shows it; `opencode -s <id>` reopens it.

Claude Code loads Slirc only in the folder you ran `slirc-agent` in. The first time you use a folder, Claude Code asks to trust it; accept, or the plugin won't load there. Claude Code must be 2.1.286 or newer, and the setup runs on macOS and Linux.

A workspace is the part before `.slirc.app`. Use the full address for a self-hosted Slirc, such as `npx slirc-agent@latest chat.example.com`. No name means app.slirc.org.

The CLI asks the workspace which version it expects. When yours is older, it prints the exact command to run, such as `npx slirc-agent@3.2.0 calango`.

## Commands

```sh
slirc-agent [workspace] [-- <pi args>]   set up if needed, then connect
slirc-agent install                      set up without connecting
slirc-agent uninstall                    remove the Slirc extension
slirc-agent status                       what is set up here
slirc-agent --help
```

`--dry-run` prints the changes and makes none. `--harness <id>` picks an agent when more than one is installed. Both Node 18+ and Bun run it.

## How a session talks to Slirc

Pi: the extension stores one private binding file per session under `~/.pi/agent/slirc/`. It never reads machine-wide Slirc credentials or starts another Pi process. Each binding gets its own agent nick and DM. The app server keeps the agent's IRC password and gives the extension only a scoped session token.

Slirc requests enter the session as user messages. The extension never copies local assistant output into chat. To reply, Pi calls `slirc_reply` with the request ID, and Slirc supplies and rechecks the destination. `slirc_send` posts more messages to the same room, to split a long answer or follow up after replying, and `slirc_delete` removes one of the agent's own messages there. `slirc_fail` reports a failed request without claiming to cancel local work, and `slirc_history` reads more of the room. Requests that arrive while Pi is offline wait for you to confirm them. Interrupted or uncertain work is never replayed by itself.

The session token can't log in to IRC, send raw IRC commands or join channels. The app server relays only conversations the agent can read. Owners can also `/invite` their own agent to open channels; open-channel attachments are owner-only and act only on the owner's messages.

Claude Code: the plugin keeps one binding per session under `$XDG_STATE_HOME/slirc-agent/claude`, and a listener process holds the connection. The model replies through `mcp__slirc__slirc_reply`, sends extra messages with `mcp__slirc__slirc_send`, deletes its own with `mcp__slirc__slirc_delete`, reports failures with `mcp__slirc__slirc_fail` and reads older messages with `mcp__slirc__slirc_history`.

Pairing starts only from something you do: typing `/slirc` or `/slirc-connect`, or launching a session through `slirc-agent`. No model tool starts it, and the link and code go to the session's notices, never to the model.

When a session goes away for about two minutes, the agent posts one notice in the owner's DM with the command to resume it. Claude Code sessions get `cd '<folder>' && claude --resume <id>`.

## Agents paired before 3.0

Agents that hold their own IRC credentials from the 2.x `pair` flow keep these commands:

```sh
slirc-agent wait [--timeout 90s]
slirc-agent read '#project' [count] [--json]
slirc-agent post '#project' "build passed"
slirc-agent session [start|stop|status]
slirc-agent whoami
```

A Pi session paired with `/slirc-connect <code>` in 2.x keeps working after the update. Typing `/slirc-connect` now points to `/slirc`.

## Adding a harness

Each harness is a module under `src/harnesses/<id>/`. [HARNESSES.md](HARNESSES.md) covers the interface, an example module, the tests and the checklist before one is offered to people.

## Development

```sh
bun install
bun test
bun run build
```

`bun run build` bundles the CLI and the Pi extension into `dist/`, which is tracked. Run it after changing `src/`.

From the repository root:

```sh
bun run test
bun run test:agent-e2e
bun run test:agent-browser-e2e
```

`test:agent-e2e` runs real Pi processes with the app, isolated SQLite, a local model fixture and an IRC protocol peer. It covers `slirc-agent <workspace>` starting Pi and pairing after Allow, session isolation, replies, local-output privacy, busy queues and ordering, native abort, reconnects, offline confirmation and uncertain delivery. It fails when Pi is missing instead of skipping. No model-provider credentials are needed.

`test:agent-browser-e2e` also needs `agent-browser` (through `bunx`), a browser and a running HTTPS dev stack (configured via `SLIRC_DEV_ORIGIN`). It opens Pi's link in the browser, presses Allow and checks the DM controls against the real app and Ergo. It closes only its own browser and Pi processes, and never resets server or browser data. The ordinary suite skips it.

The checks record native abort behavior. They don't claim Slirc has an Interrupt button. See the Pi lifecycle notes in the repository's `AGENTS.md` before building interruption.
