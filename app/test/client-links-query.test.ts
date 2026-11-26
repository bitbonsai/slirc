// The Links view's query: the typed form, the filter column and the address are one value.
import { expect, test } from "bun:test";
import { foldDay, foldLabel, lastHereIndex, quotedPost, readerBlocks } from "../client/links-query.ts";
import { absorbTokens, activeFilters, addressIn, dayHeading, decodeQuery, displaySummary, displayTitle, dropLastFilter, emptyFacets, emptyQuery, encodeQuery, filterCount, filterGroups, filterIsOn, normalizeTopic, placeholderFor, postAuthor, requestParams, toggleFilter, topicOptions, type LinkFacets } from "../client/links-query.ts";
import { hiddenCommands, slashSuggestions } from "../client/commands.ts";

const facets: LinkFacets = {
  total: 100,
  topics: [{ value: "tooling", count: 60 }, { value: "agents", count: 30 }, { value: "security", count: 10 }, { value: "everything", count: 100 }],
  sharers: [{ value: "Ada Example", count: 40 }, { value: "ben", count: 20 }, { value: "Benedict Stone", count: 5 }],
  sources: [{ value: "blog", count: 50 }, { value: "github", count: 25 }],
  origins: [{ value: "dev_links", count: 70 }, { value: "#general", count: 30 }],
  years: [{ value: "2026", count: 80 }, { value: "2025", count: 20 }],
  week: 4, month: 12,
};

test("a URL is something to add; words are something to search", () => {
  expect(addressIn("https://example.com/a")).toBe("https://example.com/a");
  expect(addressIn("  https://example.com/a worth reading  ")).toBe("https://example.com/a");
  for (const text of ["rust async", "see https://example.com/a", "example.com", "javascript:alert(1)", "https://localhost", "https://user:pw@example.com/", ""]) expect(addressIn(text)).toBeNull();
});

test("the typed form and the address round-trip the whole query", () => {
  const state = { text: "rust async", topics: ["agents", "tooling"], sharer: "Ada Example", source: "github", origin: "dev_links", when: "2025", site: "" };
  const typed = encodeQuery(state);
  expect(typed).toBe('#agents #tooling @"Ada Example" source:github in:dev_links when:2025 rust async');
  expect(decodeQuery(typed)).toEqual(state);
  expect(decodeQuery("@ben #AGENTS when:week hello")).toEqual({ ...emptyQuery(), text: "hello", topics: ["agents"], sharer: "ben", when: "week" });
  // Junk tokens stay words; nothing here is trusted beyond its shape.
  expect(decodeQuery("source:nope when:tomorrow in:<script> #!!")).toEqual({ ...emptyQuery(), text: "source:nope when:tomorrow in:<script> #!!" });
  expect(encodeQuery(emptyQuery())).toBe("");
});

test("a finished #topic or @name becomes its filter only when it names something real", () => {
  expect(absorbTokens({ ...emptyQuery(), text: "#agents " }, facets)).toEqual({ ...emptyQuery(), topics: ["agents"] });
  expect(absorbTokens({ ...emptyQuery(), text: "evals #agents @ada " }, facets)).toEqual({ ...emptyQuery(), text: "evals ", topics: ["agents"], sharer: "Ada Example" });
  // Still typing: nothing changes.
  expect(absorbTokens({ ...emptyQuery(), text: "#agents" }, facets).topics).toEqual([]);
  // Two people start with "ben", and no topic is called that: both stay words.
  expect(absorbTokens({ ...emptyQuery(), text: "@bene #nope " }, facets)).toEqual({ ...emptyQuery(), text: "#nope ", sharer: "Benedict Stone" });
  expect(absorbTokens({ ...emptyQuery(), text: "@be " }, facets).sharer).toBe("");
});

test("chips, sharer and words become one request", () => {
  const params = requestParams({ text: " rust #async ", topics: ["agents", "tooling"], sharer: "Ada Example", source: "x", origin: "dev_links", when: "month", site: "" }, "#general");
  expect(params.toString()).toBe("q=rust+async&topic=agents&topic=tooling&sharer=Ada+Example&source=x&origin=dev_links&when=month&channel=%23general");
  expect(requestParams(emptyQuery(), "").toString()).toBe("");
});

test("the filter column has fixed groups in a fixed order, each in the order the server counted", () => {
  const groups = filterGroups(facets);
  expect(groups.map((group) => group.title)).toEqual(["Topics", "Sources", "Shared by", "When", "From"]);
  expect(groups[0].entries.map((entry) => [entry.label, entry.count])).toEqual([["tooling", 60], ["agents", 30], ["security", 10], ["everything", 100]]);
  expect(groups[1].entries.map((entry) => entry.label)).toEqual(["Blogs", "GitHub"]);
  expect(groups[3].entries.map((entry) => entry.label)).toEqual(["This week", "This month", "2026", "2025"]);
  // A group with nothing in it is left out, and so is an entry with no links.
  expect(filterGroups({ ...emptyFacets(), total: 3, topics: [{ value: "agents", count: 3 }], week: 0, month: 2 }).map((group) => [group.title, group.entries.length])).toEqual([["Topics", 1], ["When", 1]]);
});

test("filters turn on and off, show as tokens, and Backspace removes the last one", () => {
  let state = toggleFilter(emptyQuery(), "topic", "agents");
  state = toggleFilter(state, "topic", "tooling");
  state = toggleFilter(state, "sharer", "ben");
  state = toggleFilter(state, "site", "bun.sh");
  state = toggleFilter(state, "when", "2025");
  expect(activeFilters(state).map((token) => token.label)).toEqual(["#agents", "#tooling", "bun.sh", "ben", "2025"]);
  expect([filterCount(state), filterIsOn(state, "sharer", "BEN"), filterIsOn(state, "topic", "mcp")]).toEqual([5, true, false]);
  // One value at a time for everything but topics.
  expect(toggleFilter(state, "when", "week").when).toBe("week");
  expect(toggleFilter(state, "topic", "agents").topics).toEqual(["tooling"]);
  expect(toggleFilter(state, "sharer", "Ben").sharer).toBe("");
  state = dropLastFilter(state);
  expect(state.when).toBe("");
  state = dropLastFilter(state);
  expect(state.sharer).toBe("");
  expect(dropLastFilter(dropLastFilter(state)).topics).toEqual(["agents"]);
});

test("a bare domain typed in the field becomes a site filter", () => {
  expect(absorbTokens({ ...emptyQuery(), text: "evals github.com " }, facets)).toEqual({ ...emptyQuery(), text: "evals ", site: "github.com" });
  expect(absorbTokens({ ...emptyQuery(), text: "v1.2 e.g. " }, facets).site).toBe("");
  expect(requestParams({ ...emptyQuery(), site: "bun.sh" }, "").toString()).toBe("site=bun.sh");
  expect(decodeQuery("site:www.Example.com x")).toEqual({ ...emptyQuery(), text: "x", site: "example.com" });
});

test("rough data is tidied when a row is drawn", () => {
  expect(displayTitle({ title: "", url: "https://www.example.com/blog/my-first_post/" })).toBe("example.com › blog › my first post");
  expect(displayTitle({ title: "https://example.com/a", url: "https://example.com/a" })).toBe("example.com › a");
  expect(displayTitle({ title: "A real title", url: "https://example.com/a" })).toBe("A real title");
  for (const summary of ["", "Unavailable", "unavailable.", "N/A", "No summary available", "Same as title"]) expect(displaySummary({ summary, title: "Same as title" })).toBe("");
  expect(displaySummary({ summary: "What it says.", title: "T" })).toBe("What it says.");
  expect(postAuthor({ url: "https://x.com/mitchellh/status/1", source: "x" })).toBe("@mitchellh");
  expect(postAuthor({ url: "https://x.com/i/status/1", source: "x", author: "sam" })).toBe("@sam");
  expect(postAuthor({ url: "https://example.com/mitchellh", source: "blog" })).toBe("");
});

test("day headings read Today, Yesterday, then dates", () => {
  const now = Date.UTC(2026, 10, 12, 9);
  expect(dayHeading(Date.UTC(2026, 10, 12, 1), now)).toBe("Today");
  expect(dayHeading(Date.UTC(2026, 10, 11, 23), now)).toBe("Yesterday");
  expect(dayHeading(Date.UTC(2026, 10, 3), now)).toBe("3 Nov");
  expect(dayHeading(Date.UTC(2024, 1, 3), now)).toBe("3 Feb 2024");
});

test("the placeholder carries the count and the instruction", () => {
  expect(placeholderFor(4354, true)).toBe("Search 4,354 links, or paste one to add");
  expect(placeholderFor(1, true)).toBe("Search 1 link, or paste one to add");
  expect(placeholderFor(0, true)).toBe("Search links, or paste one to add");
  expect(placeholderFor(9, false)).toBe("Search links, or paste one to add");
});

test("the topic type-ahead lists matches, the ones that start with the word first, and Create last", () => {
  const all = facets.topics;
  expect(topicOptions(all, [], "").map((option) => option.label)).toEqual(["#tooling", "#agents", "#security", "#everything"]);
  // What the link already has is not offered.
  expect(topicOptions(all, ["tooling"], "").map((option) => option.value)).toEqual(["agents", "security", "everything"]);
  expect(topicOptions(all, [], "e").map((option) => option.label)).toEqual(["#everything", "#agents", "#security"]);
  expect(topicOptions(all, [], "Sec").map((option) => [option.label, option.create])).toEqual([["#security", false], ["Create #sec", true]]);
  // An exact name is never offered as new, on the list or on the link.
  expect(topicOptions(all, [], "agents").some((option) => option.create)).toBe(false);
  expect(topicOptions(all, ["agents"], "agents")).toEqual([]);
  expect(topicOptions(all, [], "Team Picks!").map((option) => option.label)).toEqual(["Create #team-picks"]);
  expect(topicOptions(all, [], "x").some((option) => option.create)).toBe(false);
  expect(normalizeTopic("  #Context Engineering_101! ")).toBe("context-engineering-101");
  expect(normalizeTopic("---")).toBe("");
});

test("a day with more than five links folds to five, and nothing folds while filtering", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, index) => index);
  expect(foldDay(rows(13), true, false)).toEqual({ shown: [0, 1, 2, 3, 4], hidden: 8 });
  expect(foldDay(rows(8), true, false)).toEqual({ shown: [0, 1, 2, 3, 4], hidden: 3 });
  expect(foldDay(rows(6), true, false)).toEqual({ shown: [0, 1, 2, 3, 4], hidden: 1 });
  expect(foldLabel(1, Date.UTC(2026, 10, 9, 12), Date.UTC(2026, 10, 12, 9))).toBe("1 more from Monday");
  for (const n of [1, 4, 5]) expect(foldDay(rows(n), true, false)).toEqual({ shown: rows(n), hidden: 0 });
  // A search or a filter is on, or the day was opened.
  expect(foldDay(rows(13), false, false).hidden).toBe(0);
  expect(foldDay(rows(13), true, true).shown.length).toBe(13);
  const now = Date.UTC(2026, 10, 12, 9); // a Thursday
  expect(foldLabel(8, Date.UTC(2026, 10, 9, 12), now)).toBe("8 more from Monday");
  expect(foldLabel(3, Date.UTC(2026, 10, 12, 1), now)).toBe("3 more from today");
  expect(foldLabel(3, Date.UTC(2026, 10, 11, 1), now)).toBe("3 more from yesterday");
  expect(foldLabel(4, Date.UTC(2026, 9, 20), now)).toBe("4 more from 20 Oct");
});

test("the last-here line goes before the first link that is not new", () => {
  const rows = [50, 40, 30, 20].map((firstSharedAt) => ({ firstSharedAt }));
  expect(lastHereIndex(rows, 35)).toBe(2);
  expect(lastHereIndex(rows, 40)).toBe(1);
  // Nothing new, everything new so far, or no read position: no line.
  expect(lastHereIndex(rows, 50)).toBe(-1);
  expect(lastHereIndex(rows, 60)).toBe(-1);
  expect(lastHereIndex(rows, 10)).toBe(-1);
  expect(lastHereIndex(rows, undefined)).toBe(-1);
  expect(lastHereIndex([], 35)).toBe(-1);
});

test("an X link is a quoted post, leading with the page it shares when it shares one", () => {
  const base = { url: "https://x.com/mitchellh/status/1", source: "x", title: "A written headline", summary: "A written summary." };
  // The feed gave the post and the page it links to: the page leads, the post is one click away.
  expect(quotedPost({ ...base, post: { text: "Read this", name: "Mitchell", handle: "mitchellh", linkedUrl: "https://www.example.com/essay", linkedTitle: "An essay" } }))
    .toEqual({ handle: "@mitchellh", text: "Read this", postUrl: "https://x.com/mitchellh/status/1", linked: { url: "https://www.example.com/essay", title: "An essay", host: "example.com" } });
  // A linked page with no title reads as its address.
  expect(quotedPost({ ...base, post: { text: "Read this", name: "", handle: "mitchellh", linkedUrl: "https://example.com/blog/my-post", linkedTitle: "" } })!.linked!.title).toBe("example.com › blog › my post");
  // The post is the content: no linked page, and the post's own words.
  expect(quotedPost({ ...base, post: { text: "Just words", name: "Mitchell", handle: "mitchellh", linkedUrl: "", linkedTitle: "" } })).toEqual({ handle: "@mitchellh", text: "Just words", postUrl: base.url, linked: null });
  // No feed data: the text the import came with, and the handle from the address.
  expect(quotedPost(base)).toEqual({ handle: "@mitchellh", text: "A written summary.", postUrl: base.url, linked: null });
  expect(quotedPost({ ...base, summary: "Unavailable" })!.text).toBe("A written headline");
  // Only http(s) can lead a row.
  expect(quotedPost({ ...base, post: { text: "x", name: "", handle: "sam", linkedUrl: "javascript:alert(1)", linkedTitle: "t" } })!.linked).toBeNull();
  expect(quotedPost({ ...base, source: "blog" })).toBeNull();
});

test("the reader view draws a saved copy as blocks of text, never as markup", () => {
  const blocks = readerBlocks("# The Title\n\nFirst paragraph\nsecond line.\n\n## Part two\n\n- one\n\n- two\n\n<script>alert(1)</script> <b>not bold</b>\n\n#hashtag is a paragraph\n\n");
  expect(blocks).toEqual([
    { kind: "h1", text: "The Title" }, { kind: "p", text: "First paragraph\nsecond line." }, { kind: "h2", text: "Part two" },
    { kind: "li", text: "one" }, { kind: "li", text: "two" }, { kind: "p", text: "<script>alert(1)</script> <b>not bold</b>" }, { kind: "p", text: "#hashtag is a paragraph" },
  ]);
  expect(readerBlocks("")).toEqual([]);
});

test("/link and /links are offered only where the links helper runs", () => {
  expect(hiddenCommands(["help", "remind"], true)).toEqual(["poll", "link", "links"]);
  expect(hiddenCommands(["links"], true)).toEqual(["remind", "poll"]);
  expect(slashSuggestions("/li", hiddenCommands(["help", "remind"])).map((command) => command.name)).toEqual([]);
  expect(slashSuggestions("/li", hiddenCommands(["remind", "links"])).map((command) => command.name)).toEqual(["link", "links"]);
});
