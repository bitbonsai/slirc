// Mention matching for the composer's `@` picker. Pure so the token boundary and candidate order
// (room members before contacts, deduped, capped) are testable without the browser client.
import { foldIdentifier } from "./model.ts";

const MENTION_TOKEN_RE = /(?:^|\s)@([^\s@]*)$/;

/** The `@partial` token ending at the caret (the end of the draft by default), plus the index of its `@`. */
export function mentionToken(text: string, caret = text.length): { query: string; start: number } | null {
  const match = MENTION_TOKEN_RE.exec(text.slice(0, Math.max(0, Math.min(caret, text.length))));
  if (!match) return null;
  return { query: match[1], start: match.index + match[0].lastIndexOf("@") };
}

// `/invite ev` or `/invite @ev`: the partial nick, empty right after the command. An email or anything
// past the nick is not a pick, so it stays null.
const INVITE_TOKEN_RE = /^\/invite\s+@?([A-Za-z0-9_-]*)$/i;

export function inviteToken(text: string): string | null {
  return INVITE_TOKEN_RE.exec(text)?.[1] ?? null;
}

/** People search results to offer for `/invite`: server order, minus me and known members, max 8. */
export function inviteCandidates(results: readonly string[], exclude: readonly string[]): string[] {
  const skip = new Set(exclude.map(foldIdentifier));
  return results.filter((nick) => !skip.has(foldIdentifier(nick))).slice(0, 8);
}

/** Room members first, then contacts, case-insensitively prefixed by the query, deduped, max 8.
 * `keep` drops nicks the picker must not offer, such as an agent that isn't attached. */
export function mentionCandidates(query: string, members: readonly string[], contacts: readonly string[], keep: (nick: string) => boolean = () => true): string[] {
  const folded = foldIdentifier(query);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const nick of [...members, ...contacts]) {
    const key = foldIdentifier(nick);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if ((!folded || key.startsWith(folded)) && keep(nick)) out.push(nick);
    if (out.length >= 8) break;
  }
  return out;
}
