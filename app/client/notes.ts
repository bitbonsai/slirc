// Notes: the signed-in person's private scratchpad, shown in the usual transcript and composer.
// Notes are not messages: they live only in the app's SQLite behind /api/notes, never on IRC, and
// carry no unread counts. Other tabs and devices reload the list when /api/events says "notes".
import type { Message } from "./model.ts";
import { NOTES_CONVERSATION_ID } from "./navigation.ts";

export interface Note { id: string; body: string; createdAt: number; updatedAt: number }

const HEADERS = { "Content-Type": "application/json", "X-Slirc-Notes": "1" };

function validNote(value: any): value is Note {
  return !!value && typeof value.id === "string" && typeof value.body === "string" && Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt);
}

async function answer(response: Response, fallback: string): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : fallback);
  return body;
}

/** One note as a confirmed message by its owner, so the transcript renders it like any other row. */
export function noteMessage(note: Note, account: string, nick: string): Message {
  return {
    id: `note-${note.id}`, conversationId: NOTES_CONVERSATION_ID, serverId: note.id,
    authorAccount: account, authorNick: nick, text: note.body,
    time: new Date(note.createdAt).toISOString(), state: "confirmed",
  };
}

export function createNotes(reactive: <T extends object>(value: T) => T, { fetcher = fetch, onChange = () => {} }: { fetcher?: typeof fetch; onChange?: () => void } = {}) {
  let epoch = 0;
  const state = reactive({
    list: [] as Note[],
    loaded: false,
    messages(account: string, nick: string): Message[] {
      return state.list.map((note) => noteMessage(note, account, nick));
    },
    // The newest server answer wins; a stale reply from before a write or sign-out is dropped.
    async load(): Promise<void> {
      const mine = ++epoch;
      try {
        const body = await answer(await fetcher("/api/notes", { credentials: "same-origin", cache: "no-store" }), "Could not load your notes.");
        if (mine !== epoch) return;
        state.list = Array.isArray(body?.notes) ? body.notes.filter(validNote) : [];
        state.loaded = true;
        onChange();
      } catch { /* keep what is shown; the next event or open retries */ }
    },
    async add(text: string): Promise<Note> {
      const body = await answer(await fetcher("/api/notes", { method: "POST", credentials: "same-origin", headers: HEADERS, body: JSON.stringify({ body: text }) }), "Could not save the note.");
      if (!validNote(body?.note)) throw new Error("Could not save the note.");
      epoch += 1;
      if (!state.list.some((note) => note.id === body.note.id)) state.list = [...state.list, body.note];
      onChange();
      return body.note;
    },
    async save(id: string, text: string): Promise<void> {
      const body = await answer(await fetcher(`/api/notes/${encodeURIComponent(id)}`, { method: "PATCH", credentials: "same-origin", headers: HEADERS, body: JSON.stringify({ body: text }) }), "Could not save the edit.");
      epoch += 1;
      if (validNote(body?.note)) state.list = state.list.map((note) => note.id === id ? body.note : note);
      onChange();
    },
    async remove(id: string): Promise<void> {
      await answer(await fetcher(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin", headers: HEADERS }), "Could not delete the note.");
      epoch += 1;
      state.list = state.list.filter((note) => note.id !== id);
      onChange();
    },
    reset(): void {
      epoch += 1;
      state.list = []; state.loaded = false;
    },
  });
  return state;
}
