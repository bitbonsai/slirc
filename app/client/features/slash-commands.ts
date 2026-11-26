import { emojiText } from "@client/emoji.ts";
import { conversationId, foldIdentifier, type Message } from "@client/model.ts";
import { kickNotice, parseKick, slashCommand, slashSelection, type SlashCommand, unknownCommandMessage } from "@client/commands.ts";
import { randomId } from "@client/protocol.ts";
import { validSignInEmail } from "@client/pairing.ts";
import { threadForRoot, threadSourceUrl } from "@client/threads.ts";
import { queuedTextFor } from "@client/drafts.ts";
import { addressIn } from "@client/links-query.ts";
import { remindResult } from "@client/reminder-notice.ts";
import type { createComposerEditor } from "@client/composer-editor.ts";
import type { createGiphyPicker } from "@client/giphy-picker.ts";
import type { createAddPrompts } from "@client/add-prompts.ts";
import type { createLinksView } from "@client/links-view.ts";
import type { createPolls } from "@client/polls.ts";
import type { createEmojiPicker } from "@client/emoji-picker.ts";
import type { createMessageActions } from "@client/message-actions.ts";
import type { createNavigation } from "@client/navigation.ts";
import type { createPeopleCard } from "@client/people-card.ts";
import type { createTranscript } from "@client/transcript.ts";
import type { createView } from "@client/view.ts";
import type { AuthorizedConversation } from "@client/sync.ts";
import type { ReplyThreadSummary } from "@client/reply-threads.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface SlashCommandsDeps {
  state: Pick<RuntimeState, "authorized" | "composer" | "navIntent" | "outbox" | "roomId" | "scope">;
  ui: Pick<ClientState, "account" | "authenticated" | "composer" | "contacts" | "directs" | "helpers" | "isAdmin" | "linksHome" | "note" | "openRooms" | "pendingThread" | "replyThreadRootId" | "sendError" | "threadCommandBusy" | "threadError" | "threads">;
  nav: ReturnType<typeof createNavigation>;
  transcript: () => ReturnType<typeof createTranscript>;
  editor: () => ReturnType<typeof createComposerEditor>;
  giphy: () => ReturnType<typeof createGiphyPicker>;
  addPrompts: () => ReturnType<typeof createAddPrompts>;
  library: () => ReturnType<typeof createLinksView>;
  polls: () => ReturnType<typeof createPolls>;
  emoji: () => ReturnType<typeof createEmojiPicker>;
  actions: () => ReturnType<typeof createMessageActions>;
  people: () => ReturnType<typeof createPeopleCard>;
  openHelpDialog: () => void;
  reconnect: () => void;
  logout: () => Promise<void>;
  activeConversation: () => AuthorizedConversation | undefined;
  isGroupRoom: (wireTarget: string) => boolean;
  openRoom: (room?: string) => void;
  send: () => Promise<void>;
  loadRoomMembers: (item: AuthorizedConversation | undefined, id: string | null) => void;
  connect: () => Promise<void>;
  openDirect: (nick: string) => Promise<void>;
  replyThreadSummaryFor: (message: Message | null | undefined) => ReplyThreadSummary | null;
  currentParentWire: () => string;
  openThreadForMessage: (message: Message) => Promise<void>;
}

export function createSlashCommands(deps: SlashCommandsDeps) {
  const { state: rs, ui, nav, transcript, editor, giphy, addPrompts, library, polls, emoji, actions, people, openHelpDialog, reconnect, logout, activeConversation, isGroupRoom, openRoom, send, loadRoomMembers, connect, openDirect, replyThreadSummaryFor, currentParentWire, openThreadForMessage } = deps;

  // Completions (slash command, mention, help topic) replace the text and must leave the caret at
  // the end. Render now: left to the composer's x-effect, the re-render restores the old caret offset
  // ("/gi|phy ", "@remi|nd "), and this way it finds nothing to change.
  function replaceComposerText(text: string): void {
    ui.composer = text;
    if (!ui.pendingThread) rs.composer?.edit(text);
    editor().syncComposerEditor();
    editor().resizeComposer();
    const input = document.querySelector<HTMLElement>("#input");
    if (input) editor().focusComposerAtEnd(input);
    else editor().focusComposer();
  }

  function chooseCommand(command: SlashCommand): void {
    if (command.argument || ui.pendingThread) {
      replaceComposerText(slashSelection(command));
      return;
    }
    ui.composer = "";
    rs.composer?.edit("");
    void runSlash({ name: command.name, argument: "" });
  }

  function chooseCommandByName(name: string): void {
    const command = slashCommand(name);
    if (command) chooseCommand(command);
  }

  // Command and input feedback is an auto toast; connection and delivery errors stay in the banner.
  function hint(text: string): void {
    ui.note = text;
  }

  async function runSlash(input: { name: string; argument: string }): Promise<void> {
    switch (input.name) {
      case "help":
        openHelpDialog();
        return;
      case "reconnect":
        reconnect();
        return;
      case "leave":
        void logout();
        return;
      case "whois":
        if (!input.argument) { hint("Who should I look up? Try /whois nick."); return; }
        people().openWhois(input.argument.split(/\s+/)[0]!);
        return;
      case "giphy":
        if (!input.argument) { hint("Add a search term, like /giphy cats."); return; }
        await giphy().searchGiphy(input.argument);
        return;
      case "me":
        if (!input.argument) { hint("What should the action say? Try /me waves."); return; }
        if (!rs.roomId) { hint("Open a conversation first."); return; }
        try { await queueConversationText(rs.roomId, `\x01ACTION ${input.argument}\x01`); }
        catch (error) { ui.sendError = error instanceof Error ? error.message : "Could not send that action."; }
        return;
      case "msg":
        if (!input.argument) { hint("Who should I message? Try /msg nick hello."); return; }
        await runMsg(input.argument);
        return;
      case "invite": {
        const item = activeConversation();
        if (!item || item.kind !== "room" || isGroupRoom(item.wireTarget)) {
          hint("Open a channel to invite someone.");
          return;
        }
        const target = input.argument.trim().split(/\s+/)[0] ?? "";
        if (validSignInEmail(target)) { void addPrompts().offerEmail({ conversationId: item.conversationId, channel: item.wireTarget, email: target }); return; }
        if (!target) { hint("Who should I add? Try /invite @nick or /invite name@example.com."); return; }
        void addPrompts().offer({ conversationId: item.conversationId, channel: item.wireTarget, place: "channel", nick: target, announce: true });
        return;
      }
      case "kick":
        await runKick(input.argument);
        return;
      case "link": {
        const url = addressIn(input.argument);
        const target = rs.authorized.find((entry) => entry.kind === "room" && entry.wireTarget.toLowerCase() === ui.linksHome);
        if (!ui.linksHome || !ui.helpers.includes("links")) { hint(unknownCommandMessage(input.name)); return; }
        if (!url) { hint("Which link? Try /link https://example.com/article."); return; }
        if (!target) { hint(`Join ${ui.linksHome} to save links there.`); return; }
        try { await queueConversationText(target.conversationId, input.argument); ui.note = `Saved to ${ui.linksHome}.`; }
        catch (error) { ui.sendError = error instanceof Error ? error.message : "Could not save that link."; }
        return;
      }
      case "links": {
        if (!ui.linksHome || !ui.helpers.includes("links")) { hint(unknownCommandMessage(input.name)); return; }
        if (!rs.authorized.some((entry) => entry.kind === "room" && entry.wireTarget.toLowerCase() === ui.linksHome)) { hint(`Join ${ui.linksHome} to search links.`); return; }
        library().openWith(input.argument);
        openRoom(ui.linksHome);
        return;
      }
      case "threads":
        ui.threadCommandBusy = true;
        try { await runThreads(input.argument); }
        finally { ui.threadCommandBusy = false; }
        return;
      case "poll": {
        if (!ui.helpers.includes("poll")) { hint(unknownCommandMessage(input.name)); return; }
        // Bare `/poll` opens the dialog in a channel; elsewhere it explains where polls go.
        if (!input.argument) {
          if (polls().canCreate()) polls().openDialog(document.querySelector("#input"));
          else hint("Polls work in channels. Open one and try /poll again.");
          return;
        }
        // `/poll …` is the same as typing `@poll …`: it posts in the channel (a vote stays private), a
        // poll the helper would refuse opens the dialog, and the usual note offers to add @poll when
        // it isn't in the channel yet.
        ui.composer = `@poll ${input.argument}`;
        rs.composer?.edit(ui.composer);
        await send();
        return;
      }
      case "remind":
        if (!input.argument) { hint("When should I remind you? Try /remind in 20m stretch."); return; }
        await runRemind(input.argument);
        return;
      default:
        hint(unknownCommandMessage(input.name));
    }
  }

  // `/kick @nick [reason]`: the server checks admin rights, kicks on IRC, drops the invite exception
  // and the membership row. Then the channel gets an action line saying who was removed.
  async function runKick(argument: string): Promise<void> {
    if (!ui.isAdmin) { hint("Only admins can kick people from a channel."); return; }
    const item = activeConversation();
    if (!item || item.kind !== "room" || isGroupRoom(item.wireTarget)) { hint("Open a channel to kick someone."); return; }
    if (ui.openRooms[item.wireTarget] === true) { hint(`Everyone belongs to ${item.wireTarget}, so there's no one to kick.`); return; }
    const { nick, reason } = parseKick(argument);
    if (!nick) { hint("Who should I remove? Try /kick @nick reason."); return; }
    if (foldIdentifier(nick) === foldIdentifier(String(ui.account ?? ""))) { hint("You can't kick yourself."); return; }
    if (new TextEncoder().encode(reason).length > 200) { hint("Keep the reason under 200 characters."); return; }
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(item.wireTarget.replace(/^#/, ""))}/kick`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nick, reason }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        const error = typeof body.error === "string" ? body.error : "";
        hint(error === "member not found" ? `@${nick} isn't in ${item.wireTarget}.` : error === "invalid member" ? `Couldn't find @${nick}.` : error || "Could not kick that person.");
        return;
      }
    } catch {
      ui.sendError = "Could not reach the server to kick that person.";
      return;
    }
    if (rs.roomId === item.conversationId) loadRoomMembers(item, rs.roomId);
    try { await queueConversationText(item.conversationId, `\x01ACTION ${kickNotice(nick, item.wireTarget, reason)}\x01`); }
    catch { hint(`Removed ${nick} from ${item.wireTarget}.`); }
  }

  // Queue plain text to a captured conversation through the durable outbox. Used by the commands
  // and Giphy paths, which are not tied to the visible composer draft.
  async function queueConversationText(conversationId: string, text: string, options?: { replyTo?: string; broadcast?: boolean }): Promise<void> {
    if (!rs.outbox || !rs.scope) throw new Error("Messaging is not ready yet. Reconnect and try again.");
    const queued = queuedTextFor(conversationId, rs.scope.account, { text: emojiText(text, emoji().custom), revision: randomId() }, randomId(), Date.now(), undefined, undefined, options?.replyTo, options?.broadcast);
    await rs.outbox.enqueueText(queued);
  }

  // `/remind` sets the reminder through the app and shows remind's confirmation as a notice here.
  // The reminder itself fires in the remind DM, never in a channel. A list opens that DM instead.
  async function runRemind(argument: string, fireAt?: number): Promise<void> {
    try {
      const response = await fetch("/api/reminders", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Slirc-Remind": "1" },
        body: JSON.stringify({ text: argument, fireAt }),
      });
      const body = await response.json().catch(() => ({})) as { reply?: unknown; open?: unknown; error?: unknown };
      const result = response.ok ? remindResult(body) : null;
      const hasDirect = (nick: string) => ui.directs.some((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
      if (result && "open" in result) {
        if (!hasDirect(result.open)) await connect();
        await openDirect(result.open);
      } else if (result) {
        ui.note = result.note;
        // A first reminder opens the remind DM on the server; refresh the grant so it fires here live.
        if (!hasDirect("remind")) void connect();
      } else if (response.status === 400 && typeof body.error === "string") hint(body.error);
      else ui.sendError = typeof body.error === "string" ? body.error : "Could not set the reminder.";
    } catch {
      ui.sendError = "Could not reach the server to set the reminder.";
    }
  }

  async function runPollVote(channel: string, option: number): Promise<void> {
    try {
      const response = await fetch("/api/polls/vote", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Slirc-Poll": "1" },
        body: JSON.stringify({ channel, option }),
      });
      const body = await response.json().catch(() => ({})) as { reply?: unknown; error?: unknown };
      if (typeof body.reply === "string") hint(body.reply);
      else ui.sendError = typeof body.error === "string" ? body.error : "Could not count that vote.";
    } catch {
      ui.sendError = "Could not reach the server to count that vote.";
    }
  }

  // Absolute, so the link in a reminder also opens from an IRC client.
  function messageLink(message: Message, thread = false): string {
    const item = activeConversation();
    const wire = item?.wireTarget ?? "";
    const nick = item?.kind === "dm" ? (ui.directs.find((entry: any) => entry.channel === wire)?.nick ?? wire.replace(/^#dm-/, "")) : "";
    return new URL(threadSourceUrl(item?.kind === "dm" ? "dm" : "room", wire, nick, message.serverId ?? "", thread), location.origin).href;
  }

  // Copy link in the message menu. A message that starts a reply thread, or has its thread open, links to the thread.
  async function copyMessageLink(message: Message): Promise<void> {
    actions().closeActions();
    if (!message.serverId) return;
    const url = messageLink(message, !!replyThreadSummaryFor(message) || message.serverId === ui.replyThreadRootId);
    try { await navigator.clipboard.writeText(url); hint("Link copied"); }
    catch { hint("Could not copy the link."); }
  }

  async function runThreads(reply: string): Promise<void> {
    const item = activeConversation();
    const parent = currentParentWire();
    if (!item || item.kind === "thread" || !parent) {
      ui.threadError = "Open a room or DM to start a thread.";
      return;
    }
    const root = [...transcript().displayedMessages()].reverse().find((message: Message) => message.state === "confirmed" && message.serverId);
    if (!root) {
      ui.threadError = "Send a message first to start a thread.";
      return;
    }
    await openThreadForMessage(root);
    if (!reply.trim()) return;
    const thread = threadForRoot(ui.threads, parent, root.serverId);
    const conversation = thread && rs.authorized.find((entry) => entry.conversationId === thread.conversationId);
    if (conversation) {
      try { await queueConversationText(conversation.conversationId, reply.trim()); }
      catch { ui.sendError = "Could not save that thread reply. It is still in your box."; }
      return;
    }
    if (root.serverId && rs.roomId) {
      try { await queueConversationText(rs.roomId, reply.trim(), { replyTo: root.serverId }); }
      catch { ui.sendError = "Could not save that thread reply. It is still in your box."; }
    }
  }

  async function runMsg(argument: string): Promise<void> {
    const [rawNick, ...rest] = argument.split(/\s+/);
    const nick = (rawNick ?? "").replace(/^@/, "");
    const text = rest.join(" ").trim();
    if (!nick) { hint("Who should I message?"); return; }
    let direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
    if (!direct) {
      const contact = ui.contacts.some((item: string) => foldIdentifier(item) === foldIdentifier(nick));
      if (!contact) { hint(`No contact named @${nick}.`); return; }
      await openDirect(nick);
      if (!ui.authenticated) return;
      direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
    }
    if (!direct) { ui.sendError = `Could not open a direct message with @${nick}.`; return; }
    if (!text) return;
    const conversation = rs.authorized.find((item) => item.kind === "dm" && item.wireTarget === direct.channel);
    if (!conversation) { ui.sendError = `@${nick} is not reachable right now.`; return; }
    ui.sendError = "";
    try {
      await queueConversationText(conversation.conversationId, text);
      rs.navIntent += 1;
      nav.open({ kind: "dm", nick: direct.nick });
    } catch {
      ui.sendError = "Could not save that message. It is still in your box.";
    }
  }

  return { replaceComposerText, chooseCommand, chooseCommandByName, hint, runSlash, queueConversationText, runRemind, runPollVote, messageLink, copyMessageLink };
}
