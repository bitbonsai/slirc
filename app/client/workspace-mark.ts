// The workspace mark at the top of the desktop sidebar and on the phone's More screen: which
// workspace this window is, and the way into the workspace dialog. A workspace is its address,
// so the name comes from the host: "ai-guild.slirc.app" is ai-guild. Slirc's own workspace,
// app.slirc.org, shows the Slirc mark. Any other workspace gets a monogram, its first letter on a
// colour picked from the name, so it looks the same on every device, until an admin uploads an icon
// (Admin > Branding). Each workspace serves its own at /api/workspace-icon, so the dialog can show
// other workspaces' icons too. The letter tile stays until the icon has loaded, and comes back when
// there is none.

export type WorkspaceMark = { name: string; letter: string; color: string; logo: string; icon: string; iconReady: boolean };

// Twelve Catppuccin Mocha accents. Dark text (#11111b) reads on each of them in both themes. The
// near-white ones (rosewater, flamingo) are left out so every mark keeps a clear colour.
export const WORKSPACE_PALETTE = ["#f5c2e7", "#cba6f7", "#f38ba8", "#eba0ac", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb", "#74c7ec", "#89b4fa", "#b4befe"];

const OWN_HOST = "app.slirc.org";
const TENANT_SUFFIX = ".slirc.app";

// FNV-1a. The profile avatar's hash put ai-guild, xmiro and juan on one colour; this one spreads
// short names across the palette.
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (const char of text) value = Math.imul(value ^ char.codePointAt(0)!, 0x01000193);
  return value >>> 0;
}

export function workspaceName(host: string): string {
  const bare = host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (bare === OWN_HOST) return "Slirc";
  if (bare.endsWith(TENANT_SUFFIX)) return bare.slice(0, -TENANT_SUFFIX.length);
  return bare.split(".")[0] || bare;
}

export const WORKSPACE_ICON_PATH = "/api/workspace-icon?size=64";

// `origin` is where the icon comes from: the page's own origin for this workspace, so the dev stack
// on a port and plain http both work. Slirc's own workspace keeps the Slirc mark and asks for no icon.
// `iconVersion` is what this workspace's shell says about its icon: "" for none, so the page asks
// for nothing, or the saved icon's version. Another workspace's icon is unknown here, so it is asked for.
export function workspaceIconUrl(origin: string, iconVersion?: string): string {
  if (iconVersion === undefined) return origin + WORKSPACE_ICON_PATH;
  return iconVersion ? `${origin}${WORKSPACE_ICON_PATH}&v=${encodeURIComponent(iconVersion)}` : "";
}

export function workspaceMark(host: string, origin = "https://" + host, iconVersion?: string): WorkspaceMark {
  const name = workspaceName(host);
  const logo = name === "Slirc" ? "/icons/slirc.svg" : "";
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase();
  const icon = logo ? "" : workspaceIconUrl(origin, iconVersion);
  return { name, letter, color: WORKSPACE_PALETTE[hash(name.toLowerCase()) % WORKSPACE_PALETTE.length]!, logo, icon, iconReady: false };
}

// Slirc's own workspace. The workspace dialog offers it until it is among the rows.
export const OPEN_WORKSPACE = "https://app.slirc.org";

// "ai-guild", "ai-guild.slirc.app" and "https://ai-guild.slirc.app/x" all mean one origin, as in
// the iOS picker (native/www/picker.js). The answer is always https://<host>: any other scheme, a
// port, or userinfo is refused.
export function workspaceOrigin(value: string): string | null {
  let text = String(value || "").trim().toLowerCase();
  if (text.includes("://")) {
    if (!text.startsWith("https://")) return null;
    text = text.slice("https://".length);
  }
  let host = text.split(/[/?#]/, 1)[0]!.replace(/\.$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return null;
  if (!host.includes(".")) host += ".slirc.app";
  return "https://" + host;
}

export type WorkspaceChoice = WorkspaceMark & { origin: string; host: string; current: boolean; note: string };

const isHostedOrigin = (origin: string) => origin === OPEN_WORKSPACE || origin.endsWith(TENANT_SUFFIX);

// The workspace dialog's rows: this workspace first, then the ones the Mac or iPhone app has saved.
// Hosted workspaces also offer app.slirc.org when it isn't among them; self-hosted instances stay neutral.
export function workspaceChoices(here: string, saved: string[]): WorkspaceChoice[] {
  const row = (origin: string, current: boolean, note = ""): WorkspaceChoice => {
    const host = origin.replace(/^https?:\/\//, "");
    return { ...workspaceMark(host, origin), origin, host, current, note };
  };
  const rows = [row(here, true)];
  for (const value of saved) {
    const origin = workspaceOrigin(value);
    if (origin && !rows.some((item) => item.origin === origin)) rows.push(row(origin, false));
  }
  if (isHostedOrigin(here) && !rows.some((item) => item.origin === OPEN_WORKSPACE)) rows.push(row(OPEN_WORKSPACE, false, "Slirc's own workspace"));
  return rows;
}

// The instance rail shows this workspace and the workspaces with activity (unread or a mention),
// then fills up to RAIL_MAX icons with the rest in their usual order. Everything else folds behind
// one "+n" control. Activity is never hidden, so more than RAIL_MAX can show. The rail has no
// unread state for other workspaces yet (each is its own origin), so callers pass none and the
// rail keeps the most recently used ones: the rows arrive newest first. With RAIL_MAX or fewer
// rows, or when expanded, every row shows.
export const RAIL_MAX = 4;
export function railWorkspaces<T extends { origin: string; current: boolean }>(rows: T[], expanded: boolean, active: ReadonlySet<string> = new Set(), max = RAIL_MAX): { shown: T[]; hidden: number } {
  if (expanded || rows.length <= max) return { shown: rows, hidden: 0 };
  const keep = new Set(rows.filter((row) => row.current || active.has(row.origin)).map((row) => row.origin));
  for (const row of rows) { if (keep.size >= max) break; keep.add(row.origin); }
  const shown = rows.filter((row) => keep.has(row.origin));
  return { shown, hidden: rows.length - shown.length };
}

// The count beside the workspace row on the phone's More tab: the workspaces in the dialog,
// leaving out the app.slirc.org row a hosted workspace offers but nobody saved.
export function savedWorkspaceCount(rows: WorkspaceChoice[]): number {
  return rows.filter((row) => !row.note).length;
}

// The rows as the instance rail and the dialog show them: this workspace first, carrying the icon
// state this page has already loaded (a fresh save changes the address), then the saved ones.
export function workspaceRows(here: string, saved: string[], mark: Pick<WorkspaceMark, "icon" | "iconReady">): WorkspaceChoice[] {
  const rows = workspaceChoices(here, saved);
  if (rows[0]) Object.assign(rows[0], { icon: mark.icon, iconReady: mark.iconReady });
  return rows;
}

// Typing in the dialog's field narrows its rows by name and host. With no row left, the dialog
// offers to open what was typed: origin is that text read as an address, or null when it isn't one,
// and label is what the row shows. An empty field keeps every row.
export type WorkspaceFilter = { rows: WorkspaceChoice[]; open: { origin: string | null; label: string } | null };
export function filterWorkspaces(rows: WorkspaceChoice[], query: string): WorkspaceFilter {
  const typed = String(query || "").trim();
  const text = typed.toLowerCase().replace(/^https:\/\//, "");
  if (!text) return { rows, open: null };
  const matches = rows.filter((row) => row.name.toLowerCase().includes(text) || row.host.toLowerCase().includes(text));
  if (matches.length) return { rows: matches, open: null };
  const origin = workspaceOrigin(typed);
  return { rows: [], open: { origin, label: origin ? origin.slice("https://".length) : typed } };
}

// The dialog's list changes height as the filter narrows it. Called after each render: it animates
// from the last height it saw to the new one, short and ease-out. It skips the first render, a
// closed dialog (height 0) and reduced motion. Overflow is clipped only while it runs, so focus
// rings show the rest of the time.
const listHeights = new WeakMap<HTMLElement, number>();
export function animateListHeight(el: HTMLElement, reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches): void {
  const next = el.getBoundingClientRect().height;
  const prev = listHeights.get(el);
  listHeights.set(el, next);
  if (!prev || !next || prev === next || reduce || typeof el.animate !== "function") return;
  el.style.overflow = "hidden";
  const run = el.animate([{ height: prev + "px" }, { height: next + "px" }], { duration: 180, easing: "ease-out" });
  const done = () => { el.style.overflow = ""; };
  run.onfinish = done;
  run.oncancel = done;
}

// Keys in the workspace list, here so the Mac app's picker (desktop/Slirc/Picker) gets the same
// ones. The rows are buttons with a roving tabindex: one row at a time is a Tab stop, the current
// workspace's at first. Up and Down move between rows and wrap, Home and End jump, Enter opens the
// row as any button does, and a typed letter goes to the search field. Down and Up in the field
// move into the list. Tab and Shift+Tab cycle the
// list's one stop and the other controls, since WebKit's Tab reaches only text fields. The moved-to
// row carries .kb-focus, because WebKit leaves :focus-visible off a row that script focuses.
export function rowAfterKey(key: string, at: number, count: number): number {
  if (at < 0 || count === 0) return -1;
  if (key === "ArrowDown") return (at + 1) % count;
  if (key === "ArrowUp") return (at + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return -1;
}

export function installWorkspaceKeys(root: HTMLElement, field: HTMLInputElement): void {
  const rows = () => [...root.querySelectorAll<HTMLElement>(".workspace-row")];
  const focusRow = (row: HTMLElement) => {
    row.classList.add("kb-focus");
    row.addEventListener("blur", () => row.classList.remove("kb-focus"), { once: true });
    row.focus();
  };
  root.addEventListener("focusin", (event) => {
    const all = rows();
    if (!all.includes(event.target as HTMLElement)) return;
    for (const row of all) row.tabIndex = row === event.target ? 0 : -1;
  });
  root.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const all = rows();
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    if (event.key === "Tab") {
      const stops = [...root.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]")]
        .filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
      if (!stops.length) return;
      const at = stops.indexOf(active!);
      const step = event.shiftKey ? -1 : 1;
      const target = stops[at < 0 ? (step === 1 ? 0 : stops.length - 1) : (at + step + stops.length) % stops.length]!;
      event.preventDefault();
      if (all.includes(target)) focusRow(target);
      else target.focus();
      return;
    }
    if (active === field && (event.key === "ArrowDown" || event.key === "ArrowUp") && all.length) {
      event.preventDefault();
      focusRow(event.key === "ArrowDown" ? all[0]! : all[all.length - 1]!);
      return;
    }
    const at = all.indexOf(active!);
    if (at < 0) return;
    const next = rowAfterKey(event.key, at, all.length);
    if (next >= 0) {
      event.preventDefault();
      focusRow(all[next]!);
    } else if (event.key.length === 1 && event.key !== " " && !field.disabled) {
      field.focus();
    }
  });
}
