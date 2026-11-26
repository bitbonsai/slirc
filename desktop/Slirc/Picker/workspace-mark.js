// Generated from app/client/workspace-mark.ts by desktop/picker-assets.ts. Do not edit.
(() => {
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
  const matches = rows.filter((row) => row.name.toLowerCase().includes(text) || row.host.toLowerCase().includes(text));
  if (matches.length)
    return { rows: matches, open: null };
  const origin = workspaceOrigin(typed);
  return { rows: [], open: { origin, label: origin ? origin.slice("https://".length) : typed } };
}
const listHeights = new WeakMap;
function animateListHeight(el, reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const next = el.getBoundingClientRect().height;
  const prev = listHeights.get(el);
  listHeights.set(el, next);
  if (!prev || !next || prev === next || reduce || typeof el.animate !== "function")
    return;
  el.style.overflow = "hidden";
  const run = el.animate([{ height: prev + "px" }, { height: next + "px" }], { duration: 180, easing: "ease-out" });
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
globalThis.slircWorkspaceMark = { WORKSPACE_PALETTE, workspaceName, WORKSPACE_ICON_PATH, workspaceIconUrl, workspaceMark, OPEN_WORKSPACE, workspaceOrigin, workspaceChoices, savedWorkspaceCount, workspaceRows, filterWorkspaces, animateListHeight, rowAfterKey, installWorkspaceKeys };
})();
