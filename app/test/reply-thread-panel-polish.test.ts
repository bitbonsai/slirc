import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClientState } from "@client/client-state.ts";
import { createMessageActions } from "@client/message-actions.ts";
import { createPopupOpener, menuUnderPlacement } from "@client/popups.ts";
import { type Message } from "@client/model.ts";

const root = join(import.meta.dir, "..");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const css = readFileSync(join(root, "public/style.css"), "utf8");
const runtime = readFileSync(join(root, "client/runtime.ts"), "utf8");
const panel = html.slice(html.indexOf('<aside id="reply-thread-panel"'), html.indexOf("</aside>", html.indexOf('<aside id="reply-thread-panel"')));
const head = panel.slice(panel.indexOf('<div class="reply-thread-head">'), panel.indexOf('<div class="reply-thread-stream"'));

describe("reply thread panel polish", () => {
  test("the open thread's parent row holds a steady link-style highlight", () => {
    expect(html).toContain("replyThreadRootId && message.serverId === replyThreadRootId && 'thread-open'");
    expect(css).toMatch(/\.msg\.thread-open, \.msg\.thread-open:hover \{ background: color-mix\(in srgb, var\(--brand\) 10%, transparent\); \}/);
    const rule = css.slice(css.indexOf(".msg.thread-open,"), css.indexOf("}", css.indexOf(".msg.thread-open,")));
    expect(rule).not.toContain("animation");
  });

  test("More sits left of the close chevron, same size, and opens the parent's message menu", () => {
    const more = head.indexOf("reply-thread-more");
    expect(more).toBeGreaterThan(-1);
    expect(more).toBeLessThan(head.indexOf('class="link-button reply-thread-close" x-show="isDesktop"'));
    expect(head).toMatch(/class="link-button reply-thread-close reply-thread-more"[^>]*aria-label="More message actions"[^>]*actions\.toggleMenuAt\(activeReplyThreadRoot\(\)\)/);
    // The menu is the panel's own copy, so it stacks with the panel instead of under it.
    expect(panel).toContain('<template x-teleport="body">');
    expect(panel).toContain('class="message-menu reply-thread-menu"');
    expect(panel).toContain('x-effect="actions.panelMenu && placeMenuUnder($el, $refs.more)"');
    expect(css).toMatch(/\.message-menu\.reply-thread-menu \{ position: fixed; z-index: var\(--z-floating\);/);
    // Threads do not nest: the panel's copy hides Reply in thread.
    expect(readFileSync(join(root, "partials/message-menu.html"), "utf8")).toContain('x-show="!activeThread && !notesOpen && !actions.panelMenu" x-on:click="openThreadForMessage(message)"');
    expect(panel).toContain('Copy link');
    expect(panel).toContain('x-show="actions.panelMenu && actions.actionMessageId === message?.id"');
    expect(html).toContain('x-show="actions.actionMessageId === message.id && !actions.panelMenu" class="message-menu"');
    expect(css).toMatch(/\.reply-thread-close \{ flex: 0 0 2\.25rem; width: 2\.25rem; height: 2\.25rem;/);
  });

  test("agent avatars in the panel are bare at the transcript's size", () => {
    for (const src of ["data:image/svg+xml", "/icons/agents/", "/icons/slirc.svg"]) {
      expect(css).toContain(`.reply-avatar:has(img[src^="${src}"])`);
    }
    expect(css).toMatch(/\.reply-avatar:has\(img\[src\^="\/icons\/slirc\.svg"\]\) \{ width: 2\.25rem; height: 2\.25rem; background: transparent; border-radius: 0; \}/);
    expect(css).toMatch(/\.reply-avatar:has\(img\[src\^="\/icons\/agents\/"\]\) > span[^{]*\{ display: none; \}/);
    expect(css).toMatch(/\.reply-row:has\(> \.reply-avatar img\[src\^="\/icons\/agents\/"\]\)[^{]*\{ grid-template-columns: 2\.25rem/);
    // Human avatars keep the filled 1.75rem circle.
    expect(css).toMatch(/\.reply-avatar \{[^}]*width: 1\.75rem;[^}]*border-radius: 50%;[^}]*background: var\(--avatar-fill\);/);
  });
});

test("the panel menu sits under the More button, right edge aligned, kept 8px from the screen edge", () => {
  expect(menuUnderPlacement({ right: 1000, bottom: 120 }, { width: 1024 })).toEqual({ right: 24, top: 124 });
  expect(menuUnderPlacement({ right: 1024, bottom: 120 }, { width: 1024 })).toEqual({ right: 8, top: 124 });
});

test("toggleMenuAt opens the panel's menu, and a second press closes it", () => {
  const core = createClientState(true, false);
  const actions = createMessageActions(<T extends object>(value: T) => value, {
    core, nextTick: async (cb?: () => void) => { cb?.(); }, openPopup: createPopupOpener(),
    canEdit: () => false, canDelete: () => false, startEdit() {}, quoteMessage() {}, openThreadForMessage: async () => {},
    chooseReaction() {}, focusComposer() {}, deleteMessage: async () => {}, focusAfterDelete() {},
  } as any);
  const message = { id: "m1", serverId: "s1" } as Message;
  actions.toggleMenuAt(message);
  expect(actions.actionMessageId).toBe("m1");
  expect(actions.panelMenu).toBe(true);
  actions.toggleMenuAt(message);
  expect(actions.actionMessageId).toBe("");
  expect(actions.panelMenu).toBe(false);
  actions.toggleThreadMenu(message); // the row's own menu is not the panel's
  expect(actions.panelMenu).toBe(false);
});
