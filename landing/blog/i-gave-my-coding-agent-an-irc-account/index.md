# I gave my coding agent an IRC account

By Mauricio Wolff, 17 September 2026. Canonical: https://slirc.org/blog/i-gave-my-coding-agent-an-irc-account/

Slirc is a self-hosted chat app. It looks like Slack: channels, threads, reactions, image and video uploads, link previews, push notifications, and a PWA you install on your phone. Underneath it is an IRC server. Ergo owns the accounts, the rooms, the permissions, and the history. A Bun app adds the parts IRC never had, and stays out of the way of the parts it always had.

This post covers why it exists and how it works inside. It ends with the feature I used most, which is the one I did not plan.

**Current note:** Pi and Claude Code connect to Slirc today, and other coding agents are coming. Pi was the first tested integration. Each agent uses a private DM with its owner. Personal agents in shared channels are not the public-service direction. Access remains invite-only and requires sign-in. The agent setup commands in this post describe the September build; they are not current setup instructions. Use the [agents guide](https://docs.slirc.org/agents) to connect an existing Pi or Claude Code session.

## A Friday and a group chat

I met three friends at Lokaalhost:22 and we spent a few hours comparing how we work with agents. I wanted that conversation to keep going. Signal did not work for one person. WhatsApp was full of unrelated groups and belongs to Meta. Slack had what we wanted, with reactions, threads, and a phone app, and also a large Electron client, a short free history window, and a subscription waiting down the road.

All four of us live in terminals. IRC has been moving messages between people for decades on machines far weaker than a cheap VPS. The question was whether I could keep the useful parts of Slack and let IRC do the actual work.

I also looked at Campfire from 37signals, which is close in spirit and a good product. It was still larger than what I wanted to run.

## Slack where it helps, IRC everywhere else

The rule behind every feature: it has to make sense in an ordinary IRC client. If a feature cannot survive being opened in Halloy or Senpai, it does not go in.

That rule produced some pleasant designs.

A **thread** is a channel. When you end a message with `/thread`, the app registers a channel such as `#t-3fa921`, sets your message as its topic, posts an announcement line in the parent channel, and opens the new room. In the PWA it looks like a thread with a reply count and avatars. In WeeChat it is a channel you can join. Both are true.

![Slirc PWA on a phone: channel with a reaction, an image, a thread link](../../img/pwa-channel.png)

![Halloy on a desktop, same channel: image as URL, thread as a #t- announcement line](../../img/halloy-channel.png)

A **direct message** is a private channel shared by two people. That is why a DM waits for you when you are offline, and why its history lives in the same place as everything else.

An **upload** is a URL. The browser shrinks images to JPEG and oversized videos to a compact silent WebM before sending, and the server does byte-range serving so videos seek. In an IRC client you see a link.

**Reactions** ride on IRCv3 message tags. Halloy renders them under the message; clients without reaction support ignore them. **Edits** use a tagged replacement message, so older clients still see the revised text as an ordinary line. **Invite-only channels** are `+si` with invite exceptions, enforced by Ergo, mirrored in SQLite only so the app knows what to draw.

| In the app | In an IRC client |
|---|---|
| Thread | `#t-3fa921` channel with the message as topic |
| Direct message | private channel shared by two people |
| Image or video | a URL |
| Reaction | IRCv3 message tag in supporting clients |
| Edit | tagged replacement; revised text in older clients |
| Invite-only channel | `+si` with an invite exception |

Deleting is the compromise I state plainly. Deleting removes a message from server history, and an IRC client that already received it may keep its own copy. The app does not pretend otherwise.

## The footprint

Slirc is Bun, Hono, SQLite, and vendored Alpine.js on top of Ergo. The web app ships as plain HTML with no build step. The whole stack runs as two rootless Podman containers.

We measured it next to Campfire on the same host on 7 September with `podman stats`. Campfire idled at 1.62 GB of RAM, 220 processes, and about 917 MB of images including Redis. Slirc idled at about 20 MB, 12 processes, and about 135 MB of images, with no extra services. Then we pointed 250 synthetic IRC clients at Ergo and had them chatter at about 210 messages a second for 40 seconds. Ergo peaked under 40 MiB.

| | Campfire | Slirc |
|---|---|---|
| RAM, idle | 1.62 GB | ~20 MB |
| processes | 220 | 12 |
| image size | ~917 MB | ~135 MB |
| extra services | Redis | none |

Campfire is well built; Rails and Redis cost what they cost. My point is that a group chat for a handful of people fits in the memory Slack's desktop client uses for its splash screen, and that changes which server you buy. The hosting ladder on the [comparison page](https://docs.slirc.org/comparison) starts at a €7 Hetzner ARM box.

## The feature I did not plan

Somewhere in the second week I noticed I was leaving Claude Code running on a task, walking away, and losing touch with it. I wanted to check on it from the couch. I wanted to redirect it from the train.

Because everything in Slirc is IRC, the answer was almost free: give the agent an account.

```
$ bunx slirc-agent connect 482917
Which harness runs this agent? Claude Code
connected as claude-yournick
DM with yournick open
launching Claude Code with the Slirc loop
```

The line comes from the app: More → Agents → Add an agent shows it with a six-digit code that lasts 60 seconds and works once. Paste it into a terminal and it asks which harness runs the agent, then launches that harness with the Slirc loop as its opening message. Paste it into a Claude Code or Pi session that is already running and the harness is detected; that session is the agent. Either way you get `claude-yournick`, a DM opens with a greeting, and the password is delivered once to the process that asked for it, stored in the macOS Keychain or a mode-600 file, and never shown in the app.

![Agents tab on the phone: More → Agents → Add an agent showing bunx slirc-agent connect 482917 with a copy button and a 60 s countdown](../../img/agents-tab.png)

![Agent thread on the phone: progress lines from claude-wolff, repo and branch, edits, ending in a PR link](../../img/agent-thread.png)

Then you `/invite @claude-yournick` into a channel and mention it. The loop is two commands in the harness you already run: `slirc-agent wait` blocks until your next mention and prints it as one JSON line, the harness does the work and answers with `slirc-agent post`, then waits again. Anything longer than one line goes into a thread, so the channel stays one line per task. The agent keeps the context, repository, and permissions of the session you pasted into. If it commits and opens a pull request, that is your harness doing what it would do anyway, with the link posted to the thread.

The safety rule is the part I am proudest of, because IRC gave it to me. Every message carries an `account` tag set by the server. The agent acts only on messages that mention it and whose account tag is its owner. Everyone else in the room is context. The protocol itself says who is speaking, so the rule needs no filter.

Two honest limits. A resident inbox can acknowledge and queue messages while the harness is closed, but work starts only when the harness runs `slirc-agent wait`. The agent also inherits your Claude Code permission defaults, so if you want it to only inspect code, put a restricted tool list in your settings before leaving it unattended. The [agent guide](https://docs.slirc.org/agents) shows how.

For scripts that only need to post, the same CLI has `read` and `post`. For things like a build server, you create a bot from the app and give it a password of its own. Two helpers run on the server itself: `@remind` keeps a schedule of reminders, and `@help` answers questions about Slirc from the docs and says which page it used.

## Phones first

The PWA was designed on a phone and the desktop layout came after. Touch targets are 44 pixels. Sign-in is a link in your email, and new people pick a name and are in before they verify. On a phone you link another browser with a six-digit code rather than a QR you cannot scan from the same device. Notifications have one setting, stored with your account, so changing it on the phone changes it on the laptop. Pull down from the top of any screen to reload, which matters when the app lives on your home screen and there is no reload button.

## Where it stands

Slirc is eleven days old at the time of writing. One instance runs for a few friends, and the public rooms `#open-chat` and `#help` are readable by anyone. Ownership transfer and search are still on the list, along with expiring invite links, media authorisation, and an audit log.

The source release is coming soon, subject to acceptance, source-available under the Elastic License 2.0. You can self-host it and change it. The one right the license reserves is offering Slirc to others as a hosted service. The [setup guide](https://docs.slirc.org/setup) walks from a fresh Linux server to a working instance. If you run agents unattended and have wanted a phone in the loop, or if you have kept an IRC client open for twenty years and wondered whether the rest of the world would ever meet you there, I would like you to try it and tell me what breaks.

Join us in [#open-chat](https://app.slirc.org/open-chat) on app.slirc.org. Free forever. Pi and Claude Code are the pre-launch agent pilots, with other coding agents to follow. Source release is planned, subject to acceptance.

- [Open chat](https://app.slirc.org/open-chat)
- [Connect an agent](https://docs.slirc.org/agents)

---

- Web version: https://slirc.org/blog/
- Docs: https://docs.slirc.org/
- Source: https://github.com/bitbonsai/slirc
