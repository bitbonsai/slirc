import { type Account, accountByNick } from "../accounts.ts";
import { channelInfo, isOpenChannel, isMember, discoverableHuman, asciiFold } from "../rooms.ts";
import { agentSessionCapabilities } from "./agent-support.ts";
import { db } from "../db.ts";

// Who may add whom to a channel. The POST below enforces it and the lookup reports it, so the
// inline Add prompt never offers a click the server would refuse. A person must be discoverable to
// whoever adds them, the same gate as people search.
export function memberAddDenial(nick: string, channel: string, target: Account | null): { error: string; status: 403 | 404 } | null {
  if (accountByNick(nick)?.kind === "agent") return { error: "agents cannot manage channels", status: 403 };
  if ((!channelInfo(channel) && !isOpenChannel(channel)) || /^#(t-|dm-)/.test(channel)) return { error: "channel not found", status: 404 };
  if (!isMember(nick, channel) && !isOpenChannel(channel)) return { error: "channel membership required", status: 403 };
  if (!target || (target.kind === "human" && target.nick.toLowerCase() !== nick.toLowerCase() && !discoverableHuman(nick, target.id))) return { error: "person not found", status: 404 };
  if (target.kind === "agent") {
    if (!agentSessionCapabilities.enabled) return { error: agentSessionCapabilities.reason, status: 403 };
    // Open and workspace channels accept an agent only as an owner-only attachment; the attach
    // route writes that flag and the transport wakes the agent for its owner alone.
    if (!isOpenChannel(channel) && !["secret", "workspace"].includes(channelInfo(channel)?.visibility || "")) return { error: "agents can only join channels", status: 403 };
    if (target.owner?.toLowerCase() !== nick.toLowerCase()) return { error: "only the owner can invite this agent", status: 403 };
  }
  return null;
}

// Bots and helpers join only rooms with a membership row, even open ones; every human is already in
// an open channel.
export function belongsTo(target: Account, channel: string): boolean {
  if (target.kind === "human") return isMember(target.nick, channel);
  return !!db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ?").get(channel, target.nick);
}

export function canReadChannelForModeration(nick: string, channel: string): boolean {
  const info = channelInfo(channel);
  // Configured open channels (#open-chat, #help) have no channels row; everyone can read them.
  if (!info) return isOpenChannel(channel);
  if (info.visibility === "direct") {
    const pair = db.query("SELECT first_nick, second_nick FROM direct_conversations WHERE channel = ?").get(info.channel) as { first_nick: string; second_nick: string } | null;
    if (!pair) return false;
    const folded = asciiFold(nick);
    return pair.first_nick === folded || pair.second_nick === folded;
  }
  const thread = db.query("SELECT parent FROM threads WHERE channel = ?").get(info.channel) as { parent: string } | null;
  if (thread) return canSeeThreadChannel(nick, channel) && canReadChannelForModeration(nick, thread.parent);
  return isOpenChannel(channel) || isMember(nick, channel);
}

// Old #t- threads: the `threads` table stays until a later migration drops it.
// Child half of the thread read boundary used by rooms.ts: a workspace child is readable by parent
// members, anything else (secret, direct, or a legacy child with no channels row) needs an explicit
// child grant. Kept local so POST /api/threads cannot leak an existing private row on re-registration.
function canSeeThreadChannel(nick: string, channel: string) {
  const info = channelInfo(channel);
  if (info && info.visibility === "workspace") return true;
  return isMember(nick, channel);
}
