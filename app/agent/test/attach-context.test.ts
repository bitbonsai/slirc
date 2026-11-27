import { expect, test } from "bun:test";
import type { ParsedMessage } from "../../shared/irc.ts";
import { boundContext, CONTEXT_MAX_CHARS, CONTEXT_MAX_MESSAGES, MentionWatcher } from "../src/wait.ts";

const msg = (account: string, text: string, target = "#slirc", msgid = `m-${text}`, time = "2026-09-28T09:00:00.000Z"): ParsedMessage => ({
  command: "PRIVMSG",
  prefix: `${account}!u@example`,
  params: [target, text],
  tags: { account, msgid, time },
});

test("Ben's idea and Ben's mention stay context; only the owner's ask triggers", () => {
  const watcher = new MentionWatcher("pi-wolff", "wolff", (target) => target === "#slirc");
  expect(watcher.handle(msg("ben", "I have an idea for the editor", "#slirc", "b1"))).toBeUndefined();
  expect(watcher.handle(msg("ben", "@pi-wolff can you build it", "#slirc", "b2"))).toBeUndefined();
  const mention = watcher.handle(msg("wolff", "@pi-wolff implement Ben's idea", "#slirc", "w1"));
  expect(mention).toBeDefined();
  expect(mention!.text).toBe("@pi-wolff implement Ben's idea");
  expect(mention!.context.map((entry) => entry.text)).toEqual(["I have an idea for the editor", "@pi-wolff can you build it"]);
  expect(mention!.context.map((entry) => entry.account)).toEqual(["ben", "ben"]);
  expect(mention!.context.map((entry) => entry.messageId)).toEqual(["b1", "b2"]);
  expect(mention!.context[0].author).toBe("ben");
  expect(mention!.context[0].time).toBe("2026-09-28T09:00:00.000Z");
  expect(mention!.contextTruncated).toBe(false);
});

test("a spoofed nick with a different account tag cannot trigger", () => {
  const watcher = new MentionWatcher("pi-wolff", "wolff", () => true);
  const spoof = { command: "PRIVMSG", prefix: "wolff!u@h", params: ["#slirc", "@pi-wolff do it"], tags: { account: "ben", msgid: "s1", time: "t" } } as ParsedMessage;
  expect(watcher.handle(spoof)).toBeUndefined();
});

test("context from another room is not mixed into the trigger", () => {
  const watcher = new MentionWatcher("pi-wolff", "wolff", (target) => target === "#slirc" || target === "#other");
  watcher.handle(msg("ben", "unrelated chatter", "#other", "o1"));
  const mention = watcher.handle(msg("wolff", "@pi-wolff status", "#slirc", "w1"));
  expect(mention!.context).toEqual([]);
});

test("a room outside the allowlist neither triggers nor buffers context", () => {
  const watcher = new MentionWatcher("pi-wolff", "wolff", (target) => target === "#slirc");
  expect(watcher.handle(msg("wolff", "@pi-wolff hidden", "#other", "o1"))).toBeUndefined();
  const mention = watcher.handle(msg("wolff", "@pi-wolff status", "#slirc", "w1"));
  expect(mention!.context).toEqual([]);
});

test("the buffered owner request is delivered once, not on replay", () => {
  const watcher = new MentionWatcher("pi-wolff", "wolff", () => true);
  expect(watcher.handle(msg("wolff", "@pi-wolff once", "#slirc", "d1"))).toBeDefined();
  expect(watcher.handle(msg("wolff", "@pi-wolff once", "#slirc", "d1"))).toBeUndefined();
});

test("context is bounded by count and characters and marks truncation", () => {
  const watcher = new MentionWatcher("pi-wolff", "wolff", () => true);
  for (let i = 0; i < CONTEXT_MAX_MESSAGES + 5; i++) watcher.handle(msg("ben", `idea ${i}`, "#slirc", `c${i}`));
  const mention = watcher.handle(msg("wolff", "@pi-wolff go", "#slirc", "w1"));
  expect(mention!.context).toHaveLength(CONTEXT_MAX_MESSAGES);
  expect(mention!.context[0].text).toBe("idea 5");
  expect(mention!.contextTruncated).toBe(true);

  const long = Array.from({ length: 5 }, (_, i) => ({ messageId: `x${i}`, account: "ben", author: "ben", time: "t", text: "z".repeat(CONTEXT_MAX_CHARS / 2) }));
  const bounded = boundContext(long);
  expect(bounded.truncated).toBe(true);
  expect(bounded.context.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
});

test("owner can be triggered by account tag alone in the direct conversation", () => {
  const watcher = new MentionWatcher("pi-wolff", "wolff", () => true);
  const mention = watcher.handle({ command: "PRIVMSG", prefix: "wolff!u@h", params: ["pi-wolff", "no at-sign needed"], tags: { account: "wolff", msgid: "dm1", time: "t" } });
  expect(mention).toMatchObject({ room: "wolff", text: "no at-sign needed", msgid: "dm1" });
});
