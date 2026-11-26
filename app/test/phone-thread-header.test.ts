import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const css = readFileSync(join(root, "public/style.css"), "utf8");
const runtime = readFileSync(join(root, "client/runtime.ts"), "utf8");
const panel = html.slice(html.indexOf('<aside id="reply-thread-panel"'), html.indexOf("</aside>", html.indexOf('<aside id="reply-thread-panel"')));
const head = panel.slice(panel.indexOf('<div class="reply-thread-head">'), panel.indexOf('<div class="reply-thread-stream"'));
const rootBlock = panel.slice(panel.indexOf('<div class="reply-thread-root"'), panel.indexOf('<div class="reply-thread-divider"'));
const phone = css.slice(css.indexOf("/* Phone thread:"), css.indexOf("}\n", css.indexOf(".reply-thread-divider::after")) + 2);

describe("phone reply thread header", () => {
  test("back arrow is the phone chevron the edge swipe presses, and returns to the parent", () => {
    expect(head).toMatch(/<button type="button" class="mobile-back reply-thread-back" x-show="!isDesktop"[^>]*x-on:click="backFromReplyThread\(\)"/);
    expect(head).toContain('<path d="m15 18-6-6 6-6"/>');
    expect(runtime).toMatch(/function backFromReplyThread\(\): void \{\s+const rootId = ui\.replyThreadRootId;\s+closeReplyThread\(\);\s+if \(rootId\) transcript\.focus\(rootId\);/);
  });

  test("title reads Thread plus the channel, with the lock pill for private channels on phones", () => {
    expect(head).toContain('<span class="room-mark channel reply-thread-lock" x-show="!isDesktop && !direct && !isOpenRoom(channel)" aria-hidden="true"><span class="lock-icon"></span></span>');
    expect(head).toContain("<strong>Thread</strong>");
    expect(head).toContain('<small x-text="roomLabel || channel"></small>');
    expect(phone).toContain('.reply-thread-title small::before { content: "· "; }');
  });

  test("desktop keeps its close button", () => {
    expect(head).toMatch(/class="link-button reply-thread-close" x-show="isDesktop"/);
  });

  test("phone header is the shared blurred header floating over the stream", () => {
    expect(phone).toContain("@media (max-width: 899px)");
    expect(phone).toMatch(/\.reply-thread-head \{ position: absolute;[^}]*min-height: var\(--header-h\);[^}]*backdrop-filter: var\(--blur-medium\);[^}]*translate: 0 var\(--vv-top, 0px\);/);
    expect(phone).toMatch(/\.reply-thread-stream \{ padding-top: calc\(var\(--header-h\)/);
  });
});

describe("phone reply thread parent message", () => {
  test("parent heads the stream with avatar, nick, time, text and attachments", () => {
    expect(panel.indexOf('<div class="reply-thread-root"')).toBeLessThan(panel.indexOf('<div class="reply-thread-divider"'));
    expect(rootBlock).toContain('class="reply-avatar"');
    expect(rootBlock).toContain('<strong x-text="message.authorNick"></strong>');
    expect(rootBlock).toContain('x-text="formatTime(message.time)"');
    expect(rootBlock).toContain("textSegments(messageText(message))");
    expect(rootBlock).toContain('<template x-if="!isDesktop"><div class="reply-root-media"><template x-for="(media, mi) in mediaView.messageMedia(message.text)"');
    // Same photo and GIF markup as the channel row, so the parent shows its attachments the same way.
    const body = readFileSync(join(root, "partials/message-body.html"), "utf8");
    const start = body.indexOf('<template x-for="(media, mi)');
    expect(rootBlock).toContain(body.slice(start, body.indexOf('<template x-for="(segment, n) in linkSegments', start)));
  });

  test("reply count sits on a ruled divider under the parent", () => {
    expect(panel).toContain("activeReplyThreadReplies().length === 1 ? '1 reply' : activeReplyThreadReplies().length + ' replies'");
    expect(phone).toMatch(/\.reply-thread-divider::after \{ content: ""; flex: 1; height: 1px; background: var\(--line\); \}/);
  });

});
