import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { llmsContent, mdAssets, redirectPages, renderAll } from "../scripts/build-docs.ts";

const HOME = "index.html";
const PATHS = [HOME, "getting-started/index.html", "download/index.html", "channels/index.html", "messages/index.html", "threads/index.html", "notifications/index.html", "privacy/index.html", "clients/index.html", "agents/index.html", "bots/index.html", "setup/index.html", "about/index.html", "comparison/index.html", "faq/index.html", "design/index.html"];

test("docs render every page with one active nav item", () => {
  const pages = renderAll();
  for (const path of PATHS) expect(pages[path], path).toBeDefined();
  for (const html of Object.values(pages)) {
    expect(html).toContain('<main id="main">');
    expect(html).toContain('id="docs-nav"');
    const navigation = html.match(/<nav[^>]*id="docs-nav"[\s\S]*?<\/nav>/)?.[0] || "";
    expect(navigation.match(/aria-current="page"/g)?.length ?? 0).toBe(1);
  }
});

test("docs nav puts Open chat at the top, above the first section", () => {
  for (const [path, html] of Object.entries(renderAll({}))) {
    const content = html.match(/<div class="nav-content">\s*([\s\S]*?)<\/div>/)?.[1] || "";
    expect(content, path).toMatch(/^<a class="nav-link nav-app" href="\/open-chat">Open chat<\/a>\s*<p class="nav-section">Guides<\/p>/);
    expect(content.match(/nav-app/g)?.length, path).toBe(1);
  }
});

test("setup page opens with the install video, served from /media", () => {
  const html = renderAll({})["setup/index.html"];
  const video = html.match(/<video class="doc-video"[^>]*>/)?.[0] || "";
  expect(html.indexOf(video)).toBeLessThan(html.indexOf("Elastic License 2.0"));
  for (const src of video.match(/\/media\/[\w.-]+/g) || []) expect(existsSync(join(import.meta.dir, "..", "public", src)), src).toBe(true);
  expect(video).toContain('src="/media/self-host-install.mp4"');
  expect(video).toContain('poster="/media/self-host-install-poster.png"');
  expect(video).not.toContain("style=");
});

test("docs links resolve to generated pages", () => {
  const pages = renderAll();
  const resolve = (href: string) => (href === "/docs" ? HOME : `${href.replace(/^\/docs\//, "")}/index.html`);
  for (const [path, html] of Object.entries(pages)) {
    for (const match of html.matchAll(/href="(\/docs[^"#]*)/g)) {
      const href = match[1];
      if (/\./.test(href)) continue;
      expect(pages[resolve(href)], `${path} -> ${href}`).toBeDefined();
    }
  }
});

test("channel guide matches current controls", () => {
  const channels = renderAll()["channels/index.html"];
  for (const fact of ["Open channels", "Invite-only channels", "Send invite", "/invite", "Leave channel", "Channel settings", "Star", "Mute", "Topic", "Visibility", "Archive", "Delete channel", "Browse channels", "+R", "+s", "+m"]) {
    expect(channels).toContain(fact);
  }
  for (const fact of ["nine invitation emails", "More → Invitations", "seven days", "sends no email", "Pending invitations", "Group creation is not offered"]) expect(channels).toContain(fact);
  expect(channels).not.toContain("five email invites");
  expect(channels).not.toContain("Transfer ownership");
  for (const gone of ["Invite link", "Copied channel links", "reusable and do not expire", "Edit topic", "Make invite-only", "Make open"]) expect(channels).not.toContain(gone);
});

test("messages guide lists the commands the current client implements", () => {
  const messages = renderAll()["messages/index.html"];
  for (const fact of ["/help", "/me", "/msg", "/threads", "/giphy", "/whois", "/remind", "/reconnect", "/leave"]) expect(messages).toContain(fact);
  for (const gone of ["/join", "/emoji add", "/history", "/clear", "/nick"]) expect(messages).not.toContain(gone);
});

test("docs stay honest about invitations, renames, anonymous reading and reminder delivery", () => {
  const pages = renderAll();
  const start = pages["getting-started/index.html"];
  expect(start).not.toContain("/nick");
  expect(start).toContain("You can change your display name any time under <strong>You</strong>; your nick stays the same.");
  expect(start).toContain("can read recent <code>#open-chat</code> messages at <code>/open-chat</code>");
  expect(start).toContain("Only signed-in members can read <code>#help</code>");
  expect(start).not.toContain("invite arrives on Oct. 6th");
  expect(start).not.toContain("without an account");
  expect(start).toContain("keeps participant presence hidden in the Slirc app");
  expect(pages["privacy/index.html"]).not.toContain("readable by anyone");
  expect(pages["privacy/index.html"]).toContain("does not currently offer anonymous reading");
  expect(pages["privacy/index.html"]).toContain("does not yet promise IRC invisibility");
  expect(pages["channels/index.html"]).toContain("open to every registered member");
  expect(pages["channels/index.html"]).toContain("does not yet promise IRC invisibility");
  expect(pages["about/index.html"]).toContain("can read recent <code>#open-chat</code> messages at <code>/open-chat</code>, and nothing else");
  expect(pages["bots/index.html"]).not.toContain("delivered once");
  expect(pages["bots/index.html"]).toContain("only when it can prove the first one never arrived");
});

test("docs carry the early access banner on every page", () => {
  for (const [path, html] of Object.entries(renderAll({}))) {
    expect(html, path).toContain('Slirc is in early access. Come say hi in <a href="/open-chat">#open-chat</a>.');
    expect(html, path).not.toContain("invite-only pre-launch");
  }
});

test("about, clients, and agents pages stay within their claims", () => {
  const pages = renderAll();
  expect(pages["about/index.html"]).toContain("Slack's interaction model on top of IRC");
  expect(pages["clients/index.html"]).toContain("port <code>6697</code> with TLS");
  expect(pages["clients/index.html"]).toContain('data-irc-nick');
  expect(pages["clients/index.html"]).toContain('[servers.{{server}}]');
  expect(pages["clients/index.html"]).toContain("buffer.server_messages.change_mode");
  expect(pages["clients/index.html"]).toContain("Senpai");
  // Pi, Claude Code, Codex and OpenCode work today; no retired setup commands.
  const agents = pages["agents/index.html"];
  expect(agents).toContain("Pi, Claude Code, Codex and OpenCode work with Slirc today");
  expect(agents).toContain("Claude Code");
  expect(agents).not.toContain("bunx slirc-agent@latest connect");
  expect(agents).not.toContain("slirc-agent wait");
  expect(agents).not.toContain("list_channels");
});



test("download page leads with the apps, and /docs/install forwards to it", () => {
  const pages = renderAll({});
  const download = pages["download/index.html"];
  for (const fact of ["desktop/", "native/", "TESTFLIGHT_URL", "Install this site as an app", "Install page as app", "/docs/clients"]) expect(download).toContain(fact);
  expect(download).not.toContain("https://slirc.app/download/Slirc.dmg");
  expect(download).not.toContain("https://testflight.apple.com/join/t5w2AfBk");
  expect(download).toContain('href="/docs/download" aria-current="page">Download</a>');
  expect(pages["install/index.html"]).toBeUndefined();
  const stub = redirectPages()["install/index.html"];
  expect(stub).toContain('url=/docs/download"');
  expect(stub).toContain('<link rel="canonical" href="/docs/download" />');
  expect(stub).toContain('<script src="/docs/moved.js"></script>');
});

test("docs point at open chat, not a waiting list", () => {
  for (const [path, html] of Object.entries(renderAll({}))) {
    expect(html, path).not.toMatch(/waitlist|waiting list|request an invite/i);
    expect(html, path).toContain('href="/open-chat">Open chat</a>');
  }
});

test("docs stay neutral by default and honor DOCS_APP_ORIGIN and DOCS_ORIGIN", () => {
  const neutral = renderAll({});
  expect(neutral["clients/index.html"]).toContain("chat.example.com");
  expect(neutral["clients/index.html"]).not.toContain("{{host}}");
  expect(neutral["clients/index.html"]).not.toContain("app.slirc.org");
  expect(neutral["bots/index.html"]).toContain("chat.example.com");
  expect(neutral["bots/index.html"]).not.toContain("{{host}}");
  expect(neutral["bots/index.html"]).not.toContain("app.slirc.org");
  expect(neutral["setup/index.html"]).not.toContain("slirc.app/#pricing");
  expect(neutral["getting-started/index.html"]).not.toContain("Mauricio");
  expect(neutral["getting-started/index.html"]).not.toContain("@bitbonsai");

  const defaultLlms = llmsContent({});
  expect(defaultLlms).toContain("served under /docs/.");
  expect(defaultLlms).toContain("(/docs/clients.md)");
  expect(defaultLlms).not.toContain("app.slirc.org");
  expect(defaultLlms).not.toContain("docs.slirc.org");

  const hostedEnv = { DOCS_APP_ORIGIN: "https://chat.example.test", DOCS_ORIGIN: "https://docs.example.test" };
  const hosted = renderAll(hostedEnv);
  expect(hosted["clients/index.html"]).toContain("server = &quot;chat.example.test&quot;");
  expect(hosted["bots/index.html"]).toContain("<code>chat.example.test</code>");
  expect(hosted["index.html"]).toContain('href="https://chat.example.test/open-chat">Open chat</a>');

  const hostedLlms = llmsContent(hostedEnv);
  expect(hostedLlms).toContain("Web app at https://chat.example.test, IRC clients on chat.example.test:6697");
  expect(hostedLlms).toContain("served under https://docs.example.test/docs/.");
  expect(hostedLlms).toContain("(https://docs.example.test/docs/clients.md)");
});

test("markdown copies include every source page", () => {
  const assets = mdAssets();
  expect(Object.keys(assets).sort()).toEqual(Object.values(assets).map((path) => path.split("/").at(-1)!).sort());
});

test("built docs are not stale: public copies match app/docs sources", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  for (const [dest, source] of Object.entries(mdAssets())) {
    expect(readFileSync(join(import.meta.dir, "..", "public", "docs", dest), "utf8")).toBe(readFileSync(source as string, "utf8"));
  }
});
