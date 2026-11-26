---
title: Bots
crumb: Connect / Bots
description: Slirc's helpers for reminders, help and polls, and IRC bot accounts your own scripts log in as.
lead: A bot is an IRC account your own script logs in as. Slirc also runs its own helpers for reminders, help and polls.
---

## What a bot is

Slirc does not run your code. A bot is a normal IRC account with a name you choose. Your script connects to the IRC server with that name and password, joins channels, and sends messages. What it says appears in Slirc and in every other IRC client.

Use a bot when the thing speaking isn't you in a conversation, such as a build server, a status page or a script that answers one question. For work you drive yourself, connect a [personal agent](/docs/agents).

## Create a bot

Admins create bots on the **Admin** page, under **Bots**. Type a name and choose **Create bot**. Slirc shows the bot's password once, with a **Copy** button. Put it in your script, then choose **Done**; the password can't be shown again.

Lost a password, or think it leaked? Choose **New password** on the bot's row. The old one stops working at once and the new one appears once, the same way. **Remove** deletes the bot's IRC account and takes it out of every channel.

Bot names are shared with people and agents, so a name that is already taken becomes `name-yournick`.

## Connect your script

Clients connect to `{{host}}` on port `6697` with TLS and SASL PLAIN:

```text
nick: the bot's name
password: the password Slirc showed you
```

Any IRC client library works, in any language, because the bot is an ordinary IRC client.

## Invite it to a channel

A bot joins a channel the same way a person does:

```text
/invite @deploy-yournick
```

A note appears at the bottom of the channel, `Add @deploy-yournick to #yourchannel?`, with **Add** and **Dismiss**. Choose **Add** and the bot joins. Only you see the note. Anyone in the channel can add it. After that the bot reads and posts there like any other member, and Slirc marks it with a `bot` badge.

## Reminders, help, and polls: `@remind`, `@help`, `@poll`

`@remind`, `@help` and `@poll` are helpers Slirc runs for you. A fourth, `@welcome`, lives in `#open-chat` and posts a daily G'day gif there, which you can hide for yourself on your profile (see [notifications](/docs/notifications)). Each server picks which helpers it runs, so one you don't see in `/` may be off on yours.

Just mention the helper. For `@help` and `@poll`, if the helper isn't in the channel yet, a note under your message says `@poll isn't in #design.` (or names the group) with **Add** and **Dismiss**. Choose it and the helper joins and answers the message you already sent, so you don't send it again. Only you see the note, and a helper never joins without that click. `/invite @poll` adds it ahead of time. Helpers can't join DMs with other people or threads.

A message that starts with `@remind` is private: Slirc sets the reminder for you, shows the confirmation as a notice, and does not post the message in the channel. `@remind` never needs to join a channel.

`@remind` keeps a schedule of reminders. Exact times work without a model, and configured instances also understand natural phrasing:

```text
@remind in 20m stretch
@remind tomorrow 9:00 pick up cake
@remind next Friday morning call Mum
@remind list
@remind cancel 1
```

`/remind in 20m stretch` does the same thing. `@remind list` or `/remind list` opens your DM with `@remind` and posts your next six reminders there, one per line, and says when more remain. Each line shows when it fires, such as `Tomorrow at 9:00` or `In 20 minutes, 14:32` on your clock, then what it's about, then a link back to the message when it came from **Remind me**. The numbers reflect the current list, starting at 1; cancel one with `@remind cancel 1`.

To remember a message, open its **⋮** menu (on a phone, press and hold the message) and choose **Remind me**, then pick **In 20 minutes**, **In 1 hour** or **Tomorrow at 9:00**. Slirc sets the reminder with a short quote and a link back to the message, and the confirmation shows as a notice. When it fires, the quote shows as a quote block with a short link such as **View in #general** that opens the message. **Custom…** shows a date and time field instead, set to the next full hour; pick any time within the next year and choose **Set reminder**, or **Back** to return to the times.

Reminders always arrive in your DM with `@remind`, never in a channel, even when you asked in one. Slirc opens that DM for you if it isn't there yet. The confirmation is a notice only you see, with the time on your clock, such as `Reminder at 14:32 (in 20 minutes): stretch` or `Reminder tomorrow at 9:00: pick up cake`. From an IRC client such as Halloy, an `@remind` line in a channel is posted like any message, but the answer comes as a private notice and the reminder links back to that line. If Slirc is open on another conversation when a reminder arrives, a toast like `Reminder: stretch` stays until you choose **Open** to go to the DM or **Dismiss**. A **Remind me** toast quotes the message, and its button is the short link instead, such as **View in #general**.

Slirc confirms delivery from the server's own echo of the message, not from the send. If a restart leaves the outcome unknown, Slirc sends the reminder once more on its own only when it can prove the first one never arrived. Otherwise `@remind list` marks it **may not have sent**, and `@remind resend 1` sends it again; it may then arrive twice. Reminders created before this confirmation existed show the same way. Cancelling one stops any further attempt, but a message that already went out cannot be retracted.

`@help` answers questions about Slirc from these guides, and links the section it used:

```text
@help how do email invitations work?
@help can guests read #help?
```

In `#help` it answers without a mention. If a question is not covered by the guides, it says so rather than guessing, and a question about something other than Slirc gets a short line saying it only knows Slirc. A greeting or a thanks gets a short reply when you mention `@help`, and only a reaction in `#help` when you don't. While it writes an answer, its avatar shows above the composer with three dots, like a person typing, and the dots go away when the answer lands. Helpers run on the Slirc server, so they work while your computer is off.

<aside class="tip">
<h4><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>Tip</h4>
<p>Give each script its own bot. A password you can revoke on its own is easier to reason about than one account shared by four jobs.</p>
</aside>

## Polls: `@poll`

`@poll` runs polls in a channel. The quickest way to start one is the **+** next to the composer: choose **Poll**. Typing `/poll` on its own opens the same dialog.

In the dialog, write the question and at least two options. **Add** gives you another row, up to ten. Drag an option by its handle to move it, or focus the handle and use the up and down arrow keys. Two switches set how people answer. **Allow multiple answers** lets each person pick more than one option. **Anonymous** hides who voted for what. Everyone still sees the counts and their own vote. **Closes in** ends the poll on its own after an hour, a day or a week. With **None** it stays open until someone closes it. **Send** posts the poll, and if `@poll` isn't in the channel yet it joins first.

The poll shows as a card with the question and every option, each with a count and a bar. Tap an option to vote. Tap it again to take your vote back, or tap another option to change it. With multiple answers, each tap turns one option on or off. Counts update for everyone in the channel as votes come in. In a poll that isn't anonymous, the faces of the latest voters show next to each count.

**View votes** opens the full list. It shows each option with its count and, unless the poll is anonymous, who voted and when. Your own vote shows as "You". In an anonymous poll Slirc never sends anyone's name to the app, so only the counts show.

The person who started the poll, the channel's owner or an admin can close it from the **⋯** menu on the card. A closed poll shows the result with the winner marked, and nobody can vote anymore.

You can also start a poll by typing it, with a question and at least two options separated by commas or by "or":

```
@poll Lunch? pizza, sushi, salad
@poll pizza or sushi?
@poll Lunch? pizza, sushi for 1h
@poll Lunch? pizza, sushi named
```

`/poll Lunch? pizza, sushi, salad` does the same. Add `for 30m`, `for 2h` or `for 1d` to pick when it closes, from one minute up to 30 days. Without it, a typed poll closes a week after it started. Typed polls list voters only with `named`. Otherwise they work like anonymous ones. If a typed poll can't start, say it has only one option, Slirc doesn't post it. The New poll dialog opens with what you typed, at the part to fix.

To vote by typing, use the number: `@poll 2` or `/poll 2`. Your vote isn't posted in the channel. Slirc counts it and shows `Counted: sushi` as a notice only you see. Voting again moves your vote, or adds the option when the poll allows multiple answers. `@poll results` posts the running tally and `@poll close` closes the poll. Typed `@poll close` works for the person who started the poll or a channel op, and admins are ops in every channel.

One poll is open per channel at a time. Starting a second one shows the open poll, which you close first. A poll has up to ten options, each under 80 characters, and a question under 200. Polls survive a restart, and one that came due while the server was down closes once the helper is back.

`@poll` works in channels and groups it was added to, private ones included. It can't join DMs or threads. In a channel, start the line with `@poll`; a plain word "poll" is ordinary text. In your DM with `poll`, no @ is needed.

From an IRC client, everything the helper posts is plain text, one line per option, and votes from there count on the card. The helper also posts the tally when a poll closes, which IRC clients read and Slirc leaves out because the card already shows it. A `@poll 2` line you send in the channel is public there like any message, and the helper answers it with a private notice. To vote without anyone seeing, send it to the helper instead: `/msg poll #lunch 2`.
