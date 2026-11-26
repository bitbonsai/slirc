#!/usr/bin/env bun
// Generates app/public/vendor/emoji.json: Slack-compatible (iamcal) shortcodes paired with
// their emoji glyph and search keywords, for the composer palette, the reaction picker,
// and history.js emojify() shortcode rendering.
//
// Source is emojibase-data. Flags, skin-tone/hair components, and bare regional-indicator
// letters are dropped for this first cut; skin-tone variants live under each row's `skins`
// array in the source and are never visited since we only walk the top-level dataset.
//
// Output: a compact array of rows, one per shortcode alias: [shortcode, emoji, ...keywords].
// Some emoji have more than one Slack shortcode (":email:" and ":envelope:" for the same
// glyph); each alias gets its own row so lookups and search both work either way.
import dataset from "emojibase-data/en/data.json" with { type: "json" };
import iamcal from "emojibase-data/en/shortcodes/iamcal.json" with { type: "json" };

// 2 = skin tone / hair color components (not standalone emoji), 9 = flags, undefined = bare
// regional-indicator letters (A-Z) that only combine into flags.
const SKIP_GROUPS = new Set([2, 9, undefined]);

const rows = [];
const seen = new Set();
const MAX_KEYWORDS = 1;

for (const entry of dataset) {
  if (SKIP_GROUPS.has(entry.group)) continue;
  const codes = iamcal[entry.hexcode];
  if (!codes) continue;
  const shortcodes = Array.isArray(codes) ? codes : [codes];
  // Only the primary (first) shortcode carries keywords: aliases still match by their own
  // code, and duplicating the same tag list on every alias was most of the file's weight.
  const keywords = [...new Set((entry.tags || []).map((s) => s.toLowerCase()))]
    .filter((word) => !shortcodes.includes(word) && word.length <= 10)
    .sort((a, b) => a.length - b.length)
    .slice(0, MAX_KEYWORDS);
  shortcodes.forEach((code, index) => {
    if (seen.has(code)) return; // first hexcode to claim a shortcode wins
    seen.add(code);
    rows.push(index === 0 ? [code, entry.emoji, ...keywords] : [code, entry.emoji]);
  });
}

rows.sort((a, b) => a[0].localeCompare(b[0]));

const outUrl = new URL("../public/vendor/emoji.json", import.meta.url);
const json = JSON.stringify(rows);
const bytes = Buffer.byteLength(json, "utf8");
await Bun.write(outUrl, json);
console.log(`wrote ${rows.length} shortcodes (${(bytes / 1024).toFixed(1)} KB raw) to ${outUrl.pathname}`);
