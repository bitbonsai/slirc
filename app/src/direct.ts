import { createDirectConversation, directChannelName, directPair } from "./rooms.ts";
import { createDirectChannel } from "./grants.ts";
import { db } from "./db.ts";

const opening = new Map<string, Promise<void>>();

// Shared by the web API and local fixtures. A stored mapping alone is not an Ergo DM.
export async function openDirectConversation(nick: string, other: string) {
  const key = JSON.stringify(directPair(nick, other));
  const direct = createDirectConversation(nick, other, nick, false);
  let task = opening.get(key);
  if (!task) {
    task = (async () => {
      await createDirectChannel(direct.channel, nick, [nick, other]);
      // Recheck pair contamination after the await. Never recreate a deleted reservation or
      // publish a different channel if another lifecycle operation changed it meanwhile.
      if (directChannelName(nick, other) !== direct.channel) throw new Error("DM reservation changed");
      const [first, second] = directPair(nick, other);
      const result = db.query(`UPDATE direct_conversations SET provision_ready = 1
        WHERE channel = ? AND first_nick = ? AND second_nick = ?
          AND EXISTS (SELECT 1 FROM channels c WHERE c.channel = direct_conversations.channel AND c.visibility = 'direct' AND c.archived_at IS NULL)
          AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel = direct_conversations.channel AND m.nick IN (first_nick, second_nick)) = 2`)
        .run(direct.channel, first, second);
      if (!result.changes) throw new Error("DM reservation or membership changed");
    })().finally(() => opening.delete(key));
    opening.set(key, task);
  }
  await task;
  return direct;
}
