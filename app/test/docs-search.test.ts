import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAll, searchIndex, sectionsOf } from "../scripts/build-docs.ts";
// @ts-expect-error plain JS module shipped to the browser
import { createSearch, expandQuery, isMatch, searchDocs, snippetOf, stem } from "../public/docs/search.js";

const pageFile = (page: string) => (page ? `${page}/index.html` : "index.html");

test("sections split on h2-h4 with their anchors and plain text", () => {
  const html = '<p>Intro &amp; more.</p>\n<h2 id="first">First <code>one</code></h2>\n<p>Alpha <strong>beta</strong>.</p>\n<h3 id="deeper">Deeper</h3>\n<ul><li>Gamma</li></ul>';
  expect(sectionsOf("demo", "Demo", html)).toEqual([
    { page: "demo", title: "Demo", heading: "", anchor: "", text: "Intro & more." },
    { page: "demo", title: "Demo", heading: "First one", anchor: "first", text: "Alpha beta." },
    { page: "demo", title: "Demo", heading: "Deeper", anchor: "deeper", text: "Gamma" },
  ]);
});

test("index covers every page and every anchor exists on its page", () => {
  const pages = renderAll();
  const index = searchIndex();
  const covered = new Set(index.map((entry) => pageFile(entry.page)));
  for (const path of Object.keys(pages)) expect(covered.has(path), path).toBe(true);
  for (const entry of index) {
    expect(entry.title, entry.page).toBeTruthy();
    expect(entry.text + entry.heading).not.toMatch(/<\/(p|a|code|strong|em|li|ul|ol|div|span|h\d)>|<(p|li|ul|ol|strong|em)>|&amp;|&lt;/);
    if (entry.anchor) expect(pages[pageFile(entry.page)], `${entry.page}#${entry.anchor}`).toContain(`id="${entry.anchor}"`);
  }
});

test("generated search.json matches the sources", () => {
  const file = readFileSync(join(import.meta.dir, "..", "public", "docs", "search.json"), "utf8");
  expect(file, "run: cd app && bun run docs").toBe(JSON.stringify(searchIndex()));
});

test("every page carries the labelled search combobox in the header, not the sidebar", () => {
  for (const [path, html] of Object.entries(renderAll())) {
    const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf("</header>"));
    const sidebar = html.slice(html.indexOf('<nav class="sidebar"'), html.indexOf("</nav>"));
    expect(header, path).toContain('<label class="visually-hidden" for="docs-search-input">Search the docs</label>');
    expect(header, path).toMatch(/role="combobox"[^>]*aria-controls="docs-search-results"/);
    expect(header, path).toContain('<div id="docs-search-results" class="docs-search-results" role="listbox"');
    expect(header, path).toMatch(/<button class="search-toggle"[^>]*aria-label="Search the docs"[^>]*aria-controls="docs-search"/);
    expect(sidebar, path).not.toContain("docs-search");
    expect(html, path).toMatch(/<script type="module" src="\/docs\/search\.js\?v=[0-9a-f]{8}&amp;index=[0-9a-f]{8}">/);
  }
});

test("only the home page opens its content with the large search box", () => {
  for (const [path, html] of Object.entries(renderAll())) {
    const main = html.slice(html.indexOf('<main id="main">'));
    if (path === "index.html") {
      expect(main, path).toMatch(/^<main id="main">\s*<div class="docs-search" id="docs-home-search" role="search" data-docs-search>/);
      expect(main, path).toContain('<label class="visually-hidden" for="docs-home-search-input">Search the docs</label>');
      expect(main, path).toMatch(/role="combobox"[^>]*aria-controls="docs-home-search-results"/);
    } else expect(main, path).not.toContain("docs-search");
  }
});

test("the header field steps aside while the home page's big box is visible", () => {
  const css = readFileSync(join(import.meta.dir, "..", "public", "docs", "docs.css"), "utf8");
  const js = readFileSync(join(import.meta.dir, "..", "public", "docs", "search.js"), "utf8");
  expect(css).toMatch(/\.topbar\.home-search-visible \.docs-search, \.topbar\.home-search-visible \.search-toggle \{ display: none !important; \}/);
  expect(js).toContain("new IntersectionObserver");
  expect(js).toMatch(/classList\.toggle\("home-search-visible", entry\.isIntersecting\)/);
});

const fixture = [
  { page: "", title: "Home", heading: "", anchor: "", text: "Welcome. Every guide is in the menu, agents and invitations included." },
  { page: "channels", title: "Channels", heading: "", anchor: "", text: "Rooms for your team." },
  { page: "channels", title: "Channels", heading: "Invite people", anchor: "invite-people", text: "Send an invitation from the channel menu." },
  { page: "channels", title: "Channels", heading: "Remove a channel", anchor: "remove-a-channel", text: "Owners can remove a channel from settings." },
  { page: "agents", title: "Agents", heading: "", anchor: "", text: "Coding agents join a channel." },
  { page: "agents", title: "Agents", heading: "Rename", anchor: "rename", text: "Rename the agent from its menu." },
  { page: "download", title: "Download and install", heading: "iPhone", anchor: "iphone", text: "Join the TestFlight beta." },
  { page: "notifications", title: "Notifications", heading: "", anchor: "", text: "Push alerts for mentions." },
];
const top = (query: string) => searchDocs(createSearch(fixture), query).map((result: any) => `${result.page}#${result.anchor}`);

test("stemming folds plurals and verb forms onto one term", () => {
  expect(["invite", "invites", "inviting", "invited"].map(stem)).toEqual(["invit", "invit", "invit", "invit"]);
  expect(stem("agents")).toBe("agent");
  expect(stem("Café")).toBe("caf");
  expect(stem("press")).toBe("press");
});

test("fuzzy and prefix matching forgive typos and unfinished words", () => {
  expect(top("notifcations")[0]).toBe("notifications#");
  expect(top("invitaton")).toContain("channels#invite-people");
  expect(top("testfl")[0]).toBe("download#iphone");
  expect(top("zzzz")).toEqual([]);
  expect(top("  ")).toEqual([]);
});

test("synonyms map the words people type onto the docs' words", () => {
  expect(expandQuery("iPhone")).toEqual([["iphone", "testflight", "ios"]]);
  expect(expandQuery("forgot password")).toEqual([["forgot"], ["password", "sign"]]);
  expect(expandQuery("how do I delete it?")).toEqual([["delete", "remove"]]);
  expect(top("ios")[0]).toBe("download#iphone");
  expect(top("claude")[0]).toMatch(/^agents#/);
  expect(top("delete channel")[0]).toBe("channels#remove-a-channel");
});

test("ranking: every word must match, title and heading beat body text", () => {
  expect(top("agents")[0]).toBe("agents#");
  expect(top("agents").indexOf("agents#")).toBeLessThan(top("agents").indexOf("#"));
  expect(top("invite")[0]).toBe("channels#invite-people");
  expect(top("rename agent")).toEqual(["agents#rename"]);
  expect(searchDocs(createSearch(fixture), "channel", 2)).toHaveLength(2);
});

test("snippets center on the first matched word, and matched words are found for highlighting", () => {
  const text = `${"word ".repeat(40)}TestFlight build ${"tail ".repeat(40)}`.trim();
  const matched = new Set(["testflight"]);
  const snippet = snippetOf(text, matched);
  expect(snippet.startsWith("…")).toBe(true);
  expect(snippet.endsWith("…")).toBe(true);
  expect(snippet).toContain("TestFlight build");
  expect(snippet.length).toBeLessThanOrEqual(122);
  expect(snippetOf("Short text.", new Set(["missing"]))).toBe("Short text.");
  expect(isMatch("Invites", new Set(["invit"]))).toBe(true);
  expect(isMatch("word", new Set(["invit"]))).toBe(false);
});

test("real docs: agents, invite and testflight find the right pages", () => {
  const search = createSearch(searchIndex());
  const pages = (query: string) => searchDocs(search, query).map((result: any) => result.page);
  expect(pages("agents").slice(0, 3)).toEqual(["agents", "agents", "agents"]);
  expect(pages("invite")[0]).toBe("channels");
  expect(searchDocs(search, "testflight")[0]).toMatchObject({ page: "download", anchor: "iphone" });
  expect(searchDocs(search, "iphone")[0]).toMatchObject({ page: "download", anchor: "iphone" });
  expect(pages("claude")[0]).toBe("agents");
  expect(pages("self-hosting")[0]).toBe("setup");
  expect(pages("self-host")[0]).toBe("setup");
});
