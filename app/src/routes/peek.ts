import { createLimiter, peerKey } from "../request-security.ts";
import { createPeek, type PeekMessage, peekable } from "../peek.ts";
import { polls } from "./polls.ts";
import { enabledHelpers } from "../config.ts";
import { pollById, pollView } from "../polls.ts";
import { normalized } from "../rooms.ts";
import { embeds, embedCache } from "./embeds.ts";
import { text } from "../http/common.ts";
import { avatarVersion, knownAccount } from "../http/profiles.ts";
import { db } from "../db.ts";
import { Hono } from "hono";

export const peekRoutes = new Hono();

// Signed-out preview of #open-chat on the public playground (peek.ts). Any other channel, and
// every channel on a private workspace, is not found, signed in or not.
const peekLimit = createLimiter({ limit: 120, windowMs: 10 * 60_000 });

const peek = createPeek();

// Folded nicks of the authors in the last peek answer: a signed-out visitor may load their avatars
// and nobody else's, so /avatars never becomes a directory of the instance.
export let peekAuthors = new Set<string>();

const PEEK_URL = /https?:\/\/[^\s<>"]+/g;

// What the transcript needs beyond the text, read only from what the server already holds: the
// poll cards' counts (no voter names, no "mine"), link previews a member already fetched, and the
// photo version of each author who has one.
function peekExtras(channel: string, messages: PeekMessage[]) {
  const polls: Record<number, unknown> = {};
  if (enabledHelpers().includes("poll")) {
    for (const message of messages) {
      if (message.poll?.kind !== "card" || message.nick.toLowerCase() !== "poll") continue;
      const poll = pollById(message.poll.id);
      if (!poll || normalized(poll.channel) !== channel) continue;
      const view = pollView(poll, "", false);
      polls[poll.id] = { ...view, mine: [], options: view.options.map(({ label, count }) => ({ label, count })) };
    }
  }
  const embeds: Record<string, Record<string, string>> = {};
  for (const message of messages) {
    for (const found of message.text.match(PEEK_URL) ?? []) {
      for (const url of new Set([found, found.replace(/[).,!?:;'\]]+$/, "")])) {
        let href = url;
        try { href = new URL(url).href; } catch { continue; }
        const meta = embedCache.get(href) ?? embedCache.get(url);
        if (meta && Object.keys(embeds).length < 32) embeds[url] = meta;
      }
    }
  }
  const avatars: Record<string, number> = {};
  for (const nick of new Set(messages.map((message) => message.nick))) {
    const version = avatarVersion(db.query("SELECT avatar_path, avatar_version FROM profiles WHERE account = ?").get(knownAccount(nick) || nick) as { avatar_path: string | null; avatar_version: number | null } | null);
    if (version) avatars[nick.toLowerCase()] = version;
  }
  return { polls, embeds, avatars };
}

peekRoutes.get("/api/peek/:channel", async (c) => {
  c.header("Cache-Control", "no-store");
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  if (!peekable(channel)) return c.json({ error: "channel not found" }, 404);
  if (!peekLimit.check(peerKey(c))) return c.json({ error: "Too many requests. Try again later." }, 429);
  try {
    const messages = (await peek(channel)) ?? [];
    peekAuthors = new Set(messages.map((message) => message.nick.toLowerCase()));
    return c.json({ channel, messages, ...peekExtras(channel, messages) });
  } catch (error) {
    console.error(`peek failed for ${channel}:`, error instanceof Error ? error.message : error);
    return c.json({ error: "Could not load messages." }, 503);
  }
});
