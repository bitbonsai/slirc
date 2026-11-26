import { authenticateBinding, type Binding, validLease, agentAudience } from "../agent-session.ts";
import { db } from "../db.ts";
import { disconnectAgentTransport, evictAgentRoomForNick, joinAgentRoomForNick } from "../agent-session-transport.ts";
import { removeAgentAccount } from "../agent-accounts.ts";
import { accountIrcPassword } from "../irc-key.ts";
import { publish, channelsChanged } from "../live.ts";
import { channelInfo, threadChildren } from "../rooms.ts";
import { revokeChannelAccess, removeFromThreadChannels } from "../grants.ts";

// Session-bound pairing for the harnesses in the agent package's registry. Pi is proved end to end
// in test/agent-session-pi-proof.test.ts. The legacy connect protocol shares identities and exposes
// raw IRC credentials, so /api/agent/connect stays closed whatever this says.
// SLIRC_AGENTS_ENABLED=false turns pairing off for the instance: no requests are taken and the
// connect route refuses, so hiding the Agents page is not what enforces it.
const agentsEnabled = process.env.SLIRC_AGENTS_ENABLED !== "false";

export const agentSessionCapabilities = {
  enabled: agentsEnabled,
  reason: agentsEnabled ? "" : "Agents are off on this instance.",
};

export const AGENT_POLL_MAX_WAIT_S = 25;

export const AGENT_SSE_KEEPALIVE_MS = Number(process.env.AGENT_SSE_KEEPALIVE_MS) || 15_000;

export const bindingForRequest = (c: any) => authenticateBinding(c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1]);

export const leaseForRequest = (c: any, binding: Binding) => {
  const lease = c.req.header("X-Slirc-Agent-Lease") || "";
  return validLease(binding, lease) ? lease : null;
};

// Revoke first, so the session stops at once even if the IRC teardown below fails and is retried.
function revokeAgentBindings(where: string, value: string): void {
  const rows = db.query(`SELECT id FROM agent_session_bindings WHERE ${where} AND status <> 'revoked'`).all(value) as { id: string }[];
  for (const binding of rows) {
    db.query("UPDATE agent_session_bindings SET status='revoked',lease_id=NULL,lease_nonce=NULL,lease_expires_at=NULL WHERE id=?").run(binding.id);
    disconnectAgentTransport(binding.id);
  }
}

// Owner Remove, admin Remove and removing the owner all end here: binding revoked, transport
// closed, Ergo account and DM gone.
export async function removeAgent(nick: string): Promise<void> {
  const agent = db.query("SELECT nick, account_id, irc_password_gen, owner FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'agent'").get(nick) as
    { nick: string; account_id: string; irc_password_gen: number | null; owner: string | null } | null;
  if (!agent) return;
  // Taken before the account and its rooms go, so every open page that showed it drops it live.
  const audience = agentAudience(agent.nick, agent.owner ?? "");
  revokeAgentBindings("nick = ? COLLATE NOCASE", agent.nick);
  const channels = (db.query("SELECT channel FROM channel_members WHERE nick = ?").all(agent.nick) as { channel: string }[]).map((row) => row.channel);
  await removeAgentAccount(agent.nick, accountIrcPassword(agent), channels);
  for (const person of audience) publish(person, "agent-removed", { nick: agent.nick });
}

export async function removeAgentsOwnedBy(owner: string, ownerAccountId: string | undefined): Promise<void> {
  if (ownerAccountId) revokeAgentBindings("owner_account_id = ?", ownerAccountId);
  const agents = db.query("SELECT nick FROM accounts WHERE kind = 'agent' AND owner = ? COLLATE NOCASE").all(owner) as { nick: string }[];
  for (const agent of agents) await removeAgent(agent.nick);
}

// The owner left or was removed from a channel: their agents leave it and its threads too. The
// agent's access depends on the owner's, so it never stays behind in a room the owner can't read.
export async function removeOwnerAgentsFromChannel(owner: string, channel: string): Promise<void> {
  // A DM is between the owner and the agent; closing it is not leaving a channel.
  if (channelInfo(channel)?.visibility === "direct") return;
  const rooms = [channel, ...(db.query("SELECT channel FROM threads WHERE parent = ?").all(channel) as { channel: string }[]).map((row) => row.channel)];
  const agents = db.query("SELECT nick FROM accounts WHERE kind = 'agent' AND owner = ? COLLATE NOCASE").all(owner) as { nick: string }[];
  for (const { nick } of agents) {
    for (const room of rooms) {
      if (!db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ?").get(room, nick)) continue;
      db.query("DELETE FROM channel_members WHERE channel = ? AND nick = ?").run(room, nick);
      evictAgentRoomForNick(nick, room);
      channelsChanged(room, [nick], false);
      if (channelInfo(room)?.visibility === "secret") await revokeChannelAccess(room, nick).catch((error) => console.error(`agent revoke failed for ${nick} in ${room}:`, error));
    }
  }
}

// Someone leaving or removed from a channel leaves every thread under it as well: child membership
// rows, the private child's +I exception and their IRC join. `keepInvite` mirrors the parent rule
// that an owner keeps +I to come back through an invite link.
export async function removeFromThreads(nick: string, parent: string, reason: string, keepInvite = false): Promise<void> {
  const children = threadChildren(parent);
  if (!children.length) return;
  db.query("DELETE FROM channel_members WHERE nick = ? AND channel IN (SELECT channel FROM threads WHERE parent = ?)").run(nick, parent);
  for (const child of children) { evictAgentRoomForNick(nick, child.channel); channelsChanged(child.channel, [nick], false); }
  await removeFromThreadChannels(nick, children.map((child) => ({ channel: child.channel, revoke: child.visibility !== "workspace" && !keepInvite })), reason);
}

// Agents in a new thread join it now; otherwise a mention there waits for the next reconnect.
function joinThreadAgents(channel: string): void {
  const agents = db.query("SELECT m.nick FROM channel_members m JOIN accounts a ON a.nick = m.nick COLLATE NOCASE WHERE m.channel = ? AND a.kind = 'agent'").all(channel) as { nick: string }[];
  for (const { nick } of agents) {
    void joinAgentRoomForNick(nick, channel).catch(() => {});
  }
}
