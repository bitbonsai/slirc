title: About Slirc
crumb: About / Origin
description: Why Slirc exists, why it runs on IRC, and how it became a lightweight Slack alternative.
lead: Keep the parts of Slack that help conversation, lose the weight, and put IRC underneath it.

> Slack's interaction model on top of IRC. That was the whole idea.

## It started on a Friday

I met three friends at Lokaalhost:22. We spent a few hours comparing agentic workflows and swapping tools, and left with more energy than we arrived with.

I wanted that conversation to continue. Signal did not work because one person was not there. WhatsApp was full of unrelated groups, tied to Meta, and easy to ignore. Slack had reactions, GIFs, and threads, but also a large Electron client, a short free-history window, and another subscription waiting down the road.

We all use terminals. Why not IRC?

My earliest memories of talking to people online are BBSs and IRC. IRC has survived for decades because it is simple, open, and good at moving messages between people. Servers once ran on machines far weaker than a cheap VPS today.

I also tried [Campfire](https://once.com/campfire). It was closer in spirit, but still larger than what I wanted. I wanted the useful parts of Slack with IRC doing the actual work.

## Slack where useful, IRC everywhere else

The web app handles images, videos, link previews, reactions, notifications, direct messages, and threads. Underneath, the conversation remains IRC.

Open Slirc in [Halloy](https://halloy.chat), [Senpai](https://sr.ht/~taiite/senpai/), mIRC, or another IRC client and the channel still makes sense. An image becomes a URL. A thread becomes another channel. Nothing depends on one interface understanding a private format.

The main client is a PWA. Save it to a phone and it behaves like an installed app without an app store or a large native download. I built it for the phone first.

**The stack.**

Slirc uses Bun, Hono, Alpine.js, SQLite, and [Ergo](https://ergo.chat/). Ergo owns IRC accounts, channels, permissions, chat history, and reactions. The app keeps the metadata needed for profiles, invites, uploads, notifications, reminders, and polls.

I chose tools I can understand and operate myself. Fewer moving pieces means lower memory use and less work when something breaks.

Slirc is free to run yourself, on your own server, under the Elastic License 2.0. The [FAQ](/docs/faq) has the details.

[Campfire vs Slirc](/docs/comparison) has the current resource numbers.

## Channels and access

Only members post in `#open-chat` and `#help`. On the public instance, a visitor who isn't signed in can read recent `#open-chat` messages at `/open-chat`, and nothing else.

Open channels are listed for every member to join. Invite-only channels stay hidden until someone invites you. Email is the front door: new members join from an invite link and pick a name, and returning members sign in with a magic link. On the public instance, a new email address can also sign up from the sign-in form; the account starts once the emailed link or code proves the address, and it belongs only to `#open-chat` and `#help` until someone invites it.

IRC still enforces the channel boundaries.

**Threads that remain IRC.**

Threads were the interesting constraint. How do you isolate one discussion without inventing something ordinary IRC clients cannot read?

A Slirc thread is a channel linked to its opening message. The app presents it as a focused conversation. An IRC client presents it as another room. Both are true.

That pattern guides the rest of the product: improve the interface and keep the protocol.

**Formatting and media.**

Messages support the formatting I use: bold, emphasis, inline code, and fenced code blocks with syntax highlighting. Photos upload from the composer and GIFs come from `/giphy`. Links get previews, and YouTube, Vimeo, and other oEmbed links get a player.

Outside the PWA, all of that reads as plain text and URLs.

## Editing without pretending

Messages can be edited and deleted in the app. Deleting removes a message from server history, but an IRC client that already received it may keep a copy. Slirc says so up front.

Modern controls are useful, but IRC remains the source of truth.

## Why the `.org`

I bought `slirc.org` because I want this to become something other people can run. Host it yourself, keep your data, and contribute fixes back. A hosted version may make sense too, because convenience is worth paying for even when the underlying software is available.

The first useful version took a couple of days and a few dollars in model credits. Producing code was the easy part. The hard part is deciding what belongs, what stays understandable in IRC, and what should be removed.

That is still the work.
