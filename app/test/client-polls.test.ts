// Poll cards on the client: which lines become cards, which tallies hide, what a tap sends, and how a
// live "poll" event redraws a card another person is looking at.
import { expect, test } from "bun:test";
import { eventsFromBatch } from "@client/sync.ts";
import { cardPollId, createPolls, draftPayload, isPollTally, moveItem, nextPicks, optimistic, pollHint, pollMark, pollPrefill, share, type PollView } from "@client/polls.ts";
import type { Message } from "@client/model.ts";

const line = (text: string, extra: Record<string, string> = {}, prefix = "poll!poll@h") => ({ kind: "line" as const, message: {
  tags: { batch: "ml", ...extra }, prefix, command: "PRIVMSG", params: ["#lunch", text],
} });

test("a tagged multiline announcement and a tagged tally carry their poll, live and from history", () => {
  const announcement = { id: "ml", type: "draft/multiline", params: ["#lunch"], tags: { msgid: "srv-1", "+slirc/poll": "7", time: "2026-11-17T12:00:00.000Z" }, complete: true,
    items: [line("Poll by rita: Lunch?"), line("1. pizza"), line("2. sushi"), line("Vote with @poll 1, @poll 2 and so on.")] };
  const [live] = eventsFromBatch("room", announcement as any) as { message: Message }[];
  expect(live!.message.poll).toEqual({ id: 7, kind: "card" });
  expect(live!.message.text).toStartWith("Poll by rita: Lunch?\n1. pizza");
  const tally = { kind: "line" as const, message: { tags: { msgid: "srv-2", "+slirc/poll-tally": "7", time: "2026-11-17T12:05:00.000Z" }, prefix: "poll!poll@h", command: "PRIVMSG", params: ["#lunch", "Poll closed: Lunch? (2 votes)"] } };
  const history = eventsFromBatch("room", { id: "h", type: "chathistory", params: ["#lunch"], tags: {}, complete: true, items: [{ kind: "batch", batch: announcement }, tally] } as any) as { message: Message }[];
  expect(history.map((event) => event.message.poll)).toEqual([{ id: 7, kind: "card" }, { id: 7, kind: "tally" }]);
  // Junk ids are not a poll.
  expect(pollMark({ "+slirc/poll": "7;drop" })).toBeUndefined();
  expect(pollMark({ "+slirc/poll": "" })).toBeUndefined();
});

test("only the poll helper's own tagged lines become cards or hide as tallies", () => {
  expect(cardPollId({ authorNick: "poll", poll: { id: 3, kind: "card" } })).toBe(3);
  expect(cardPollId({ authorNick: "Poll", poll: { id: 3, kind: "card" } })).toBe(3);
  expect(cardPollId({ authorNick: "rita", poll: { id: 3, kind: "card" } })).toBeNull();
  expect(cardPollId({ authorNick: "poll", poll: { id: 3, kind: "tally" } })).toBeNull();
  expect(cardPollId({ authorNick: "poll" })).toBeNull();
  expect(isPollTally({ authorNick: "poll", poll: { id: 3, kind: "tally" } })).toBe(true);
  expect(isPollTally({ authorNick: "rita", poll: { id: 3, kind: "tally" } })).toBe(false);
  expect(isPollTally({ authorNick: "poll", poll: { id: 3, kind: "card" } })).toBe(false);
});

const view = (extra: Partial<PollView> = {}): PollView => ({
  id: 7, channel: "#lunch", creator: "rita", question: "Lunch?", multi: false, anonymous: false, createdAt: 0, closesAt: null, closedAt: null,
  options: [{ label: "pizza", count: 1, voters: [{ nick: "sam", at: 1 }] }, { label: "sushi", count: 0, voters: [] }], voters: 1, mine: [], winners: [], canClose: false, ...extra,
});

test("a tap votes, changes, or takes the vote back; with multiple answers it toggles", () => {
  expect(nextPicks({ multi: false, mine: [] }, 2)).toEqual([2]);
  expect(nextPicks({ multi: false, mine: [1] }, 2)).toEqual([2]);
  expect(nextPicks({ multi: false, mine: [2] }, 2)).toEqual([]);
  expect(nextPicks({ multi: true, mine: [3] }, 1)).toEqual([1, 3]);
  expect(nextPicks({ multi: true, mine: [1, 3] }, 3)).toEqual([1]);
  const after = optimistic(view(), [2], "ana");
  expect(after.options.map((option) => option.count)).toEqual([1, 1]);
  expect(after.options[1]!.voters!.map((voter) => voter.nick)).toEqual(["ana"]);
  expect(after).toMatchObject({ mine: [2], voters: 2 });
  expect(optimistic(after, [], "ana")).toMatchObject({ mine: [], voters: 1 });
  expect(share({ voters: 4 }, { count: 1 })).toBe(25);
  expect(share({ voters: 0 }, { count: 0 })).toBe(0);
});

test("the hint names the kind of answer and the time left", () => {
  expect(pollHint(view())).toBe("Select one");
  expect(pollHint(view({ multi: true, closesAt: 2 * 3_600_000 }), 0)).toBe("Select one or more · Closes in 2 hours");
  expect(pollHint(view({ closesAt: 90_000 }), 0)).toBe("Select one · Closes in 2 minutes");
  expect(pollHint(view({ closesAt: 3_600_000 - 500 }), 0)).toBe("Select one · Closes in 1 hour");
  expect(pollHint(view({ closesAt: 86_400_000 - 500 }), 0)).toBe("Select one · Closes in 1 day");
  expect(pollHint(view({ closedAt: 5, voters: 3 }))).toBe("Closed · 3 votes");
  expect(pollHint(view({ closesAt: 1_000 }), 2_000)).toBe("Select one · Closing");
});

test("the dialog sends trimmed options and reorders them", () => {
  expect(draftPayload(" Lunch? ", [{ key: 1, text: " pizza " }, { key: 2, text: "" }, { key: 3, text: "sushi" }])).toEqual({ question: "Lunch?", options: ["pizza", "sushi"] });
  expect(draftPayload("Lunch?", [{ key: 1, text: "pizza" }, { key: 2, text: " " }])).toBeNull();
  expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
});

test("a live poll event redraws a card this tab shows, and a vote posts the whole choice", async () => {
  let server = view();
  const calls: { url: string; body?: string }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    if (url.endsWith("/vote")) server = { ...server, mine: [2], options: [server.options[0]!, { label: "sushi", count: 1, voters: [{ nick: "ana", at: 2 }] }], voters: 2 };
    return new Response(JSON.stringify(server), { status: 200 });
  }) as unknown as typeof fetch;
  const polls = createPolls((value) => value, { enabled: () => true, me: () => "ana", wireFor: () => "#lunch", composerChannel: () => "#lunch", nextTick: async () => {}, fetch: fake });
  const message = { id: "m", conversationId: "room", authorNick: "poll", authorAccount: "poll", text: "", time: "", state: "confirmed", poll: { id: 7, kind: "card" } } as Message;
  expect(polls.card(message)).toBe("loading");
  await Bun.sleep(0);
  expect((polls.card(message) as PollView).options[0]!.count).toBe(1);

  // Someone else voted: the live event names the poll and this tab reads it again.
  server = { ...server, options: [{ label: "pizza", count: 2, voters: [{ nick: "sam", at: 1 }, { nick: "bo", at: 3 }] }, server.options[1]!], voters: 2 };
  polls.changed(7);
  await Bun.sleep(0);
  expect((polls.card(message) as PollView).options[0]!.count).toBe(2);
  // A poll this tab never showed is not fetched.
  polls.changed(99);
  expect(calls.some((call) => call.url === "/api/polls/99")).toBe(false);

  await polls.vote(polls.card(message) as PollView, 2);
  expect(calls.at(-1)).toEqual({ url: "/api/polls/7/vote", body: JSON.stringify({ options: [2] }) });
  expect((polls.card(message) as PollView).mine).toEqual([2]);

  // A card in another channel's transcript, or with polls off, stays plain text.
  const elsewhere = createPolls((value) => value, { enabled: () => true, me: () => "ana", wireFor: () => "#other", composerChannel: () => null, nextTick: async () => {}, fetch: fake });
  elsewhere.card(message);
  await Bun.sleep(0);
  expect(elsewhere.card(message)).toBeNull();
  const off = createPolls((value) => value, { enabled: () => false, me: () => "ana", wireFor: () => "#lunch", composerChannel: () => "#lunch", nextTick: async () => {}, fetch: fake });
  expect(off.card(message)).toBeNull();
});

test("a closing tally hides only while its card draws", async () => {
  const fake = (async () => new Response(JSON.stringify(view()), { status: 200 })) as unknown as typeof fetch;
  const tally = { id: "t", conversationId: "room", authorNick: "poll", authorAccount: "poll", text: "Poll closed: Lunch?", time: "", state: "confirmed", poll: { id: 7, kind: "tally" } } as Message;
  const card = { ...tally, id: "m", poll: { id: 7, kind: "card" } } as Message;
  const polls = createPolls((value) => value, { enabled: () => true, me: () => "ana", wireFor: () => "#lunch", composerChannel: () => "#lunch", nextTick: async () => {}, fetch: fake });
  // The announcement isn't loaded (scrolled out of history, say): the tally is the result shown.
  expect(polls.hidesTally(tally)).toBe(false);
  polls.card(card);
  await Bun.sleep(0);
  expect(polls.hidesTally(tally)).toBe(true);
  const missing = createPolls((value) => value, { enabled: () => true, me: () => "ana", wireFor: () => "#lunch", composerChannel: () => "#lunch", nextTick: async () => {}, fetch: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch });
  missing.card(card);
  await Bun.sleep(0);
  expect(missing.hidesTally(tally)).toBe(false);
  const off = createPolls((value) => value, { enabled: () => false, me: () => "ana", wireFor: () => "#lunch", composerChannel: () => "#lunch", nextTick: async () => {}, fetch: fake });
  expect(off.hidesTally(tally)).toBe(false);
});

test("a typed poll the helper would refuse opens the dialog with what parsed, at the field to fix", () => {
  expect(pollPrefill("@poll lunch")).toEqual({ question: "lunch", options: [], closesIn: null, hint: "Add at least two options.", focus: 0 });
  expect(pollPrefill("/poll lunch")).toBeNull();
  expect(pollPrefill("@poll Lunch? pizza")).toMatchObject({ question: "Lunch?", options: ["pizza"], focus: 1 });
  expect(pollPrefill("@poll Lunch? pizza, sushi, Pizza for 1h")).toMatchObject({ options: ["pizza", "sushi", "Pizza"], closesIn: 3_600_000, hint: "Each option has to be different.", focus: 2 });
  expect(pollPrefill(`@poll Lunch? pizza, ${"a".repeat(81)}`)).toMatchObject({ hint: expect.stringContaining("80"), focus: 1 });
  expect(pollPrefill(`@poll ${"q".repeat(201)}? a, b`)).toMatchObject({ hint: expect.stringContaining("200"), focus: "question" });
  expect(pollPrefill("@poll Lunch? a, b for 1 fortnight")).toMatchObject({ options: ["a", "b"], hint: expect.stringContaining("duration"), focus: "closes" });
  expect(pollPrefill("@poll Lunch? a for 2d")).toMatchObject({ options: ["a"], closesIn: null });
  // Bare @poll opens the dialog empty; the helper's other commands and a valid poll still send.
  expect(pollPrefill("@poll")).toEqual({ question: "", options: [], closesIn: null, hint: "", focus: "question" });
  for (const text of ["@poll Lunch? pizza, sushi", "@poll pizza or sushi?", "@poll help", "@poll results", "@poll close", "@poll 2", "@pollster lunch", "lunch @poll"]) expect(pollPrefill(text)).toBeNull();
});

test("the dialog opens prefilled and puts the cursor on the first field to fix", async () => {
  const focused: string[] = [];
  const field = (name: string) => ({ focus: () => focused.push(name) });
  Object.assign(globalThis, {
    HTMLElement: class {},
    document: { activeElement: null, querySelector: (selector: string) => field(selector), querySelectorAll: () => [field("option 0"), field("option 1")] },
  });
  try {
    const polls = createPolls((value) => value, { enabled: () => true, me: () => "ana", wireFor: () => "#lunch", composerChannel: () => "#lunch", nextTick: async (callback) => callback?.() });
    polls.openDialog(null, pollPrefill("@poll lunch")!);
    expect(polls.dialogOpen).toBe(true);
    expect(polls.question).toBe("lunch");
    expect(polls.options.map((option) => option.text)).toEqual(["", ""]);
    expect(polls.error).toBe("Add at least two options.");
    expect(focused).toEqual(["option 0"]);
    polls.closeDialog();
    polls.openDialog(null, pollPrefill("@poll Lunch? pizza, sushi, pizza")!);
    expect(polls.options.map((option) => option.text)).toEqual(["pizza", "sushi", "pizza"]);
    polls.closeDialog();
    polls.openDialog(null);
    expect([polls.question, polls.error, polls.options.length]).toEqual(["", "", 2]);
    expect(focused.at(-1)).toBe("#poll-question");
  } finally {
    delete (globalThis as any).document;
    delete (globalThis as any).HTMLElement;
  }
});
