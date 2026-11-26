// Text emoticons people still type by hand. IRC keeps the typed form; the PWA shows the emoji.
// Only whole tokens match: preceded by start or space, followed by end, space, or sentence punctuation.
const EMOTICONS = {
  ":)": "\u{1F642}", ":-)": "\u{1F642}", "=)": "\u{1F642}",
  ":D": "\u{1F600}", ":-D": "\u{1F600}", "=D": "\u{1F600}", "xD": "\u{1F606}", "XD": "\u{1F606}",
  ";)": "\u{1F609}", ";-)": "\u{1F609}",
  ":(": "\u{1F641}", ":-(": "\u{1F641}", ":'(": "\u{1F622}",
  ":P": "\u{1F61B}", ":-P": "\u{1F61B}", ":p": "\u{1F61B}", ":-p": "\u{1F61B}",
  ":O": "\u{1F62E}", ":-O": "\u{1F62E}", ":o": "\u{1F62E}",
  ":|": "\u{1F610}", ":/": "\u{1F615}", ":-/": "\u{1F615}", ":*": "\u{1F618}",
  "<3": "\u2764\uFE0F", "</3": "\u{1F494}", "8)": "\u{1F60E}", "B)": "\u{1F60E}",
  ">:(": "\u{1F620}", "\\o/": "\u{1F64C}", ":3": "\u{1F60A}", "o_O": "\u{1F633}", "-_-": "\u{1F611}",
};
const EMOTICON_RE = new RegExp(`(^|\\s)(${Object.keys(EMOTICONS).map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")})(?=$|\\s|[.,!?])`, "g");

// Shortcode table for :shortcode: rendering. Rows are [shortcode, emoji, ...keywords], built by
// scripts/build-emoji.ts. null until the client calls setEmojiTable, so emojify() quietly skips
// shortcode replacement until then.
let emojiByCode = null;

export function setEmojiTable(rows) {
  emojiByCode = new Map(rows.map((row) => [row[0], row[1]]));
}

const SHORTCODE_RE = /:([a-z0-9_+-]{2,32}):/gi;

export function emojify(text) {
  let result = text.replace(EMOTICON_RE, (_, lead, face) => lead + EMOTICONS[face]);
  if (emojiByCode) result = result.replace(SHORTCODE_RE, (full, code) => emojiByCode.get(code.toLowerCase()) ?? full);
  return result;
}
