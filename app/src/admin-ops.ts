// Instance admins are channel operators on the IRC side too, so Ergo itself lets them moderate:
// delete anyone's message, kick, set modes. The grant is a persistent ChanServ AMODE +o per
// channel, set when a channel or thread is created and backfilled at boot for older ones.
//
// DMs, private groups and their threads are left alone: an admin has no backdoor into private
// conversations, and being an operator there would be one.

import { db } from "./db.ts";
import { grantChannelOps } from "./grants.ts";
import { openChannels } from "./rooms.ts";

export function adminNicks(): string[] {
  return (db.query("SELECT nick FROM accounts WHERE kind = 'human' AND role = 'admin' AND verified_at IS NOT NULL ORDER BY nick").all() as { nick: string }[])
    .map((row) => row.nick);
}

// Registered channels and threads an admin moderates. A thread qualifies through its parent; a
// #t- channel with no threads row (an old DM thread) never does.
export function adminOpChannels(): string[] {
  const rows = db.query(`SELECT c.channel FROM channels c
      LEFT JOIN threads t ON t.channel = c.channel
      LEFT JOIN channels p ON p.channel = t.parent
      WHERE c.visibility <> 'direct' AND c.is_group = 0
        AND (CASE WHEN t.channel IS NOT NULL THEN p.channel IS NULL OR (p.visibility <> 'direct' AND p.is_group = 0)
                  ELSE c.channel NOT LIKE '#t-%' END)
      ORDER BY c.channel`).all() as { channel: string }[];
  return [...new Set([...openChannels, ...rows.map((row) => row.channel)])];
}

// Ops every admin on one channel if it qualifies. Never throws: creation must not fail because the
// grant did, and the next boot's backfill repairs a miss.
export async function opAdmins(channel: string): Promise<void> {
  if (!adminOpChannels().includes(channel.toLowerCase())) return;
  await grantChannelOps(channel, adminNicks()).catch((error) => {
    console.error(`admin ops for ${channel}:`, error instanceof Error ? error.message : error);
  });
}

// Boot backfill. AMODE is idempotent, so running it on every boot only re-confirms existing grants.
// Failures are counted, not logged one by one: an Ergo that is still starting fails every channel.
export async function backfillAdminOps(): Promise<{ channels: number; failed: number; firstError: string }> {
  const admins = adminNicks();
  const channels = admins.length ? adminOpChannels() : [];
  let failed = 0, firstError = "";
  for (const channel of channels) {
    try {
      await grantChannelOps(channel, admins);
    } catch (error) {
      failed++;
      firstError ||= `${channel}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { channels: channels.length, failed, firstError };
}
