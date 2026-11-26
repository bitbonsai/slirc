// Local fixtures for the isolated slirc2 profile. The guarded client seed invokes this
// after normal local channel bootstrap; it can also be run manually with the opt-in:
//   podman exec -e SLIRC_BOOT_SEED=true slirc2-app bun scripts/boot-seed.ts
// Never run from default or production app startup.
//
// Creates/reuses eve/ben/ada (@example.test), keeps #dev-test private for those fixtures
// and the owner, and creates public #dev-open. Fixture status is labelled once in each room
// topic; the messages read like ordinary chat, and Pexels and the one Giphy GIF are verified
// real provider assets. Two fixture DMs use existing accounts.
// Two-phase stamps skip confirmed sends and warn on uncertain ones. No bots or autonomous
// chatter. This is not exactly-once: inspect the room before clearing an uncertain stamp.

// The guard below runs before anything that opens the database or dials IRC/Ergo.
import type { Account } from "../src/accounts.ts";
import type { ParsedMessage } from "../src/irc.ts";
import {
  BOOT_CHANNEL,
  BOOT_CHANNEL_TOPIC,
  BOOT_OPEN_CHANNEL,
  BOOT_OPEN_CHANNEL_MODES,
  BOOT_OPEN_CHANNEL_TOPIC,
  BOOT_SEED_VERSION,
  bootChannelMessages,
  bootOpenMessages,
  bootDirectMessages,
  bootPeople,
  bootSeedGuard,
  messageStamp,
  resumeAction,
  trackMembership,
  type StampState,
} from "./boot-fixtures.ts";

const guard = bootSeedGuard(process.env);
if (!guard.ok) {
  console.error(guard.reason);
  process.exit(1);
}

const { accountByNick, markVerified, provisionAccount } = await import("../src/accounts.ts");
const { db } = await import("../src/db.ts");
const { openDirectConversation } = await import("../src/direct.ts");
const { createChannel, makeChannelSecret, setChannelMode, setChannelTopic } = await import("../src/grants.ts");
const { IrcClient } = await import("../src/irc.ts");

const OWNER = (process.env.OWNER_NICK || process.env.ADMIN_NICK || "admin").toLowerCase();
const HOST = process.env.ERGO_HOST || "127.0.0.1";
const PORT = Number(process.env.ERGO_PORT || 6667);
const CAPABILITIES = ["message-tags", "echo-message"];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = (ms: number, message: string) => wait(ms).then(() => { throw new Error(message); });

const readStamp = (key: string): StampState | null => {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<StampState>;
    if (parsed.status === "sending" || parsed.status === "confirmed") return parsed as StampState;
  } catch {}
  return null;
};
const writeMeta = (key: string, value: string) =>
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const writeStamp = (key: string, status: StampState["status"]) => writeMeta(key, JSON.stringify({ status, at: Date.now() }));
// Visible, actionable skip: an operator must look at the room before replaying anything.
const warnUncertain = (key: string, state: StampState) =>
  console.warn(`boot-seed: ${key} is ${state.status} (${new Date(state.at).toISOString()}); not replaying. ` +
    `Check the room, then delete the row to resend: DELETE FROM meta WHERE key = '${key}';`);

// Decide before opening any connection: confirmed lines are done, uncertain ones only warn.
// Never replays, so an uncertain line needs an explicit operator decision.
function alreadyHandled(key: string): boolean {
  const state = readStamp(key);
  const action = resumeAction(state);
  if (action === "send") return false;
  if (action === "warn") warnUncertain(key, state!);
  return true;
}

const clients = new Map<string, IrcClient>();
const joined = new WeakMap<IrcClient, Set<string>>();

async function session(account: Account, realName: string): Promise<IrcClient> {
  const existing = clients.get(account.nick);
  if (existing) return existing;
  // The membership set is wired in before connect(): Ergo's always-on setting reattaches
  // already-joined rooms during registration, and those JOIN echoes land before any
  // post-connect waiter exists. onMessage captures them so ensureJoin sees the channel.
  const channels = new Set<string>();
  const client = new IrcClient({
    host: HOST,
    port: PORT,
    nick: account.nick,
    realname: realName,
    saslUser: account.nick,
    saslPass: account.ircPassword,
    capabilities: CAPABILITIES,
    onMessage: (message) => trackMembership(channels, account.nick, message),
  });
  joined.set(client, channels);
  await Promise.race([client.connect(), timeout(10_000, `connect timed out for ${account.nick}`)]);
  clients.set(account.nick, client);
  return client;
}

async function ensureJoin(client: IrcClient, channel: string): Promise<void> {
  const set = joined.get(client) ?? new Set<string>();
  joined.set(client, set);
  if (set.has(channel)) return;
  const nick = client.nick.toLowerCase();
  // Register the waiter before sending, or a fast JOIN echo can arrive first and be missed.
  const waiter = client.waitFor((message) =>
    message.command === "JOIN" &&
    (message.prefix || "").split("!")[0].toLowerCase() === nick &&
    message.params[0] === channel);
  client.send(`JOIN ${channel}`);
  await Promise.race([waiter, timeout(8_000, `${client.nick} could not join ${channel}`)]);
  set.add(channel);
}

// Echo is matched by our own nick and captured inside the predicate, then confirmed after
// waitFor settles.
async function say(client: IrcClient, channel: string, text: string): Promise<void> {
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
}

// Mark `sending` just before the wire write, confirm after the echo. A crash in between
// leaves the uncertain state that alreadyHandled() warns about on the next run.
async function transmit(client: IrcClient, channel: string, key: string, text: string): Promise<void> {
  writeStamp(key, "sending");
  await say(client, channel, text);
  writeStamp(key, "confirmed");
}

try {
  // ── accounts ───────────────────────────────────────────────────────────────
  const owner: Account | null = accountByNick(OWNER);
  if (!owner?.ircPassword) throw new Error(`owner account ${OWNER} has no IRC credentials; run migrate-founder first`);

  const fixtures = new Map<string, { account: Account; realName: string }>();
  for (const person of bootPeople) {
    const existing = accountByNick(person.nick);
    const account = existing ?? await provisionAccount(person.nick, person.email);
    if (account.email !== person.email) throw new Error(`${account.nick} is already bound to a different email`);
    markVerified(account.nick);
    fixtures.set(person.nick, { account, realName: person.realName });
  }
  const fixtureAccounts = [...fixtures.values()].map((entry) => entry.account);

  // ── #dev-test: secret, shared with the owner ───────────────────────────────
  const members = [...new Set([owner.nick, ...fixtureAccounts.map((a) => a.nick)])];
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, 'secret', ?) ON CONFLICT(channel) DO UPDATE SET visibility = 'secret'")
    .run(BOOT_CHANNEL, owner.nick, Date.now());
  for (const nick of members) {
    db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(BOOT_CHANNEL, nick);
  }
  const channelStamp = `boot-seed:${BOOT_SEED_VERSION}:channel:${BOOT_CHANNEL}`;
  const channelConfig = JSON.stringify({ channel: BOOT_CHANNEL, owner: owner.nick, members, topic: BOOT_CHANNEL_TOPIC, v: BOOT_SEED_VERSION });
  if (db.query("SELECT value FROM meta WHERE key = ?").get(channelStamp)?.value === channelConfig) {
    console.log(`${BOOT_CHANNEL} already provisioned`);
  } else {
    await createChannel(BOOT_CHANNEL, owner.nick, "secret", { adopt: true });
    await makeChannelSecret(BOOT_CHANNEL, members);
    await setChannelTopic(BOOT_CHANNEL, BOOT_CHANNEL_TOPIC);
    writeMeta(channelStamp, channelConfig);
    console.log(`provisioned ${BOOT_CHANNEL}: ${members.join(", ")}`);
  }

  // ── public test room ───────────────────────────────────────────────────────
  // OPEN_CHANNELS in the isolated profile grants PWA access; this provisions its IRC half.
  const openStamp = `boot-seed:${BOOT_SEED_VERSION}:channel:${BOOT_OPEN_CHANNEL}`;
  const openTopic = BOOT_OPEN_CHANNEL_TOPIC;
  const openConfig = JSON.stringify({ channel: BOOT_OPEN_CHANNEL, owner: owner.nick, modes: BOOT_OPEN_CHANNEL_MODES, topic: openTopic, v: BOOT_SEED_VERSION });
  if (db.query("SELECT value FROM meta WHERE key = ?").get(openStamp)?.value !== openConfig) {
    await createChannel(BOOT_OPEN_CHANNEL, owner.nick, "workspace", { adopt: true });
    await setChannelMode(BOOT_OPEN_CHANNEL, BOOT_OPEN_CHANNEL_MODES);
    await setChannelTopic(BOOT_OPEN_CHANNEL, openTopic);
    writeMeta(openStamp, openConfig);
    console.log(`provisioned public ${BOOT_OPEN_CHANNEL}`);
  }

  // ── channel messages ───────────────────────────────────────────────────────
  for (const { channel, messages } of [
    { channel: BOOT_CHANNEL, messages: bootChannelMessages },
    { channel: BOOT_OPEN_CHANNEL, messages: bootOpenMessages },
  ]) {
    for (const [index, message] of messages.entries()) {
      const key = messageStamp("channel", channel, message.author, index);
      if (alreadyHandled(key)) continue;
      const person = fixtures.get(message.author);
      if (!person) throw new Error(`unknown fixture author ${message.author}`);
      const client = await session(person.account, person.realName);
      await ensureJoin(client, channel);
      await transmit(client, channel, key, message.text.replaceAll("@OWNER", `@${owner.nick}`));
    }
  }

  // ── direct messages ────────────────────────────────────────────────────────
  // The existing server helper creates both the SQLite peer row and the registered,
  // locked Ergo channel, with access granted to exactly these two fixture accounts.
  for (const dm of bootDirectMessages) {
    const first = dm.a === "owner" ? { account: owner, realName: owner.nick } : fixtures.get(dm.a);
    const second = dm.b === "owner" ? { account: owner, realName: owner.nick } : fixtures.get(dm.b);
    if (!first || !second) throw new Error(`unknown DM fixture ${dm.id}`);
    const pending = dm.lines.map((line, index) => {
      const person = line.from === "a" ? first : second;
      return { line, person, key: messageStamp("dm", dm.id, person.account.nick, index) };
    }).filter(({ key }) => !alreadyHandled(key));
    if (!pending.length) continue;
    const channel = (await openDirectConversation(first.account.nick, second.account.nick)).channel;
    for (const { line, person, key } of pending) {
      const client = await session(person.account, person.realName);
      await ensureJoin(client, channel);
      await transmit(client, channel, key, line.text);
    }
  }
} finally {
  // Quit every fixture session even when a step throws; the persistent oper session from
  // grants.ts is torn down by process exit.
  for (const client of clients.values()) client.quit();
}
console.log("boot fixtures ready");
process.exit(0);
