// Cmd+K (Ctrl+K off Apple) jump palette: one list over channels, groups, DMs and people.
// Pure parts live here so they can be tested without a browser; palettes.ts holds the dialog.

export type JumpKind = "channel" | "group" | "dm" | "person";
import { matchRank } from "./match.ts";

// `alias` is a second name the row answers to, such as an agent's display name when the label is its nick.
export interface JumpRow { id: string; kind: JumpKind; label: string; alias?: string; hint: string; target: string; unread: number }

const APPLE = /Mac|iPhone|iPad|iPod/;

export function isApplePlatform(nav: { platform?: string; userAgent?: string } = globalThis.navigator ?? {}): boolean {
  return APPLE.test(nav.platform || "") || APPLE.test(nav.userAgent || "");
}

// Cmd+K on Apple keyboards, Ctrl+K elsewhere. Ctrl+K on a Mac stays the text field's own shortcut.
export function isJumpShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean }, apple: boolean): boolean {
  if (event.isComposing || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return false;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

// Cmd+Option+O on Apple keyboards, Ctrl+Alt+O elsewhere: the Workspaces dialog, also the Mac app's
// Switch Workspace… key. Option changes the typed character (ø on a Mac), so the physical O key is
// the test. AltGr on Windows reports Ctrl+Alt; it stays a typing key (ó on a Polish keyboard).
export function isWorkspacesShortcut(event: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; getModifierState?: (key: string) => boolean }, apple: boolean): boolean {
  if (event.isComposing || !event.altKey || event.shiftKey || event.code !== "KeyO") return false;
  if (event.getModifierState?.("AltGraph")) return false;
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

// Higher is better, 0 is no match. Exact, then the shared matcher (start of the label or alias, then
// start of a word in either), then the letters in order ("dvt" finds "dev-test"). Shorter labels win ties.
export function fuzzyScore(label: string, query: string, alias = ""): number {
  const text = label.toLowerCase(), needle = query.trim().toLowerCase().replace(/^[#@]/, "");
  if (!needle) return 1;
  if (text === needle) return 100;
  const rank = matchRank(needle, label, alias);
  if (rank === 2) return 80 - text.length / 100;
  if (rank === 1) return 60 - text.length / 100;
  let position = 0;
  for (const char of needle) {
    position = text.indexOf(char, position);
    if (position < 0) return 0;
    position += 1;
  }
  return 20 - text.length / 100;
}

export const JUMP_LIMIT = 12;

// No query: unread conversations first, then the sidebar order. A query ranks by fuzzyScore;
// equal scores keep the sidebar order.
export function rankJump(rows: readonly JumpRow[], query: string, limit = JUMP_LIMIT): JumpRow[] {
  if (!query.trim()) return [...rows].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0)).slice(0, limit);
  return rows.map((row, order) => ({ row, order, score: fuzzyScore(row.label, query, row.alias) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((item) => item.row);
}

// One row per place. A person with a DM is listed once, as the DM.
export function jumpRows(input: {
  channels: readonly { wireTarget: string; label: string; secret: boolean; unread: number }[];
  groups: readonly { wireTarget: string; label: string; unread: number }[];
  directs: readonly { nick: string; name?: string; unread: number }[];
  people: readonly (string | { nick: string; name?: string })[];
}): JumpRow[] {
  const rows: JumpRow[] = [];
  const seen = new Set<string>();
  for (const room of input.channels) rows.push({ id: `room:${room.wireTarget}`, kind: "channel", label: room.label, hint: room.secret ? "Invite-only channel" : "Channel", target: room.wireTarget, unread: room.unread });
  for (const group of input.groups) rows.push({ id: `room:${group.wireTarget}`, kind: "group", label: group.label, hint: "Group", target: group.wireTarget, unread: group.unread });
  for (const direct of input.directs) {
    const key = direct.nick.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: `dm:${key}`, kind: "dm", label: direct.nick, hint: "Direct message", target: direct.nick, unread: direct.unread, ...(direct.name && direct.name !== direct.nick ? { alias: direct.name } : {}) });
  }
  for (const person of input.people) {
    const nick = typeof person === "string" ? person : person.nick;
    const key = nick.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: `person:${key}`, kind: "person", label: nick, hint: "Start a direct message", target: nick, unread: 0, ...(typeof person !== "string" && person.name && person.name !== nick ? { alias: person.name } : {}) });
  }
  return rows;
}
