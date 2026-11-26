import { type ClientSession, type ClientState } from "@client/client-state.ts";
import { giphyPickerComponent } from "@client/composer-pickers.ts";
import { giphyResultsFrom } from "@client/presentation.ts";
import { giphyWireText } from "@client/media.ts";
import { type OpenPopup } from "@client/popups.ts";
import { NOTES_CONVERSATION_ID } from "@client/navigation.ts";

export function createGiphyPicker(reactive: <T extends object>(value: T) => T, { core, session, openPopup, roomId, isAuthorized, queueConversationText, saveNote }: {
  core: Pick<ClientState, "sendError">;
  session: ClientSession;
  openPopup: OpenPopup;
  roomId: () => string | null;
  isAuthorized: (id: string) => boolean;
  queueConversationText: (id: string, text: string) => Promise<void>;
  // Notes never reach IRC: a GIF picked there is saved as a note with the same wire line.
  saveNote: (text: string) => Promise<unknown>;
}) {
  let giphyEpoch = 0;
  const picker = giphyPickerComponent();
  const local = reactive({ ...picker,
    giphyOpen: false,
    giphyQuery: "",
    giphyResults: [] as { preview: string; url: string; title: string }[],
    giphyBusy: false,
    giphyError: "",
  });
  async function searchGiphy(query: string): Promise<void> {
    openPopup(closeGiphy);
    const capturedScope = session.key();
    const capturedRoom = roomId()!;
    const epoch = ++giphyEpoch;
    local.giphyOpen = true;
    local.giphyQuery = query;
    local.giphyResults = [];
    window.dispatchEvent(new CustomEvent("slirc:giphy-reset", { detail: { results: [] } }));
    local.giphyBusy = true;
    local.giphyError = "";
    try {
      const response = await fetch(`/giphy?q=${encodeURIComponent(query)}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => ({})) as { gifs?: unknown; error?: unknown };
      if (epoch !== giphyEpoch || session.key() !== capturedScope || roomId() !== capturedRoom) return;
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `GIF search failed (${response.status})`);
      const gifs = giphyResultsFrom(body);
      local.giphyResults = gifs;
      window.dispatchEvent(new CustomEvent("slirc:giphy-reset", { detail: { results: gifs } }));
      if (!gifs.length) local.giphyError = "No GIFs found.";
    } catch (error) {
      if (epoch === giphyEpoch && session.key() === capturedScope) local.giphyError = error instanceof Error ? error.message : "GIF search is unavailable right now.";
    } finally {
      if (epoch === giphyEpoch) local.giphyBusy = false;
    }
  }

  async function chooseGiphy(item: { preview: string; url: string; title: string; width?: number; height?: number }): Promise<void> {
    if (!item || !roomId() || !session.scope() || !isAuthorized(roomId()!)) { local.giphyError = "Open a conversation first."; return; }
    const capturedRoom = roomId()!;
    const capturedScopeKey = session.key();
    const capturedScope = session.scope()!;
    const capturedQuery = local.giphyQuery;
    closeGiphy();
    try {
      const text = giphyWireText(capturedQuery, item.url, item.width, item.height);
      if (capturedRoom === NOTES_CONVERSATION_ID) await saveNote(text);
      else await queueConversationText(capturedRoom, text);
    } catch {
      if (session.key() === capturedScopeKey) core.sendError = capturedRoom === NOTES_CONVERSATION_ID ? "Could not save that GIF as a note." : `Could not send that GIF to @${capturedScope.account}.`;
    }
  }

  function closeGiphy(): void {
    giphyEpoch += 1;
    local.giphyOpen = false;
    local.giphyBusy = false;
  }

  function moveGiphy(delta: number): void {
    window.dispatchEvent(new CustomEvent("slirc:giphy-move", { detail: { delta } }));
  }
  function resetSearch(): void {
    closeGiphy(); local.giphyResults = []; local.giphyError = "";
  }
  return Object.assign(local, {
    searchGiphy, chooseGiphy, closeGiphy, moveGiphy, resetSearch,
    destroy(): void { resetSearch(); (picker.destroy as (this: unknown) => void).call(local); },
  });
}
