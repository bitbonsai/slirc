// The picker's rules for which addresses the shell accepts and when a saved one opens. A plain
// script with no imports or exports: index.html loads it with a script tag, and
// native/test/picker.test.ts imports it, and both read globalThis.slircPicker. It needs match.js
// (generated from app/shared/match.ts) loaded first.
(() => {
  const NOT_FOUND = "We couldn't find a workspace at that address. Check the spelling.";
  const UNREACHABLE = "We couldn't reach your workspace. Check your connection, or enter a different address.";
  const couldntReach = (origin) => "We couldn't reach " + hostOf(origin) + ". Try again, or pick another workspace.";

  // "ai-guild", "ai-guild.slirc.app" and "https://ai-guild.slirc.app/x" all mean one origin. The
  // answer is always https://<host>: any other scheme, a port, or userinfo is refused.
  function workspaceOrigin(value) {
    let text = String(value || "").trim().toLowerCase();
    if (text.includes("://")) {
      if (!text.startsWith("https://")) return null;
      text = text.slice("https://".length);
    }
    let host = text.split(/[/?#]/, 1)[0].replace(/\.$/, "");
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return null;
    if (!host.includes(".")) host += ".slirc.app";
    return "https://" + host;
  }

  // hosts is window.SLIRC_HOSTS, written by write-hosts.ts. "*" allows any valid https origin
  // (still verified via /api/version before opening). Specific patterns match equal label counts
  // with "*" standing for one label, e.g. "*.slirc.app".
  function opens(origin, hosts) {
    if (typeof origin !== "string" || !origin.startsWith("https://")) return false;
    const host = origin.slice("https://".length).split(".");
    return hosts.some((pattern) => {
      if (pattern === "*") return true;
      const parts = pattern.split(".");
      return parts.length === host.length && parts.every((part, i) => part === "*" || part === host[i]);
    });
  }

  // A workspace is a host whose /api/version returns its client version as JSON, so arbitrary
  // websites and unclaimed subdomains never open in the shell. http is Capacitor's native HTTP
  // plugin, since the page cannot read another origin's answer. "unknown" means we got no usable
  // answer (offline, timeout, a restart in progress), which is never proof that the workspace is gone.
  async function isWorkspace(http, origin, timeout) {
    if (!http) return "unknown";
    try {
      const answer = await http.get({
        url: origin + "/api/version",
        headers: { Accept: "application/json" },
        responseType: "json",
        disableRedirects: true,
        connectTimeout: timeout,
        readTimeout: timeout,
      });
      if (answer.status >= 500) return "unknown";
      let body = answer.data;
      if (typeof body === "string") try { body = JSON.parse(body); } catch { body = null; }
      return answer.status === 200 && body && /^[0-9a-f]{6,40}$/.test(String(body.version)) ? "yes" : "no";
    } catch {
      return "unknown";
    }
  }

  // Screens a slirc:// link may open. Any app can claim a custom scheme, so such a link may come
  // from anywhere. It never opens a screen that carries a pairing, sign-in, invitation or join
  // token, and never takes a query string. Those links work only over https, which iOS hands to
  // the app only for hosts that list it in their apple-app-site-association file.
  const SCHEME_PATHS = /^\/(dm\/[^/]+|channels|invitations|profile|settings|clients|agents)?$/;

  // A link the app was opened with: an https Universal Link, or slirc://<host>/<path>, which stands
  // for https://<host>/<path>. Returns { origin, url } when the host passes the same checks as a
  // typed address, or null.
  function linkTarget(value, hosts) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      return null;
    }
    const path = url.pathname || "/";
    if (url.protocol === "slirc:") {
      if (url.search || !SCHEME_PATHS.test(path)) return null;
    } else if (url.protocol !== "https:") return null;
    if (url.username || url.password || url.port) return null;
    const origin = workspaceOrigin(url.hostname);
    if (!origin || !opens(origin, hosts)) return null;
    return { origin, url: origin + path + (url.protocol === "https:" ? url.search : "") + url.hash };
  }

  // Slirc's own workspace. The picker offers it with one tap until it is saved.
  const OPEN_WORKSPACE = "https://app.slirc.org";

  function offersOpenWorkspace(store, hosts) {
    return opens(OPEN_WORKSPACE, hosts) && !store.workspaces.includes(OPEN_WORKSPACE);
  }

  // The store is { workspaces, last }: the saved origins in the order they were added, and the one
  // used last, which a launch opens. Preferences keeps them as the strings raw holds:
  // raw.workspaces is a JSON array, raw.last an origin, and raw.legacy the single "workspace"
  // value that earlier builds saved. Every entry goes through the same checks as typed text, and
  // anything that fails them is dropped. changed says whether the stored strings need rewriting.
  function readStore(raw, hosts) {
    const valid = (value) => {
      const origin = typeof value === "string" ? workspaceOrigin(value) : null;
      return origin && opens(origin, hosts) ? origin : null;
    };
    let list = [];
    try {
      const parsed = JSON.parse(raw.workspaces ?? "[]");
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
    const workspaces = [];
    for (const value of raw.legacy == null ? list : [...list, raw.legacy]) {
      const origin = valid(value);
      if (origin && !workspaces.includes(origin)) workspaces.push(origin);
    }
    let last = valid(raw.last == null ? raw.legacy : raw.last);
    if (!workspaces.includes(last)) last = null;
    const changed = raw.legacy != null || JSON.stringify(workspaces) !== (raw.workspaces ?? "[]") || last !== (raw.last ?? null);
    return { store: { workspaces, last }, changed };
  }

  // Adding a saved origin again only makes it the last used one.
  function addWorkspace(store, origin) {
    const workspaces = store.workspaces.includes(origin) ? store.workspaces : [...store.workspaces, origin];
    return { workspaces, last: origin };
  }

  function removeWorkspace(store, origin) {
    return { workspaces: store.workspaces.filter((saved) => saved !== origin), last: store.last === origin ? null : store.last };
  }

  // What a launch does with the store. load() returns the raw strings and persist(store) writes
  // them back. Returns { open: origin, store } to navigate, with url set when a link names a page, or { show: origin, message, store } for
  // the picker, where show fills the field and failed, when set, is a workspace that couldn't be reached. check(origin) is isWorkspace with the launch timeout.
  // An error from persist() after a "no" rejects, and the caller shows an empty picker.
  async function launch({ load, persist, check, hosts, params }) {
    let store = { workspaces: [], last: null };
    let loaded = false;
    try {
      const read = readStore(await load(), hosts);
      if (read.changed) await persist(read.store);
      store = read.store;
      loaded = true;
    } catch {
      store = { workspaces: [], last: null };
    }
    // ?link= is a link the app was opened with. It opens once its host proves to be a workspace,
    // which also saves a new one. A refused link is ignored and the launch carries on as usual.
    // When the saved list could not be read, the link opens unsaved: writing it then would leave a
    // list of one in place of every saved workspace.
    const target = params.has("link") ? linkTarget(params.get("link"), hosts) : null;
    if (target) {
      const found = await check(target.origin);
      if (found !== "yes") return { show: target.origin, message: found === "no" ? NOT_FOUND : UNREACHABLE, store };
      if (!loaded) return { open: target.origin, url: target.url, store };
      const next = addWorkspace(store, target.origin);
      await persist(next);
      return { open: target.origin, url: target.url, store: next };
    }
    // ?unreachable=<origin> comes from the shell when that workspace failed to load or its client
    // never started. The picker marks it and offers Try again. Older pages send ?unreachable=1.
    if (params.has("unreachable")) {
      const failed = unreachableOrigin(params.get("unreachable"), hosts);
      return failed ? { show: null, message: couldntReach(failed), failed, store } : { show: null, message: UNREACHABLE, store };
    }
    if (!store.last || params.has("pick")) return { show: null, message: "", store };
    // A saved address that answers but is not a workspace is forgotten. No answer at all still opens
    // the workspace, so an offline launch ends on the unreachable page with the address kept.
    if ((await check(store.last)) === "no") {
      const next = removeWorkspace(store, store.last);
      await persist(next);
      return { show: store.last, message: NOT_FOUND, store: next };
    }
    return { open: store.last, store };
  }

  // The origin in ?unreachable=, only when it is already a full origin that passes the usual checks.
  function unreachableOrigin(value, hosts) {
    const origin = workspaceOrigin(value);
    return origin && origin === String(value) && opens(origin, hosts) ? origin : null;
  }

  const hostOf = (origin) => origin.replace(/^https:\/\//, "");
  // ai-guild.slirc.app is "ai-guild"; app.slirc.org is "Slirc"; any other host is its first label.
  const nameOf = (origin) => (origin === OPEN_WORKSPACE ? "Slirc" : hostOf(origin).split(".")[0]);

  // The field above the cards narrows them by name and host as you type, like the web client's
  // workspace dialog (filterWorkspaces in app/client/workspace-mark.ts). With no card left, open is
  // what to offer instead: the typed text read as an address (origin, null when it isn't one) and
  // the label its row shows. An empty field keeps every card.
  function filterWorkspaces(origins, query) {
    const typed = String(query || "").trim();
    const text = typed.toLowerCase().replace(/^https:\/\//, "");
    if (!text) return { matches: origins, open: null };
    const matches = globalThis.slircMatch.rankMatches(origins, text, (origin) => [nameOf(origin), hostOf(origin)]);
    if (matches.length) return { matches, open: null };
    const origin = workspaceOrigin(typed);
    return { matches: [], open: { origin, label: origin ? hostOf(origin) : typed } };
  }

  globalThis.slircPicker = { NOT_FOUND, UNREACHABLE, couldntReach, unreachableOrigin, OPEN_WORKSPACE, offersOpenWorkspace, hostOf, nameOf, filterWorkspaces, workspaceOrigin, opens, isWorkspace, linkTarget, readStore, addWorkspace, removeWorkspace, launch };
})();
