import { expect, test } from "bun:test";
import { clearsDraft, conversationId, deliveryState, foldIdentifier, scopeKey, type QueueText } from "../client/model.ts";

test("identity, draft ownership, and delivery uncertainty contracts", () => {
  const scope = { instance: "https://slirc.example:443", accountId: "account-1", account: "alice" };
  expect(scopeKey(scope)).toBe(scopeKey({ ...scope, instance: "https://slirc.example" }));
  expect(scopeKey(scope)).not.toBe(scopeKey({ ...scope, accountId: "account-2" }));
  expect(scopeKey(scope)).not.toBe(scopeKey({ ...scope, instance: "https://other.example" }));
  expect(() => scopeKey({ ...scope, accountId: "" })).toThrow();
  expect(() => scopeKey({ ...scope, instance: "https://user:pass@slirc.example" })).toThrow();
  expect(foldIdentifier("ABC[\\]^", "ascii")).toBe("abc[\\]^");
  expect(foldIdentifier("ABC[\\]^", "rfc1459")).toBe("abc{|}~");
  expect(foldIdentifier("ABC[\\]^", "strict-rfc1459")).toBe("abc{|}^");
  expect(conversationId("room", "#Room")).toBe(conversationId("room", "#room"));
  expect(conversationId("dm", "account-2")).not.toBe(conversationId("room", "account-2"));

  const message = { id: "local-1", conversationId: "dm-1", authorAccount: "alice", authorNick: "Alice", text: "hello", time: "2026-09-27T10:00:00Z", state: "saving" as const };
  const send: QueueText = { message, operation: { id: "op-1", messageId: message.id, conversationId: message.conversationId, kind: "text", text: message.text, state: "queued", createdAt: 1 }, draftRevision: "edit-1" };
  const draft = { conversationId: "dm-1", revision: "edit-1", text: "hello", updatedAt: 1 };
  expect(clearsDraft(draft, send)).toBe(true);
  expect(clearsDraft({ ...draft, revision: "edit-2", text: "new text" }, send)).toBe(false);
  expect(clearsDraft({ ...draft, conversationId: "dm-2" }, send)).toBe(false);

  expect(deliveryState("saving", "persisted")).toBe("queued");
  expect(() => deliveryState("saving", "begin-send")).toThrow();
  expect(deliveryState("sending", "disconnected")).toBe("uncertain");
  expect(() => deliveryState("uncertain", "begin-send")).toThrow();
  expect(() => deliveryState("uncertain", "retry-failed")).toThrow();
  expect(deliveryState("uncertain", "confirmed")).toBe("confirmed");
  expect(deliveryState("uncertain", "explicit-resend-after-recovery")).toBe("queued");
  expect(() => deliveryState("confirmed", "begin-send")).toThrow();
});
