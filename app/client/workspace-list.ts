// The workspace dialog's list in a browser and the installed web app. The Mac and iPhone apps keep
// their list natively (native-shell.ts); a browser keeps it in localStorage, which belongs to one
// origin, so calango.slirc.app and xmiro.slirc.app would each know only themselves. When the dialog
// opens another workspace, the list rides along in the URL fragment, which never reaches a server
// log: https://xmiro.slirc.app/#workspaces=calango.slirc.app:1763900000000,... The page there merges
// it into its own list and takes the fragment off the address bar at once.
//
// Merging is a union by origin that keeps each entry's latest use. A carried entry gets in only for
// *.slirc.app, app.slirc.org, or an origin already on this browser's list, so a crafted link can't
// plant a look-alike sign-in site. A custom domain still opens when typed into the dialog; it just
// doesn't travel in the fragment. Times can't be in the future, and the link and the list are capped. Removing a
// workspace leaves a note on this origin, so a list carried in from elsewhere doesn't bring it back
// here; opening it from this origin again does. The removal doesn't travel to other origins.
import { workspaceOrigin } from "@client/workspace-mark.ts";

export const WORKSPACE_LIST_KEY = "slirc.workspaces";
export const MAX_WORKSPACES = 20;
const MAX_REMOVED = 50;
const MAX_FRAGMENT = 2048;
const PREFIX = "#workspaces=";

type Store = Pick<Storage, "getItem" | "setItem">;
export type WorkspaceList = { saved: Record<string, number>; removed: Record<string, number> };

const storage = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

function validTime(value: unknown, now: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, now) : null;
}

// Keeps the newest entries of a record, at most max of them.
function newest(record: Record<string, number>, max: number): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort((a, b) => b[1] - a[1]).slice(0, max));
}

function clean(record: unknown, max: number, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!record || typeof record !== "object") return out;
  for (const [key, value] of Object.entries(record)) {
    const origin = workspaceOrigin(key);
    const at = validTime(value, now);
    if (origin && origin === key && at) out[origin] = at;
  }
  return newest(out, max);
}

export function readWorkspaceList(store: Store | null = storage(), now = Date.now()): WorkspaceList {
  let raw: unknown = null;
  try { raw = JSON.parse(store?.getItem(WORKSPACE_LIST_KEY) || "null"); } catch { /* a broken entry starts over */ }
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<WorkspaceList>;
  return { saved: clean(value.saved, MAX_WORKSPACES, now), removed: clean(value.removed, MAX_REMOVED, now) };
}

function writeWorkspaceList(list: WorkspaceList, store: Store | null): void {
  try { store?.setItem(WORKSPACE_LIST_KEY, JSON.stringify({ saved: newest(list.saved, MAX_WORKSPACES), removed: newest(list.removed, MAX_REMOVED) })); } catch { /* storage full or blocked: the list lasts for this page */ }
}

// "calango.slirc.app:1763900000000,xmiro.slirc.app:1763800000000", newest first.
export function encodeWorkspaces(saved: Record<string, number>): string {
  return Object.entries(newest(saved, MAX_WORKSPACES)).map(([origin, at]) => origin.replace(/^https:\/\//, "") + ":" + at).join(",");
}

export function decodeWorkspaces(text: string, now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  if (text.length > MAX_FRAGMENT) return out;
  for (const item of text.split(",").slice(0, MAX_WORKSPACES)) {
    const cut = item.lastIndexOf(":");
    if (cut <= 0 || !/^\d{1,16}$/.test(item.slice(cut + 1))) continue;
    const host = item.slice(0, cut);
    const origin = workspaceOrigin(host);
    const at = validTime(Number(item.slice(cut + 1)), now);
    if (origin && origin === "https://" + host && at) out[origin] = Math.max(out[origin] ?? 0, at);
  }
  return out;
}

const slircOrigin = (origin: string) => origin === "https://app.slirc.org" || origin.endsWith(".slirc.app");

// A carried list joins this one. Entries removed on this origin stay out, and so do foreign hosts
// this browser hasn't saved itself. Hosted workspaces accept each other's origins; self-hosted
// origins only update entries already saved here.
export function mergeWorkspaces(list: WorkspaceList, incoming: Record<string, number>, here?: string): WorkspaceList {
  const trustHosted = !here || slircOrigin(here);
  const saved = { ...list.saved };
  for (const [origin, at] of Object.entries(incoming)) {
    if (list.removed[origin] || !((trustHosted && slircOrigin(origin)) || list.saved[origin])) continue;
    saved[origin] = Math.max(saved[origin] ?? 0, at);
  }
  return { saved: newest(saved, MAX_WORKSPACES), removed: list.removed };
}

function touch(list: WorkspaceList, origin: string, now: number): WorkspaceList {
  const removed = { ...list.removed };
  delete removed[origin];
  return { saved: newest({ ...list.saved, [origin]: now }, MAX_WORKSPACES), removed };
}

type Here = Pick<Location, "hash" | "pathname" | "search" | "origin">;
type Hist = Pick<History, "replaceState" | "state">;

// On load: merges a carried list, takes the fragment off the address bar, and marks this workspace
// as used now. Runs before the router and sign-in read the fragment.
export function takeCarriedWorkspaces(loc: Here = location, hist: Hist | null = typeof history === "undefined" ? null : history, store: Store | null = storage(), now = Date.now()): void {
  let list = readWorkspaceList(store, now);
  if (loc.hash.startsWith(PREFIX)) {
    let text = "";
    try { text = decodeURIComponent(loc.hash.slice(PREFIX.length)); } catch { /* malformed: ignore */ }
    list = mergeWorkspaces(list, decodeWorkspaces(text, now), loc.origin);
    try { hist?.replaceState(hist.state, "", loc.pathname + loc.search); } catch { /* the fragment stays, harmless */ }
  }
  const here = workspaceOrigin(loc.origin);
  if (here === loc.origin) list = touch(list, here, now);
  writeWorkspaceList(list, store);
}

// The saved workspaces for the dialog, most recently used first, without this one.
export function savedWorkspaces(here: string = location.origin, store: Store | null = storage(), now = Date.now()): string[] {
  const { saved } = readWorkspaceList(store, now);
  return Object.keys(newest(saved, MAX_WORKSPACES)).filter((origin) => origin !== here);
}

// The address the dialog opens: the target with this origin's list in the fragment. The target is
// saved here too, so coming back lists it.
export function workspaceLink(target: string, here: string = location.origin, store: Store | null = storage(), now = Date.now()): string {
  let list = touch(readWorkspaceList(store, now), target, now);
  if (workspaceOrigin(here) === here) list = { ...list, saved: { ...list.saved, [here]: now } };
  writeWorkspaceList(list, store);
  const { [target]: _skip, ...rest } = list.saved;
  const carried = encodeWorkspaces(rest);
  return target + "/" + (carried ? PREFIX + carried : "");
}

// Whether the instance rail shows every workspace, kept per device.
export const RAIL_EXPANDED_KEY = "slirc.railExpanded";
export function readRailExpanded(store: Pick<Storage, "getItem"> | null = storage()): boolean {
  try { return store?.getItem(RAIL_EXPANDED_KEY) === "1"; } catch { return false; }
}
export function writeRailExpanded(open: boolean, store: Pick<Storage, "setItem"> | null = storage()): void {
  try { store?.setItem(RAIL_EXPANDED_KEY, open ? "1" : "0"); } catch { /* blocked: it lasts for this page */ }
}

// Takes a workspace off this origin's list and keeps it off when a carried list names it again.
export function forgetWorkspace(origin: string, store: Store | null = storage(), now = Date.now()): void {
  const list = readWorkspaceList(store, now);
  const saved = { ...list.saved };
  delete saved[origin];
  writeWorkspaceList({ saved, removed: { ...list.removed, [origin]: now } }, store);
}
