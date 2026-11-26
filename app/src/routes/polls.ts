import { createLimiter } from "../request-security.ts";
import { bodyLimit } from "hono/body-limit";
import { verifiedHuman, currentUser, sameOriginJson } from "../http/session.ts";
import { enabledHelpers } from "../config.ts";
import { isMember, isOpenChannel, channelInfo, normalized } from "../rooms.ts";
import { voteIn, openPoll, type Poll, canClose as canClosePoll, pollById, checkPoll, createPoll, announceLines, pollView, setVotes, isClosed as pollClosed, closePoll, tallyLines, votes } from "../polls.ts";
import { db } from "../db.ts";
import { publishWhere, channelsChanged } from "../live.ts";
import { setPollChangeListener, helperSay, pollTag, tallyTag } from "../helper-bot.ts";
import { accountByNick } from "../accounts.ts";
import { memberAddDenial, belongsTo } from "../http/authz.ts";
import { grantChannelAccess } from "../grants.ts";
import { join } from "node:path";
import { Hono } from "hono";

export const polls = new Hono();

// A vote from the composer (`@poll 2` or `/poll 2`). It never goes over IRC, so nobody in the
// channel sees who voted for what; the confirmation shows only for the voter.
const pollVoteLimit = createLimiter({ limit: 30, windowMs: 60_000 });

polls.use("/api/polls/vote", bodyLimit({ maxSize: 512 }));

polls.post("/api/polls/vote", async (c) => {
  c.header("Cache-Control", "no-store");
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!sameOriginJson(c, "X-Slirc-Poll")) return c.json({ error: "same-origin request required" }, 403);
  if (!enabledHelpers().includes("poll")) return c.json({ error: "Polls are off on this server." }, 503);
  const body = await c.req.json().catch(() => ({})) as { channel?: unknown; option?: unknown };
  const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
  const option = body.option;
  if (!channel.startsWith("#") || typeof option !== "number" || !Number.isInteger(option)) return c.json({ error: "Vote with a number, like @poll 2." }, 400);
  if (!isMember(requester.nick, channel)) return c.json({ error: "Join the channel to vote." }, 403);
  if (!pollVoteLimit.check(requester.nick)) return c.json({ error: "Too many votes at once. Try again in a minute." }, 429);
  const reply = voteIn(channel, requester.nick, option);
  const open = openPoll(channel);
  if (open) pollChanged(open);
  return c.json({ reply });
});

// Poll cards. The helper's announcement carries +slirc/poll=<id>; the app reads the poll's state
// here and hears about each change through the live "poll" event, sent only to the channel's
// members. The event names the poll, never a voter: each tab asks again and gets its own view.
function pollChanged(poll: { id: number; channel: string }): void {
  // Live listeners are keyed by lowercased nick and channel_members keeps the nick's own case,
  // so membership is compared without case here.
  const member = db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ? COLLATE NOCASE");
  publishWhere((nick) => isOpenChannel(poll.channel) || !!member.get(poll.channel, nick), "poll", { id: poll.id, channel: poll.channel });
}

setPollChangeListener(pollChanged);

// The creator, a server admin or the channel's owner can close a poll from its card. Typed
// `@poll close` keeps its own rule (creator or channel op), which the helper checks over IRC.
function mayClosePoll(poll: Poll, nick: string): boolean {
  return canClosePoll(poll, nick, accountByNick(nick)?.role === "admin" || channelInfo(poll.channel)?.owner?.toLowerCase() === nick.toLowerCase());
}

// One poll the caller can read: a verified member of its channel, on a server with polls on.
function readablePoll(c: any): { poll: Poll; nick: string } | Response {
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!enabledHelpers().includes("poll")) return c.json({ error: "Polls are off on this server." }, 503);
  const poll = pollById(Number(c.req.param("id")));
  // An outsider gets the same answer as a missing poll, so ids reveal nothing.
  if (!poll || !isMember(requester.nick, poll.channel)) return c.json({ error: "poll not found" }, 404);
  return { poll, nick: requester.nick };
}

const pollCreateLimit = createLimiter({ limit: 10, windowMs: 60_000 });

polls.use("/api/polls", bodyLimit({ maxSize: 4096 }));

polls.use("/api/polls/*", bodyLimit({ maxSize: 4096 }));

polls.post("/api/polls", async (c) => {
  c.header("Cache-Control", "no-store");
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!sameOriginJson(c, "X-Slirc-Poll")) return c.json({ error: "same-origin request required" }, 403);
  if (!enabledHelpers().includes("poll")) return c.json({ error: "Polls are off on this server." }, 503);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const channel = typeof body.channel === "string" ? normalized(body.channel) : "";
  if (!channel.startsWith("#")) return c.json({ error: "Pick a channel for the poll." }, 400);
  const helper = accountByNick("poll");
  if (!helper || helper.kind !== "bot") return c.json({ error: "Polls are off on this server." }, 503);
  const denial = memberAddDenial(requester.nick, channel, helper);
  if (denial) return c.json({ error: denial.status === 404 ? "Polls work in channels." : "Join the channel to start a poll." }, denial.status);
  const parsed = checkPoll(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  if (!pollCreateLimit.check(requester.nick)) return c.json({ error: "Too many polls at once. Try again in a minute." }, 429);
  const open = openPoll(channel);
  if (open) return c.json({ error: `There is already an open poll here: ${open.question} Close it first.`, poll: open.id }, 409);
  // The helper joins on its own once it has a membership row; the announcement waits in its outbox.
  if (!belongsTo(helper, channel)) {
    db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(channel, helper.nick);
    if (!isOpenChannel(channel)) {
      try { await grantChannelAccess(channel, helper.nick); } catch (error) {
        db.query("DELETE FROM channel_members WHERE channel = ? AND nick = ?").run(channel, helper.nick);
        console.error(`poll grant failed in ${channel}:`, error);
        return c.json({ error: "Could not add @poll to this channel. Try again." }, 500);
      }
      channelsChanged(channel, [helper.nick], true);
    }
  }
  // Another request may have opened a poll here while the grant was awaited.
  const raced = openPoll(channel);
  if (raced) return c.json({ error: `There is already an open poll here: ${raced.question} Close it first.`, poll: raced.id }, 409);
  const poll = createPoll(channel, requester.nick, parsed);
  helperSay("poll", channel, [announceLines(poll).join("\n")], undefined, pollTag(poll));
  return c.json(pollView(poll, requester.nick, mayClosePoll(poll, requester.nick)));
});

polls.get("/api/polls/:id", (c) => {
  c.header("Cache-Control", "no-store");
  const found = readablePoll(c);
  if (found instanceof Response) return found;
  return c.json(pollView(found.poll, found.nick, mayClosePoll(found.poll, found.nick)));
});

// The voter's whole choice for one poll: { options: [2] }, { options: [1, 3] }, or [] to take it back.
polls.post("/api/polls/:id/vote", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!sameOriginJson(c, "X-Slirc-Poll")) return c.json({ error: "same-origin request required" }, 403);
  const found = readablePoll(c);
  if (found instanceof Response) return found;
  const body = await c.req.json().catch(() => ({})) as { options?: unknown };
  if (!pollVoteLimit.check(found.nick)) return c.json({ error: "Too many votes at once. Try again in a minute." }, 429);
  const result = setVotes(found.poll, found.nick, body.options);
  if (!result.ok) return c.json({ error: result.error }, result.error === "That poll is closed." ? 409 : 400);
  pollChanged(found.poll);
  return c.json(pollView(found.poll, found.nick, mayClosePoll(found.poll, found.nick)));
});

polls.post("/api/polls/:id/close", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!sameOriginJson(c, "X-Slirc-Poll")) return c.json({ error: "same-origin request required" }, 403);
  const found = readablePoll(c);
  if (found instanceof Response) return found;
  const { poll, nick } = found;
  if (pollClosed(poll)) return c.json(pollView(poll, nick, false));
  if (!mayClosePoll(poll, nick)) return c.json({ error: `Only ${poll.creator} or an admin can close this poll.` }, 403);
  const closed = closePoll(poll);
  // IRC clients read the result as text; the app hides that tally and redraws the card instead.
  helperSay("poll", closed.channel, [tallyLines(closed, votes(closed), true).join("\n")], undefined, tallyTag(closed));
  pollChanged(closed);
  return c.json(pollView(closed, nick, false));
});
