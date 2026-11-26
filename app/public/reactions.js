// IRCv3 reactions are TAGMSG replies. Ergo owns persistence; clients rebuild current state from live events and CHATHISTORY.
function escapeTag(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\:").replace(/ /g, "\\s").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function reactionLine(target, messageId, emoji, remove = false) {
  if (!target || /[\0\r\n ]/.test(target)) throw new Error("invalid reaction target");
  const reply = escapeTag(messageId);
  const reaction = escapeTag(emoji);
  return `@+reply=${reply};+draft/reply=${reply};+draft/${remove ? "unreact" : "react"}=${reaction} TAGMSG ${target}`;
}
