import type { ParsedMessage } from "../../shared/irc.ts";
import type { RoomContext } from "../../shared/room-context.ts";
import { isOwnerMention } from "./listen.ts";

export type MentionTrigger = { room: string; thread?: string; from: string; text: string; msgid: string };
// A trigger plus the bounded, untrusted room context that preceded it. Context entries keep the
// server-authored account tag, nick, time, and msgid; they are never instructions.
export type Mention = MentionTrigger & { context: RoomContext[]; contextTruncated: boolean };

export const CONTEXT_MAX_MESSAGES = 20;
export const CONTEXT_MAX_CHARS = 4_000;
// Raw per-room ceiling so a long-lived session cannot grow context without bound before bounding.
const ROOM_BUFFER_MAX = 200;
// Trigger msgids are remembered so reconnect/history replay cannot execute one request twice.
const TRIGGER_SEEN_MAX = 2_000;

const roomPattern = /^[#&][^\x00\x07\r\n ,:]{1,63}$/;
const nickPattern = /^[A-Za-z][A-Za-z0-9_\-\[\]\\^{}|`]{0,31}$/;
const nickOf = (prefix = "") => prefix.split("!", 1)[0];

// A complete PRIVMSG (multiline batches already joined) that mentions the agent and comes from the owner's
// account. Direct messages addressed to the agent nick report the sender as the room. Slirc threads are
// #t- channels, so the thread field is set when the mention landed in one.
export function mentionFrom(message: ParsedMessage, nick: string, owner: string): MentionTrigger | undefined {
  let room = message.params[0] || "";
  // In the DM with the owner every line is for the agent; elsewhere the owner has to mention it.
  const direct = /^#dm-/i.test(room) || room.toLowerCase() === nick.toLowerCase();
  const fromOwner = message.command === "PRIVMSG" && message.tags.account?.toLowerCase() === owner.toLowerCase();
  if (!(direct ? fromOwner : isOwnerMention(message, nick, owner))) return undefined;
  if (room.toLowerCase() === nick.toLowerCase()) room = nickOf(message.prefix);
  if (!roomPattern.test(room) && !nickPattern.test(room)) return undefined;
  const msgid = message.tags.msgid;
  if (!msgid) return undefined;
  const mention: MentionTrigger = { room, from: nickOf(message.prefix), text: message.params[1] || "", msgid };
  if (/^#t-/i.test(room)) mention.thread = room;
  return mention;
}

// Keep the newest messages that fit both bounds, dropping oldest first. Any drop flips truncated.
export function boundContext(
  entries: RoomContext[],
  maxMessages = CONTEXT_MAX_MESSAGES,
  maxChars = CONTEXT_MAX_CHARS,
): { context: RoomContext[]; truncated: boolean } {
  let truncated = entries.length > maxMessages;
  const tail = truncated ? entries.slice(-maxMessages) : entries;
  let total = 0;
  const kept: RoomContext[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    total += tail[i].text.length;
    if (total > maxChars) {
      truncated = true;
      break;
    }
    kept.unshift(tail[i]);
  }
  return { context: kept, truncated };
}

type Batch = { tags: Record<string, string>; prefix?: string; target: string; text: string; lines: number };

// Feeds raw IRC lines in, hands back one Mention when the owner addresses the agent. Multiline batches are
// joined first so the mention check sees the whole message. Every allowed PRIVMSG is buffered as untrusted
// context, whoever sent it; only the owner's account tag can turn the buffer into a trigger.
export class MentionWatcher {
  private multiline = new Map<string, Batch>();
  private contexts = new Map<string, RoomContext[]>();
  private triggers = new Set<string>();

  constructor(
    private nick: string,
    private owner: string,
    // Predicate over the wire target (channel name or agent nick). Default accepts everything so the
    // standalone `wait` fallback keeps working; the resident session passes its granted-room set.
    private allow: (target: string) => boolean = () => true,
  ) {}

  handle(message: ParsedMessage): Mention | undefined {
    if (message.command === "BATCH") {
      const marker = message.params[0] || "";
      if (marker.startsWith("+") && message.params[1] === "draft/multiline") {
        this.multiline.set(marker.slice(1), { tags: message.tags, prefix: message.prefix, target: message.params[2] || "", text: "", lines: 0 });
        return undefined;
      }
      if (marker.startsWith("-")) {
        const batch = this.multiline.get(marker.slice(1));
        if (!batch) return undefined;
        this.multiline.delete(marker.slice(1));
        return this.receive({ tags: batch.tags, prefix: batch.prefix, command: "PRIVMSG", params: [batch.target, batch.text] });
      }
      return undefined;
    }
    if (message.command !== "PRIVMSG") return undefined;
    const batch = this.multiline.get(message.tags.batch);
    if (batch) {
      if (batch.lines && !("draft/multiline-concat" in message.tags)) batch.text += "\n";
      batch.text += message.params[1] || "";
      batch.lines++;
      return undefined;
    }
    return this.receive(message);
  }

  private receive(message: ParsedMessage): Mention | undefined {
    const target = message.params[0] || "";
    if (!this.allow(target)) return undefined;
    const text = message.params[1] || "";
    const room = target.toLowerCase() === this.nick.toLowerCase() ? nickOf(message.prefix) : target;
    const msgid = message.tags.msgid;
    if (msgid) {
      const entries = this.contexts.get(room.toLowerCase()) || [];
      // History replay and live events can carry the same msgid; keep one copy for context.
      if (!entries.some((entry) => entry.messageId === msgid)) {
        entries.push({ messageId: msgid, account: message.tags.account ?? null, author: nickOf(message.prefix), time: message.tags.time || "", text });
        this.contexts.set(room.toLowerCase(), entries.slice(-ROOM_BUFFER_MAX));
      }
    }
    const mention = mentionFrom(message, this.nick, this.owner);
    if (!mention) return undefined;
    if (this.triggers.has(mention.msgid)) return undefined;
    this.triggers.add(mention.msgid);
    if (this.triggers.size > TRIGGER_SEEN_MAX) this.triggers.delete(this.triggers.values().next().value!);
    const { context, truncated } = boundContext((this.contexts.get(room.toLowerCase()) || []).filter((entry) => entry.messageId !== mention.msgid));
    return { ...mention, context, contextTruncated: truncated };
  }
}
