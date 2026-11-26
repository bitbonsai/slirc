// Contacts start collapsed in the sidebar and on the phone DMs tab until the person opens them.
import { expect, test } from "bun:test";
import { createClientState } from "@client/client-state.ts";

test("contacts start collapsed on desktop and phone", () => {
  expect(createClientState(true, false).contactsOpen).toBe(false);
  expect(createClientState(false, true).contactsOpen).toBe(false);
});
