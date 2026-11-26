// Poll cards. The poll helper announces a poll as plain lines (what IRC clients read) carrying the
// client-only tag +slirc/poll=<id>; Slirc draws a card from GET /api/polls/:id instead. Anyone can
// put a client-only tag on their own line, so only a tagged line from the helper itself, for a poll
// of the same channel, becomes a card; anything else renders as the text it is. Tallies the helper
// posts for IRC clients (+slirc/poll-tally=<id>) are hidden here because the card is already live.

import { foldIdentifier, type Message } from "@client/model.ts";
import { MAX_OPTION, MAX_OPTIONS, MAX_QUESTION, MIN_OPTIONS, parsePoll, pollIntent, type PollRefusal } from "../shared/poll-parse.ts";

export { MAX_OPTION, MAX_OPTIONS, MAX_QUESTION };

export const POLL_TAG = "+slirc/poll";
export const POLL_TALLY_TAG = "+slirc/poll-tally";
export const POLL_HELPER = "poll";
export const CLOSES_IN = [
  { label: "None", value: null },
  { label: "1 hour", value: 3_600_000 },
  { label: "1 day", value: 86_400_000 },
  { label: "1 week", value: 7 * 86_400_000 },
] as const;

export type PollOption = { label: string; count: number; voters?: { nick: string; at: number }[] };
export type PollView = {
  id: number;
  channel: string;
  creator: string;
  question: string;
  multi: boolean;
  anonymous: boolean;
  createdAt: number;
  closesAt: number | null;
  closedAt: number | null;
  options: PollOption[];
  voters: number;
  mine: number[];
  winners: number[];
  canClose: boolean;
};

// The poll a line names, from its tags: a card announcement or a tally. Ids are plain digits.
export function pollMark(tags: Record<string, string | undefined>): Message["poll"] | undefined {
  const card = tags[POLL_TAG];
  if (card && /^\d{1,9}$/.test(card)) return { id: Number(card), kind: "card" };
  const tally = tags[POLL_TALLY_TAG];
  if (tally && /^\d{1,9}$/.test(tally)) return { id: Number(tally), kind: "tally" };
  return undefined;
}

const fromHelper = (message: Pick<Message, "authorNick">) => foldIdentifier(message.authorNick) === POLL_HELPER;

// A tally the helper posted for IRC clients; the transcript leaves it out.
export function isPollTally(message: Pick<Message, "poll" | "authorNick">): boolean {
  return message.poll?.kind === "tally" && fromHelper(message);
}

// The poll id a line should draw as a card, or null for an ordinary message.
export function cardPollId(message: Pick<Message, "poll" | "authorNick">): number | null {
  return message.poll?.kind === "card" && fromHelper(message) ? message.poll.id : null;
}

// The picks after tapping `option` (1-based): one answer moves or is taken back; several toggle.
export function nextPicks(view: Pick<PollView, "multi" | "mine">, option: number): number[] {
  const chosen = view.mine.includes(option);
  if (!view.multi) return chosen ? [] : [option];
  return chosen ? view.mine.filter((pick) => pick !== option) : [...view.mine, option].sort((a, b) => a - b);
}

// What the card shows before the server answers: the tap applied to the counts it already has.
export function optimistic(view: PollView, picks: number[], me: string): PollView {
  const before = new Set(view.mine);
  const after = new Set(picks);
  const options = view.options.map((option, index) => {
    const n = index + 1;
    const delta = (after.has(n) ? 1 : 0) - (before.has(n) ? 1 : 0);
    if (!delta) return option;
    const voters = option.voters && (delta > 0 ? [...option.voters, { nick: me, at: Date.now() }] : option.voters.filter((voter) => foldIdentifier(voter.nick) !== foldIdentifier(me)));
    return { ...option, count: Math.max(0, option.count + delta), ...(voters ? { voters } : {}) };
  });
  const voters = view.voters + (picks.length && !view.mine.length ? 1 : 0) - (!picks.length && view.mine.length ? 1 : 0);
  return { ...view, options, mine: [...picks].sort((a, b) => a - b), voters: Math.max(0, voters) };
}

// Bar width: the share of people who picked this option, so bars of a multi-answer poll stay at most full.
export function share(view: Pick<PollView, "voters">, option: Pick<PollOption, "count">): number {
  return view.voters ? Math.round((option.count / view.voters) * 100) : 0;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// The line under the question: how to answer and, for a timed poll, when it ends.
export function pollHint(view: PollView, now = Date.now()): string {
  if (view.closedAt !== null) return `Closed · ${plural(view.voters, "vote")}`;
  const how = view.multi ? "Select one or more" : "Select one";
  if (view.closesAt === null) return how;
  // Past its time but not yet closed by the server: the result is on its way.
  if (view.closesAt <= now) return `${how} · Closing`;
  // Rounded to the unit it reads in, so a fresh one-hour poll says "1 hour", not "60 minutes".
  const left = Math.max(0, view.closesAt - now);
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  const hours = Math.round(left / 3_600_000);
  const when = minutes < 60 ? plural(minutes, "minute") : hours < 24 ? plural(hours, "hour") : plural(Math.round(left / 86_400_000), "day");
  return `${how} · Closes in ${when}`;
}

// The screen-reader name of one answer: label, count, and whether it is yours or the winner.
export function optionLabel(view: PollView, index: number): string {
  const option = view.options[index]!;
  const parts = [option.label, plural(option.count, "vote")];
  if (view.winners.includes(index + 1)) parts.push(view.winners.length > 1 ? "tied for most votes" : "most votes");
  return parts.join(", ");
}

export function voteTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

type DraftOption = { key: number; text: string };

// Options as the server takes them: trimmed, blanks dropped. Null when the dialog cannot send yet.
export function draftPayload(question: string, options: DraftOption[]): { question: string; options: string[] } | null {
  const q = question.trim();
  const list = options.map((option) => option.text.trim()).filter(Boolean);
  if (!q || list.length < 2) return null;
  return { question: q, options: list };
}

// What the New poll dialog opens with when a typed poll would be refused, and the field to fix first.
export type PollPrefill = { question: string; options: string[]; closesIn: number | null; hint: string; focus: "question" | "closes" | number };

// `@poll …` text the helper would refuse as a new poll, read into the dialog. Bare `@poll` opens it
// empty. Null for a valid poll and for the helper's other commands (help, results, close, a vote),
// which still go to the channel.
export function pollPrefill(text: string, now = Date.now()): PollPrefill | null {
  const match = /^@poll\b[\s,:]*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  const request = match[1]!.trim();
  if (!request) return { question: "", options: [], closesIn: null, hint: "", focus: "question" };
  const intent = pollIntent(request);
  if (intent.kind !== "create") return null;
  const parsed = parsePoll(intent.text, now);
  if (!("error" in parsed)) return null;
  return fromRefusal(parsed);
}

function fromRefusal({ error, draft, field, index }: PollRefusal): PollPrefill {
  const options = draft.options.slice(0, MAX_OPTIONS);
  // The dialog lists its own choices for when a poll closes; a typed span outside them is dropped.
  const closesIn = CLOSES_IN.some((choice) => choice.value === draft.closesIn) ? draft.closesIn : null;
  if (field === "question") return { question: draft.question, options, closesIn, hint: draft.question ? error : "Write a question.", focus: "question" };
  if (field === "closes") return { question: draft.question, options, closesIn, hint: error, focus: "closes" };
  // Too few options: point at the first empty row, without the typed syntax ("commas or or").
  if (options.length < MIN_OPTIONS) return { question: draft.question, options, closesIn, hint: "Add at least two options.", focus: options.length };
  return { question: draft.question, options, closesIn, hint: error, focus: Math.min(index ?? 0, options.length - 1) };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function createPolls(reactive: <T extends object>(value: T) => T, deps: {
  enabled: () => boolean;
  me: () => string;
  // The channel a conversation id belongs to, and the one the composer is on (null outside a channel).
  wireFor: (conversationId: string) => string | null;
  composerChannel: () => string | null;
  nextTick: (callback?: () => void) => Promise<void>;
  fetch?: typeof fetch;
}) {
  const request = (...args: Parameters<typeof fetch>) => (deps.fetch ?? fetch)(...args);
  let keySeq = 0;
  // Each load or vote bumps its poll's sequence, so a slow answer never overwrites a newer one.
  const seq = new Map<number, number>();
  const loading = new Set<number>();
  let invoker: HTMLElement | null = null;
  let dragFrom = -1;

  const blank = () => [{ key: ++keySeq, text: "" }, { key: ++keySeq, text: "" }];
  const local = reactive({
    views: {} as Record<number, PollView | "missing">,
    busy: {} as Record<number, boolean>,
    errors: {} as Record<number, string>,
    menuFor: 0,
    votesFor: 0,
    plusOpen: false,
    dialogOpen: false,
    question: "",
    options: blank() as DraftOption[],
    multi: false,
    anonymous: false,
    closesIn: null as number | null,
    sending: false,
    error: "",
    dragging: -1,
    // Polite screen-reader news: a move in the dialog, a poll sent or closed.
    status: "",
  });

  const headers = { "Content-Type": "application/json", "X-Slirc-Poll": "1" };

  async function load(id: number): Promise<void> {
    const mine = (seq.get(id) ?? 0) + 1;
    seq.set(id, mine);
    loading.add(id);
    try {
      const response = await request(`/api/polls/${id}`, { credentials: "same-origin", cache: "no-store" });
      if (seq.get(id) !== mine) return;
      if (response.status === 404 || response.status === 503) { local.views[id] = "missing"; return; }
      if (!response.ok) return;
      local.views[id] = await response.json() as PollView;
    } catch {
      // Offline: keep whatever the card showed; the next live event or reconnect loads it again.
    } finally {
      loading.delete(id);
    }
  }

  // A loaded poll this conversation may draw: polls on, and the poll belongs to its channel.
  function drawable(id: number, conversationId: string): PollView | null {
    const view = local.views[id];
    if (!deps.enabled() || !view || view === "missing") return null;
    const wire = deps.wireFor(conversationId);
    return wire && foldIdentifier(wire) === foldIdentifier(view.channel) ? view : null;
  }

  // The card for a message, "loading" while its first read is on the way, or null for plain text.
  function card(message: Message): PollView | "loading" | null {
    if (!deps.enabled()) return null;
    const id = cardPollId(message);
    if (id === null) return null;
    if (!local.views[id]) {
      if (!loading.has(id)) void load(id);
      return "loading";
    }
    return drawable(id, message.conversationId);
  }

  // A closing tally hides only while its poll's card is drawn; otherwise it is the only result shown.
  const hidesTally = (message: Message) => isPollTally(message) && !!drawable(message.poll!.id, message.conversationId);

  async function vote(view: PollView, option: number): Promise<void> {
    if (view.closedAt !== null) return;
    const picks = nextPicks(view, option);
    const mine = (seq.get(view.id) ?? 0) + 1;
    seq.set(view.id, mine);
    local.views[view.id] = optimistic(view, picks, deps.me());
    local.errors[view.id] = "";
    try {
      const response = await request(`/api/polls/${view.id}/vote`, { method: "POST", credentials: "same-origin", headers, body: JSON.stringify({ options: picks }) });
      const body = await response.json().catch(() => ({}));
      if (seq.get(view.id) !== mine) return;
      if (response.ok) { local.views[view.id] = body as PollView; return; }
      local.errors[view.id] = typeof body.error === "string" ? body.error : "Could not count that vote.";
      void load(view.id);
    } catch {
      if (seq.get(view.id) !== mine) return;
      local.views[view.id] = view;
      local.errors[view.id] = "Could not reach the server. Try again.";
    }
  }

  async function close(view: PollView): Promise<void> {
    local.menuFor = 0;
    local.busy[view.id] = true;
    local.errors[view.id] = "";
    try {
      const response = await request(`/api/polls/${view.id}/close`, { method: "POST", credentials: "same-origin", headers, body: "{}" });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        seq.set(view.id, (seq.get(view.id) ?? 0) + 1);
        local.views[view.id] = body as PollView;
        local.status = "Poll closed";
      } else local.errors[view.id] = typeof body.error === "string" ? body.error : "Could not close the poll.";
    } catch {
      local.errors[view.id] = "Could not reach the server. Try again.";
    } finally {
      local.busy[view.id] = false;
    }
  }

  // A live "poll" event: someone voted or the poll closed. Only polls this tab shows are read again.
  function changed(id: number): void {
    if (local.views[id] && local.views[id] !== "missing") void load(id);
  }
  // The live stream reconnected: anything could have changed while it was down.
  function refreshAll(): void {
    for (const key of Object.keys(local.views)) changed(Number(key));
  }

  function toggleMenu(view: PollView): void {
    local.menuFor = local.menuFor === view.id ? 0 : view.id;
  }

  function openVotes(view: PollView, from?: EventTarget | null): void {
    local.menuFor = 0;
    invoker = from instanceof HTMLElement ? from : null;
    local.votesFor = view.id;
    void load(view.id);
  }
  function closeVotes(): void {
    local.votesFor = 0;
    restoreFocus();
  }
  const votesView = (): PollView | null => {
    const view = local.views[local.votesFor];
    return view && view !== "missing" ? view : null;
  };
  const voterName = (nick: string) => foldIdentifier(nick) === foldIdentifier(deps.me()) ? "You" : nick;

  // The composer's + menu offers Poll only in a channel on a server with polls on.
  const canCreate = () => deps.enabled() && !!deps.composerChannel();

  // `prefill` is a typed poll the helper would refuse: the dialog opens with what it said and the
  // cursor on the first thing to fix.
  function openDialog(from?: EventTarget | null, prefill?: PollPrefill): void {
    local.plusOpen = false;
    if (!canCreate()) return;
    invoker = from instanceof HTMLElement ? from : (document.activeElement as HTMLElement | null);
    const typed = prefill?.options ?? [];
    const rows = [...typed, ...Array.from({ length: Math.max(MIN_OPTIONS - typed.length, 0) }, () => "")];
    local.question = prefill?.question ?? "";
    local.options = rows.map((text) => ({ key: ++keySeq, text }));
    local.multi = false;
    local.anonymous = false;
    local.closesIn = prefill?.closesIn ?? null;
    local.error = prefill?.hint ?? "";
    local.sending = false;
    local.dialogOpen = true;
    const focus = prefill?.focus ?? "question";
    void deps.nextTick(() => {
      if (focus === "question") document.querySelector<HTMLInputElement>("#poll-question")?.focus();
      else if (focus === "closes") document.querySelector<HTMLInputElement>("input[name=poll-closes]:checked")?.focus();
      else document.querySelectorAll<HTMLInputElement>(".poll-option-input")[focus]?.focus();
    });
  }
  function closeDialog(): void {
    if (local.sending) return;
    local.dialogOpen = false;
    restoreFocus();
  }
  function restoreFocus(): void {
    const target = invoker;
    invoker = null;
    if (target?.isConnected) void deps.nextTick(() => target.focus());
  }

  const focusOption = (index: number) => deps.nextTick(() => document.querySelectorAll<HTMLInputElement>(".poll-option-input")[index]?.focus());

  function addOption(): void {
    if (local.options.length >= MAX_OPTIONS) return;
    local.options = [...local.options, { key: ++keySeq, text: "" }];
    void focusOption(local.options.length - 1);
  }
  function removeOption(index: number): void {
    if (local.options.length <= 2) { local.options[index]!.text = ""; void focusOption(index); return; }
    local.options = local.options.filter((_option, n) => n !== index);
    void focusOption(Math.min(index, local.options.length - 1));
  }
  // Enter in an option moves to the next one, adding a row at the end.
  function optionKeydown(event: KeyboardEvent, index: number): void {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (index < local.options.length - 1) void focusOption(index + 1);
    else if (local.options[index]!.text.trim()) addOption();
  }
  function move(from: number, to: number): void {
    const next = moveItem(local.options, from, to);
    if (next === local.options) return;
    local.options = next;
    local.status = `Moved to position ${to + 1} of ${next.length}`;
  }
  // The drag handle is also a button: Up and Down move the option, for keyboards and screen readers.
  function handleKeydown(event: KeyboardEvent, index: number): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const to = index + (event.key === "ArrowUp" ? -1 : 1);
    move(index, to);
    void deps.nextTick(() => document.querySelectorAll<HTMLElement>(".poll-option-handle")[Math.max(0, Math.min(to, local.options.length - 1))]?.focus());
  }
  // Pointer drag on the handle, for mouse and touch alike: the row follows the pointer across the
  // midpoints of its neighbours.
  function dragStart(event: PointerEvent, index: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    dragFrom = index;
    local.dragging = index;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }
  function dragMove(event: PointerEvent): void {
    if (dragFrom < 0) return;
    const rows = [...document.querySelectorAll<HTMLElement>(".poll-draft-row")];
    let to = rows.length - 1;
    for (let n = 0; n < rows.length; n++) {
      const box = rows[n]!.getBoundingClientRect();
      if (event.clientY < box.top + box.height / 2) { to = n; break; }
    }
    if (to !== dragFrom) {
      move(dragFrom, to);
      dragFrom = to;
      local.dragging = to;
    }
  }
  function dragEnd(): void {
    dragFrom = -1;
    local.dragging = -1;
  }

  const ready = () => !!draftPayload(local.question, local.options) && !local.sending;

  async function submit(): Promise<void> {
    const payload = draftPayload(local.question, local.options);
    const channel = deps.composerChannel();
    if (!payload) { local.error = local.question.trim() ? "Add at least two options." : "Write a question."; return; }
    if (!channel) { local.error = "Open a channel to start a poll."; return; }
    local.sending = true;
    local.error = "";
    try {
      const response = await request("/api/polls", { method: "POST", credentials: "same-origin", headers, body: JSON.stringify({ channel, ...payload, multi: local.multi, anonymous: local.anonymous, closesIn: local.closesIn }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { local.error = typeof body.error === "string" ? body.error : "Could not start the poll."; return; }
      const view = body as PollView;
      seq.set(view.id, (seq.get(view.id) ?? 0) + 1);
      local.views[view.id] = view;
      local.sending = false;
      closeDialog();
      local.status = "Poll sent";
    } catch {
      local.error = "Could not reach the server. Try again.";
    } finally {
      local.sending = false;
    }
  }

  function reset(): void {
    seq.clear();
    loading.clear();
    local.views = {};
    local.busy = {};
    local.errors = {};
    local.menuFor = 0;
    local.votesFor = 0;
    local.plusOpen = false;
    local.dialogOpen = false;
  }

  // Views handed over whole, from the signed-out peek: no read of its own, and a listed id without
  // a view stays plain text instead of asking /api/polls.
  function prime(views: Record<number, PollView | "missing">): void {
    for (const [key, view] of Object.entries(views)) {
      const id = Number(key);
      seq.set(id, (seq.get(id) ?? 0) + 1);
      local.views[id] = view;
    }
  }

  return Object.assign(local, {
    card, hidesTally, prime, vote, close, changed, refreshAll, toggleMenu, openVotes, closeVotes, votesView, voterName, canCreate,
    openDialog, closeDialog, addOption, removeOption, optionKeydown, handleKeydown, dragStart, dragMove, dragEnd, ready, submit, reset,
    hint: pollHint, share, optionLabel, voteTime, closesInChoices: CLOSES_IN, maxOptions: MAX_OPTIONS, maxQuestion: MAX_QUESTION, maxOption: MAX_OPTION,
    isWinner: (view: PollView, index: number) => view.winners.includes(index + 1),
    isMine: (view: PollView, index: number) => view.mine.includes(index + 1),
    topVoters: (option: PollOption) => (option.voters ?? []).slice(-3).reverse(),
  });
}
