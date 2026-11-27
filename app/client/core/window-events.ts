import { inMacApp } from "@client/native-shell.ts";
import { conversationId } from "@client/model.ts";
import { inviteToken, mentionToken } from "@client/mentions.ts";
import { NOTES_CONVERSATION_ID } from "@client/navigation.ts";
import { helpInsert, type HelpTopic } from "@client/help.ts";
import { isApplePlatform, isJumpShortcut, isWorkspacesShortcut, type JumpRow } from "@client/jump.ts";
import { isChannelSearchShortcut } from "@client/search.ts";
import type { createTranscript } from "@client/transcript.ts";
import type { createComposerEditor } from "@client/composer-editor.ts";
import type { createEmojiPicker } from "@client/emoji-picker.ts";
import type { createGiphyPicker } from "@client/giphy-picker.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface WindowEventsDeps {
  state: Pick<RuntimeState, "roomId">;
  ui: Pick<ClientState, "authenticated" | "composer" | "mentionOpen" | "slashOpen" | "workspaceDialog"> & { openWorkspaces: () => void };
  signal: AbortSignal;
  transcript: () => ReturnType<typeof createTranscript>;
  editor: () => ReturnType<typeof createComposerEditor>;
  emoji: () => ReturnType<typeof createEmojiPicker>;
  giphy: () => ReturnType<typeof createGiphyPicker>;
  openJump: () => void;
  canSearchChannel: () => boolean;
  openChannelSearch: () => void;
  selectConversation: (id: string | null, focusMessageId?: string, focusThread?: boolean) => void;
  openRoom: (room?: string) => void;
  openDirect: (nick: string, deliberate?: boolean) => Promise<void>;
  replaceComposerText: (text: string) => void;
  chooseCommandByName: (name: string) => void;
}

export function createWindowEvents(deps: WindowEventsDeps) {
  const { state: rs, ui, signal, transcript, editor, emoji, giphy, openJump, canSearchChannel, openChannelSearch, selectConversation, openRoom, openDirect, replaceComposerText, chooseCommandByName } = deps;

  // Cmd+K on Apple keyboards, Ctrl+K elsewhere, from anywhere in the signed-in app. Another open
  // dialog keeps the keyboard; the palette's own shortcut toggles it closed.
  const applePlatform = isApplePlatform();

  window.addEventListener("keydown", (event) => {
    if (!isJumpShortcut(event, applePlatform) || !ui.authenticated) return;
    const open = document.querySelector("dialog[open]");
    if (open && open.id !== "jump-dialog") return;
    event.preventDefault();
    openJump();
  }, { signal });

  window.addEventListener("keydown", (event) => {
    if (!isChannelSearchShortcut(event, applePlatform) || !canSearchChannel()) return;
    const open = document.querySelector("dialog[open]");
    if (open && open.id !== "channel-search-dialog") return;
    event.preventDefault();
    openChannelSearch();
  }, { signal });

  window.addEventListener("slirc:channel-search-pick", (event) => {
    const detail = (event as CustomEvent<{ conversationId?: unknown; focusId?: unknown }>).detail;
    if (typeof detail?.conversationId !== "string" || typeof detail?.focusId !== "string") return;
    if (detail.conversationId !== rs.roomId) return;
    // Notes have no server ids to look up; every other hit takes the message-link path (replies open their thread).
    if (rs.roomId === NOTES_CONVERSATION_ID) transcript().focus(detail.focusId);
    else selectConversation(detail.conversationId, detail.focusId);
  }, { signal });

  // Cmd+Option+O (Ctrl+Alt+O off Apple) opens the Workspaces dialog, also from the composer. The
  // Mac app's menu has the same key and calls SlircOpenWorkspaces, so there the page leaves it alone
  // and the dialog opens once.
  const macApp = inMacApp();

  window.addEventListener("keydown", (event) => {
    if (macApp || !isWorkspacesShortcut(event, applePlatform) || !ui.authenticated) return;
    event.preventDefault();
    const open = document.querySelector("dialog[open]");
    if (open || ui.workspaceDialog) return;
    ui.openWorkspaces();
  }, { signal });

  window.addEventListener("slirc:jump-pick", (event) => {
    const row = (event as CustomEvent<{ row?: JumpRow }>).detail?.row;
    if (!row) return;
    if (row.kind === "channel" || row.kind === "group") openRoom(row.target);
    else void openDirect(row.target, true);
  }, { signal });

  // Thread-picking is the one thing the dialog cannot do itself: the parent still owns routing.
  window.addEventListener("slirc:open-room", (event) => {
    const channel = (event as CustomEvent<{ channel?: unknown }>).detail?.channel;
    if (typeof channel === "string") openRoom(channel);
  }, { signal });

  // Narrow coordination between the composer and the named panels. The panels own their selection,
  // the parent owns command definitions/dispatch and the durable Giphy send.
  window.addEventListener("slirc:slash-open", (event) => {
    ui.slashOpen = !!(event as CustomEvent<{ open?: unknown }>).detail?.open;
  }, { signal });

  window.addEventListener("slirc:mention-open", (event) => {
    ui.mentionOpen = !!(event as CustomEvent<{ open?: unknown }>).detail?.open;
  }, { signal });

  window.addEventListener("slirc:mention-pick", (event) => {
    const nick = (event as CustomEvent<{ nick?: unknown }>).detail?.nick;
    if (typeof nick !== "string" || !nick) return;
    const text = String(ui.composer ?? "");
    // An /invite pick fills in the command; Enter then runs it and shows the Add note.
    if (inviteToken(text) !== null) { replaceComposerText(`/invite @${nick} `); return; }
    const input = document.querySelector<HTMLElement>("#input");
    const caret = input ? editor().composerSelectionOffset(input) : text.length;
    const token = mentionToken(text, caret);
    if (!token) return;
    // Replace only the token at the caret, so text after it survives, and leave the caret after the nick.
    const after = text.slice(caret);
    const insert = "@" + nick + (after.startsWith(" ") ? "" : " ");
    const updated = text.slice(0, token.start) + insert + after;
    replaceComposerText(updated);
    if (input) editor().setComposerSelection(input, editor().displayOffsetAtSource(updated, token.start + insert.length));
    emoji().syncCaret();
  }, { signal });

  window.addEventListener("slirc:help-pick", (event) => {
    const row = (event as CustomEvent<{ row?: HelpTopic }>).detail?.row;
    if (!row) return;
    if (row.url) { window.open(row.url, "_blank", "noopener,noreferrer"); return; }
    const insert = helpInsert(row);
    if (!insert) return;
    replaceComposerText(insert);
  }, { signal });

  window.addEventListener("slirc:slash-run", (event) => {
    const name = (event as CustomEvent<{ name?: unknown }>).detail?.name;
    if (typeof name === "string") chooseCommandByName(name);
  }, { signal });

  window.addEventListener("slirc:giphy-send", (event) => {
    void giphy().chooseGiphy((event as CustomEvent<{ preview?: unknown; url?: unknown; title?: unknown }>).detail as { preview: string; url: string; title: string });
  }, { signal });

}
