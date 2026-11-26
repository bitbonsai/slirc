// Ergo checks every line of a draft/multiline batch as it would relay it, source included:
// ":<nick>!<user>@<host> PRIVMSG <target> :<text>\r\n" must fit 512 bytes (tags aside), or the
// whole batch fails with 417 "Line too long to be relayed without truncation" and nothing lands.
// A line over 512 bytes as sent is dropped on read instead, and the rest of the batch lands.
// Senders cut each text line into parts that fit and mark every continuation with
// draft/multiline-concat; readers join a concat part to the part before it with no newline.

export const IRC_LINE_BYTES = 512;
// The sender's source as Ergo relays it, at its longest: ":" nick "!" user "@" host " " with
// Slirc's Ergo limits nicklen 32, identlen 20 and a 64-byte vhost. A sender cannot know its cloak
// for sure, so it budgets for the longest one.
export const MAX_SOURCE_BYTES = 1 + 32 + 1 + 20 + 1 + 64 + 1;
export const CONCAT_TAG = "draft/multiline-concat";

export type WirePart = { text: string; concat: boolean };

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

// The parts of `text` for one PRIVMSG target: one part per short line, several for a long one.
// A part is never empty unless its whole line is, and a cut never splits a character.
export function wireParts(text: string, target: string): WirePart[] {
  const budget = IRC_LINE_BYTES - 2 - MAX_SOURCE_BYTES - byteLength(`PRIVMSG ${target} :`);
  const parts: WirePart[] = [];
  for (const line of text.split("\n")) {
    let rest = line;
    let concat = false;
    do {
      let piece = "";
      let bytes = 0;
      for (const char of rest) {
        const size = byteLength(char);
        if (bytes + size > budget) break;
        piece += char;
        bytes += size;
      }
      parts.push({ text: piece, concat });
      rest = rest.slice(piece.length);
      concat = true;
    } while (rest);
  }
  return parts;
}

// One message text from received parts, in order. `concat` is true when the part carried the tag.
export function joinParts(parts: WirePart[]): string {
  let text = "";
  parts.forEach((part, index) => {
    text += (index > 0 && !part.concat ? "\n" : "") + part.text;
  });
  return text;
}

export function isConcat(tags?: Record<string, string> | null): boolean {
  return !!tags && Object.prototype.hasOwnProperty.call(tags, CONCAT_TAG);
}
