// The daily digest: what an import added, written as a short post, queued for the `links` helper,
// and a channel the helper only posts in, so it saves nothing there.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://guild.example.test";
process.env.SLIRC_HELPERS = "help,links";

import { beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { importLinks, importRowsFromCsv } = await import("../src/links.ts");
const { collectFromMessage, linksChannelsFor } = await import("../src/links-collect.ts");
const { textSegments } = await import("../client/render.ts");
const { digestLines, ensureDigestChannel, libraryUrl, queueDigest, takeDigests } = await import("../src/links-digest.ts");

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 10, 14, 9);
const link = (title: string, shares = 1, topics = ["agents"], at = T0) => ({ title, url: `https://example.com/${encodeURIComponent(title)}`, topics, shares, lastSharedAt: at });

beforeEach(() => {
  process.env.LINKS_DIGEST_CHANNEL = "#guild";
  db.exec("DELETE FROM links; DELETE FROM links_fts; DELETE FROM link_seen; DELETE FROM links_digests; DELETE FROM channel_members; DELETE FROM channels");
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query(`INSERT INTO accounts (account_id, nick, email, role, kind, owner, verified_at, created_at) VALUES ('acct-ada', 'ada', 'ada@example.test', 'member', 'human', NULL, 1, 1)`).run();
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#guild', 'ada', 'secret', 1), ('#links', 'ada', 'workspace', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#guild', 'ada'), ('#links', 'ada'), ('#links', 'links')").run();
});

test("the post names the count, the most shared three and where the rest are", () => {
  expect(digestLines([], "https://guild.example.test/#links")).toEqual([]);
  expect(libraryUrl("#links")).toBe("https://guild.example.test/#links");
  const lines = digestLines([
    link("Quiet one", 1, ["tooling"], T0 - DAY),
    link("Most shared", 3, ["claude-code", "workflow", "agents"]),
    link("Newer single", 1, [], T0),
    link("Second", 2),
    link("x".repeat(150)),
  ], "https://guild.example.test/#links");
  expect(lines).toEqual([
    "5 new links from Slack today:",
    "• [Most shared](https://example.com/Most%20shared) (claude-code, workflow)",
    "• [Second](https://example.com/Second) (agents)",
    "• [Newer single](https://example.com/Newer%20single)",
    "[2 more in the library](https://guild.example.test/#links)",
  ]);
  expect(digestLines([link("Only")], "https://guild.example.test/#links")).toEqual([
    "1 new link from Slack today:",
    "• [Only](https://example.com/Only) (agents)",
    "[In the library](https://guild.example.test/#links)",
  ]);
  expect(digestLines([link("Line\nbreak"), link("y".repeat(150), 9)], "u")[1]).toBe(`• [${"y".repeat(99)}…](https://example.com/${"y".repeat(150)}) (agents)`);
});

test("a title's brackets and a URL's parenthesis or space keep the link whole in Slirc", () => {
  const [, line] = digestLines([{ title: "Read [this] first", url: "https://en.wikipedia.org/wiki/Foo_(bar) baz", topics: [], shares: 1, lastSharedAt: T0 }], "https://guild.example.test/#links");
  expect(line).toBe("• [Read (this) first](https://en.wikipedia.org/wiki/Foo_(bar%29%20baz)");
  const segments = textSegments(line!).filter((segment) => segment.href);
  expect(segments.map((segment) => [segment.text, segment.href])).toEqual([["Read (this) first", "https://en.wikipedia.org/wiki/Foo_(bar%29%20baz"]]);
});

test("the import collects only links new to the library, in a dry run too", () => {
  const csv = [
    "date,channel,title,link,summary,author,source,topics,shared_by",
    "2026-11-13,dev_tech_links,Fresh,https://example.com/fresh,,,blog,agents tooling,Ada Example",
    "2026-11-13,gophers,Fresh again,https://example.com/fresh/,,,blog,agents,Ben Example",
    "2026-11-13,gophers,Known,https://example.com/known,,,blog,tooling,Ada Example",
  ].join("\n");
  importLinks(importRowsFromCsv(csv.split("\n").filter((line) => !line.includes("fresh")).join("\n")));
  const dry: any[] = [];
  importLinks(importRowsFromCsv(csv), { dryRun: true, added: dry });
  expect(dry.map((item) => [item.title, item.shares, item.topics])).toEqual([["Fresh", 2, ["agents", "tooling"]]]);
  const real: any[] = [];
  const report = importLinks(importRowsFromCsv(csv), { added: real });
  expect(real.map((item) => item.url)).toEqual(["https://example.com/fresh"]);
  expect(JSON.stringify(report)).not.toContain("example.com");
});

test("a queued post goes out once, only after the helper joined, and a day-old one is dropped", () => {
  delete process.env.LINKS_DIGEST_CHANNEL;
  expect(queueDigest(["a"], T0)).toBe(false);
  process.env.LINKS_DIGEST_CHANNEL = "#guild";
  expect(queueDigest([], T0)).toBe(false);
  expect(queueDigest(["line one", "line two"], T0)).toBe(true);
  expect(takeDigests(new Set(["#links"]), T0 + 5_000)).toEqual([]);
  expect(takeDigests(new Set(["#guild"]), T0 + 10_000)).toEqual([{ channel: "#guild", body: "line one\nline two" }]);
  expect(takeDigests(new Set(["#guild"]), T0 + 15_000)).toEqual([]);
  queueDigest(["late"], T0);
  expect(takeDigests(new Set(), T0 + DAY + 1)).toEqual([]);
  expect(takeDigests(new Set(["#guild"]), T0 + DAY + 2)).toEqual([]);
});

test("the helper joins the digest channel but saves nothing there and gives it no Links view", async () => {
  await ensureDigestChannel();
  expect(db.query("SELECT channel FROM channel_members WHERE nick = 'links' ORDER BY channel").all()).toEqual([{ channel: "#guild" }, { channel: "#links" }]);
  expect(linksChannelsFor("ada")).toEqual(["#links"]);
  expect(collectFromMessage({ channel: "#guild", nick: "ada", text: "https://example.com/a", msgid: "m1", time: "2026-11-14T10:00:00Z" })).toEqual([]);
  // The links home is never post-only, even when it is the digest channel too.
  process.env.LINKS_DIGEST_CHANNEL = "#links";
  expect(linksChannelsFor("ada").sort()).toEqual(["#guild", "#links"]);
});
