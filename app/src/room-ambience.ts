import { db } from "./db.ts";
import type { ParsedMessage } from "./irc.ts";
import { isDailyGreeting } from "../shared/service-bots.ts";
import { openRoom } from "./welcome.ts";

// The public room should never look abandoned to someone reading it for the first time, and it
// should never be faked. `welcome`, labelled as a bot in the app, keeps it alive with one true line
// a day and a gif with it when Giphy is configured. Everything here is pure except the meta stamp,
// so the schedule survives restarts and a redeploy never posts twice. helper-bot.ts owns the socket.

export const NOTE_HOUR = 9;

export const enabled = () => process.env.SLIRC_ROOM_AMBIENCE !== "false";

// Local calendar day and ISO-ish week, in the instance TZ (the container sets TZ=Europe/Amsterdam).
export function dayKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const stamp = (key: string) => (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
const mark = (key: string, value: string) => db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

export const lastNoteDay = () => stamp("ambience:note-day");
export const markNote = (now = Date.now()) => mark("ambience:note-day", dayKey(now));

export function dueNote(now = Date.now(), last = lastNoteDay()): boolean {
  return new Date(now).getHours() >= NOTE_HOUR && last !== dayKey(now);
}

export const welcomeNote = (room = openRoom()) => `Welcome to ${room}. This room is public, so anyone can read along. Sign in with your email to say hi.`;
export const noteLine = (room = openRoom()) => welcomeNote(room);

// The gif search of the day. Friday is always the same one; the rest rotate.
export const GIF_QUERIES = ["good morning coffee", "typing fast", "ship it", "high five", "small victory", "tuesday", "cat keyboard"];
export function dayIndex(now = Date.now()): number {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}
export function gifQuery(now = Date.now()): string {
  return new Date(now).getDay() === 5 ? "never gonna give you up" : GIF_QUERIES[dayIndex(now) % GIF_QUERIES.length];
}
// Same shape the PWA posts from /giphy, so it renders as an inline image with the search as caption.
export const gifLine = (query: string, url: string) => `[Giphy: ${query}] ${url}`;

// Only one daily gif stays in the room. When Ergo echoes welcome's new gif line, the previous
// one's msgid comes out of meta and gets a native REDACT, the same delete a person sends for their
// own message, so every client and the history drop it. Greetings and other people's lines never match.
const gifKey = (channel: string) => `ambience:gif-msgid:${channel.toLowerCase()}`;
const nickOf = (prefix = "") => prefix.split("!", 1)[0];

export function isWelcomeGif(message: ParsedMessage): boolean {
  const [target = "", text = ""] = message.params;
  const account = message.tags.account;
  return message.command === "PRIVMSG" && target.startsWith("#") && !!message.tags.msgid
    && isDailyGreeting(nickOf(message.prefix), text) && (!account || account.toLowerCase() === "welcome");
}

export function replacePreviousGif(message: ParsedMessage, send: (line: string) => unknown): string | null {
  if (!isWelcomeGif(message)) return null;
  const channel = message.params[0];
  const msgid = message.tags.msgid;
  const previous = stamp(gifKey(channel));
  mark(gifKey(channel), msgid);
  if (!previous || previous === msgid) return null;
  send(`REDACT ${channel} ${previous} :replaced by today's gif`);
  return previous;
}

export async function giphyUrl(query: string, apiKey = process.env.GIPHY_API_KEY, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const response = await fetcher(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&limit=1&rating=g`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const data = await response.json() as { data?: { images?: { original?: { url?: string; width?: string; height?: string } } }[] };
    const original = data.data?.[0]?.images?.original;
    const url = original?.url;
    if (typeof url !== "string" || !url.startsWith("https://")) return null;
    // The size rides in the fragment, as the PWA's picker sends it, so clients reserve the box.
    const side = (value: unknown) => typeof value === "string" && /^\d{1,4}$/.test(value) && +value >= 1 && +value <= 8192 ? +value : 0;
    const width = side(original?.width), height = side(original?.height);
    return width && height && !url.includes("#") ? `${url}#w=${width}&h=${height}` : url;
  } catch {
    return null;
  }
}
