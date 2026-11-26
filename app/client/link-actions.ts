import { type Message } from "@client/model.ts";
import { actionBody, isActionText, textSegments } from "@client/render.ts";
import { placePopup, visualViewportRect, type OpenPopup } from "@client/popups.ts";
import { type ClientState } from "@client/client-state.ts";

export function createLinkActions(reactive: <T extends object>(value: T) => T, { core, nextTick, openPopup, canEdit, startEdit, setComposerSelection, displayOffsetAtSource }: {
  core: Pick<ClientState, 'composer' | 'messages'>;
  openPopup: OpenPopup;
  nextTick: (callback?: () => void) => Promise<void>;
  canEdit: (message: Message) => boolean;
  startEdit: (message: Message) => void;
  setComposerSelection: (input: HTMLElement, start: number, end: number) => void;
  displayOffsetAtSource: (text: string, offset: number) => number;
}) {
  let linkPopupInvoker: HTMLElement | null = null;
  const local = reactive({
    linkPopup: null as null | { messageId: string; href: string; raw: string; occurrence: number; rect: { top: number; left: number; right: number; bottom: number } },
  });

  // Right-click on desktop and long-press on the phone; a plain click opens the link itself.
  function openLinkPopup(anchor: HTMLElement, message: Message, segment: { href?: string; raw?: string; sourceStart?: number }): void {
    if (!segment.href) return;
    openPopup(dismissPopup);
    linkPopupInvoker = anchor;
    const raw = segment.raw || segment.href;
    const occurrence = textSegments((isActionText(message.text) ? actionBody(message.text) : message.text)).filter((item) =>
      (item.raw || item.href) === raw && (item.sourceStart ?? Infinity) < (segment.sourceStart ?? Infinity)).length;
    const rect = linkPopupInvoker.getBoundingClientRect();
    local.linkPopup = { messageId: message.id, href: segment.href, raw, occurrence, rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom } };
    void nextTick(() => { if (local.linkPopup) document.querySelector<HTMLElement>(".link-popover [data-first-action]")?.focus({ preventScroll: true }); });
  }

  function linkPopupMessage(): Message | null {
    return core.messages.find((message: Message) => message.id === local.linkPopup?.messageId) ?? null;
  }

  function linkPopupStyle(): string {
    const rect = local.linkPopup?.rect;
    if (!rect) return "display: none";
    const place = placePopup(rect, { width: 160, height: 44 }, visualViewportRect());
    return `position: fixed; top: ${place.top}px; left: ${place.left}px; bottom: auto; right: auto;`;
  }

  function closeLinkPopup(restoreFocus = true): void {
    local.linkPopup = null;
    const invoker = linkPopupInvoker;
    linkPopupInvoker = null;
    if (restoreFocus && invoker?.isConnected) invoker.focus({ preventScroll: true });
  }

  function dismissPopup(): void { closeLinkPopup(false); }

  function editMessageLink(messageId: string, raw: string, occurrence: number): void {
    const message = core.messages.find((item: Message) => item.id === messageId);
    if (!message || !canEdit(message)) return;
    closeLinkPopup(false);
    startEdit(message);
    void nextTick(() => {
      const input = document.querySelector<HTMLElement>("#input");
      if (!input) return;
      const text = String(core.composer ?? "");
      let start = -1, from = 0;
      for (let i = 0; i <= occurrence; i++) {
        start = text.indexOf(raw, from);
        if (start < 0) return;
        from = start + raw.length;
      }
      const labelStart = raw.startsWith("[") ? start + 1 : start;
      const labelEnd = raw.startsWith("[") ? start + raw.indexOf("](") : start + raw.length;
      input.focus({ preventScroll: true });
      setComposerSelection(input, displayOffsetAtSource(text, labelStart), displayOffsetAtSource(text, labelEnd));
    });
  }

  return Object.assign(local, {
    openLinkPopup,
    linkPopupMessage,
    linkPopupStyle,
    closeLinkPopup,
    editMessageLink,
    destroy: () => closeLinkPopup(false),
  });
}
