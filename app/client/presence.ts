import { foldIdentifier } from "@client/model.ts";
import { parseIrcLine } from "@client/irc.ts";

import { normalizeProfileBadge, type ProfileBadge } from "../shared/profile-badges.ts";
import { SERVICE_BOT_NICKS } from "../shared/service-bots.ts";

export type AvatarStatus = Exclude<ProfileBadge, "available"> | "online" | "offline";
const labels: Record<AvatarStatus, string> = { online: "Online", offline: "Offline", busy: "Busy", away: "Away", focus: "Focus", break: "Break", resting: "Resting", vacation: "Vacation", "": "Status unavailable" };

// MONITOR reports live nick presence, not channel membership or replayed history.
// Ergo keeps always-on accounts connected with no device and marks them AWAY instead; away-notify
// with extended-monitor streams AWAY changes, but MONITOR + never reports an existing away state.
// Service bots and bot accounts get no presence. Agents get no MONITOR entry either: the server holds
// their IRC connection, so their dot is the server's `attached` flag (live harness lease) or offline.
export function createPresence(reactive: <T extends object>(value: T) => T, send: (line: string) => boolean) {
  const local = reactive({ connected: false, online: {} as Record<string, boolean>, away: {} as Record<string, boolean>, bots: {} as Record<string, boolean>, agents: {} as Record<string, boolean>, availability: {} as Record<string, string>, badges: {} as Record<string, ProfileBadge> });
  let self = "";
  let limit = 0;
  let awayNotify = false;
  let desired = new Map<string, string>();
  let watched = new Map<string, string>();
  const isBot = (key: string) => SERVICE_BOT_NICKS.includes(key) || !!local.bots[key];

  function commands(sign: "+" | "-", nicks: string[]): void {
    let names = "";
    for (const nick of nicks) {
      if (names.length + nick.length > 400) { send(`MONITOR ${sign} ${names}`); names = ""; }
      names += (names ? "," : "") + nick;
    }
    if (names) send(`MONITOR ${sign} ${names}`);
  }

  function watch(nicks: string[]): void {
    desired = new Map(nicks.filter((nick) => typeof nick === "string" && /^[a-z0-9_\[\]{}\\`^|-]{1,64}$/i.test(nick) && !isBot(foldIdentifier(nick))).map((nick) => [foldIdentifier(nick), nick]));
    if (!local.connected || !limit) return;
    const next = new Map([...desired].slice(0, limit));
    commands("-", [...watched].filter(([key]) => !next.has(key)).map(([, nick]) => nick));
    commands("+", [...next].filter(([key]) => !watched.has(key)).map(([, nick]) => nick));
    local.online = Object.fromEntries(Object.entries(local.online).filter(([key]) => next.has(key)));
    local.away = Object.fromEntries(Object.entries(local.away).filter(([key]) => next.has(key)));
    watched = next;
  }

  function disconnect(): void {
    local.connected = false;
    local.online = {};
    local.away = {};
    watched.clear();
    limit = 0;
    awayNotify = false;
  }

  function start(nick: string): void { disconnect(); self = foldIdentifier(nick); }
  function reset(): void { disconnect(); self = ""; desired.clear(); local.availability = {}; local.badges = {}; local.bots = {}; local.agents = {}; }

  function feed(line: string): void {
    const message = parseIrcLine(line.replace(/\r?\n$/, ""));
    if (!message || message.tags.batch) return;
    if (message.command === "CAP" && message.params[1] === "ACK" && (message.params.at(-1) || "").split(" ").includes("away-notify")) awayNotify = true;
    if (message.command === "001") { local.connected = true; watch([...desired.values()]); }
    if (message.command === "005") {
      const token = message.params.find((param) => /^MONITOR=\d+$/.test(param));
      if (token) { limit = Number(token.slice(8)); watch([...desired.values()]); }
    }
    if (message.command === "730" || message.command === "731") {
      const online = { ...local.online };
      const away = { ...local.away };
      const arrived: string[] = [];
      for (const entry of (message.params.at(-1) || "").split(",")) {
        const key = foldIdentifier(entry.split("!", 1)[0]!);
        if (!watched.has(key)) continue;
        if (message.command === "731" || !online[key]) delete away[key];
        if (message.command === "730" && !online[key]) arrived.push(watched.get(key)!);
        online[key] = message.command === "730";
      }
      local.online = online;
      local.away = away;
      // USERHOST reads the current away flag (nick=-host). Ergo answers ten nicks per line; fakelag
      // allows a burst of five commands, so fewer, fuller lines keep sends behind it moving.
      if (awayNotify) for (let i = 0; i < arrived.length; i += 10) send(`USERHOST ${arrived.slice(i, i + 10).join(" ")}`);
    }
    if (message.command === "302") {
      const away = { ...local.away };
      for (const entry of (message.params.at(-1) || "").split(" ")) {
        const match = /^([^=*]+)\*?=([+-])/.exec(entry);
        const key = match ? foldIdentifier(match[1]!) : "";
        if (!key || !watched.has(key) || !local.online[key]) continue;
        if (match![2] === "-") away[key] = true;
        else delete away[key];
      }
      local.away = away;
    }
    if (message.command === "AWAY" || message.command === "301") {
      const key = foldIdentifier((message.command === "AWAY" ? message.prefix?.split("!", 1)[0] : message.params[1]) || "");
      if (key && watched.has(key)) {
        const away = { ...local.away };
        if (message.command === "301" || message.params[0]) away[key] = true;
        else delete away[key];
        local.away = away;
      }
    }
    if (message.command === "734") {
      // A full server watch list is unknown presence, never evidence someone is offline.
      const online = { ...local.online };
      const away = { ...local.away };
      for (const nick of (message.params[2] || "").split(",")) { const key = foldIdentifier(nick); watched.delete(key); delete online[key]; delete away[key]; }
      local.online = online;
      local.away = away;
    }
  }

  function setAvailability(rows: { nick: string; availability?: unknown; badge?: unknown; kind?: unknown; attached?: unknown }[]): void {
    const availability = { ...local.availability };
    const badges = { ...local.badges };
    const bots = { ...local.bots };
    const agents = { ...local.agents };
    let learned = false;
    for (const row of rows) {
      if (typeof row?.nick !== "string") continue;
      const key = foldIdentifier(row.nick);
      availability[key] = typeof row.availability === "string" ? row.availability : "";
      badges[key] = normalizeProfileBadge(row.badge);
      if (row.kind === "bot" || row.kind === "agent") { learned ||= desired.has(key); bots[key] = true; }
      if (row.kind === "agent") agents[key] = row.attached === true;
    }
    local.availability = availability;
    local.badges = badges;
    local.bots = bots;
    local.agents = agents;
    if (learned) watch([...desired.values()]);
  }

  // Live `agent-presence` event from the server: the same attachment flag, pushed when it flips.
  function setAgentAttached(nick: string, attached: boolean): void {
    if (typeof nick !== "string" || !nick) return;
    const key = foldIdentifier(nick);
    local.agents = { ...local.agents, [key]: attached === true };
    if (local.bots[key]) return;
    local.bots = { ...local.bots, [key]: true };
    if (desired.has(key)) watch([...desired.values()]);
  }

  function status(nick: string, availability?: string, badge?: ProfileBadge): AvatarStatus {
    if (typeof nick !== "string" || !nick) return "";
    const key = foldIdentifier(nick);
    if (key in local.agents) return local.agents[key] ? "online" : "offline";
    if (isBot(key)) return "";
    const online = key === self ? local.connected : local.connected ? local.online[key] : undefined;
    if (online === undefined) return "";
    if (!online) return "offline";
    const selected = normalizeProfileBadge(badge ?? local.badges[key]);
    if (selected && selected !== "available") return selected;
    // Self is connected by definition; a picked badge outranks Ergo's auto-away.
    if (key !== self && local.away[key]) return "away";
    if (selected) return "online";
    return (availability ?? local.availability[key] ?? "").trim().toLowerCase() === "busy" ? "busy" : "online";
  }

  return Object.assign(local, { watch, start, disconnect, reset, feed, setAvailability, setAgentAttached, status, label: (nick: string, availability?: string, badge?: ProfileBadge) => labels[status(nick, availability, badge)] });
}
