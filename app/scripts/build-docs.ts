// Build the static docs site from markdown sources.
//
//   Edit app/docs/*.md   →   bun run docs   →   app/public/docs/
//
// The app server serves the generated HTML as plain static files; nothing
// here runs in production. Rendering uses Bun.markdown (built into Bun), so
// there is no dependency for the docs.

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { escapeHtml } from "../shared/escape-html.ts";

const SRC_DIR = join(import.meta.dir, "..", "docs");
const OUT_DIR = join(import.meta.dir, "..", "public", "docs");
// Docs share the app's appearance script; its content hash busts caches when it changes.
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 8);
const THEME_JS_V = hash(readFileSync(join(import.meta.dir, "..", "public", "theme.js")));
const SEARCH_JS_V = hash(readFileSync(join(OUT_DIR, "search.js")));
const APP_BACK_JS_V = hash(readFileSync(join(OUT_DIR, "app-back.js")));

// page key -> source markdown file; output path is derived (home → index.html).
const PAGES: Record<string, string> = {
  home: "home.md",
  "getting-started": "getting-started.md",
  download: "download.md",
  channels: "channels.md",
  messages: "messages.md",
  threads: "threads.md",
  notifications: "notifications.md",
  privacy: "privacy.md",
  clients: "clients.md",
  about: "about.md",
  agents: "agents.md",
  bots: "bots.md",
  comparison: "comparison.md",
  setup: "setup.md",
  faq: "faq.md",
  design: "design.md",
};

// Old page keys that moved. Each gets a stub page that forwards, keeping any #section.
const REDIRECTS: Record<string, string> = { install: "download" };

const NAV: { href: string; label: string; sub?: boolean; section?: string }[] = [
  { href: "/docs", label: "Home" },
  { href: "/docs/getting-started", label: "Getting started" },
  { href: "/docs/download", label: "Download" },
  { href: "/docs/channels", label: "Channels & invites" },
  { href: "/docs/messages", label: "Messages & media" },
  { href: "/docs/threads", label: "Threads", sub: true },
  { href: "/docs/notifications", label: "Notifications" },
  { href: "/docs/privacy", label: "Privacy & safety" },
  { href: "/docs/clients", label: "IRC clients", section: "Connect" },
  { href: "/docs/agents", label: "Agents" },
  { href: "/docs/bots", label: "Bots" },
  { href: "/docs/setup", label: "Self-hosting" },
  { href: "/docs/design", label: "Design system", section: "Reference" },
  { href: "/docs/about", label: "About Slirc", section: "About" },
  { href: "/docs/comparison", label: "Footprint" },
  { href: "/docs/faq", label: "FAQ" },
];

export type DocsConfig = {
  appOrigin: string;
  docsOrigin: string;
  host: string;
  openChatHref: string;
  docsBase: string;
};

function normalizeOrigin(value: string | undefined): string {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return new URL(trimmed).origin;
}

export function docsConfig(env: NodeJS.ProcessEnv = process.env): DocsConfig {
  const appOrigin = normalizeOrigin(env.DOCS_APP_ORIGIN);
  const docsOrigin = normalizeOrigin(env.DOCS_ORIGIN);
  const host = appOrigin ? new URL(appOrigin).hostname : "chat.example.com";
  const openChatHref = appOrigin ? `${appOrigin}/open-chat` : "/open-chat";
  const docsBase = docsOrigin ? `${docsOrigin}/docs` : "/docs";
  return { appOrigin, docsOrigin, host, openChatHref, docsBase };
}


function navHtml(activeKey: string, openChatHref: string): string {
  let out = `      <a class="nav-link nav-app" href="${escapeHtml(openChatHref)}">Open chat</a>\n      <p class="nav-section">Guides</p>\n`;
  let section = "";
  for (const { href, label, sub, section: itemSection } of NAV) {
    if (itemSection && itemSection !== section) {
      out += `      <p class="nav-section">${itemSection}</p>\n`;
      section = itemSection;
    }
    const isActive = href === (activeKey === "home" ? "/docs" : `/docs/${activeKey}`);
    const classes = ["nav-link", sub ? "sub" : "", isActive ? "active" : ""].filter(Boolean).join(" ");
    const current = isActive ? ' aria-current="page"' : "";
    out += `      <a class="${classes}" href="${href}"${current}>${label}</a>\n`;
  }
  return out.trimEnd();
}

// GitHub-style slugs so in-app links can point at a section (e.g. /docs/getting-started#your-name-and-nick).
function addHeadingIds(html: string): string {
  const seen = new Map<string, number>();
  return html.replace(/<h([2-4])>([\s\S]*?)<\/h\1>/g, (_match, level, inner) => {
    const base = inner.replace(/<[^>]+>/g, "").replace(/&[a-z]+;|&#\d+;/g, "").toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-") || "section";
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
}

// A labelled combobox driving a listbox; search.js wires every [data-docs-search] block.
function searchBox(id: string, placeholder: string, indent: string): string {
  return [
    `<div class="docs-search" id="${id}" role="search" data-docs-search>`,
    `  <label class="visually-hidden" for="${id}-input">Search the docs</label>`,
    `  <span class="docs-search-field">`,
    `    <svg class="docs-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/></svg>`,
    `    <input id="${id}-input" class="docs-search-input" type="search" placeholder="${placeholder}" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="${id}-results" aria-autocomplete="list" />`,
    `    <kbd class="docs-search-key" aria-hidden="true">⌘K</kbd>`,
    `  </span>`,
    `  <div id="${id}-results" class="docs-search-results" role="listbox" aria-label="Search results" hidden></div>`,
    `  <p class="docs-search-status visually-hidden" aria-live="polite"></p>`,
    `</div>`,
  ].map((line) => indent + line).join("\n");
}

function shell(opts: { appMoreHref: string; home: boolean; indexV: string; htmlTitle: string; description: string; crumb: string; heading: string; body: string; nav: string; pager: string; mdUrl: string; openChatHref: string }): string {
  return `<!-- generated from app/docs/*.md — edit there, then run: bun run docs -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#11111b" />
  <meta name="color-scheme" content="light dark" />
  <meta name="description" content="${escapeHtml(opts.description)}" />
  <title>${escapeHtml(opts.htmlTitle)}</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
  <link rel="alternate" type="text/markdown" href="${opts.mdUrl}" />
  <script src="/theme.js?v=${THEME_JS_V}"></script>
  <link rel="stylesheet" href="/docs/docs.css?v=39" />
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="app-back" id="app-back" hidden><a class="app-back-link" href="${escapeHtml(opts.appMoreHref)}" aria-label="Back to Slirc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 4 12l7 7"/></svg>Back</a></div>

  <header class="topbar">
    <button class="menu-toggle" id="menu-toggle" type="button" aria-label="Open documentation menu" aria-expanded="false" aria-controls="docs-nav">
      <svg class="menu-icon menu-bars" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>
      <svg class="menu-icon menu-close" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
    <a class="brand" href="/docs"><img class="brand-lockup" src="/brand-org-dark.svg" width="233" height="73" alt="Slirc" /><span class="tag">docs</span></a>
    <button class="search-toggle" id="search-toggle" type="button" aria-label="Search the docs" aria-expanded="false" aria-controls="docs-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 4.5 4.5"/></svg>
    </button>
${searchBox("docs-search", "Search docs…", "    ")}
    <a class="open-app-mobile" href="${escapeHtml(opts.openChatHref)}">Open chat</a>
  </header>

  <div class="layout">
    <nav class="sidebar" id="docs-nav" aria-label="Documentation" hidden>
      <div class="nav-content">
${opts.nav}
      </div>
    </nav>

    <main id="main">
${opts.home ? searchBox("docs-home-search", "Search the docs", "      ") + "\n" : ""}      <div class="callout info prelaunch-note"><p>Slirc is in early access. Come say hi in <a href="${escapeHtml(opts.openChatHref)}">#open-chat</a>.</p></div>
${opts.crumb}${opts.heading}${opts.body}
      <footer class="doc-footer">
        <p class="doc-footer-meta"><a href="/docs">All guides</a> · <a href="${opts.mdUrl}">markdown</a></p>
        <nav class="pager" aria-label="Page navigation">
${opts.pager}
        </nav>
      </footer>
    </main>
    <nav class="toc" id="page-nav" aria-label="On this page"></nav>
  </div>

  <script type="module" src="/docs/glow.js"></script>
  <script src="/docs/docs.js?v=16" defer></script>
  <script src="/docs/app-back.js?v=${APP_BACK_JS_V}" defer></script>
  <script type="module" src="/docs/search.js?v=${SEARCH_JS_V}&amp;index=${opts.indexV}"></script>
</body>
</html>
`;
}

// Front matter: `key: value` lines until the first blank line.
function parseFrontMatter(source: string): { fm: Record<string, string>; body: string } {
  const lines = source.split("\n");
  const fm: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    const match = line.match(/^([a-z-]+):\s*(.*)$/);
    if (match) fm[match[1]] = match[2];
  }
  return { fm, body: lines.slice(i).join("\n") };
}

function pagerHtml(activeKey: string): string {
  const items = NAV.filter(({ href }) => href.startsWith("/docs"));
  const current = activeKey === "home" ? "/docs" : `/docs/${activeKey}`;
  const index = items.findIndex(({ href }) => href === current);
  const box = (item: (typeof items)[number] | null, side: "prev" | "next") => {
    if (!item) return `        <span class="pager-box ${side} empty" aria-hidden="true"></span>`;
    const label = side === "prev" ? "← Previous" : "Next →";
    return `        <a class="pager-box ${side}" href="${item.href}"><small>${label}</small><span>${item.label}</span></a>`;
  };
  return `${box(items[index - 1] ?? null, "prev")}\n${box(items[index + 1] ?? null, "next")}`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[name as string] as string);
}

function plainText(html: string): string {
  // Block tags break words; inline tags (strong, code, a) sit inside them.
  const block = /<\/?(p|li|ul|ol|h[1-6]|div|pre|br|tr|td|th|table|thead|tbody|blockquote|details|summary|figure|figcaption|section|hr)\b[^>]*>/gi;
  return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(block, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export type SearchEntry = { page: string; title: string; heading: string; anchor: string; text: string; crumb?: string };

// One entry per section: the text before the first heading, then each h2-h4 with its text.
// `page` is relative to the docs root ("" is home), so the client resolves it under any prefix.
export function sectionsOf(page: string, title: string, html: string): SearchEntry[] {
  const parts = html.split(/(?=<h[2-4] id=")/);
  const entries: SearchEntry[] = [];
  for (const part of parts) {
    const head = part.match(/^<h([2-4]) id="([^"]+)">([\s\S]*?)<\/h\1>/);
    const heading = head ? plainText(head[3]) : "";
    const text = plainText(head ? part.slice(head[0].length) : part);
    if (!head && !text) continue;
    entries.push({ page, title, heading, anchor: head ? head[2] : "", text });
  }
  return entries;
}

function render(env: NodeJS.ProcessEnv = process.env): { pages: Record<string, string>; index: SearchEntry[] } {
  const config = docsConfig(env);
  const parsed = Object.entries(PAGES).map(([key, file]) => {
    const source = readFileSync(join(SRC_DIR, file), "utf8").replaceAll("{{host}}", config.host);
    const { fm, body } = parseFrontMatter(source);
    const title = (fm.title || key).trim();
    return { key, file, fm, title, rendered: addHeadingIds(Bun.markdown.html(body.trim() + "\n", { allowHtml: true })) };
  });
  const index = parsed.flatMap(({ key, fm, title, rendered }) => {
    const entries = sectionsOf(key === "home" ? "" : key, title, rendered);
    const lead = (fm.lead || "").trim();
    const crumb = (fm.crumb || "").trim();
    if (lead && entries[0] && !entries[0].anchor) entries[0].text = `${lead} ${entries[0].text}`.trim();
    else if (lead) entries.unshift({ page: key === "home" ? "" : key, title, heading: "", anchor: "", text: lead });
    if (crumb && entries[0] && !entries[0].anchor) entries[0].crumb = crumb;
    return entries;
  });
  const indexV = hash(JSON.stringify(index));
  const pages: Record<string, string> = {};
  for (const { key, file, fm, title, rendered } of parsed) {
    const htmlTitle = key === "home" ? "Slirc docs" : `${title} · Slirc docs`;
    const description = (fm.description || "Slirc documentation").trim();
    const crumb = fm.crumb ? `      <p class="crumb">${escapeHtml(fm.crumb.trim())}</p>\n` : "";
    const heading = fm.lead
      ? `      <h1>${escapeHtml(title)}</h1>\n      <p class="lead">${escapeHtml(fm.lead.trim())}</p>\n`
      : "";
    const html = shell({ appMoreHref: `${config.appOrigin}/more`, home: key === "home", indexV, htmlTitle, description, crumb, heading, body: rendered, nav: navHtml(key, config.openChatHref), pager: pagerHtml(key), mdUrl: `/docs/${file}`, openChatHref: config.openChatHref });
    pages[key === "home" ? "index.html" : `${key}/index.html`] = html;
  }
  return { pages, index };
}

export function renderAll(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return render(env).pages;
}

export function redirectPages(): Record<string, string> {
  const pages: Record<string, string> = {};
  for (const [from, to] of Object.entries(REDIRECTS)) {
    const target = `/docs/${to}`;
    pages[`${from}/index.html`] = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="noindex" />
  <title>Moved · Slirc docs</title>
  <link rel="canonical" href="${target}" />
  <meta http-equiv="refresh" content="0; url=${target}" />
  <script src="/docs/moved.js"></script>
</head>
<body><p>This page moved to <a href="${target}">${target}</a>.</p></body>
</html>
`;
  }
  return pages;
}

export function searchIndex(env: NodeJS.ProcessEnv = process.env): SearchEntry[] {
  return render(env).index;
}

// Markdown copies served alongside the HTML so agents can `read` a page and
// get the plain source back, not the styled page.
export function mdAssets(): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const file of Object.values(PAGES)) assets[file] = join(SRC_DIR, file);
  return assets;
}

export function llmsContent(env: NodeJS.ProcessEnv = process.env): string {
  const { appOrigin, host, docsBase } = docsConfig(env);
  const summary = appOrigin
    ? `> Slack-style chat on IRC (Ergo). Web app at ${appOrigin}, IRC clients on ${host}:6697 (TLS, SASL).`
    : "> Slack-style chat on IRC (Ergo). Web app and IRC clients on port 6697 (TLS, SASL).";
  const lines = [
    "# Slirc",
    "",
    summary,
    "",
    `Markdown sources for the documentation, served under ${docsBase}/. Read these instead of the HTML pages.`,
    "",
    "Coding agents (Pi, Claude Code, Codex and OpenCode) join through `slirc-agent`: paste the command from the Agents page, `npx slirc-agent@latest <workspace> <connect code>`, into a session as your own message and let it run, or run it in a terminal, then press Allow in Slirc; see the Agents page.",
    "",
    "## Docs",
    "",
  ];
  for (const [key, file] of Object.entries(PAGES)) {
    const { fm } = parseFrontMatter(readFileSync(join(SRC_DIR, file), "utf8"));
    const description = (fm.description || fm.lead || "").trim().replace(/\s+/g, " ");
    lines.push(`- [${(fm.title || key).trim()}](${docsBase}/${file})${description ? `: ${description}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

export function build(env: NodeJS.ProcessEnv = process.env): string[] {
  const { pages, index } = render(env);
  for (const [path, html] of Object.entries({ ...pages, ...redirectPages() })) {
    const target = join(OUT_DIR, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
  }
  for (const [dest, source] of Object.entries(mdAssets())) {
    copyFileSync(source, join(OUT_DIR, dest));
  }
  writeFileSync(join(OUT_DIR, "llms.txt"), llmsContent(env));
  writeFileSync(join(OUT_DIR, "search.json"), JSON.stringify(index));
  const written = Object.keys(pages);
  console.log(`docs: wrote ${written.length} pages and their markdown to public/docs (${written.join(", ")})`);
  return written;
}

if (import.meta.main) build();