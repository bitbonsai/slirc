// Help content for the `/help` palette. Command rows are derived from the slash catalog in
// `commands.ts`, so the dialog can never advertise a command the client does not run. One extra
// row opens the docs. Kept as data so the dialog is the same search-and-pick surface as the thread
// palette.
import { SLASH_COMMANDS } from "@client/commands.ts";

export interface HelpTopic {
  command: string;
  description: string;
  /** When set the row opens a URL instead of inserting into the composer. */
  url?: string;
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  ...SLASH_COMMANDS.map((command) => ({ command: `/${command.name}${command.argument ? " …" : ""}`, description: command.description })),
  { command: "Open the help pages", description: "guides for using Slirc.", url: "/docs" },
];

const FOLD = (value: string): string => value.trim().toLowerCase();

export function filterHelpTopics(topics: readonly HelpTopic[], query: string): HelpTopic[] {
  const needle = FOLD(query);
  if (!needle) return [...topics];
  return topics.filter((topic) => `${topic.command} ${topic.description}`.toLowerCase().includes(needle));
}

/** The token to place in the composer for a command row, or null for docs rows. */
export function helpInsert(topic: HelpTopic): string | null {
  if (topic.url || !topic.command.startsWith("/")) return null;
  const token = topic.command.slice(1).split(/[\s<[(]/)[0];
  return token ? `/${token} ` : null;
}

if (import.meta.main) {
  const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
  const names = new Set(SLASH_COMMANDS.map((command) => command.name));
  for (const topic of HELP_TOPICS) {
    if (!topic.command.startsWith("/")) continue;
    const token = topic.command.slice(1).split(/[\s<[(]/)[0]!;
    assert(names.has(token), `help advertises /${token} but it is not in SLASH_COMMANDS`);
  }
  const giphy = HELP_TOPICS.find((topic) => topic.command.startsWith("/giphy"));
  assert(giphy && helpInsert(giphy) === "/giphy ", "/giphy row inserts the command");
  assert(helpInsert(HELP_TOPICS.at(-1)!) === null, "docs row does not insert");
  assert(filterHelpTopics(HELP_TOPICS, "gif").length === 1, "filters by description");
  assert(filterHelpTopics(HELP_TOPICS, "").length === HELP_TOPICS.length, "empty query keeps all rows");
  console.log("help self-check ok");
}
