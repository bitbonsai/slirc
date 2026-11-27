// Generated from app/client/workspace-mark.ts by desktop/picker-assets.ts. Do not edit.
(() => {
function foldIdentifier(value, mapping = "ascii") {
  const lower = value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  if (mapping === "ascii")
    return lower;
  return lower.replace(/[\[\]\\^]/g, (ch) => ({ "[": "{", "]": "}", "\\": "|", "^": mapping === "rfc1459" ? "~" : "^" })[ch]);
}
function foldText(value) {
  return String(value ?? "").toLowerCase();
}
const WORD_CHAR = /[\p{L}\p{N}]/u;
function matchRank(query, ...fields) {
  const needle = foldText(query);
  if (!needle)
    return 2;
  let best = 0;
  for (const field of fields) {
    const text = foldText(field);
    if (text.startsWith(needle))
      return 2;
    for (let at = text.indexOf(needle, 1);at > 0 && best < 1; at = text.indexOf(needle, at + 1)) {
      if (!WORD_CHAR.test(text[at - 1]))
        best = 1;
    }
  }
  return best;
}
function rankMatches(items, query, fields) {
  return items.map((item) => ({ item, rank: matchRank(query, ...fields(item)) })).filter((entry) => entry.rank > 0).sort((a, b) => b.rank - a.rank).map((entry) => entry.item);
}
const WORKSPACE_PALETTE = ["#f5c2e7", "#cba6f7", "#f38ba8", "#eba0ac", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb", "#74c7ec", "#89b4fa", "#b4befe"];
const OWN_HOST = "app.slirc.org";
const TENANT_SUFFIX = ".slirc.app";
function hash(text) {
  let value = 2166136261;
  for (const char of text)
    value = Math.imul(value ^ char.codePointAt(0), 16777619);
  return value >>> 0;
}
function workspaceName(host) {
  const bare = host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (bare === OWN_HOST)
    return "Slirc";
  if (bare.endsWith(TENANT_SUFFIX))
    return bare.slice(0, -TENANT_SUFFIX.length);
  return bare.split(".")[0] || bare;
}
const WORKSPACE_ICON_PATH = "/api/workspace-icon?size=64";
function workspaceIconUrl(origin, iconVersion) {
  if (iconVersion === undefined)
    return origin + WORKSPACE_ICON_PATH;
  return iconVersion ? `${origin}${WORKSPACE_ICON_PATH}&v=${encodeURIComponent(iconVersion)}` : "";
}
function workspaceMark(host, origin = "https://" + host, iconVersion) {
  const name = workspaceName(host);
  const logo = name === "Slirc" ? "/icons/slirc.svg" : "";
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase();
  const icon = logo ? "" : workspaceIconUrl(origin, iconVersion);
  return { name, letter, color: WORKSPACE_PALETTE[hash(name.toLowerCase()) % WORKSPACE_PALETTE.length], logo, icon, iconReady: false };
}
const OPEN_WORKSPACE = "https://app.slirc.org";
function workspaceOrigin(value) {
  let text = String(value || "").trim().toLowerCase();
  if (text.includes("://")) {
    if (!text.startsWith("https://"))
      return null;
    text = text.slice("https://".length);
  }
  let host = text.split(/[/?#]/, 1)[0].replace(/\.$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host))
    return null;
  if (!host.includes("."))
    host += ".slirc.app";
  return "https://" + host;
}
const isHostedOrigin = (origin) => origin === OPEN_WORKSPACE || origin.endsWith(TENANT_SUFFIX);
function workspaceChoices(here, saved) {
  const row = (origin, current, note = "") => {
    const host = origin.replace(/^https?:\/\//, "");
    return { ...workspaceMark(host, origin), origin, host, current, note };
  };
  const rows = [row(here, true)];
  for (const value of saved) {
    const origin = workspaceOrigin(value);
    if (origin && !rows.some((item) => item.origin === origin))
      rows.push(row(origin, false));
  }
  if (isHostedOrigin(here) && !rows.some((item) => item.origin === OPEN_WORKSPACE))
    rows.push(row(OPEN_WORKSPACE, false, "Slirc's own workspace"));
  return rows;
}
const RAIL_MAX = 2;
const RAIL_MOTION = { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)" };
function railWorkspaces(rows, expanded, active = new Set, max = RAIL_MAX) {
  if (rows.length <= max)
    return { shown: rows, peek: null, hidden: 0, foldable: false };
  if (expanded)
    return { shown: rows, peek: null, hidden: 0, foldable: true };
  const shown = rows.filter((row) => row.current || active.has(row.origin));
  const rest = rows.filter((row) => !shown.includes(row));
  return { shown, peek: rest[0] ?? null, hidden: Math.max(0, rest.length - 1), foldable: rest.length > 0 };
}
function workspaceActivity(counts, here) {
  return new Set(Object.entries(counts).filter(([origin, count]) => origin !== here && count > 0).map(([origin]) => origin));
}
function savedWorkspaceCount(rows) {
  return rows.filter((row) => !row.note).length;
}
function workspaceRows(here, saved, mark) {
  const rows = workspaceChoices(here, saved);
  if (rows[0])
    Object.assign(rows[0], { icon: mark.icon, iconReady: mark.iconReady });
  return rows;
}
function filterWorkspaces(rows, query) {
  const typed = String(query || "").trim();
  const text = typed.toLowerCase().replace(/^https:\/\//, "");
  if (!text)
    return { rows, open: null };
  const ranked = rankMatches(rows, text, (row) => [row.name, row.host]);
  const matches = [...ranked.filter((row) => row.current), ...ranked.filter((row) => !row.current)];
  if (matches.length)
    return { rows: matches, open: null };
  const origin = workspaceOrigin(typed);
  return { rows: [], open: { origin, label: origin ? origin.slice("https://".length) : typed } };
}
const listHeights = new WeakMap;
function animateListHeight(el, reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, timing = { duration: 180, easing: "ease-out" }) {
  const next = el.getBoundingClientRect().height;
  const prev = listHeights.get(el);
  listHeights.set(el, next);
  if (!prev || !next || prev === next || reduce || typeof el.animate !== "function")
    return;
  el.style.overflow = "hidden";
  const run = el.animate([{ height: prev + "px" }, { height: next + "px" }], timing);
  const done = () => {
    el.style.overflow = "";
  };
  run.onfinish = done;
  run.oncancel = done;
}
function rowAfterKey(key, at, count) {
  if (at < 0 || count === 0)
    return -1;
  if (key === "ArrowDown")
    return (at + 1) % count;
  if (key === "ArrowUp")
    return (at + count - 1) % count;
  if (key === "Home")
    return 0;
  if (key === "End")
    return count - 1;
  return -1;
}
function installWorkspaceKeys(root, field) {
  const rows = () => [...root.querySelectorAll(".workspace-row")];
  const focusRow = (row) => {
    row.classList.add("kb-focus");
    row.addEventListener("blur", () => row.classList.remove("kb-focus"), { once: true });
    row.focus();
  };
  root.addEventListener("focusin", (event) => {
    const all = rows();
    if (!all.includes(event.target))
      return;
    for (const row of all)
      row.tabIndex = row === event.target ? 0 : -1;
  });
  root.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
      return;
    const all = rows();
    const active = root.ownerDocument.activeElement;
    if (event.key === "Tab") {
      const stops = [...root.querySelectorAll("button, [href], input, select, textarea, [tabindex]")].filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
      if (!stops.length)
        return;
      const at = stops.indexOf(active);
      const step = event.shiftKey ? -1 : 1;
      const target = stops[at < 0 ? step === 1 ? 0 : stops.length - 1 : (at + step + stops.length) % stops.length];
      event.preventDefault();
      if (all.includes(target))
        focusRow(target);
      else
        target.focus();
      return;
    }
    if (active === field && (event.key === "ArrowDown" || event.key === "ArrowUp") && all.length) {
      event.preventDefault();
      focusRow(event.key === "ArrowDown" ? all[0] : all[all.length - 1]);
      return;
    }
    const at = all.indexOf(active);
    if (at < 0)
      return;
    const next = rowAfterKey(event.key, at, all.length);
    if (next >= 0) {
      event.preventDefault();
      focusRow(all[next]);
    } else if (event.key.length === 1 && event.key !== " " && !field.disabled) {
      field.focus();
    }
  });
}
globalThis.slircWorkspaceMark = { WORKSPACE_PALETTE, workspaceName, WORKSPACE_ICON_PATH, workspaceIconUrl, workspaceMark, OPEN_WORKSPACE, workspaceOrigin, workspaceChoices, RAIL_MAX, RAIL_MOTION, railWorkspaces, workspaceActivity, savedWorkspaceCount, workspaceRows, filterWorkspaces, animateListHeight, rowAfterKey, installWorkspaceKeys };
})();
