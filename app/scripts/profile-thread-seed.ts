// Guarded local sample DM-thread seed for the isolated slirc2 stack. Explicitly invoked by
// the coordinator inside the `slirc2-app` container — never from app startup:
//
//   podman exec -e SLIRC_PROFILE_THREAD_SEED=true slirc2-app bun scripts/profile-thread-seed.ts
//
// Requires SLIRC_DEV_PROFILE=slirc2 (the coordinator injects it). Production sets neither.
//
// Reuses the existing owner/Eve direct conversation, posts one real root PRIVMSG there,
// provisions the private child with the same helpers the `/api/dms/:nick/threads` route uses
// (createChannel + makeChannelSecret + channels/channel_members rows), registers the thread
// metadata the way `POST /api/threads` does, and seeds a few short Eve replies over real IRC.
//
// Idempotent per write: a two-phase stamp (`sending` before the call, `confirmed` after the
// echo/row is durable) means a rerun skips confirmed writes and aborts on an uncertain one.
// No blind retry. A malformed or unknown stamp value is an error, never treated as absent.
// To replay one write, confirm what the channel shows, then delete that exact row by key.
// No credentials or session tokens are printed.
//
// Existing fixture threads are untouched: this creates one new child and never resets or deletes.
import type { ParsedMessage } from "../src/irc.ts";
import {
  PROFILE_THREAD_SAMPLE,
  profileThreadSeedGuard,
  threadStamp,
  threadTitle,
} from "./profile-thread-fixtures.ts";

const guard = profileThreadSeedGuard(process.env);
if (!guard.ok) {
  console.error(guard.reason);
  process.exit(1);
}

const { accountByNick } = await import("../src/accounts.ts");
const { db } = await import("../src/db.ts");
const { directConversation } = await import("../src/rooms.ts");
const { createChannel, makeChannelSecret } = await import("../src/grants.ts");
const { IrcClient } = await import("../src/irc.ts");
const { randomBytes } = await import("node:crypto");

const OWNER = (process.env.OWNER_NICK || process.env.ADMIN_NICK || "admin").toLowerCase();
const PEER = (process.env.SLIRC_SEED_PEER || "eve").toLowerCase();
const HOST = process.env.ERGO_HOST || "127.0.0.1";
const PORT = Number(process.env.ERGO_PORT || 6667);
const CAPABILITIES = ["message-tags", "echo-message", "server-time"];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = (ms: number, message: string) => wait(ms).then(() => { throw new Error(message); });

type State = { status: "sending" | "confirmed"; at: number; msgid?: string; time?: string; channel?: string };
const readState = (key: string): State | null => {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return null;
  let parsed: Partial<State>;
  try {
    parsed = JSON.parse(row.value) as Partial<State>;
  } catch {
    throw new Error(`profile-thread-seed: ${key} holds malformed state; inspect the row before rerunning`);
  }
  if (parsed.status !== "sending" && parsed.status !== "confirmed") {
    throw new Error(`profile-thread-seed: ${key} holds unknown state ${JSON.stringify(parsed.status)}; inspect before rerunning`);
  }
  return parsed as State;
};
const writeState = (key: string, state: State) =>
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(state));
const uncertain = (key: string, state: State) =>
  console.warn(`profile-thread-seed: ${key} is ${state.status} (${new Date(state.at).toISOString()}); not replaying. ` +
    `Check the channel, then delete the row to resend: DELETE FROM meta WHERE key = '${key}';`);

const joined = new WeakMap<IrcClient, Set<string>>();
async function session(account: { nick: string; ircPassword: string }, realName: string): Promise<IrcClient> {
  const channels = new Set<string>();
  const client = new IrcClient({
    host: HOST, port: PORT, nick: account.nick, realname: realName,
    saslUser: account.nick, saslPass: account.ircPassword, capabilities: CAPABILITIES,
    onMessage: (message) => {
      const from = (message.prefix || "").split("!")[0].toLowerCase();
      if (message.command === "JOIN" && from === account.nick.toLowerCase() && message.params[0]) channels.add(message.params[0]);
      else if (message.command === "PART" && from === account.nick.toLowerCase() && message.params[0]) channels.delete(message.params[0]);
    },
  });
  joined.set(client, channels);
  await Promise.race([client.connect(), timeout(10_000, `connect timed out for ${account.nick}`)]);
  return client;
}

async function ensureJoin(client: IrcClient, channel: string): Promise<void> {
  const set = joined.get(client) ?? new Set<string>();
  joined.set(client, set);
  if (set.has(channel)) return;
  const nick = client.nick.toLowerCase();
  const waiter = client.waitFor((message) =>
    message.command === "JOIN" && (message.prefix || "").split("!")[0].toLowerCase() === nick && message.params[0] === channel);
  client.send(`JOIN ${channel}`);
  await Promise.race([waiter, timeout(8_000, `${client.nick} could not join ${channel}`)]);
  set.add(channel);
}

// Echo is matched by our own nick inside the predicate; the message is captured, then confirmed.
async function say(client: IrcClient, channel: string, text: string): Promise<ParsedMessage> {
  const nick = client.nick.toLowerCase();
  let echoed: ParsedMessage | null = null;
  const reply = client.waitFor((message) => {
    if (message.command !== "PRIVMSG" || message.params[0] !== channel || message.params[1] !== text) return false;
    if ((message.prefix || "").split("!")[0].toLowerCase() !== nick) return false;
    echoed = message;
    return true;
  });
  if (!client.send(`PRIVMSG ${channel} :${text}`)) throw new Error(`${client.nick} lost its connection to ${channel}`);
  await Promise.race([reply, timeout(8_000, `no echo for ${client.nick} in ${channel}`)]);
  if (!echoed) throw new Error(`message not confirmed in ${channel}`);
  return echoed;
}

const clients: IrcClient[] = [];
try {
  const owner = accountByNick(OWNER);
  const peer = accountByNick(PEER);
  if (!owner?.ircPassword) throw new Error(`owner account ${OWNER} has no IRC credentials; run migrate-founder first`);
  if (!peer?.ircPassword) throw new Error(`fixture account ${PEER} is missing; run the boot fixtures first`);

  // The owner/Eve direct conversation already exists; never provision or reset it here.
  const existing = directConversation(owner.nick, peer.nick);
  if (!existing) throw new Error(`no direct conversation between ${owner.nick} and ${peer.nick}; run the boot fixtures first`);
  const parent = existing.channel;

  // ── root ─────────────────────────────────────────────────────────────────
  const rootKey = threadStamp("root", owner.nick, 0);
  let root = readState(rootKey);
  if (root?.status === "sending") { uncertain(rootKey, root); process.exit(1); }
  if (!root) {
    writeState(rootKey, { status: "sending", at: Date.now() });
    const ownerClient = await session(owner, owner.nick);
    clients.push(ownerClient);
    await ensureJoin(ownerClient, parent);
    const echoed = await say(ownerClient, parent, PROFILE_THREAD_SAMPLE.root);
    const msgid = (echoed.tags.msgid || "").trim();
    if (!msgid) throw new Error(`Ergo returned no msgid for the root in ${parent}; the stamp stays uncertain`);
    root = { status: "confirmed", at: Date.now(), msgid, time: echoed.tags.time || new Date().toISOString() };
    writeState(rootKey, root);
  }
  const rootId = (root.msgid || "").trim();
  if (!rootId) throw new Error(`profile-thread-seed: confirmed root stamp ${rootKey} has no msgid; inspect before rerunning`);
  const rootTime = root.time || new Date().toISOString();

  // ── private child: same provisioning as POST /api/dms/:nick/threads ───────
  const childKey = threadStamp("child", owner.nick, 0);
  let child = readState(childKey);
  if (child?.status === "sending") { uncertain(childKey, child); process.exit(1); }
  if (!child) {
    const channel = `#t-${randomBytes(4).toString("hex").slice(0, 6)}`;
    writeState(childKey, { status: "sending", at: Date.now(), channel });
    await createChannel(channel, owner.nick, "secret");
    await makeChannelSecret(channel, [owner.nick, peer.nick]);
    db.transaction(() => {
      db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, 'secret', ?)").run(channel, owner.nick, Date.now());
      for (const member of [owner.nick, peer.nick]) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(channel, member);
      const now = Date.now();
      db.query("INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel) DO NOTHING")
        .run(channel, parent, rootId, threadTitle(PROFILE_THREAD_SAMPLE.root),
          `/?room=${encodeURIComponent(parent)}&msg=${encodeURIComponent(rootId)}`,
          owner.nick, PROFILE_THREAD_SAMPLE.root, rootTime, owner.nick, now, now);
    })();
    child = { status: "confirmed", at: Date.now(), channel };
    writeState(childKey, child);
  }
  const thread = child.channel!;

  // ── short realistic replies, in the thread only ───────────────────────────
  const peerClient = await session(peer, peer.nick);
  clients.push(peerClient);
  for (const [index, text] of PROFILE_THREAD_SAMPLE.replies.entries()) {
    const key = threadStamp("reply", peer.nick, index);
    const state = readState(key);
    if (state?.status === "confirmed") continue;
    if (state?.status === "sending") {
      uncertain(key, state);
      throw new Error(`profile-thread-seed: a reply in ${thread} is uncertain; inspect the thread before rerunning`);
    }
    writeState(key, { status: "sending", at: Date.now() });
    await ensureJoin(peerClient, thread);
    await say(peerClient, thread, text);
    writeState(key, { status: "confirmed", at: Date.now() });
  }

  // Output the thread channel, root id and parent only. Nothing here is a secret.
  console.log(JSON.stringify({ channel: thread, root: rootId, parent }));
} finally {
  for (const client of clients) client.quit();
}
process.exit(0);
