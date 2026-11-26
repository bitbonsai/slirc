// Slash-command catalog and parsing. The composer forwards only text that is not a command;
// every recognized command runs locally or through an existing API. No legacy commands are
// advertised: the list below is exactly what runs.

export interface SlashCommand {
  name: string;
  description: string;
  /** true when running it needs an argument, so selection fills "/name " and waits. */
  argument: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "giphy", description: "Find and send a GIF", argument: true },
  { name: "help", description: "Browse help commands", argument: false },
  { name: "leave", description: "Sign out on this device", argument: false },
  { name: "link", description: "Save a link to the library", argument: true },
  { name: "links", description: "Search saved links", argument: true },
  { name: "me", description: "Send an action", argument: true },
  { name: "msg", description: "Open a direct message", argument: true },
  { name: "invite", description: "Invite someone to this channel", argument: true },
  { name: "poll", description: "Start a poll or vote in one", argument: true },
  { name: "kick", description: "Remove someone from this channel (admins)", argument: true },
  { name: "remind", description: "Ask the room's remind helper", argument: true },
  { name: "reconnect", description: "Reconnect to IRC", argument: false },
  { name: "threads", description: "Start a thread from the latest message", argument: true },
  { name: "whois", description: "Look up a person", argument: true },
];

const BY_NAME = new Map(SLASH_COMMANDS.map((command) => [command.name, command]));

export interface SlashInput {
  name: string;
  argument: string;
}

// `/name` with no space, or `/name the rest`; `/` alone and `/foo bar` both parse, but only a
// known name runs. The single-token shape is what opens the suggestion list.
export function parseSlash(text: string): SlashInput | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), argument: (match[2] ?? "").trim() };
}

export function slashCommand(name: string): SlashCommand | undefined {
  return BY_NAME.get(name.toLowerCase());
}

// Prefix suggestions, only while the first token is still being typed. `/g` lists only `/giphy`;
// once a space arrives the list closes and Enter runs the command with its argument.
export function slashSuggestions(text: string, hidden: readonly string[] = []): SlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query) && !hidden.includes(command.name));
}

// /remind and /poll talk to their helpers, and /link and /links to the links library; an instance
// that does not run the helper does not offer its commands. Only admins see /kick.
export function hiddenCommands(helpers: readonly string[], isAdmin = false): string[] {
  return [...(helpers.includes("remind") ? [] : ["remind"]), ...(helpers.includes("poll") ? [] : ["poll"]), ...(helpers.includes("links") ? [] : ["link", "links"]), ...(isAdmin ? [] : ["kick"])];
}

// `/kick @nick [reason]`: the nick, without its @, and the rest as the reason.
export function parseKick(argument: string): { nick: string; reason: string } {
  const [rawNick = "", ...rest] = argument.trim().split(/\s+/);
  return { nick: rawNick.replace(/^@/, ""), reason: rest.join(" ").trim() };
}

// The line the channel sees after a kick, sent as an action from the admin so IRC clients show it too.
export function kickNotice(nick: string, channel: string, reason: string): string {
  return `removed ${nick} from ${channel}${reason ? `: ${reason}` : ""}`;
}

// Text to place in the composer when a suggestion is chosen. Argument-taking commands keep a
// trailing space; `/g` Enter therefore becomes `/giphy ` and never sends a literal `/g`.
export function slashSelection(command: SlashCommand): string {
  return command.argument ? `/${command.name} ` : `/${command.name}`;
}

export function unknownCommandMessage(name: string): string {
  return `Unknown command: /${name}. Type / for the list.`;
}

export function commandHelpText(): string {
  return SLASH_COMMANDS.map((command) => `/${command.name} — ${command.description}`).join("\n");
}

if (import.meta.main) {
  const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
  assert(slashSuggestions("/g").map((c) => c.name).join(",") === "giphy", "/g must list only giphy");
  assert(slashSuggestions("/giphy x").length === 0, "a spaced command closes the list");
  assert(slashSelection(BY_NAME.get("giphy")!) === "/giphy ", "argument command fills with a space");
  assert(parseSlash("/help")?.name === "help", "help parses");
  assert(parseSlash("/giphy cats")?.argument === "cats", "argument parses");
  assert(parseSlash("/shrug")?.name === "shrug" && !BY_NAME.has("shrug"), "unknown names still parse so they can error");
  console.log("commands self-check ok");
}
