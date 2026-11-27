import { parseLine } from "../shared/irc.ts";
import { db } from "./db.ts";
import { publish } from "./live.ts";
import { isMember, normalized } from "./rooms.ts";

// A small index of IRCv3 `+reply` threads, built from lines as they pass through the /irc relay.
// It holds ids, nicks and times, never message text: the client reads the root's text from its own
// history. History replays and the same live line on several sockets are deduplicated by msgid.
// The tables live in db.ts. There is no one-time backfill; a thread appears once any of its replies has passed through.
// Roots whose own line has not passed through yet, so their author is unknown. Checked per line.
const rootsWithoutAuthor = new Set<string>((db.query("SELECT root_msgid FROM reply_threads WHERE root_author = ''").all() as { root_msgid: string }[]).map((row) => row.root_msgid));

const MSGID = /^[A-Za-z0-9_-]{1,512}$/;

// Called with every line the relay forwards to a browser. Only a channel message (or the opener of
// a multiline one) that carries both a msgid and a +reply tag changes the index.
export function observeReplyLine(line: string): void {
  const seen = /(?:^@|;)msgid=([^;\s]+)/.exec(line)?.[1];
  const isReply = line.includes("+reply=");
  if (!seen || (!isReply && !rootsWithoutAuthor.has(seen))) return;
  const parsed = parseLine(line);
  const sender = parsed.prefix?.split("!")[0];
  if (!sender) return;
  const { tags, params } = parsed;
  const command = parsed.command.toUpperCase();
  const target = command === "PRIVMSG" ? params[0] : command === "BATCH" && params[1] === "draft/multiline" ? params[2] : undefined;
  const msgid = tags.msgid;
  const parent = tags["+reply"];
  if (!target?.startsWith("#") || !msgid) return;
  // The root itself: its author started the thread, so it is on their list too.
  if (!parent) { claimRoot(msgid, sender.toLowerCase(), normalized(target)); return; }
  if (!MSGID.test(msgid) || !MSGID.test(parent)) return;
  // An edit re-sends the same reply under a new msgid; counting it would double the thread.
  if (tags["+draft/edit"]) return;
  const channel = normalized(target);
  const at = Date.parse(tags.time ?? "") || Date.now();
  const nick = sender.toLowerCase();
  const people: string[] = [];
  const added = db.transaction(() => {
    const root = (db.query("SELECT root_msgid FROM reply_thread_msgs WHERE msgid = ?").get(parent) as { root_msgid: string } | null)?.root_msgid ?? parent;
    if (root === msgid) return false;
    if (!db.query("INSERT OR IGNORE INTO reply_thread_msgs (msgid, root_msgid, nick, at) VALUES (?, ?, ?, ?)").run(msgid, root, nick, at).changes) return false;
    db.query("INSERT OR IGNORE INTO reply_threads (root_msgid, channel) VALUES (?, ?)").run(root, channel);
    db.query("INSERT OR IGNORE INTO reply_thread_people (root_msgid, nick) VALUES (?, ?)").run(root, nick);
    for (const row of db.query("SELECT nick FROM reply_thread_people WHERE root_msgid = ?").all(root) as { nick: string }[]) people.push(row.nick);
    return true;
  })();
  if (added) {
    if (!db.query("SELECT 1 FROM reply_threads WHERE root_msgid = ? AND root_author != ''").get(rootOf(msgid))) rootsWithoutAuthor.add(rootOf(msgid));
    for (const person of people) publish(person, "reply-threads", {});
  }
}

function rootOf(msgid: string): string {
  return (db.query("SELECT root_msgid FROM reply_thread_msgs WHERE msgid = ?").get(msgid) as { root_msgid: string }).root_msgid;
}

function claimRoot(root: string, author: string, channel: string): void {
  rootsWithoutAuthor.delete(root);
  const people: string[] = [];
  db.transaction(() => {
    if (!db.query("UPDATE reply_threads SET root_author = ? WHERE root_msgid = ? AND channel = ? AND root_author = ''").run(author, root, channel).changes) return;
    db.query("INSERT OR IGNORE INTO reply_thread_people (root_msgid, nick) VALUES (?, ?)").run(root, author);
    for (const row of db.query("SELECT nick FROM reply_thread_people WHERE root_msgid = ?").all(root) as { nick: string }[]) people.push(row.nick);
  })();
  for (const person of people) publish(person, "reply-threads", {});
}

export type ReplyThreadRow = { rootId: string; channel: string; replies: number; lastAt: string; lastBy: string; others: string[] };

// Threads this person started or replied to, newest activity first, in channels they can read now.
export function replyThreadsFor(nick: string, limit = 100): ReplyThreadRow[] {
  const me = nick.toLowerCase();
  const rows = db.query(`
    SELECT t.root_msgid AS rootId, t.channel AS channel, COUNT(m.msgid) AS replies, MAX(m.at) AS lastAt
    FROM reply_thread_people p
    JOIN reply_threads t ON t.root_msgid = p.root_msgid
    JOIN reply_thread_msgs m ON m.root_msgid = t.root_msgid
    WHERE p.nick = ?
    GROUP BY t.root_msgid ORDER BY lastAt DESC LIMIT ?`).all(me, limit * 2) as { rootId: string; channel: string; replies: number; lastAt: number }[];
  const out: ReplyThreadRow[] = [];
  const readable = new Map<string, boolean>();
  for (const row of rows) {
    let ok = readable.get(row.channel);
    if (ok === undefined) { ok = isMember(nick, row.channel); readable.set(row.channel, ok); }
    if (!ok) continue;
    const last = db.query("SELECT nick FROM reply_thread_msgs WHERE root_msgid = ? ORDER BY at DESC LIMIT 1").get(row.rootId) as { nick: string };
    const others = (db.query("SELECT at FROM reply_thread_msgs WHERE root_msgid = ? AND nick != ? ORDER BY at DESC LIMIT 50").all(row.rootId, me) as { at: number }[])
      .map((reply) => new Date(reply.at).toISOString());
    out.push({ rootId: row.rootId, channel: row.channel, replies: row.replies, lastAt: new Date(row.lastAt).toISOString(), lastBy: last.nick, others });
    if (out.length >= limit) break;
  }
  return out;
}
