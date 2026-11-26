import { expect, test } from "bun:test";
import { afterNick, matchesMention } from "../src/mention.ts";

test("matches a nick as @mention or standalone word, not inside another word", () => {
  expect(matchesMention("hey @mauricio", "mauricio")).toBe(true);
  expect(matchesMention("mauricio, look", "mauricio")).toBe(true);
  expect(matchesMention("mauricios note", "mauricio")).toBe(false);
});

test("drops the helper's own name, with or without the @ and an optional me", () => {
  expect(afterNick("@remind in 20m stretch", "remind")).toBe("in 20m stretch");
  expect(afterNick("remind in 20m stretch", "remind")).toBe("in 20m stretch");
  expect(afterNick("@remind me in 20m stretch", "remind")).toBe("in 20m stretch");
  expect(afterNick("@remind: list", "remind")).toBe("list");
  expect(afterNick("in 20m stretch", "remind")).toBe("in 20m stretch");
  expect(afterNick("reminder in 20m stretch", "remind")).toBe("reminder in 20m stretch");
});
