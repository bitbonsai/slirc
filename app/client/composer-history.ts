import { type Message } from "@client/model.ts";

// Alt+Up / Alt+Down in the composer: step through what you sent in this conversation, like a
// shell. Plain Up in an empty composer is different: it selects the newest message (E edits it).

export const RECALL_LIMIT = 50;

// Your own sent lines, oldest first, without deleted ones, edited-away originals, helper cards
// or repeats in a row.
export function sentTexts(messages: readonly Message[], account: string): string[] {
  const me = account.toLowerCase();
  const replaced = new Set(messages.map((message) => message.replaces).filter(Boolean));
  const texts: string[] = [];
  for (const message of messages) {
    if (message.authorAccount.toLowerCase() !== me || message.deleted || message.notice || message.poll) continue;
    if (message.serverId && replaced.has(message.serverId)) continue;
    const text = message.text.trim();
    if (text && texts.at(-1) !== text) texts.push(text);
  }
  return texts.slice(-RECALL_LIMIT);
}

// `index` points into the entries; `saved` is the draft to give back after the newest one.
export interface Recall { index: number; saved: string }

// One step. Up from no recall saves the draft and shows the newest entry; Down past the newest
// restores the draft and ends the recall. Null means nothing to do.
export function recallStep(entries: readonly string[], state: Recall | null, direction: -1 | 1, current: string): { state: Recall | null; text: string } | null {
  if (!entries.length) return null;
  if (!state) {
    if (direction === 1) return null;
    const index = entries.length - 1;
    return { state: { index, saved: current }, text: entries[index]! };
  }
  const index = state.index + direction;
  if (index < 0) return null;
  if (index >= entries.length) return { state: null, text: state.saved };
  return { state: { index, saved: state.saved }, text: entries[index]! };
}
