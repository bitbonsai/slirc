title: Privacy & safety
crumb: Guides / Privacy & safety
description: Slirc privacy and safety: where your data lives, how access is gated, and what stays private.
lead: Slirc runs on your operator's own hardware and talks an open protocol. This page names what is stored, what is gated, and where the edges are.

This page describes how a Slirc instance handles your data. Every instance runs the same code under its own operator.

## Your data lives on the instance you chose

Conversations, identity, channels, and history stay on the machine your operator runs, the same one that serves the app. Slirc runs without third-party chat platforms, analytics, or tracking scripts.

Because Slirc speaks IRC, your history is portable. Any IRC client can read it.

<a id="email-is-only-for-sign-in"></a>

## Email and invitations

Your email address is not shown in chat, profiles or member lists. Slirc uses it for sign-in and invitations. When you invite someone by email, the invitation shows your name and email address so they can tell it is really you.

A verified member who enters your exact email to start a conversation can discover your account through the resulting DM or membership. Slirc does not provide an email directory or email autocomplete. Senders can see addresses they entered in their own Invitations page.

People search is not an instance directory. It returns only someone you can already discover: an explicit member of a public or workspace channel, someone who has posted in one (including `#open-chat` and `#help`), a person you share a non-direct room with that you both read, or someone you have a DM with, even a closed one. Posting in an open channel makes someone searchable but does not make them a Contact. A stranger who belongs only to a room you cannot see never appears, and guessing their account ID gets the same unavailable result as an unknown one.

The address is also the key to your account, so you can't edit it yourself. Ask an admin to update it from your profile. Your next sign-in link goes to the new address.

## Channels are gated, twice

Invite-only channels stay hidden until you're invited, and the instance blocks anyone who isn't on the member list. Open channels are visible to every registered user, so anything you post there is group-wide. On a public instance, recent `#open-chat` messages are also readable without signing in at `/open-chat`: messages with their nick, time, reactions, polls and media posted there, and the avatars of people who posted. Member lists, presence, other channels, and who voted for what stay private. An archived channel is read-only.

The public help channel, `#help`, is readable by signed-in members. Slirc does not currently offer anonymous reading there, and the member list stays hidden in the app for everyone: joins, parts, and quits aren't visible, and neither is the list of who's there. Slirc does not yet promise IRC invisibility.

## Agents read what a member reads

An agent runs on its owner's computer, and what it reads may go to the model provider its owner chose. It reads its DM with its owner and the open or invite-only channels its owner added it to. In an open channel it is owner-only and acts only on messages from its owner's account. Like a person you add, it can read each channel's full history, not only what comes after it joins. It leaves a channel when its owner does. Admins can see and remove every agent on the instance.

## Media follows conversation access

Uploads have random URLs. Photos and videos in private conversations require current membership, even when someone has the link. Thread media also requires access to its parent conversation. Losing membership blocks new requests, including video ranges; it cannot erase a copy someone already downloaded.

Media posted in public rooms is public. Giphy and other externally hosted media follow their provider's access rules, not Slirc membership.

Saving an image as custom emoji makes the cropped emoji public across this Slirc instance, including public rooms. Use an image everyone may see.

## Closing a DM is not deleting it

**Close DM** hides a one-to-one conversation from your list across devices. The other participant keeps seeing it, and its shared channel, membership, and history stay unchanged. A new message in it reopens it, and opening the person from **Contacts** also restores the DM and its history.

Deleting a message is separate. It removes that message from server history. IRC clients that already received it may keep their own copy. That's the nature of an open protocol, and no product setting can undo it.

## Be careful with keys

- **Email invitations** are personal. They expire after seven days, can be cancelled, and only the verified account for the invited email address can accept one.
- **Media links** point to files. Private uploads still require conversation membership; public-room files and custom emoji do not.

Only share them with people you trust to be in the channel.

## FAQ

<details>
  <summary>Who can read the public channels?</summary>
  <div><p>Members signed in to Slirc can read `#help`. Slirc does not currently offer anonymous reading there, and joining events stay hidden in the app. On a public instance, anyone can read recent `#open-chat` messages at `/open-chat` without signing in.</p></div>
</details>

<details>
  <summary>Can other people see my email?</summary>
  <div><p>Your email is not listed in chat, profiles or member lists. Someone who enters your exact email can discover your account when Slirc opens a conversation or adds you to a channel. Senders can see addresses they entered in their own invitation history. An email invitation shows the sender's name and email address to the person invited.</p></div>
</details>

<details>
  <summary>Who can open an uploaded image or video?</summary>
  <div><p>Current members of the private conversation, including the parent of a thread. Public-room media and custom emoji are public. Removing access cannot erase copies already downloaded.</p></div>
</details>

<details>
  <summary>Does Slirc track me?</summary>
  <div><p>Slirc includes no analytics or tracking. Conversations stay on your operator's hardware.</p></div>
</details>