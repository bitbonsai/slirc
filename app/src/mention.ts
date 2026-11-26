const escape = (nick: string) => nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function matchesMention(text: string, nick: string) {
  return new RegExp(`(^|[^A-Za-z0-9_])@?${escape(nick)}(?=$|[^A-Za-z0-9_])`, "i").test(text);
}

// Only "@nick", never the bare word. A helper named after a common word uses this in rooms.
export function matchesAtMention(text: string, nick: string) {
  return new RegExp(`(^|[^A-Za-z0-9_])@${escape(nick)}(?=$|[^A-Za-z0-9_])`, "i").test(text);
}

// What is left to answer once the helper's own name is out of the way. "@remind in 20m stretch"
// and a DM's "remind in 20m stretch" are the same request; "remind me in 20m stretch" is too.
export function afterNick(text: string, nick: string): string {
  const match = text.match(new RegExp(`@?${escape(nick)}\\b[:,]?\\s*(?:me\\b[:,]?\\s*)?`, "i"));
  return match ? text.slice((match.index || 0) + match[0].length).trim() : text.trim();
}
