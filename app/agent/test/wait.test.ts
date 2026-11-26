import { describe, expect, test } from "bun:test";
import type { ParsedMessage } from "../../src/irc.ts";
import { mentionFrom, MentionWatcher } from "../src/wait.ts";

const privmsg = (account: string, text: string, target = "#slirc", tags: Record<string, string> = {}): ParsedMessage => ({
  command: "PRIVMSG",
  prefix: `${account}!user@example`,
  params: [target, text],
  tags: { account, msgid: `m-${text.length}`, ...tags },
});

describe("wait mention filter", () => {
  test("accepts owner mentions in rooms, threads, and direct messages", () => {
    expect(mentionFrom(privmsg("wolff", "@pi-wolff ship it"), "pi-wolff", "wolff")).toEqual({ room: "#slirc", from: "wolff", text: "@pi-wolff ship it", msgid: "m-17" });
    expect(mentionFrom(privmsg("wolff", "pi-wolff: status?", "#t-abc123"), "pi-wolff", "wolff")?.thread).toBe("#t-abc123");
    expect(mentionFrom(privmsg("wolff", "hi pi-wolff", "pi-wolff"), "pi-wolff", "wolff")?.room).toBe("wolff");
  });

  test("rejects other accounts, partial nicks, and messages without msgid", () => {
    expect(mentionFrom(privmsg("alice", "@pi-wolff do it"), "pi-wolff", "wolff")).toBeUndefined();
    expect(mentionFrom(privmsg("wolff", "pi-wolffish is someone else"), "pi-wolff", "wolff")).toBeUndefined();
    expect(mentionFrom(privmsg("wolff", "just chatting"), "pi-wolff", "wolff")).toBeUndefined();
    const untagged = privmsg("wolff", "@pi-wolff hello");
    delete untagged.tags.msgid;
    expect(mentionFrom(untagged, "pi-wolff", "wolff")).toBeUndefined();
    expect(mentionFrom({ command: "NOTICE", prefix: "wolff!u@h", params: ["#slirc", "@pi-wolff"], tags: { account: "wolff", msgid: "1" } }, "pi-wolff", "wolff")).toBeUndefined();
  });

  test("joins multiline batches before matching", () => {
    const watcher = new MentionWatcher("pi-wolff", "wolff");
    expect(watcher.handle({ command: "BATCH", params: ["+b1", "draft/multiline", "#slirc"], tags: { account: "wolff", msgid: "m-1" }, prefix: "wolff!u@h" })).toBeUndefined();
    expect(watcher.handle(privmsg("wolff", "@pi-wolff two things", "#slirc", { batch: "b1" }))).toBeUndefined();
    expect(watcher.handle(privmsg("wolff", "second line", "#slirc", { batch: "b1" }))).toBeUndefined();
    const mention = watcher.handle({ command: "BATCH", params: ["-b1"], tags: {}, prefix: "irc.example" });
    expect(mention).toMatchObject({ room: "#slirc", from: "wolff", text: "@pi-wolff two things\nsecond line", msgid: "m-1" });
    // The trigger itself is not repeated inside the context it carries.
    expect(mention?.context).toEqual([]);
  });
});

import { test as tDm, expect as eDm } from "bun:test";
import { mentionFrom as mentionFromDm } from "../src/wait.ts";
tDm("owner lines in the DM count without a mention", () => {
  const message = { command: "PRIVMSG", prefix: "wolff!u@h", params: ["#dm-claude-wolff-wolff", "summarize the session"], tags: { account: "wolff", msgid: "m1" } } as any;
  eDm(mentionFromDm(message, "claude-wolff", "wolff")?.room).toBe("#dm-claude-wolff-wolff");
  const other = { ...message, tags: { account: "ana", msgid: "m2" } };
  eDm(mentionFromDm(other, "claude-wolff", "wolff")).toBeUndefined();
  const room = { ...message, params: ["#slirc", "no mention here"] };
  eDm(mentionFromDm(room, "claude-wolff", "wolff")).toBeUndefined();
});
