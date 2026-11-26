// Signed-out read of the public room on the public playground: /open-chat shows recent
// messages with a sign-in bar where the composer goes. Only text an IRC user in that channel would
// already see leaves here (nick, time, text, reply and poll tags, reactions); no member list,
// presence or other rooms.
//
// One long-lived oper connection joins each open channel once and reads CHATHISTORY from it, so a
// visitor never opens an IRC connection and repeated views do not parade JOIN/PART lines. It uses
// the oper's usual service nick (slirc-org-<hex>, like the app's management session) with +B. The
// app never lists open-channel members, so only plain IRC clients see it in NAMES. Answers
// are cached briefly per channel; the route also limits each peer.

import { slircMode } from "./config.ts";
import { operClient } from "./grants.ts";
import { pageHistoryResult } from "./history.ts";
import { type IrcClient, type ParsedMessage } from "./irc.ts";
import { isOpenChannel, normalized } from "./rooms.ts";
import { isConcat, joinParts } from "../public/multiline.js";
import { openRoom } from "./welcome.ts";

export type PeekReaction = { emoji: string; count: number; accounts: string[] };
export type PeekMessage = {
  id: string; time: string; nick: string; text: string; action?: true;
  replyTo?: string; poll?: { id: number; kind: "card" | "tally" }; reactions?: PeekReaction[];
};

export const PEEK_LIMIT = 50;
const PEEK_TTL_MS = 15_000;
const PAGE_TIMEOUT_MS = 5_000;
const MSGID = /^[A-Za-z0-9_-]{1,64}$/;
const POLL_ID = /^\d{1,9}$/;

// Only the public room (#open-chat), and only while it is a configured open channel on the public
// playground. #help keeps its signed-in-only reading; a channel row, a thread or a DM never qualifies.
export function peekable(channel: string): boolean {
  const room = normalized(channel);
  return slircMode() === "public_playground" && isOpenChannel(room) && room === openRoom();
}

const nickOf = (m: ParsedMessage) => m.prefix?.split("!")[0] || "";
const msgid = (value: string | undefined) => (value && MSGID.test(value) ? value : "");

function pollOf(tags: Record<string, string>): PeekMessage["poll"] {
  if (POLL_ID.test(tags["+slirc/poll"] || "")) return { id: Number(tags["+slirc/poll"]), kind: "card" };
  if (POLL_ID.test(tags["+slirc/poll-tally"] || "")) return { id: Number(tags["+slirc/poll-tally"]), kind: "tally" };
  return undefined;
}

// History rows to what the page shows, oldest first: PRIVMSG text from people and bots, with a
// draft/multiline batch joined into one message, and the reactions (TAGMSG +draft/react) counted
// onto the message they name. Ergo's replayed events (HistServ), CTCP other than ACTION, and empty
// lines are dropped. An edit (+draft/edit) replaces the text of the message it names instead of
// showing twice. Only what an IRC user in the room already sees leaves: nick, time, text, the
// reply/poll tags and who reacted with what.
export function peekMessages(items: ParsedMessage[], limit = PEEK_LIMIT): PeekMessage[] {
  type Line = { tags: Record<string, string>; nick: string; text: string };
  const batches = new Map<string, { opener: ParsedMessage; first?: ParsedMessage; last?: ParsedMessage; parts: { text: string; concat: boolean }[] }>();
  const rows: Line[] = [];
  const reacts: { tags: Record<string, string>; nick: string }[] = [];
  for (const m of items) {
    if (m.command === "BATCH" && m.params[1] === "draft/multiline") {
      batches.set((m.params[0] || "").slice(1), { opener: m, parts: [] });
      continue;
    }
    const batch = m.tags.batch ? batches.get(m.tags.batch) : undefined;
    if (m.command === "PRIVMSG" && batch) {
      batch.first ??= m;
      batch.last = m;
      batch.parts.push({ text: m.params.at(-1) || "", concat: isConcat(m.tags) });
      continue;
    }
    if (m.command === "PRIVMSG") rows.push({ tags: m.tags, nick: nickOf(m), text: m.params.at(-1) || "" });
    else if (m.command === "TAGMSG") reacts.push({ tags: m.tags, nick: nickOf(m) });
  }
  // Like the signed-in client (client/sync.ts): the sender comes from the batch's lines, and the
  // opener's msgid and time fall back to the lines' when the server put them there instead. An
  // opener without a sender or time otherwise dropped the whole note, or sorted it out of the page.
  for (const { opener, first, last, parts } of batches.values()) {
    if (!first || !last) continue;
    const tags = { ...first.tags, ...opener.tags };
    tags.msgid ||= opener.tags.msgid || last.tags.msgid || first.tags.msgid || "";
    tags.time ||= first.tags.time || last.tags.time || "";
    delete tags.batch;
    rows.push({ tags, nick: nickOf(first) || nickOf(opener), text: joinParts(parts) });
  }
  rows.sort((a, b) => (a.tags.time || "").localeCompare(b.tags.time || ""));

  const byId = new Map<string, PeekMessage>();
  const ordered: PeekMessage[] = [];
  for (const row of rows) {
    const nick = row.nick;
    if (!nick || /^histserv$/i.test(nick)) continue;
    let text = row.text;
    let action = false;
    if (text.startsWith("\x01")) {
      const ctcp = text.replace(/^\x01|\x01$/g, "");
      if (!/^ACTION /.test(ctcp)) continue;
      text = ctcp.slice(7);
      action = true;
    }
    if (!text.trim()) continue;
    const edited = row.tags["+draft/edit"];
    if (edited && byId.has(edited)) {
      const original = byId.get(edited)!;
      if (original.nick.toLowerCase() === nick.toLowerCase()) original.text = text;
      continue;
    }
    const id = msgid(row.tags.msgid);
    const replyTo = msgid(row.tags["+reply"] || row.tags["+draft/reply"]);
    const poll = pollOf(row.tags);
    const message: PeekMessage = {
      id, time: row.tags.time || "", nick, text,
      ...(action ? { action: true as const } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(poll ? { poll } : {}),
    };
    if (id) byId.set(id, message);
    ordered.push(message);
  }

  // Reactions in server order: a react adds the account, an unreact takes it back.
  const tally = new Map<string, Map<string, Set<string>>>();
  reacts.sort((a, b) => (a.tags.time || "").localeCompare(b.tags.time || ""));
  for (const { tags, nick } of reacts) {
    const target = msgid(tags["+reply"] || tags["+draft/reply"]);
    const emoji = tags["+draft/react"] ?? tags["+draft/unreact"] ?? "";
    const account = tags.account || nick;
    if (!target || !byId.has(target) || !emoji || emoji.length > 64 || !account) continue;
    const forMessage = tally.get(target) ?? new Map<string, Set<string>>();
    tally.set(target, forMessage);
    const accounts = forMessage.get(emoji) ?? new Set<string>();
    forMessage.set(emoji, accounts);
    if (tags["+draft/unreact"] !== undefined) accounts.delete(account); else accounts.add(account);
  }
  for (const [target, forMessage] of tally) {
    const reactions = [...forMessage].filter(([, accounts]) => accounts.size).map(([emoji, accounts]) => ({ emoji, count: accounts.size, accounts: [...accounts] }));
    if (reactions.length) byId.get(target)!.reactions = reactions;
  }
  return ordered.slice(-limit);
}

let reader: Promise<IrcClient> | null = null;
const joined = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

function dropReader(client?: IrcClient): void {
  reader = null;
  joined.clear();
  try { client?.quit(); } catch {}
}

async function readHistory(channel: string): Promise<ParsedMessage[]> {
  // event-playback replays reactions as TAGMSG instead of HistServ text; multiline keeps a
  // multi-line message in one batch instead of a row per line.
  reader ??= operClient(["draft/chathistory", "batch", "message-tags", "server-time", "draft/event-playback", "draft/multiline"]).then((client) => {
    client.send(`MODE ${client.nick} +B`);
    // Leaving a room (KICK, PART, SAPART) means the next read joins again. The watcher never resolves.
    const self = client.nick.toLowerCase();
    void client.waitFor((m) => {
      const target = (m.command === "KICK" ? m.params[1] : m.command === "PART" ? (m.prefix?.split("!")[0] || "") : "")?.toLowerCase();
      if (target === self) joined.delete((m.params[0] || "").toLowerCase());
      return false;
    });
    return client;
  });
  let client: IrcClient;
  try { client = await reader; } catch (error) { reader = null; throw error; }
  // A dropped connection (Ergo restart) refuses the write; open a fresh one on the next read.
  if (!client.send("PING peek")) { dropReader(client); throw new Error("peek reader disconnected"); }
  if (!joined.has(channel)) {
    const self = client.nick.toLowerCase();
    const echo = client.waitFor((m) => m.command === "JOIN" && (m.params[0] || "").toLowerCase() === channel && (m.prefix?.split("!")[0] || "").toLowerCase() === self);
    if (!client.send(`JOIN ${channel}`)) { dropReader(client); throw new Error("peek reader disconnected"); }
    const ok = await Promise.race([echo.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000))]);
    if (!ok) { dropReader(client); throw new Error(`peek reader could not join ${channel}`); }
    joined.add(channel);
  }
  // A slow or cut-short page is a failure, never an empty room, so it is not cached as one.
  const page = await pageHistoryResult(client, channel, "*", PEEK_LIMIT * 4, PAGE_TIMEOUT_MS, true);
  if (!page.complete) { dropReader(client); throw new Error(`peek history timed out for ${channel}`); }
  return page.items;
}

export function createPeek(load: (channel: string) => Promise<ParsedMessage[]> = readHistory, now = () => Date.now()) {
  const cache = new Map<string, { at: number; messages: Promise<PeekMessage[]> }>();
  return async function peek(raw: string): Promise<PeekMessage[] | null> {
    const channel = normalized(raw);
    if (!peekable(channel)) return null;
    const hit = cache.get(channel);
    if (hit && now() - hit.at < PEEK_TTL_MS) return hit.messages;
    // One read at a time on the shared connection; a failed read is not cached.
    const messages = queue.then(() => load(channel)).then((items) => peekMessages(items));
    queue = messages.catch(() => {});
    cache.set(channel, { at: now(), messages });
    messages.catch(() => { if (cache.get(channel)?.messages === messages) cache.delete(channel); });
    return messages;
  };
}
