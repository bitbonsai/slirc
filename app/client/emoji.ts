import rows from "../public/vendor/emoji.json";
import { emojify, setEmojiTable } from "../public/history.js";
import { hasUnclosedCodeFence, textSegments, type TextSegment } from "@client/render.ts";

// Reuse the legacy table and converter. Accept the requested plural as an alias.
const standardRows = [...rows, ["claps", "👏"]];
setEmojiTable(rows);
const displayEmoji = (text: string): string => emojify(text).replace(/:claps:/gi, "👏");

export type CustomEmoji = { name: string; url: string; addedBy?: string };
export type EmojiSuggestion = { code: string; emoji: string; image?: string; addedBy?: string };

export function emojiContext(text: string, caret = text.length): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  if (hasUnclosedCodeFence(before) || (before.split("\n").at(-1)!.match(/`/g)?.length ?? 0) % 2) return null;
  const match = /(^|[\s(]):([a-z0-9_+-]{0,32})$/i.exec(before);
  return match ? { start: caret - match[2]!.length - 1, end: caret, query: match[2]!.toLowerCase() } : null;
}

// Same ranking as the legacy composer and reaction search.
export function emojiSuggestions(query: string, custom: CustomEmoji[] = [], limit = 8): EmojiSuggestion[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const instance = custom.filter((row) => row.name.includes(q))
    .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name))
    .map((row) => ({ code: row.name, emoji: `:${row.name}:`, image: row.url, addedBy: row.addedBy }));
  const scored: (EmojiSuggestion & { rank: number })[] = [];
  const customCodes = new Set(custom.map((row) => row.name));
  for (const [code, emoji, ...keywords] of standardRows) {
    if (customCodes.has(code!)) continue;
    const rank = code!.startsWith(q) ? 0 : code!.includes(q) ? 1 : keywords.some((word) => word.startsWith(q)) ? 2 : keywords.some((word) => word.includes(q)) ? 3 : -1;
    if (rank >= 0) scored.push({ code: code!, emoji: emoji!, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.code.length - b.code.length || a.code.localeCompare(b.code));
  return [...instance, ...scored].slice(0, limit);
}

// Add reaction search. Under two letters it shows the presets, popular picks, then custom emoji.
// A custom emoji reacts with its `:name:` shortcode, the same text IRC clients read.
const POPULAR_REACTIONS = ["🎉", "✅", "🙏", "💯", "🚀", "👌", "🤝", "💪", "😍", "🥳", "😎", "😊", "😅", "🤔", "😮", "😢", "😬", "🙈", "👋", "✨", "⭐", "☕", "➕", "❌"];
const stripVariant = (emoji: string): string => emoji.replace(/\uFE0F/g, "");
const codeByEmoji = new Map<string, string>();
for (const [code, emoji] of standardRows) if (!codeByEmoji.has(stripVariant(emoji!))) codeByEmoji.set(stripVariant(emoji!), code!);

export function reactionSearchRows(query: string, custom: CustomEmoji[], presets: readonly string[]): EmojiSuggestion[] {
  const q = query.trim().replace(/^:+|:+$/g, "");
  if (q.length >= 2) return emojiSuggestions(q, custom, 40);
  const standard = [...new Set([...presets, ...POPULAR_REACTIONS])].map((emoji) => ({ code: codeByEmoji.get(stripVariant(emoji)) ?? "", emoji }));
  const instance = custom.map((row) => ({ code: row.name, emoji: `:${row.name}:`, image: row.url, addedBy: row.addedBy }));
  return [...standard, ...instance].slice(0, 48);
}

// Preserve Markdown, code, URLs and nicknames. Only human text becomes Unicode on the wire.
export function emojiText(text: string, custom: CustomEmoji[] = []): string {
  const convert = custom.some((row) => row.name.toLowerCase() === "claps") ? emojify : displayEmoji;
  return textSegments(text).map((segment) => {
    const raw = segment.raw ?? segment.text;
    return segment.href || segment.nick || segment.format === "code" || segment.format === "fence" ? raw : convert(raw);
  }).join("");
}

export function emojiTextSegments(text: string, custom: CustomEmoji[]): (TextSegment & { emojiUrl?: string })[] {
  const result: (TextSegment & { emojiUrl?: string })[] = [];
  const byCode = new Map(custom.map((row) => [row.name.toLowerCase(), row.url]));
  for (const segment of textSegments(text)) {
    if (segment.href || segment.nick || segment.format === "code" || segment.format === "fence") { result.push(segment); continue; }
    let end = 0;
    for (const match of segment.text.matchAll(/:([a-z0-9_+-]{2,32}):/gi)) {
      const url = byCode.get(match[1]!.toLowerCase());
      if (!url) continue;
      if (match.index > end) result.push({ ...segment, text: displayEmoji(segment.text.slice(end, match.index)) });
      result.push({ text: match[0], emojiUrl: url });
      end = match.index + match[0].length;
    }
    if (end < segment.text.length || !end) result.push({ ...segment, text: displayEmoji(segment.text.slice(end)) });
  }
  return result;
}
