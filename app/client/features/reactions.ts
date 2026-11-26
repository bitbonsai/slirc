import type { Message } from "@client/model.ts";
import { reactionChips } from "@client/presentation.ts";
import { reactionTagMessage } from "@client/protocol.ts";
import type { createMessageActions } from "@client/message-actions.ts";
import type { AuthorizedConversation } from "@client/sync.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface ReactionsDeps {
  state: Pick<RuntimeState, "capsOk" | "roomId" | "socket" | "sync">;
  ui: Pick<ClientState, "authenticated" | "capsNote" | "currentConversationId" | "messages" | "peekRoom" | "phase" | "reactions" | "readyVersion" | "sendError">;
  actions: () => ReturnType<typeof createMessageActions>;
  activeConversation: () => AuthorizedConversation | undefined;
  hint: (text: string) => void;
}

export function createReactions(deps: ReactionsDeps) {
  const { state: rs, ui, actions, activeConversation, hint } = deps;

  function reactionsReady(): boolean {
    // Alpine tracks reactive reads. Read phase, readyVersion, capsNote, the open conversation and
    // the message projection before the non-reactive capsOk/sync/socket guards, or a short-circuit
    // leaves the persistent picker buttons disabled after the open room turns ready.
    const phase = ui.phase;
    const tracked = [ui.readyVersion, ui.capsNote, ui.currentConversationId, ui.messages];
    void tracked;
    // Signed-out peek: chips stay pressable so a tap asks to sign in instead of doing nothing.
    if (!ui.authenticated && ui.peekRoom) return true;
    return phase === "live" && rs.capsOk && !!rs.roomId && (rs.sync?.isReady(rs.roomId) ?? false) && rs.socket?.readyState === WebSocket.OPEN;
  }

  // Online-first: send the TAGMSG on the live connection, report a refusal, and never paint a
  // count this tab did not receive back from the server. The committed event is the truth.
  function chooseReaction(message: Message, emoji: string): void {
    const item = activeConversation();
    const target = item?.wireTarget;
    actions().closeReactionPicker();
    if (!item || !target || !message || !message.serverId || message.state !== "confirmed") return;
    if (!reactionsReady()) { hint("Reactions need a live connection."); return; }
    const selected = reactionChips(ui.reactions, message.serverId).some((chip) => chip.emoji === emoji && chip.mine);
    try {
      // Taking a reaction back also clears it from the messages this one edited, where it may live.
      for (const id of selected ? [message.serverId, ...(message.chain ?? [])] : [message.serverId]) {
        rs.socket!.send(`${reactionTagMessage(target, id, emoji, selected)}\r\n`);
      }
      actions().stamp(`${message.serverId}:${emoji}`);
    } catch (error) {
      ui.sendError = error instanceof Error ? error.message : "Could not react.";
    }
  }

  return { reactionsReady, chooseReaction };
}
