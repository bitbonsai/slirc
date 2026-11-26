// First-party service nicks: the instance service account and the helper bots. The one list for
// client presence, server helper bots and the always-on opt-out in grants.ts.
export const SERVICE_NICK = "slirc";
export const HELPER_NICKS = ["help", "remind", "poll", "welcome", "links"] as const;
// Helpers that run only when SLIRC_HELPERS names them; an unset setting leaves them off.
export const OPT_IN_HELPERS: readonly string[] = ["links"];
// Posts the note about what changed after a deploy (src/update-notes.ts); not a running helper.
export const UPDATES_NICK = "updates";
export const SERVICE_BOT_NICKS: readonly string[] = [SERVICE_NICK, ...HELPER_NICKS, UPDATES_NICK];

// The daily G'day: the `welcome` helper's one `[Giphy: query] url` line in the open channel. Its
// newcomer greetings are plain text, and people's own /giphy lines carry their own name.
export const isDailyGreeting = (author: string, text: string) => author.toLowerCase() === "welcome" && /^\[Giphy: /.test(text);
