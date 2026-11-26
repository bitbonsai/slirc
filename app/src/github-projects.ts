// OSS project channels: one Slirc channel per GitHub repository, kept up to date by that
// repository's webhooks. Ergo owns the room and its history; this file owns the binding between
// `owner/repo` and the channel, the webhook secret, and the plain-text update lines.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";

// GitHub's own limits: owners are up to 39 characters, repository names up to 100.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const CHANNEL = /^#[a-z][a-z0-9_-]{1,31}$/;
const RESERVED_CHANNEL_PREFIX = /^#(?:t|dm|g)-/i;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const ISSUE_ACTIONS = ["opened", "reopened", "closed"];

export type ProjectRepo = { owner: string; name: string };
export type ProjectBinding = {
  channel: string;
  repo: string;
  repoOwner: string;
  repoName: string;
  creatorNick: string;
  webhookSecret: string;
  createdAt: string;
};

export function parseRepo(value: unknown): ProjectRepo | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match || !OWNER.test(match[1]) || !NAME.test(match[2])) return null;
  // `.` and `..` pass GitHub's charset but are not repositories.
  if (match[2] === "." || match[2] === "..") return null;
  return { owner: match[1], name: match[2] };
}

export function repoLabel(repo: ProjectRepo): string {
  return `${repo.owner}/${repo.name}`;
}

// IRC's channel charset, lowercased: dots and anything else outside it fold to a dash.
function channelSlug(value: string): string | null {
  const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 32);
  const channel = `#${slug}`;
  if (!CHANNEL.test(channel) || RESERVED_CHANNEL_PREFIX.test(channel)) return null;
  return channel;
}

// `#repo`, or `#owner-repo` when the short name is taken or unusable. Never invents a third name.
export function channelCandidates(repo: ProjectRepo): string[] {
  const candidates = [channelSlug(repo.name), channelSlug(`${repo.owner}-${repo.name}`)];
  return [...new Set(candidates.filter((channel): channel is string => !!channel))];
}

// GitHub signs the raw request body with the binding's secret; a missing or malformed header is a
// rejection, and the compare is constant time so a guess cannot be narrowed by response timing.
export function verifyGithubSignature(secret: string, rawBody: string | Uint8Array, signatureHeader: string): boolean {
  if (!secret) return false;
  const match = SIGNATURE.exec((signatureHeader || "").trim());
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function newWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

type Row = { channel: string; repo_owner: string; repo_name: string; creator_nick: string; webhook_secret: string; created_at: string };
const binding = (row: Row): ProjectBinding => ({
  channel: row.channel,
  repo: `${row.repo_owner}/${row.repo_name}`,
  repoOwner: row.repo_owner,
  repoName: row.repo_name,
  creatorNick: row.creator_nick,
  webhookSecret: row.webhook_secret,
  createdAt: row.created_at,
});

const COLUMNS = "channel, repo_owner, repo_name, creator_nick, webhook_secret, created_at";

export function projectBinding(repo: ProjectRepo): ProjectBinding | null {
  const row = db.query(`SELECT ${COLUMNS} FROM project_repos WHERE lower(repo_owner) = lower(?) AND lower(repo_name) = lower(?)`)
    .get(repo.owner, repo.name) as Row | null;
  return row ? binding(row) : null;
}

export function projectBindings(): ProjectBinding[] {
  return (db.query(`SELECT ${COLUMNS} FROM project_repos ORDER BY channel`).all() as Row[]).map(binding);
}

// Duplicate repositories throw SQLite's UNIQUE constraint; the caller answers 409 before that.
export function bindProject(channel: string, repo: ProjectRepo, creatorNick: string): ProjectBinding {
  const row: Row = {
    channel,
    repo_owner: repo.owner,
    repo_name: repo.name,
    creator_nick: creatorNick,
    webhook_secret: newWebhookSecret(),
    created_at: new Date().toISOString(),
  };
  db.query(`INSERT INTO project_repos (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(row.channel, row.repo_owner, row.repo_name, row.creator_nick, row.webhook_secret, row.created_at);
  return binding(row);
}

type GithubItem = { number?: unknown; title?: unknown; html_url?: unknown; user?: { login?: unknown }; labels?: { name?: unknown }[]; merged?: unknown; merged_at?: unknown };
type GithubPayload = { action?: unknown; issue?: GithubItem; pull_request?: GithubItem };

// One line: no control characters or line breaks from a title can start a second IRC command.
const oneLine = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

function labelsOf(item: GithubItem | undefined): string[] {
  if (!Array.isArray(item?.labels)) return [];
  return item.labels.map((label) => oneLine(label?.name, 40)).filter(Boolean).slice(0, 6);
}

function githubUrl(value: unknown, repo: string, kind: "issues" | "pull", number: number): string {
  const url = oneLine(value, 300);
  if (/^https:\/\/github\.com\//.test(url)) return url;
  return `https://github.com/${repo}/${kind}/${number}`;
}

function updateText(summary: string, labels: string[], url: string): string {
  return [summary, labels.length ? `Labels: ${labels.join(", ")}` : "", url].filter(Boolean).join("\n");
}

// The message for one webhook delivery, or null when nothing should be posted: an unsupported
// event, an unsupported action, or a payload without the issue/PR it claims to carry.
export function formatGithubEvent(event: string, payload: unknown, repo: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as GithubPayload;
  const action = oneLine(data.action, 32);
  if (!ISSUE_ACTIONS.includes(action)) return null;

  if (event === "issues") {
    const issue = data.issue;
    const number = Number(issue?.number);
    if (!Number.isInteger(number) || number <= 0) return null;
    const author = oneLine(issue?.user?.login, 40) || "someone";
    const title = oneLine(issue?.title, 200) || "Untitled";
    const summary = `Issue #${number} ${action} by ${author} in ${repo}: ${title}`;
    return updateText(summary, labelsOf(issue), githubUrl(issue?.html_url, repo, "issues", number));
  }

  if (event === "pull_request") {
    const pull = data.pull_request;
    const number = Number(pull?.number);
    if (!Number.isInteger(number) || number <= 0) return null;
    const verb = action === "closed" && (pull?.merged === true || !!pull?.merged_at) ? "merged" : action;
    const author = oneLine(pull?.user?.login, 40) || "someone";
    const title = oneLine(pull?.title, 200) || "Untitled";
    const summary = `Pull request #${number} ${verb} by ${author} in ${repo}: ${title}`;
    return updateText(summary, labelsOf(pull), githubUrl(pull?.html_url, repo, "pull", number));
  }

  return null;
}
