// One-shot room bootstrap: registers channels, applies modes and access,
// and seeds channel_members rows. Idempotent after adding a member or channel.
//
// Env: SEED_CHANNELS_JSON (optional) in the
// shape {"#chan": {"private": true, "members": ["nick"]}}.
//
// Run inside the app container: bun src/seed.ts

import { db } from "./db.ts";
import { clearChannelAccess, createChannel, makeChannelSecret, setChannelMode, setChannelTopic } from "./grants.ts";
import { openRoom } from "./welcome.ts";

const founder = (process.env.CHAN_FOUNDER_NICK || process.env.OWNER_NICK || process.env.ADMIN_NICK || "").trim();

const SEED = JSON.parse(process.env.SEED_CHANNELS_JSON || JSON.stringify({
  "#open-chat": { private: false, members: [] },
  "#help": { private: false, members: [] },
})) as Record<string, { private: boolean; members: string[] }>;

if (Object.keys(SEED).length > 0 && !founder) throw new Error("OWNER_NICK required");

const resetLegacyAccess = !db.query("SELECT 1 FROM meta WHERE key = 'wolff-channel-migration'").get();

for (const [channel, conf] of Object.entries(SEED)) {
  if (conf.private) db.query(`INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, 'secret', ?)
                              ON CONFLICT(channel) DO NOTHING`).run(channel, founder, Date.now());
  // The founder owns every private seeded room and gets Ergo access below, so the app must list
  // them as a member too. Without the row a private workspace with no open rooms has an owner
  // who is in no conversation and cannot enter.
  for (const member of conf.private ? [...conf.members, founder] : conf.members) {
    db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(channel, member.toLowerCase());
  }

  // Register and configure the channel once per config shape. Re-running every boot spammed IRC clients
  // with join/mode/topic events from a fresh oper-nick-* client on each deploy.
  const stamp = JSON.stringify({ conf, founder, v: 1 });
  const seeded = db.query("SELECT value FROM meta WHERE key = ?").get(`seeded:${channel}`) as { value: string } | null;
  if (seeded?.value === stamp && !resetLegacyAccess) {
    console.log(`${channel} already seeded`);
    continue;
  }
  // adopt: the configured rooms are re-seeded in place whenever their config changes.
  await createChannel(channel, founder, conf.private ? "secret" : "workspace", { adopt: true });
  if (conf.private) {
    if (resetLegacyAccess) await clearChannelAccess(channel);
    const members = [...new Set([...conf.members, founder].map((nick) => nick.toLowerCase()))];
    await makeChannelSecret(channel, members);
    console.log(`registered ${channel}; private (${[...members, "slirc"].join(", ")})`);
  } else {
    // Public rooms: moderated, guests may read; -R because createChannel registers workspace rooms as +R.
    await setChannelMode(channel, "+Mu-R");
    const topic = channel.toLowerCase() === openRoom()
      ? "Public chat — everyone can read, posting needs an account. Type your email below to join."
      : "Support — ask and answer questions. Posting needs an account, type your email below to join.";
    await setChannelTopic(channel, topic);
    console.log(`registered ${channel}; public read-only for guests`);
  }
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`seeded:${channel}`, stamp);
}

db.query("INSERT INTO meta (key, value) VALUES ('wolff-channel-migration', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now()));

// One-shot: channels created before the service nick was renamed still invite `pushbot`,
// so the relay cannot join them. Add the new nick and drop the old exception once.
if (!db.query("SELECT 1 FROM meta WHERE key = 'service-nick'").get()) {
  const known = new Set([
    ...(db.query("SELECT channel FROM channels").all() as { channel: string }[]).map((row) => row.channel),
    ...Object.keys(SEED),
  ]);
  for (const channel of known) {
    await setChannelMode(channel, "+I slirc");
    await setChannelMode(channel, "-I pushbot");
  }
  db.query("INSERT INTO meta (key, value) VALUES ('service-nick', 'slirc')").run();
  console.log(`service nick migration: ${known.size} channel(s) now invite slirc`);
}
