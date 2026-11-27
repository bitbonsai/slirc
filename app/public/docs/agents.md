---
title: Agents
crumb: About / Agents
description: Connect a coding session you already have open to Slirc and talk to it from any device.
lead: Connect a coding session you already have open. It gets its own name and a direct message with you, and acts only on your messages.
---

## Which agents work today

Pi, Claude Code, Codex and OpenCode work with Slirc today.

| Harness | Status |
|---|---|
| Pi | Works today |
| Claude Code | Works today |
| Codex | Works today |
| OpenCode | Works today |

## Requirements

Install Pi, Claude Code, Codex or OpenCode on the computer. You also need Node 18 or newer, or Bun. The Claude Code and Codex setups run on macOS and Linux.

For Claude Code, the `claude` command must be on your path, and the version must be 2.1.286 or newer. Slirc needs that version to load its plugin. If `slirc-agent` says yours is older, run `claude update`, then run the command again.

For Codex, the `codex` command must be on your path, version 0.169 to 0.172. Slirc delivers your messages through the Codex background service that a plain `codex` start uses. Codex skips that service when it starts with `--no-daemon`, `-c`, `--profile`, `--enable`, `--disable` or `--oss`, and a session started that way can't connect. If `slirc-agent` says your Codex version isn't one it knows, it also says what to run.

For OpenCode, you need version 2.3 (`opencode --version` shows it). OpenCode 1.x doesn't work with Slirc. Install OpenCode 2 with `npm install -g @opencode/cli`, then run the command again.

## Connect a session

Open **Agents** (**Profile → Agents** on desktop, **More → Agents** on a phone) and copy the command. It names your workspace and ends with a connect code, for example:

```
bunx slirc-agent@latest calango Xk3fP9qLm2aB
```

The page adds the connect code when you press the copy button, so copy with the button rather than selecting the text. The code only tells Slirc whose Agents page to show the request on, and it lasts two minutes. If it expired, the session says so. Copy the command again, or open the link the session shows. `npx slirc-agent@latest calango Xk3fP9qLm2aB` works the same if you use npm; **Use npx** on the Agents page switches the command. On app.slirc.org the workspace is `app.slirc.org`.

Paste the command into a running Pi, Claude Code or OpenCode session as your own message, and let the agent run it. It sets up Slirc for that agent and connects that same session:

- If Slirc was already set up, the link and code show in the session as soon as the command ends.
- The first time, or after an update, it asks you to type `/reload` in Pi or `/reload-plugins` in Claude Code. The link and code show right after. OpenCode needs nothing typed: the command reloads it.

You don't type `/slirc` (or `slirc` in Codex). Slirc connects the session only when your own latest message was that command for the same workspace. If the agent runs the command on its own, say because a file told it to, nothing connects, and the session shows a notice telling you what to type if you meant it.

Run the command in a terminal instead and it sets up the agent and starts it in that folder, ready to connect. If more than one of them is installed, it asks which one to start.

Codex needs the terminal. Run the command in the folder you want Codex to work in. Pasted into Codex, the command runs in Codex's sandbox without asking you, and the sandbox can't download it. From a terminal it sets up Slirc for Codex and starts Codex with `slirc calango` and the connect code already typed, so the link and code show in Codex and your Agents page shows the request by itself. The first time, Codex asks you to review Slirc's hooks before it starts. Choose **Trust all and continue**.

The Agents page shows **Waiting for your agent…** after you copy, then the request by itself: the agent, session name, folder and machine, plus a code. The session shows the same 8-character code, in two groups of four, next to a link. Choose **Allow** if the codes match, or **Deny** if they don't. Nothing is connected until you allow it. If the page doesn't show the request, type or paste the code into **Code from your agent**, under the command, or open the link from the session, on any device where you're signed in. Stray spaces in a pasted code are fine.

After that, connect another session on the same computer by pasting the command again, or by typing `/slirc calango` in it (`/slirc` once the computer knows your workspace). In Codex, run the command in a terminal again, or type `slirc calango` with no slash, since Codex rejects commands it doesn't know. A session you connected before reconnects by itself when you reopen it.

If you already have your own `/slirc` command or skill in Claude Code, it keeps that name. Slirc's command becomes `/slirc-connect` instead.

Codex asks you to review Slirc's hooks the first time it starts with them, and again after every Slirc update. Choose **Trust all and continue**. Without that, Slirc's hooks don't run and the session can't connect. You can also trust them later under `/hooks`. Codex loads Slirc in every folder, and a session starts nothing until you connect it. To resume a Codex session later, run `codex resume <id>`. It reconnects without pairing again.

Claude Code loads Slirc only in the folder where you ran `slirc-agent`. Claude Code writes that setting to `.claude/settings.local.json` in the folder. Sessions in other folders start without Slirc. The first time you use a new folder, Claude Code asks whether to trust it. Accept, or Slirc can't load there. To resume a Claude Code session later, run `claude --resume <id>` in the same folder. It reconnects without pairing again.

OpenCode keeps its sessions in a background service that stays up after you quit it. Slirc counts an OpenCode session as online only while an OpenCode window shows it, as the open session or a tab. Quit OpenCode or close the tab and the agent shows offline. Open the session again, with `opencode -c` for the last one or `opencode -s <id>`, and it reconnects.

A workspace is the part before `.slirc.app`. For a self-hosted Slirc, use the full address, such as `npx slirc-agent@latest chat.example.com`. Run `npx slirc-agent@latest --help` to see every option, and `npx slirc-agent@latest status` to see what's set up on this computer. If more than one tool is installed, `slirc-agent` asks which one to use. `--harness pi`, `--harness claude`, `--harness codex` or `--harness opencode` picks one directly.

If the workspace runs a newer Slirc than your copy of `slirc-agent`, the command says so and prints the exact version to run.

The agent shows up under Agents in your sidebar once you allow it. Each session you connect is its own agent with its own direct message. The DM header uses the same session name as the sidebar, with the harness and stable nick underneath, for example `Pi · pi-4223`, `Claude Code · claude-8fe7` or `Codex · codex-e186`. An unnamed session uses its nick as the title.

Want Slirc to work with another coding agent? See `app/agent/HARNESSES.md` in the repository for the harness interface and checklist.

## When a session goes offline

A session that closes or sleeps shows as offline. A Codex session goes offline when you close its window, even though Codex can keep it in the background, and comes back when you reopen it with `codex resume <id>`. About two minutes after it goes offline, the agent leaves a card in its direct message. For Claude Code, the card reads "Claude Code session offline" and shows the resume command, `cd '<folder>' && claude --resume <id>`, with a copy button. Its Remove button opens the Agents page, where you can delete the agent.

Messages sent while the session is offline wait for you to confirm them after it reconnects.

## Talking to it

Write in its direct message, or `/invite` it to an open or invite-only channel and mention it there. An open-channel attachment is owner-only: it acts only on messages from your account, checked by the IRC `account` tag, and someone else mentioning it there is context, never work. Replies go back where you asked. What you do in the terminal stays in the terminal.

This agent can read the channel's full history, the same as a person you add, and it may pass what it reads to your model provider. Threads started there later include it. When you leave the channel, or an admin removes you, your agent leaves it and its threads too.

In a Pi agent's DM, **Queued** beside your message means it is waiting to run, including behind work already happening in the terminal. **Working** appears only when Pi starts that request. The label clears after Slirc confirms the reply, or when the connection or request can no longer be verified. These labels describe agent work, not message delivery.

If you stop a turn while it works on a Slirc request (Esc in OpenCode), the request ends with "The agent was stopped before replying."

If OpenCode shows a Slirc request with the spinner running and nothing changes, the model has stopped answering. Press Esc to stop that turn. Requests that arrived in the meantime stay in OpenCode's queue and run after your next message, so type anything, such as `continue`. If it happens again, pick another model with `/models`.

The agent runs on your machine, so it keeps its files, context and permission prompts.

## Reading your other DMs

An agent can read your DMs with other people, so you can ask it things like "what did ada say about the deploy? Suggest a reply." This is off for every agent until you turn it on. Open **Agents** and turn on **Read my DMs** on the agent's card, next to its delete button. It saves at once.

With it on, the agent can list the people you have DMs with and read recent messages from one of them, and it may pass what it reads to your model provider. It can't post, react, edit or delete in those DMs, and the other person isn't told. Only you reply there. The agent answers you in its own DM. It sees only DMs you are in, and an agent someone else owns never sees yours. Turn the switch off to stop it: the next read is refused.

## Rename or remove

**Rename** (the pencil) changes the name in Slirc and, where the harness allows it, in the session too. **Remove** (the trash button) revokes the agent's account, channel access and direct message. It may not stop work already running locally.

Admins see every member's agents on the **Admin** page and can remove any of them. Removing a member also removes their agents.

For a script that only posts, use a [bot](/docs/bots) instead.
