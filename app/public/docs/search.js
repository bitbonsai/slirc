// Docs search over the static index built by scripts/build-docs.ts (search.json).
// MiniSearch does the ranking (BM25 with fuzzy and prefix matching); the rest is plain DOM.
// The search functions are exported for tests.
import MiniSearch from "../vendor/minisearch.js";

const fold = (value) => value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Light suffix stemming so "invites", "inviting" and "invited" meet at "invit".
export function stem(word) {
  let out = fold(word);
  const strip = (suffix, replacement = "") => {
    if (out.endsWith(suffix) && out.length - suffix.length >= 3) { out = out.slice(0, -suffix.length) + replacement; return true; }
    return false;
  };
  if (!strip("ies", "y")) strip("ing") || strip("ed") || strip("es") || (!out.endsWith("ss") && strip("s"));
  strip("e");
  return out;
}

const STOP = new Set("a an and are can do does for from how i in is it my of on or should the to what when where which who why with you your".split(" "));

// Words people type for things the docs name differently. Keys and values are plain words or phrases.
export const SYNONYMS = {
  iphone: ["testflight", "ios"],
  ios: ["testflight", "iphone"],
  ipad: ["testflight", "iphone"],
  android: ["install"],
  phone: ["install", "iphone"],
  mac: ["install", "desktop"],
  claude: ["agents"],
  pi: ["agents"],
  codex: ["agents"],
  opencode: ["agents"],
  ai: ["agents"],
  bot: ["agents", "bots"],
  password: ["sign in"],
  login: ["sign in"],
  logout: ["sign out"],
  signin: ["sign in"],
  delete: ["remove"],
  remove: ["delete"],
  erase: ["delete"],
  room: ["channel"],
  group: ["channel"],
  dm: ["direct messages"],
  pm: ["direct messages"],
  push: ["notifications"],
  alert: ["notifications"],
  selfhost: ["self-hosting", "setup"],
  server: ["setup"],
  weechat: ["irc clients"],
  halloy: ["irc clients"],
  reply: ["thread"],
  member: ["people"],
  user: ["people", "member"],
};

const tokens = (text) => fold(text).split(/[^a-z0-9]+/).filter(Boolean);

// Query words minus filler ("how do I ..."), each with its synonyms as alternatives.
export function expandQuery(query) {
  const words = tokens(query);
  const kept = words.filter((word) => !STOP.has(word));
  // Phrase synonyms drop their filler too: "sign in" searches as "sign".
  const plain = (phrase) => tokens(phrase).filter((word) => !STOP.has(word)).join(" ");
  return (kept.length ? kept : words).map((word) => [word, ...(SYNONYMS[word] || []).map(plain).filter(Boolean)]);
}

export function createSearch(entries) {
  const search = new MiniSearch({
    fields: ["title", "crumb", "heading", "text"],
    storeFields: ["page", "title", "heading", "anchor", "text"],
    processTerm: (term) => (term ? stem(term) : null),
    searchOptions: {
      boost: { title: 3, crumb: 2.5, heading: 2, text: 1 },
      prefix: (term) => term.length > 2,
      fuzzy: (term) => (term.length > 4 ? 0.2 : false),
      // A page's own intro edges out its sections when the title matches.
      boostDocument: (_id, _term, stored) => (stored && !stored.anchor ? 1.2 : 1),
    },
  });
  search.addAll(entries.map((entry, id) => ({ id, ...entry })));
  return search;
}

// Every query word must match (itself, a synonym, or a near spelling of either).
export function searchDocs(search, query, limit = 8) {
  const groups = expandQuery(query);
  if (!groups.length) return [];
  const queries = groups.map((alternatives) => ({
    combineWith: "OR",
    queries: alternatives.map((alt) => ({ combineWith: "AND", queries: [alt] })),
  }));
  return search.search({ combineWith: "AND", queries }).slice(0, limit);
}

// Does this word of the text count as one the query matched? `matched` are stemmed index terms.
export function isMatch(word, matched) {
  const term = stem(word);
  return !!term && matched.has(term);
}

// About 120 characters of the section text around the first matched word.
export function snippetOf(text, matched, size = 120) {
  let first = -1;
  for (const found of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (isMatch(found[0], matched)) { first = found.index; break; }
  }
  let start = first > 30 ? first - 30 : 0;
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < first) start = space + 1;
  }
  let end = Math.min(text.length, start + size);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start) end = space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

// Paths resolve against this script, so the docs work under any prefix.
const base = typeof document === "undefined" ? null : new URL("./", import.meta.url);
let search = null;
const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || "");
let loading = null;

// One index for every box on the page, fetched on first focus.
const load = () => (loading ||= fetch(new URL(`search.json?v=${new URL(import.meta.url).searchParams.get("index") || ""}`, base))
  .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`${response.status}`))))
  .then((entries) => (search = createSearch(entries)))
  .catch(() => { loading = null; return null; }));

const hrefOf = (entry) => {
  const page = entry.page ? new URL(entry.page, base).pathname : base.pathname.replace(/\/$/, "");
  return entry.anchor ? `${page}#${entry.anchor}` : page;
};

function highlight(element, text, matched) {
  let last = 0;
  for (const found of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!isMatch(found[0], matched)) continue;
    element.append(text.slice(last, found.index));
    const mark = document.createElement("mark");
    mark.textContent = found[0];
    element.append(mark);
    last = found.index + found[0].length;
  }
  element.append(text.slice(last));
}

// Wire one [data-docs-search] block: its combobox input, listbox and live status.
function wire(box, { onEscape } = {}) {
  const input = box.querySelector(".docs-search-input");
  const list = box.querySelector(".docs-search-results");
  const status = box.querySelector(".docs-search-status");
  if (!input || !list || !status || box.dataset.wired) return;
  box.dataset.wired = "1";
  const key = box.querySelector(".docs-search-key");
  if (key && !isMac) key.textContent = "Ctrl K";
  let options = [];
  let active = -1;

  function setActive(next) {
    options[active]?.setAttribute("aria-selected", "false");
    active = next;
    const option = options[active];
    if (option) {
      option.setAttribute("aria-selected", "true");
      option.scrollIntoView({ block: "nearest" });
      input.setAttribute("aria-activedescendant", option.id);
    } else input.removeAttribute("aria-activedescendant");
  }

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    setActive(-1);
  }

  function say(message, visible) {
    status.textContent = message;
    status.classList.toggle("shown", visible);
  }

  async function update() {
    const query = input.value;
    if (!query.trim()) {
      list.replaceChildren();
      options = [];
      say("", false);
      close();
      return;
    }
    if (!search && !(await load())) return say("Search is unavailable right now.", true);
    if (query !== input.value) return;
    options = searchDocs(search, query).map((result, i) => {
      const matched = new Set(result.terms);
      const option = document.createElement("a");
      option.id = `${list.id}-option-${i}`;
      option.className = "docs-search-option";
      option.href = hrefOf(result);
      option.tabIndex = -1;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      const where = document.createElement("span");
      where.className = "docs-search-where";
      where.textContent = result.heading ? `${result.title} › ${result.heading}` : result.title;
      const snippet = document.createElement("span");
      snippet.className = "docs-search-snippet";
      highlight(snippet, snippetOf(result.text, matched), matched);
      option.append(where, snippet);
      return option;
    });
    list.replaceChildren(...options);
    active = -1;
    const open = options.length > 0;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    say(open ? `${options.length} ${options.length === 1 ? "result" : "results"}` : "No matching sections.", !open);
    if (open) setActive(0);
  }

  function clear() {
    input.value = "";
    update();
  }

  input.addEventListener("focus", () => { load(); if (input.value.trim()) update(); });
  input.addEventListener("input", update);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!options.length) return;
      event.preventDefault();
      if (list.hidden) { list.hidden = false; input.setAttribute("aria-expanded", "true"); }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((active + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      const option = options[active] || options[0];
      if (!option || list.hidden) return;
      event.preventDefault();
      option.click();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      if (!list.hidden) close();
      else if (input.value) clear();
      else if (onEscape) onEscape();
      else input.blur();
    }
  });
  // Keep focus in the field while a result is pressed, so the click lands.
  list.addEventListener("pointerdown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    if (!event.target.closest(".docs-search-option")) return;
    clear();
    input.blur();
  });
  box.addEventListener("focusout", (event) => {
    if (!box.contains(event.relatedTarget)) close();
  });
  return { input, clear };
}

function setup() {
  const topbar = document.querySelector(".topbar");
  const box = document.getElementById("docs-search");
  const toggle = document.getElementById("search-toggle");
  if (!box) return;

  // Phone width: the header field is hidden until the search icon opens it over the header.
  const openField = () => { topbar?.classList.add("searching"); toggle?.setAttribute("aria-expanded", "true"); };
  const closeField = (refocus) => {
    if (!topbar?.classList.contains("searching")) return;
    topbar.classList.remove("searching");
    toggle?.setAttribute("aria-expanded", "false");
    if (refocus) toggle?.focus();
  };
  const header = wire(box, { onEscape: () => (topbar?.classList.contains("searching") ? closeField(true) : header.input.blur()) });
  toggle?.addEventListener("click", () => { openField(); header.input.focus(); });
  box.addEventListener("focusout", (event) => {
    if (!box.contains(event.relatedTarget) && event.relatedTarget !== toggle) closeField(false);
  });

  // "/" and Cmd+K go to the home page's big box while it is on screen, else to the header field.
  const focusHeader = () => {
    const pageInput = topbar?.classList.contains("home-search-visible") && document.querySelector("main [data-docs-search] .docs-search-input");
    const input = pageInput || header.input;
    if (!pageInput && !input.offsetParent) openField();
    input.focus();
    input.select();
  };
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      return focusHeader();
    }
    if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) return;
    event.preventDefault();
    focusHeader();
  });

  // Boxes inside the page (the home page's big one) come and go with in-app navigation.
  // While the home page's big box is visible, the header field and its icon step aside.
  let observer = null;
  const wirePage = () => {
    document.querySelectorAll("main [data-docs-search]").forEach((pageBox) => wire(pageBox));
    observer?.disconnect();
    topbar?.classList.remove("home-search-visible");
    const homeBox = document.querySelector("main [data-docs-search]");
    if (!homeBox || !topbar || typeof IntersectionObserver === "undefined") return;
    // The sticky top bar covers the top of the viewport, so the box counts as gone once it slides under it.
    observer = new IntersectionObserver(([entry]) => {
      topbar.classList.toggle("home-search-visible", entry.isIntersecting);
      if (entry.isIntersecting) closeField(false);
    }, { rootMargin: `-${topbar.offsetHeight}px 0px 0px 0px` });
    observer.observe(homeBox);
  };
  wirePage();
  document.addEventListener("docs:page", wirePage);
}

if (typeof document !== "undefined") setup();
