import "./fixture.ts";

import { beforeEach, describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const polls = await import("../src/polls.ts");

// Close to now: a poll past its closing time is closed, so test polls must still be running.
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const HOUR = 3_600_000;

const parsed = (input: string) => {
  const result = polls.parsePoll(input, NOW);
  if ("error" in result) throw new Error(result.error);
  return result;
};

describe("poll parsing", () => {
  test("splits a question from comma options", () => {
    expect(parsed("Lunch? pizza, sushi, salad")).toEqual({ question: "Lunch?", options: ["pizza", "sushi", "salad"], closesAt: NOW + polls.DEFAULT_SPAN_MS, named: false });
  });

  test("falls back to 'or' when there is no comma", () => {
    expect(parsed("pizza or sushi?")).toEqual({ question: "pizza or sushi?", options: ["pizza", "sushi"], closesAt: NOW + polls.DEFAULT_SPAN_MS, named: false });
    expect(parsed("Where? here or there")).toMatchObject({ question: "Where?", options: ["here", "there"] });
  });

  test("reads a duration and the named flag in either order", () => {
    expect(parsed("Lunch? a, b for 1h")).toMatchObject({ closesAt: NOW + HOUR, named: false });
    expect(parsed("Lunch? a, b named")).toMatchObject({ closesAt: NOW + polls.DEFAULT_SPAN_MS, named: true, options: ["a", "b"] });
    expect(parsed("Lunch? a, b for 30m named")).toMatchObject({ closesAt: NOW + 30 * 60_000, named: true });
    expect(parsed("Lunch? a, b named for 2 days")).toMatchObject({ closesAt: NOW + 2 * 24 * HOUR, named: true });
  });

  test("keeps 'for' and 'named' inside options alone", () => {
    expect(parsed("Vote? named storms, numbered storms")).toMatchObject({ options: ["named storms", "numbered storms"], named: false });
  });

  test("rejects too few, too many, or duplicate options", () => {
    expect(polls.parsePoll("Lunch? pizza", NOW)).toMatchObject({ error: expect.stringContaining("at least 2") });
    expect(polls.parsePoll("", NOW)).toMatchObject({ error: expect.stringContaining("question") });
    expect(polls.parsePoll(`N? ${Array.from({ length: 11 }, (_v, i) => `o${i}`).join(", ")}`, NOW)).toMatchObject({ error: expect.stringContaining("at most 10") });
    expect(polls.parsePoll("Lunch? pizza, Pizza", NOW)).toMatchObject({ error: expect.stringContaining("different") });
    expect(polls.parsePoll("Lunch? a, b for 1 fortnight", NOW)).toMatchObject({ error: expect.stringContaining("duration") });
  });

  test("keeps questions, options and durations to sizes a channel can read", () => {
    expect(polls.parsePoll(`${"q".repeat(201)}? a, b`, NOW)).toMatchObject({ error: expect.stringContaining("200") });
    expect(polls.parsePoll(`Q? ${"a".repeat(81)}, b`, NOW)).toMatchObject({ error: expect.stringContaining("80") });
    expect(polls.parsePoll("Q? a, b for 31d", NOW)).toMatchObject({ error: expect.stringContaining("30 days") });
    expect(polls.parsePoll("Q? a, b for 30s", NOW)).toMatchObject({ error: expect.stringContaining("1 minute") });
    expect(parsed("Q? a, b for 30d")).toMatchObject({ closesAt: NOW + 30 * 24 * HOUR });
  });
});

describe("poll store", () => {
  beforeEach(() => {
    db.query("DELETE FROM poll_votes").run();
    db.query("DELETE FROM polls").run();
  });

  const open = (input = "Lunch? pizza, sushi, salad", creator = "ana") => polls.createPoll("#Untitled", creator, parsed(input), NOW);

  test("one vote per nick, revote replaces", () => {
    const poll = open();
    expect(polls.vote(poll, "bo", 2)).toEqual({ ok: true, option: "sushi" });
    expect(polls.vote(poll, "Bo", 1)).toEqual({ ok: true, option: "pizza" });
    expect(polls.vote(poll, "cy", 1)).toEqual({ ok: true, option: "pizza" });
    expect(polls.votes(poll)).toEqual([{ nick: "bo", option: 1 }, { nick: "cy", option: 1 }]);
    expect(polls.vote(poll, "bo", 4)).toEqual({ ok: false, error: "Pick a number from 1 to 3." });
    expect(polls.vote(poll, "bo", 0)).toMatchObject({ ok: false });
  });

  test("one open poll per room", () => {
    const poll = open();
    expect(polls.openPoll("#untitled")?.id).toBe(poll.id);
    expect(polls.openPoll("#other")).toBeNull();
    polls.closePoll(poll, NOW + 1);
    expect(polls.openPoll("#untitled")).toBeNull();
    expect(polls.createPoll("#untitled", "bo", parsed("Tea? green, black"), NOW + 2).id).toBeGreaterThan(poll.id);
  });

  test("close is for the creator or an op, and rejects new votes", () => {
    const poll = open();
    expect(polls.canClose(poll, "bo", false)).toBe(false);
    expect(polls.canClose(poll, "Ana", false)).toBe(true);
    expect(polls.canClose(poll, "bo", true)).toBe(true);
    const closed = polls.closePoll(poll, NOW + 5);
    expect(closed.closed_at).toBe(NOW + 5);
    expect(polls.vote(closed, "bo", 1)).toEqual({ ok: false, error: "That poll is closed." });
  });

  test("a private vote answers only with the pick, and knows when there is no poll", () => {
    expect(polls.voteIn("#untitled", "bo", 1)).toStartWith("No open poll here.");
    open();
    expect(polls.voteIn("#Untitled", "bo", 2)).toBe("Counted: sushi");
    expect(polls.voteIn("#untitled", "bo", 9)).toBe("Pick a number from 1 to 3.");
  });

  test("a poll with no duration still ends after a week", () => {
    const poll = open("Lunch? a, b");
    expect(polls.duePolls(NOW + polls.DEFAULT_SPAN_MS - 1)).toEqual([]);
    expect(polls.duePolls(NOW + polls.DEFAULT_SPAN_MS).map((due) => due.id)).toEqual([poll.id]);
  });

  test("timed polls come due once", () => {
    const timed = open("Lunch? a, b for 1h");
    expect(polls.duePolls(NOW + HOUR - 1)).toEqual([]);
    expect(polls.duePolls(NOW + HOUR).map((poll) => poll.id)).toEqual([timed.id]);
    polls.closePoll(timed, NOW + HOUR);
    expect(polls.duePolls(NOW + HOUR)).toEqual([]);
  });

  test("announcement lists the options and the tally counts votes and names the winner", () => {
    const poll = open("Lunch? pizza, sushi, salad for 1h");
    expect(polls.announceLines(poll, NOW)).toEqual(expect.arrayContaining(["1. pizza", "2. sushi", "3. salad"]));
    polls.vote(poll, "bo", 1);
    polls.vote(poll, "cy", 1);
    polls.vote(poll, "di", 2);
    expect(polls.tallyLines(poll, polls.votes(poll))).toEqual(["Poll: Lunch? (3 votes)", "1. pizza: 2", "2. sushi: 1", "3. salad: 0"]);
    expect(polls.tallyLines(poll, polls.votes(poll), true)).toEqual(["Poll closed: Lunch? (3 votes)", "1. pizza: 2", "2. sushi: 1", "3. salad: 0", "Winner: pizza"]);
  });

  test("named polls list voters, ties are called", () => {
    const poll = open("Tea? green, black named");
    polls.vote(poll, "bo", 1);
    polls.vote(poll, "cy", 2);
    expect(polls.tallyLines(poll, polls.votes(poll), true)).toEqual(["Poll closed: Tea? (2 votes)", "1. green: 1 (bo)", "2. black: 1 (cy)", "Tie: green, black"]);
    expect(polls.tallyLines(poll, [], true)).toEqual(["Poll closed: Tea? (0 votes)", "1. green: 0", "2. black: 0"]);
  });
});

test("a big named tally keeps each option to one line under the wire budget", () => {
  db.query("DELETE FROM poll_votes").run();
  db.query("DELETE FROM polls").run();
  const poll = polls.createPoll("#big", "ana", parsed("Lunch? pizza, sushi named"), NOW);
  const ballots = Array.from({ length: 120 }, (_v, i) => ({ nick: `member${String(i).padStart(3, "0")}`, option: 1 }));
  const line = polls.tallyLines(poll, ballots)[1]!;
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(polls.LINE_BYTES);
  expect(line).toStartWith("1. pizza: 120 (member000, member001");
  expect(line).toMatch(/ and \d+ more\)$/);
  expect(polls.tallyLines(poll, ballots.slice(0, 2))[1]).toBe("1. pizza: 2 (member000, member001)");
});
