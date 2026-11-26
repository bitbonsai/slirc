// The dock badge counts only what the sidebar lists.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";

const { sidebarUnreadTotal } = await import("@client/store.ts");

test("a count for a conversation the sidebar does not list stays out of the badge", () => {
  const unread = { "room:#general": 2, "thread:#t-abc": 1, "room:#gone": 3 };
  const listed = new Set(["room:#general", "thread:#t-abc"]);
  expect(sidebarUnreadTotal(unread, (id) => listed.has(id), (id) => unread[id as keyof typeof unread] ?? 0)).toBe(3);
});

test("muted conversations add nothing", () => {
  const unread = { "room:#general": 2, "room:#muted": 4 };
  expect(sidebarUnreadTotal(unread, () => true, (id) => (id === "room:#muted" ? 0 : unread[id as keyof typeof unread]))).toBe(2);
});
