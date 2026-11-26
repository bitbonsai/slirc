// What the links helper keeps from channels: a member's links, once, scoped to a private channel
// when the channel is private, and nothing from bots, code, GIFs or this workspace's own pages.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://guild.example.test";
process.env.SLIRC_HELPERS = "help,links";

import { beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { searchLinks, linkFacets, deleteScopedLinks, renameLinksChannel } = await import("../src/links.ts");
const { collectFromMessage, collectable, ensureLinksHome, extractUrls, joinLinksHomeOnce, linksChannelsFor, linksHome, messageTitle, resetLinkLimits, saveLink } = await import("../src/links-collect.ts");

const pages: Record<string, { title: string; description: string; site: string; image: string } | null> = {};
const fetched: string[] = [];
const describe = async (url: string) => { fetched.push(url); return pages[url] ?? null; };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const post = (channel: string, nick: string, text: string, msgid = crypto.randomUUID()) => collectFromMessage({ channel, nick, text, msgid, time: "2026-11-11T10:00:00.000Z", describe });

function account(nick: string, kind = "human"): { id: string; nick: string; kind: any; verifiedAt: number } {
  db.query(`INSERT INTO accounts (account_id, nick, email, role, kind, owner, verified_at, created_at) VALUES (?, ?, ?, 'member', ?, NULL, 1, 1)`).run(`acct-${nick}`, nick, `${nick}@example.test`, kind);
  return { id: `acct-${nick}`, nick, kind, verifiedAt: 1 };
}

beforeEach(() => {
  process.env.SLIRC_HELPERS = "help,links";
  delete process.env.LINKS_CHANNEL;
  resetLinkLimits();
  fetched.length = 0;
  for (const key of Object.keys(pages)) delete pages[key];
  db.exec("DELETE FROM links; DELETE FROM links_fts; DELETE FROM link_seen; DELETE FROM channel_members; DELETE FROM channels; DELETE FROM meta WHERE key LIKE 'links-home-joined:%'");
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query("UPDATE accounts SET role = 'admin', verified_at = COALESCE(verified_at, 1) WHERE nick = 'bitbonsai'").run();
  account("ada"); account("ben"); account("robo", "agent"); account("poll", "bot");
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#general', 'ada', 'workspace', 1), ('#vault', 'ada', 'secret', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#general', 'ada'), ('#general', 'ben'), ('#general', 'links'), ('#vault', 'ada'), ('#vault', 'links')").run();
});

test("addresses are read out of a message, without the ones in code or the punctuation around them", () => {
  expect(extractUrls("see https://example.com/a, and (https://example.com/b).")).toEqual(["https://example.com/a", "https://example.com/b"]);
  expect(extractUrls("https://en.wikipedia.org/wiki/Rust_(programming_language)")).toEqual(["https://en.wikipedia.org/wiki/Rust_(programming_language)"]);
  expect(extractUrls("run `curl https://example.com/x` or\n```\nhttps://example.com/y\n```\nthen https://example.com/z")).toEqual(["https://example.com/z"]);
  expect(extractUrls("mailto:sam@example.com ftp://example.com/a javascript:alert(1) www.example.com")).toEqual([]);
  expect(extractUrls("https://example.com/a https://example.com/a")).toEqual(["https://example.com/a"]);
  expect(messageTitle("worth a read https://example.com/a  on agents")).toBe("worth a read on agents");
  expect(collectable("https://guild.example.test/uploads/1.png")).toBe(false);
  expect(collectable("https://media.giphy.com/media/abc/giphy.gif")).toBe(false);
  expect(collectable("https://example.com/a")).toBe(true);
});

test("a member's link is saved with their account, and the page's title replaces the working one", async () => {
  pages["https://example.com/post"] = { title: "A real title", description: "What the page says.", site: "Example", image: "" };
  const [saved] = post("#general", "ada", "nice one https://example.com/post");
  expect(saved.state).toBe("saved");
  // Saved at once, before the page is read.
  expect(searchLinks("ben").rows[0].title).toBe("nice one");
  await settle();
  const row = searchLinks("ben").rows[0];
  expect([row.title, row.summary, row.sharedByName, row.sharedByAccount, row.scope, row.shareCount]).toEqual(["A real title", "What the page says.", "ada", "acct-ada", "", 1]);
  expect(row.origins).toEqual(["#general"]);
  expect(row.firstSharedAt).toBe(Date.parse("2026-11-11T10:00:00.000Z"));
});

test("an X post keeps the poster's words as its title, and a page with no title keeps the address", async () => {
  pages["https://x.com/sam/status/5"] = { title: "Sam on X", description: "", site: "X", image: "" };
  post("#general", "ada", "Sam explains evals in one thread https://x.com/sam/status/5");
  post("#general", "ada", "https://example.com/deep/path/");
  await settle();
  const titles = searchLinks("ada").rows.map((row) => row.title).sort();
  expect(titles).toEqual(["Sam explains evals in one thread", "example.com/deep/path"]);
});

test("a repeat only adds a share and fetches nothing; the same message is never counted twice", async () => {
  post("#general", "ada", "https://example.com/a", "msg-1");
  await settle();
  expect(fetched.length).toBe(1);
  expect(post("#general", "ben", "again https://www.example.com/a/?utm_source=x", "msg-2")[0].state).toBe("repeat");
  // A replayed line with the same msgid.
  expect(post("#general", "ben", "again https://www.example.com/a/?utm_source=x", "msg-2")[0].state).toBe("seen");
  await settle();
  expect(fetched.length).toBe(1);
  const row = searchLinks("ada").rows[0];
  expect([row.shareCount, row.sharedByName]).toEqual([2, "ada"]);
  expect((db.query("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(1);
});

test("nothing is kept from bots, agents, strangers, DMs, threads, GIFs or this workspace's own links", () => {
  for (const nick of ["robo", "poll", "links", "nobody"]) expect(post("#general", nick, "https://example.com/bot")).toEqual([]);
  expect(post("#dm-abc123", "ada", "https://example.com/dm")).toEqual([]);
  expect(post("#t-abc123", "ada", "https://example.com/thread")).toEqual([]);
  expect(post("ada", "ada", "https://example.com/query")).toEqual([]);
  expect(post("#general", "ada", "lol https://media.giphy.com/media/x/giphy.gif")[0].state).toBe("invalid");
  expect(post("#general", "ada", "see https://guild.example.test/?room=%23general&msg=1")[0].state).toBe("invalid");
  expect(post("#general", "ada", "`https://example.com/code`")).toEqual([]);
  expect(searchLinks("ada").total).toBe(0);
  process.env.SLIRC_HELPERS = "help";
  expect(post("#general", "ada", "https://example.com/off")).toEqual([]);
});

test("a private channel's link stays with its members, and a later public share copies nothing from it", async () => {
  pages["https://x.com/sam/status/9"] = null;
  post("#vault", "ada", "this is our acquisition target https://x.com/sam/status/9");
  expect(searchLinks("ada", { channel: "#vault" }).rows.map((row) => [row.title, row.scope])).toEqual([["this is our acquisition target", "#vault"]]);
  for (const query of [{}, { q: "acquisition" }, { channel: "#vault" }, { origin: "#vault" }]) expect(searchLinks("ben", query).total).toBe(0);
  expect(JSON.stringify(linkFacets("ben"))).not.toContain("vault");

  post("#general", "ben", "pricing thread https://x.com/sam/status/9");
  await settle();
  expect(searchLinks("ben").rows.map((row) => row.title)).toEqual(["pricing thread"]);
  expect(searchLinks("ben", { q: "acquisition" }).total).toBe(0);
  expect((db.query("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n).toBe(2);
  // A channel with no row at all is treated as private.
  post("#mystery", "ada", "https://example.com/m");
  expect((db.query("SELECT scope FROM links WHERE url_key = 'example.com/m'").get() as { scope: string }).scope).toBe("#mystery");
});

test("a removed link is not brought back by a channel post, only by asking for it", async () => {
  const [saved] = post("#general", "ada", "https://example.com/gone");
  db.query("UPDATE links SET removed_at = 5, title = '' WHERE id = ?").run(saved.id);
  db.query("DELETE FROM links_fts WHERE rowid = ?").run(saved.id);
  expect(post("#general", "ben", "https://example.com/gone")[0].state).toBe("removed");
  expect(searchLinks("ada").total).toBe(0);
  const back = saveLink({ url: "https://example.com/gone", scope: "", origin: "", sharer: { id: "acct-ben", nick: "ben" }, message: "bring it back https://example.com/gone", restore: true, describe });
  expect(back).toEqual({ id: saved.id, state: "saved" });
  const row = searchLinks("ada").rows[0];
  expect([row.title, row.sharedByName, row.shareCount]).toEqual(["bring it back", "ben", 1]);
});

test("one person can add thirty new links an hour; repeats do not count", () => {
  for (let index = 0; index < 30; index++) expect(post("#general", "ada", `https://example.com/n/${index}`)[0].state).toBe("saved");
  expect(post("#general", "ada", "https://example.com/n/31")[0].state).toBe("limited");
  expect(post("#general", "ada", "https://example.com/n/3")[0].state).toBe("repeat");
  expect(post("#general", "ben", "https://example.com/n/31")[0].state).toBe("saved");
});

test("the home channel is made once, the helper is in it, and each member joins it once", async () => {
  expect(linksHome()).toBe("#links");
  await ensureLinksHome();
  await ensureLinksHome();
  expect(db.query("SELECT owner, visibility FROM channels WHERE channel = '#links'").get()).toEqual({ owner: "bitbonsai", visibility: "workspace" });
  expect(db.query("SELECT COUNT(*) AS n FROM channel_members WHERE channel = '#links' AND nick = 'links'").get()).toEqual({ n: 1 });
  const ada = { id: "acct-ada", nick: "ada", kind: "human" as const, verifiedAt: 1 };
  expect(joinLinksHomeOnce(ada)).toBe(true);
  expect(linksChannelsFor("ada").sort()).toEqual(["#general", "#links", "#vault"]);
  expect(linksChannelsFor("ben").sort()).toEqual(["#general"]);
  // Someone who leaves is not added again.
  db.query("DELETE FROM channel_members WHERE channel = '#links' AND nick = 'ada'").run();
  expect(joinLinksHomeOnce(ada)).toBe(false);
  expect(linksChannelsFor("ada")).not.toContain("#links");
  expect(joinLinksHomeOnce({ id: "acct-robo", nick: "robo", kind: "agent", verifiedAt: 1 })).toBe(false);
  process.env.SLIRC_HELPERS = "help";
  expect(linksChannelsFor("ada")).toEqual([]);
  expect(joinLinksHomeOnce({ id: "acct-ben", nick: "ben", kind: "human", verifiedAt: 1 })).toBe(false);
});

test("a deleted channel takes its private links with it, and a renamed one keeps them under the new name", () => {
  post("#vault", "ada", "secret https://example.com/v");
  post("#general", "ada", "open https://example.com/g");
  renameLinksChannel("#vault", "#bunker");
  db.query("UPDATE channel_members SET channel = '#bunker' WHERE channel = '#vault'").run();
  expect(searchLinks("ada", { channel: "#bunker" }).total).toBe(1);
  expect((db.query("SELECT COUNT(*) AS n FROM links WHERE scope = '#vault' OR origins LIKE '%vault%'").get() as { n: number }).n).toBe(0);
  expect(deleteScopedLinks("#bunker")).toBe(1);
  expect(searchLinks("ada").rows.map((row) => row.title)).toEqual(["open"]);
  expect((db.query("SELECT COUNT(*) AS n FROM links_fts").get() as { n: number }).n).toBe(1);
});
