import { expect, test } from "bun:test";
import { emojify, setEmojiTable } from "../public/history.js";
import emojiRows from "../public/vendor/emoji.json" with { type: "json" };

// Real vendored table, same as the app fetches at runtime, so these tests
// exercise the actual shortcode set rather than a hand-picked fixture.
setEmojiTable(emojiRows);

test("replaces whole-token emoticons with emoji, leaving code and URLs alone", () => {
  expect(emojify("nice :) really :D")).toBe("nice \u{1F642} really \u{1F600}");
  expect(emojify(":-) at start, <3 mid, :P.")).toBe("\u{1F642} at start, ❤️ mid, \u{1F61B}.");
  expect(emojify("time 10:30 or a:b or (x:)")).toBe("time 10:30 or a:b or (x:)");
});

test("converts a known :shortcode: to emoji and leaves an unknown one typed", () => {
  expect(emojify("nice :tada: work")).toBe("nice \u{1F389} work");
  expect(emojify("still just :notreal: text")).toBe("still just :notreal: text");
});
