import "./fixture.ts";

process.env.APP_HOST = "app.slirc.org";

import { describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const rooms = await import("../src/rooms.ts");
const { observeReplyLine, replyThreadsFor } = await import("../src/reply-threads.ts");

function line(nick: string, target: string, msgid: string, time: string, text: string, reply?: string): string {
  return `@msgid=${msgid};time=${time}${reply ? `;+reply=${reply}` : ""} :${nick}!u@h PRIVMSG ${target} :${text}`;
}

db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#garden', 'alice', 'workspace', 1), ('#vault', 'alice', 'secret', 1)").run();
db.query("INSERT INTO channel_members (channel, nick) VALUES ('#vault', 'alice'), ('#vault', 'bob')").run();
rooms.joinWorkspaceChannel("bob", "#garden");
rooms.joinWorkspaceChannel("carol", "#garden");

describe("reply thread index", () => {
  test("indexes replies, flattens nested ones to the root and counts each msgid once", () => {
    const root = "r1";
    observeReplyLine(line("bob", "#garden", "m1", "2026-11-24T10:01:00.000Z", "first", root));
    observeReplyLine(line("carol", "#garden", "m2", "2026-11-24T10:02:00.000Z", "nested", "m1"));
    observeReplyLine(line("carol", "#garden", "m2", "2026-11-24T10:02:00.000Z", "nested", "m1")); // history replay
    const [thread] = replyThreadsFor("bob");
    expect(thread).toMatchObject({ rootId: root, channel: "#garden", replies: 2, lastBy: "carol", lastAt: "2026-11-24T10:02:00.000Z" });
    expect(thread!.others).toEqual(["2026-11-24T10:02:00.000Z"]);
    expect(replyThreadsFor("carol").map((row) => row.rootId)).toEqual([root]);
    expect(replyThreadsFor("dave")).toEqual([]);
  });

  test("the root's author gets the thread once the root line passes through", () => {
    expect(replyThreadsFor("alice").map((row) => row.rootId)).not.toContain("r1");
    observeReplyLine(line("Alice", "#garden", "r1", "2026-11-24T10:00:00.000Z", "start"));
    rooms.joinWorkspaceChannel("alice", "#garden");
    expect(replyThreadsFor("alice").map((row) => row.rootId)).toContain("r1");
  });

  test("lists newest activity first and ignores edits, tag-less lines and DMs of other targets", () => {
    observeReplyLine(line("bob", "#garden", "n1", "2026-11-25T09:00:00.000Z", "later", "r2"));
    observeReplyLine("@msgid=n2;+reply=r2;+draft/edit=n1 :bob!u@h PRIVMSG #garden :edited");
    observeReplyLine(":bob!u@h PRIVMSG #garden :no tags");
    observeReplyLine(line("bob", "bob", "n3", "2026-11-25T09:00:00.000Z", "query", "r3"));
    const rows = replyThreadsFor("bob");
    expect(rows.map((row) => row.rootId)).toEqual(["r2", "r1"]);
    expect(rows[0]!.replies).toBe(1);
  });

  test("lists only channels the person can read now, and leaving removes their threads", () => {
    observeReplyLine(line("bob", "#vault", "v1", "2026-11-25T10:00:00.000Z", "secret reply", "vr"));
    observeReplyLine(line("alice", "#vault", "vr", "2026-11-25T09:59:00.000Z", "secret root"));
    expect(replyThreadsFor("bob").map((row) => row.rootId)).toContain("vr");
    expect(replyThreadsFor("carol").map((row) => row.rootId)).not.toContain("vr");
    db.query("INSERT OR IGNORE INTO reply_thread_people (root_msgid, nick) VALUES ('vr', 'carol')").run();
    expect(replyThreadsFor("carol").map((row) => row.rootId)).not.toContain("vr"); // not a member
    expect(rooms.leaveChannel("bob", "#vault")).toBe(true);
    expect(replyThreadsFor("bob").map((row) => row.rootId)).not.toContain("vr");
    expect(replyThreadsFor("bob").map((row) => row.rootId)).toContain("r1");
    expect(rooms.leaveChannel("bob", "#garden")).toBe(true);
    expect(replyThreadsFor("bob")).toEqual([]);
    expect(replyThreadsFor("alice").map((row) => row.rootId)).toContain("vr");
  });

  test("a multiline opener counts as a reply", () => {
    observeReplyLine("@msgid=ml1;time=2026-11-25T11:00:00.000Z;+reply=r9 :carol!u@h BATCH +b1 draft/multiline #garden");
    expect(replyThreadsFor("carol").map((row) => row.rootId)).toContain("r9");
  });
});
