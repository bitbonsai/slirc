// Job cards on the client: which messages become cards, how the tidy text reads into rows, and the
// card's tabs and "Show more" state.
import { expect, test } from "bun:test";
import { eventsFromBatch } from "@client/sync.ts";
import { createJobCards, FIRST_ROWS, isBotRow, jobsDay, jobsMark, parseJobs, visibleJobs } from "@client/job-cards.ts";
import type { Message } from "@client/model.ts";

const NB = String.fromCharCode(0xa0);
const TEXT = [
  "**8 new remote jobs** open to Europe, via [Himalayas](https://himalayas.app)",
  "**Engineering**",
  `• 🇵🇹 [Senior Front-End Developer (Angular)](https://himalayas.app/a) · Imaginary Cloud · Portugal \`EUR${NB}35‑54k\``,
  "• 🇪🇺 [Staff Engineer, Platform & Infra](https://himalayas.app/b) · RemoteJobsOne · FR, DE, NL, UK `USD 350‑500k`",
  "• 🇪🇺 [Software Engineer II](https://himalayas.app/c) · Ookla · Europe",
  "• 🇸🇰 [DevOps Engineer](https://himalayas.app/d) · Deutsche Telekom · Slovakia `EUR 3.8k / mo`",
  "• 🇩🇪 [Solution Architect](https://himalayas.app/e) · NVIDIA · Germany, Poland",
  "**Design**",
  "• 🇪🇺 [Head of Design](https://himalayas.app/f) · Hospitable · Europe",
  "• 🌍 [Product Designer](https://himalayas.app/g) · Acme · Worldwide",
  "**Product**",
  "• 🇩🇪 [Product Manager](https://himalayas.app/h) · Synera · Germany",
  "[170 more on Himalayas](https://himalayas.app/jobs) · also lennysjobs.com and weworkremotely.com",
].join("\n");
const MARK = { day: "2026-11-20", logos: ["https://cdn.example/a.png", "", "http://plain.example/c.png"] };

const message = (over: Partial<Message> = {}): Message => ({ id: "m1", conversationId: "room", authorAccount: "jobs", authorNick: "jobs", text: TEXT, time: "2026-11-20T09:00:00.000Z", state: "confirmed", jobs: MARK, ...over });

test("a tagged multiline digest carries its day and logos, live and from history", () => {
  const line = (text: string) => ({ kind: "line" as const, message: { tags: { batch: "ml" }, prefix: "jobs!jobs@h", command: "PRIVMSG", params: ["#jobs", text] } });
  const batch = { id: "ml", type: "draft/multiline", params: ["#jobs"], tags: { msgid: "srv-1", time: "2026-11-20T09:00:00.000Z", "+slirc/jobs": "2026-11-20", "+slirc/jobs-logos": "https://cdn.example/a.png,,https://cdn.example/b%2Cc.png" }, complete: true, items: TEXT.split("\n").map(line) };
  const [live] = eventsFromBatch("room", batch as any) as { message: Message }[];
  expect(live!.message.jobs).toEqual({ day: "2026-11-20", logos: ["https://cdn.example/a.png", "", "https://cdn.example/b%2Cc.png"] });
  expect(live!.message.text).toBe(TEXT);
  const [replayed] = eventsFromBatch("room", { id: "h", type: "chathistory", params: ["#jobs"], tags: {}, complete: true, items: [{ kind: "batch", batch }] } as any) as { message: Message }[];
  expect(replayed!.message.jobs?.day).toBe("2026-11-20");
  expect(jobsMark({ "+slirc/jobs": "today" })).toBeUndefined();
  expect(jobsMark({ "+slirc/jobs": "2026-11-20", "+slirc/jobs-logos": "javascript:alert(1),https://ok.example/x" })).toEqual({ day: "2026-11-20", logos: ["", "https://ok.example/x"] });
});

test("the tidy text reads into grouped rows, with logos through the image proxy", () => {
  const view = parseJobs(TEXT, MARK)!;
  expect(view.summary).toBe("8 new remote jobs open to Europe");
  expect(view.groups).toEqual([{ name: "Engineering", count: 5 }, { name: "Design", count: 2 }, { name: "Product", count: 1 }]);
  expect(view.jobs[0]).toEqual({ group: "Engineering", flag: "🇵🇹", title: "Senior Front-End Developer (Angular)", url: "https://himalayas.app/a", company: "Imaginary Cloud", where: "Portugal", salary: `EUR${NB}35‑54k`, logo: "/api/embed/image?url=https%3A%2F%2Fcdn.example%2Fa.png", letter: "I" });
  // No logo, or one that isn't https, gets the letter tile; no salary stays empty.
  expect(view.jobs.slice(1, 3).map((job) => [job.logo, job.letter, job.salary])).toEqual([["", "R", "USD 350‑500k"], ["", "O", ""]]);
  expect(view.jobs[4]!.where).toBe("Germany, Poland");
  expect(view.more).toEqual({ label: "170 more on Himalayas", url: "https://himalayas.app/jobs" });
  expect(view.boards).toEqual([{ label: "lennysjobs.com", url: "https://lennysjobs.com" }, { label: "weworkremotely.com", url: "https://weworkremotely.com" }]);
});

test("text the card can't read stays text", () => {
  expect(parseJobs("**3 new jobs**\nhello\n[More](https://x.example)", MARK)).toBeNull();
  // A job before any area heading, or one linking anywhere but https.
  expect(parseJobs(["**1 new job**", "• 🇩🇪 [A](https://x.example/a) · B · Germany", "[More](https://x.example)"].join("\n"), MARK)).toBeNull();
  expect(parseJobs(["**1 new job**", "**Engineering**", "• 🇩🇪 [A](javascript:alert(1)) · B · Germany", "[More](https://x.example)"].join("\n"), MARK)).toBeNull();
  expect(parseJobs(["**1 new job**", "**Engineering**", "• 🇩🇪 [A](https://x.example/a) · B · Germany"].join("\n"), MARK)).toBeNull();
});

test("only a bot account's tagged message becomes a card", () => {
  const rows = [{ nick: "jobs", kind: "bot" }, { nick: "rita", kind: "human" }, { nick: "rita-agent", kind: "agent" }];
  const cards = createJobCards((value) => value, { isBot: (nick) => isBotRow(rows, nick) });
  expect(cards.card(message())?.jobs.length).toBe(8);
  expect(cards.card(message({ authorAccount: "JOBS", authorNick: "JOBS" }))).not.toBeNull();
  expect(cards.card(message({ id: "m2", authorAccount: "rita", authorNick: "rita" }))).toBeNull();
  expect(cards.card(message({ id: "m3", authorAccount: "rita-agent", authorNick: "rita-agent" }))).toBeNull();
  // A person can't borrow the bot's nick: the account decides.
  expect(cards.card(message({ id: "m4", authorAccount: "rita", authorNick: "jobs" }))).toBeNull();
  expect(cards.card(message({ id: "m5", jobs: undefined }))).toBeNull();
  expect(cards.card(message({ id: "m6", deleted: true }))).toBeNull();
  expect(isBotRow([], "jobs")).toBe(false);
});

test("tabs filter the rows and Show more opens the rest", () => {
  const view = parseJobs(TEXT, MARK)!;
  expect(visibleJobs(view, "", false)).toMatchObject({ hidden: 8 - FIRST_ROWS });
  expect(visibleJobs(view, "", false).rows.length).toBe(FIRST_ROWS);
  expect(visibleJobs(view, "", true)).toMatchObject({ hidden: 0 });
  expect(visibleJobs(view, "Design", false).rows.map((job) => job.title)).toEqual(["Head of Design", "Product Designer"]);
  const cards = createJobCards((value) => value, { isBot: () => true });
  const m = message();
  expect(cards.tab(m)).toBe("");
  cards.pick(m, "Product");
  expect(cards.rows(m, view).rows.map((job) => job.title)).toEqual(["Product Manager"]);
  cards.pick(m, "");
  cards.expand(m);
  expect(cards.rows(m, view).rows.length).toBe(8);
  cards.reset();
  expect(cards.tab(m)).toBe("");
  expect(jobsDay("2026-11-20")).toMatch(/20/);
});
