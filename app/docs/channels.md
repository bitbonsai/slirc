title: Channels & invites
crumb: Guides / Channels & invites
description: Slirc channels and invites: open and invite-only channels, the channel menu, and how invitation links work.
lead: Channels hold group conversations. Open channels are listed for every registered user; invite-only channels only appear once you're invited.

## Channels

Slirc uses IRC channels for group chat. Three kinds:

- The public help channel, open to every registered member.
- Open channels, listed for every registered user.
- Invite-only channels, invisible until you're invited.

Verified members can create both kinds.

The rooms panel shows rooms you belong to, open channels you can join, threads, direct messages, and a **Starred** section for channels and DMs you pin on this device.

### Public help channel

The public help channel is open to every registered member. Members can read it; writing requires an account. Slirc does not currently offer anonymous reading. In the Slirc app, its member list, joins, parts, and quits stay hidden. Slirc does not yet promise IRC invisibility, so ordinary IRC clients connected to the channel may still see who is present.

### Open channels

Verified members can create an open channel for the whole group. Every registered user can see it and join. Use it for a topic the group shares, like a project room or an event.

### Invite-only channels

Verified members can create an invite-only channel, and an owner or admin can switch a channel between open and invite-only later. Making a channel open again exposes its whole history to every registered member; the hint under the choice says so before you save.

An invite-only channel is invisible to everyone who hasn't been invited. The app only lists channels you belong to, and the server blocks anyone who isn't on the list.

## Direct messages

Choose **+** beside **Direct messages** to start a conversation. Search verified people by nick or name. `help` and `remind` show up in Contacts and in search too, when your server runs them. Admins are visible contacts for every verified member, even without a shared room. Admins can search and message any verified person in the system. Other people appear through membership in a public or workspace channel, a post in a public channel (including `#open-chat` and `#help`), a shared non-direct room, or a DM you have had with them, even a closed one. **Contacts**, listed before you type, include anyone you have a DM with and leave out people you only share `#open-chat` or `#help` with; search still finds them. Select one person to open your existing DM or create one. Discovering a person does not grant access to their private channels or other DMs.

Existing groups use secret IRC channels, not pair DMs, and cannot be made open. Group creation is not currently offered in the New DM picker. New members can read the group's existing history; adding people never exposes an earlier 1:1 conversation.

You can also open a person's profile by clicking their name, or use `/msg`:

```text
/msg nick Hello there
```

Direct messages appear under **Direct messages** in the rooms panel. Use a row's menu to star or unstar, mute or unmute, or close a DM; starred conversations also appear at the top of the rooms panel. **Mute** dims the conversation mark on this device and does not change push-notification settings. **Close DM** hides the one-to-one conversation from your list on all your devices. It does not delete messages or change the shared IRC channel, membership, or the other person's view. A new message in a closed DM reopens it. You can also open it again from **Contacts**, with history intact. Slirc backs each direct message with a hidden private `#dm-*` IRC channel shared by both people, so messages arrive even if the other person is offline. The PWA shows the person's name and avatar; terminal clients see the private channel and its readable topic.

### Notes

**Notes** sits at the top of **Direct messages**, on phone and desktop. It is a private scratchpad, like a DM with yourself. Write in the usual box, and links get previews. Use a note's menu to edit or delete it. Opening `/dm/<your nick>` opens Notes too.

Notes are not messages. They stay in the Slirc app's database, never go over IRC, and nobody else can see them, admins included. IRC clients do not show them. They have no unread counts or notifications, and they show on all your signed-in devices. To add an image to a note, paste, pick or drop it. It shows above the box and uploads when you save the note. Only you can open it.

## The channel menu

Every non-thread channel in the rooms panel has a kebab menu (<kbd>⋮</kbd>). Opening another menu or picker closes the previous one. It holds the actions you take on the spot:

- **Star**: pins the channel to the **Starred** section at the top of your rooms on this device. The same action is available for direct messages. DM menus also offer **View profile**, **Mute** and **Close DM**; **View profile** opens that person's card.
- **Mute**: keeps the channel visible but dims its mark on this device. It does not change push notifications; see [notifications](/docs/notifications).
- **Copy**: opens a submenu with **Name** and **Link**. Name and Link copy the channel name or a link to the channel. The link opens the channel in Slirc for people who already have access.
- **Leave channel**: non-owners. Drops you out of the channel. Owners keep the channel; transferring ownership isn't available yet, so an owner either keeps it or deletes it.
- **Members**: the desktop panel starts closed. Open it from the people icon in the header. Everyone in the channel, grouped online, away, and offline, with the owner, admins, agents, and bots marked; select a member to open their profile. Collapse it with the header icon or the panel's hide button. Open channels do not list members, and `#help` keeps participant presence private. Invite-only channels also show your **Pending invitations**, without counting invitees as members. Other members cannot see the email addresses you invited.
- **Channel settings…**: opens the channel settings dialog.

### Channel settings

The dialog's title names the channel. Any member can change the **Topic**. Owners and admins also pick the **Visibility**: **Open** lists the channel for every registered member and makes its history readable; **Invite-only** hides the channel and requires an invite from then on. The hint under the choice describes only the one you picked. **Save** stays off until something changes, then saves the topic and visibility together.

The channel's owner and admins also see **Archive channel**. After you confirm, the channel turns read-only. Members still read its history and it stays in their list, but the composer is replaced by an **Archived channel** bar and nobody can post, from Slirc or from an IRC client. The heading says **Archived · read only**. Choose **Unarchive** in the same place to let people post again. DMs and threads can't be archived, and neither can the default channel or an open playground channel.

Admins also see **Delete channel** below. You type the channel name to confirm. Deleting removes the channel for everyone, with its messages, threads, memberships, invites and files; anyone who had it open moves to the default channel with a short notice. The default channel and DMs can't be deleted.

## Browsing and joining open channels

Open channels you haven't joined show up under **Browse channels** in the rooms panel. Pick one and join, no invite needed. Archived channels don't appear there.

## Creating a channel

Verified members create either kind from the same form, with **+** beside **Channels** in the desktop sidebar or on phone Home. It defaults to invite-only.

## Inviting people

In a channel, type `/invite @eve` to add someone who is already on Slirc. A note at the bottom of the channel says `Add @eve to #design?` with **Add** and **Dismiss**; **Add** adds them right away, and the note changes to `Added @eve.` If they're already a member, the note says so. Only you see these notes, and they go away when you reload. Channel permissions still apply: if you can't add people to the channel, the note says `@eve isn't in #design. You can't add people here.` and has no **Add**.

Mentioning someone works the same way. If you @mention a person who isn't in an invite-only channel, a note under your message says `@eve isn't in #design.` with **Add** and **Dismiss**. Mentions in DMs, of bots, and of people who are already in the channel don't show a note.

To add your agent, type `/invite @claude-8fe7` (its nick) in an open or invite-only channel, then mention it there. Only you can invite your own agents. An open-channel attachment is owner-only: it acts only on your messages, so someone else mentioning it does nothing, it reads the channel's history, and it leaves when you do. See [Agents](/docs/agents).

`/invite name@example.com` shows a note that says `Send name@example.com an invitation to #design?`. Nothing is sent until you choose **Invite by email**; the note then says `Invitation sent to name@example.com.` If the address already belongs to someone on Slirc, they're added to the channel instead. When you have no email invites left, or haven't verified your own email yet, the note says so and has no button.

For a DM, open **+** beside **Direct messages** and enter a name or email in the same field. Choosing a person opens the DM immediately; an email requires **Send invite**. Email invitations are personal, not reusable channel links. Group creation is not offered in this picker.

If an address matches an existing verified member, Slirc opens the DM or adds them to the selected group/channel, subject to your permissions. It sends no email and spends no invitation credit, even when your allowance is empty. Selecting a person and entering their email does not add them twice.

The default allowance is nine invitation emails per verified account, shared across DMs, groups and channels. Your server may set a different limit; the dialog shows it. Admins have no allowance, so the dialog and **People** show **Unlimited email invites** for them. Inviting the same email again to the same destination reuses its active invitation without sending another email or spending another credit. Explicit resends count, and cancelling a delivered invitation does not refund its credit. Confirmed delivery failures do not consume credit. An uncertain delivery keeps its credit and cannot be resent blindly.

Open **People** from your profile navigation or **More → Invitations** on a phone to see your sent invitations, remaining allowance, and delivery status. You can resend eligible invitations or cancel a pending invitation. Cancellation revokes the link, not existing conversation membership. A desktop **Invite someone** shortcut opens the new-conversation dialog for people or email recipients; its dismiss (×) hides only that shortcut.

Email invitations expire after seven days and require the invited email account. Resending replaces the link and starts a new seven-day window. Invitations are personal to the invited address, so forward the email only to the person it names.

An invited person is an ordinary IRC participant. [IRC clients](/docs/clients) see the same private channels, access grants and conversation history.

<div class="callout danger"><h4><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>Invitations are personal</h4><p>Only the invited email address can accept an invitation, and it expires after seven days. Send invitations to people you trust, and cancel one if you sent it to the wrong address.</p></div>

### Inviting many people

Admins can invite a whole list in one go. Open **People** and choose **Invite many**, or choose **Invite many** in the new-conversation dialog. Under **Invite to**, pick a channel you belong to, or **Workspace only**, which uses the default channel everyone joins. With no channel to pick, the dialog skips this choice. Then paste addresses, one per line, or drop a CSV file. Any column that holds email addresses works, names are optional, and a header row is skipped.

**Check list** shows what happens to each address before anything is sent. A new address gets an email invite. Someone already on Slirc is added to the channel, or marked as already there. An address you invited to the same place is marked **Already invited** and gets no second email. Repeats, typos and your own address are marked and left out. Someone on Slirc you can't find in **People** is added too, but the list shows only their address.

**Send** sends the invites in batches and shows progress, so keep the dialog open until it finishes. The summary lists each address with its result, and the **Copy** button copies the addresses that were not sent. Bulk invites use up to 75% of the server's daily email limit, which leaves room for sign-in emails. When a list is bigger than what's left today, the extra addresses wait; check the list again the next day to send them. Each invitation then works like any other: it expires after seven days, and **People** shows it under **Sent invitations**.

### Join links

An admin can make one link that anyone can use to join a channel, for example to post in a group chat. Open **People** and use **Join link**: pick the channel, choose **Make link** and copy it. To send it again later, use **Copy link** next to the open link. Links made before 19 Nov 2026 can't be copied again; make a new one instead.

Opening the link asks for an email address and sends one email. Someone new picks a name and lands in the channel; an address that already has an account signs in instead. If you are signed in and already in the channel, the link opens the channel. A link takes 99 people and lasts seven days. **People** shows how many joined, and **Revoke** closes the link at once.

### Kicking someone from a channel

An admin can type `/kick @eve` in a channel to take that person out of it. A reason can follow the nick, as in `/kick @eve posting spam`. They leave the channel right away, and the channel shows a line from you, like `removed eve from #design: posting spam`. IRC clients also see the kick. To come back to an invite-only channel they need a new invite; an open channel they can join again from **Browse channels**. Admins can't kick themselves or another admin, and `/kick` doesn't work in a channel everyone belongs to, like `#open-chat`. Only admins see `/kick` in the command list.

### Removing a member

An admin can remove a person from the workspace: open their profile, choose **Remove member**, and confirm. They leave every channel, thread and DM, every device they signed in on is signed out, and IRC clients lose their password and certificates. They can't sign in again or come back through a join link or invitation with the same email. Their past messages stay under their name. Any admin can do this. Admins can't remove themselves or another admin, and agents and bots are managed from their own pages.

### Workspace icon

An admin can give the workspace its own icon. Open **Admin**, choose **Upload icon** under **Branding** and pick a PNG, JPEG or WebP image. Drag it inside the square and zoom with the slider, then choose **Save icon**. The icon takes the place of the letter tile in the sidebar and in the Workspaces list, also in other workspaces that list this one. Other people see it within a minute. **Remove** brings the letter tile back.

## Joining through an invite

For an email invitation:

1. Open the link and choose a display name.
2. Choose **Join**. Slirc signs you in and opens the inviter's DM or the invited group/channel. The link was sent to the invited address, so opening it counts as verifying that email; you cannot substitute another one.

If the invited address already has a Slirc account, Slirc emails it a sign-in code and link instead, so a forwarded invitation cannot open that account. Type the code on the invitation page, or open the link. If you are already signed in with the invited account, choose **Join** directly. If a different account is signed in, switch accounts first.

## How it maps to IRC

Slirc channels are ordinary IRC channels, so the mechanics are standard IRC under the surface:

| Concept | IRC |
| --- | --- |
| Open channel | registered-only (`+R`), so guests and unregistered nicks can't join |
| Invite-only channel | secret and invite-only (`+si`), hidden from lists and blocked without an invite |
| Archive | moderated (`+m`), so nobody can post. Members still read it, and it stays in the list |
| Delete | unregisters the channel; its name becomes reusable after the channel empties |

## Switching and ordering channels

Open or close the rooms panel with the panel button beside the Slirc mark in the top-left. The heading in the middle shows the current channel or person. On desktop it opens channel settings, or the person's card for a direct message. On a phone it returns to Home. Unread messages show a count on each room.

On desktop, drag any channel in **Channels** up or down to set your own order, or focus a channel and press <kbd>Alt</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd> (<kbd>Option</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd> on a Mac). The order saves per account in this browser.

### GitHub project channels

Verified members can bind a GitHub repository (`owner/repo`) to a channel through `POST /api/projects`, which creates or adopts `#repo` (or `#owner-repo`) and returns a webhook URL and secret. Signed GitHub webhooks (`X-Hub-Signature-256`) then post issue and pull request updates straight into the channel.

Read next: [messages and media](/docs/messages), or [threads](/docs/threads) for focused conversations.