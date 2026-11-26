title: Threads
crumb: Guides / Threads
description: Slirc threads: start a focused conversation from one message. Replies travel with standard IRCv3 +reply tags inside the channel or DM.
lead: Reply to any message in a side panel without cluttering the channel. Replies use standard IRCv3 `+reply` tags, so IRC clients see them in the same channel or DM.

## Start a thread in the app

Use a message's **Reply in thread** action (or press <kbd>T</kbd> on a selected message, or right-click a message on desktop).

1. A thread panel opens beside the channel on desktop, or full-screen on a phone, showing the opening message and its replies.
2. Replies stay inside the thread panel by default. Check **Also send to #channel** (or the DM name) before sending to post a copy to the main timeline as well.
3. Press <kbd>Esc</kbd> or close the panel to return to the conversation.

Messages with replies show a reply count under the message; select it to open the thread. On IRC, every reply travels in the same channel or DM with an IRCv3 `+reply=<msgid>` tag pointing to the opening message, so any IRC client can read and reply without joining a separate channel.

The **Threads** group in the sidebar lists the threads you started or replied to, newest activity first, each with its opening text and channel. A count shows replies you haven't read. It lists the first three and a "more" row for the rest. Select a row to open the thread. Threads in a channel you leave drop off your list, and the group is hidden while you have none. A thread appears once one of its replies has reached the app.

## Use threads from IRC

For reply threads, standard IRC clients see each reply in the same channel or DM with an IRCv3 `+reply=<msgid>` tag. Clients that support `+reply` link replies back to the opening message automatically.
