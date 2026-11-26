import webpush from "web-push";
import { db, vapidKeys } from "./db.ts";
import { IrcClient, type ParsedMessage } from "./irc.ts";
import { matchesMention } from "./mention.ts";
import { isMember, recordValidatedPublicAuthorMessage, reopenDirectOnMessage, watchedChannels, asciiFold } from "./rooms.ts";
import { publish } from "./live.ts";
import { createHmac } from "node:crypto";
import { accountByNick, allAccounts, ergo } from "./accounts.ts";
import { isDailyGreeting } from "../shared/service-bots.ts";
import { isConcat } from "../shared/multiline.ts";
import { agentMetadata } from "./agent-session.ts";

export function vapidContact(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env.VAPID_CONTACT?.trim();
  if (direct) return direct;
  const from = env.RESEND_FROM?.trim();
  if (!from) return null;
  const angle = from.match(/<([^<>\s]+@[^<>\s]+)>/);
  const address = (angle ? angle[1] : from).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address) ? `mailto:${address}` : null;
}

let configuredVapidContact: string | null = null;
function ensureVapidDetails(): boolean {
  const contact = vapidContact();
  if (!contact) return false;
  if (configuredVapidContact !== contact) {
    const { publicKey, privateKey } = vapidKeys();
    webpush.setVapidDetails(contact, publicKey, privateKey);
    configuredVapidContact = contact;
  }
  return true;
}

function nickOf(prefix?: string) {
  return (prefix || "").split("!", 1)[0];
}

// Where a notification opens: the channel or thread, or the root for a DM, whose route needs the
// other person's nick rather than the #dm-* channel name.
export function pushUrl(target: string): string {
  return /^#dm-/i.test(target) || !target.startsWith("#") ? "/" : `/#${target.slice(1)}`;
}

async function notify(nick: string, title: string, body: string, tag: string, url = "/") {
  const rows = db.query("SELECT endpoint, p256dh, auth FROM subscriptions WHERE nick = ?").all(nick) as { endpoint: string; p256dh: string; auth: string }[];
  if (!rows.length) return;
  if (!ensureVapidDetails()) {
    console.error("push skipped: VAPID_CONTACT (or RESEND_FROM) required");
    return;
  }
  for (const row of rows) {
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify({ title, body, tag, url }));
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) db.query("DELETE FROM subscriptions WHERE endpoint = ?").run(row.endpoint);
      else console.error("push failed:", error);
    }
  }
}

function preference(nick: string) {
  return db.query("SELECT preference FROM notification_prefs WHERE nick = ?").get(nick) as { preference: string } | null;
}

// Multiline messages arrive as one BATCH of PRIVMSGs; notify once with the
// joined text instead of once per line.
const multiline = new Map<string, { from: string; target: string; lines: string[]; edit: boolean }>();

// Someone who turned off the daily G'day in Settings gets no push for it; everyone else still does.
export function wantsChannelPush(nick: string, from: string, text: string): boolean {
  const pref = preference(nick)?.preference || "all";
  if (pref === "none") return false;
  if (isDailyGreeting(from, text) && (db.query("SELECT hide_greeting FROM accounts WHERE nick = ? COLLATE NOCASE").get(nick) as { hide_greeting: number } | null)?.hide_greeting) return false;
  return pref === "all" || matchesMention(text, nick);
}

// The name the app shows for an agent (its session name, as /auth/me sends it); null for people and
// removed agents, which keep their nick.
function agentName(nick: string): string | null {
  return agentMetadata(nick)?.name || null;
}

// Push text is read outside the app, so an agent's `@nick` reads as its display name, like the chip
// in the transcript. Only the notification changes; matching and the IRC line keep the nick.
export function pushText(text: string, nameOf: (nick: string) => string | null = agentName): string {
  return text.replace(/(^|[^\w@])@([\w\-\[\]\\^{}|`]+)/g, (all, lead: string, nick: string) => {
    const name = nameOf(nick);
    return name ? lead + name : all;
  });
}

async function notifyChannel(from: string, target: string, text: string, channels: Set<string>) {
  if (!channels.has(target.toLowerCase())) return;
  let shown: string | null = null;
  for (const { nick } of allAccounts()) {
    if (nick === from || !isMember(nick, target)) continue;
    if (wantsChannelPush(nick, from, text)) await notify(nick, `${from} in ${target}`, shown ??= pushText(text), `channel:${from}:${chars(text, 40)}`, pushUrl(target));
  }
}

// A DM message reopens the pair for anyone who closed it, and tells both people's tabs so a DM they
// do not hold yet (closed, or started by the other side) appears without a reload.
export function reopenDirect(target: string) {
  if (!/^#dm-/i.test(target)) return;
  for (const nick of reopenDirectOnMessage(target)) publish(nick, "direct", { channel: target.toLowerCase() });
}

// ponytail: tags are used as notification dedupe keys; a slice keeps them bounded.
function chars(text: string, limit: number) {
  return text.length > limit ? text.slice(0, limit) : text;
}

async function handle(m: ParsedMessage, channels: Set<string>) {
  if (m.command === "BATCH") {
    const id = m.params[0]?.slice(1);
    if (m.params[0]?.startsWith("+") && m.params[1] === "draft/multiline") {
      multiline.set(id, { from: nickOf(m.prefix), target: m.params[2] || "", lines: [], edit: isEdit(m.tags) });
    } else if (m.params[0]?.startsWith("-")) {
      const batch = multiline.get(id);
      if (batch) {
        multiline.delete(id);
        if (batch.from && batch.from !== "slirc" && channels.has(batch.target.toLowerCase())) reopenDirect(batch.target);
        if (!batch.edit) await notifyChannel(batch.from, batch.target, batch.lines.join("\n"), channels);
      }
    }
    return;
  }
  if (m.command !== "PRIVMSG") return;
  const from = nickOf(m.prefix);
  const [target, text = ""] = m.params;
  if (/^#t-/i.test(target)) db.query("UPDATE threads SET last_activity = ? WHERE channel = ?").run(Date.now(), target.toLowerCase());
  if (!from || from === "slirc" || !channels.has(target.toLowerCase())) return;
  const author = typeof m.tags.account === "string" ? accountByNick(m.tags.account) : null;
  if (author && author.kind === "human" && author.verifiedAt && asciiFold(author.nick) === asciiFold(from) && m.tags.msgid) {
    recordValidatedPublicAuthorMessage(author.id, target, m.tags.msgid);
  }
  const batch = typeof m.tags.batch === "string" ? multiline.get(m.tags.batch) : null;
  if (batch) {
    // A concat part continues the line before it (a long line cut to fit Ergo's 512 bytes).
    if (isConcat(m.tags) && batch.lines.length) batch.lines[batch.lines.length - 1] += text;
    else batch.lines.push(text);
    return;
  }
  reopenDirect(target);
  if (!isEdit(m.tags)) await notifyChannel(from, target, text, channels);
}

// An edit (+draft/edit) changes a message people already saw, so it is not news worth a push.
export function isEdit(tags: ParsedMessage["tags"]): boolean {
  return typeof tags["+draft/edit"] === "string" && tags["+draft/edit"] !== "";
}

// The relay signs in like every other internal client, so an instance that requires SASL from
// everyone (a private workspace) still gets notifications. Its password is derived from the oper
// secret: nothing new to store, and it never leaves the server. Without ERGO_OPER_PASS the relay
// connects unauthenticated as before, which only works where Ergo exempts the app's network.
export async function relayCredentials(): Promise<{ saslUser: string; saslPass: string } | null> {
  const operPass = process.env.ERGO_OPER_PASS;
  if (!operPass) return null;
  const saslPass = createHmac("sha256", operPass).update("slirc-relay").digest("base64url");
  const registered = await ergo("/v1/ns/saregister", { accountName: "slirc", passphrase: saslPass });
  if (!registered.success && registered.errorCode !== "ACCOUNT_EXISTS") throw new Error(registered.error || "Could not create the slirc relay account.");
  const updated = await ergo("/v1/ns/passwd", { accountName: "slirc", passphrase: saslPass });
  if (!updated.success) throw new Error(updated.error || "Could not set the slirc relay password.");
  return { saslUser: "slirc", saslPass };
}

async function connect() {
  const channels = new Set<string>();
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let retrying = false;
  const reconnect = () => {
    if (retrying) return;
    retrying = true;
    if (syncTimer) clearInterval(syncTimer);
    setTimeout(() => void connect(), 3_000);
  };
  let credentials: Awaited<ReturnType<typeof relayCredentials>>;
  try { credentials = await relayCredentials(); }
  catch (error) {
    console.error("slirc relay account:", error instanceof Error ? error.message : error);
    reconnect();
    return;
  }
  const client = new IrcClient({
    host: process.env.ERGO_HOST || "127.0.0.1",
    port: Number(process.env.ERGO_PORT || 6667),
    nick: "slirc",
    realname: "notification relay",
    ...credentials,
    // Without these Ergo strips the `account` and `msgid` tags, and public-author evidence
    // (the fix for dead Message actions on people met in open channels) never records.
    capabilities: ["account-tag", "message-tags"],
    onMessage: (message) => void handle(message, channels),
    onClose: reconnect,
  });
  client.connect().then(() => {
    client.send("MODE slirc +B");
    const sync = () => {
      const watched = new Set(watchedChannels());
      for (const channel of watched) if (!channels.has(channel)) {
        channels.add(channel);
        client.send(`JOIN ${channel}`);
      }
      for (const channel of channels) if (!watched.has(channel)) {
        channels.delete(channel);
        client.send(`PART ${channel}`);
      }
    };
    sync();
    syncTimer = setInterval(sync, 5_000);
  }).catch((error) => {
    console.error("slirc connect failed:", error);
    reconnect();
  });
}

export function startSlircBot() {
  void connect();
}
