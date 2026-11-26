// The update note: after a deploy, one short message in the open channel about what changed for
// the people who use the app. scripts/update-note.ts is the command; this file holds the instance
// facts, the hand-written note cleanup, the stored last version and the post itself.

import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { HELPER_NICKS, UPDATES_NICK } from "../shared/service-bots.ts";
import { enabledHelpers, slircMode } from "./config.ts";
import { CONCAT_TAG, wireParts } from "../shared/multiline.ts";

export const LAST_KEY = "update_notes_last_commit";

const HELPER_USES: Record<string, string> = {
  help: "answers questions about Slirc",
  remind: "sets reminders",
  poll: "runs polls",
  welcome: "greets the public channel each day",
  links: "keeps a library of shared links",
};

// What people on this instance can use, read from the app container's own settings: the helpers
// (SLIRC_HELPERS), agents (SLIRC_AGENTS_ENABLED), push notifications (SLIRC_BOT_ENABLED), the
// mode and the channels anyone can find.
export function instanceFacts(): string {
  const on = enabledHelpers();
  const helpers = HELPER_NICKS.map((nick) => `- ${nick} helper (${HELPER_USES[nick] || nick}): ${on.includes(nick) ? "on" : "off"}`);
  const channels = (db.query(`SELECT channel FROM channels WHERE visibility = 'workspace' AND archived_at IS NULL
                              AND channel NOT LIKE '#t-%' ORDER BY channel LIMIT 40`).all() as { channel: string }[]).map((row) => row.channel);
  const open = (process.env.OPEN_CHANNELS || "").split(",").map((channel) => channel.trim().toLowerCase()).filter(Boolean);
  const listed = [...new Set([...open, ...channels])];
  return [
    ...helpers,
    `- coding agents in channels: ${process.env.SLIRC_AGENTS_ENABLED === "false" ? "off" : "on"}`,
    `- push notifications: ${process.env.SLIRC_BOT_ENABLED === "false" || process.env.PUSHBOT_ENABLED === "false" ? "off" : "on"}`,
    `- people who aren't signed in can read the public channel: ${slircMode() === "public_playground" ? "yes" : "no"}`,
    `- other bots: none besides the helpers above`,
    `- public channels: ${listed.length ? listed.join(", ") : "none"}`,
  ].join("\n");
}

// A note someone wrote by hand, as the lines to post: line endings evened out, blank lines at
// either end dropped, the rest kept as written. Nothing left is an error.
export function handNote(text: string): string {
  const note = text.replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "");
  if (!note.trim()) throw new Error("no note on stdin");
  return note;
}

export function lastCommit(): string | null {
  return (db.query("SELECT value FROM meta WHERE key = ?").get(LAST_KEY) as { value: string } | null)?.value ?? null;
}

export function recordCommit(commit: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(LAST_KEY, commit);
}

// The bot is owned by the instance, like the helpers: a NickServ account and a `bot` row, created
// on first use. A person who already has the nick keeps it and the note is not posted.
let ensuredAccount: Promise<string> | null = null;

async function ensureAccount(): Promise<string> {
  if (!ensuredAccount) {
    ensuredAccount = ensureAccountOnce().catch((error) => {
      ensuredAccount = null;
      throw error;
    });
  }
  return ensuredAccount;
}

async function ensureAccountOnce(): Promise<string> {
  const { ergo } = await import("./accounts.ts");
  const { accountIrcPassword } = await import("./irc-key.ts");
  const existing = db.query("SELECT kind FROM accounts WHERE nick = ? COLLATE NOCASE").get(UPDATES_NICK) as { kind: string } | null;
  if (existing && existing.kind !== "bot") throw new Error(`a ${existing.kind} account already uses the nick ${UPDATES_NICK}`);
  // Same as the helpers: the row's id and counter give the password, and NickServ is made to agree.
  const now = Date.now();
  db.query(`INSERT INTO accounts (nick, email, irc_password_gen, role, kind, owner, verified_at, provisional_expires_at, created_at)
            VALUES (?, ?, 0, 'member', 'bot', NULL, ?, NULL, ?)
            ON CONFLICT(nick) DO UPDATE SET owner = NULL`)
    .run(UPDATES_NICK, `${UPDATES_NICK}@helpers.invalid`, now, now);
  const password = accountIrcPassword(db.query("SELECT account_id, irc_password_gen FROM accounts WHERE nick = ? COLLATE NOCASE")
    .get(UPDATES_NICK) as { account_id: string; irc_password_gen: number | null });
  const registered = await ergo("/v1/ns/saregister", { accountName: UPDATES_NICK, passphrase: password });
  if (!registered.success && registered.errorCode !== "ACCOUNT_EXISTS") throw new Error(registered.error || "could not create the updates account");
  const updated = await ergo("/v1/ns/passwd", { accountName: UPDATES_NICK, passphrase: password });
  if (!updated.success) throw new Error(updated.error || "could not set the updates password");
  return password;
}

// Serialize posts so bursty webhook deliveries do not collide on the single `updates` nick.
let postQueue: Promise<void> = Promise.resolve();

// Joins, posts one message and leaves. Resolves only once Ergo echoes the message back and the
// channel's history holds it: Ergo can echo a message to its sender and still keep it out of
// history (op-moderated channels), and then nobody who loads the channel later sees the note.
// Ergo's refusals (FAIL BATCH, 4xx numerics) end the post at once, with Ergo's reason.
export function postNote(channel: string, note: string, timeoutMs = 30_000): Promise<void> {
  const run = postQueue.then(() => postNoteNow(channel, note, timeoutMs));
  postQueue = run.then(() => {}, () => {});
  return run;
}

async function postNoteNow(channel: string, note: string, timeoutMs = 30_000): Promise<void> {
  const { IrcClient } = await import("./irc.ts");
  const password = await ensureAccount();
  const client = new IrcClient({
    host: process.env.ERGO_HOST || "127.0.0.1",
    port: Number(process.env.ERGO_PORT || 6667),
    nick: UPDATES_NICK,
    realname: "Slirc updates",
    saslUser: UPDATES_NICK,
    saslPass: password,
    capabilities: ["message-tags", "batch", "draft/multiline", "echo-message", "draft/chathistory", "server-time"],
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out posting the note")), timeoutMs); });
  try {
    await Promise.race([client.connect(timeoutMs), deadline]);
    // A lingering always-on session would keep the bot in the channel after it leaves.
    client.send("NS SET ALWAYS-ON false");
    client.send(`MODE ${UPDATES_NICK} +B`);
    const target = channel.toLowerCase();
    let refused = "";
    const joined = client.waitFor((m) => {
      if (m.command === "JOIN" && (m.params[0] || "").toLowerCase() === target) return true;
      if (["403", "405", "471", "473", "474", "475", "477"].includes(m.command)) { refused = m.params.at(-1) || m.command; return true; }
      return false;
    });
    client.send(`JOIN ${channel}`);
    await Promise.race([joined, deadline]);
    if (refused) throw new Error(`could not join ${channel}: ${refused}`);
    let msgid = "";
    let failure = "";
    const fromBot = (m: { prefix?: string }) => (m.prefix || "").split("!", 1)[0].toLowerCase() === UPDATES_NICK;
    const echoed = client.waitFor((m) => {
      if (m.command === "FAIL" || /^4\d\d$/.test(m.command)) { failure = m.params.slice(1).join(" ") || m.command; return true; }
      // A multiline echo carries its msgid on the batch opener, a single line on the line itself.
      if (m.command === "BATCH" && m.params[1] === "draft/multiline" && fromBot(m)) { msgid = m.tags.msgid || ""; return false; }
      if (m.command !== "PRIVMSG" || (m.params[0] || "").toLowerCase() !== target || !fromBot(m)) return false;
      msgid ||= m.tags.msgid || "";
      return true;
    });
    const lines = note.split("\n");
    // A long hand-written line is cut into parts Ergo can relay, joined again on read.
    const parts = wireParts(note, channel);
    if (parts.length > 1 && client.enabledCapabilities.has("draft/multiline")) {
      const batch = `updates-${randomBytes(4).toString("hex")}`;
      client.send(`BATCH +${batch} draft/multiline ${channel}`);
      for (const part of parts) client.send(`@batch=${batch}${part.concat ? `;${CONCAT_TAG}` : ""} PRIVMSG ${channel} :${part.text}`);
      client.send(`BATCH -${batch}`);
    } else {
      for (const line of lines) client.send(`PRIVMSG ${channel} :${line}`);
    }
    await Promise.race([echoed, deadline]);
    if (failure) throw new Error(`Ergo refused the note in ${channel}: ${failure}`);
    const { pageHistoryResult } = await import("./history.ts");
    const page = await Promise.race([pageHistoryResult(client, target, "*", 20, timeoutMs, true), deadline]);
    if (!msgid || !page.items.some((m) => m.tags.msgid === msgid)) {
      throw new Error(`the note was echoed but is not in ${channel}'s history, so people loading the channel won't see it`);
    }
    client.send(`PART ${channel}`);
  } finally {
    clearTimeout(timer);
    client.quit();
  }
}
