// The links library table: link keys, full-text search, who may see what, removal and the import.
// Private-channel visibility is tested from both sides: a member sees the channel's links, a
// person outside it gets none of its rows, counts or filter values.
import "./fixture.ts";

process.env.SLIRC_HELPERS = "help,links";

import { beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const links = await import("../src/links.ts");
const { importLinks, importRowsFromCsv, linkFacets, linkKey, matchExpression, recordShare, removeLink, searchLinks, visibleLink } = links;

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 0, 10, 12);
const ada = { id: "acct-ada", nick: "ada", role: "member" };
const ben = { id: "acct-ben", nick: "ben", role: "member" };
const admin = { id: "acct-admin", nick: "bitbonsai", role: "admin" };

function share(url: string, fields: Partial<Parameters<typeof recordShare>[0]> = {}) {
  return recordShare({ url, sharedAt: T0, sharerName: "ada", sharerAccount: ada.id, title: "Untitled", enriched: true, ...fields })!;
}

beforeEach(() => {
  db.exec("DELETE FROM links; DELETE FROM links_fts; DELETE FROM link_seen; DELETE FROM link_model_counts; DELETE FROM link_topic_edits; DELETE FROM channel_members; DELETE FROM channels");
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#vault', 'ada', 'secret', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#vault', 'ada')").run();
});

test("SQLite in this build has FTS5 with prefix search", () => {
  db.exec("CREATE VIRTUAL TABLE temp.probe USING fts5(body, prefix = '2 3')");
  db.exec("INSERT INTO temp.probe VALUES ('rustaceans gather')");
  expect((db.query("SELECT COUNT(*) AS n FROM temp.probe WHERE probe MATCH '\"rust\"*'").get() as { n: number }).n).toBe(1);
  db.exec("DROP TABLE temp.probe");
});

test("a link key folds the variants of one address", () => {
  const key = linkKey("https://example.com/post");
  for (const variant of ["http://www.example.com/post/", "https://EXAMPLE.com/post#top", "https://example.com/post?utm_source=x&utm_medium=y", "https://example.com/post?fbclid=1&gclid=2"]) {
    expect(linkKey(variant)).toBe(key);
  }
  expect(linkKey("https://twitter.com/sam/status/12?s=20&t=abc")).toBe(linkKey("https://x.com/sam/status/12"));
  expect(linkKey("https://youtu.be/abc123?si=zz")).toBe(linkKey("https://www.youtube.com/watch?v=abc123"));
  // A query that names the page is kept.
  expect(linkKey("https://example.com/post?id=1")).not.toBe(linkKey("https://example.com/post?id=2"));
  for (const bad of ["mailto:sam@example.com", "javascript:alert(1)", "ftp://example.com/a", "https://user:pass@example.com/", "not a url", `https://example.com/${"a".repeat(2_100)}`]) {
    expect(linkKey(bad)).toBeNull();
  }
});

test("what a person types never reaches MATCH as syntax", () => {
  expect(matchExpression('rust" OR title:* NEAR(', "AND")).toBe('"rust"* AND "or"* AND "title"* AND "near"*');
  expect(matchExpression("  ", "AND")).toBe("");
  share("https://example.com/a", { title: "Rust async book" });
  for (const hostile of ['"', "*", "title:", "a AND", "NEAR(", "(((", "-rust", 'rust" OR 1'] ) {
    expect(() => searchLinks("ada", { q: hostile })).not.toThrow();
  }
});

test("search finds by prefix, ranks a title match first and falls back to any word", () => {
  share("https://example.com/summary", { title: "Notes from a conference", summary: "A talk on tokio and async runtimes in Rust.", sharedAt: T0 + DAY });
  share("https://example.com/title", { title: "Tokio internals", summary: "How the scheduler works.", sharedAt: T0 });
  share("https://example.com/other", { title: "CSS grid tricks", summary: "Layout notes.", topics: ["design"] });
  expect(searchLinks("ada", { q: "tok" }).rows.map((row) => row.title)).toEqual(["Tokio internals", "Notes from a conference"]);
  expect(searchLinks("ada", { q: "grid" }).total).toBe(1);
  // No row holds both words, so either one counts.
  expect(searchLinks("ada", { q: "tokio grid" }).total).toBe(3);
  expect(searchLinks("ada", { q: "zzzz" }).total).toBe(0);
  // The host is searchable, and so are topics.
  expect(searchLinks("ada", { q: "design" }).rows[0].title).toBe("CSS grid tricks");
  expect(searchLinks("ada", { q: "example" }).total).toBe(3);
});

test("no search words lists newest first, and each filter narrows", () => {
  share("https://x.com/sam/status/1", { title: "Old post", sharedAt: T0, topics: ["agents"], origin: "#general" });
  share("https://github.com/a/b", { title: "A repo", sharedAt: T0 + 40 * DAY, topics: ["tooling", "agents"], origin: "dev_links" });
  share("https://example.com/c", { title: "A blog", sharedAt: T0 + 80 * DAY, topics: ["tooling"], source: "blog", origin: "#general" });
  expect(searchLinks("ada").rows.map((row) => row.title)).toEqual(["A blog", "A repo", "Old post"]);
  expect(searchLinks("ada", { topics: ["agents"] }).rows.map((row) => row.title)).toEqual(["A repo", "Old post"]);
  // A topic matches as a whole word: "agent" is not "agents".
  expect(searchLinks("ada", { topics: ["agent"] }).total).toBe(0);
  expect(searchLinks("ada", { source: "github" }).rows.map((row) => row.title)).toEqual(["A repo"]);
  expect(searchLinks("ada", { source: "x" }).total).toBe(1);
  expect(searchLinks("ada", { origin: "#general" }).total).toBe(2);
  expect(searchLinks("ada", { origin: "dev_links" }).total).toBe(1);
  expect(searchLinks("ada", { from: T0 + 30 * DAY, to: T0 + 50 * DAY }).rows.map((row) => row.title)).toEqual(["A repo"]);
  expect(searchLinks("ada", { topics: ["tooling' OR 1=1 --"] }).total).toBe(0);
  const page = searchLinks("ada", { limit: 2 });
  expect([page.rows.length, page.total, page.more]).toEqual([2, 3, true]);
  expect(searchLinks("ada", { limit: 2, offset: 2 }).more).toBe(false);
});

test("topics, sharer and words combine, and suggestions are counted inside the current results", () => {
  share("https://example.com/1", { title: "Agents at work", topics: ["agents", "tooling"], sharerName: "Ada Example", sharerAccount: null, origin: "dev_links" });
  share("https://example.com/2", { title: "Agents and memory", topics: ["agents", "memory"], sharerName: "ben", sharerAccount: ben.id, origin: "#general" });
  share("https://example.com/3", { title: "Tooling roundup", topics: ["tooling"], sharerName: "ada example", sharerAccount: null, origin: "dev_links" });
  // An imported name and a member name filter the same way, ignoring case.
  expect(searchLinks("ada", { sharer: "ada example" }).total).toBe(2);
  expect(searchLinks("ada", { sharer: "ben" }).rows.map((row) => row.title)).toEqual(["Agents and memory"]);
  expect(searchLinks("ada", { sharer: "Ada" }).total).toBe(0);
  expect(searchLinks("ada", { topics: ["agents", "tooling"] }).rows.map((row) => row.title)).toEqual(["Agents at work"]);
  expect(searchLinks("ada", { topics: ["agents"], sharer: "Ada Example", q: "work" }).total).toBe(1);
  expect(searchLinks("ada", { topics: ["agents"], sharer: "Ada Example", q: "memory" }).total).toBe(0);

  const narrowed = linkFacets("ada", { topics: ["agents"] });
  expect(narrowed.total).toBe(2);
  expect(narrowed.topics).toEqual([{ value: "agents", count: 2 }, { value: "memory", count: 1 }, { value: "tooling", count: 1 }]);
  expect(narrowed.sharers.map((facet) => facet.value).sort()).toEqual(["Ada Example", "ben"]);
  expect(narrowed.origins.map((facet) => facet.value).sort()).toEqual(["#general", "dev_links"]);
  // Names that differ only by case are one person.
  expect(linkFacets("ada").sharers[0]).toEqual({ value: "Ada Example", count: 2 });
  expect(linkFacets("ada", { q: "roundup" }).topics).toEqual([{ value: "tooling", count: 1 }]);
  expect(linkFacets("ada", { q: "zzzz" }).total).toBe(0);
});

test("a site filter matches one host, and single-choice groups keep their other values on offer", () => {
  share("https://github.com/a/b", { title: "Repo", topics: ["tooling"], sharerName: "ada", source: "github" });
  share("https://gist.github.com/x", { title: "Gist", topics: ["tooling"], sharerName: "ben", sharerAccount: ben.id, source: "github" });
  share("https://github.community/t/1", { title: "Forum", topics: ["agents"], sharerName: "ben", sharerAccount: ben.id, source: "web" });
  share("https://github.com", { title: "Home", sharerName: "ada", source: "product" });
  expect(searchLinks("ada", { site: "github.com" }).rows.map((row) => row.title).sort()).toEqual(["Home", "Repo"]);
  expect(searchLinks("ada", { site: "WWW.GitHub.com" }).total).toBe(2);
  for (const site of ["github", "%", "git_hub.com", "github.com/%"]) expect(searchLinks("ada", { site }).total).toBe(0);

  const picked = links.linkFilterFacets("ada", { source: "github" });
  // The list is narrowed to GitHub, but the other sources stay listed to switch to.
  expect(picked.total).toBe(2);
  expect(picked.sources.map((facet) => facet.value).sort()).toEqual(["github", "product", "web"]);
  expect(picked.sharers.map((facet) => [facet.value, facet.count])).toEqual([["ada", 1], ["ben", 1]]);
  expect(links.linkFilterFacets("ada", { sharer: "ben" }).sharers.map((facet) => facet.value).sort()).toEqual(["ada", "ben"]);
  // Topics narrow together, so they are counted inside the results.
  expect(links.linkFilterFacets("ada", { topics: ["agents"] }).topics).toEqual([{ value: "agents", count: 1 }]);
  expect(links.viewerHasSite("ada", "github.com")).toBe(true);
  expect(links.viewerHasSite("ada", "example.org")).toBe(false);
});

test("a channel's own view lists what was collected there, and only for its members", () => {
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#general', 'ada', 'workspace', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#general', 'ada'), ('#general', 'ben')").run();
  share("https://example.com/g", { title: "From general", origin: "#general" });
  share("https://example.com/i", { title: "Imported", origin: "dev_links" });
  share("https://example.com/v", { title: "Vault only", scope: "#vault", origin: "#vault" });
  // The same link in the vault and in general: the vault's own view still shows its row.
  share("https://example.com/both", { title: "Vault wording", scope: "#vault", origin: "#vault" });
  share("https://example.com/both", { title: "General wording", origin: "#general" });

  expect(searchLinks("ada", { channel: "#general" }).rows.map((row) => row.title).sort()).toEqual(["From general", "General wording"]);
  expect(searchLinks("ada", { channel: "#vault" }).rows.map((row) => row.title).sort()).toEqual(["Vault only", "Vault wording"]);
  expect(searchLinks("ada").rows.map((row) => row.title).sort()).toEqual(["From general", "General wording", "Imported", "Vault only"]);
  expect(linkFacets("ada", { channel: "#vault" }).total).toBe(2);
  // Asking for a channel you are not in gives nothing, whatever else is in the query.
  expect(searchLinks("ben", { channel: "#vault" }).total).toBe(0);
  expect(linkFacets("ben", { channel: "#vault" }).total).toBe(0);
  expect(searchLinks("ben", { channel: "#general" }).total).toBe(2);
  expect(searchLinks("ben", { channel: "#nowhere" }).total).toBe(0);
});

test("a repeat share counts once more and keeps the first date and sharer", () => {
  const first = share("https://example.com/a", { title: "First", sharedAt: T0, origin: "#general" });
  const again = share("https://www.example.com/a/?utm_source=chat", { title: "Second title", sharedAt: T0 + DAY, sharerName: "ben", sharerAccount: ben.id, origin: "#random" });
  expect(again).toEqual({ id: first.id, created: false, removed: false });
  const row = visibleLink("ada", first.id)!;
  expect([row.shareCount, row.firstSharedAt, row.lastSharedAt, row.sharedByName, row.title]).toEqual([2, T0, T0 + DAY, "ada", "First"]);
  expect(row.origins).toEqual(["#general", "#random"]);
  expect((db.query("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(1);
});

test("a private channel's links are invisible outside it: rows, search, counts and filter values", () => {
  share("https://example.com/public", { title: "Public roadmap", topics: ["tooling"], origin: "#general" });
  const secret = share("https://example.com/secret", { title: "Layoff planning memo", summary: "Zebra project numbers.", topics: ["zebra-only"], source: "research", scope: "#vault", origin: "#vault", sharedAt: Date.UTC(2019, 5, 1) });

  // The member sees both.
  expect(searchLinks("ada").total).toBe(2);
  expect(searchLinks("ada", { q: "zebra" }).rows.map((row) => row.id)).toEqual([secret.id]);
  expect(linkFacets("ada").origins.map((facet) => facet.value)).toContain("#vault");

  // Someone outside gets nothing that came from it.
  for (const query of [{}, { q: "zebra" }, { q: "layoff" }, { topics: ["zebra-only"] }, { origin: "#vault" }, { source: "research" }]) {
    const result = searchLinks("ben", query);
    expect(result.rows.find((row) => row.id === secret.id)).toBeUndefined();
    expect(result.total).toBe(Object.keys(query).length ? 0 : 1);
  }
  expect(visibleLink("ben", secret.id)).toBeNull();
  const facets = linkFacets("ben");
  expect(facets.total).toBe(1);
  expect(JSON.stringify(facets)).not.toContain("vault");
  expect(JSON.stringify(facets)).not.toContain("zebra");
  expect(JSON.stringify(facets)).not.toContain("research");
  expect(facets.years).toEqual([{ value: "2026", count: 1 }]);
  expect(links.allowedTopics()).toEqual(["tooling"]);

  // Joining shows them; leaving hides them again on the next read.
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#vault', 'ben')").run();
  expect(searchLinks("ben", { q: "zebra" }).total).toBe(1);
  expect(linkFacets("ben").total).toBe(2);
  db.query("DELETE FROM channel_members WHERE channel = '#vault' AND nick = 'ben'").run();
  expect(searchLinks("ben", { q: "zebra" }).total).toBe(0);
  expect(linkFacets("ben").total).toBe(1);
});

test("the same link shared privately and publicly is two rows, and the private text stays private", () => {
  const secret = share("https://x.com/sam/status/9", { title: "our acquisition target, keep quiet", scope: "#vault", origin: "#vault" });
  const open = share("https://x.com/sam/status/9", { title: "Sam on pricing", origin: "#general", sharerName: "ben", sharerAccount: ben.id });
  expect(open.created).toBe(true);
  expect(open.id).not.toBe(secret.id);
  expect(searchLinks("ben").rows.map((row) => row.title)).toEqual(["Sam on pricing"]);
  expect(searchLinks("ben", { q: "acquisition" }).total).toBe(0);
  // A member of the private channel is shown the link once, as the row everyone sees.
  expect(searchLinks("ada").rows.map((row) => row.title)).toEqual(["Sam on pricing"]);
  expect(linkFacets("ada").total).toBe(1);
});

test("whoever added a link, or an admin, can remove it; removal clears the text and keeps the link gone", () => {
  const mine = share("https://example.com/mine", { title: "Mine", summary: "Text to clear", topics: ["tooling"] });
  const imported = share("https://example.com/imported", { title: "Imported", sharerName: "Old Colleague", sharerAccount: null });
  const secret = share("https://example.com/secret", { title: "Secret", scope: "#vault" });

  expect(removeLink(ben, mine.id)).toBe("forbidden");
  expect(removeLink(ben, imported.id)).toBe("forbidden");
  // A link the caller cannot see reads as missing, like an id that does not exist.
  expect(removeLink(ben, secret.id)).toBe("missing");
  expect(removeLink(ben, 999_999)).toBe("missing");
  expect(removeLink(admin, secret.id)).toBe("missing");

  expect(removeLink(ada, mine.id)).toBe("removed");
  expect(removeLink(admin, imported.id)).toBe("removed");
  expect(searchLinks("ada").rows.map((row) => row.title)).toEqual(["Secret"]);
  expect(searchLinks("ada", { q: "clear" }).total).toBe(0);
  const raw = db.query("SELECT title, summary, topics, removed_at FROM links WHERE id = ?").get(mine.id) as any;
  expect([raw.title, raw.summary, raw.topics]).toEqual(["", "", ""]);
  expect(raw.removed_at).toBeGreaterThan(0);
  expect(removeLink(ada, mine.id)).toBe("missing");
  // Posting it again does not bring it back.
  expect(share("https://example.com/mine", { title: "Back again" })).toEqual({ id: mine.id, created: false, removed: true });
  expect(searchLinks("ada", { q: "back" }).total).toBe(0);
});

test("any member who can see a link may add, remove and create topics; a private link only by its channel", () => {
  const open = share("https://example.com/open", { title: "Open", topics: ["tooling"] });
  const secret = share("https://example.com/secret", { title: "Secret", topics: ["agents"], scope: "#vault" });
  const edit = links.editLinkTopic;
  // Another member, not the adder, edits freely.
  expect((edit(ben, open.id, "add", "agents") as any).link.topics).toEqual(["tooling", "agents"]);
  // A new topic is lowercased and hyphenated.
  expect((edit(ben, open.id, "add", "  #Context Engineering_101! ") as any).link.topics).toEqual(["tooling", "agents", "context-engineering-101"]);
  expect(links.normalizeTopic("Évals & Benchmarks")).toBe("vals-benchmarks");
  expect((edit(ada, open.id, "remove", "tooling") as any).link.topics).toEqual(["agents", "context-engineering-101"]);
  // Adding what is there, or removing what is not, changes nothing and records nothing.
  edit(ada, open.id, "add", "agents");
  edit(ada, open.id, "remove", "nope");
  expect(searchLinks("ada", { topics: ["context-engineering-101"] }).total).toBe(1);
  expect(searchLinks("ada", { q: "context-engineering" }).total).toBe(1);
  expect(searchLinks("ada", { topics: ["tooling"] }).total).toBe(0);
  for (const bad of ["", "!!!", "-", "#"]) expect(edit(ada, open.id, "add", bad)).toEqual({ error: "invalid" });

  // The private link: its member edits, everyone else finds nothing there, the admin included.
  expect((edit(ada, secret.id, "add", "zebra") as any).link.topics).toEqual(["agents", "zebra"]);
  expect(edit(ben, secret.id, "add", "leak")).toEqual({ error: "missing" });
  expect(edit(ben, secret.id, "remove", "agents")).toEqual({ error: "missing" });
  expect(edit(admin, secret.id, "add", "leak")).toEqual({ error: "missing" });
  expect(edit(ben, 999_999, "add", "x1")).toEqual({ error: "missing" });
  expect(visibleLink("ada", secret.id)!.topics).toEqual(["agents", "zebra"]);
  expect(linkFacets("ben").topics.map((facet) => facet.value)).not.toContain("zebra");

  // Who changed what, and when.
  const log = db.query("SELECT link_id, account_id, nick, action, topic FROM link_topic_edits ORDER BY id").all();
  expect(log).toEqual([
    { link_id: open.id, account_id: ben.id, nick: "ben", action: "add", topic: "agents" },
    { link_id: open.id, account_id: ben.id, nick: "ben", action: "add", topic: "context-engineering-101" },
    { link_id: open.id, account_id: ada.id, nick: "ada", action: "remove", topic: "tooling" },
    { link_id: secret.id, account_id: ada.id, nick: "ada", action: "add", topic: "zebra" },
  ]);
  for (const topic of ["t1", "t2", "t3", "t4", "t5", "t6"]) edit(ada, open.id, "add", topic);
  expect(edit(ada, open.id, "add", "one-too-many")).toEqual({ error: "full" });
  expect((edit(ada, open.id, "remove", "t1") as any).link.topics.length).toBe(7);
});

const CSV = [
  "date,channel,title,link,summary,author,source,topics,shared_by,comment",
  '2026-03-02,dev_links,"A guide, with a comma",https://example.com/guide,"Line one\nline two, quoted ""twice""",sam,blog,tooling design,Ada Example,PRIVATE-COMMENT-ONE',
  "2026-01-05,frontend,Same guide earlier,https://www.example.com/guide/?utm_source=slack,Earlier summary.,sam,blog,tooling workflow,Ben Example,PRIVATE-COMMENT-TWO",
  "2026-02-01,dev_links,An X post,https://x.com/sam/status/77?s=20,What Sam said.,sam,x,agents,Ada Example,",
  "2026-02-01,dev_links,No scheme,example.com/nope,Bad row.,sam,blog,tooling,Ada Example,",
  "02/01/2026,dev_links,Bad date,https://example.com/date,Bad row.,sam,blog,tooling,Ada Example,",
  "2026-02-01,dev_links,,https://example.com/untitled,Bad row.,sam,blog,tooling,Ada Example,",
  "2026-02-01,dev_links,An X post,https://x.com/sam/status/77?s=20,What Sam said.,sam,x,agents,Ada Example,",
].join("\n");

test("the import merges duplicates, skips bad rows without quoting them, and never stores the comment column", () => {
  const rows = importRowsFromCsv(CSV);
  expect(rows.length).toBe(7);
  expect(Object.keys(rows[0]).sort()).toEqual(["author", "channel", "date", "line", "link", "shared_by", "source", "summary", "title", "topics"]);

  const dry = importLinks(rows, { dryRun: true });
  expect([dry.read, dry.added, dry.merged, dry.skipped.length, dry.alreadyImported]).toEqual([7, 2, 1, 4, 0]);
  expect((db.query("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM link_seen").get() as { n: number }).n).toBe(0);

  const report = importLinks(rows);
  expect([report.read, report.added, report.merged, report.skipped.length, report.alreadyImported]).toEqual([7, 2, 1, 4, 0]);
  expect(report.skipped.map((item) => item.line)).toEqual([5, 6, 7, 8]);
  expect(JSON.stringify(report)).not.toMatch(/example\.com|Bad row|Ada/);

  const guide = searchLinks("ada", { q: "guide" }).rows[0];
  // The earliest row gives the date, sharer, title and summary; topics merge, most frequent first.
  expect([guide.title, guide.summary, guide.sharedByName, guide.shareCount]).toEqual(["Same guide earlier", "Earlier summary.", "Ben Example", 2]);
  expect(guide.firstSharedAt).toBe(Date.parse("2026-01-05T12:00:00Z"));
  expect(guide.lastSharedAt).toBe(Date.parse("2026-03-02T12:00:00Z"));
  expect(guide.topics[0]).toBe("tooling");
  expect(guide.topics.sort()).toEqual(["design", "tooling", "workflow"]);
  expect(guide.origins.sort()).toEqual(["dev_links", "frontend"]);
  expect([guide.sharedByAccount, guide.scope]).toEqual([null, ""]);
  expect(guide.enrichedAt).toBeGreaterThan(0);
  expect(searchLinks("ada", { source: "x" }).total).toBe(1);

  // The comment text is nowhere in the database.
  const dump = JSON.stringify([db.query("SELECT * FROM links").all(), db.query("SELECT * FROM links_fts").all(), db.query("SELECT * FROM link_seen").all()]);
  expect(dump).not.toContain("PRIVATE-COMMENT");

  // A second run changes nothing.
  const again = importLinks(importRowsFromCsv(CSV));
  expect([again.added, again.merged, again.alreadyImported]).toEqual([0, 0, 3]);
  expect(searchLinks("ada", { q: "guide" }).rows[0].shareCount).toBe(2);
  expect((db.query("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(2);
});

test("an import with a missing column is refused", () => {
  expect(() => importRowsFromCsv("date,channel,title,link\n2026-01-01,a,b,https://example.com")).toThrow("missing columns");
});

test("the daily model budget stops at the cap and starts again the next day", () => {
  process.env.LINKS_DAILY_MODEL_CALLS = "2";
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  expect([links.takeModelCall(T0, log), links.takeModelCall(T0, log), links.takeModelCall(T0, log)]).toEqual([true, true, false]);
  expect(lines.length).toBe(1);
  expect(links.takeModelCall(T0 + DAY, log)).toBe(true);
  delete process.env.LINKS_DAILY_MODEL_CALLS;
  expect(links.modelCallCap()).toBe(200);
});
