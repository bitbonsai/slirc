import type { createPresence } from "@client/presence.ts";
import { conversationId, foldIdentifier, type Message } from "@client/model.ts";
import { agentOfflineCard, agentOfflineFolded, type AgentOfflineCard } from "@client/agent-offline.ts";
import { agentFor, isAgentNick } from "@client/agent-roster.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface AgentNoticesDeps {
  state: Pick<RuntimeState, "directories">;
  ui: Pick<ClientState, "account" | "agentProfiles" | "agentRequests" | "channel" | "copiedAgentCommand" | "direct" | "directs" | "messages">;
  presence: () => ReturnType<typeof createPresence>;
  connect: () => Promise<void>;
}

export function createAgentNotices(deps: AgentNoticesDeps) {
  const { state: rs, ui, presence, connect } = deps;

  function agentRequestLabel(message: Message): string {
    if (!message.serverId || message.deleted || message.state !== "confirmed" || foldIdentifier(message.authorAccount) !== foldIdentifier(ui.account)) return "";
    const conversation = rs.directories.get(message.conversationId);
    if (conversation?.kind !== "dm") return "";
    const direct = ui.directs.find((row: { channel: string }) => foldIdentifier(row.channel) === foldIdentifier(conversation.wireTarget));
    const agent = direct && agentFor(ui.agentProfiles, direct.nick);
    if (!agent || foldIdentifier(agent.owner) !== foldIdentifier(ui.account)) return "";
    return ui.agentRequests.find((row: { channel: string; messageId: string }) =>
      foldIdentifier(row.channel) === foldIdentifier(conversation.wireTarget) && row.messageId === message.serverId)?.state || "";
  }

  // A live event about an agent this tab has never heard of (a fresh pairing) refreshes /auth/me
  // once, so its DM and profile show up without a reload.
  const agentRefreshes = new Set<string>();

  function refreshForAgent(nick: string): void {
    const key = foldIdentifier(nick);
    if (isAgentNick(ui.agentProfiles, nick) || agentRefreshes.has(key)) return;
    agentRefreshes.add(key);
    void connect();
  }

  const offlineCard = (message: Message) => agentOfflineCard(message, ui.direct ? String(ui.channel ?? "") : null, (nick) => isAgentNick(ui.agentProfiles, nick));

  // An agent's offline notice as a card, or null for every other line. A folded card (the agent
  // came back since) is left out of the transcript by offlineFolded. See agent-offline.ts.
  function offlineView(message: Message): AgentOfflineCard | null {
    return offlineCard(message);
  }

  function offlineFolded(message: Message): boolean {
    if (!offlineCard(message)) return false;
    const list = ui.messages as Message[];
    const at = list.findIndex((item) => item.id === message.id);
    const later = (at < 0 ? [] : list.slice(at + 1)).map((item) => ({ authorNick: item.authorNick, isCard: !!offlineCard(item) }));
    return agentOfflineFolded(message, later, presence().agents[foldIdentifier(message.authorNick)] === true);
  }

  // The resume command from an agent's offline card. The check mark shows for 1.5 s on that card.
  async function copyAgentCommand(message: Message): Promise<void> {
    const command = offlineCard(message)?.command;
    if (!command) return;
    try { await navigator.clipboard.writeText(command); } catch { return; }
    ui.copiedAgentCommand = message.id;
    setTimeout(() => { if (ui.copiedAgentCommand === message.id) ui.copiedAgentCommand = ""; }, 1_500);
  }

  return { agentRequestLabel, agentRefreshes, refreshForAgent, offlineView, offlineFolded, copyAgentCommand };
}
