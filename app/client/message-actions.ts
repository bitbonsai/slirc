import { type Message } from "@client/model.ts";
import { DEFAULT_REACTIONS, nextMessageIndex } from "@client/presentation.ts";
import { reactionSearchRows, type CustomEmoji, type EmojiSuggestion } from "@client/emoji.ts";
import { anchorPopupStyle, placePopup, popupAnchorName, popupMaxHeight, popupSide, supportsAnchorPositioning, visualViewportRect, type OpenPopup, type PopupTrigger } from "@client/popups.ts";
import { hideActiveTooltip } from "@client/tooltips.ts";
import { type ClientState } from "@client/client-state.ts";

// Remind me times. Each `when` is a form the remind parser reads on its own (src/reminders.ts), so
// everything after it stays the reminder text.
export const REMIND_PRESETS = [
  { label: "In 20 minutes", when: "in 20m" },
  { label: "In 1 hour", when: "in 1h" },
  { label: "Tomorrow at 9:00", when: "tomorrow 9:00" },
] as const;

// One line, at most 60 characters. Double quotes turn single so the reminder keeps one clear pair.
export function reminderQuote(text: string): string {
  const line = text.replace(/\s+/g, " ").replace(/["“”]/g, "'").trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

// The link goes last: the parser's trailing "... in 5m" form cannot match a URL ending.
export function reminderAbout(text: string, link: string): string {
  const quote = reminderQuote(text);
  return quote ? `"${quote}" ${link}` : link;
}

// `datetime-local` values are local wall time without seconds, e.g. 2026-10-08T14:00.
export function localDateTimeValue(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function nextFullHour(now: number): number {
  const date = new Date(now);
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date.getTime();
}

const REMIND_MAX_MS = 365 * 86_400_000;

// Columns in the Add reaction grid; ArrowUp/Down move one row.
export const REACTION_GRID_COLUMNS = 8;

export function createMessageActions(reactive: <T extends object>(value: T) => T, { core, nextTick, openPopup, canEdit, canDelete, startEdit, quoteMessage, openThreadForMessage, chooseReaction, focusComposer, deleteMessage, focusAfterDelete, messageLink, setReminder, customEmoji = () => [] }: {
  core: Pick<ClientState, 'messages' | 'isDesktop'>;
  openPopup: OpenPopup;
  nextTick: (callback?: () => void) => Promise<void>;
  canEdit: (message: Message) => boolean;
  canDelete: (message: Message) => boolean;
  startEdit: (message: Message) => void;
  quoteMessage: (message: Message) => void;
  openThreadForMessage: (message: Message) => Promise<void>;
  chooseReaction: (message: Message, emoji: string) => void;
  focusComposer: () => void;
  deleteMessage: (message: Message | undefined) => Promise<void>;
  focusAfterDelete: () => void;
  messageLink: (message: Message) => string;
  /** With `fireAt` the server skips reading a time from the text. */
  setReminder: (text: string, fireAt?: number) => Promise<void>;
  customEmoji?: () => CustomEmoji[];
}) {
  let pressTimer: number | null = null;
  let pressPoint: { x: number; y: number } | null = null;
  const local = reactive({
    actionMessageId: "",
    panelMenu: false,
    menuPoint: null as { x: number; y: number } | null,
    openReactionId: "",
    viewportRevision: 0,
    reactionQuery: "",
    reactionSearch: false,
    reactionIndex: 0,
    stampedReaction: "",
    pressFired: false,
    deleteCandidate: "",
    remindOpen: false,
    remindForm: false,
    remindValue: "",
    remindMin: "",
    remindMax: "",
    remindError: "",
  });
  let stampTimer: ReturnType<typeof setTimeout> | null = null;
  function viewportChanged(): void { local.viewportRevision += 1; }
  function stamp(value: string): void {
    if (stampTimer !== null) clearTimeout(stampTimer);
    local.stampedReaction = value;
    stampTimer = setTimeout(() => { local.stampedReaction = ""; stampTimer = null; }, 400);
  }
  async function confirmDelete(): Promise<void> {
    const message = core.messages.find((item: Message) => item.id === local.deleteCandidate);
    local.deleteCandidate = "";
    document.querySelector<HTMLDialogElement>("#delete-dialog")?.close();
    focusAfterDelete();
    await deleteMessage(message);
  }
  function reset(): void {
    closeActions(); pressCancel();
    if (stampTimer !== null) clearTimeout(stampTimer);
    stampTimer = null; local.stampedReaction = ""; local.pressFired = false;
    local.deleteCandidate = "";
    document.querySelector<HTMLDialogElement>("#delete-dialog")?.close();
  }
  function closeActions(): void {
    pressCancel();
    local.actionMessageId = "";
    local.panelMenu = false;
    local.menuPoint = null;
    local.openReactionId = "";
    local.reactionQuery = ""; local.reactionSearch = false;
    local.remindOpen = false; local.remindForm = false;
  }

  function toggleThreadMenu(message: Message): void {
    openPopup(closeActions);
    local.actionMessageId = local.actionMessageId === message.id ? "" : message.id;
    local.menuPoint = null;
    local.openReactionId = "";
    local.pressFired = false;
    local.remindOpen = false; local.remindForm = false;
  }

  // The thread panel's More button: the same actions, in a menu inside the panel. The row's own menu
  // sits under the panel's stacking layer.
  function toggleMenuAt(message: Message): void {
    const closing = local.actionMessageId === message.id;
    toggleThreadMenu(message);
    local.panelMenu = !closing;
  }

  function toggleReactionPicker(message: Message): void {
    const id = message.id;
    const opening = local.openReactionId !== id;
    if (opening) openPopup(closeActions);
    local.openReactionId = opening ? id : "";
    local.actionMessageId = "";
    local.reactionQuery = ""; local.reactionSearch = false;
    // The trigger is still focused after the click; drop its tooltip so the picker is unobstructed.
    if (opening) hideActiveTooltip();
  }

  function pickEmoji(emoji: string): void {
    const message = core.messages.find((item: Message) => item.id === local.openReactionId);
    if (message) chooseReaction(message, emoji);
  }

  function closeReactionPicker(): void {
    local.openReactionId = "";
    local.reactionQuery = ""; local.reactionSearch = false;
  }

  // Add reaction swaps the presets (desktop picker) or the actions (phone sheet) for a search.
  function openReactionSearch(): void {
    local.reactionQuery = ""; local.reactionIndex = 0; local.reactionSearch = true;
    hideActiveTooltip();
    swapMenu(".reaction-search-input");
  }

  function closeReactionSearch(): void {
    local.reactionQuery = ""; local.reactionSearch = false;
    swapMenu(".reaction-search-open");
  }

  function reactionRows(): EmojiSuggestion[] {
    return reactionSearchRows(local.reactionQuery, customEmoji(), DEFAULT_REACTIONS);
  }

  function reactionQueryChanged(): void { local.reactionIndex = 0; }

  // Desktop reacts through pickEmoji, the phone sheet through fromSheet, like the presets beside it.
  function reactWith(row: EmojiSuggestion | undefined): void {
    if (!row) return;
    if (local.openReactionId) pickEmoji(row.emoji);
    else fromSheet((message) => chooseReaction(message, row.emoji));
  }

  function reactionSearchKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const rows = reactionRows();
    const stop = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.key === "Escape") { stop(); closeReactionSearch(); return; }
    if (event.key === "Enter") { stop(); reactWith(rows[local.reactionIndex]); return; }
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: REACTION_GRID_COLUMNS, ArrowUp: -REACTION_GRID_COLUMNS }[event.key];
    if (!step || !rows.length) return;
    // Left and Right stay in the text field while it has text to move through.
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && local.reactionQuery) return;
    stop();
    local.reactionIndex = Math.min(rows.length - 1, Math.max(0, local.reactionIndex + step));
    void nextTick(() => document.querySelector(".reaction-search-grid [aria-selected=\"true\"]")?.scrollIntoView({ block: "nearest" }));
  }

  function popupAnchorStyles(id: string, role: "more" | "add"): string {
    return supportsAnchorPositioning() ? `anchor-name: ${popupAnchorName(`${id}-${role}`)}` : "";
  }

  // The trigger's own box, which the anchored popup also sits against. A tall row (photo, embed, long
  // text) would put the popup far below its button. The row box stays as a fallback when the trigger
  // is not rendered.
  function triggerBox(id: string, role: "more" | "add"): PopupTrigger | null {
    const row = [...document.querySelectorAll<HTMLElement>(".msg[data-message-id]")].find((el) => el.dataset.messageId === id);
    if (!row) return null;
    const trigger = row.querySelector<HTMLElement>(`.message-${role}`);
    const r = (trigger?.getClientRects().length ? trigger : row).getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  }

  function pickerStyle(): string {
    local.viewportRevision;
    if (!local.openReactionId) return "display: none";
    const box = triggerBox(local.openReactionId, "add");
    const picker = document.querySelector<HTMLElement>(".reaction-picker");
    if (!box || !picker) return "display: none";
    const size = { width: Math.max(picker.offsetWidth, 240), height: Math.max(picker.offsetHeight, 44) };
    const viewport = visualViewportRect();
    if (supportsAnchorPositioning()) {
      const side = popupSide(box, size, viewport);
      const maxHeight = popupMaxHeight(box, size, viewport, side);
      const cap = maxHeight ? `max-height: ${maxHeight}px; overflow-y: auto;` : "";
      return `${anchorPopupStyle(popupAnchorName(`${local.openReactionId}-add`), side)} ${cap}`;
    }
    const place = placePopup(box, size, viewport);
    const cap = place.maxHeight ? `max-height: ${place.maxHeight}px; overflow-y: auto;` : "";
    return `top: ${place.top}px; left: ${place.left}px; bottom: auto; right: auto; ${cap}`;
  }

  function menuStyle(): string {
    local.viewportRevision;
    if (!local.actionMessageId) return "display: none";
    const menu = document.querySelector<HTMLElement>(".message-menu");
    if (!menu) return "display: none";
    const size = { width: Math.max(menu.offsetWidth, 160), height: Math.max(menu.offsetHeight, 44) };
    const viewport = visualViewportRect();
    if (local.menuPoint) {
      const box: PopupTrigger = { top: local.menuPoint.y, bottom: local.menuPoint.y, left: local.menuPoint.x, right: local.menuPoint.x };
      const place = placePopup(box, size, viewport);
      const cap = place.maxHeight ? `max-height: ${place.maxHeight}px; overflow-y: auto;` : "";
      return `position: fixed; top: ${place.top}px; left: ${place.left}px; bottom: auto; right: auto; ${cap}`;
    }
    const box = triggerBox(local.actionMessageId, "more");
    if (!box) return "display: none";
    if (supportsAnchorPositioning()) {
      const side = popupSide(box, size, viewport);
      const maxHeight = popupMaxHeight(box, size, viewport, side);
      const cap = maxHeight ? `max-height: ${maxHeight}px; overflow-y: auto;` : "";
      return `${anchorPopupStyle(popupAnchorName(`${local.actionMessageId}-more`), side)} ${cap}`;
    }
    const place = placePopup(box, size, viewport);
    const cap = place.maxHeight ? `max-height: ${place.maxHeight}px; overflow-y: auto;` : "";
    return `position: fixed; top: ${place.top}px; left: ${place.left}px; bottom: auto; right: auto; ${cap}`;
  }

  function isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target.closest(".message-menu")) return true;
    if (target.closest("input, textarea, select, a, [contenteditable=''], [contenteditable='true']")) return true;
    const button = target.closest("button");
    return !!button && !button.classList.contains("message-more") && !button.classList.contains("message-add");
  }

  function messageKeydown(event: KeyboardEvent, message: Message): void {
    if (isInteractiveTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (local.actionMessageId === message.id) closeMessageMenu(true);
      else focusComposer();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const rows = [...document.querySelectorAll<HTMLElement>(".msg[data-message-id]")];
      const index = rows.findIndex((row) => row.dataset.messageId === message.id);
      const target = nextMessageIndex(index, rows.length, event.key);
      if (target === "stay") return; // ArrowUp at the oldest row stays put
      if (target === "composer") { focusComposer(); return; } // ArrowDown past the newest
      const next = rows[target]!;
      next.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
      next.classList.add("kb-focus");
      next.addEventListener("blur", () => next.classList.remove("kb-focus"), { once: true });
      next.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key.toLowerCase() === "e") {
      if (canEdit(message)) { event.preventDefault(); startEdit(message); }
      return;
    }
    if (event.key.toLowerCase() === "d") {
      if (canDelete(message)) { event.preventDefault(); requestDelete(message); }
      return;
    }
    if (event.key.toLowerCase() === "q") {
      event.preventDefault();
      quoteMessage(message);
      return;
    }
    if (event.key.toLowerCase() === "t") { event.preventDefault(); void openThreadForMessage(message); return; }
    if (event.key.toLowerCase() === "r") { event.preventDefault(); toggleReactionPicker(message); }
  }

  // `onPress` replaces the message sheet, e.g. a link opens its own menu.
  function pressStart(event: TouchEvent, message: Message, onPress?: () => void): void {
    if (event.touches.length !== 1) return;
    openPopup(closeActions);
    pressCancel();
    const touch = event.touches[0]!;
    pressPoint = { x: touch.clientX, y: touch.clientY };
    local.pressFired = false;
    pressTimer = globalThis.setTimeout(() => {
      pressTimer = null;
      openPopup(closeActions);
      local.pressFired = true;
      navigator.vibrate?.(10);
      getSelection()?.removeAllRanges();
      if (onPress) { onPress(); return; }
      local.actionMessageId = message.id;
      local.openReactionId = "";
      local.reactionQuery = ""; local.reactionSearch = false;
      local.remindOpen = false; local.remindForm = false;
    }, 420) as unknown as number;
  }

  function pressMove(event: TouchEvent): void {
    if (pressTimer === null || !pressPoint || event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    // A scroll or sideways drag is not a long press.
    if (Math.abs(touch.clientX - pressPoint.x) > 12 || Math.abs(touch.clientY - pressPoint.y) > 12) pressCancel();
  }

  function pressEnd(event?: TouchEvent): void {
    // The sheet is already up; lifting the finger must not send it a tap that closes it again.
    if (local.pressFired) event?.preventDefault();
    pressCancel();
  }

  // Android Chrome turns its own long press into a text selection, the Copy/Share toolbar and Touch
  // to Search. On desktop (web and Mac app), right-clicking a confirmed message opens its actions
  // menu at the pointer unless text is selected or an interactive child (like a link) owns the click.
  function pressContextMenu(event: MouseEvent | Event, message?: Message): void {
    if (pressTimer !== null || local.pressFired) { event.preventDefault(); return; }
    if (!core.isDesktop || !message || message.state !== "confirmed" || !message.serverId) return;
    if (typeof window !== "undefined" && window.getSelection?.()?.toString()) return;
    if (isInteractiveTarget(event.target)) return;
    event.preventDefault();
    const mouse = event as MouseEvent;
    openPopup(closeActions);
    local.actionMessageId = message.id;
    local.menuPoint = typeof mouse.clientX === "number" && typeof mouse.clientY === "number"
      ? { x: mouse.clientX, y: mouse.clientY }
      : null;
    local.openReactionId = "";
    local.pressFired = false;
    local.remindOpen = false; local.remindForm = false;
    hideActiveTooltip();
  }

  function pressCancel(): void {
    if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
    pressPoint = null;
  }

  function closeMessageMenu(focusTrigger = false): void {
    const rowId = local.actionMessageId;
    local.actionMessageId = "";
    local.panelMenu = false;
    local.menuPoint = null;
    local.openReactionId = "";
    local.reactionQuery = ""; local.reactionSearch = false;
    local.remindOpen = false; local.remindForm = false;
    if (!focusTrigger || !rowId) return;
    const row = [...document.querySelectorAll<HTMLElement>(".msg[data-message-id]")].find((el) => el.dataset.messageId === rowId);
    row?.querySelector<HTMLElement>(".message-more")?.focus();
  }

  function actionMessage(): Message | undefined {
    return local.actionMessageId ? core.messages.find((item: Message) => item.id === local.actionMessageId) : undefined;
  }

  // The phone sheet is modal, so the page stays inert until it closes. Close it before the desktop
  // handler runs so Edit can still focus the composer.
  function fromSheet(run: (message: Message) => unknown): void {
    const message = actionMessage();
    document.querySelector<HTMLDialogElement>("#message-sheet")?.close();
    closeMessageMenu(false);
    if (message) void run(message);
  }

  // Swapping the items resizes the menu, so place it again for its new size before focusing inside it.
  function swapMenu(focusSelector: string): void {
    void nextTick(() => {
      viewportChanged();
      void nextTick(() => [...document.querySelectorAll<HTMLElement>(focusSelector)].find((item) => item.getClientRects().length > 0)?.focus());
    });
  }

  // Remind me swaps the menu or sheet items for the times, then focuses the first one.
  function openRemind(): void {
    local.remindOpen = true;
    swapMenu(".remind-presets button");
  }

  function closeRemind(): Message | undefined {
    const message = actionMessage();
    const sheet = document.querySelector<HTMLDialogElement>("#message-sheet");
    const onSheet = !!sheet?.open;
    sheet?.close();
    closeMessageMenu(!onSheet);
    return message;
  }

  async function remindAt(when: string): Promise<void> {
    const message = closeRemind();
    if (message) await setReminder(`${when} ${reminderAbout(message.text || "", messageLink(message))}`);
  }

  // Custom… swaps the times for a date and time field, starting at the next full hour.
  function openRemindForm(): void {
    const now = Date.now();
    local.remindValue = localDateTimeValue(nextFullHour(now));
    local.remindMin = localDateTimeValue(now);
    local.remindMax = localDateTimeValue(now + REMIND_MAX_MS);
    local.remindError = "";
    local.remindForm = true;
    swapMenu(".remind-form input");
  }

  function remindBack(): void {
    local.remindForm = false;
    openRemind();
  }

  // A wall time without an offset parses as local time. Past or empty values stay in the form.
  async function remindCustom(): Promise<void> {
    const fireAt = new Date(local.remindValue).getTime();
    const now = Date.now();
    const error = !Number.isFinite(fireAt) || fireAt <= now ? "Pick a time in the future" : fireAt > now + REMIND_MAX_MS ? "Pick a time within a year" : "";
    if (error) { local.remindError = error; return; }
    const message = closeRemind();
    if (message) await setReminder(reminderAbout(message.text || "", messageLink(message)), fireAt);
  }

  function menuKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const menu = event.currentTarget as HTMLElement;
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button")].filter((button) => !button.disabled && button.getClientRects().length > 0);
    if (!items.length) return;
    const stop = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.key === "Escape") { stop(); closeMessageMenu(true); return; }
    // The date and time field uses the arrows and Home/End itself.
    if ((event.target as HTMLElement | null)?.tagName === "INPUT") return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") { stop(); items[(current + 1) % items.length]!.focus(); return; }
    if (event.key === "ArrowUp") { stop(); items[(current - 1 + items.length) % items.length]!.focus(); return; }
    if (event.key === "Home") { stop(); items[0]!.focus(); return; }
    if (event.key === "End") { stop(); items[items.length - 1]!.focus(); return; }
  }

  function requestDelete(message: Message): void {
    if (!canDelete(message)) return;
    openPopup();
    local.deleteCandidate = message.id;
    closeMessageMenu(false);
    const dialog = document.querySelector<HTMLDialogElement>("#delete-dialog");
    void nextTick(() => { if (dialog && !dialog.open) dialog.showModal(); });
  }

  function cancelDelete(): void {
    const candidate = core.messages.find((item: Message) => item.id === local.deleteCandidate);
    local.deleteCandidate = "";
    document.querySelector<HTMLDialogElement>("#delete-dialog")?.close();
    if (candidate) {
      const row = [...document.querySelectorAll<HTMLElement>(".msg[data-message-id]")].find((el) => el.dataset.messageId === candidate.id);
      row?.querySelector<HTMLElement>(".message-more")?.focus();
    }
  }

  return Object.assign(local, {
    closeActions,
    toggleThreadMenu,
    toggleMenuAt,
    toggleReactionPicker,
    pickEmoji,
    closeReactionPicker,
    openReactionSearch,
    closeReactionSearch,
    reactionRows,
    reactionQueryChanged,
    reactWith,
    reactionSearchKeydown,
    popupAnchorStyles,
    pickerStyle,
    menuStyle,
    isInteractiveTarget,
    messageKeydown,
    pressStart,
    pressMove,
    pressEnd,
    pressCancel,
    pressContextMenu,
    closeMessageMenu,
    actionMessage,
    fromSheet,
    menuKeydown,
    requestDelete,
    cancelDelete,
    remindPresets: REMIND_PRESETS,
    openRemind,
    remindAt,
    openRemindForm,
    remindBack,
    remindCustom,
    confirmDelete, stamp, reset,
    init(): void {
      window.addEventListener("resize", viewportChanged);
      window.visualViewport?.addEventListener("resize", viewportChanged);
      window.visualViewport?.addEventListener("scroll", viewportChanged);
    },
    destroy(): void {
      reset();
      window.removeEventListener("resize", viewportChanged);
      window.visualViewport?.removeEventListener("resize", viewportChanged);
      window.visualViewport?.removeEventListener("scroll", viewportChanged);
    },
  });
}
