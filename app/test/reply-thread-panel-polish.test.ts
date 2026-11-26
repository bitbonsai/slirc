import { expect, test } from "bun:test";
import { createClientState } from "@client/client-state.ts";
import { createMessageActions } from "@client/message-actions.ts";
import { createPopupOpener, menuUnderPlacement } from "@client/popups.ts";
import { type Message } from "@client/model.ts";

test("the panel menu sits under the More button, right edge aligned, kept 8px from the screen edge", () => {
  expect(menuUnderPlacement({ right: 1000, bottom: 120 }, { width: 1024 })).toEqual({ right: 24, top: 124 });
  expect(menuUnderPlacement({ right: 1024, bottom: 120 }, { width: 1024 })).toEqual({ right: 8, top: 124 });
});

test("toggleMenuAt opens the panel's menu, and a second press closes it", () => {
  const core = createClientState(true, false);
  const actions = createMessageActions(<T extends object>(value: T) => value, {
    core, nextTick: async (cb?: () => void) => { cb?.(); }, openPopup: createPopupOpener(),
    canEdit: () => false, canDelete: () => false, startEdit() {}, quoteMessage() {}, openThreadForMessage: async () => {},
    chooseReaction() {}, focusComposer() {}, deleteMessage: async () => {}, focusAfterDelete() {},
  } as any);
  const message = { id: "m1", serverId: "s1" } as Message;
  actions.toggleMenuAt(message);
  expect(actions.actionMessageId).toBe("m1");
  expect(actions.panelMenu).toBe(true);
  actions.toggleMenuAt(message);
  expect(actions.actionMessageId).toBe("");
  expect(actions.panelMenu).toBe(false);
  actions.toggleThreadMenu(message); // the row's own menu is not the panel's
  expect(actions.panelMenu).toBe(false);
});
