import { afterEach, expect, jest, mock, test } from "bun:test";
import { emojiContext, emojiSuggestions, emojiText, emojiTextSegments } from "@client/emoji.ts";
import { BROWSE_DELAY_MS, createEmojiPicker } from "@client/emoji-picker.ts";
import { createPopupOpener } from "@client/popups.ts";
import { queuedTextFor } from "@client/drafts.ts";
import { serializeOperation } from "@client/protocol.ts";

const custom = [{ name: "party_parrot", url: "/uploads/parrot?type=image", addedBy: "eve" }];

test("reuses standard shortcodes and emoticons without changing code, URLs or unknown names", () => {
  expect(emojiText("nice :clap: :CLAPS: :) :not_real:")).toBe("nice 👏 👏 🙂 :not_real:");
  const code = "`:clap:`\n```text\n:clap:\n```";
  expect(emojiText(code)).toBe(code);
  expect(emojiText("https://example.test/:clap: [label](https://example.test/:clap:)")).toBe("https://example.test/:clap: [label](https://example.test/:clap:)");
  expect(emojiText("**:clap:** and _:tada:_")).toBe("**👏** and _🎉_");
  expect(emojiText("\x01ACTION :clap:\x01")).toBe("\x01ACTION 👏\x01");
});

test("standard emoji are durable Unicode messages while drafts and custom shortcodes stay intact", () => {
  const snapshot = { text: ":claps: :party_parrot:", revision: "draft-r1" };
  const queued = queuedTextFor("room-a", "eve", { ...snapshot, text: emojiText(snapshot.text, custom) }, "cid-1", 1);
  expect(snapshot.text).toBe(":claps: :party_parrot:");
  expect(queued.draftRevision).toBe("draft-r1");
  expect(queued.message.text).toBe("👏 :party_parrot:");
  expect(queued.operation.text).toBe(queued.message.text);
  expect(serializeOperation(queued.operation, "#dev-test", true)).toEqual(["@+slirc/cid=cid-1 PRIVMSG #dev-test :👏 :party_parrot:"]);
});

test("renders custom emoji as images, falling back to the shortcode if it was removed", () => {
  expect(emojiTextSegments("Hi :party_parrot: :clap:", custom)).toMatchObject([
    { text: "Hi " }, { text: ":party_parrot:", emojiUrl: "/uploads/parrot?type=image" }, { text: " 👏" },
  ]);
  expect(emojiTextSegments(":party_parrot:", [])).toEqual([{ text: ":party_parrot:" }]);
  expect(emojiTextSegments("`:party_parrot:`", custom)[0]!.emojiUrl).toBeUndefined();
  const plural = [{ name: "claps", url: "/uploads/claps?type=image" }];
  expect(emojiText(":claps:", plural)).toBe(":claps:");
  expect(emojiSuggestions("clap", plural).filter((row) => row.code === "claps")).toEqual([{ code: "claps", emoji: ":claps:", image: plural[0]!.url, addedBy: undefined }]);
  expect(emojiTextSegments(":claps:", plural)).toEqual([{ text: ":claps:", emojiUrl: plural[0]!.url }]);
});

test("legacy ranking caps results and requires two characters before suggesting", () => {
  expect(emojiSuggestions("c")).toEqual([]);
  expect(emojiSuggestions("clap")[0]).toMatchObject({ code: "clap", emoji: "👏" });
  expect(emojiSuggestions("party", custom)[0]).toMatchObject({ code: "party_parrot", emoji: ":party_parrot:", image: custom[0]!.url });
  expect(emojiSuggestions("heart").length).toBeLessThanOrEqual(8);
});

test("emoji context follows the caret and ignores URLs, times and code", () => {
  expect(emojiContext("before :cl after", 10)).toEqual({ start: 7, end: 10, query: "cl" });
  expect(emojiContext("(:cl")).toEqual({ start: 1, end: 4, query: "cl" });
  for (const text of ["10:30", "https://example.test/:cl", "```\n:cl", "`code :cl"]) expect(emojiContext(text)).toBeNull();
});

test("emoji picker replaces other popups, wraps selection, inserts rather than sends and dismisses", () => {
  const core = { composer: ":clap" };
  const openPopup = createPopupOpener();
  const closeMenu = mock(() => {});
  const insert = mock(() => {});
  const picker = createEmojiPicker((value) => value, { core, openPopup, nextTick: async (fn) => { fn?.(); }, getCaret: () => core.composer.length, insert });
  openPopup(closeMenu);
  picker.sync();
  expect(closeMenu).toHaveBeenCalledTimes(1);
  picker.move(-1);
  expect(picker.index).toBe(picker.matches().length - 1);
  picker.syncCaret();
  expect(picker.index).toBe(0);
  picker.choose();
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ emoji: "👏" }));
  expect(picker.isOpen()).toBe(false);
  expect(core.composer).toBe(":clap");
  picker.reset(); picker.sync();
  openPopup(closeMenu);
  expect(picker.isOpen()).toBe(false);
  picker.destroy();
});

test("emoji picker teardown rejects a late custom-emoji response", async () => {
  const fetch = globalThis.fetch;
  let answer!: (response: Response) => void;
  globalThis.fetch = mock(() => new Promise<Response>((resolve) => { answer = resolve; })) as typeof fetch;
  try {
    const picker = createEmojiPicker((value) => value, { core: { composer: "" }, openPopup: createPopupOpener(), nextTick: async () => {}, getCaret: () => 0, insert() {} });
    picker.init.call({ $refs: {} });
    picker.destroy();
    answer(Response.json(custom));
    await Bun.sleep(0);
    expect(picker.custom).toEqual([]);
  } finally { globalThis.fetch = fetch; }
});

// A bare ':' opens the picker after a pause, so people learn emoji search exists.
function typing() {
  const core = { composer: "" };
  const insert = mock(() => {});
  const picker = createEmojiPicker((value) => value, { core, openPopup: createPopupOpener(), nextTick: async (fn) => { fn?.(); }, getCaret: () => core.composer.length, insert });
  const type = (text: string) => { core.composer = text; picker.reset(); picker.syncCaret(); picker.arm(); };
  return { core, picker, insert, type };
}

afterEach(() => { jest.useRealTimers(); });

test("a bare ':' opens the emoji picker after the pause and picking replaces the ':'", () => {
  jest.useFakeTimers();
  const { picker, insert, type } = typing();
  type("hi :");
  jest.advanceTimersByTime(BROWSE_DELAY_MS - 1);
  expect(picker.isOpen()).toBe(false);
  jest.advanceTimersByTime(1);
  expect(picker.isOpen()).toBe(true);
  expect(picker.matches().length).toBeGreaterThan(8);
  type("hi :t");
  expect(picker.isOpen()).toBe(true);
  expect(picker.matches().every((row) => row.code.startsWith("t"))).toBe(true);
  type("hi :tad");
  expect(picker.matches()[0]).toMatchObject({ code: "tada" });
  picker.choose();
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ emoji: "🎉" }));
  picker.destroy();
});

test("a letter, a keystroke or a caret move before the pause keeps the picker closed", () => {
  jest.useFakeTimers();
  const { core, picker, type } = typing();
  type(":"); type(":c");
  jest.advanceTimersByTime(BROWSE_DELAY_MS * 2);
  expect(picker.isOpen()).toBe(false);
  type(":"); picker.cancel();
  jest.advanceTimersByTime(BROWSE_DELAY_MS * 2);
  expect(picker.isOpen()).toBe(false);
  type("a :"); core.composer = "a : b";
  jest.advanceTimersByTime(BROWSE_DELAY_MS * 2);
  expect(picker.isOpen()).toBe(false);
  picker.destroy();
});

test("a ':' inside a time, a URL, a word or code never opens the picker", () => {
  jest.useFakeTimers();
  const { picker, type } = typing();
  for (const text of ["at 12:", "12:30", "https:", "https://example.test/:", "note:", "`code :", "```\n:"]) {
    type(text);
    jest.advanceTimersByTime(BROWSE_DELAY_MS * 2);
    expect(picker.isOpen()).toBe(false);
  }
  picker.destroy();
});

test("Esc closes the opened picker and leaves the ':' as typed", () => {
  jest.useFakeTimers();
  const { core, picker, insert, type } = typing();
  type("ok :");
  jest.advanceTimersByTime(BROWSE_DELAY_MS);
  expect(picker.isOpen()).toBe(true);
  picker.dismiss();
  expect(picker.isOpen()).toBe(false);
  expect(core.composer).toBe("ok :");
  expect(insert).not.toHaveBeenCalled();
  jest.advanceTimersByTime(BROWSE_DELAY_MS * 2);
  expect(picker.isOpen()).toBe(false);
  picker.destroy();
});
