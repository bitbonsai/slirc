// "Can read my DMs": an owner lets one of their agents read the DMs the owner is in, read-only.
//
// The agent never joins those DMs. Its own IRC connection stays outside them (Ergo's +si and the
// DM's two +I entries keep it out), so it has no way to post, react, edit or delete there. Reads go
// through the server: a short session of the `slirc` relay account, which already sits in every DM
// for notifications, asks Ergo for one page of CHATHISTORY and leaves. The relay is a multiclient
// account, so the extra session adds no JOIN, PART or QUIT that anyone in the DM could see.
//
// Every read checks the binding, the owner's setting and the DM pair again, before and after the
// await, so turning the setting off stops the next read at once.

import { db } from "./db.ts";
import { pageHistoryResult } from "./history.ts";
import { IrcClient, type ParsedMessage } from "./irc.ts";
import { authorizedBindingById, type Binding } from "./agent-session.ts";
import { directConversations } from "./rooms.ts";
import { peekMessages } from "./peek.ts";
import { relayPassword } from "./slirc-bot.ts";

export const OWNER_DM_LIMIT = 100;
const PAGE_TIMEOUT_MS = 5_000;

export type OwnerDmMessage = { messageId: string; nick: string; text: string; time: string; replyTo?: string };
export type OwnerDmReader = (channel: string, before: string, limit: number) => Promise<ParsedMessage[] | null>;

// One page of history over a relay session. Null when the relay can't sign in or Ergo answers
// incompletely: a slow page is never passed off as an empty DM.
async function relayReader(channel: string, before: string, limit: number): Promise<ParsedMessage[] | null> {
  const password = relayPassword();
  if (!password) return null;
  const client = new IrcClient({
    host: process.env.ERGO_HOST || "127.0.0.1", port: Number(process.env.ERGO_PORT || 6667),
    nick: "slirc", realname: "notification relay", saslUser: "slirc", saslPass: password,
    capabilities: ["draft/chathistory", "batch", "message-tags", "server-time", "draft/multiline"],
  });
  try {
    await client.connect();
    const page = await pageHistoryResult(client, channel, before, limit, PAGE_TIMEOUT_MS, true);
    return page.complete ? page.items : null;
  } catch {
    return null;
  } finally {
    try { client.quit(); } catch {}
  }
}

let reader: OwnerDmReader = relayReader;
export function setOwnerDmReaderForTests(next: OwnerDmReader = relayReader): void { reader = next; }

// The binding as it stands now, only while it is ready, authorized and the owner has the setting on.
export function ownerDmBinding(id: string): Binding | null {
  const binding = authorizedBindingById(id);
  return binding?.status === "ready" && binding.read_owner_dms === 1 ? binding : null;
}

export function setOwnerDmAccess(bindingId: string, enabled: boolean): void {
  db.query("UPDATE agent_session_bindings SET read_owner_dms=? WHERE id=?").run(enabled ? 1 : 0, bindingId);
}

// The owner's own open DMs. The agent's own DM is left out: it reads that one with slirc_history.
const ownerDmRows = (binding: Binding) => directConversations(binding.owner_nick)
  .filter((dm) => dm.nick.toLowerCase() !== binding.nick.toLowerCase());

// Listed by the other person's nick; the agent never learns or names a channel.
export const ownerDms = (binding: Binding): { nick: string }[] => ownerDmRows(binding).map((dm) => ({ nick: dm.nick }));

const ownerDmChannel = (binding: Binding, peer: string): string | null =>
  ownerDmRows(binding).find((dm) => dm.nick.toLowerCase() === peer.toLowerCase())?.channel ?? null;

// Recent messages, oldest first, from the owner's DM with `peer`. `before` is `*`, `msgid=…` or
// `timestamp=…`. Null when access is gone or the DM isn't the owner's; "unavailable" when Ergo
// didn't answer in full.
export async function readOwnerDm(bindingId: string, peer: string, before: string, limit: number): Promise<OwnerDmMessage[] | null | "unavailable"> {
  const binding = ownerDmBinding(bindingId);
  const channel = binding && ownerDmChannel(binding, peer);
  if (!binding || !channel) return null;
  const size = Math.max(1, Math.min(OWNER_DM_LIMIT, Math.floor(limit) || 50));
  const items = await reader(channel, before, size);
  // The owner may have turned the setting off, or left the DM, while Ergo answered.
  const still = ownerDmBinding(bindingId);
  if (!still || ownerDmChannel(still, peer) !== channel) return null;
  if (!items) return "unavailable";
  return peekMessages(items, size).map((message) => ({
    messageId: message.id, nick: message.nick, text: message.action ? `* ${message.text}` : message.text, time: message.time,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  }));
}
