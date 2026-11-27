// Generated from app/shared/match.ts by desktop/picker-assets.ts. Do not edit.
(() => {
function foldIdentifier(value, mapping = "ascii") {
  const lower = value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  if (mapping === "ascii")
    return lower;
  return lower.replace(/[\[\]\\^]/g, (ch) => ({ "[": "{", "]": "}", "\\": "|", "^": mapping === "rfc1459" ? "~" : "^" })[ch]);
}
function foldText(value) {
  return String(value ?? "").toLowerCase();
}
const WORD_CHAR = /[\p{L}\p{N}]/u;
function matchRank(query, ...fields) {
  const needle = foldText(query);
  if (!needle)
    return 2;
  let best = 0;
  for (const field of fields) {
    const text = foldText(field);
    if (text.startsWith(needle))
      return 2;
    for (let at = text.indexOf(needle, 1);at > 0 && best < 1; at = text.indexOf(needle, at + 1)) {
      if (!WORD_CHAR.test(text[at - 1]))
        best = 1;
    }
  }
  return best;
}
function rankMatches(items, query, fields) {
  return items.map((item) => ({ item, rank: matchRank(query, ...fields(item)) })).filter((entry) => entry.rank > 0).sort((a, b) => b.rank - a.rank).map((entry) => entry.item);
}
globalThis.slircMatch = { matchRank, rankMatches };
})();
