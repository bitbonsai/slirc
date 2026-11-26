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

test("phone shows agents at the top of the DMs tab, not on Home", async () => {
  const mobile = await Bun.file(new URL("../partials/mobile-navigation.html", import.meta.url)).text();
  const home = mobile.split('data-phone-screen="home"')[1]!.split('data-phone-screen="dms"')[0]!;
  const dms = mobile.split('data-phone-screen="dms"')[1]!.split('data-phone-screen="more"')[0]!;
  expect(home).not.toContain("agentList()");
  expect(dms.indexOf("<span>Agents</span>")).toBeGreaterThan(-1);
  expect(dms.indexOf("<span>Agents</span>")).toBeLessThan(dms.indexOf("directList()"));
});

test("phone DMs tab orders Notes, Agents, People, Contacts, each section collapsible", async () => {
  const mobile = await Bun.file(new URL("../partials/mobile-navigation.html", import.meta.url)).text();
  const dms = mobile.split('data-phone-screen="dms"')[1]!.split('data-phone-screen="more"')[0]!;
  const order = ["<strong>Notes</strong>", "<span>Agents</span>", "<span>People</span>", "<span>Contacts</span>"].map((label) => dms.indexOf(label));
  expect(order.every((at) => at > -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(dms).toContain('x-on:click="peopleOpen = !peopleOpen"');
  expect(dms).toContain('x-on:click="contactsOpen = !contactsOpen"');
  const people = dms.slice(dms.indexOf('<div x-show="peopleOpen">'));
  expect(people.indexOf("directList()")).toBeGreaterThan(-1);
  expect(people.indexOf("groupList()")).toBeLessThan(people.indexOf("mobile-empty"));
  expect(dms.indexOf('<div x-show="contactsOpen">')).toBeLessThan(dms.indexOf("nick in contactList()"));
});
