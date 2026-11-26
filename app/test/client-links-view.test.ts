// The Links view component: which channels open on it, what Enter does, and that a reply for an
// older query never lands.
import { expect, test } from "bun:test";
import { AUTO_ROWS, createLinksView, groupByDay, hostOf, keepUnchanged } from "../client/links-view.ts";

const facets = { total: 2, topics: [{ value: "agents", count: 1 }], sources: [], origins: [], sharers: [{ value: "ada", count: 1 }], years: [], week: 0, month: 0 };
const row = (id: number, title: string) => ({ id, url: `https://example.com/${id}`, title, summary: "", author: "", source: "web", topics: [], origins: [], firstSharedAt: 1, lastSharedAt: 1, shareCount: 1, sharedBy: "ada", private: null, canRemove: true });

function setup(options: { delay?: (url: string) => number; marker?: number } = {}) {
  const requests: string[] = [];
  const posted: string[] = [];
  let address = "";
  const core = { channel: "#links", direct: false, activeThread: null as unknown, linksHome: "#links", linksChannels: ["#links", "#general"], authenticated: true };
  const fetcher = (async (input: any, init?: any) => {
    const url = String(input);
    requests.push(`${init?.method || "GET"} ${url}`);
    const wait = options.delay?.(url) ?? 0;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (url.startsWith("/api/links/facets")) return Response.json(facets);
    if (url.startsWith("/api/links/lookup")) return Response.json({ link: url.includes("known") ? row(7, "Known") : null });
    if (url.includes("/remove")) return Response.json({ removed: true });
    if (url.endsWith("/copy")) return Response.json({ id: 1, url: "https://example.com/1", title: "Saved title", byline: "A. Writer", text: "# Head\n\n<img src=x onerror=alert(1)> stays text", savedAt: 5, image: false, gone: true, kind: "page" });
    if (url.startsWith("/api/links/topics")) return Response.json({ topics: facets.topics });
    if (url.endsWith("/topics")) { const change = JSON.parse(init.body); return Response.json({ link: { ...row(1, "result for everything"), topics: change.add ? [change.add] : [] } }); }
    const q = new URL(url, "https://x.test").searchParams.get("q") || "";
    return Response.json({ rows: [row(1, `result for ${q || "everything"}`), row(2, "second")], total: 2, more: false });
  }) as unknown as typeof fetch;
  const view = createLinksView((value) => value, {
    core, routed: () => false, post: async (text) => { posted.push(text); }, nextTick: () => {}, fetcher,
    address: { read: () => address, write: (value) => { address = value; } }, now: () => Date.UTC(2026, 10, 11), readMarker: async () => options.marker,
  });
  return { view, core, requests, posted, address: () => address, setAddress: (value: string) => { address = value; } };
}
const settle = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));
const type = (view: any, value: string) => view.onInput({ target: { value } } as any);

test("the home channel opens on Links, other channels on Messages, and the choice is remembered", async () => {
  const { view, core, requests } = setup();
  view.sync();
  expect(view.on).toBe(true);
  await settle(20);
  expect(view.rows.length).toBe(2);
  expect(requests[0]).toBe("GET /api/links?");
  core.channel = "#general";
  view.sync();
  expect(view.on).toBe(false);
  view.show("links");
  expect(view.on).toBe(true);
  await settle(20);
  // Another channel's view asks for that channel only.
  expect(requests.at(-2)).toBe("GET /api/links?channel=%23general");
  core.channel = "#links"; view.sync();
  core.channel = "#general"; view.sync();
  expect(view.on).toBe(true);
  // No helper in the channel, a DM or a thread: no Links view.
  core.channel = "#random"; view.sync();
  expect([view.on, view.available()]).toEqual([false, false]);
  core.channel = "#links"; core.direct = true; view.sync();
  expect(view.on).toBe(false);
});

test("words filter and are never posted; a URL is posted on Enter; a saved one is shown instead", async () => {
  const { view, posted, requests } = setup();
  view.sync();
  await settle(20);
  type(view, "rust");
  await settle();
  expect(view.rows[0].title).toBe("result for rust");
  expect(view.mode()).toBe("search");
  await view.submit();
  expect(posted).toEqual([]);

  type(view, "https://example.com/new a note");
  await settle(20);
  expect(view.mode()).toBe("add");
  // A URL in the box does not run a search.
  expect(requests.at(-1)).toContain("/api/links/lookup?url=");
  await view.submit();
  expect(posted).toEqual(["https://example.com/new a note"]);
  expect(view.query.text).toBe("");
  expect(view.note).toBe("Saving that link…");

  type(view, "https://example.com/known");
  await settle(20);
  expect(view.mode()).toBe("saved");
  await view.submit();
  expect(posted.length).toBe(1);
  expect(view.rows.map((item: any) => item.title)).toEqual(["Known"]);
});

test("a slow reply for an older query never replaces a newer one", async () => {
  const { view } = setup({ delay: (url) => (url.includes("q=slow") ? 120 : 0) });
  view.sync();
  await settle(20);
  type(view, "slow");
  await settle(170);
  type(view, "fast");
  await settle(300);
  expect(view.rows[0].title).toBe("result for fast");
});

test("the query lives in the address, and a pasted address opens the same view", async () => {
  const first = setup();
  first.view.sync();
  await settle(20);
  first.view.toggle("topic", "agents");
  first.view.filterBy("sharer", "ada");
  type(first.view, "evals");
  expect(first.address()).toBe("#agents @ada evals");
  await settle();
  expect(first.requests.at(-2)).toBe("GET /api/links?q=evals&topic=agents&sharer=ada");
  first.view.show("messages");
  expect(first.address()).toBe("");

  const second = setup();
  second.setAddress("#agents @ada evals");
  second.view.sync();
  expect(second.view.query).toEqual({ text: "evals", topics: ["agents"], sharer: "ada", source: "", origin: "", when: "", site: "" });
  expect(second.view.tokens().map((token: any) => token.label)).toEqual(["#agents", "ada"]);
  second.view.openWith("when:2025 mcp");
  expect(second.view.query.when).toBe("2025");
  expect(second.view.query.text).toBe("mcp");
});

test("the read position is taken when the view opens, and a filter hides the line", async () => {
  const { view } = setup({ marker: 1 });
  view.sync();
  await settle(20);
  expect(view.lastHere).toBe(1);
  view.toggle("topic", "agents");
  await settle(20);
  expect(view.days.every((day: any) => day.lastHere === null)).toBe(true);
});

test("the reader opens a saved copy as text, and a row whose original is gone opens it from its main link", async () => {
  const { view, requests } = setup();
  view.sync();
  await settle(20);
  (globalThis as any).document ??= { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} };
  let prevented = 0;
  const click = { preventDefault() { prevented++; } } as any;
  // A live original: the main link goes to the page, not the copy.
  view.mainClick({ ...view.rows[0], copy: true, gone: false }, click);
  view.mainClick({ ...view.rows[0], copy: false, gone: true }, click);
  expect([prevented, view.readerLoading]).toEqual([0, false]);
  view.mainClick({ ...view.rows[0], copy: true, gone: true }, click);
  expect(prevented).toBe(1);
  await settle(30);
  expect(requests.at(-1)).toBe("GET /api/links/1/copy");
  expect(view.reader.title).toBe("Saved title");
  expect(view.reader.gone).toBe(true);
  expect(view.reader.blocks).toEqual([{ kind: "h1", text: "Head" }, { kind: "p", text: "<img src=x onerror=alert(1)> stays text" }]);
  view.closeReader();
  expect(view.reader).toBeNull();
});

test("removing a link takes it off the list", async () => {
  const { view, requests } = setup();
  view.sync();
  await settle(20);
  view.askRemove(view.rows[0]);
  // The dialog element is absent here; the request and the list are what matter.
  (globalThis as any).document ??= { querySelector: () => null };
  await view.confirmRemove();
  expect(requests.at(-1)).toBe("POST /api/links/1/remove");
  expect(view.rows.map((item: any) => item.id)).toEqual([2]);
});

test("editing topics updates the row and the counts in place, without reloading the list", async () => {
  const { view, requests } = setup();
  view.sync();
  await settle(20);
  (globalThis as any).document ??= { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} };
  const before = view.rows.map((item: any) => item.id);
  view.openTopics(view.rows[0]);
  expect(view.editing).toBe(1);
  view.onTopicInput({ target: { value: "ag" } } as any);
  expect(view.topicOptions().map((option: any) => option.label)).toEqual(["#agents", "Create #ag"]);
  const listLoads = requests.filter((request) => request.startsWith("GET /api/links?")).length;
  view.onTopicKeydown({ key: "Enter", preventDefault() {} } as any);
  await settle(30);
  expect(requests).toContain("POST /api/links/1/topics");
  expect(view.rows[0].topics).toEqual(["agents"]);
  expect(view.days[0].rows[0].topics).toEqual(["agents"]);
  expect(view.rows.map((item: any) => item.id)).toEqual(before);
  // Counts came again; the list did not.
  expect(requests.filter((request) => request.startsWith("GET /api/links?")).length).toBe(listLoads);
  expect(requests.filter((request) => request.startsWith("GET /api/links/facets")).length).toBeGreaterThan(1);
  expect(view.editing).toBe(1);
  view.removeTopic(view.rows[0], "agents");
  await settle(30);
  expect(view.rows[0].topics).toEqual([]);
  view.onTopicKeydown({ key: "Escape", preventDefault() {}, stopPropagation() {} } as any);
  expect(view.editing).toBe(0);
});

test("rows sit under day headings newest first, and a search drops the headings", () => {
  const now = Date.UTC(2026, 10, 12, 9);
  const at = (id: number, when: number) => ({ ...row(id, `t${id}`), firstSharedAt: when });
  const rows = [at(1, Date.UTC(2026, 10, 12, 8)), at(2, Date.UTC(2026, 10, 12, 1)), at(3, Date.UTC(2026, 10, 11, 12)), at(4, Date.UTC(2026, 9, 2))];
  expect(groupByDay(rows, false, now).map((day) => [day.heading, day.rows.map((item) => item.id)])).toEqual([["Today", [1, 2]], ["Yesterday", [3]], ["2 Oct", [4]]]);
  expect(groupByDay(rows, true, now).map((day) => [day.heading, day.rows.length])).toEqual([["", 4]]);
  expect(groupByDay([], true, now)).toEqual([]);
  expect(hostOf("https://www.example.com/a")).toBe("example.com");
  expect(hostOf("nope")).toBe("");
});

test("days fold, the last-here line sits at the read position, and newer days are marked new", () => {
  const now = Date.UTC(2026, 10, 12, 9);
  const at = (id: number, when: number) => ({ ...row(id, `t${id}`), firstSharedAt: when });
  const today = Array.from({ length: 9 }, (_, index) => at(100 + index, Date.UTC(2026, 10, 12, 8) - index * 60_000));
  const monday = [at(200, Date.UTC(2026, 10, 9, 12)), at(201, Date.UTC(2026, 10, 9, 11))];
  const rows = [...today, ...monday];
  // Read up to the third link of today.
  const marker = today[2].firstSharedAt;
  const days = groupByDay(rows, false, now, { folding: true, expanded: {}, marker });
  expect(days.map((day) => [day.heading, day.rows.length, day.hidden, day.more, day.isNew, day.lastHere])).toEqual([
    ["Today", 5, 4, "4 more from today", true, 102], ["9 Nov", 2, 0, "", false, null],
  ]);
  // The read position is behind the fold: the line goes after the control.
  expect(groupByDay(rows, false, now, { folding: true, expanded: {}, marker: today[7].firstSharedAt })[0].lastHere).toBe("end");
  // Opened, the day shows whole and the line is on its row again.
  const opened = groupByDay(rows, false, now, { folding: true, expanded: { [days[0].key]: true }, marker: today[7].firstSharedAt })[0];
  expect([opened.rows.length, opened.hidden, opened.lastHere]).toEqual([9, 0, 107]);
  // The boundary at the top of an older day: that day is not new, the one above is.
  const older = groupByDay(rows, false, now, { folding: true, expanded: {}, marker: monday[0].firstSharedAt });
  expect(older.map((day) => [day.isNew, day.lastHere])).toEqual([[true, null], [false, 200]]);
  // No position, nothing new, or a filter on: no line, no fold.
  expect(groupByDay(rows, false, now, { folding: false }).map((day) => [day.rows.length, day.lastHere, day.isNew])).toEqual([[9, null, false], [2, null, false]]);
  expect(groupByDay(rows, false, now, { folding: true, marker: today[0].firstSharedAt }).every((day) => day.lastHere === null && !day.isNew)).toBe(true);
});

test("a new page keeps the days already drawn, and a changed row redraws only its day", () => {
  const now = Date.UTC(2026, 10, 12, 9);
  const at = (id: number, day: number) => ({ ...row(id, `t${id}`), firstSharedAt: Date.UTC(2026, 10, day, 8) - id });
  const first = [at(1, 12), at(2, 12), at(3, 11), at(4, 10)];
  const before = groupByDay(first, false, now, { folding: true });
  // The next page carries on the 10th and adds the 9th.
  const after = keepUnchanged(before, groupByDay([...first, at(5, 10), at(6, 9)], false, now, { folding: true }));
  expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
  expect([after[0] === before[0], after[1] === before[1], after[2] === before[2]]).toEqual([true, true, false]);
  expect(after.map((day) => day.rows.length)).toEqual([2, 1, 2, 1]);
  // A row edited in place is a new object: its day is drawn again, the others are kept.
  const edited = [...first];
  edited[2] = { ...first[2]!, topics: ["agents"] };
  const redrawn = keepUnchanged(before, groupByDay(edited, false, now, { folding: true }));
  expect([redrawn[0] === before[0], redrawn[1] === before[1], redrawn[2] === before[2]]).toEqual([true, false, true]);
  // A read position that arrives later redraws the days whose line or "new" mark changes.
  const marked = keepUnchanged(before, groupByDay(first, false, now, { folding: true, marker: first[2]!.firstSharedAt }));
  expect(marked.map((day) => [day.isNew, day.lastHere])).toEqual([[true, null], [false, 3], [false, null]]);
  expect([marked[0] === before[0], marked[1] === before[1], marked[2] === before[2]]).toEqual([false, false, true]);
});

test("scrolling loads pages up to the cap, the button goes on from there, and a new query starts over", async () => {
  const requests: string[] = [];
  const total = AUTO_ROWS + 120;
  const fetcher = (async (input: any) => {
    const url = new URL(String(input), "https://x.test");
    requests.push(url.pathname + url.search);
    if (url.pathname === "/api/links/facets") return Response.json(facets);
    const offset = Number(url.searchParams.get("offset") || 0);
    const rows = Array.from({ length: Math.max(0, Math.min(50, total - offset)) }, (_, index) => ({ ...row(offset + index + 1, "t"), firstSharedAt: 10_000_000 - offset - index }));
    return Response.json({ rows, total, more: offset + rows.length < total });
  }) as unknown as typeof fetch;
  let address = "";
  const core = { channel: "#links", direct: false, activeThread: null as unknown, linksHome: "#links", linksChannels: ["#links"], authenticated: true };
  const view: any = createLinksView((value) => value, {
    core, routed: () => false, post: async () => {}, nextTick: () => {}, fetcher,
    address: { read: () => address, write: (value) => { address = value; } }, now: () => Date.UTC(2026, 10, 11),
  });
  const bottom = { target: { scrollHeight: 2000, scrollTop: 1500, clientHeight: 400 } } as any;
  const scrollToEnd = async () => { for (let index = 0; index < 30; index++) { view.onScroll(bottom); await settle(1); } };
  view.sync();
  await settle(20);
  await scrollToEnd();
  expect(view.rows.length).toBe(AUTO_ROWS);
  expect([view.more, view.capped(), view.olderLabel()]).toEqual([true, true, "Show older links"]);
  // The button loads the next page; scrolling then carries on to the end.
  await view.showOlder();
  expect(view.rows.length).toBe(AUTO_ROWS + 50);
  expect(view.capped()).toBe(false);
  await scrollToEnd();
  expect([view.rows.length, view.more, view.capped()]).toEqual([total, false, false]);
  // A filter starts again from the first page with the cap back in place.
  view.toggle("topic", "agents");
  await settle();
  expect(view.rows.length).toBe(50);
  expect(view.limit).toBe(AUTO_ROWS);
  expect(requests.at(-1)).toBe("/api/links/facets?topic=agents");
  type(view, "rust ");
  await settle();
  await scrollToEnd();
  expect([view.rows.length, view.capped(), view.olderLabel()]).toEqual([AUTO_ROWS, true, "Show more results"]);
});
