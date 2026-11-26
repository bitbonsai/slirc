// Non-destructive local protocol check. Use disposable fixtures whose app membership was removed:
// podman exec slirc2-app bun scripts/check-private-irc-access.ts '#secret-channel' outsider formermember
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { IrcClient, type ParsedMessage } from "../src/irc.ts";
import { accountIrcPassword } from "../src/irc-key.ts";

assert.equal(process.env.SLIRC_DEV_PROFILE, "slirc2", "This check is local-only");
const [channel, ...nicks] = process.argv.slice(2);
assert(channel && /^#[a-z0-9][a-z0-9_-]*$/.test(channel) && nicks.length, "Supply a channel and fixture nicks");
assert(process.env.DB_PATH, "DB_PATH is required");
const db = new Database(process.env.DB_PATH, { readonly: true });
assert.equal(db.query<{ visibility: string }, [string]>("SELECT visibility FROM channels WHERE channel = ?").get(channel)?.visibility, "secret");

async function bounded(work: Promise<void>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([work, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("IRC response timed out")), 10_000);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

try {
  for (const nick of nicks) {
    assert(!db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ? COLLATE NOCASE").get(channel, nick), "Fixture must not be an app member");
    const account = db.query<{ nick: string; account_id: string; irc_password_gen: number | null }, [string]>("SELECT nick, account_id, irc_password_gen FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'human' AND verified_at IS NOT NULL").get(nick);
    assert(account, "Fixture must be a verified human");
    const seen: ParsedMessage[] = [];
    const client = new IrcClient({
      host: process.env.ERGO_HOST!, port: Number(process.env.ERGO_PORT || 6667),
      nick: account.nick, saslUser: account.nick, saslPass: accountIrcPassword(account),
      capabilities: ["draft/chathistory", "message-tags"],
      onMessage: (message) => seen.push(message),
    });
    try {
      await bounded(client.connect());
      const joinDenied = client.waitFor((m) => ["473", "474", "475", "477"].includes(m.command) && m.params[1] === channel);
      client.send(`JOIN ${channel}`);
      await bounded(joinDenied);
      const historyDenied = client.waitFor((m) => m.command === "FAIL" && m.params[0] === "CHATHISTORY" && m.params.includes(channel));
      client.send(`CHATHISTORY LATEST ${channel} * 10`);
      await bounded(historyDenied);
      assert(!seen.some((m) => m.command === "PRIVMSG" && m.params[0] === channel), "Private message content reached a nonmember");
      assert(!seen.some((m) => m.command === "JOIN" && m.params[0] === channel && m.prefix?.split("!")[0].toLowerCase() === nick.toLowerCase()), "Nonmember joined the private channel");
      console.log(`${nick}: JOIN and CHATHISTORY denied; no private messages received`);
    } finally {
      client.quit();
    }
  }
} finally {
  db.close();
}
