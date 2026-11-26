import { validSignInEmail } from "@client/pairing.ts";
import { type ClientSession, type ClientState } from "@client/client-state.ts";

// "New conversation" dialog. Collects recipients only; the server resolves exact email matches,
// deduplicates to immutable accounts, picks the destination (pair DM, private group) and owns
// membership/grant/email side effects. Uncertain submits keep their frozen idempotency key so a
// retry replays the stored outcome instead of sending a second invitation.
// kind "bot" marks a helper (help, remind) the server offers for a DM only.
export interface NewConversationPerson { accountId: string; nick: string; displayName: string; avatarUrl: string; kind?: string }
export type NewConversationRecipient =
  | { kind: "account"; accountId: string; nick: string; displayName: string }
  | { kind: "email"; email: string };
export interface NewConversationOutcome {
  accountId?: string; nick?: string; email?: string; status: string;
  invitationId?: string; id?: string; expiresAt?: number; error?: string;
}
export interface ConversationResult { type: "direct" | "group" | "channel"; channel: string; nick?: string }

export type NewConversationMode = "direct" | "group" | "invite";

export const NEW_CONVERSATION_SEARCH_LIMIT = 20;

export function newConversationStatusLabel(status: string): string {
  switch (status) {
    case "invited": return "Invitation sent";
    case "added": return "Added";
    case "existing": return "Already a member";
    case "uncertain": return "Delivery uncertain";
    case "failed": return "Delivery failed";
    default: return status;
  }
}

export function recipientPayload(recipients: readonly NewConversationRecipient[]) {
  return recipients.map((recipient) => recipient.kind === "account" ? { accountId: recipient.accountId } : { email: recipient.email });
}

export function conversationRecipientKey(recipients: readonly NewConversationRecipient[]): string {
  return JSON.stringify(recipientPayload(recipients));
}

// Whether the server definitely recorded this attempt. Anything ambiguous (a processing 409,
// malformed body, gateway/5xx) must keep the frozen key so a retry replays instead of duplicating.
export function conversationOutcomeIsRecorded(status: number, body: unknown): boolean {
  const parsed = body && typeof body === "object" ? body as Record<string, unknown> : null;
  if (!parsed) return false;
  if (status >= 200 && status < 300) return Array.isArray(parsed.recipients) || "conversation" in parsed || parsed.pending === true;
  if (status === 400 || status === 403 || status === 404 || status === 429) return true;
  if (status === 409) return /different payload/i.test(String(parsed.error || ""));
  // 500 now; 502 is what operations stored before the switch replay with.
  if (status === 500 || status === 502) return Array.isArray(parsed.recipients);
  return false;
}

export function validNewConversationPerson(value: unknown): value is NewConversationPerson {
  const person = value as NewConversationPerson | null;
  return !!person && typeof person === "object"
    && typeof person.accountId === "string" && person.accountId.length > 0
    && typeof person.nick === "string" && person.nick.length > 0
    && typeof person.displayName === "string";
}

export function createNewConversation(reactive: <T extends object>(value: T) => T, { core, session, nextTick, connect, openDirect, openRoom, accountIdFor, avatarUrl }: {
  core: Pick<ClientState, "authenticated" | "account" | "contacts">;
  session: ClientSession;
  nextTick: (callback?: () => void) => Promise<void>;
  connect: () => Promise<void>;
  openDirect: (nick: string, accountId?: string) => void | Promise<void>;
  openRoom: (room: string) => void;
  accountIdFor: (nick: string) => string | undefined;
  avatarUrl: (nick: string) => string;
}) {
  let searchSeq = 0;
  let invoker: HTMLElement | null = null;
  let heightObserver: ResizeObserver | null = null;

  function observeHeight(): void {
    const card = dialog()?.querySelector<HTMLElement>(".new-conversation-card");
    const content = card?.querySelector<HTMLElement>(".new-conversation-content");
    if (!card || !content || typeof ResizeObserver === "undefined") return;
    const resize = () => {
      const style = getComputedStyle(card);
      card.style.height = `${content.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
    };
    resize();
    heightObserver = new ResizeObserver(resize);
    heightObserver.observe(content);
  }
  const local = reactive({
    mode: "direct" as NewConversationMode,
    destination: null as string | null,
    query: "",
    searchBusy: false,
    searchError: "",
    results: [] as NewConversationPerson[],
    recipients: [] as NewConversationRecipient[],
    emailInput: "",
    emailError: "",
    remaining: 0,
    limit: 0,
    unlimited: false,
    busy: false,
    error: "",
    note: "",
    outcomes: [] as NewConversationOutcome[],
    settled: false,
    submitSucceeded: false,
    pending: null as { key: string; recipientKey: string } | null,
    // Highlighted row in the people list; arrow keys move it and Enter opens it.
    active: 0,
    // The query the current results answer, so Enter never picks from an older search.
    searchedQuery: "",
  });

  const inScope = (key: string) => session.key() === key && !session.stopped() && core.authenticated;
  const dialog = () => typeof document === "undefined" ? null : document.querySelector<HTMLDialogElement>("#new-conversation-dialog");

  function reset(): void {
    searchSeq += 1;
    heightObserver?.disconnect(); heightObserver = null;
    dialog()?.querySelector<HTMLElement>(".new-conversation-card")?.style.removeProperty("height");
    local.mode = "direct";
    local.destination = null;
    local.query = ""; local.searchBusy = false; local.searchError = "";
    local.results = []; local.recipients = []; local.emailInput = ""; local.emailError = "";
    local.busy = false; local.error = ""; local.note = ""; local.outcomes = []; local.settled = false; local.submitSucceeded = false; local.pending = null;
    local.active = 0; local.searchedQuery = "";
  }

  function open(event?: Event): void {
    if (!core.authenticated || local.busy) return;
    invoker = (event?.currentTarget as HTMLElement | null) ?? null;
    reset();
    local.remaining = 0; local.limit = 0; local.unlimited = false;
    void nextTick(() => {
      dialog()?.showModal();
      observeHeight();
      if (typeof document !== "undefined") document.querySelector<HTMLInputElement>("#new-conversation-search")?.focus();
    });
    void loadAllowance();
  }

  // Email only: `/invite @name` adds existing people inline, without this dialog.
  function openInvite(channel: string, email = ""): void {
    open();
    if (!core.authenticated || local.busy) return;
    local.destination = channel;
    local.query = email;
  }

  function isEmailQuery(): boolean { return validSignInEmail(local.query.trim()); }

  function invitationSent(): boolean {
    return local.submitSucceeded && local.settled && !local.error && emailRecipientCount() > 0 && local.outcomes.length > 0
      && local.outcomes.every((outcome) => ["invited", "added", "existing"].includes(outcome.status));
  }

  function close(): void {
    if (local.busy) return;
    dialog()?.close();
    reset();
    if (invoker?.isConnected) invoker.focus();
    invoker = null;
  }

  async function loadAllowance(): Promise<void> {
    const key = session.key();
    try {
      const response = await fetch("/api/invites/email", { credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (!inScope(key) || !response.ok) return;
      if (typeof body.remaining === "number") local.remaining = body.remaining;
      if (typeof body.limit === "number") local.limit = body.limit;
      if (typeof body.unlimited === "boolean") { local.unlimited = body.unlimited; if (body.unlimited) local.limit = 0; }
    } catch { /* allowance is best-effort; submit still enforces it */ }
  }

  function isSelected(accountId: string): boolean {
    return local.recipients.some((recipient) => recipient.kind === "account" && recipient.accountId === accountId);
  }

  function emailSelected(email: string): boolean {
    const value = email.trim().toLowerCase();
    return local.recipients.some((recipient) => recipient.kind === "email" && recipient.email.toLowerCase() === value);
  }

  // Switching intent starts a fresh request: existing reset drops selection/search/outcomes, then we
  // park focus on the control that mode needs. Best-effort only; the dialog may not be mounted.
  function setMode(mode: NewConversationMode): void {
    if (local.busy) return;
    const card = dialog()?.querySelector<HTMLElement>(".new-conversation-card");
    const height = card?.style.height;
    reset();
    if (card && height) card.style.height = height;
    local.mode = mode;
    local.destination = null;
    void nextTick(() => {
      if (typeof document === "undefined") return;
      const selector = mode === "invite" ? "#new-conversation-email" : "#new-conversation-search";
      document.querySelector<HTMLInputElement>(selector)?.focus();
      observeHeight();
    });
  }

  // Direct intent is a single-person picker: picking closes the dialog and runs the existing
  // optimistic openDirect path. No /api/conversations POST and no connect() wait; group/invite keep
  // the multi-recipient selection + submit flow untouched.
  function choosePerson(person: NewConversationPerson): void {
    if (local.busy || !validNewConversationPerson(person)) return;
    if (local.mode === "direct" && !local.destination) {
      if (!core.authenticated) return;
      if (person.nick.toLowerCase() === core.account.toLowerCase()) return;
      const key = session.key();
      close();
      if (!inScope(key)) return;
      void openDirect(person.nick, person.accountId);
      return;
    }
    addPerson(person);
  }

  // Any selection edit starts a new logical request: drop the frozen key and prior outcome.
  function selectionChanged(): void {
    local.settled = false; local.submitSucceeded = false; local.outcomes = []; local.error = ""; local.note = ""; local.pending = null;
  }

  // What the list shows: search results once 2 characters are typed, contacts before that.
  function visiblePeople(): NewConversationPerson[] {
    return local.query.trim().length >= 2 ? local.results : contactSuggestions();
  }

  // Arrow keys move the highlight; Enter opens the highlighted person, so with one result Enter
  // starts the DM. Enter before the debounced search ran searches first.
  async function keydown(event: KeyboardEvent): Promise<void> {
    if (local.busy || isEmailQuery() || local.destination) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const count = visiblePeople().length;
      if (!count) return;
      event.preventDefault();
      local.active = (local.active + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      return;
    }
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (local.query.trim().length >= 2 && local.searchedQuery !== local.query.trim()) await search();
    const person = visiblePeople()[local.active] ?? visiblePeople()[0];
    if (person) choosePerson(person);
  }

  function contactSuggestions(): NewConversationPerson[] {
    return core.contacts.flatMap((nick) => {
      const accountId = accountIdFor(nick);
      if (!accountId || isSelected(accountId) || nick.toLowerCase() === core.account.toLowerCase()) return [];
      return [{ accountId, nick, displayName: nick, avatarUrl: avatarUrl(nick) }];
    }).slice(0, NEW_CONVERSATION_SEARCH_LIMIT);
  }

  async function search(): Promise<void> {
    const rawQuery = local.query.trim();
    const query = rawQuery.startsWith("@") ? rawQuery.slice(1) : rawQuery;
    const seq = ++searchSeq;
    if (validSignInEmail(rawQuery)) { local.searchError = ""; local.results = []; local.searchBusy = false; return; }
    if (query.length > 80) { local.searchError = "Search is limited to 80 characters."; local.results = []; local.searchBusy = false; return; }
    if (query.length < 2) { local.searchError = ""; local.results = []; local.searchBusy = false; return; }
    const key = session.key();
    local.searchBusy = true; local.searchError = "";
    try {
      const response = await fetch(`/api/people?q=${encodeURIComponent(query)}&limit=${NEW_CONVERSATION_SEARCH_LIMIT}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (seq !== searchSeq || !inScope(key)) return;
      if (!response.ok) throw new Error(body.error || "Search failed.");
      // Helpers only take DMs, so a group or channel invite never lists them.
      const direct = local.mode === "direct" && !local.destination;
      local.results = Array.isArray(body.people) ? body.people.filter((person: unknown) => validNewConversationPerson(person) && (direct || person.kind !== "bot")) : [];
      local.searchedQuery = rawQuery;
      local.active = 0;
    } catch (error) {
      if (seq === searchSeq && inScope(key)) local.searchError = error instanceof Error ? error.message : "Search failed.";
    } finally {
      if (seq === searchSeq && inScope(key)) local.searchBusy = false;
    }
  }

  function addPerson(person: NewConversationPerson): void {
    if (local.busy || !validNewConversationPerson(person) || isSelected(person.accountId)) return;
    if (person.nick.toLowerCase() === core.account.toLowerCase()) return;
    selectionChanged();
    local.recipients = [...local.recipients, { kind: "account", accountId: person.accountId, nick: person.nick, displayName: person.displayName || person.nick }];
  }

  function addEmail(): void {
    if (local.busy) return;
    const email = local.emailInput.trim();
    if (!validSignInEmail(email)) { local.emailError = "Enter a valid email address."; return; }
    if (emailSelected(email)) { local.emailError = "That email is already selected."; return; }
    selectionChanged();
    local.emailError = "";
    local.recipients = [...local.recipients, { kind: "email", email }];
    local.emailInput = "";
  }

  function removeRecipient(index: number): void {
    if (local.busy) return;
    selectionChanged();
    local.recipients = local.recipients.filter((_, position) => position !== index);
  }

  function emailRecipientCount(): number {
    return local.recipients.filter((recipient) => recipient.kind === "email").length;
  }

  async function submitEmailQuery(): Promise<void> {
    if (!isEmailQuery() || local.busy) return;
    const email = local.query.trim();
    if (local.recipients.length !== 1 || local.recipients[0]?.kind !== "email" || local.recipients[0].email !== email) {
      selectionChanged();
      local.recipients = [{ kind: "email", email }];
    }
    await submit();
  }

  async function submit(): Promise<void> {
    if (!core.authenticated || local.busy || local.settled || !local.recipients.length) return;
    const key = session.key();
    const recipientKey = JSON.stringify({ destination: local.destination ? { type: "channel", channel: local.destination } : null, recipients: recipientPayload(local.recipients) });
    const request = local.pending && local.pending.recipientKey === recipientKey
      ? local.pending
      : (local.pending = { key: crypto.randomUUID(), recipientKey });
    local.busy = true; local.error = ""; local.note = "";
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": request.key },
        body: JSON.stringify({ recipients: recipientPayload(local.recipients), ...(local.destination ? { destination: { type: "channel", channel: local.destination } } : {}) }),
      });
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      if (!inScope(key)) return;
      const parsed = body && typeof body === "object" ? body as Record<string, any> : null;
      // Release the frozen key only when the server recorded a definite outcome. A processing 409,
      // malformed body or gateway error keeps it so the retry cannot create a second group/email.
      if (conversationOutcomeIsRecorded(response.status, parsed)) local.pending = null;
      if (parsed) {
        if (typeof parsed.remaining === "number") local.remaining = parsed.remaining;
        if (typeof parsed.limit === "number") local.limit = parsed.limit;
        if (typeof parsed.unlimited === "boolean") { local.unlimited = parsed.unlimited; if (parsed.unlimited) local.limit = 0; }
        local.outcomes = Array.isArray(parsed.recipients) ? parsed.recipients : [];
      } else {
        local.outcomes = [];
      }
      if (!parsed) {
        local.error = "The server did not return a usable reply. Retry sends the same request.";
        return;
      }
      const needsAttention = local.outcomes.some((outcome) => outcome.status === "failed" || outcome.status === "uncertain");
      const uncertain = local.outcomes.some((outcome) => outcome.status === "uncertain");
      const failed = local.outcomes.some((outcome) => outcome.status === "failed");
      if (!parsed.conversation && !local.outcomes.length) {
        local.error = parsed.error || "Could not start the conversation.";
        return;
      }
      local.settled = true;
      local.submitSucceeded = response.ok;
      // Never route on a non-2xx response, even if a partial body carries a conversation.
      if (response.ok && local.destination && !needsAttention) { await complete(null); return; }
      if (response.ok && parsed.conversation && !needsAttention) { await complete(parsed.conversation as ConversationResult); return; }
      if (!parsed.conversation) {
        if (uncertain && !failed) local.note = "Delivery is uncertain. Check Invitations; do not resend blindly.";
        else if (needsAttention) local.note = "The invitation could not be delivered.";
        else if (parsed.pending) local.note = "Invitation sent. The conversation starts when they accept.";
        else local.note = parsed.error || "No conversation was created.";
        if (invitationSent()) void nextTick(() => {
          if (typeof document !== "undefined") document.querySelector<HTMLButtonElement>("#new-conversation-done")?.focus();
        });
      } else if (needsAttention) {
        local.note = "Some recipients need attention. Successful invitations were sent.";
      }
    } catch {
      if (inScope(key)) local.error = "Could not reach the server. Retry sends the same request.";
      // local.pending stays set so the retry reuses the idempotency key.
    } finally {
      if (inScope(key)) local.busy = false;
    }
  }

  async function complete(conversation: ConversationResult | null): Promise<void> {
    const key = session.key();
    await connect();
    if (!inScope(key)) return;
    dialog()?.close();
    reset();
    if (invoker?.isConnected) invoker.focus();
    invoker = null;
    if (conversation?.type === "direct" && conversation.nick) void openDirect(conversation.nick);
    else if (conversation?.channel) openRoom(conversation.channel);
  }

  return Object.assign(local, {
    open, openInvite, close, search, setMode, choosePerson, addPerson, addEmail, removeRecipient,
    isEmailQuery, invitationSent, submitEmailQuery,
    contactSuggestions, visiblePeople, keydown, emailRecipientCount, submit, reset,
    newConversationStatusLabel, destroy: reset,
  });
}
