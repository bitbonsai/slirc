// Channel-history clearing over IRC. HistServ has no channel-wide purge: only DELETE <target>
// <msgid> (and FORGET, which is per-account and must not be used here). So a full clear pages
// CHATHISTORY and deletes one msgid at a time. Shared by the app's channel-teardown path and by
// scripts/history-prune.ts, so there is one pager and one delete.
//
// HistServ DELETE works even for a channel the oper is not on and that Ergo no longer has, but
// CHATHISTORY only answers for a channel that still exists. Callers must clear BEFORE unregistering
// (grants.unregisterChannel does not delete history, and SAJOIN after unregister would recreate an
// empty foreign room).
//
// NICK and QUIT rows are never deleted. Ergo writes one row with one msgid into every channel the
// user is in, and stock HistServ DELETE looks the msgid up without the target (LIMIT 1), so deleting
// it here can remove another channel's copy instead. They hold no message content. Callers must
// negotiate draft/event-playback so these rows arrive as NICK/QUIT and can be told apart; without it
// Ergo replays them as HistServ PRIVMSGs like any other event.

import { type IrcClient, type ParsedMessage } from "./irc.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CHANNEL = /^#[a-z0-9][a-z0-9_-]{0,63}$/i;
const HISTSERV = /^histserv$/i;

export interface ChannelHistoryResult {
  channel: string;
  scanned: number;
  deleted: number;
  failed: number;
  // NICK/QUIT rows left in place because their msgid is shared with other channels.
  skipped: number;
  // True when work stopped early (deadline, page cap, delete timeout or a failed scan page).
  // A partial result must be logged, never presented as a complete clear.
  partial: boolean;
}

export interface ClearHistoryOptions {
  pageSize?: number;
  pageTimeoutMs?: number;
  deleteTimeoutMs?: number;
  maxPages?: number;
  // Total budget across paging and deletes. Unset means run to completion (scripts).
  deadlineMs?: number;
  now?: () => number;
  onTarget?: (message: ParsedMessage) => void;
}

export function sharedHistoryEvent(message: ParsedMessage): boolean {
  return message.command === "NICK" || message.command === "QUIT";
}

export function validHistoryChannel(channel: string): boolean {
  return CHANNEL.test(channel);
}

// The scripts' join: SAJOIN on an oper connection (grants operClient; SAJOIN without OPER is
// refused). Resolves "" once joined, else Ergo's refusal for this channel (numeric and text) or a
// timeout note, so a script can say why it skipped a channel.
export async function sajoinRefusal(client: IrcClient, channel: string, timeoutMs = 5_000): Promise<string> {
  const self = client.nick.toLowerCase();
  const target = channel.toLowerCase();
  let refusal = "";
  const done = client.waitFor((m) => {
    if (m.command === "JOIN" && (m.params[0] || "").toLowerCase() === target && (m.prefix?.split("!")[0] || "").toLowerCase() === self) return true;
    const aboutChannel = m.params.some((param) => param.toLowerCase() === target);
    if ((/^[45]\d\d$/.test(m.command) && (m.command === "481" || aboutChannel)) || (m.command === "FAIL" && aboutChannel)) {
      refusal = `${m.command} ${m.params.slice(1).join(" ")}`;
      return true;
    }
    return false;
  });
  client.send(`SAJOIN ${client.nick} ${channel}`);
  const answered = await Promise.race([done.then(() => true), sleep(timeoutMs).then(() => false)]);
  return answered ? refusal : `no reply from Ergo within ${timeoutMs / 1000} s`;
}

// SAJOIN the oper and wait for the self JOIN echo so CHATHISTORY does not race the membership.
// Returns false on timeout; the caller decides whether an empty scan is trustworthy.
export async function joinHistoryChannel(client: IrcClient, channel: string, timeoutMs = 3_000): Promise<boolean> {
  const nick = client.nick.toLowerCase();
  const target = channel.toLowerCase();
  const joined = client.waitFor((m) => m.command === "JOIN"
    && (m.params[0] || "").toLowerCase() === target
    && (m.prefix?.split("!")[0] || "").toLowerCase() === nick);
  client.send(`SAJOIN ${client.nick} ${channel}`);
  return Promise.race([joined.then(() => true), sleep(timeoutMs).then(() => false)]);
}

// One CHATHISTORY page, newest-first before `before`. Resolves on the closing BATCH; a timeout
// resolves with whatever arrived so the caller can bound the whole operation.
export async function pageHistory(client: IrcClient, channel: string, before: string, pageSize: number, timeoutMs: number): Promise<ParsedMessage[]> {
  return (await pageHistoryResult(client, channel, before, pageSize, timeoutMs)).items;
}

// The same page, with `complete` false when the timeout cut it short, for callers that must tell a
// short page from a slow one. `nested` also keeps the lines inside batches opened in the page (a
// draft/multiline message), which arrive tagged with the inner batch instead of the page's.
export async function pageHistoryResult(client: IrcClient, channel: string, before: string, pageSize: number, timeoutMs: number, nested = false): Promise<{ items: ParsedMessage[]; complete: boolean }> {
  return new Promise((resolve) => {
    const items: ParsedMessage[] = [];
    const inner = new Set<string>();
    let batchId: string | null = null;
    let settled = false;
    const finish = (complete: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ items, complete });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.waitFor((m) => {
      if (settled) return true;
      if (m.command === "BATCH") {
        const ref = m.params[0] || "";
        if (ref.startsWith("+") && m.params[1] === "chathistory" && m.params[2] === channel) { batchId = ref.slice(1); return false; }
        if (batchId && ref === `-${batchId}`) { finish(true); return true; }
        if (nested && batchId && ref.startsWith("+") && m.tags.batch === batchId) { inner.add(ref.slice(1)); items.push(m); }
        return false;
      }
      if (batchId && (m.tags.batch === batchId || (!!m.tags.batch && inner.has(m.tags.batch)))) items.push(m);
      return false;
    });
    client.send(`CHATHISTORY BEFORE ${channel} ${before} ${pageSize}`);
  });
}

// Walk a channel's history oldest-first through the BEFORE cursor. Yields one page at a time so
// callers can act without holding the whole transcript.
export async function* scanChannelHistory(client: IrcClient, channel: string, options: Pick<ClearHistoryOptions, "pageSize" | "pageTimeoutMs" | "maxPages"> = {}): AsyncGenerator<ParsedMessage[]> {
  const pageSize = options.pageSize ?? 1_000;
  const pageTimeoutMs = options.pageTimeoutMs ?? 8_000;
  const maxPages = options.maxPages ?? 200;
  let before = "*";
  for (let page = 0; page < maxPages; page++) {
    const items = await pageHistory(client, channel, before, pageSize, pageTimeoutMs);
    if (!items.length) return;
    yield items;
    const oldest = items.map((m) => m.tags.time).filter(Boolean).sort()[0];
    if (!oldest || items.length < pageSize) return;
    before = `timestamp=${oldest}`;
  }
}

// Delete one message by msgid. Returns the HistServ reply on success, null on failure or timeout.
// The target is always the caller's exact channel; HistServ never infers it.
//
// Ergo's event-playback replays stored JOIN/PART/MODE rows as HistServ PRIVMSGs whose msgid is the
// real row msgid with a leading `_`. HistServ does not know the `_` form ("not found"); it deletes
// the real row by the stripped id. Messages without the marker are sent unchanged.
export function storedHistoryMsgid(msgid: string): string {
  return msgid.startsWith("_") ? msgid.slice(1) : msgid;
}

export async function deleteHistoryMsgid(client: IrcClient, channel: string, msgid: string, timeoutMs = 5_000): Promise<string | null> {
  let reply = "";
  const answered = client.waitFor((m) => {
    if (m.command !== "NOTICE" || !HISTSERV.test(m.prefix?.split("!")[0] || "")) return false;
    reply = m.params.at(-1) || "";
    return true;
  });
  client.send(`PRIVMSG HistServ :DELETE ${channel} ${storedHistoryMsgid(msgid)}`);
  const got = await Promise.race([answered.then(() => true), sleep(timeoutMs).then(() => false)]);
  return got && /success|deleted/i.test(reply) ? reply : null;
}

// Delete every item on one channel. The client must already be joined to it. Bounded per page and
// per delete; an optional whole-operation deadline marks the result partial instead of hanging.
export async function clearChannelHistory(client: IrcClient, channel: string, options: ClearHistoryOptions = {}): Promise<ChannelHistoryResult> {
  const now = options.now ?? Date.now;
  const deadline = options.deadlineMs === undefined ? Infinity : now() + options.deadlineMs;
  const deleteTimeoutMs = options.deleteTimeoutMs ?? 5_000;
  const pageSize = options.pageSize ?? 1_000;
  const maxPages = options.maxPages ?? 200;
  let pages = 0, lastPageSize = 0;
  let scanned = 0, eligible = 0, deleted = 0, failed = 0, skipped = 0, partial = false;
  try {
    for await (const items of scanChannelHistory(client, channel, options)) {
      pages++;
      lastPageSize = items.length;
      scanned += items.length;
      for (const message of items) {
        if (!message.tags.msgid) continue;
        if (sharedHistoryEvent(message)) { skipped++; continue; }
        eligible++;
        options.onTarget?.(message);
        if (now() >= deadline) { partial = true; break; }
        const reply = await deleteHistoryMsgid(client, channel, message.tags.msgid, deleteTimeoutMs);
        if (reply) deleted++;
        else failed++;
      }
      if (partial) break;
    }
  } catch {
    partial = true;
  }
  if (!partial && pages >= maxPages && lastPageSize >= pageSize) partial = true;
  if (!partial && (failed > 0 || deleted + failed !== eligible)) partial = true;
  return { channel, scanned, deleted, failed, skipped, partial };
}
