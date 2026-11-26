import { foldIdentifier } from "@client/model.ts";
import { type ClientSession } from "@client/client-state.ts";

// Inline "Add / Dismiss" note, Slack style: under a message that mentioned a helper or a person who
// isn't in the conversation, or at the end of the transcript for `/invite @nick` and
// `/invite name@example.com`. It is local to this tab, never sent over IRC and never stored. Add runs
// the members route, which enforces the same rule as the lookup that decided to offer it; an email
// note sends the same invitation as the new conversation dialog. A helper added from a mention
// answers that message itself, server-side, so nothing is sent twice.
export type AddPromptPlace = "channel" | "group" | "dm" | "thread";
export interface AddPrompt {
  id: string;
  conversationId: string;
  channel: string;
  messageId: string | null;
  nick: string;
  /** Set on an email invitation note; `nick` then holds the address. */
  email?: string;
  place?: AddPromptPlace;
  /** One of your own agents, mentioned in a channel it can't answer in. Invite adds it there. */
  agent?: boolean;
  state: "ask" | "busy" | "done";
  text: string;
}

// Helpers that answer a mention in any room they were added to. `welcome` only greets in the open room.
// remind is left out: a message that starts with @remind becomes a private /remind, and reminders
// fire in the remind DM, so the helper never needs to join a channel.
const PROMPT_HELPERS = ["poll", "help"];
const NICK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// Bots that never get a person note; the server's kind check catches any other bot or agent.
const QUIET_BOTS = [...PROMPT_HELPERS, "remind", "welcome", "slirc"];

export function mentionedHelpers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z]+)(?=$|[^A-Za-z0-9_])/g)) {
    const nick = match[1]!.toLowerCase();
    if (PROMPT_HELPERS.includes(nick)) found.add(nick);
  }
  return [...found];
}

// Everyone else @mentioned. Unknown nicks, bots and members stay quiet after the lookup in offer().
export function mentionedPeople(text: string): string[] {
  const found = new Map<string, string>();
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9_-]{0,31})(?=$|[^A-Za-z0-9_@-])/g)) {
    const nick = match[1]!;
    if (!QUIET_BOTS.includes(nick.toLowerCase())) found.set(foldIdentifier(nick), nick);
  }
  return [...found.values()];
}

const sentence = (text: string) => { const value = text.trim(); return value ? `${value[0]!.toUpperCase()}${value.slice(1)}${/[.!?]$/.test(value) ? "" : "."}` : ""; };

export function createAddPrompts(reactive: <T extends object>(value: T) => T, { session, self, serverIdFor, nextTick, reveal, restoreFocus }: {
  session: ClientSession;
  self: () => string;
  /** Server msgid of a sent message once the server confirmed it. */
  serverIdFor: (messageId: string) => string | undefined;
  nextTick: (callback?: () => void) => Promise<void>;
  /** Keep a new note in view: always for a note you asked for (/invite), only when pinned for one under a message. */
  reveal: (force: boolean) => void;
  /** Hand focus back to the composer when the control that held it disappears. */
  restoreFocus: () => void;
}) {
  const local = reactive({ items: [] as AddPrompt[] });
  let next = 0;
  const inScope = (key: string) => session.key() === key && !session.stopped();

  function forMessage(messageId: string): AddPrompt[] { return local.items.filter((item) => item.messageId === messageId); }
  function forEnd(conversationId: string): AddPrompt[] { return local.items.filter((item) => item.messageId === null && item.conversationId === conversationId); }

  function show(prompt: Omit<AddPrompt, "id">): void {
    const same = (item: AddPrompt) => item.conversationId === prompt.conversationId && item.messageId === prompt.messageId && foldIdentifier(item.nick) === foldIdentifier(prompt.nick);
    local.items = [...local.items.filter((item) => !same(item)), { ...prompt, id: `add-prompt-${++next}` }];
    const force = prompt.messageId === null;
    const frame = globalThis.requestAnimationFrame ?? ((callback: () => void) => setTimeout(callback, 0));
    void nextTick(() => frame(() => reveal(force)));
  }

  function update(id: string, patch: Partial<AddPrompt>): void {
    const item = local.items.find((entry) => entry.id === id);
    if (item) Object.assign(item, patch);
  }

  // `announce` is for /invite: say when someone is already here or can't be found. A mention stays
  // quiet unless there is something to add. `person` is a human mention: bots and agents stay quiet.
  // The note names the room: a channel by its #name, a group by `title` when it has one.
  async function offer({ conversationId, channel, place, title, nick: rawNick, messageId = null, announce, person = false }: {
    conversationId: string; channel: string; place: AddPromptPlace; title?: string; nick: string; messageId?: string | null; announce: boolean; person?: boolean;
  }): Promise<void> {
    const nick = rawNick.replace(/^@/, "");
    const where = place === "group" ? title || "this group" : channel;
    const base = { conversationId, channel, messageId, nick, place, state: "done" as const };
    if (place === "dm" || place === "thread") { show({ ...base, text: `${nick} can't join ${place === "dm" ? "DMs" : "threads"}.` }); return; }
    if (!NICK.test(nick)) { if (announce) show({ ...base, text: `Couldn't find @${nick}.` }); return; }
    if (foldIdentifier(nick) === foldIdentifier(self())) { if (announce) show({ ...base, text: `You're already in ${where}.` }); return; }
    const key = session.key();
    let response: Response;
    let body: Record<string, any> = {};
    try {
      response = await fetch(`/api/channels/${encodeURIComponent(channel)}/members/${encodeURIComponent(nick)}`, { credentials: "same-origin", cache: "no-store" });
      body = await response.json().catch(() => ({}));
    } catch {
      if (inScope(key) && announce) show({ ...base, text: `Couldn't check @${nick}. Try again.` });
      return;
    }
    if (!inScope(key)) return;
    const name = typeof body.nick === "string" ? body.nick : nick;
    if (response.ok && body.member === true) { if (announce) show({ ...base, nick: name, text: `${name} is already in ${where}.` }); return; }
    // Your own agent answers only in its DM or an invite-only channel it is in, so a mention anywhere
    // else would be dropped without a word. The lookup hides other people's agents (404), so they stay quiet.
    if (person && !announce && place === "channel") {
      if (response.ok && body.kind === "agent") { show({ ...base, nick: name, agent: true, state: "ask", text: `${name} isn't in this channel yet. This agent can read the channel's full history.` }); return; }
      if (response.status === 403 && body.error === "agents can only join secret channels") { show({ ...base, agent: true, text: `${nick} only answers in its DM or in invite-only channels.` }); return; }
    }
    // The lookup checks the sender before the target, so a 403 about agents is the only one that names who was mentioned.
    if (person && (response.ok ? body.kind !== "human" : response.status !== 403 || /agent/i.test(String(body.error)))) return;
    // An agent reads a channel the way a person does, past messages included: say so before it is added.
    const since = body.kind === "agent" ? " This agent can read the channel's full history." : "";
    if (response.ok) { show({ ...base, nick: name, state: "ask", text: announce ? `Add @${name} to ${where}?${since}` : `@${name} isn't in ${where}.${since}` }); return; }
    if (response.status === 404 && body.error === "person not found") { if (announce) show({ ...base, text: `Couldn't find @${nick}.` }); return; }
    show({ ...base, text: `@${nick} isn't in ${where}. You can't add people here.` });
  }

  // `/invite name@example.com`: offer the email invitation only when the sender has invites left.
  // Whether the address already has an account stays a server secret until they press the button.
  async function offerEmail({ conversationId, channel, email }: { conversationId: string; channel: string; email: string }): Promise<void> {
    const base = { conversationId, channel, messageId: null, nick: email, email, place: "channel" as const };
    const key = session.key();
    let response: Response | null = null;
    let body: Record<string, any> = {};
    try {
      response = await fetch("/api/invites/email", { credentials: "same-origin", cache: "no-store" });
      body = await response.json().catch(() => ({}));
    } catch { /* The send reports its own error. */ }
    if (!inScope(key)) return;
    if (response?.status === 401 || response?.status === 403) { show({ ...base, state: "done", text: `Verify your email before you invite ${email}.` }); return; }
    if (response?.ok && body.remaining === 0) { show({ ...base, state: "done", text: `You have used all ${body.limit} email invites.` }); return; }
    show({ ...base, state: "ask", text: `Send ${email} an invitation to ${channel}?` });
  }

  // The same request as the new conversation dialog with this channel as the destination.
  async function inviteByEmail(prompt: AddPrompt, email: string): Promise<string> {
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ recipients: [{ email }], destination: { type: "channel", channel: prompt.channel } }),
      });
      const body = await response.json().catch(() => ({}));
      const outcome = Array.isArray(body.recipients) ? body.recipients[0] ?? {} : {};
      if (outcome.status === "invited") return `Invitation sent to ${email}.`;
      if (outcome.status === "added") return `Added @${outcome.nick}.`;
      if (outcome.status === "existing") return `@${outcome.nick} is already here.`;
      if (outcome.status === "uncertain") return `Couldn't confirm the invitation to ${email}. Check Invitations before you resend.`;
      return sentence(String(outcome.error || body.error || "")) || `Couldn't invite ${email}.`;
    } catch {
      return `Couldn't invite ${email}. Check your connection.`;
    }
  }

  // A mention prompt waits for the server to confirm the message, so the helper can find it.
  function canAdd(prompt: AddPrompt): boolean {
    return prompt.state === "ask" && (!prompt.messageId || !!serverIdFor(prompt.messageId));
  }

  function label(prompt: AddPrompt): string {
    if (prompt.email) return prompt.state === "busy" ? "Sending…" : "Invite by email";
    if (prompt.state === "busy") return prompt.agent ? "Inviting…" : "Adding…";
    return prompt.agent ? "Invite" : "Add";
  }

  async function add(prompt: AddPrompt): Promise<void> {
    if (!canAdd(prompt)) return;
    if (prompt.email) {
      const key = session.key();
      update(prompt.id, { state: "busy" });
      const text = await inviteByEmail(prompt, prompt.email);
      if (!inScope(key)) return;
      update(prompt.id, { state: "done", text });
      void nextTick(restoreFocus);
      return;
    }
    const key = session.key();
    // The msgid lets a helper answer the line that mentioned it; an agent never answers an old line.
    const msgid = prompt.messageId && !prompt.agent ? serverIdFor(prompt.messageId) : undefined;
    update(prompt.id, { state: "busy" });
    let text: string;
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(prompt.channel)}/members`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nick: prompt.nick, ...(msgid ? { msgid } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) text = sentence(String(body.error || "")) || `Couldn't add ${prompt.nick}.`;
      else text = body.added === false ? `@${prompt.nick} is already here.` : prompt.agent ? `Added @${prompt.nick}. Mention it again to ask.` : `Added @${prompt.nick}.`;
    } catch {
      text = `Couldn't add ${prompt.nick}. Check your connection.`;
    }
    if (!inScope(key)) return;
    update(prompt.id, { state: "done", text });
    void nextTick(restoreFocus);
  }

  function ignore(prompt: AddPrompt): void {
    if (prompt.state === "busy") return;
    local.items = local.items.filter((item) => item.id !== prompt.id);
    void nextTick(restoreFocus);
  }

  function reset(): void { local.items = []; }

  // The note's sentence with the person pulled out, so the markup can show them as avatar + @nick.
  function segments(prompt: AddPrompt): { text?: string; nick?: string }[] {
    // Someone we could not find gets no avatar chip: the note only repeats what was typed. Neither does an address.
    if (prompt.email || /^Couldn't (find|check) /.test(prompt.text)) return [{ text: prompt.text }];
    const escaped = prompt.nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`@?${escaped}`, "i").exec(prompt.text);
    if (!match) return [{ text: prompt.text }];
    return [{ text: prompt.text.slice(0, match.index) }, { nick: prompt.nick }, { text: prompt.text.slice(match.index + match[0].length) }].filter((part) => part.nick || part.text);
  }

  return Object.assign(local, { forMessage, forEnd, offer, offerEmail, canAdd, label, add, ignore, segments, reset, destroy: reset });
}
