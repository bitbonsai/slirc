import { emojiContext, emojiSuggestions, reactionSearchRows, type CustomEmoji, type EmojiSuggestion } from "@client/emoji.ts";
import { type ClientState } from "@client/client-state.ts";
import { type OpenPopup } from "@client/popups.ts";

export const BROWSE_DELAY_MS = 500;

export function createEmojiPicker(reactive: <T extends object>(value: T) => T, { core, openPopup, nextTick, getCaret, insert }: {
  core: Pick<ClientState, "composer">;
  openPopup: OpenPopup;
  nextTick: (callback?: () => void) => Promise<void>;
  getCaret: () => number;
  insert: (row: EmojiSuggestion) => void;
}) {
  // browse holds the start of a bare ':' that waited BROWSE_DELAY_MS; it lists popular emoji
  // until letters reach the two the :shortcode suggestions need.
  const local = reactive({ index: 0, dismissed: false, caret: null as number | null, custom: [] as CustomEmoji[], browse: null as number | null });
  let list: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lifecycle = new AbortController();
  function context() {
    return emojiContext(core.composer, Math.min(local.caret ?? core.composer.length, core.composer.length));
  }
  function matches(): EmojiSuggestion[] {
    if (local.dismissed) return [];
    const found = context();
    if (!found) return [];
    if (local.browse === found.start && found.query.length < 2) {
      return reactionSearchRows("", local.custom, []).filter((row) => row.code && row.code.startsWith(found.query));
    }
    return emojiSuggestions(found.query, local.custom);
  }
  function cancel(): void { clearTimeout(timer); timer = undefined; }
  // Called after each input: a bare ':' where :shortcode would trigger opens the list after a pause.
  function arm(): void {
    cancel();
    const found = context();
    if (local.browse !== null && found?.start !== local.browse) local.browse = null;
    if (!found || found.query || local.browse !== null) return;
    const text = core.composer, caret = local.caret;
    timer = setTimeout(() => {
      timer = undefined;
      if (core.composer !== text || getCaret() !== caret) return;
      local.index = 0; local.dismissed = false; local.browse = found.start;
    }, BROWSE_DELAY_MS);
  }
  function dismiss(): void { cancel(); local.dismissed = true; local.browse = null; }
  function reset(): void { local.index = 0; local.dismissed = false; }
  function syncCaret(): void {
    const caret = getCaret();
    if (caret !== local.caret) { local.index = 0; cancel(); }
    local.caret = caret;
  }
  function sync(): void { if (matches().length) openPopup(dismiss); }
  function move(delta: number): void {
    const rows = matches();
    if (!rows.length) return;
    local.index = (local.index + delta + rows.length) % rows.length;
    void nextTick(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  }
  function choose(row?: EmojiSuggestion): void {
    const selected = row ?? matches()[local.index];
    if (!selected) return;
    insert(selected);
    dismiss(); local.index = 0;
  }
  return Object.assign(local, {
    matches, dismiss, reset, syncCaret, sync, move, choose, arm, cancel,
    isOpen: () => matches().length > 0,
    urlFor: (code: string) => local.custom.find((row) => `:${row.name}:` === code.toLowerCase())?.url,
    init(this: { $refs: { list?: HTMLElement } }): void {
      list = this.$refs.list ?? null;
      void fetch("/api/emoji", { credentials: "same-origin", cache: "no-store", signal: lifecycle.signal })
        .then((response) => response.ok ? response.json() : [])
        .then((rows) => {
          if (!lifecycle.signal.aborted && Array.isArray(rows)) local.custom = rows.filter((row) =>
            typeof row?.name === "string" && typeof row?.url === "string" && row.url.startsWith("/uploads/"));
        }).catch(() => { /* Standard emoji still work when the custom list is unavailable. */ });
    },
    destroy(): void { lifecycle.abort(); dismiss(); list = null; },
  });
}
