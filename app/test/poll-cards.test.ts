// Poll cards: the dialog creates a poll through POST /api/polls, the card reads GET /api/polls/:id,
// taps go to POST /api/polls/:id/vote and the card menu closes through POST /api/polls/:id/close.
// Every change goes out as a live "poll" event to the channel's members only.

import "./fixture.ts";

const ORIGIN = "https://slirc.test";
process.env.APP_ORIGIN = ORIGIN;
process.env.SLIRC_HELPERS = "help,remind,poll";

import { createHash } from "node:crypto";
import { beforeAll, beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { subscribe } = await import("../src/live.ts");
const { ensureHelperAccounts, directPollReply, mentionedIn, pollReply } = await import("../src/helper-bot.ts");
const polls = await import("../src/polls.ts");
const { afterNick } = await import("../src/mention.ts");

const sessions: Record<string, string> = {};
function person(nick: string, role = "member") {
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES (?, ?, ?, 'human', 1, 1)").run(nick, `${nick}@example.com`, role);
  sessions[nick] = `poll-cards-${nick}`;
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(createHash("sha256").update(sessions[nick]).digest("hex"), nick, Date.now());
}

const call = (nick: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => app.request(path, {
  method,
  headers: {
    ...(nick ? { Cookie: `slirc_session=${sessions[nick]}` } : {}),
    ...(method === "POST" ? { "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Poll": "1" } : {}),
    ...extra,
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const create = (nick: string, body: Record<string, unknown>) => call(nick, "POST", "/api/polls", { channel: "#lunch", question: "Lunch?", options: ["pizza", "sushi", "salad"], ...body });
const vote = (nick: string, id: number, options: unknown) => call(nick, "POST", `/api/polls/${id}/vote`, { options });
const read = async (nick: string, id: number) => (await call(nick, "GET", `/api/polls/${id}`)).json();

beforeAll(async () => {
  await ensureHelperAccounts();
  person("rita");
  person("sam");
  person("olga");
  person("ada", "admin");
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#lunch', 'olga', 'workspace', 1) ON CONFLICT DO NOTHING").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#lunch', 'rita'), ('#lunch', 'sam'), ('#lunch', 'olga'), ('#lunch', 'ada'), ('#lunch', 'poll')").run();
});

beforeEach(() => {
  db.query("DELETE FROM poll_votes").run();
  db.query("DELETE FROM polls").run();
});

test("the dialog creates a poll and the creator gets the card's state", async () => {
  const response = await create("rita", { multi: false, anonymous: false, closesIn: 3_600_000 });
  expect(response.status).toBe(200);
  const view = await response.json();
  expect(view).toMatchObject({ channel: "#lunch", creator: "rita", question: "Lunch?", multi: false, anonymous: false, voters: 0, mine: [], winners: [], canClose: true, closedAt: null });
  expect(view.options.map((option: { label: string }) => option.label)).toEqual(["pizza", "sushi", "salad"]);
  // The server reads the clock once to check the poll and again to store it, so allow a few ms.
  expect(Math.abs(view.closesAt - view.createdAt - 3_600_000)).toBeLessThanOrEqual(50);
  // "None" means no timer.
  db.query("DELETE FROM polls").run();
  expect((await (await create("rita", { closesIn: null })).json()).closesAt).toBeNull();
});

test("create refuses cross-site, outsiders, bad input and a second open poll", async () => {
  expect((await call("rita", "POST", "/api/polls", { channel: "#lunch", question: "Q?", options: ["a", "b"] }, { Origin: "https://evil.test" })).status).toBe(403);
  expect((await call(null, "POST", "/api/polls", { channel: "#lunch", question: "Q?", options: ["a", "b"] })).status).toBe(401);
  expect((await create("rita", { channel: "#elsewhere" })).status).toBe(404);
  expect((await create("rita", { options: ["only"] })).status).toBe(400);
  expect((await create("rita", { options: ["a", "A"] })).status).toBe(400);
  expect((await create("rita", { question: " " })).status).toBe(400);
  expect((await create("rita", { closesIn: 1_000 })).status).toBe(400);
  expect(db.query("SELECT COUNT(*) AS n FROM polls").get()).toEqual({ n: 0 });
  expect((await create("rita", {})).status).toBe(200);
  const second = await create("sam", { question: "Tea?" });
  expect(second.status).toBe(409);
  expect((await second.json()).error).toContain("Lunch?");
});

test("vote, change and unvote in a one-answer poll", async () => {
  const { id } = await (await create("rita", {})).json();
  expect((await (await vote("sam", id, [1])).json()).mine).toEqual([1]);
  const changed = await (await vote("sam", id, [3])).json();
  expect(changed.mine).toEqual([3]);
  expect(changed.options.map((option: { count: number }) => option.count)).toEqual([0, 0, 1]);
  expect((await vote("sam", id, [1, 2])).status).toBe(400);
  const back = await (await vote("sam", id, [])).json();
  expect(back).toMatchObject({ mine: [], voters: 0 });
  expect((await vote("sam", id, [4])).status).toBe(400);
  expect((await vote("sam", id, "1")).status).toBe(400);
});

test("a poll with multiple answers counts each pick and each person once", async () => {
  const { id } = await (await create("rita", { multi: true })).json();
  await vote("sam", id, [1, 3]);
  const view = await (await vote("rita", id, [3])).json();
  expect(view.options.map((option: { count: number }) => option.count)).toEqual([1, 0, 2]);
  expect(view.voters).toBe(2);
  expect((await read("sam", id)).mine).toEqual([1, 3]);
  // A typed vote adds to the picks instead of moving them.
  directPollReply("sam", "#lunch 2");
  expect((await read("sam", id)).mine).toEqual([1, 2, 3]);
});

test("named polls list voters with times; anonymous polls never send identities", async () => {
  const named = await (await create("rita", { anonymous: false })).json();
  await vote("sam", named.id, [2]);
  const shown = await read("rita", named.id);
  expect(shown.options[1].voters).toEqual([{ nick: "sam", at: expect.any(Number) }]);
  await call("rita", "POST", `/api/polls/${named.id}/close`, {});

  const secret = await (await create("rita", { anonymous: true })).json();
  await vote("sam", secret.id, [2]);
  await vote("olga", secret.id, [2]);
  const response = await call("rita", "GET", `/api/polls/${secret.id}`);
  const raw = await response.text();
  expect(raw).not.toContain("sam");
  expect(raw).not.toContain("olga");
  const view = JSON.parse(raw);
  expect(view.anonymous).toBe(true);
  expect(view.options[1]).toEqual({ label: "sushi", count: 2 });
  // The voter still sees their own pick.
  expect((await read("sam", secret.id)).mine).toEqual([2]);
});

test("only the creator, an admin or the channel owner can close, and a closed poll takes no votes", async () => {
  let { id } = await (await create("rita", {})).json();
  await vote("sam", id, [2]);
  expect((await read("sam", id)).canClose).toBe(false);
  expect((await call("sam", "POST", `/api/polls/${id}/close`, {})).status).toBe(403);
  const closed = await (await call("rita", "POST", `/api/polls/${id}/close`, {})).json();
  expect(closed).toMatchObject({ winners: [2], canClose: false });
  expect(closed.closedAt).toBeNumber();
  expect((await vote("sam", id, [1])).status).toBe(409);

  ({ id } = await (await create("rita", {})).json());
  expect((await read("ada", id)).canClose).toBe(true);
  expect((await call("ada", "POST", `/api/polls/${id}/close`, {})).status).toBe(200);
  ({ id } = await (await create("rita", {})).json());
  expect((await call("olga", "POST", `/api/polls/${id}/close`, {})).status).toBe(200);
});

test("outsiders and signed-out callers cannot read or vote", async () => {
  const { id } = await (await create("rita", {})).json();
  person("zed");
  expect((await call("zed", "GET", `/api/polls/${id}`)).status).toBe(404);
  expect((await vote("zed", id, [1])).status).toBe(404);
  expect((await call(null, "GET", `/api/polls/${id}`)).status).toBe(401);
  expect((await call("rita", "GET", "/api/polls/99999")).status).toBe(404);
  expect((await call("rita", "POST", `/api/polls/${id}/vote`, { options: [1] }, { "X-Slirc-Poll": "" })).status).toBe(403);
});

test("votes and closes reach channel members live, and nobody else", async () => {
  // olga creates: rita has used up her ten polls a minute in the tests above.
  const { id } = await (await create("olga", {})).json();
  const heard: Record<string, unknown[]> = { rita: [], zed: [] };
  const stops = ["rita", "zed"].map((nick) => subscribe(nick, (event, data) => { if (event === "poll") heard[nick].push(data); }));
  try {
    await vote("sam", id, [1]);
    directPollReply("olga", "#lunch 2");
    await call("olga", "POST", `/api/polls/${id}/close`, {});
  } finally {
    for (const stop of stops) stop();
  }
  expect(heard.rita).toEqual([{ id, channel: "#lunch" }, { id, channel: "#lunch" }, { id, channel: "#lunch" }]);
  expect(heard.zed).toEqual([]);
});

test("question and options stay on one line and within IRC's line size", async () => {
  // A line break would add a fake numbered line to the announcement IRC clients read.
  expect((await create("olga", { question: "Lunch?\r\n4. free beer" })).status).toBe(400);
  expect((await create("olga", { options: ["pizza", "sushi\n9. fake"] })).status).toBe(400);
  // 200 emoji are under 200 characters but 800 bytes, past what Ergo relays in one line.
  const emoji = await create("olga", { question: "😀".repeat(100) });
  expect(emoji.status).toBe(400);
  expect((await emoji.json()).error).toContain("question");
  expect(polls.parsePoll(`${"😀".repeat(100)}? a, b`)).toMatchObject({ error: expect.stringContaining("question") });
  expect(db.query("SELECT COUNT(*) AS n FROM polls").get()).toEqual({ n: 0 });
});

test("a poll past its closing time takes no votes, reads as closed and frees the channel", async () => {
  const parsed = polls.checkPoll({ question: "Old?", options: ["a", "b"], closesIn: 60_000 }, Date.now() - 120_000);
  if ("error" in parsed) throw new Error(parsed.error);
  const poll = polls.createPoll("#lunch", "rita", parsed, Date.now() - 120_000);
  db.query("INSERT INTO poll_votes (poll_id, nick, option, voted_at) VALUES (?, 'sam', 2, 1)").run(poll.id);
  expect((await vote("rita", poll.id, [1])).status).toBe(409);
  expect(directPollReply("rita", "#lunch 1")).toStartWith("No open poll here");
  const view = await read("rita", poll.id);
  expect(view).toMatchObject({ closedAt: poll.closes_at, winners: [2], canClose: false });
  // The helper may be offline and never post the result; a new poll can still start.
  expect((await create("olga", {})).status).toBe(200);
});

test("a vote made with a poll read before it closed is refused", () => {
  const parsed = polls.checkPoll({ question: "Race?", options: ["a", "b"] });
  if ("error" in parsed) throw new Error(parsed.error);
  const stale = polls.createPoll("#lunch", "rita", parsed);
  polls.closePoll(stale);
  expect(polls.setVotes(stale, "sam", [1])).toEqual({ ok: false, error: "That poll is closed." });
  expect(polls.vote(stale, "sam", 1)).toEqual({ ok: false, error: "That poll is closed." });
  expect(db.query("SELECT COUNT(*) AS n FROM poll_votes").get()).toEqual({ n: 0 });
});

test("a member whose nick has capitals still hears live votes", async () => {
  person("tess");
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#lunch', 'Tess')").run();
  const parsed = polls.checkPoll({ question: "Case?", options: ["a", "b"] });
  if ("error" in parsed) throw new Error(parsed.error);
  const poll = polls.createPoll("#lunch", "rita", parsed);
  const heard: unknown[] = [];
  const stop = subscribe("Tess", (event, data) => { if (event === "poll") heard.push(data); });
  try { directPollReply("sam", "#lunch 1"); } finally { stop(); }
  expect(heard).toEqual([{ id: poll.id, channel: "#lunch" }]);
});

test("in a room the poll helper answers only @poll, never the bare word", () => {
  expect(mentionedIn("poll", "poll-cards sync check 204926")).toBe(false);
  expect(mentionedIn("poll", "polling is fun")).toBe(false);
  const text = "@poll lunch? pizza, sushi";
  expect(mentionedIn("poll", text)).toBe(true);
  expect(polls.parsePoll(afterNick(text, "poll"))).toMatchObject({ question: "lunch?", options: ["pizza", "sushi"] });
  // Other helpers keep the IRC habit of answering their bare name.
  expect(mentionedIn("remind", "remind: in 20m stretch")).toBe(true);
});

test("a refused poll from an IRC client gets one line with what went wrong and an example", () => {
  const reply = pollReply("poll", "rita", "#refused", "lunch", false);
  expect(reply).toEqual({ lines: [`A poll needs at least 2 options, separated by commas or "or". Try: @poll ${polls.POLL_EXAMPLE}`], addressed: true });
  // Addressed to the asker, it stays inside one IRC line with a long nick and channel around it.
  expect(Buffer.byteLength(`@${"n".repeat(30)} ${reply.lines[0]}`)).toBeLessThan(polls.LINE_BYTES);
  expect(pollReply("poll", "rita", "#refused", "Lunch? a, b for 1 fortnight", false).lines[0]).not.toContain("Try: @poll");
});
