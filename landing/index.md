# Slirc

## Chat with friends and coding agents.

Put your coding agents to work in the same app where you talk with friends. Send a request in a private chat and your agent works in the project you already have open. Like Slack, just simpler.

Pi and Claude Code are our pre-launch pilots. Support for other coding agents is coming.

[Open chat](https://app.slirc.org/open-chat). **Slirc** is free forever. Join us in #open-chat, our public room. Source release is planned, subject to acceptance, under Elastic License 2.0; there is no public source download yet. [Managed hosting](https://slirc.app) provides a separate instance for your team.

The demos are illustrative conversations, not live activity. In `#a-team`, friends ask a Pi agent to try a new open model on a Mac mini, and the Remind bot sets a follow-up. Today a paired agent answers only in its owner's DM; channel replies come next.

## One conversation across your devices.

Switch between your phone, desktop and an IRC client like Halloy without starting a new chat.

## Get the app.

The same channels and DMs, outside the browser.

- [Download for Mac](https://slirc.app/download/Slirc.dmg), macOS 14 or later.
- iPhone: install TestFlight from the App Store, open [the TestFlight link](https://testflight.apple.com/join/t5w2AfBk) on the iPhone, tap Install, then open Slirc and type your workspace address.
- [All downloads](https://slirc.org/download/): Mac, iPhone, Windows, Android, Linux, and IRC clients.

## Backed by IRC.

[Ergo](https://ergo.chat/) keeps accounts, channels, permissions, and chat history. **Slirc** adds DMs, threads, reactions, media, and notifications.

Use an ordinary IRC client to connect to the same channels and history. You don't have to use the browser app.

### How Slirc maps to IRC

- Channel: an IRC channel.
- Thread: a channel named like `#t-3fa921`, announced in the parent channel with a link.
- Direct message: a private channel shared by two accounts, such as `#dm-person1-person2`, with history for offline participants.
- Upload: a URL in the message.
- Reaction: an IRCv3 reaction attached to the message ID. Supporting clients such as Halloy render it.

Clients connect to `app.slirc.org` on port 6697 with TLS and SASL. Read the [clients guide](https://docs.slirc.org/clients) for setup.

## Your coding agent, wherever you are.

Connect your Pi or Claude Code session. It stays on your computer, with your repo and permissions, and answers only to you.

Each saved session gets a private DM with you. Reopen the session and pick up the same conversation. Terminal-only conversations aren't copied into chat. The DM shows your requests and the agent's replies.

Pi and Claude Code work today; Codex comes later. Today agents work in their owner's DM; channel replies come next. Your computer and agent session need to stay running.

### Connect an agent

Follow the [agents guide](https://docs.slirc.org/agents) to set up the integration. Then open Agents in **Slirc**, choose Add an agent, and paste the connect command into your existing Pi or Claude Code session. Waiting requests need your confirmation after an offline session reconnects. Use your terminal for permission prompts or to stop local work.

## Come say hi, it's free.

#open-chat is our public room on the shared **Slirc**. Meet us and others trying it. Free forever.

[Open chat](https://app.slirc.org/open-chat).

Need a private team workspace? [Managed hosting from €29/month](https://slirc.app) gives you a separate **Slirc** instance, hosted in the EU. Self-hosting will be available after the source release, subject to acceptance.

## More

- [Why Slirc exists](https://slirc.org/about/)
- [September development post](https://slirc.org/blog/), retained as a historical account
- [Documentation](https://docs.slirc.org)
- [GitHub](https://github.com/bitbonsai/slirc)
- [slirc-agent on npm](https://www.npmjs.com/package/slirc-agent)

Made with love by @bitbonsai in the Netherlands. Built with Bun, Hono, SQLite, and Ergo IRC. Elastic License 2.0.
