// The classes of one message row: grouping with the row above, pending sends, the open menu or thread,
// action lines and notes.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { conversationId, type Message } from "../client/model.ts";

const { createTranscript } = await import("../client/transcript.ts");

const ROOM = conversationId("room", "#open-chat");
let seq = 0;
function row(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `r-${seq}`, conversationId: ROOM, serverId: `s-${seq}`, authorAccount: "bob", authorNick: "bob",
    text: "hi", time: new Date(Date.UTC(2026, 9, 8, 9, 0, seq)).toISOString(), state: "confirmed", ...overrides,
  };
}

function setup(messages: Message[], over: Record<string, unknown> = {}, menuOpenId = "") {
  const core = { messages, threads: [], embeds: {}, currentConversationId: ROOM, greeting: true, notesOpen: false, replyThreadRootId: "", replyThreadFaded: {}, ...over };
  const transcript = createTranscript({ core: core as never, nextTick: async () => {}, authorized: () => [], stopped: () => false, linkOpen: () => false, closeLink: () => {}, menuOpenId: () => menuOpenId });
  const classes = (index: number) => transcript.messageClass(messages[index]!, index).filter(Boolean);
  return { classes, core };
}

test("a row from the same person right after the last one continues it", () => {
  const { classes } = setup([row(), row()]);
  expect(classes(0)).toEqual([]);
  expect(classes(1)).toEqual(["cont"]);
});

test("a message still going out is pending", () => {
  for (const state of ["saving", "queued", "sending"]) expect(setup([row({ state })]).classes(0)).toEqual(["pending"]);
  expect(setup([row({ state: "failed" })]).classes(0)).toEqual([]);
});

test("the row whose menu or thread is open is marked, and a faded thread fades", () => {
  const messages = [row(), row({ authorAccount: "eve", authorNick: "eve" })];
  const { classes } = setup(messages, { replyThreadRootId: messages[1]!.serverId, replyThreadFaded: { [messages[1]!.serverId as string]: true } }, messages[0]!.id);
  expect(classes(0)).toEqual(["menu-open"]);
  expect(classes(1)).toEqual(["thread-open", "thread-fade"]);
});

test("an action line is marked and a note row is marked in the notes view", () => {
  const { classes, core } = setup([row({ text: "\x01ACTION waves\x01" }), row({ authorAccount: "eve", authorNick: "eve" })]);
  expect(classes(0)).toContain("action");
  expect(classes(1)).toEqual([]);
  core.notesOpen = true;
  expect(classes(1)).toEqual(["note"]);
});
