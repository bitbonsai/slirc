// Job cards. A jobs bot posts its daily digest as one multiline message in tidy text that every IRC
// client reads, and tags it with the client-only tag +slirc/jobs=<day> (plus +slirc/jobs-logos, the
// listed jobs' logo addresses in order). Slirc draws that message as a card, built from the text
// itself. Anyone can put a client-only tag on their own line, so only a tagged message from a bot
// account (kind "bot", never a person or an agent) in the channel becomes a card; anything else, or
// text the card can't read, renders as the text it is.
//
// The text the card reads, one line each:
//   **11 new remote jobs** open to Europe, via [Himalayas](https://himalayas.app)
//   **Engineering**
//   • 🇵🇹 [Senior Front-End Developer](https://…) · Imaginary Cloud · Portugal `EUR 35-54k`
//   [170 more on Himalayas](https://…/jobs) · also lennysjobs.com and weworkremotely.com

import { foldIdentifier, type Message } from "@client/model.ts";
import { embedImageUrl } from "@client/render.ts";

export const JOBS_TAG = "+slirc/jobs";
export const JOBS_LOGOS_TAG = "+slirc/jobs-logos";
// Rows the card shows before "Show N more".
export const FIRST_ROWS = 6;
const MAX_JOBS = 50;

export type JobItem = { group: string; flag: string; title: string; url: string; company: string; where: string; salary: string; logo: string; letter: string };
export type JobLink = { label: string; url: string };
export type JobsView = { day: string; summary: string; jobs: JobItem[]; groups: { name: string; count: number }[]; more: JobLink | null; boards: JobLink[] };

// The day a tagged message covers and its logos, from the opener's tags. Junk is no mark.
export function jobsMark(tags: Record<string, string | undefined>): Message["jobs"] | undefined {
  const day = tags[JOBS_TAG];
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const logos = (tags[JOBS_LOGOS_TAG] || "").split(",").slice(0, MAX_JOBS).map((logo) => safeUrl(logo) ?? "");
  return { day, logos };
}

const safeUrl = (raw: string): string | null => {
  if (!raw || raw.length > 600) return null;
  try { const url = new URL(raw); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
};

const LINK = /\[([^\]\n]{1,300})\]\((https:\/\/[^)\s]{1,600})\)/;
const JOB = new RegExp(`^•\\s+(\\S{1,16})\\s+${LINK.source}\\s+·\\s+(.{1,200}?)\\s+·\\s+(.{1,200}?)(?:\\s+\`([^\`]{1,60})\`)?\\s*$`, "u");
const GROUP = /^\*\*([^*]{1,40})\*\*$/;
const DOMAIN = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i;
const plainText = (markdown: string) => markdown.replace(new RegExp(LINK.source, "g"), "$1").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

// The card a message's text makes, or null when any line is not in the shape above.
export function parseJobs(text: string, mark: NonNullable<Message["jobs"]>): JobsView | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const summary = plainText(lines[0]!).replace(/,\s*via\s+.*$/i, "");
  if (!summary) return null;
  const footer = lines.at(-1)!;
  const jobs: JobItem[] = [];
  let group = "";
  for (const line of lines.slice(1, -1)) {
    const heading = GROUP.exec(line);
    if (heading) { group = heading[1]!.trim(); continue; }
    const job = JOB.exec(line);
    const url = job && safeUrl(job[3]!);
    if (!job || !url || !group || jobs.length >= MAX_JOBS) return null;
    const company = job[4]!.trim();
    const logo = safeUrl(mark.logos[jobs.length] || "") || "";
    jobs.push({ group, flag: job[1]!, title: job[2]!.trim(), url, company, where: job[5]!.trim(), salary: (job[6] || "").trim(), logo: logo ? embedImageUrl(logo) : "", letter: (company.match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase() });
  }
  if (!jobs.length) return null;
  const first = new RegExp(`^${LINK.source}`).exec(footer);
  const more = first && safeUrl(first[2]!) ? { label: first[1]!.trim(), url: first[2]! } : null;
  const rest = (first ? footer.slice(first[0].length) : footer).replace(/^\s*·\s*/, "").replace(/^also\s+/i, "");
  const boards = rest.split(/\s*(?:,|\band\b|·)\s*/).map((part) => part.trim()).filter((part) => DOMAIN.test(part)).slice(0, 6).map((domain) => ({ label: domain, url: `https://${domain}` }));
  if (!more && !boards.length) return null;
  const names = [...new Set(jobs.map((job) => job.group))];
  return { day: mark.day, summary, jobs, groups: names.map((name) => ({ name, count: jobs.filter((job) => job.group === name).length })), more, boards };
}

// "Thu 20 Nov" for the card's eyebrow; the day is the bot's UTC day.
export function jobsDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

// The rows a tab shows: all of them once expanded, else the first six.
export function visibleJobs(view: JobsView, tab: string, expanded: boolean): { rows: JobItem[]; hidden: number } {
  const all = tab ? view.jobs.filter((job) => job.group === tab) : view.jobs;
  return expanded ? { rows: all, hidden: 0 } : { rows: all.slice(0, FIRST_ROWS), hidden: Math.max(0, all.length - FIRST_ROWS) };
}

export function createJobCards(reactive: <T extends object>(value: T) => T, deps: {
  // True when `nick` is a bot account (kind "bot") in the conversation's channel.
  isBot: (nick: string, conversationId: string) => boolean;
}) {
  const local = reactive({ tabs: {} as Record<string, string>, expanded: {} as Record<string, boolean> });
  // Parsed once per message text; the text of a confirmed message doesn't change.
  const parsed = new Map<string, { text: string; view: JobsView | null }>();

  function card(message: Message): JobsView | null {
    if (!message.jobs || message.deleted || !deps.isBot(message.authorAccount || message.authorNick, message.conversationId)) return null;
    const known = parsed.get(message.id);
    if (known && known.text === message.text) return known.view;
    const view = parseJobs(message.text, message.jobs);
    parsed.set(message.id, { text: message.text, view });
    return view;
  }

  const tab = (message: Message) => local.tabs[message.id] || "";
  function pick(message: Message, name: string): void { local.tabs[message.id] = name; }
  function expand(message: Message): void { local.expanded[message.id] = true; }
  const rows = (message: Message, view: JobsView) => visibleJobs(view, tab(message), !!local.expanded[message.id]);
  function reset(): void { parsed.clear(); local.tabs = {}; local.expanded = {}; }

  return Object.assign(local, { card, tab, pick, expand, rows, reset, day: jobsDay });
}

export const isBotRow = (rows: { nick: string; kind: string }[], nick: string) => {
  const key = foldIdentifier(nick);
  return !!key && rows.some((row) => row.kind === "bot" && foldIdentifier(row.nick) === key);
};
