import { conversationId, type Message } from "@client/model.ts";
import type { AuthorizedConversation } from "@client/sync.ts";
import { NOTES_CONVERSATION_ID } from "@client/navigation.ts";
import { jumpRows, type JumpRow } from "@client/jump.ts";
import { embedMetaFromResponse, type EmbedMeta } from "@client/embed.ts";
import { searchConversation, searchNotes, type SearchKind } from "@client/search.ts";
import { recallStep, sentTexts, type Recall } from "@client/composer-history.ts";
import type { createPopupOpener } from "@client/popups.ts";
import type { createLinksView } from "@client/links-view.ts";
import type { createNotes } from "@client/notes.ts";
import type { createPolls } from "@client/polls.ts";
import type { createView } from "@client/view.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface SearchDeps {
  state: Pick<RuntimeState, "authorized" | "db" | "directories" | "roomId" | "stopped" | "sync">;
  ui: Pick<ClientState, "account" | "authenticated" | "channel" | "channels" | "composer" | "directs" | "editingMessageId" | "embeds" | "greeting" | "messages" | "mobileNav" | "notesOpen" | "pendingDm" | "pendingThread" | "roomLabel" | "threads"> & { nick?: string; view: ReturnType<typeof createView> };
  isDesktop: boolean;
  openPopup: ReturnType<typeof createPopupOpener>;
  notes: ReturnType<typeof createNotes>;
  library: () => ReturnType<typeof createLinksView>;
  polls: () => ReturnType<typeof createPolls>;
  isGroupRoom: (wireTarget: string) => boolean;
  isOpenRoom: (room: string) => boolean;
  unreadCount: (id: string) => number;
  roomLabelFor: (wireTarget: string) => string;
  conversationIdForDm: (channel: string) => string;
  contactList: () => string[];
  activeChannelArchived: () => boolean;
  offlineFolded: (message: Message) => boolean;
  replaceComposerText: (text: string) => void;
}

export function createSearch(deps: SearchDeps) {
  const { state: rs, ui, isDesktop, openPopup, notes, library, polls, isGroupRoom, isOpenRoom, unreadCount, roomLabelFor, conversationIdForDm, contactList, activeChannelArchived, offlineFolded, replaceComposerText } = deps;

  // Cmd/Ctrl+K: channels (starred ones too), groups, DMs including agents, then contacts.
  function openJump(): void {
    if (!ui.authenticated) return;
    const isGroup = (wire: string) => isGroupRoom(wire);
    const rows: JumpRow[] = jumpRows({
      channels: ui.channels.filter((item: AuthorizedConversation) => !isGroup(item.wireTarget)).map((item: AuthorizedConversation) => ({
        wireTarget: item.wireTarget, label: item.wireTarget.replace(/^#/, ""), secret: !isOpenRoom(item.wireTarget), unread: unreadCount(item.conversationId),
      })),
      groups: ui.channels.filter((item: AuthorizedConversation) => isGroup(item.wireTarget)).map((item: AuthorizedConversation) => ({
        wireTarget: item.wireTarget, label: roomLabelFor(item.wireTarget), unread: unreadCount(item.conversationId),
      })),
      directs: ui.directs.map((item: { nick: string; channel: string }) => ({ nick: item.nick, unread: unreadCount(conversationIdForDm(item.channel)) })),
      people: contactList(),
    });
    openPopup();
    window.dispatchEvent(new CustomEvent("slirc:jump-open", { detail: { rows } }));
  }

  function canSearchChannel(): boolean {
    if (!ui.authenticated || rs.stopped || library().on) return false;
    if (ui.view.routed) return false;
    if (!isDesktop && ui.mobileNav !== null) return false;
    if (!rs.roomId || ui.pendingDm) return false;
    return rs.roomId === NOTES_CONVERSATION_ID || rs.directories.has(rs.roomId);
  }

  function openChannelSearch(): void {
    if (!canSearchChannel() || !rs.roomId) return;
    const targetId = rs.roomId;
    const isNotes = targetId === NOTES_CONVERSATION_ID;
    const label = isNotes ? "Notes" : (ui.roomLabel || String(ui.channel ?? ""));
    const targetDb = rs.db;
    const targetSync = rs.sync;
    const previewTried = new Set<string>();
    openPopup();
    window.dispatchEvent(new CustomEvent("slirc:channel-search-open", {
      detail: {
        conversationId: targetId,
        label,
        isNotes,
        exhausted: isNotes ? true : (targetSync?.isExhausted(targetId) ?? false),
        search: async (query: string, kind: SearchKind | null = null) => {
          if (isNotes) return searchNotes(notes.list, String(ui.account ?? ""), String(ui.nick ?? ""), query, { kind, embeds: ui.embeds });
          if (!targetDb) return { hits: [], total: 0, parsed: { from: null, terms: [] } };
          return searchConversation(targetDb, targetId, query, {
            kind,
            embeds: ui.embeds,
            threads: ui.threads,
            conversations: rs.authorized,
            greeting: ui.greeting,
            hidden: (message) => polls().hidesTally(message) || offlineFolded(message),
          });
        },
        // Cards for links this device has not rendered yet: ask the server once per link while the palette is open.
        previews: async (urls: string[]) => {
          const fresh = urls.filter((url) => !ui.embeds[url] && !previewTried.has(url)).slice(0, 12);
          for (const url of fresh) previewTried.add(url);
          const found: Record<string, EmbedMeta> = {};
          await Promise.all(fresh.map(async (url) => {
            try {
              const response = await fetch("/api/embed", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
              const meta = response.ok ? embedMetaFromResponse(await response.json()) : null;
              if (meta) found[url] = meta;
            } catch { /* the card stays a plain host line */ }
          }));
          if (!Object.keys(found).length) return false;
          ui.embeds = { ...ui.embeds, ...found };
          return true;
        },
        loadOlder: async () => {
          if (isNotes || !targetSync) return { loaded: 0, hasMore: false };
          return targetSync.loadOlder(targetId);
        },
      },
    }));
  }

  // Alt+Up / Alt+Down recall. The recall ends when the text no longer matches what it put in the
  // composer (you typed) or the conversation changed.
  let recall: (Recall & { conversationId: string; text: string }) | null = null;

  function recallSent(direction: -1 | 1): boolean {
    if (!rs.roomId || ui.editingMessageId || ui.pendingThread || ui.notesOpen || activeChannelArchived()) return false;
    const current = String(ui.composer ?? "");
    const live = recall && recall.conversationId === rs.roomId && recall.text === current ? recall : null;
    const step = recallStep(sentTexts(ui.messages, String(ui.account ?? "")), live, direction, current);
    if (!step) return false;
    recall = step.state ? { ...step.state, conversationId: rs.roomId, text: step.text } : null;
    replaceComposerText(step.text);
    return true;
  }

  return { openJump, canSearchChannel, openChannelSearch, recallSent };
}
