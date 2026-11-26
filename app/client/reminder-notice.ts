import { type IrcMessage } from "@client/irc.ts";
import { foldIdentifier } from "@client/model.ts";
import { messageLinkLabel } from "@client/navigation.ts";
import { type AuthorizedConversation } from "@client/sync.ts";

// A sticky toast: no timer, stays until the person takes its action or dismisses it. Auto notes
// (`note`) are separate state, so a quick notice can never replace or push this one away.
export interface StickyNote {
  id: string;
  text: string;
  action: string;
  conversationId: string;
  /** A message on this instance the reminder points at; the action opens it instead of the DM. */
  href?: string;
  /** Sprite icon; the bell when absent. The update toast's refresh also gives it the dark HUD look. */
  icon?: "bell" | "refresh";
}

export interface ReminderNoticeOptions {
  core: { stickies: StickyNote[] };
  /** True when this conversation is the one on screen; no toast for what the person is reading. */
  onScreen: (conversationId: string) => boolean;
  /** Navigate to the DM with this helper nick. */
  open: (nick: string) => void;
  /** Open a message link on this instance in place. */
  openLink: (href: string) => void;
  /** This instance's origin, to tell its message links from other URLs. */
  origin: string;
  helper?: string;
}

// What the app does with a POST /api/reminders answer: a list opens the remind DM, where remind
// posts it; anything else is a notice where the person typed. Null means no usable answer.
export function remindResult(body: { reply?: unknown; open?: unknown }): { open: string } | { note: string } | null {
  if (typeof body.open === "string" && body.open) return { open: body.open };
  return typeof body.reply === "string" ? { note: body.reply } : null;
}

// Same bare-link token the transcript renders; long enough for a short quote in one or two lines.
const URL_TOKEN = /https?:\/\/[^\s<>"']+/g;
const TOAST_LENGTH = 60;

// A fired reminder as toast copy rather than the IRC line. The bell says it is a reminder, so the
// sender goes; a remembered message drops its `> ` marker for typographic quotes. A link to a message
// here becomes the action label, and any other URL shortens to its host so the text stays readable.
export function reminderToast(raw: string, origin: string): { text: string; action: string; href?: string } {
  let href: string | undefined;
  let action = "Open";
  const quoted = raw.startsWith("> ");
  const body = (quoted ? raw.slice(2) : raw).replace(URL_TOKEN, (url) => {
    const label = messageLinkLabel(url, origin);
    if (label) {
      if (!href) { href = url; action = label; }
      return "";
    }
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }).replace(/\s+/g, " ").trim();
  const clipped = body.length > TOAST_LENGTH ? `${body.slice(0, TOAST_LENGTH - 1).trimEnd()}…` : body;
  const text = !clipped ? "Reminder" : quoted ? `Reminder: “${clipped}”` : `Reminder: ${clipped}`;
  return { text, action, ...(href ? { href } : {}) };
}

// Fired reminders arrive as a live line from the remind account in the person's DM with it. Fed
// only from the sync live hook, which history pages never reach, so backfill on boot or reconnect
// shows nothing. Seen message ids keep a duplicate delivery from raising a second toast.
export function createReminderNotice(options: ReminderNoticeOptions) {
  const helper = foldIdentifier(options.helper ?? "remind");
  const seen = new Set<string>();
  const nicks = new Map<string, string>();

  function observe(conversation: AuthorizedConversation, message: IrcMessage): void {
    if (message.command !== "PRIVMSG" || conversation.kind !== "dm") return;
    const account = String(message.tags.account ?? "").trim();
    if (foldIdentifier(account) !== helper) return;
    const id = String(message.tags.msgid ?? "");
    const text = String(message.params[1] ?? "").trim();
    if (!id || !text || seen.has(id)) return;
    seen.add(id);
    if (options.onScreen(conversation.conversationId)) return;
    nicks.set(id, account);
    // Newest first; several reminders stack instead of replacing each other.
    options.core.stickies = [{ id, ...reminderToast(text, options.origin), conversationId: conversation.conversationId }, ...options.core.stickies];
  }

  // Open goes to that toast's DM and clears every toast for it: they are all read there. A toast
  // with a message link opens that message instead and clears only itself.
  function open(id: string): void {
    const item = options.core.stickies.find((entry) => entry.id === id);
    if (!item) return;
    if (item.href) {
      dismiss(id);
      options.openLink(item.href);
      return;
    }
    options.core.stickies = options.core.stickies.filter((entry) => entry.conversationId !== item.conversationId);
    options.open(nicks.get(id) ?? helper);
  }

  function dismiss(id: string): void {
    options.core.stickies = options.core.stickies.filter((entry) => entry.id !== id);
  }

  function dismissAll(): void {
    options.core.stickies = [];
  }

  // Opening the DM some other way also answers its toasts.
  function viewed(conversationId: string | null): void {
    if (options.core.stickies.some((entry) => entry.conversationId === conversationId)) {
      options.core.stickies = options.core.stickies.filter((entry) => entry.conversationId !== conversationId);
    }
  }

  function reset(): void {
    seen.clear();
    nicks.clear();
    options.core.stickies = [];
  }

  return { observe, open, dismiss, dismissAll, viewed, reset };
}
