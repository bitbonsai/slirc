// Row logic shared by the desktop rail and the phone lists: which row is lit or dimmed, what a tap opens.
import { expect, test } from "bun:test";
import { conversationRowsComponent, type RowsScope } from "@client/conversation-rows.ts";

function scope(over: Partial<RowsScope> = {}) {
  const opened: string[] = [];
  const state: RowsScope = {
    direct: false, channel: "#open", isMuted: () => false, isStarred: () => false,
    conversationIdForDm: (channel) => "dm-" + channel, avatarStatusLabel: (nick) => nick + " is online",
    openDirect: (nick) => opened.push("dm:" + nick), openRoom: (target) => opened.push("room:" + target), ...over,
  };
  return { ...conversationRowsComponent(), ...state, opened } as ReturnType<typeof conversationRowsComponent> & RowsScope & { opened: string[] };
}
const room = { kind: "room", wireTarget: "#open", conversationId: "c1" };
const dm = { kind: "dm", nick: "ben", channel: "ben", conversationId: "dm-ben" };

test("only the open conversation is lit, and a DM never lights a room", () => {
  const inRoom = scope();
  expect(inRoom.channelClass(room)).toEqual(["active", false]);
  expect(inRoom.dmClass(dm)).toEqual([false, false]);
  const inDm = scope({ direct: true, channel: "ben" });
  expect(inDm.dmClass(dm)).toEqual(["active", false]);
  expect(inDm.channelClass(room)).toEqual([false, false]);
  expect(inDm.starredClass(dm)).toEqual(["active", false]);
  expect(inRoom.starredClass(room)).toEqual(["active", false]);
});

test("a muted conversation is dimmed on the rail", () => {
  const muted = scope({ isMuted: (target) => ["#open", "dm:dm-ben"].includes(target) });
  expect(muted.channelClass(room)[1]).toBe("muted-room");
  expect(muted.dmClass(dm)[1]).toBe("muted-room");
  expect(muted.starredClass({ ...dm })[1]).toBe("muted-room");
});

test("phone rows light nothing; only muted DMs dim", () => {
  const muted = scope({ isMuted: (target) => target === "dm:dm-ben", direct: true, channel: "ben" });
  expect(muted.dmPhoneClass(dm)).toBe("muted-room");
  expect(muted.starredPhoneClass(dm)).toBe("muted-room");
  expect(muted.starredPhoneClass(room)).toBe(false);
  expect(scope().dmPhoneClass(dm)).toBe(false);
});

test("a starred row opens as a DM or a room", () => {
  const rows = scope();
  rows.openStarred(dm);
  rows.openStarred(room);
  expect(rows.opened).toEqual(["dm:ben", "room:#open"]);
});

test("labels name the row and what a tap does", () => {
  const rows = scope({ isStarred: (id) => id === "c1" });
  expect(rows.starLabel("c1", "channel")).toBe("Unstar channel");
  expect(rows.starLabel("c2", "channel")).toBe("Star channel");
  expect(rows.rowTip("ben")).toBe("ben · ben is online");
  expect(rows.dmId(dm)).toBe("dm-ben");
  expect(rows.threadLabel({ title: "Plan", label: "#open", unread: 2 })).toBe("Open thread: Plan, #open, 2 unread");
  expect(rows.threadLabel({ title: "Plan", label: "#open", unread: 0 })).toBe("Open thread: Plan, #open");
});
