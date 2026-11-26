// Private poll votes: `@poll 2` in the app goes to POST /api/polls/vote and `/msg poll #room 2` from
// an IRC client goes to the helper's own nick. Neither posts in the channel.

import "./fixture.ts";

const ORIGIN = "https://slirc.test";
process.env.APP_ORIGIN = ORIGIN;
process.env.SLIRC_HELPERS = "help,remind,poll";

import { createHash } from "node:crypto";
import { beforeAll, beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const polls = await import("../src/polls.ts");
const { directPollReply, ensureHelperAccounts } = await import("../src/helper-bot.ts");
const { hiddenCommands } = await import("../client/commands.ts");

const token = "poll-route-session";
const post = (body: unknown, extra: Record<string, string> = {}) => app.request("/api/polls/vote", {
  method: "POST",
  headers: { Cookie: `slirc_session=${token}`, "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Poll": "1", ...extra },
  body: JSON.stringify(body),
});
const ballots = () => db.query("SELECT nick, option FROM poll_votes").all();

beforeAll(() => {
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('rita', 'rita@example.com', 'member', 'human', 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'rita', ?)").run(createHash("sha256").update(token).digest("hex"), Date.now());
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#lunch', 'rita'), ('#lunch', 'poll')").run();
});

beforeEach(() => {
  db.query("DELETE FROM poll_votes").run();
  db.query("DELETE FROM polls").run();
  const parsed = polls.parsePoll("Lunch? pizza, sushi");
  if ("error" in parsed) throw new Error(parsed.error);
  polls.createPoll("#lunch", "ana", parsed);
  polls.createPoll("#secret", "ana", parsed);
});

test("a vote from the app is counted and only the voter gets the answer", async () => {
  const response = await post({ channel: "#Lunch", option: 2 });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ reply: "Counted: sushi" });
  expect(ballots()).toEqual([{ nick: "rita", option: 2 }]);
});

test("cross-site, signed-out, outsider and malformed votes are refused before anything is stored", async () => {
  expect((await post({ channel: "#lunch", option: 1 }, { Origin: "https://evil.test" })).status).toBe(403);
  expect((await post({ channel: "#lunch", option: 1 }, { "X-Slirc-Poll": "" })).status).toBe(403);
  expect((await post({ channel: "#lunch", option: 1 }, { Cookie: "" })).status).toBe(401);
  expect((await post({ channel: "#secret", option: 1 })).status).toBe(403);
  expect((await post({ channel: "#lunch", option: "1" })).status).toBe(400);
  expect((await post({ channel: "lunch", option: 1 })).status).toBe(400);
  expect(ballots()).toEqual([]);
});

test("an instance without the poll helper refuses votes and hides /poll", async () => {
  process.env.SLIRC_HELPERS = "help,remind";
  try {
    expect((await post({ channel: "#lunch", option: 1 })).status).toBe(503);
  } finally {
    process.env.SLIRC_HELPERS = "help,remind,poll";
  }
  expect(hiddenCommands(["help", "remind"])).toContain("poll");
  expect(hiddenCommands(["help", "remind", "poll"])).not.toContain("poll");
});

test("/msg poll votes in a channel the sender is in, and only hints otherwise", () => {
  expect(directPollReply("rita", "#lunch 1")).toBe("Counted: pizza");
  expect(directPollReply("Rita", "@poll #LUNCH 2")).toBe("Counted: sushi");
  expect(ballots()).toEqual([{ nick: "rita", option: 2 }]);
  expect(directPollReply("rita", "#secret 1")).toBe("You are not in that channel.");
  expect(directPollReply("rita", "Lunch? pizza, sushi")).toStartWith("Polls run in channels");
  expect(db.query("SELECT COUNT(*) n FROM polls WHERE channel = 'rita'").get()).toEqual({ n: 0 });
});

test("a person who already has a helper's nick keeps it, and the helper stays off", async () => {
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('poll', 'poll@example.com', 'member', 'human', 1, 1)").run();
  await ensureHelperAccounts();
  expect(db.query("SELECT kind, irc_password_gen FROM accounts WHERE nick = 'poll'").get()).toEqual({ kind: "human", irc_password_gen: null });
  expect(db.query("SELECT kind FROM accounts WHERE nick = 'remind'").get()).toEqual({ kind: "bot" });
});

test("someone signing up with a helper name gets another nick, so turning that helper on later never collides", async () => {
  const { provisionAccount } = await import("../src/accounts.ts");
  // welcome does not run here and has no account, so only the reservation keeps the name free. A
  // reserved name starts the nick from "member", so nobody gets a lookalike such as welcome2.
  const account = await provisionAccount("Welcome", "welcome.person@example.com");
  expect(account.nick).toMatch(/^member\d*$/);
});
