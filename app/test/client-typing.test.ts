// IRCv3 typing indicators: tag parsing, per-authorized-conversation receiver state, expiry, bounds,
// throttled local sending and cleanup. One file per process.
import { expect, test } from "bun:test";
import { createTypingIndicators, typingLine, typingValue } from "@client/typing.ts";
import { type IrcMessage } from "@client/irc.ts";

const identity = <T extends object>(value: T): T => value;

function make(overrides: Record<string, unknown> = {}) {
  let clock = 1_000;
  const sent: string[] = [];
  const authorized = new Set(["room-1"]);
  let current: string | null = "room-1";
  const typing = createTypingIndicators(identity, {
    self: () => "alice",
    isAuthorized: (id) => authorized.has(id),
    current: () => current,
    send: (value) => { sent.push(value); },
    now: () => clock,
    ...overrides,
  });
  return {
    typing, sent, authorized,
    at: (next: number) => { clock = next; },
    setCurrent: (id: string | null) => { current = id; },
  };
}

test("typing tags parse in spec order and reject junk", () => {
  expect(typingValue({ "+typing": "active" })).toBe("active");
  expect(typingValue({ "+draft/typing": "paused" })).toBe("paused");
  expect(typingValue({ "+typing": "active", "+draft/typing": "done" })).toBe("active");
  expect(typingValue({ "+typing": "typinging" })).toBeNull();
  expect(typingValue({})).toBeNull();
  expect(typingLine("#room", "done")).toBe("@+typing=done TAGMSG #room");
});

test("receiver state is per authorized conversation, deduped, and never shows self", () => {
  const { typing } = make();
  typing.observe("room-1", "bob", "active");
  typing.observe("room-1", "BOB", "active"); // same account, folded
  typing.observe("room-1", "alice", "active"); // self
  typing.observe("room-2", "carol", "active"); // unauthorized target
  expect(typing.accounts()).toEqual(["bob"]);
  expect(typing.statusText()).toBe("bob is typing");
  // paused/done clear immediately.
  typing.observe("room-1", "bob", "paused");
  expect(typing.accounts()).toEqual([]);
  typing.reset();
});

test("observeMessage reads the account tag and typing value", () => {
  const { typing } = make();
  typing.observeMessage("room-1", { command: "TAGMSG", tags: { account: "bob", "+typing": "active" } } as unknown as IrcMessage);
  expect(typing.accounts()).toEqual(["bob"]);
  typing.reset();
});

test("a helper bot types like a person: bot tag, no presence, cleared by its reply", () => {
  const { typing } = make();
  // Ergo marks +B senders with the bot tag; helpers have an account but never a presence dot.
  typing.observeMessage("room-1", { command: "TAGMSG", tags: { account: "help", bot: "", "+typing": "active" } } as unknown as IrcMessage);
  expect(typing.accounts()).toEqual(["help"]);
  expect(typing.statusText()).toBe("help is typing");
  typing.clear("room-1", "help");
  expect(typing.accounts()).toEqual([]);
  typing.observeMessage("room-1", { command: "TAGMSG", tags: { account: "remind", bot: "", "+typing": "active" } } as unknown as IrcMessage);
  typing.observeMessage("room-1", { command: "TAGMSG", tags: { account: "remind", bot: "", "+typing": "done" } } as unknown as IrcMessage);
  expect(typing.accounts()).toEqual([]);
  typing.reset();
});

test("more than maxTypers evicts the oldest account", () => {
  const { typing } = make({ maxTypers: 2 });
  typing.observe("room-1", "a", "active");
  typing.observe("room-1", "b", "active");
  typing.observe("room-1", "c", "active");
  expect(typing.accounts()).toEqual(["c", "b"]);
  typing.reset();
});

test("a stale typer expires on its own timer", async () => {
  const { typing } = make({ ttlMs: 20 });
  typing.observe("room-1", "bob", "active");
  expect(typing.accounts()).toEqual(["bob"]);
  await Bun.sleep(45);
  expect(typing.accounts()).toEqual([]);
  typing.reset();
});

test("local typing is throttled to one active per refresh window and stops with done", () => {
  const { typing, sent, at } = make({ refreshMs: 1_000 });
  typing.noteTyping("h");
  typing.noteTyping("he");
  expect(sent).toEqual(["active"]);
  at(2_001);
  typing.noteTyping("hey");
  expect(sent).toEqual(["active", "active"]);
  typing.stopTyping();
  typing.stopTyping();
  typing.noteTyping("");
  expect(sent).toEqual(["active", "active", "done"]);
  typing.reset();
});

test("idle local typing pauses once, then done", async () => {
  const { typing, sent } = make({ idleMs: 20 });
  typing.noteTyping("hi");
  expect(sent).toEqual(["active"]);
  await Bun.sleep(45);
  expect(sent).toEqual(["active", "paused"]);
  typing.stopTyping();
  expect(sent).toEqual(["active", "paused", "done"]);
  typing.reset();
});

test("reset clears received and local state without sending", () => {
  const { typing, sent } = make();
  typing.observe("room-1", "bob", "active");
  typing.noteTyping("hello");
  sent.length = 0;
  typing.reset();
  expect(typing.accounts()).toEqual([]);
  expect(sent).toEqual([]);
});

test("an agent typing shows its display name; people keep their account", () => {
  const names: Record<string, string> = { "pi-d6a3": "slirc.app" };
  const { typing } = make({ label: (account: string) => names[account] ?? account });
  typing.observe("room-1", "pi-d6a3", "active");
  expect(typing.statusText()).toBe("slirc.app is typing");
  expect(typing.label("pi-d6a3")).toBe("slirc.app");
  typing.observe("room-1", "bob", "active");
  expect(typing.statusText()).toBe("bob and slirc.app are typing");
  typing.reset();
});
