import { describe, expect, test } from "bun:test";
import { type Message } from "@client/model.ts";
import { broadcastParent, buildReplyIndex, isLegacyThreadAnnouncement, replyThreadReplies, replyThreadRoot, replyThreadSummary } from "@client/reply-threads.ts";
import { serializeOperation } from "@client/protocol.ts";

function msg(overrides: Partial<Message> & { id: string; text: string }): Message {
  return {
    conversationId: "room:#general",
    authorAccount: "alice",
    authorNick: "alice",
    time: "2026-11-24T10:00:00.000Z",
    state: "confirmed",
    ...overrides,
  };
}

describe("IRCv3 +reply threads", () => {
  test("old thread announcement lines are recognised so the transcript can hide them", () => {
    expect(isLegacyThreadAnnouncement(msg({ id: "a", text: "↳ thread #t-3fa921 — https://app.example/room?msg=m1" }))).toBe(true);
    expect(isLegacyThreadAnnouncement(msg({ id: "b", text: "see #t-3fa921 later" }))).toBe(false);
  });


  test("groups flat and nested +reply messages under their top-level root and hides non-broadcast replies", () => {
    const messages: Message[] = [
      msg({ id: "1", serverId: "m1", authorNick: "alice", text: "Root message", time: "2026-11-24T10:00:00.000Z" }),
      msg({ id: "2", serverId: "m2", authorNick: "bob", replyTo: "m1", text: "First reply", time: "2026-11-24T10:01:00.000Z" }),
      msg({ id: "3", serverId: "m3", authorNick: "carol", replyTo: "m2", text: "Nested IRC reply", time: "2026-11-24T10:02:00.000Z" }),
      msg({ id: "4", serverId: "m4", authorNick: "bob", replyTo: "m1", broadcast: true, text: "Also in channel", time: "2026-11-24T10:03:00.000Z" }),
      msg({ id: "5", serverId: "m5", authorNick: "dave", replyTo: "missing-root", text: "Orphan reply stays visible", time: "2026-11-24T10:04:00.000Z" }),
    ];

    const index = buildReplyIndex(messages);

    expect(index.hiddenMessageIds.has("2")).toBe(true);
    expect(index.hiddenMessageIds.has("3")).toBe(true);
    expect(index.hiddenMessageIds.has("4")).toBe(false); // broadcast stays in main feed
    expect(index.hiddenMessageIds.has("5")).toBe(false); // orphan stays visible

    const summary = replyThreadSummary(index, messages[0]!);
    expect(summary).toEqual({
      rootId: "m1",
      count: 3,
      participants: ["bob", "carol"],
      lastTime: "2026-11-24T10:03:00.000Z",
    });

    expect(replyThreadReplies(index, "m1").map((m) => m.id)).toEqual(["2", "3", "4"]);
    expect(replyThreadRoot(index, "m1")?.id).toBe("1");
    expect(broadcastParent(index, messages[3]!)?.id).toBe("1");
    expect(broadcastParent(index, messages[1]!)).toBeNull();
  });

  test("preserves replies when the root message was edited", () => {
    const messages: Message[] = [
      msg({ id: "1", serverId: "m1-edited", chain: ["m1"], authorNick: "alice", text: "Edited root" }),
      msg({ id: "2", serverId: "m2", authorNick: "bob", replyTo: "m1", text: "Reply to original id" }),
    ];

    const index = buildReplyIndex(messages);
    expect(replyThreadSummary(index, messages[0]!)?.count).toBe(1);
    expect(replyThreadReplies(index, "m1-edited").map((m) => m.id)).toEqual(["2"]);
  });

  test("ignores legacy #t- thread announcements", () => {
    const messages: Message[] = [
      msg({ id: "1", serverId: "m1", text: "Root" }),
      msg({ id: "2", serverId: "m2", clientId: "thread-announce:#t-abc123", replyTo: "m1", text: "↳ thread #t-abc123 — https://example.test" }),
    ];

    const index = buildReplyIndex(messages);
    expect(replyThreadSummary(index, messages[0]!)).toBeNull();
  });

  test("serializes +reply and +slirc/broadcast=1 on single-line and multiline sends", () => {
    const single = serializeOperation({
      id: "cid-1",
      messageId: "cid-1",
      conversationId: "room:#general",
      kind: "text",
      text: "Hello thread",
      replyTo: "m1",
      broadcast: true,
      state: "queued",
      createdAt: 1,
    }, "#general", true);
    expect(single).toEqual(["@+slirc/cid=cid-1;+reply=m1;+slirc/broadcast=1 PRIVMSG #general :Hello thread"]);

    const multi = serializeOperation({
      id: "cid-2",
      messageId: "cid-2",
      conversationId: "room:#general",
      kind: "text",
      text: "Line 1\nLine 2",
      replyTo: "m1",
      broadcast: true,
      state: "queued",
      createdAt: 1,
    }, "#general", true, () => "b1");
    expect(multi[0]).toBe("@+slirc/cid=cid-2;+reply=m1;+slirc/broadcast=1 BATCH +b1 draft/multiline #general");
  });
});
