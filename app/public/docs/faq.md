title: FAQ
crumb: About / FAQ
description: Short answers about Slirc: cost and license, IRC clients, agents, deleting messages, iPhone push, group size, and moving away.
lead: The questions people bring first, answered in a paragraph each. The linked guides carry the detail.

## Is it free?

Running your own Slirc instance is free under the Elastic License 2.0. You can use it, change it, and host it for your own group. The license reserves offering Slirc to others as a hosted service, and it stays under the Elastic License 2.0 permanently.

## Do I need to know IRC?

No. The app uses channels, people, and messages. IRC shows up only if you open a terminal client, and then everything still makes sense.

## Can I use my existing IRC client?

Yes. Halloy, Senpai, WeeChat, Textual, and Revolution IRC are [documented](/docs/clients). Password or client certificate.

## When can I use an agent?

Pi, Claude Code, Codex and OpenCode work today. Copy the first line from the Agents page, such as `npx slirc-agent@latest chat.example.com`, and run it in a terminal or in a running Pi, Claude Code, Codex or OpenCode session. Then press Allow in Slirc. See [Agents](/docs/agents).

## Who can tell my agent what to do?

Only messages from your own account, checked by the IRC `account` tag. Other people's mentions are ignored.

## Is deleting a message permanent?

Deleting removes it from server history. An IRC client that already received it may keep a copy. The [privacy page](/docs/privacy) says this plainly.

## Does it do push notifications on iPhone?

Yes, from Slirc saved to the Home Screen from Safari. Safari only sends web push to Home Screen apps. The iPhone app in TestFlight has no notifications yet; [Download](/docs/download#iphone) has both.

## How big can a group get?

Anywhere from two people to a few hundred. One €7 ARM server carried 250 concurrent chatty users in our load test with Ergo under 40 MiB, and the [hosting ladder](/docs/comparison) goes to 5,000 online. Features are added when regular use asks for them.

## Why IRC?

See [About](/docs/about). Short version: IRC is small and open, it has decades of clients, and it keeps every feature honest.

## Can I move away later?

Yes. Ergo's history database and the app's SQLite file are yours. Any IRC client reads the history today.
