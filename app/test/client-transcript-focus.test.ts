// Back from a phone reply thread jumps to its parent with transcript.focus. Room message ids hold
// quotes (srv:["[\"room\",\"#dev-open\"]","…"]), so an unescaped id broke the row selector, the
// lookup threw, and the jump never happened.
import { afterEach, expect, test } from "bun:test";

const { createTranscript } = await import("../client/transcript.ts");

const real = { document: globalThis.document, CSS: (globalThis as { CSS?: unknown }).CSS, window: (globalThis as { window?: unknown }).window };
afterEach(() => { Object.assign(globalThis, real); });

test("focus finds a row whose message id contains quotes", () => {
  const id = 'srv:["[\\"room\\",\\"#dev-open\\"]","2smm555bjx2yvkijvm6v4hb8ns"]';
  const selectors: string[] = [];
  let scrolled = 0;
  const row = { classList: { add() {}, remove() {} }, scrollIntoView() { scrolled += 1; } };
  const chat = { scrollHeight: 2000, clientHeight: 800, scrollTop: 1200 };
  Object.assign(globalThis, {
    CSS: { escape: (value: string) => value.replace(/["\\[\]#:,]/g, (c) => "\\" + c) },
    window: { matchMedia: () => ({ matches: true }) },
    document: { querySelector: (selector: string) => {
      selectors.push(selector);
      if (selector === "#chat") return chat;
      if (selector.includes('"' + id + '"')) throw new SyntaxError("not a valid selector");
      return selector.startsWith(".msg[data-message-id=") ? row : null;
    }, querySelectorAll: () => [] },
  });
  const core = { messages: [{ id, serverId: "2smm555bjx2yvkijvm6v4hb8ns" }], threads: [], embeds: {}, currentConversationId: "room:#dev-open" };
  const transcript = createTranscript({ core: core as never, nextTick: async () => {}, authorized: () => [], stopped: () => false, linkOpen: () => false, closeLink: () => {} });
  transcript.focus("2smm555bjx2yvkijvm6v4hb8ns");
  expect(scrolled).toBe(1);
  expect(selectors.some((s) => s.startsWith(".msg[data-message-id=") && s.includes('\\"room'))).toBe(true);
});
