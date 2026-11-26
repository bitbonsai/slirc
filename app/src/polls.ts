import { db } from "./db.ts";
import { describeWhen } from "./reminders.ts";
import { bytes, CONTROL, LINE_BYTES, MAX_OPTIONS, MAX_SPAN_MS, MIN_OPTIONS, sizeError, type ParsedPoll } from "../shared/poll-parse.ts";
export * from "../shared/poll-parse.ts";

// Room polls for the @poll helper. Plain text in, plain text out: every line here
// reads the same in the PWA and in an ordinary IRC client. The typed-poll rules live in
// shared/poll-parse.ts, where the app's composer reads them too.

export type Poll = {
  id: number;
  channel: string;
  creator: string;
  question: string;
  options: string[];
  named: boolean;
  multi: boolean;
  created_at: number;
  closes_at: number | null;
  closed_at: number | null;
};
export type Vote = { nick: string; option: number };

type Row = Omit<Poll, "options" | "named" | "multi"> & { options: string; named: number; multi: number };
const fromRow = (row: Row): Poll => ({ ...row, options: JSON.parse(row.options), named: row.named === 1, multi: row.multi === 1 });

export function pollById(id: number): Poll | null {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = db.query("SELECT * FROM polls WHERE id = ?").get(id) as Row | null;
  return row ? fromRow(row) : null;
}

// A poll from the app's dialog. Same limits as a typed one; closesIn is null for no timer.
export function checkPoll(input: { question?: unknown; options?: unknown; multi?: unknown; anonymous?: unknown; closesIn?: unknown }, now = Date.now()): ParsedPoll | { error: string } {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  const options = Array.isArray(input.options) ? input.options.map((option) => typeof option === "string" ? option.trim() : "").filter(Boolean) : [];
  const closesIn = input.closesIn ?? null;
  if (!question) return { error: "Write a question." };
  if (CONTROL.test(question) || options.some((option) => CONTROL.test(option))) return { error: "Keep the question and each option on one line." };
  if (options.length < MIN_OPTIONS) return { error: `A poll needs at least ${MIN_OPTIONS} options.` };
  if (options.length > MAX_OPTIONS) return { error: `A poll can have at most ${MAX_OPTIONS} options.` };
  const tooBig = sizeError(question, options);
  if (tooBig) return { error: tooBig };
  if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) return { error: "Each option has to be different." };
  if (closesIn !== null && (typeof closesIn !== "number" || !Number.isInteger(closesIn) || closesIn < 60_000 || closesIn > MAX_SPAN_MS)) return { error: "A poll can run from 1 minute to 30 days." };
  return { question, options, closesAt: closesIn === null ? null : now + closesIn, named: input.anonymous !== true, multi: input.multi === true };
}

// A poll past its closing time is closed, even before the helper posts its result: the helper
// may be offline, and the poll must not take votes or block the next one meanwhile.
export function isClosed(poll: Pick<Poll, "closed_at" | "closes_at">, now = Date.now()): boolean {
  return poll.closed_at !== null || (poll.closes_at !== null && poll.closes_at <= now);
}

export function openPoll(channel: string, now = Date.now()): Poll | null {
  const row = db.query("SELECT * FROM polls WHERE channel = ? COLLATE NOCASE AND closed_at IS NULL AND (closes_at IS NULL OR closes_at > ?) ORDER BY id DESC LIMIT 1").get(channel, now) as Row | null;
  return row ? fromRow(row) : null;
}

export function createPoll(channel: string, creator: string, parsed: ParsedPoll, now = Date.now()): Poll {
  const result = db.query("INSERT INTO polls (channel, creator, question, options, named, multi, created_at, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(channel.toLowerCase(), creator, parsed.question, JSON.stringify(parsed.options), parsed.named ? 1 : 0, parsed.multi ? 1 : 0, now, parsed.closesAt);
  return {
    id: Number(result.lastInsertRowid),
    channel: channel.toLowerCase(),
    creator,
    question: parsed.question,
    options: parsed.options,
    named: parsed.named,
    multi: parsed.multi === true,
    created_at: now,
    closes_at: parsed.closesAt,
    closed_at: null,
  };
}

// A typed vote (`@poll 2`, `/msg poll #room 2`). One pick per account moves on a second vote; a
// poll with multiple answers adds the pick to the ones already made.
export function vote(poll: Poll, nick: string, option: number, now = Date.now()): { ok: true; option: string } | { ok: false; error: string } {
  if (isClosed(poll, now)) return { ok: false, error: "That poll is closed." };
  if (!Number.isInteger(option) || option < 1 || option > poll.options.length) {
    return { ok: false, error: `Pick a number from 1 to ${poll.options.length}.` };
  }
  const counted = db.transaction(() => {
    // The poll object can be stale: it may have closed since it was read.
    if (!stillOpen(poll.id, now)) return false;
    if (!poll.multi && db.query("UPDATE poll_votes SET option = ?, voted_at = ? WHERE poll_id = ? AND nick = ?").run(option, now, poll.id, nick).changes) return true;
    db.query("INSERT INTO poll_votes (poll_id, nick, option, voted_at) VALUES (?, ?, ?, ?) ON CONFLICT(poll_id, nick, option) DO UPDATE SET voted_at = excluded.voted_at")
      .run(poll.id, nick, option, now);
    return true;
  })();
  return counted ? { ok: true, option: poll.options[option - 1] } : { ok: false, error: "That poll is closed." };
}

// A tap on the card sends the voter's whole choice: [] takes the vote back. Picks that stay keep
// their time, so "View votes" shows when each was first made.
export function setVotes(poll: Poll, nick: string, picks: unknown, now = Date.now()): { ok: true } | { ok: false; error: string } {
  if (isClosed(poll, now)) return { ok: false, error: "That poll is closed." };
  if (!Array.isArray(picks) || picks.some((pick) => !Number.isInteger(pick) || pick < 1 || pick > poll.options.length)) {
    return { ok: false, error: `Pick a number from 1 to ${poll.options.length}.` };
  }
  const chosen = [...new Set(picks as number[])];
  if (!poll.multi && chosen.length > 1) return { ok: false, error: "This poll takes one answer." };
  const saved = db.transaction(() => {
    if (!stillOpen(poll.id, now)) return false;
    const keep = new Set(chosen);
    for (const row of db.query("SELECT option FROM poll_votes WHERE poll_id = ? AND nick = ?").all(poll.id, nick) as { option: number }[]) {
      if (!keep.has(row.option)) db.query("DELETE FROM poll_votes WHERE poll_id = ? AND nick = ? AND option = ?").run(poll.id, nick, row.option);
    }
    for (const option of chosen) db.query("INSERT INTO poll_votes (poll_id, nick, option, voted_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(poll.id, nick, option, now);
    return true;
  })();
  return saved ? { ok: true } : { ok: false, error: "That poll is closed." };
}

const stillOpen = (id: number, now: number) => !!db.query("SELECT 1 FROM polls WHERE id = ? AND closed_at IS NULL AND (closes_at IS NULL OR closes_at > ?)").get(id, now);

export function votes(poll: Poll): Vote[] {
  return db.query("SELECT nick, option FROM poll_votes WHERE poll_id = ? ORDER BY voted_at, rowid").all(poll.id) as Vote[];
}

// What the app's card draws, for one viewer. An anonymous poll never names anyone but the viewer,
// and only through `mine`.
export type PollView = {
  id: number;
  channel: string;
  creator: string;
  question: string;
  multi: boolean;
  anonymous: boolean;
  createdAt: number;
  closesAt: number | null;
  closedAt: number | null;
  options: { label: string; count: number; voters?: { nick: string; at: number }[] }[];
  voters: number;
  mine: number[];
  winners: number[];
  canClose: boolean;
};

export function pollView(poll: Poll, viewer: string, canCloseIt: boolean, now = Date.now()): PollView {
  // Past its time it reads as closed at that time, before the helper gets to close it.
  const closedAt = poll.closed_at ?? (isClosed(poll, now) ? poll.closes_at : null);
  const rows = db.query("SELECT nick, option, voted_at FROM poll_votes WHERE poll_id = ? ORDER BY voted_at, rowid").all(poll.id) as { nick: string; option: number; voted_at: number }[];
  const options = poll.options.map((label) => ({ label, count: 0, ...(poll.named ? { voters: [] as { nick: string; at: number }[] } : {}) }));
  const people = new Set<string>();
  const mine: number[] = [];
  for (const row of rows) {
    const option = options[row.option - 1];
    if (!option) continue;
    option.count++;
    option.voters?.push({ nick: row.nick, at: row.voted_at });
    people.add(row.nick.toLowerCase());
    if (row.nick.toLowerCase() === viewer.toLowerCase()) mine.push(row.option);
  }
  const top = Math.max(0, ...options.map((option) => option.count));
  const winners = closedAt !== null && top > 0 ? options.flatMap((option, index) => option.count === top ? [index + 1] : []) : [];
  return {
    id: poll.id,
    channel: poll.channel,
    creator: poll.creator,
    question: poll.question,
    multi: poll.multi,
    anonymous: !poll.named,
    createdAt: poll.created_at,
    closesAt: poll.closes_at,
    closedAt,
    options,
    voters: people.size,
    mine: mine.sort((a, b) => a - b),
    winners,
    canClose: canCloseIt && closedAt === null,
  };
}

export function closePoll(poll: Poll, now = Date.now()): Poll {
  db.query("UPDATE polls SET closed_at = ? WHERE id = ? AND closed_at IS NULL").run(now, poll.id);
  return { ...poll, closed_at: now };
}

// Polls whose "for 1h" has run out and that nobody closed by hand.
export function duePolls(now = Date.now()): Poll[] {
  return (db.query("SELECT * FROM polls WHERE closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= ? ORDER BY closes_at").all(now) as Row[]).map(fromRow);
}

export function canClose(poll: Poll, nick: string, isOp: boolean): boolean {
  return isOp || poll.creator.toLowerCase() === nick.toLowerCase();
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// The lines posted when a poll opens. Plain numbered options, then how to vote.
export function announceLines(poll: Poll, now = Date.now()): string[] {
  const lines = [`Poll by ${poll.creator}: ${poll.question}`];
  poll.options.forEach((option, index) => lines.push(`${index + 1}. ${option}`));
  let footer = `Vote with @poll 1, @poll 2 and so on${poll.multi ? ", as many as you like" : ""}. Results with @poll results, close with @poll close.`;
  if (poll.closes_at !== null) footer += ` Closes ${describeWhen(poll.closes_at, now)}.`;
  if (poll.named) footer += " Votes are shown by name.";
  lines.push(footer);
  return lines;
}

// Running or final tally. Named polls list who picked each option.
export function tallyLines(poll: Poll, ballots: Vote[], final = false): string[] {
  const counts = poll.options.map(() => 0);
  const names = poll.options.map(() => [] as string[]);
  for (const ballot of ballots) {
    if (ballot.option < 1 || ballot.option > poll.options.length) continue;
    counts[ballot.option - 1]++;
    names[ballot.option - 1].push(ballot.nick);
  }
  // With multiple answers one person can hold several ballots; the header counts people.
  const total = poll.multi ? new Set(ballots.map((ballot) => ballot.nick.toLowerCase())).size : ballots.length;
  const lines = [`${final ? "Poll closed" : "Poll"}: ${poll.question} (${plural(total, poll.multi ? "voter" : "vote")})`];
  poll.options.forEach((option, index) => {
    let line = `${index + 1}. ${option}: ${counts[index]}`;
    if (poll.named && names[index].length) line += ` (${namesWithin(names[index], LINE_BYTES - bytes(line) - 3)})`;
    lines.push(line);
  });
  if (final && total > 0) {
    const top = Math.max(...counts);
    const leaders = poll.options.filter((_option, index) => counts[index] === top);
    lines.push(leaders.length === 1 ? `Winner: ${leaders[0]}` : `Tie: ${leaders.join(", ")}`);
  }
  return lines;
}

// As many names as fit in `budget` bytes, then "and N more", so a big named poll stays one line.
function namesWithin(names: string[], budget: number): string {
  const shown: string[] = [];
  for (let n = 0; n < names.length; n++) {
    const rest = names.length - n - 1;
    const next = [...shown, names[n]!].join(", ") + (rest ? ` and ${rest} more` : "");
    if (bytes(next) > budget) return `${shown.join(", ")}${shown.length ? " and " : ""}${names.length - shown.length} more`;
    shown.push(names[n]!);
  }
  return shown.join(", ");
}

export function alreadyOpenLines(poll: Poll): string[] {
  return [
    `There is already an open poll here: ${poll.question}`,
    `Vote with @poll 1 to @poll ${poll.options.length}, or close it with @poll close (${poll.creator} or a channel op can close it).`,
  ];
}

// A private vote: from the app's composer (POST /api/polls/vote) or `/msg poll #channel 2` from an IRC
// client. The answer goes only to the voter, so nobody else learns the pick.
export function voteIn(channel: string, nick: string, option: number): string {
  const poll = openPoll(channel);
  if (!poll) return "No open poll here. Start one with @poll Lunch? pizza, sushi, salad";
  const result = vote(poll, nick, option);
  return result.ok ? `Counted: ${result.option}` : result.error;
}
