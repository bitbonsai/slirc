// Shared behavior for the Slirc documentation site. No dependencies.
(function () {
  "use strict";

  const toggle = document.getElementById("menu-toggle");
  const nav = document.getElementById("docs-nav");
  const toc = document.getElementById("page-nav");
  const layout = document.querySelector(".layout");
  const mobile = () => window.matchMedia("(max-width: 879px)").matches;
  let backdrop = null;

  // Live examples on the design page. Delegated, and not inline handlers, so they survive
  // client-side page swaps and run under the app's CSP.
  document.addEventListener("focusin", (event) => {
    const select = event.target.closest?.("select[data-theme-preview]");
    if (select) select.value = document.documentElement.dataset.theme || "dark";
  });
  document.addEventListener("change", (event) => {
    const select = event.target.closest?.("select[data-theme-preview]");
    if (select) document.documentElement.dataset.theme = select.value;
  });
  document.addEventListener("click", (event) => {
    event.target.closest?.("[data-dismiss-toast]")?.closest(".glass-toast")?.remove();
  });
  document.addEventListener("submit", (event) => {
    if (event.target.closest?.(".ds-example")) event.preventDefault();
  });
  let pageAbort = null;
  let navigationId = 0;
  let renderedPath = location.pathname + location.search;
  const pageCache = new Map();

  function openMenu() {
    if (!nav) return;
    nav.hidden = false;
    toggle?.setAttribute("aria-expanded", "true");
    toggle?.setAttribute("aria-label", "Close documentation menu");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "nav-backdrop";
      backdrop.addEventListener("click", closeMenu);
    }
    layout?.prepend(backdrop);
    document.body.style.overflow = "hidden";
  }

  function closeMenu() {
    if (!nav) return;
    nav.hidden = mobile();
    toggle?.setAttribute("aria-expanded", "false");
    toggle?.setAttribute("aria-label", "Open documentation menu");
    backdrop?.remove();
    document.body.style.overflow = "";
  }

  function applyLayout() {
    if (!nav) return;
    if (mobile()) nav.hidden = true;
    else {
      nav.hidden = false;
      backdrop?.remove();
      document.body.style.overflow = "";
    }
  }

  function scrollToHash(hash) {
    const id = decodeURIComponent((hash || "").replace(/^#/, ""));
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function enhancePage(main) {
    pageAbort?.abort();
    pageAbort = new AbortController();
    const { signal } = pageAbort;

    const builder = main.querySelector("[data-irc-config]");
    if (builder) {
      const nickInput = builder.querySelector("[data-irc-nick]");
      const serverInput = builder.querySelector("[data-irc-server]");
      const codes = Array.from(main.querySelectorAll("pre code")).filter((code) => /\{\{(?:nick|server)\}\}/.test(code.textContent || ""));
      for (const code of codes) code.dataset.ircTemplate = code.textContent || "";
      const stored = (key) => { try { return localStorage.getItem(key) || ""; } catch { return ""; } };
      const save = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
      const clean = (value, fallback) => value.trim().replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || fallback;
      const params = new URLSearchParams(location.search);
      const savedNick = stored("slirc-docs-irc-nick");
      nickInput.value = params.get("nick") || savedNick || nickInput.value;
      serverInput.value = params.get("server") || stored("slirc-docs-irc-server") || serverInput.value;
      const renderConfig = () => {
        const nick = clean(nickInput.value, "yournick");
        const server = clean(serverInput.value, "slirc");
        save("slirc-docs-irc-nick", nickInput.value);
        save("slirc-docs-irc-server", serverInput.value);
        for (const code of codes) {
          const text = code.dataset.ircTemplate.replaceAll("{{nick}}", nick).replaceAll("{{server}}", server);
          if (window.__glow) code.innerHTML = window.__glow(text, { prefix: false, mark: true });
          else code.textContent = text;
          code.closest("pre").dataset.glowed = "1";
        }
      };
      nickInput.addEventListener("input", renderConfig, { signal });
      serverInput.addEventListener("input", renderConfig, { signal });
      renderConfig();
      if (!params.has("nick") && !savedNick) {
        fetch("/auth/me", { credentials: "same-origin" })
          .then((response) => response.ok ? response.json() : null)
          .then((account) => {
            if (!account?.authenticated || !account.nick) return;
            nickInput.value = account.nick;
            renderConfig();
          })
          .catch(() => {});
      }
    }

    for (const summary of main.querySelectorAll("details summary")) {
      if (!summary.querySelector(".chevron")) {
        summary.insertAdjacentHTML("afterbegin", '<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>');
      }
    }

    toc?.replaceChildren();
    if (toc) {
      // The design system page has dozens of subsections; its contents list stays at section level.
      const headings = Array.from(main.querySelectorAll(main.querySelector(".ds") ? "h2" : "h2, h3"));
      toc.hidden = headings.length === 0;
      if (headings.length) {
        const list = document.createElement("ol");
        const used = new Set();
        headings.forEach((heading, index) => {
          const base = heading.textContent.trim().toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || `section-${index + 1}`;
          // Build-time ids win: search results and in-app links point at them.
          let id = heading.id || base;
          for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
          used.add(id);
          heading.id = id;
          const item = document.createElement("li");
          item.className = heading.tagName === "H3" ? "toc-h3" : "toc-h2";
          const link = document.createElement("a");
          link.href = `#${id}`;
          link.textContent = heading.textContent.trim();
          item.appendChild(link);
          list.appendChild(item);
        });
        toc.appendChild(list);
        toc.addEventListener("click", (event) => {
          const link = event.target.closest('a[href^="#"]');
          if (!link) return;
          const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
          if (!target) return;
          event.preventDefault();
          history.pushState({ ...history.state, docsDepth: ((history.state && history.state.docsDepth) || 0) + 1 }, "", link.hash);
          scrollToHash(link.hash);
        }, { signal });

        const links = Array.from(list.querySelectorAll("a"));
        const byHeading = new Map(links.map((link) => [document.getElementById(link.hash.slice(1)), link]));
        let ticking = false;
        const setCurrent = () => {
          const line = 110;
          let current = headings[0];
          for (const heading of headings) if (heading.getBoundingClientRect().top <= line) current = heading;
          links.forEach((link) => link.classList.toggle("active", link === byHeading.get(current)));
        };
        window.addEventListener("scroll", () => {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(() => { setCurrent(); ticking = false; });
        }, { passive: true, signal });
        setCurrent();
      }
    }

    for (const pre of main.querySelectorAll("pre")) {
      const code = pre.querySelector("code");
      if (code && !pre.dataset.glowed && window.__glow) {
        code.innerHTML = window.__glow(code.textContent || "", { prefix: false, mark: true });
        pre.dataset.glowed = "1";
      }
      if (pre.querySelector(".copy-btn")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-btn";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code to clipboard");
      button.addEventListener("click", async () => {
        const text = (pre.querySelector("code")?.textContent || "").replace(/\n\s*$/, "");
        button.textContent = "Copied";
        button.classList.add("copied");
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const area = document.createElement("textarea");
          area.value = text;
          document.body.appendChild(area);
          area.select();
          document.execCommand("copy");
          area.remove();
        }
        setTimeout(() => { button.textContent = "Copy"; button.classList.remove("copied"); }, 1600);
      }, { signal });
      pre.appendChild(button);
    }
  }

  function updateNav(nextDoc) {
    const activeHref = nextDoc.getElementById("docs-nav")?.querySelector("a[aria-current]")?.getAttribute("href");
    for (const link of nav?.querySelectorAll("a[href]") || []) {
      const active = link.getAttribute("href") === activeHref;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function swap(nextDoc, url, push) {
    const nextMain = nextDoc.querySelector("main");
    const currentMain = document.querySelector("main");
    if (!nextMain || !currentMain) return false;
    currentMain.replaceWith(nextMain);
    document.title = nextDoc.title;
    const nextDescription = nextDoc.querySelector('meta[name="description"]')?.getAttribute("content");
    if (nextDescription) document.querySelector('meta[name="description"]')?.setAttribute("content", nextDescription);
    updateNav(nextDoc);
    renderedPath = url.pathname + url.search;
    if (push) history.pushState({ path: renderedPath, docsDepth: ((history.state && history.state.docsDepth) || 0) + 1 }, "", url.pathname + url.search + url.hash);
    if (mobile()) closeMenu();
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    enhancePage(nextMain);
    // search.js wires any search box the new page brings (the home page has one).
    document.dispatchEvent(new Event("docs:page"));
    return true;
  }

  async function fetchPage(url) {
    const path = url.pathname + url.search;
    let html = pageCache.get(path);
    if (!html) {
      const response = await fetch(path, { headers: { Accept: "text/html" } });
      if (!response.ok) throw new Error(`${response.status}`);
      html = await response.text();
      pageCache.set(path, html);
    }
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function navigate(url, push) {
    const id = ++navigationId;
    let nextDoc;
    try {
      nextDoc = await fetchPage(url);
    } catch {
      if (id === navigationId) location.href = url.href;
      return;
    }
    if (id !== navigationId || !nextDoc.querySelector("main")) return;

    const doSwap = () => swap(nextDoc, url, push);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const transition = !reduced && document.startViewTransition?.(doSwap);
    if (transition) await transition.finished;
    else doSwap();
    if (id === navigationId && url.hash) scrollToHash(url.hash);
  }

  function shouldIntercept(event, link) {
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (link.target || link.hasAttribute("download")) return false;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/docs") || /\.[a-z0-9]+$/i.test(url.pathname)) return false;
    return !(url.pathname + url.search === renderedPath && url.hash);
  }

  toggle?.addEventListener("click", () => (nav?.hidden ? openMenu() : closeMenu()));
  nav?.addEventListener("click", (event) => {
    if (event.target.closest("a") && mobile()) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav && !nav.hidden && mobile()) {
      closeMenu();
      toggle?.focus();
    }
  });
  window.matchMedia("(min-width: 880px)").addEventListener?.("change", applyLayout);

  const navLinks = nav ? Array.from(nav.querySelectorAll('a[href^="/"]')) : [];
  nav?.addEventListener("keydown", (event) => {
    let index = navLinks.indexOf(document.activeElement);
    if (index === -1) return;
    if (event.key === "ArrowDown") index = Math.min(navLinks.length - 1, index + 1);
    else if (event.key === "ArrowUp") index = Math.max(0, index - 1);
    else return;
    event.preventDefault();
    navLinks[index].focus();
    navLinks[index].scrollIntoView({ block: "nearest" });
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest("a[href]");
    if (!shouldIntercept(event, link)) return;
    event.preventDefault();
    navigate(new URL(link.href, location.href), true);
  });

  window.addEventListener("popstate", () => {
    const url = new URL(location.href);
    if (url.pathname + url.search === renderedPath) scrollToHash(url.hash);
    else navigate(url, false);
  });

  applyLayout();
  const initialMain = document.querySelector("main");
  if (initialMain) enhancePage(initialMain);
  if (location.hash) requestAnimationFrame(() => scrollToHash(location.hash));
})();
