// What a message row needs beyond its text: the avatar colour, and the labels and cards its media
// and link previews draw. The transcript row and the thread panel read all of it from here, so
// the markup in partials/message-body.html, message-media.html and message-embeds.html stays
// declarative.

import { WORKSPACE_PALETTE } from "@client/workspace-mark.ts";
import type { Message } from "@client/model.ts";

// The workspace palette without its red, so a person's avatar never looks like an error. Every
// avatar colour was one of these before the palette was shared, so nobody's colour moved.
const AVATAR_RED = "#f38ba8";
export const AVATAR_PALETTE = WORKSPACE_PALETTE.filter((color) => color !== AVATAR_RED);

// The account (or nick, for a row without one) picks the colour, the same on every screen.
export function avatarColor(key: string | undefined): string {
  const hash = [...(key || "").toLowerCase()].reduce((value, char) => Math.imul(31, value) + char.charCodeAt(0) | 0, 0) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length]!;
}

export function avatarStyle(key: string | undefined): string {
  return "background:" + avatarColor(key) + ";color:#11111b";
}

export function initial(nick: string | undefined): string {
  return (nick || "?").slice(0, 1).toUpperCase();
}

export function replyCountLabel(count: number): string {
  return count === 1 ? "1 reply" : count + " replies";
}

const PENDING = ["saving", "queued", "sending"];

type Media = { kind: string; url?: string; href: string };
type Segment = { href?: string };
type Embed = { kind?: string; title?: string; description?: string; image?: string; site?: string };
type Player = { site: string; title: string; thumb: string } | null;

export type PreviewCard = { href: string; title: string; description: string; site: string; image: string };
export type PlayerCard = { href: string; title: string; site: string; thumb: string; youtube: boolean };

export function createMessageView({ embeds, linkSegments, messageText, isGiphyUrl, embedImageUrl, playerCard, isMediaError, redactFor, stampedReaction }: {
  embeds: () => Record<string, Embed | undefined>;
  linkSegments: (text: string) => Segment[];
  messageText: (message: Message) => string;
  isGiphyUrl: (href: string) => boolean;
  embedImageUrl: (url: string) => string;
  playerCard: (href: string) => Player;
  isMediaError: (href: string) => boolean;
  redactFor: (message: Message) => { state: string } | null | undefined;
  stampedReaction: () => string | null | undefined;
}) {
  const hrefs = (message: Message): string[] =>
    linkSegments(messageText(message)).map((segment) => segment.href ?? "");

  return {
    avatarStyle,
    initial,
    replyCountLabel,
    isPending: (message: Message) => PENDING.includes(message.state as string),

    // The aria label of the toggle above a photo, GIF or video, and of the photo button itself.
    toggleLabel: (media: Media) => media.kind === "giphy" ? "Toggle GIF" : media.kind === "video" ? "Toggle video" : "Toggle image",
    openLabel: (media: Media) => media.kind === "giphy" ? "Open GIF" : "Open photo",
    // The address stays hidden unless the proxied image failed to load.
    showsFallback: (media: Media) => media.kind === "image" && !!media.url && isMediaError(media.href),

    // Cards for links with a stored preview that is neither a photo nor a player.
    previewCards(message: Message): PreviewCard[] {
      const stored = embeds();
      const cards: PreviewCard[] = [];
      for (const href of hrefs(message)) {
        const embed = stored[href];
        if (!href || isGiphyUrl(href) || embed?.kind === "image" || playerCard(href)) continue;
        if (!embed || !(embed.title || embed.description || embed.image || embed.site)) continue;
        let host = "";
        try { host = new URL(href).hostname; } catch { /* keep the card without a host */ }
        cards.push({ href, title: embed.title || href, description: embed.description || "", site: embed.site || host, image: embed.image ? embedImageUrl(embed.image) : "" });
      }
      return cards;
    },
    showsCardImage: (card: PreviewCard) => !!card.image && !isMediaError(card.image),

    // Cards for links that open in the player (YouTube, audio and video hosts).
    playerCards(message: Message): PlayerCard[] {
      const cards: PlayerCard[] = [];
      for (const href of hrefs(message)) {
        const card = href ? playerCard(href) : null;
        if (card) cards.push({ href, title: card.title, site: card.site, thumb: card.thumb, youtube: card.site === "YouTube" });
      }
      return cards;
    },

    chipClass: (message: Message, chip: { mine?: boolean; emoji: string }) =>
      [chip.mine && "mine", stampedReaction() === message.serverId + ":" + chip.emoji && "stamp"],
    canRetryRedact(message: Message): boolean {
      const state = redactFor(message)?.state;
      return state === "failed" || state === "uncertain";
    },
    retryRedactLabel: (message: Message) => redactFor(message)?.state === "uncertain" ? "Resend delete" : "Retry delete",
  };
}
