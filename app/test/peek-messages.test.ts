// The signed-out #open-chat payload: history lines to the rows the shared transcript draws.
import "./fixture.ts";
import { expect, test } from "bun:test";
import { parseLine } from "../src/irc.ts";
import { peekMessages } from "../src/peek.ts";

const lines = (...rows: string[]) => rows.map(parseLine);

test("a multiline batch is one message, joined the way the client joins it", () => {
  const rows = peekMessages(lines(
    "@batch=h;msgid=m1;time=2026-11-19T10:00:00.000Z :ada!a@slirc BATCH +ml draft/multiline #open-chat",
    "@batch=ml :ada!a@slirc PRIVMSG #open-chat :first line",
    "@batch=ml;draft/multiline-concat :ada!a@slirc PRIVMSG #open-chat : continued",
    "@batch=ml :ada!a@slirc PRIVMSG #open-chat :second line",
    "@batch=h;msgid=m2;time=2026-11-19T10:00:01.000Z :ben!b@slirc PRIVMSG #open-chat :after",
  ));
  expect(rows.map((row) => [row.id, row.nick, row.text])).toEqual([
    ["m1", "ada", "first line continued\nsecond line"],
    ["m2", "ben", "after"],
  ]);
});

test("the updates bot's multiline note shows even when its opener lacks a sender or time", () => {
  const rows = peekMessages(lines(
    "@batch=h;msgid=u1;time=2026-11-19T15:23:46.000Z;bot;account=updates :updates!u@slirc PRIVMSG #open-chat :Admins can copy a join link again.",
    // Opener as a server writes a nested batch: its own source, no time; the lines carry both.
    "@batch=h;msgid=u2;bot;account=updates :slirc.org BATCH +ml draft/multiline #open-chat",
    "@batch=ml;time=2026-11-19T17:40:00.000Z :updates!u@slirc PRIVMSG #open-chat :We fixed reminders that fired twice.",
    "@batch=ml :updates!u@slirc PRIVMSG #open-chat :Polls now show who voted.",
    "@batch=h :slirc.org BATCH -ml",
    "@batch=h;msgid=w1;time=2026-11-20T09:00:00.000Z;bot :welcome!w@slirc PRIVMSG #open-chat :Good morning",
  ));
  expect(rows.map((row) => [row.id, row.nick, row.text])).toEqual([
    ["u1", "updates", "Admins can copy a join link again."],
    ["u2", "updates", "We fixed reminders that fired twice.\nPolls now show who voted."],
    ["w1", "welcome", "Good morning"],
  ]);
  expect(rows[1]!.time).toBe("2026-11-19T17:40:00.000Z");
});

test("reactions count onto the message they name, and an unreact takes one back", () => {
  const [row] = peekMessages(lines(
    "@msgid=m1;time=2026-11-19T10:00:00.000Z :ada!a@slirc PRIVMSG #open-chat :ship it",
    "@msgid=r1;time=2026-11-19T10:00:01.000Z;+reply=m1;+draft/react=👍;account=ben :ben!b@slirc TAGMSG #open-chat",
    "@msgid=r2;time=2026-11-19T10:00:02.000Z;+reply=m1;+draft/react=👍;account=eve :eve!e@slirc TAGMSG #open-chat",
    "@msgid=r3;time=2026-11-19T10:00:03.000Z;+reply=m1;+draft/react=🎉;account=ben :ben!b@slirc TAGMSG #open-chat",
    "@msgid=r4;time=2026-11-19T10:00:04.000Z;+reply=m1;+draft/unreact=🎉;account=ben :ben!b@slirc TAGMSG #open-chat",
    "@msgid=r5;time=2026-11-19T10:00:05.000Z;+reply=gone;+draft/react=👀 :ben!b@slirc TAGMSG #open-chat",
  ));
  expect(row!.reactions).toEqual([{ emoji: "👍", count: 2, accounts: ["ben", "eve"] }]);
});

test("poll and reply tags pass through; malformed ones do not", () => {
  const rows = peekMessages(lines(
    "@msgid=p1;time=2026-11-19T10:00:00.000Z;+slirc/poll=7 :poll!p@slirc PRIVMSG #open-chat :Poll: lunch?",
    "@msgid=p2;time=2026-11-19T10:00:01.000Z;+slirc/poll-tally=7;+reply=p1 :poll!p@slirc PRIVMSG #open-chat :Results",
    "@msgid=p3;time=2026-11-19T10:00:02.000Z;+slirc/poll=x;+reply=bad%20id :ada!a@slirc PRIVMSG #open-chat :plain",
  ));
  expect(rows.map(({ poll, replyTo }) => ({ poll, replyTo }))).toEqual([
    { poll: { id: 7, kind: "card" }, replyTo: undefined },
    { poll: { id: 7, kind: "tally" }, replyTo: "p1" },
    { poll: undefined, replyTo: undefined },
  ]);
});
