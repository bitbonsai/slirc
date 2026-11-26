// Read-only audit for C1 (security-audit-2026-11-18). Lists private channels (DMs, threads, groups,
// secret rooms) where someone besides the members and the app is inside or holds an invite exception,
// or where +s/+i is missing, plus #dm-/#t-/#g- channels on Ergo the app has no record of.
// Opens SQLite read-only. Sends Ergo only MODE, WHO, the list form of SAMODE +I, and LIST.
// Prints channel names, nicks and accounts; never emails. Exit 1 when it finds anything.
//   podman exec slirc-org bun scripts/scan-private-occupants.ts
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { ergoOperUser } from "../src/config.ts";
import { operClient } from "../src/grants.ts";
import type { IrcClient } from "../src/irc.ts";

const db = new Database(process.env.DB_PATH || "/data/chat.sqlite", { readonly: true });
const members = new Map<string, Set<string>>();
const add = (channel: string, nick: string) => {
  const key = channel.toLowerCase();
  if (!members.has(key)) members.set(key, new Set());
  members.get(key)!.add(nick.toLowerCase());
};
const rows = db.query(`SELECT c.channel AS channel, m.nick AS nick FROM channels c LEFT JOIN channel_members m ON m.channel = c.channel
  WHERE c.visibility != 'workspace' AND c.archived_at IS NULL`).all() as { channel: string; nick: string | null }[];
for (const row of rows) { members.has(row.channel.toLowerCase()) || members.set(row.channel.toLowerCase(), new Set()); if (row.nick) add(row.channel, row.nick); }
for (const row of db.query("SELECT channel, first_nick, second_nick FROM direct_conversations").all() as { channel: string; first_nick: string; second_nick: string }[]) {
  add(row.channel, row.first_nick); add(row.channel, row.second_nick);
}
const known = new Set((db.query("SELECT channel FROM channels UNION SELECT channel FROM direct_conversations UNION SELECT channel FROM threads").all() as { channel: string }[])
  .map((row) => row.channel.toLowerCase()));
db.close();

const app = new Set([ergoOperUser().toLowerCase(), "slirc"]);
type Probe = { exists: boolean; modes: string; masks: string[]; occupants: { nick: string; account: string }[] };

// One round trip per channel, closed by a PING so every reply before it has arrived.
async function probe(client: IrcClient, channel: string): Promise<Probe | null> {
  const self = client.nick.toLowerCase();
  const target = channel.toLowerCase();
  const token = `scan-${randomBytes(4).toString("hex")}`;
  const result: Probe = { exists: true, modes: "", masks: [], occupants: [] };
  const done = client.waitFor((m) => {
    if (m.command === "PONG" && m.params.at(-1) === token) return true;
    if ((m.params[0] || "").toLowerCase() !== self) return false;
    if (m.command === "354" && m.params[1] === "152") result.occupants.push({ nick: m.params[2] || "", account: (m.params[3] || "0").toLowerCase() });
    if ((m.params[1] || "").toLowerCase() !== target) return false;
    if (m.command === "324") result.modes = m.params[2] || "";
    else if (m.command === "403") result.exists = false;
    else if (m.command === "346") result.masks.push((m.params[2] || "").toLowerCase());
    return false;
  });
  client.send(`MODE ${channel}`);
  client.send(`SAMODE ${channel} +I`);
  client.send(`WHO ${channel} %tna,152`);
  client.send(`PING ${token}`);
  return await Promise.race([done.then(() => result), Bun.sleep(5_000).then(() => null)]);
}

const client = await operClient();
let findings = 0;
const report = (channel: string, problem: string) => { findings++; console.log(`${channel}\t${problem}`); };
try {
  for (const [channel, people] of members) {
    const result = await probe(client, channel);
    if (!result) { report(channel, "no reply from Ergo"); continue; }
    if (!result.exists) continue;
    if (!(result.modes.includes("s") && result.modes.includes("i"))) report(channel, `not private: modes ${result.modes || "(none)"}`);
    for (const { nick, account } of result.occupants) {
      if (!app.has(account) && !people.has(account)) report(channel, `stranger inside: ${nick} (account ${account === "0" ? "none" : account})`);
    }
    const allowed = new Set([...people, "slirc"].map((nick) => `${nick}!*@*`));
    for (const mask of result.masks) if (!allowed.has(mask)) report(channel, `extra invite exception: ${mask}`);
  }

  // Channels with the app's private prefixes that the app never recorded (a squat, or a half-provisioned leftover).
  const listed: { channel: string; users: string }[] = [];
  const end = client.waitFor((m) => {
    if (m.command === "322" && /^#(dm|t|g)-/i.test(m.params[1] || "")) listed.push({ channel: m.params[1], users: m.params[2] || "?" });
    return m.command === "323";
  });
  client.send("LIST");
  await Promise.race([end, Bun.sleep(10_000)]);
  for (const { channel, users } of listed) if (!known.has(channel.toLowerCase())) report(channel, `on Ergo but unknown to the app (${users} users)`);
} finally {
  client.quit();
}
console.log(findings ? `${findings} finding(s)` : "no unexpected occupants, invite exceptions or unknown private channels");
process.exitCode = findings ? 1 : 0;
