// An admin's edit of a bot's message. The edit has to look like the bot's own edit to every client,
// plain IRC included, so it goes out from the bot's own account: a PRIVMSG carrying
// `+draft/edit=<old msgid>`, then a REDACT of the original with reason "edited", the same two lines
// a person's client sends for their own edit. The bot's password is derived from its account row
// (irc-key.ts), so no credential is stored or exposed. Only `bot` accounts qualify: the instance
// helpers (owner NULL) and the managed bots admins create. People and agents never do.

import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { accountIrcPassword } from "./irc-key.ts";
import { IrcClient, type ParsedMessage } from "./irc.ts";
import { CONCAT_TAG, wireParts } from "../shared/multiline.ts";

const host = () => process.env.ERGO_HOST || "127.0.0.1";
const port = () => Number(process.env.ERGO_PORT || 6667);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MSGID = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL = /^#[a-z0-9][a-z0-9_-]{0,62}$/i;
export const BOT_EDIT_MAX_BYTES = 4000;

export class BotEditError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// The bot row for a nick, or null for a person, an agent or an unknown nick.
export function editableBot(nick: string): { nick: string; account_id: string; irc_password_gen: number | null } | null {
  if (!nick) return null;
  return db.query("SELECT nick, account_id, irc_password_gen FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'bot'").get(nick) as
    { nick: string; account_id: string; irc_password_gen: number | null } | null;
}

export function validEditText(text: string): boolean {
  if (!text.trim() || /[\x00-\x09\x0b-\x1f\x7f]/.test(text)) return false;
  return new TextEncoder().encode(text).length <= BOT_EDIT_MAX_BYTES;
}

const author = (m: ParsedMessage) => (m.tags.account || (m.prefix || "").split("!", 1)[0] || "").toLowerCase();

// The message's author in the channel's history, or "" when Ergo no longer has it.
async function historyAuthor(client: IrcClient, channel: string, msgid: string, timeoutMs: number): Promise<string> {
  let batch = "";
  let found = "";
  const done = client.waitFor((m) => {
    if (m.command === "BATCH") {
      const ref = m.params[0] || "";
      if (ref.startsWith("+") && m.params[1] === "chathistory") { batch = ref.slice(1); return false; }
      if (batch && ref === `-${batch}`) return true;
      // A multiline message carries its msgid on its own batch opener inside the page.
      if (batch && ref.startsWith("+") && m.tags.msgid === msgid) found = author(m);
      return false;
    }
    if (batch && m.command === "PRIVMSG" && m.tags.msgid === msgid) found = author(m);
    if (m.command === "FAIL" && (m.params[0] || "").toUpperCase() === "CHATHISTORY") return true;
    return false;
  });
  client.send(`CHATHISTORY AROUND ${channel} msgid=${msgid} 3`);
  await Promise.race([done, sleep(timeoutMs)]);
  return found;
}

// Resolves once Ergo echoes the replacement. The original's REDACT is then best effort: Slirc clients
// hide an edited original by its `+draft/edit` link even if the REDACT is lost, as for any edit.
export async function editBotMessage(botNick: string, channel: string, msgid: string, text: string, guard?: () => boolean): Promise<{ msgid: string; redacted: boolean }> {
  if (!CHANNEL.test(channel)) throw new BotEditError("invalid channel", 400);
  if (!MSGID.test(msgid)) throw new BotEditError("invalid message id", 400);
  if (!validEditText(text)) throw new BotEditError("invalid text", 400);
  const bot = editableBot(botNick);
  if (!bot) throw new BotEditError("only bot messages can be edited", 403);
  const timeoutMs = Number(process.env.BOT_EDIT_TIMEOUT_MS || 5_000);
  const client = new IrcClient({
    host: host(), port: port(), nick: bot.nick, realname: "Slirc bot edit", saslUser: bot.nick, saslPass: accountIrcPassword(bot),
    capabilities: ["message-tags", "batch", "draft/multiline", "echo-message", "draft/chathistory", "server-time", "account-tag", "draft/message-redaction"],
  });
  try {
    await client.connect(timeoutMs);
    const target = channel.toLowerCase();
    let refused = "";
    const joined = client.waitFor((m) => {
      if (m.command === "JOIN" && (m.params[0] || "").toLowerCase() === target) return true;
      if (["403", "405", "471", "473", "474", "475", "477"].includes(m.command)) { refused = m.params.at(-1) || m.command; return true; }
      return false;
    });
    client.send(`JOIN ${channel}`);
    // A bot attached to a running session is already in the channel and gets no JOIN back.
    await Promise.race([joined, sleep(Math.min(timeoutMs, 2_000))]);
    if (refused) throw new BotEditError(`could not join ${channel}: ${refused}`, 502);

    const by = await historyAuthor(client, channel, msgid, timeoutMs);
    if (!by) throw new BotEditError("message not found", 404);
    if (by !== bot.nick.toLowerCase()) throw new BotEditError("only bot messages can be edited", 403);
    if (guard && !guard()) throw new BotEditError("moderation access changed", 403);

    const cid = randomBytes(8).toString("hex");
    let newId = "";
    let failure = "";
    const echoed = client.waitFor((m) => {
      if (m.command === "FAIL" || /^4\d\d$/.test(m.command)) { failure = m.params.slice(1).join(" ") || m.command; return true; }
      if ((m.command === "PRIVMSG" || m.command === "BATCH") && m.tags["+slirc/cid"] === cid) { newId = m.tags.msgid || ""; return true; }
      return false;
    });
    const tags = `+slirc/cid=${cid};+draft/edit=${msgid}`;
    const parts = wireParts(text, channel);
    if (parts.length > 1) {
      if (!client.enabledCapabilities.has("draft/multiline")) throw new BotEditError("multiline not supported by this server", 502);
      const batch = `edit-${randomBytes(4).toString("hex")}`;
      client.send(`@${tags} BATCH +${batch} draft/multiline ${channel}`);
      for (const part of parts) client.send(`@batch=${batch}${part.concat ? `;${CONCAT_TAG}` : ""} PRIVMSG ${channel} :${part.text}`);
      client.send(`BATCH -${batch}`);
    } else {
      client.send(`@${tags} PRIVMSG ${channel} :${text}`);
    }
    if (!await Promise.race([echoed.then(() => true), sleep(timeoutMs).then(() => false)])) throw new BotEditError("the edit was not confirmed", 504);
    if (failure || !newId) throw new BotEditError(`Ergo refused the edit: ${failure || "no message id"}`, 502);

    let redacted = false;
    const gone = client.waitFor((m) => {
      if (m.command === "REDACT" && (m.params[0] || "").toLowerCase() === target && m.params[1] === msgid) { redacted = true; return true; }
      return m.command === "FAIL" && (m.params[0] || "").toUpperCase() === "REDACT";
    });
    client.send(`REDACT ${channel} ${msgid} :edited`);
    await Promise.race([gone, sleep(timeoutMs)]);
    return { msgid: newId, redacted };
  } finally {
    client.quit();
  }
}
