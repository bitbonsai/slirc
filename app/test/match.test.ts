// The shared typed-text matcher: start of text or start of any word, case-folded, prefix hits first.
import { expect, test } from "bun:test";
import { matchRank, rankMatches } from "../shared/match.ts";
import { foldIdentifier, foldText } from "../shared/fold.ts";

test("matchRank: 2 for a prefix, 1 for a word start, 0 otherwise", () => {
  expect(matchRank("b", "bit")).toBe(2);
  expect(matchRank("bc", "claude-bcdb")).toBe(1);
  expect(matchRank("dev", "#demo-dev")).toBe(1);
  expect(matchRank("dev", "demo-developer")).toBe(1);
  expect(matchRank("ev", "steve")).toBe(0);
  expect(matchRank("it", "bit")).toBe(0);
  expect(matchRank("ada b", "Ada Byron")).toBe(2);
  expect(matchRank("byr", "Ada Byron")).toBe(1);
});

test("matchRank folds case, takes the best of several fields, and matches an empty query", () => {
  expect(matchRank("BI", "bit")).toBe(2);
  expect(matchRank("bit", "claude-bcdb", "Bit")).toBe(2);
  expect(matchRank("bcd", "Bit", "claude-bcdb")).toBe(1);
  expect(matchRank("x", "claude-bcdb", undefined, null)).toBe(0);
  expect(matchRank("", "anything")).toBe(2);
});

test("rankMatches puts prefix hits first and keeps input order otherwise", () => {
  const rows = ["zed-bob", "carol", "bob", "dave-bobby", "bobby"];
  expect(rankMatches(rows, "bob", (row) => [row])).toEqual(["bob", "bobby", "zed-bob", "dave-bobby"]);
});

test("the two foldings", () => {
  expect(foldIdentifier("Ada[1]")).toBe("ada[1]");
  expect(foldIdentifier("Ada[1]", "rfc1459")).toBe("ada{1}");
  expect(["A", "B"].map((nick) => foldIdentifier(nick))).toEqual(["a", "b"]);
  expect(foldText("Émile")).toBe("émile");
});
