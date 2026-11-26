import { conversationId } from "@client/model.ts";
import type { ClientState } from "@client/client-state.ts";

export interface IrcResetNotesDeps {
  ui: Pick<ClientState, "ircReset" | "stickies">;
  openIrc: () => void;
  openAdmin: () => void;
}

export function createIrcResetNotes(deps: IrcResetNotesDeps) {
  const { ui, openIrc, openAdmin } = deps;

  // After the derived-password migration, people with password IRC clients, and admins with
  // managed bots, keep a sticky note until they make a new password or dismiss it.
  const IRC_RESET_NOTES = {
    "irc-reset-clients": { kind: "clients", text: "Your IRC password changed. Open IRC clients and copy the new one.", open: () => openIrc() },
    "irc-reset-bots": { kind: "bots", text: "Your bots' IRC passwords changed. Open Admin and press New password for each bot.", open: () => openAdmin() },
  } as const;

  type IrcResetId = keyof typeof IRC_RESET_NOTES;

  // Opened on this page: the note stays away until the next load, while the flag waits for a new password.
  const ircResetOpened = new Set<string>();

  function showIrcResetNotes(): void {
    const ids = (Object.keys(IRC_RESET_NOTES) as IrcResetId[]).filter((id) => ui.ircReset[IRC_RESET_NOTES[id].kind] && !ircResetOpened.has(id));
    ui.stickies = [...ids.map((id) => ({ id, text: IRC_RESET_NOTES[id].text, action: "Open", conversationId: "" })),
      ...ui.stickies.filter((item) => !(item.id in IRC_RESET_NOTES))];
  }

  function ircResetOpen(id: string): boolean {
    if (!(id in IRC_RESET_NOTES)) return false;
    ircResetOpened.add(id);
    ui.stickies = ui.stickies.filter((item) => item.id !== id);
    IRC_RESET_NOTES[id as IrcResetId].open();
    return true;
  }

  function ircResetDismiss(id: string): boolean {
    if (!(id in IRC_RESET_NOTES)) return false;
    const kind = IRC_RESET_NOTES[id as IrcResetId].kind;
    ui.stickies = ui.stickies.filter((item) => item.id !== id);
    ui.ircReset = { ...ui.ircReset, [kind]: false };
    void fetch("/api/irc/reset-notice", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) }).catch(() => {});
    return true;
  }

  return { showIrcResetNotes, ircResetOpen, ircResetDismiss };
}
