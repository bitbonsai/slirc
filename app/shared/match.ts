// One typed-text matcher for every picker and list that filters people, agents, bots, channels or
// workspaces. A row matches when the text starts a field or any word in it, case-folded. Prefix hits
// outrank word-start hits; callers keep their own order among equals.

import { foldText } from "./fold.ts";

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** 2 when the query starts a field, 1 when it starts a word inside one ("dev" in "demo-dev"), 0 for no match.
 * An empty query matches everything as a prefix. */
export function matchRank(query: string, ...fields: readonly unknown[]): 0 | 1 | 2 {
  const needle = foldText(query);
  if (!needle) return 2;
  let best: 0 | 1 | 2 = 0;
  for (const field of fields) {
    const text = foldText(field);
    if (text.startsWith(needle)) return 2;
    for (let at = text.indexOf(needle, 1); at > 0 && best < 1; at = text.indexOf(needle, at + 1)) {
      if (!WORD_CHAR.test(text[at - 1]!)) best = 1;
    }
  }
  return best;
}

/** The items that match, prefix hits first. The sort is stable, so equal ranks keep their input order. */
export function rankMatches<T>(items: readonly T[], query: string, fields: (item: T) => readonly unknown[]): T[] {
  return items
    .map((item) => ({ item, rank: matchRank(query, ...fields(item)) }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.item);
}
