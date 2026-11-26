title: Messages & media
crumb: Guides / Messages & media
description: Slirc messages and media: formatting, reactions, editing, uploads, link previews, and commands.
lead: Send text, reactions, images, videos, and links. Everything stays compact and readable, in the app and in any IRC client.

## Sending a message

Type in the composer at the bottom and press <kbd>Enter</kbd> to send. Press <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line. Inside an open code fence, <kbd>Enter</kbd> adds a line and <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> sends. Sending closes an unfinished fence for you. The composer always shows which room you're writing to.

Saving, queued, and sending labels use muted text with three moving dots. Queued means the message is waiting to send, not that it failed. Reduced motion keeps the dots still.

On desktop, press <kbd>↑</kbd> in an empty composer to select the newest message, and <kbd>↑</kbd> or <kbd>↓</kbd> to move between messages. On a selected message, <kbd>E</kbd> edits it, <kbd>D</kbd> asks to delete it, <kbd>Q</kbd> quotes it, <kbd>T</kbd> opens its thread and <kbd>R</kbd> opens the reaction picker. <kbd>Esc</kbd>, or <kbd>↓</kbd> past the newest message, goes back to the composer. Type <code>/</code> in the composer to pick a command.

Press <kbd>Alt</kbd> + <kbd>↑</kbd> (<kbd>Option</kbd> + <kbd>↑</kbd> on a Mac) in the composer to bring back a message you sent earlier in this conversation, like a shell's history. Press it again to go further back, and <kbd>Alt</kbd> + <kbd>↓</kbd> to come forward; past the newest one you get back what you were typing. The recalled text is a new message: change it and send it. To fix a message already sent, use plain <kbd>↑</kbd> and <kbd>E</kbd> instead, which edits it in place.

Press <kbd>Cmd</kbd> + <kbd>K</kbd> (<kbd>Ctrl</kbd> + <kbd>K</kbd> on Windows and Linux) anywhere to jump to a channel, DM or person. Type part of a name, even a few letters in order such as `dvt` for `dev-test`, move with <kbd>↑</kbd> and <kbd>↓</kbd>, press <kbd>Enter</kbd> to open it, or <kbd>Esc</kbd> to go back where you were. Conversations with unread messages come first.

Press <kbd>Cmd</kbd> + <kbd>Option</kbd> + <kbd>O</kbd> (<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>O</kbd> on Windows and Linux) to open the Workspaces list, the same list the workspace icon opens, and switch to another workspace. On a wide screen the rail on the far left lists every saved workspace as an icon; select one to switch, or **+** at its foot to add one.

## Starting a direct message

Open **New DM**, type at least two characters to search by name or nick, and choose a person to open the conversation immediately. Choosing a Contact does the same. Type or paste an email in the same field to show an invitation confirmation, then choose **Send invite**. Typing an email never sends an invitation. After a successful send, the dialog shows confirmation instead of the form; choose **Done** or **Invite someone else**. Slirc creates the private pair in the background while you type. The opened conversation is keyed to that person's account, so your draft is saved and anything you send waits locally, then goes out once the server authorizes the conversation. If starting it fails, your text stays in the conversation and **Try again** retries the same pair instead of creating a second one. Photos wait until the conversation is ready.

## Typing

While someone else types, their avatar appears above the composer with three dots. Only people in the current conversation show. Typing is live only. It is never saved with message history, and replaying older messages never shows it. Your own typing travels on the same IRC connection and clears when you send, pause, or leave the conversation.

## Formatting

Slirc supports a small, safe Markdown subset. Formatting previews in the composer and stays readable as plain text in IRC clients.

<table>
  <thead><tr><th>Style</th><th>Type</th><th>Result</th></tr></thead>
  <tbody>
    <tr><td>Bold</td><td><code>**important**</code> or <code>__important__</code></td><td><strong>important</strong></td></tr>
    <tr><td>Italic</td><td><code>*gentle*</code> or <code>_gentle_</code></td><td><em>gentle</em></td></tr>
    <tr><td>Inline code</td><td><code>`npm install`</code></td><td><code>npm install</code></td></tr>
    <tr><td>Code block</td><td>Fenced with <code>```</code>; add language after opening fence</td><td>Glow-highlighted block</td></tr>
    <tr><td>Link</td><td><code>[label](https://…)</code></td><td><a href="https://example.com">a label</a></td></tr>
    <tr><td>Quote</td><td><code>&gt; </code> at the start of a line</td><td>Quote block</td></tr>
    <tr><td>List</td><td><code>- </code>, <code>* </code>, <code>• </code> or <code>1. </code> at the start of a line</td><td>Bulleted or numbered item</td></tr>
  </tbody>
</table>

In a list, a new line starts with the next bullet or number. That's Shift + Enter on a computer and Return on a phone. A new line on an empty item ends the list.

Select text and press <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>B</kbd> for bold, <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>I</kbd> for italic, or <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>C</kbd> for inline code. With no selection, shortcut wraps the word at the caret. Paste an HTTP(S) URL over selected text to make a link. Click or tap a rendered link to open it in a new tab. Right-click it, or long-press it on a phone, for **Go to** or **Edit**; Edit selects its text in the composer so pasting a replacement URL keeps its label.

## Emoji

Type `:clap:` or `:claps:` for 👏. After two characters, such as `:cl`, the composer suggests emoji. Use the arrow keys and Enter or Tab to choose; Escape closes the picker without sending.

Standard emoji are sent as Unicode, so IRC clients can display them too. Existing custom emoji appear as images in Slirc and keep their `:shortcode:` on IRC. Code and URLs stay unchanged; unknown shortcodes stay as text.

## Reactions

Hover or focus a message and click the smile button to open the reaction picker. On a phone, touch and hold the message instead; quick reactions sit at the top of the sheet that opens. For any other emoji, choose **Add reaction** (the smile with a plus) after the quick reactions, type a name such as `tada`, and press Enter or tap a result. Pick an emoji to stamp the message; tap the stamp again to remove it. Hover or keyboard-focus a stamp to see who added it. Everyone in Slirc sees reactions, and IRC clients with reaction support, such as Halloy, render the same stamps.

Custom emoji added to your **Slirc** show up in message and reaction search. They travel over IRC as readable shortcodes such as `:party_parrot:`.

## Editing and deleting

Open a message's menu (<kbd>⋮</kbd>) or right-click any message on desktop to edit it, reply in a thread, set a reminder with **Remind me**, copy a link to it with **Copy link**, or delete it. Right-clicking selected text keeps the copy menu, and right-clicking a link keeps the link menu. On a phone, touch and hold a message to get the same actions in a sheet; tap outside it to close. Edited messages show *(edited)*. You can edit or delete your own messages. Admins can also delete anyone's message in a channel or thread, or in a DM they are part of. They can edit messages the instance's bots posted, like a poll or an update note, and the edit shows as the bot's own. In channels and threads, admins are channel operators, so an IRC client gives them the same rights.

Drafts save locally as you type. Switch conversations to find unsent text under **Drafts** in navigation; select one to continue at its end, or delete it there. Sending clears its entry.

<div class="callout danger"><h4><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>Deleting is not erasing</h4><p>Deleting removes the message from server history, but IRC clients that already received it may keep their own copy.</p></div>

## Images and videos

Use the attach button, drop, or paste to add up to 10 JPEG, PNG, or WebP photos, each under 12 MB. Attach or drop MP4, MOV, and WebM videos the same way. Before upload, your browser shrinks a large MP4 or MOV to about 720p and removes its location and other metadata. The video that uploads must be under 30 MB. Videos play inline with the player's own controls. Remove any of them with its **×** before sending. The server resizes each one to at most 1600 pixels on the longest edge and saves it as WebP, preserving transparency and removing embedded metadata. Your caption and photos go out as one message; if they do not fit in one message, each photo goes out as its own message, in order, with the caption on the first. Animated GIFs are not uploaded: send a GIF with `/giphy`. The GIF shows inline, with its bracketed `[Giphy: …]` label as the link; the original URL stays in the message for IRC clients.

Every photo, video, and `/giphy` GIF keeps its box before its bytes arrive. Slirc knows each upload's pixel size, and a GIF carries its own in its link, so a channel full of pictures opens at the right height and nothing moves as they load. Collapse a message's image and embed previews to icons with the toggle on any preview. Slirc remembers collapsed messages per account in this browser.

Private uploads require current conversation membership, including the parent conversation for thread media. Public-room media and custom emoji are public. See [media access and its limits](/docs/privacy). Authorized video viewers can seek through the file.

Open an image to zoom. Escape restores the normal view before closing it; reactions stay on the message, not in the lightbox.

## Links and previews

Paste a link and Slirc shows a preview with the page's title, description, and image when available. A link that points straight at an image, such as a Pexels photo, shows the picture inline instead of a card; click it to open the lightbox. When the server knows the picture's dimensions, Slirc reserves its space before it loads. A card's thumbnail always keeps the same frame, cropped to fill it, so a preview saved without a known size cannot shift the conversation either. Pages that publish oEmbed (YouTube, Vimeo, Spotify, SoundCloud, Bluesky, TikTok, Loom, CodePen, Figma, Apple Music, Bandcamp, Twitch, Mastodon and PeerTube instances) show a thumbnail with a play button; pressing it opens the player in a sandboxed frame.

Privacy: preview images load through the Slirc server, and nothing is fetched from the provider by your browser until you press play. YouTube uses the no-cookie host, Vimeo gets do-not-track. Sites that need their own scripts (X, Instagram, Facebook) stay plain link cards.

Previews are per device. Dismiss one with the × and Slirc remembers.

A link to a message in this Slirc shows as a short label, such as **View in #general**, **View in DM with sam** or **View in thread**, and opens that message in place.

**Copy link** in a message's menu copies a link anyone in that conversation can open in a browser, the desktop app or the phone app. It opens the conversation at that message, with the messages around it, even an old one, and the message glows briefly. On a message that started a reply thread, the link opens the thread too and shows as **View thread in #general**. A link to a reply opens its thread. A link to a DM message opens the same DM for both people in it, shown as **View in DM with** the other person. People who can't read the conversation, or a message that was deleted, get the note *That message isn't available.*

In public rooms, you see the preview a member already loaded for that link, plus video thumbnails. The server does not fetch remote pages on request. Photos and videos pasted in those rooms stay visible to members too; private media requires current conversation membership.

## Links library

Some workspaces keep every shared link in a searchable library. It is off unless the workspace runs the `links` helper. When it's on, `links` saves each link posted in a channel it's in, once per link, with its title, preview image and a copy of the page text. The library lives in `#links`, which opens on a search field with the saved links grouped by day. Other channels with the helper in them get a **Links** and **Messages** switch in the header, showing that channel's links. A link from an invite-only channel is visible only to that channel's members.

`/link https://example.com/article` saves a link to `#links`. `/links` opens the library, and `/links` followed by words searches it. Both commands show only where the helper runs.

## Searching a conversation

Press <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>F</kbd>, or use the magnifying glass in the header, to search the open channel, DM or Notes. Type words to find messages that contain all of them, or add `from:@name` to limit results to one person. Use the **Images** and **Links** buttons to list only messages with pictures or links, alone or together with words. Pick a result to jump to that message; replies open their thread. Search covers the messages this device has loaded. Choose **Load older messages** to fetch more history.

## Commands

`/help` inside the app lists everything. The useful ones:

| Command | What it does |
| --- | --- |
| `/help` | Browse the command list |
| `/me action` | Send an action ("waves") |
| `/msg nick text` | Open a direct message |
| `/threads [reply]` | Start a [thread](/docs/threads) from the latest message |
| `/giphy search` | Find a GIF and send it |
| `/whois nick` | Look up a person |
| `/invite @nick` or `/invite email` | Add someone to this channel, or [invite them by email](/docs/channels#inviting-people) |
| `/kick @nick [reason]` | Remove someone from a channel (admins only, see [channels](/docs/channels#kicking-someone-from-a-channel)) |
| `/remind when text` | Set a reminder; it arrives in your DM with remind |
| `/poll question? a, b` | Start a [poll](/docs/bots#polls-poll); `/poll 2` votes privately |
| `/reconnect` | Reconnect to IRC |
| `/leave` | Sign out of Slirc on this device |

## Next

Turn one message into a focused conversation with [threads](/docs/threads), or tune when you get pinged in [notifications](/docs/notifications).