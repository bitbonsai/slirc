// "Reply in thread" opens a pending view before the server creates the child channel. Abandoning
// it (failure, or the reader leaving) hands the parent composer back without losing any text.
import { expect, test } from "bun:test";

const { pendingThreadFallbackText } = await import("@client/threads.ts");

test.each([
  ["keeps the parent draft and appends the typed reply", "parent draft", "thread reply", "parent draft\nthread reply"],
  ["with nothing typed restores the parent draft unchanged", "parent draft", "", "parent draft"],
  ["with only whitespace typed restores the parent draft unchanged", "parent draft", "  \n", "parent draft"],
  ["on an empty parent keeps only the typed reply", "", "thread reply", "thread reply"],
  ["with nothing on either side stays empty", "", "", ""],
])("an abandoned pending thread %s", (_name, parent, reply, expected) => {
  expect(pendingThreadFallbackText(parent, reply)).toBe(expected);
});
