import "./fixture.ts";
import { expect, test } from "bun:test";

process.env.SLIRC_HELPERS_ENABLED = "false";
const { pushUrl, isEdit, pushText, vapidContact } = await import("../src/slirc-bot.ts");

test("a notification opens its channel or thread, and a DM with its sender", () => {
  expect(pushUrl("#general")).toBe("/#general");
  expect(pushUrl("#t-abc123")).toBe("/#t-abc123");
  expect(pushUrl("#dm-1234abcd", "ada")).toBe("/dm/ada");
  expect(pushUrl("#DM-1234abcd", "Ben_2")).toBe("/dm/Ben_2");
  expect(pushUrl("#dm-1234abcd")).toBe("/");
  expect(pushUrl("#dm-1234abcd", "../x")).toBe("/");
  expect(pushUrl("bitbonsai", "ada")).toBe("/");
});

test("an edit sends no push: people already saw the message", () => {
  expect(isEdit({ "+draft/edit": "abc" })).toBe(true);
  expect(isEdit({ msgid: "abc" })).toBe(false);
});

test("push text shows an agent's display name for its @mention; people and removed agents keep the nick", () => {
  const names: Record<string, string> = { "pi-d6a3": "slirc.app" };
  const nameOf = (nick: string) => names[nick.toLowerCase()] ?? null;
  expect(pushText("@pi-d6a3 can you check this, @ada?", nameOf)).toBe("slirc.app can you check this, @ada?");
  expect(pushText("ask @PI-D6A3.", nameOf)).toBe("ask slirc.app.");
  expect(pushText("@pi-241e was removed", nameOf)).toBe("@pi-241e was removed");
  expect(pushText("mail me@pi-d6a3", nameOf)).toBe("mail me@pi-d6a3");
});

test("VAPID contact reads VAPID_CONTACT, falls back to RESEND_FROM, or returns null", () => {
  expect(vapidContact({})).toBeNull();
  expect(vapidContact({ VAPID_CONTACT: "mailto:ops@example.test" })).toBe("mailto:ops@example.test");
  expect(vapidContact({ RESEND_FROM: "Slirc <noreply@example.test>" })).toBe("mailto:noreply@example.test");
  expect(vapidContact({ RESEND_FROM: "noreply@example.test" })).toBe("mailto:noreply@example.test");
  expect(vapidContact({ RESEND_FROM: "not-an-email" })).toBeNull();
  expect(vapidContact({ VAPID_CONTACT: "https://example.test", RESEND_FROM: "noreply@example.test" })).toBe("https://example.test");
});
