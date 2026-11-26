// Dev fixture: three fake people, one demo channel, direct messages, and optional threads, with the
// things the client has to render — embed cards, inline images, markdown, a mention.
//
// Run it inside the app container:  just dev-seed   (or with --force to post again)
//
// Images are hotlinked from Pexels, so nothing binary lives in this repo.
import { randomBytes } from "node:crypto";
import { accountByEmail, accountByNick, markVerified, provisionAccount } from "../src/accounts.ts";
import { db } from "../src/db.ts";
import { createChannel, createDirectChannel } from "../src/grants.ts";
import { IrcClient } from "../src/irc.ts";
import { createDirectConversation, directChannelName } from "../src/rooms.ts";

const CHANNEL = "#demo-dev";
const HOST = process.env.ERGO_HOST || "127.0.0.1";
const PORT = Number(process.env.ERGO_PORT || 6667);
const OWNER = (process.env.OWNER_NICK || process.env.ADMIN_NICK || "admin").toLowerCase();
const force = process.argv.includes("--force");
const threadsOnly = process.argv.includes("--threads");
const botsOnly = process.argv.includes("--bots");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = "dev-demo:v1";
const THREAD_KEY = "dev-threads:v2";
const BOT_KEY = "dev-bots:v1";
if (!force && !threadsOnly && !botsOnly && db.query("SELECT 1 FROM meta WHERE key = ?").get(KEY)) {
  console.log(`${KEY} already seeded; pass --force to post again`);
  process.exit(0);
}
if (!force && threadsOnly && db.query("SELECT 1 FROM meta WHERE key = ?").get(THREAD_KEY)) {
  console.log(`${THREAD_KEY} already seeded; pass --force to create again`);
  process.exit(0);
}
if (!force && botsOnly && db.query("SELECT 1 FROM meta WHERE key = ?").get(BOT_KEY)) {
  console.log(`${BOT_KEY} already seeded; pass --force to create again`);
  process.exit(0);
}

const pexels = (id: number) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=1200`;

type Person = { nick: string; realName: string };
const ana: Person = { nick: "ana", realName: "Ana Reyes" };
const tomas: Person = { nick: "tomas", realName: "Tomás Iglesias" };
const juno: Person = { nick: "juno", realName: "Juno Park" };
const people = [ana, tomas, juno];

// The intended nick may be taken; provisionAccount then numbers the account, and the
// IRC nick must be the account's own or Ergo never finishes registration.
function open(person: Person, onMessage?: (message: { command: string; params: string[]; tags: Record<string, string> }) => void) {
  const email = `${person.nick}@dev.slirc.invalid`;
  let account = accountByNick(person.nick) || accountByEmail(email);
  const client = (nick: string, password: string) =>
    new IrcClient({ host: HOST, port: PORT, nick, realname: person.realName, saslUser: nick, saslPass: password, capabilities: ["message-tags", "echo-message"], onMessage });
  if (account?.ircPassword) return { account, client: client(account.nick, account.ircPassword) };
  if (account) throw new Error(`${account.nick} has no IRC password`);
  return provisionAccount(person.nick, email).then((created) => {
    markVerified(created.nick);
    if (!created.ircPassword) throw new Error(`${created.nick} has no IRC password`);
    return { account: created, client: client(created.nick, created.ircPassword) };
  });
}

// Post lines as one person; returns the msgid of each line. Verifies the JOIN, because a
// refused JOIN would otherwise be reported as a posted line.
async function say(person: Person, channel: string, lines: string[]): Promise<string[]> {
  const ids: string[] = [];
  const pending: string[] = [];
  let joined = false;
  let nick = "";
  const session = await open(person, (message) => {
    if (message.command === "JOIN" && (message.prefix || "").startsWith(nick)) joined = true;
    if (message.command === "PRIVMSG" && message.params[0] === channel && message.tags.msgid) pending.push(message.tags.msgid);
  });
  nick = session.account.nick;
  const { client } = session;
  try {
    await Promise.race([client.connect(), wait(8_000).then(() => { throw new Error("connect timed out"); })]);
    client.send(`JOIN ${channel}`);
    for (let i = 0; i < 15 && !joined; i++) await wait(100);
    if (!joined) return console.warn(`${nick}: cannot join ${channel}`), [];
    for (const line of lines) {
      pending.length = 0;
      client.send(`PRIVMSG ${channel} :${line.replace(/@OWNER/g, `@${OWNER}`)}`);
      for (let i = 0; i < 15 && !pending.length; i++) await wait(100);
      if (pending[0]) ids.push(pending[0]);
      await wait(250);
    }
    console.log(`${nick} → ${channel}: ${ids.length}/${lines.length}`);
  } catch (error) {
    console.warn(`${nick} → ${channel} failed:`, error instanceof Error ? error.message : error);
  } finally {
    try { client.quit(); } catch {}
    await wait(200);
  }
  return ids;
}

async function retry(what: string, work: () => Promise<void>) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await work(); } catch (error) {
      console.warn(`${what}: attempt ${attempt} (${error instanceof Error ? error.message : error})`);
      await wait(2_000);
    }
  }
}

const nickOf = (person: Person) => (accountByNick(person.nick) || accountByEmail(`${person.nick}@dev.slirc.invalid`))?.nick || person.nick;
const realNicks = () => people.map(nickOf);

console.log(`seeding ${CHANNEL} with ${people.length} people`);

// ── channel ──────────────────────────────────────────────────────────────────
const created = await retry(`create ${CHANNEL}`, async () => {
  if (!db.query("SELECT 1 FROM channels WHERE channel = ?").get(CHANNEL)) {
    await createChannel(CHANNEL, OWNER, "workspace");
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, 'workspace', ?)").run(CHANNEL, OWNER, Date.now());
  }
  for (const nick of [OWNER, ...realNicks()]) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(CHANNEL, nick);
});
if (created === undefined && !db.query("SELECT 1 FROM channels WHERE channel = ?").get(CHANNEL)) process.exit(1);

if (!threadsOnly && !botsOnly) {
// ── conversation: an unfurl, a video card, photos, markdown, a mention ────────
await say(ana, CHANNEL, [
  "moved the release notes into the repo — https://github.com/bitbonsai/slirc",
  `and here is the offsite set from last week ${pexels(3184291)}`,
  "the one with the whiteboard is the keeper",
]);
await say(tomas, CHANNEL, [
  "```sh\njust deploy\n# 12:35 app    rebuilt\n# 12:35 ergo   untouched\n```",
  "**shorter** deploy, *less* to break. notes in `docs/`",
  "the walkthrough video is still the best intro https://www.youtube.com/watch?v=aqz-KE-bpKQ",
]);
await say(juno, CHANNEL, [
  `@OWNER did we ever pin the reader photo? ${pexels(1181671)}`,
  "asking because the blog draft links to it",
]);

// ── a direct message, so the DM view has content ──────────────────────────────
const dm = directChannelName(OWNER, ana.nick);
await retry(`create ${dm}`, async () => {
  if (db.query("SELECT 1 FROM direct_conversations WHERE channel = ?").get(dm)) return;
  await createDirectChannel(dm, OWNER, [OWNER, ana.nick]);
  createDirectConversation(OWNER, ana.nick, OWNER);
});
if (db.query("SELECT 1 FROM direct_conversations WHERE channel = ?").get(dm)) {
  await say(ana, dm, [
    `sent you the photo set for the post ${pexels(3184338)}`,
    "tell me if the crop is too tight",
  ]);
}
}

if (threadsOnly) {
  const makeThread = async (author: Person, rootText: string, replies: [Person, string[]][]) => {
    rootText = rootText.replaceAll("@OWNER", `@${OWNER}`);
    const [root] = await say(author, CHANNEL, [rootText]);
    if (!root) return;
    const channel = `#t-${randomBytes(3).toString("hex")}`;
    const now = Date.now();
    // These mirror the PWA's saved root context. Replies create the IRC child channel for fixture browsing.
    db.query("INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)")
      .run(channel, CHANNEL, root, rootText.replace(/\s+/g, " ").slice(0, 60), nickOf(author), rootText, new Date(now).toISOString(), nickOf(author), now, now);
    for (const [person, lines] of replies) await say(person, channel, lines);
    console.log(`thread ${channel}: ${rootText}`);
  };
  await makeThread(tomas, "Embed context https://www.youtube.com/watch?v=aqz-KE-bpKQ", [[ana, ["The player stays with the root."]]]);
  await makeThread(ana, `Image context ${pexels(590016)}`, [[juno, ["Crop looks good on a phone."]]]);
  await makeThread(juno, "Plain text context stays compact.", [[tomas, ["Easy to scan."]]]);
  await makeThread(ana, "> tomas: **Quoted** context keeps its Markdown.", [[juno, ["Quote treatment reads clearly."]]]);
  await makeThread(tomas, "@OWNER can you review this mention context?", [[ana, ["Mention still opens the profile."]]]);
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(THREAD_KEY, String(Date.now()));
}

if (botsOnly) {
  db.query("INSERT INTO channel_members (channel, nick) VALUES (?, 'remind') ON CONFLICT DO NOTHING").run(CHANNEL);
  // Helpers connect asynchronously after app startup; give remind time to join its room.
  await wait(5_000);
  await say(ana, "#help", ["How do threads work in Slirc?"]);
  await say(ana, CHANNEL, [
    "@remind in 2 hours review the Pexels image crop",
    "@remind tomorrow 9:00 check the release post",
  ]);
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(BOT_KEY, String(Date.now()));
}

if (!threadsOnly && !botsOnly) db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, String(Date.now()));
console.log("done");
process.exit(0);
