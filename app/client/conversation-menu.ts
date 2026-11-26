import { routeUrl } from "@client/navigation.ts";
import { placePopup, type OpenPopup } from "@client/popups.ts";
import { type ClientState } from "@client/client-state.ts";

export function createConversationMenu(reactive: <T extends object>(value: T) => T, { core, openPopup }: {
  core: Pick<ClientState, 'error' | 'note' | 'isDesktop'>;
  openPopup: OpenPopup;
}) {
  const local = reactive({
    starMenuId: "",
    navMenu: null as null | { id: string; kind: "room" | "dm" | "thread"; target: string; label: string; left: number; top: number },
    copyFlyout: null as null | { conversationId: string; target: string; left: number; top: number },
  });
  function close(): void { local.starMenuId = ""; local.navMenu = null; local.copyFlyout = null; }
  function openNavMenu(event: MouseEvent, id: string, kind: "room" | "dm" | "thread", target: string, label: string): void {
    if (local.starMenuId === id) { local.starMenuId = ""; local.navMenu = null; local.copyFlyout = null; return; }
    openPopup(close);
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = kind === "room" ? 192 : kind === "thread" ? 156 : 176, height = kind === "room" ? 192 : kind === "thread" ? 140 : 176;
    const position = placePopup({ left: rect.right - width, top: rect.top, right: rect.right, bottom: rect.bottom }, { width, height }, { left: 8, top: 8, right: innerWidth - 8, bottom: innerHeight - 8 }, 4);
    local.starMenuId = id;
    local.navMenu = { id, kind, target, label, left: position.left, top: position.top };
    local.copyFlyout = null;
  }

  async function copyThreadLink(): Promise<void> {
    if (!local.navMenu) return;
    try { await navigator.clipboard.writeText(new URL(routeUrl({ kind: "room", room: local.navMenu.target }), location.origin).href); }
    catch { core.note = "Clipboard unavailable; copy the thread URL from the address bar."; }
    local.starMenuId = ""; local.navMenu = null;
  }

  function openCopyFlyout(event: MouseEvent, conversationId: string, target: string): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 176, left = rect.right + width + 8 > innerWidth ? rect.left - width : rect.right;
    local.copyFlyout = { conversationId, target, left: Math.max(8, left), top: Math.max(8, Math.min(rect.top - 4, innerHeight - 128)) };
  }

  async function copyChannelText(kind: "name" | "link"): Promise<void> {
    const flyout = local.copyFlyout;
    if (!flyout) return;
    try {
      let text = flyout.target;
      if (kind === "link") text = new URL(routeUrl({ kind: "room", room: flyout.target }), location.origin).href;
      await navigator.clipboard.writeText(text);
      core.note = kind === "link" ? "Channel link copied" : "Name copied";
    } catch (error) { core.error = error instanceof Error ? error.message : "Could not copy."; }
    local.copyFlyout = null; local.starMenuId = ""; local.navMenu = null;
  }

  return Object.assign(local, {
    openNavMenu,
    copyThreadLink,
    openCopyFlyout,
    copyChannelText,
    close,
    destroy: close,
    navMenuStyle: () => local.navMenu && core.isDesktop ? `left:${local.navMenu.left}px;top:${local.navMenu.top}px` : "",
    copyFlyoutStyle: () => local.copyFlyout ? `left:${local.copyFlyout.left}px;top:${local.copyFlyout.top}px` : "",
  });
}
