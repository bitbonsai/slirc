// Agent accounts the client knows about, keyed by folded nick. Rows arrive from /auth/me account
// details, room members, the Agents page and live `agent-updated` events; each source may carry only
// part of the record, so a merge never blanks a field a richer source already filled.
import { foldIdentifier } from "@client/model.ts";
import { agentAvatarUrl } from "@client/presentation.ts";
import { rankMatches } from "@client/match.ts";

export interface AgentProfile {
  nick: string;
  /** Owning account nick, when the source says so. */
  owner: string;
  harness: string;
  name: string;
  repo: string;
  model: string;
}

export type AgentProfiles = Record<string, AgentProfile>;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// One patch from any agent-shaped row: `{ nick, kind: "agent", owner?, agent?: { harness, name, repo, model } }`.
// Legacy Agents page rows carry `harness`, `repo` and `sessionName` at the top level instead.
function patchFrom(row: Record<string, unknown>): Partial<AgentProfile> {
  const agent = (row.agent && typeof row.agent === "object" ? row.agent : {}) as Record<string, unknown>;
  const patch: Partial<AgentProfile> = {};
  const fields: [keyof AgentProfile, unknown][] = [
    ["owner", row.owner],
    ["harness", agent.harness ?? row.harness],
    ["name", agent.name ?? row.sessionName],
    ["repo", agent.repo ?? row.repo],
    ["model", agent.model ?? row.model],
  ];
  for (const [key, value] of fields) if (text(value)) patch[key] = text(value);
  return patch;
}

function merge(into: AgentProfiles, nick: string, patch: Partial<AgentProfile>): void {
  const key = foldIdentifier(nick);
  const prev = into[key] ?? { nick, owner: "", harness: "", name: "", repo: "", model: "" };
  into[key] = { ...prev, ...patch, nick: prev.nick || nick };
}

/** New record with every agent row merged in. `owner` stamps rows from an owner-scoped source. */
export function mergeAgents(prev: AgentProfiles, rows: unknown[], options: { owner?: string; allAgents?: boolean } = {}): AgentProfiles {
  const next = { ...prev };
  for (const value of rows) {
    const row = (value ?? {}) as Record<string, unknown>;
    const nick = text(row.nick);
    if (!nick || (!options.allAgents && row.kind !== "agent")) continue;
    merge(next, nick, { ...(options.owner ? { owner: options.owner } : {}), ...patchFrom(row) });
  }
  return next;
}

/** Live `agent-updated` payload. Returns null for a malformed event so callers can ignore it. */
export function applyAgentUpdate(prev: AgentProfiles, data: unknown): AgentProfiles | null {
  const raw = (data ?? {}) as Record<string, unknown>;
  const nick = text(raw.nick);
  if (!nick) return null;
  const next = { ...prev };
  merge(next, nick, patchFrom({ agent: raw.agent, owner: raw.owner }));
  return next;
}

export function forgetAgent(prev: AgentProfiles, nick: string): AgentProfiles {
  const next = { ...prev };
  delete next[foldIdentifier(nick)];
  return next;
}

export function agentFor(profiles: AgentProfiles | undefined, nick: string): AgentProfile | undefined {
  return profiles?.[foldIdentifier(String(nick || ""))];
}

export function agentLabel(profiles: AgentProfiles | undefined, nick: string): string {
  return agentFor(profiles, nick)?.name || nick;
}

/** How an `@nick` renders in a message: a known agent becomes a chip with its harness mark and
 * display name, the nick kept for the tooltip. People and removed agents get null and stay as text. */
export function agentMention(profiles: AgentProfiles | undefined, nick: string): { nick: string; name: string; icon: string } | null {
  const agent = agentFor(profiles, nick);
  return agent ? { nick: agent.nick || nick, name: agent.name || agent.nick || nick, icon: agentAvatarUrl(agent.nick || nick, agent.harness) } : null;
}

// Harness ids are protocol values (`pi`, `claude`); the header shows the name people see.
const HARNESS_NAMES: Record<string, string> = { pi: "Pi", claude: "Claude Code", opencode: "OpenCode", codex: "Codex" };

function harnessLabel(harness: string): string {
  const id = harness.trim().toLowerCase();
  return HARNESS_NAMES[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : "");
}

/** DM header for a known agent: the sidebar display name, then `harness · stable nick`. */
export function agentHeader(profiles: AgentProfiles | undefined, nick: string): { title: string; subtitle: string } {
  const agent = agentFor(profiles, nick);
  const stableNick = agent?.nick || nick;
  const harness = harnessLabel(agent?.harness ?? "");
  return { title: agentLabel(profiles, nick), subtitle: harness ? `${harness} · ${stableNick}` : "" };
}

/** `repo · model`, whichever exist; empty when neither does. */
export function agentSubtitle(agent: Partial<Pick<AgentProfile, "repo" | "model">> | undefined): string {
  return [agent?.repo, agent?.model].filter((part): part is string => !!part).join(" · ");
}

function ownedBy(agent: AgentProfile, account: string): boolean {
  return !!account && foldIdentifier(agent.owner) === foldIdentifier(account);
}

export function ownAgentNicks(profiles: AgentProfiles | undefined, account: string): string[] {
  return Object.values(profiles ?? {}).filter((agent) => ownedBy(agent, account)).map((agent) => agent.nick);
}

/** Own agents whose nick or name starts with the `/invite` query, or any word in either; prefix hits first. */
export function agentInviteMatches(profiles: AgentProfiles | undefined, account: string, query: string): string[] {
  if (!foldIdentifier(query)) return [];
  return rankMatches(Object.values(profiles ?? {}).filter((agent) => ownedBy(agent, account)), query, (agent) => [agent.nick, agent.name]).map((agent) => agent.nick);
}

export interface AgentNavRow { nick: string; label: string; channel: string }

// The AGENTS section: every DM whose peer is an agent, plus own agents that have no DM yet. Starred
// DMs stay in Starred only, like the Direct messages list.
export function agentNavRows(profiles: AgentProfiles | undefined, directs: readonly { nick: string; channel: string }[], account: string, starred: (channel: string) => boolean): AgentNavRow[] {
  const rows = new Map<string, AgentNavRow>();
  for (const direct of directs) {
    const agent = agentFor(profiles, direct.nick);
    if (agent) rows.set(foldIdentifier(direct.nick), { nick: direct.nick, label: agent.name || direct.nick, channel: direct.channel });
  }
  for (const nick of ownAgentNicks(profiles, account)) {
    if (!rows.has(foldIdentifier(nick))) rows.set(foldIdentifier(nick), { nick, label: agentLabel(profiles, nick), channel: "" });
  }
  return [...rows.values()].filter((row) => !row.channel || !starred(row.channel)).sort((a, b) => a.label.localeCompare(b.label));
}

export function isAgentNick(profiles: AgentProfiles | undefined, nick: string): boolean {
  return !!agentFor(profiles, nick);
}

/** The `@` picker offers an agent only while it is attached. A removed agent is forgotten, so it is
 * never a known agent here, and people always pass. */
export function mentionableNick(profiles: AgentProfiles | undefined, nick: string, attached: (nick: string) => boolean): boolean {
  return !isAgentNick(profiles, nick) || attached(nick);
}
