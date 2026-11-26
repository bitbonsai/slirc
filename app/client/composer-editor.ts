import { emojiContext, type EmojiSuggestion } from "@client/emoji.ts";
import { type createEmojiPicker } from "@client/emoji-picker.ts";
import { type createGiphyPicker } from "@client/giphy-picker.ts";
import { type Draft } from "@client/model.ts";
import { hasUnclosedCodeFence, linkPasteReplacement, listEnter, textSegments } from "@client/render.ts";
import { type SlashCommand } from "@client/commands.ts";
import { composerArrowUpTarget, composerRecallDirection, enterSends, fenceHtml, giphyPickerIntent } from "@client/presentation.ts";
import { Composer } from "@client/drafts.ts";
import { bindKeyboardDismiss } from "@client/keyboard-dismiss.ts";
import { type ClientState } from "@client/client-state.ts";

export function createComposerEditor(reactive: <T extends object>(value: T) => T, { core, nextTick, draftComposer, roomId, rememberText, updateDraftNavigation, send, cancelEdit, chooseCommand, closeGiphy, moveGiphy, onChatScroll, scrollToBottom, coarse, giphy, emoji, recallSent = () => false, onActivity, onBlur }: {
  core: Pick<ClientState, 'composer' | 'editingMessageId' | 'isDesktop' | 'mentionOpen' | 'slashOpen'>;
  nextTick: (callback?: () => void) => Promise<void>;
  draftComposer: () => Composer | null;
  roomId: () => string | null;
  rememberText: (text: string) => void;
  updateDraftNavigation: (draft: Draft) => void;
  send: () => Promise<void>;
  cancelEdit: () => void;
  chooseCommand: (command: SlashCommand) => void;
  closeGiphy: () => void;
  moveGiphy: (delta: number) => void;
  onChatScroll: () => void;
  scrollToBottom: (force: boolean) => void;
  coarse: boolean;
  giphy: Pick<ReturnType<typeof createGiphyPicker>, "giphyOpen" | "giphyResults" | "giphyError">;
  emoji: Pick<ReturnType<typeof createEmojiPicker>, "isOpen" | "move" | "dismiss" | "choose" | "reset" | "syncCaret" | "arm" | "cancel">;
  /** Alt+Up / Alt+Down: put an earlier sent message in the composer. True when it did. */
  recallSent?: (direction: -1 | 1) => boolean;
  /** Composer text changed: the typing owner throttles active and stops on empty. */
  onActivity: (text: string) => void;
  /** The composer lost focus: end our own typing state. */
  onBlur: () => void;
}) {
  let composerInputCaret: { input: HTMLElement; offset: number } | null = null;
  let cleanupLayout: (() => void) | null = null;
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  const local = reactive({
    composerTall: false,
    composerComposing: false,
  });

  function resizeComposer(): void {
    const input = document.querySelector<HTMLElement>("#input");
    if (!input) return;
    input.style.height = "auto";
    const height = Math.min(Math.max(input.scrollHeight, 24), 160);
    const next = `${height}px`;
    if (input.style.height !== next) input.style.height = next;
    local.composerTall = height > 24;
  }

  function composerInsideCodeFence(): boolean {
    const input = document.querySelector<HTMLElement>("#input");
    if (!input) return hasUnclosedCodeFence(String(core.composer ?? ""));
    const anchor = window.getSelection()?.anchorNode;
    if (anchor && input.contains(anchor) && (anchor instanceof Element ? anchor : anchor.parentElement)?.closest("pre")) return true;
    return hasUnclosedCodeFence(String(core.composer ?? ""));
  }

  function insertComposerNewline(): void {
    const input = document.querySelector<HTMLElement>("#input");
    if (!input) return;
    const before = serializeComposer(input);
    // On a list line the new line starts with the next marker; an empty item ends the list.
    const caret = composerSelectionOffset(input);
    const list = window.getSelection()?.isCollapsed && !composerInsideCodeFence() ? listEnter(before, caret) : null;
    if (list && list.end > list.start) {
      // Select the empty item by characters: after a typed newline the DOM holds <br>/<div>, so
      // source offsets do not map onto text nodes. The item itself is plain marker and spaces.
      const selection = window.getSelection()!;
      for (let i = caret; i < list.end; i++) selection.modify("move", "forward", "character");
      for (let i = list.start; i < list.end; i++) selection.modify("extend", "backward", "character");
    }
    const insert = list ? list.insert : "\n";
    document.execCommand(insert ? "insertText" : "delete", false, insert);
    if (serializeComposer(input) === before) {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : document.createRange();
      if (!selection?.rangeCount) { range.selectNodeContents(input); range.collapse(false); }
      range.deleteContents();
      if (insert) {
        const added = document.createTextNode(insert);
        range.insertNode(added); range.setStartAfter(added);
      }
      range.collapse(true);
      selection?.removeAllRanges(); selection?.addRange(range);
    }
    if (serializeComposer(input) !== String(core.composer ?? "")) onInput({ target: input } as unknown as Event);
  }

  function composerKeydown(event: KeyboardEvent): void {
    emoji.cancel();
    if (!event.isComposing && (event.metaKey || event.ctrlKey)) {
      const key = event.key.toLowerCase();
      const marker = !event.altKey && !event.shiftKey ? key === "b" ? "**" : key === "i" ? "*" : "" : "";
      const code = event.altKey && event.code === "KeyC" && !event.getModifierState("AltGraph");
      if (marker || code) {
        event.preventDefault();
        formatComposerSelection(code ? "`" : marker);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
      return;
    }
    // The open Giphy picker owns Enter: it picks the highlighted GIF, or swallows Enter when there
    // is nothing to pick, so a `/giphy …` draft can never send as a plain message. Arrows move the
    // horizontal selection; IME composition and modifiers are left alone.
    if (giphy.giphyOpen) {
      const intent = giphyPickerIntent(event, giphy.giphyResults.length);
      if (intent) {
        event.preventDefault();
        if (intent === "close") closeGiphy();
        else if (intent === "prev") moveGiphy(-1);
        else if (intent === "next") moveGiphy(1);
        else if (intent === "pick") window.dispatchEvent(new CustomEvent("slirc:giphy-pick"));
        return;
      }
    }
    // The mention list owns Enter/arrows while open, the same way the slash list does.
    if (core.mentionOpen && !event.isComposing) {
      if (event.key === "ArrowDown") { event.preventDefault(); window.dispatchEvent(new CustomEvent("slirc:mention-move", { detail: { delta: 1 } })); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); window.dispatchEvent(new CustomEvent("slirc:mention-move", { detail: { delta: -1 } })); return; }
      if (event.key === "Escape") { event.preventDefault(); window.dispatchEvent(new CustomEvent("slirc:mention-dismiss")); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); window.dispatchEvent(new CustomEvent("slirc:mention-choose")); return; }
    }
    // The slash component owns the highlight; the composer forwards narrow key intents and reads
    // only the shared openness flag for its ArrowUp behavior.
    if (core.slashOpen && !event.isComposing) {
      if (event.key === "ArrowDown") { event.preventDefault(); window.dispatchEvent(new CustomEvent("slirc:slash-move", { detail: { delta: 1 } })); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); window.dispatchEvent(new CustomEvent("slirc:slash-move", { detail: { delta: -1 } })); return; }
      // Escape hides the list without wiping the draft.
      if (event.key === "Escape") { event.preventDefault(); window.dispatchEvent(new CustomEvent("slirc:slash-dismiss")); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); window.dispatchEvent(new CustomEvent("slirc:slash-choose")); return; }
    }
    if (emoji.isOpen() && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); emoji.move(event.key === "ArrowDown" ? 1 : -1); return; }
      if (event.key === "Escape") { event.preventDefault(); emoji.dismiss(); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) { event.preventDefault(); emoji.choose(); return; }
    }
    // Escape while editing cancels and restores the previous draft.
    if (core.editingMessageId && event.key === "Escape" && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      cancelEdit();
      return;
    }
    // Alt+Up / Alt+Down walk your sent messages, shell style. Plain Up (below) selects a message.
    if (composerRecallDirection({
      key: event.key, isComposing: event.isComposing, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
      menuOpen: giphy.giphyOpen || core.slashOpen || core.mentionOpen || emoji.isOpen(),
    }) && recallSent(event.key === "ArrowUp" ? -1 : 1)) {
      event.preventDefault();
      return;
    }
    // Desktop ArrowUp from an empty composer (no open list, no IME, no modifier) enters the
    // newest message so the row handlers can take over.
    if (composerArrowUpTarget({
      isDesktop: core.isDesktop, key: event.key, isComposing: event.isComposing,
      ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
      text: String(core.composer ?? ""), menuOpen: giphy.giphyOpen || core.slashOpen || core.mentionOpen || emoji.isOpen(),
    }) && focusNewestMessage()) {
      event.preventDefault();
      return;
    }
    if (enterSends({ key: event.key, shiftKey: event.shiftKey, isComposing: event.isComposing, isDesktop: core.isDesktop }, composerInsideCodeFence())) {
      event.preventDefault();
      void send();
      return;
    }
    if (event.key === "Enter" && !event.isComposing && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      insertComposerNewline();
    }
  }

  function focusComposer(): void {
    document.querySelector<HTMLElement>("#input")?.focus();
  }

  function focusNewestMessage(): boolean {
    const rows = [...document.querySelectorAll<HTMLElement>(".msg[data-message-id]")];
    const newest = rows.at(-1);
    if (!newest) return false;
    newest.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
    newest.classList.add("kb-focus");
    newest.addEventListener("blur", () => newest.classList.remove("kb-focus"), { once: true });
    newest.scrollIntoView({ block: "nearest" });
    return true;
  }

  function serializeComposerChildren(parent: Node): string {
    const nodes = Array.from(parent.childNodes);
    let text = "";
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node instanceof HTMLElement && (node.tagName === "DIV" || node.tagName === "P")) {
        if (text && !text.endsWith("\n")) text += "\n";
        const emptyFinalBreak = i === nodes.length - 1 && node.childNodes.length === 1 && node.firstChild?.nodeName === "BR";
        if (!emptyFinalBreak) text += serializeComposerChildren(node);
        if (i < nodes.length - 1 && !text.endsWith("\n")) text += "\n";
      } else text += serializeComposerNode(node);
    }
    return text;
  }

  function serializeComposerNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
    if (!(node instanceof HTMLElement)) return serializeComposerChildren(node);
    const tag = node.tagName.toLowerCase();
    if (tag === "br") return "\n";
    if (tag === "pre") {
      const code = node.querySelector("code");
      const value = code?.textContent ?? node.textContent ?? "";
      if (node.dataset.markdown && value === node.dataset.originalCode) return node.dataset.markdown;
      const language = node.dataset.language || code?.getAttribute("language") || "";
      return `\`\`\`${language}\n${value}\n\`\`\``;
    }
    if (tag === "strong" || tag === "b") {
      if (node.dataset.markdown && node.textContent === node.dataset.originalText) return node.dataset.markdown;
      return `**${Array.from(node.childNodes, serializeComposerNode).join("")}**`;
    }
    if (tag === "em" || tag === "i") {
      if (node.dataset.markdown && node.textContent === node.dataset.originalText) return node.dataset.markdown;
      return `*${Array.from(node.childNodes, serializeComposerNode).join("")}*`;
    }
    if (tag === "code") {
      if (node.dataset.markdown && node.textContent === node.dataset.originalText) return node.dataset.markdown;
      return `\`${node.textContent ?? ""}\``;
    }
    if (tag === "a") {
      const href = node.getAttribute("href") || "";
      if (node.dataset.markdown && node.textContent === node.dataset.originalText && href === node.dataset.originalHref) return node.dataset.markdown;
      return `[${Array.from(node.childNodes, serializeComposerNode).join("")}](${href})`;
    }
    const children = Array.from(node.childNodes, serializeComposerNode).join("");
    return tag === "div" || tag === "p" ? children + (children.endsWith("\n") ? "" : "\n") : children;
  }

  function serializeComposer(input: Node): string {
    if (input.childNodes.length === 1 && (input.firstChild as Element).tagName === "BR") return "";
    return serializeComposerChildren(input);
  }

  function displayOffsetAtSource(text: string, offset: number): number {
    let source = 0;
    let display = 0;
    for (const segment of textSegments(text)) {
      const start = segment.sourceStart ?? source;
      if (offset < start) return display + offset - source;
      const raw = segment.raw ?? segment.text;
      const end = start + raw.length;
      if (offset <= end) {
        let local = offset - start;
        if (segment.format === "strong") local -= raw.startsWith("**") || raw.startsWith("__") ? 2 : 0;
        else if (segment.format === "em") local -= 1;
        else if (segment.format === "code") local -= 1;
        else if (segment.format === "fence") local -= Math.max(3, raw.indexOf("\n") + 1);
        else if (segment.href && raw.startsWith("[")) local -= 1;
        return display + Math.max(0, Math.min(segment.text.length, local));
      }
      source = end;
      display += segment.text.length;
    }
    return display + Math.max(0, offset - source);
  }

  function composerSelectionOffset(input: HTMLElement): number {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !input.contains(selection.anchorNode)) return serializeComposer(input).length;
    const before = document.createRange();
    before.selectNodeContents(input);
    before.setEnd(selection.anchorNode!, selection.anchorOffset);
    return serializeComposer(before.cloneContents()).length;
  }

  function setComposerSelection(input: HTMLElement, start: number, end = start): void {
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    let remainingStart = Math.max(0, start);
    let remainingEnd = Math.max(remainingStart, end);
    let startNode: Node | null = null, endNode: Node | null = null;
    let startOffset = 0, endOffset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.textContent?.length ?? 0;
      if (!startNode && remainingStart <= length) { startNode = node; startOffset = remainingStart; }
      if (!endNode && remainingEnd <= length) { endNode = node; endOffset = remainingEnd; break; }
      remainingStart -= length;
      remainingEnd -= length;
    }
    if (!startNode || !endNode) {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges(); selection?.addRange(range);
      return;
    }
    const selection = window.getSelection();
    if (startNode === endNode && startOffset === endOffset) {
      const format = startNode.parentElement?.closest("pre") ?? startNode.parentElement?.closest("strong, em, code");
      if (format && input.contains(format)) {
        const prefix = document.createRange();
        prefix.selectNodeContents(format); prefix.setEnd(startNode, startOffset);
        if (prefix.toString().length === (format.textContent?.length ?? 0)) {
          const outside = document.createRange();
          outside.setStartAfter(format); outside.collapse(true);
          selection?.removeAllRanges(); selection?.addRange(outside);
          // Chromium otherwise carries this inline style into the next typed character.
          const command = format.tagName === "STRONG" || format.tagName === "B" ? "bold" : format.tagName === "EM" || format.tagName === "I" ? "italic" : "removeFormat";
          document.execCommand(command);
          return;
        }
      }
    }
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    selection?.removeAllRanges(); selection?.addRange(range);
  }

  function focusComposerAtEnd(input: HTMLElement): void {
    input.focus({ preventScroll: true });
    setComposerSelection(input, input.textContent?.length ?? 0);
  }

  function renderComposerMarkdown(input: HTMLElement, text: string, caret?: number): void {
    const fragment = document.createDocumentFragment();
    for (const segment of textSegments(text)) {
      if (segment.format === "fence") {
        const pre = document.createElement("pre");
        pre.className = "fence";
        pre.dataset.markdown = segment.raw ?? "";
        pre.dataset.originalCode = segment.code ?? "";
        pre.dataset.language = segment.lang ?? "";
        pre.innerHTML = fenceHtml(segment);
        fragment.append(pre);
      } else if (segment.format) {
        const element = document.createElement(segment.format === "strong" ? "strong" : segment.format === "em" ? "em" : "code");
        element.textContent = segment.text;
        element.dataset.markdown = segment.raw ?? "";
        element.dataset.originalText = segment.text;
        fragment.append(element);
      } else if (segment.href && segment.raw?.startsWith("[")) {
        const link = document.createElement("a");
        link.href = segment.href;
        link.textContent = segment.text;
        link.dataset.markdown = segment.raw;
        link.dataset.originalText = segment.text;
        link.dataset.originalHref = segment.href;
        fragment.append(link);
      } else fragment.append(document.createTextNode(segment.text));
    }
    input.replaceChildren(fragment);
    if (caret !== undefined) setComposerSelection(input, caret);
  }

  function hasUnrenderedMarkdown(input: HTMLElement): boolean {
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest("strong, b, em, i, code, a, pre")) continue;
      if (textSegments(node.nodeValue ?? "").some((segment) => segment.format || (segment.href && segment.raw?.startsWith("[")))) return true;
    }
    return false;
  }

  function syncComposerEditor(): void {
    const input = document.querySelector<HTMLElement>("#input");
    const text = String(core.composer ?? "");
    if (!input || serializeComposer(input) === text) return;
    const caret = document.activeElement === input ? displayOffsetAtSource(text, composerSelectionOffset(input)) : undefined;
    renderComposerMarkdown(input, text, caret);
    resizeComposer();
  }

  function captureComposerCaret(event: Event): void {
    const input = event.currentTarget as HTMLElement;
    composerInputCaret = { input, offset: composerSelectionOffset(input) };
  }

  // Browsers put a caret that sits after an inline element at the end of a line back inside it, so
  // text typed after a closed `code`, **bold** or *italic* span lands in the span. Move what was typed
  // at the span's end into the plain text that follows, and keep the caret after it.
  function ejectTypedSuffix(input: HTMLElement): void {
    const selection = window.getSelection();
    const anchor = selection?.isCollapsed ? selection.anchorNode : null;
    if (!selection || !anchor || anchor.nodeType !== Node.TEXT_NODE) return;
    const format = anchor.parentElement?.closest<HTMLElement>("code, strong, em");
    if (!format || !input.contains(format) || format.closest("pre")) return;
    const original = format.dataset.originalText;
    const now = format.textContent ?? "";
    if (original === undefined || now === original || !now.startsWith(original)) return;
    const before = document.createRange();
    before.selectNodeContents(format); before.setEnd(anchor, selection.anchorOffset);
    if (before.toString().length !== now.length) return;
    const suffix = now.slice(original.length);
    format.textContent = original;
    let text = format.nextSibling;
    if (text?.nodeType === Node.TEXT_NODE) (text as Text).insertData(0, suffix);
    else { text = document.createTextNode(suffix); format.after(text); }
    const caret = document.createRange();
    caret.setStart(text, suffix.length); caret.collapse(true);
    selection.removeAllRanges(); selection.addRange(caret);
  }

  function onInput(event?: Event): void {
    const input = (event?.target as HTMLElement | null) ?? document.querySelector<HTMLElement>("#input");
    if (!input) return;
    if (!local.composerComposing) ejectTypedSuffix(input);
    const savedCaret = composerInputCaret?.input === input ? composerInputCaret.offset : null;
    composerInputCaret = null;
    const text = serializeComposer(input);
    core.composer = text;
    window.dispatchEvent(new CustomEvent("slirc:slash-reset"));
    if (giphy.giphyOpen) closeGiphy();
    if (!core.editingMessageId && roomId()) rememberText(text);
    // An edit is not a draft: it must not overwrite the conversation's saved draft or draft cache.
    if (!core.editingMessageId) {
      const composer = draftComposer();
      const conversationId = roomId();
      composer?.edit(text);
      if (composer && conversationId) updateDraftNavigation({ conversationId, revision: composer.revision ?? "", text, updatedAt: Date.now() });
    }
    if (!local.composerComposing && hasUnrenderedMarkdown(input)) {
      const sourceCaret = savedCaret ?? composerSelectionOffset(input);
      const caret = displayOffsetAtSource(text, sourceCaret);
      renderComposerMarkdown(input, text, caret);
    }
    emoji.reset(); emoji.syncCaret(); emoji.arm();
    resizeComposer();
    onActivity(text);
  }

  function composerBlur(): void { emoji.cancel(); onBlur(); }

  function chooseEmoji(row: EmojiSuggestion): void {
    const input = document.querySelector<HTMLElement>("#input");
    if (!input) return;
    const text = core.composer;
    const context = emojiContext(text, composerSelectionOffset(input));
    if (!context) return;
    const after = text.slice(context.end);
    const insert = row.emoji + (after.startsWith(" ") ? "" : " ");
    const updated = text.slice(0, context.start) + insert + after;
    renderComposerMarkdown(input, updated, displayOffsetAtSource(updated, context.start + insert.length));
    onInput({ target: input } as unknown as Event);
    input.focus({ preventScroll: true });
  }

  function pasteLink(event: ClipboardEvent): void {
    const input = event.currentTarget as HTMLElement | null;
    const pasted = event.clipboardData?.getData("text/plain");
    if (!input || typeof pasted !== "string") return;
    const selection = window.getSelection();
    const selected = selection?.toString() ?? "";
    const replacement = linkPasteReplacement(selected, 0, selected.length, pasted);
    event.preventDefault();
    const insert = replacement ?? pasted;
    if (!document.execCommand("insertText", false, insert)) {
      const range = document.createRange();
      if (selection?.rangeCount) range.setStart(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
      else { range.selectNodeContents(input); range.collapse(false); }
      if (selection?.rangeCount) range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
      range.deleteContents();
      const node = document.createTextNode(insert);
      range.insertNode(node);
      range.setStartAfter(node); range.collapse(true);
      selection?.removeAllRanges(); selection?.addRange(range);
      onInput({ target: input } as unknown as Event);
    }
  }

  function formatComposerSelection(marker: string): void {
    const input = document.querySelector<HTMLElement>("#input");
    if (!input?.isContentEditable) return;
    let selection = window.getSelection();
    if (!selection?.rangeCount || !input.contains(selection.anchorNode)) return;
    if (selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      const before = range.cloneRange(); before.selectNodeContents(input); before.setEnd(range.startContainer, range.startOffset);
      const offset = before.toString().length;
      const visible = input.textContent ?? "";
      const left = visible.slice(0, offset).match(/[\p{L}\p{N}_-]+$/u)?.[0] ?? "";
      const right = visible.slice(offset).match(/^[\p{L}\p{N}_-]+/u)?.[0] ?? "";
      if (!left && !right) return;
      setComposerSelection(input, offset - left.length, offset + right.length);
      selection = window.getSelection();
    }
    const selected = selection?.toString() ?? "";
    if (!selected) return;
    if (marker === "**") document.execCommand("bold");
    else if (marker === "*") document.execCommand("italic");
    else {
      const anchor = selection?.anchorNode;
      const inCode = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest("code");
      document.execCommand(inCode ? "insertText" : "insertHTML", false, inCode ? selected : `<code>${escapeHtml(selected)}</code>`);
    }
    if (serializeComposer(input) !== String(core.composer ?? "")) onInput({ target: input } as unknown as Event);
  }

  function escapeHtml(text: string): string {
    const element = document.createElement("span");
    element.textContent = text;
    return element.innerHTML;
  }

  function init(): void {
    const input = document.querySelector<HTMLElement>("#input");
    const composerEl = document.querySelector<HTMLElement>("#composer");
    const layout = (): void => {
      const vv = window.visualViewport;
      const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      document.documentElement.style.setProperty("--kb", `${kb}px`);
      // iOS pans the visual viewport up to keep the caret above the keyboard, which carries fixed
      // bars with it. The phone header shifts down by the same amount so Back stays on screen.
      document.documentElement.style.setProperty("--vv-top", `${vv ? Math.max(0, Math.round(vv.offsetTop)) : 0}px`);
      const focusing = !!input && document.activeElement === input;
      document.body.classList.toggle("kb-open", kb > 0 || (coarse && focusing));
      if (composerEl) {
        document.documentElement.style.setProperty("--composer-space", `${composerEl.getBoundingClientRect().height + kb + 16}px`);
      }
      resizeComposer();
      scrollToBottom(false);
    };
    const blur = (): void => { if (blurTimer !== null) clearTimeout(blurTimer); blurTimer = setTimeout(layout, 50); };
    const observers: ResizeObserver[] = [];
    let stopKeyboardDismiss: (() => void) | null = null;
    if (input && !core.isDesktop) {
      input.addEventListener("focus", layout);
      input.addEventListener("blur", blur);
      stopKeyboardDismiss = bindKeyboardDismiss(document);
    }
    window.visualViewport?.addEventListener("resize", layout);
    window.visualViewport?.addEventListener("scroll", layout);
    if (composerEl) { const observer = new ResizeObserver(layout); observer.observe(composerEl); observers.push(observer); }
    const list = document.querySelector<HTMLElement>("#messages");
    if (list) { const observer = new ResizeObserver(() => scrollToBottom(false)); observer.observe(list); observers.push(observer); }

    cleanupLayout = () => {
      input?.removeEventListener("focus", layout); input?.removeEventListener("blur", blur);
      stopKeyboardDismiss?.();
      window.visualViewport?.removeEventListener("resize", layout);
      window.visualViewport?.removeEventListener("scroll", layout);
      for (const observer of observers) observer.disconnect();
      if (blurTimer !== null) clearTimeout(blurTimer);
      blurTimer = null;
    };
    layout();
  }

  return Object.assign(local, {
    init,
    destroy(): void { cleanupLayout?.(); cleanupLayout = null; composerInputCaret = null; },
    resizeComposer,
    composerInsideCodeFence,
    insertComposerNewline,
    composerKeydown,
    focusComposer,
    focusNewestMessage,
    serializeComposerChildren,
    serializeComposerNode,
    serializeComposer,
    displayOffsetAtSource,
    composerSelectionOffset,
    setComposerSelection,
    focusComposerAtEnd,
    renderComposerMarkdown,
    hasUnrenderedMarkdown,
    syncComposerEditor,
    captureComposerCaret,
    onInput,
    composerBlur,
    chooseEmoji,
    pasteLink,
    formatComposerSelection,
    escapeHtml,

  });
}
