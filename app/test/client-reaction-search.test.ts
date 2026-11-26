import { afterEach, expect, mock, test } from "bun:test";
import { createClientState } from "@client/client-state.ts";
import { reactionSearchRows } from "@client/emoji.ts";
import { createMessageActions, REACTION_GRID_COLUMNS } from "@client/message-actions.ts";
import { createPopupOpener } from "@client/popups.ts";
import { DEFAULT_REACTIONS } from "@client/presentation.ts";
import { type Message } from "@client/model.ts";

const custom = [{ name: "party_parrot", url: "/uploads/parrot?type=image", addedBy: "eve" }];
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown): void {
  if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
});

function key(name: string) {
  return { key: name, isComposing: false, preventDefault: mock(() => {}), stopPropagation: mock(() => {}) } as unknown as KeyboardEvent;
}

function setup() {
  const dialog = { close: mock(() => {}), open: false };
  const focused: string[] = [];
  const visible = (selector: string) => [{ getClientRects: () => [{}], focus: () => focused.push(selector) }];
  global("window", new EventTarget());
  global("document", {
    querySelector: (selector: string) => selector === "#message-sheet" ? dialog : null,
    querySelectorAll: (selector: string) => selector === ".reaction-search-input" || selector === ".reaction-search-open" ? visible(selector) : [],
  });
  const core = createClientState(true, false);
  const message = { id: "m1", serverId: "s1", state: "confirmed", text: "hi" } as Message;
  core.messages = [message];
  const chooseReaction = mock((_message: Message, _emoji: string) => {});
  const actions = createMessageActions((value) => value, {
    core, nextTick: async (callback) => { callback?.(); }, openPopup: createPopupOpener(), canEdit: () => false, canDelete: () => false,
    startEdit() {}, quoteMessage() {}, openThreadForMessage: async () => {}, chooseReaction, focusComposer() {},
    deleteMessage: async () => {}, focusAfterDelete() {}, messageLink: () => "", setReminder: async () => {}, customEmoji: () => custom,
  });
  return { actions, chooseReaction, dialog, focused, message };
}

test("Add reaction search starts with the presets and popular picks, then searches shortcodes and custom emoji", () => {
  const defaults = reactionSearchRows("", custom, DEFAULT_REACTIONS);
  expect(defaults.slice(0, DEFAULT_REACTIONS.length).map((row) => row.emoji)).toEqual([...DEFAULT_REACTIONS]);
  expect(defaults.slice(0, 2)).toEqual([{ code: "+1", emoji: "👍" }, { code: "heart", emoji: "❤️" }]);
  expect(new Set(defaults.map((row) => row.emoji)).size).toBe(defaults.length);
  expect(defaults.filter((row) => !row.code)).toEqual([]);
  expect(defaults.map((row) => row.emoji)).toContain("🎉");
  expect(defaults.at(-1)).toEqual({ code: "party_parrot", emoji: ":party_parrot:", image: custom[0]!.url, addedBy: "eve" });
  expect(reactionSearchRows("t", custom, DEFAULT_REACTIONS)).toEqual(defaults); // One letter is not a search yet.
  expect(reactionSearchRows(":tada:", [], DEFAULT_REACTIONS)[0]).toMatchObject({ code: "tada", emoji: "🎉" });
  expect(reactionSearchRows("parrot", custom, DEFAULT_REACTIONS)[0]).toMatchObject({ code: "party_parrot", emoji: ":party_parrot:", image: custom[0]!.url });
  expect(reactionSearchRows("face", [], DEFAULT_REACTIONS).length).toBeGreaterThan(8); // A grid, not the composer's eight rows.
  expect(reactionSearchRows("zzzzqq", custom, DEFAULT_REACTIONS)).toEqual([]);
});

test("desktop Add reaction focuses the field, moves through the grid and reacts through pickEmoji", () => {
  const { actions, chooseReaction, focused, message } = setup();
  actions.toggleReactionPicker(message);
  actions.openReactionSearch();
  expect(actions.reactionSearch).toBe(true);
  expect(focused).toEqual([".reaction-search-input"]);
  const rows = actions.reactionRows();
  actions.reactionSearchKeydown(key("ArrowRight"));
  expect(actions.reactionIndex).toBe(1);
  actions.reactionSearchKeydown(key("ArrowDown"));
  expect(actions.reactionIndex).toBe(1 + REACTION_GRID_COLUMNS);
  actions.reactionSearchKeydown(key("ArrowUp"));
  actions.reactionSearchKeydown(key("ArrowUp")); // Clamped at the first row.
  expect(actions.reactionIndex).toBe(0);
  actions.reactionSearchKeydown(key("ArrowRight"));
  const enter = key("Enter");
  actions.reactionSearchKeydown(enter);
  expect(enter.preventDefault).toHaveBeenCalled();
  expect(chooseReaction).toHaveBeenCalledWith(message, rows[1]!.emoji);
});

test("a typed search resets the highlight, keeps Left and Right in the field and reacts with a custom shortcode", () => {
  const { actions, chooseReaction, message } = setup();
  actions.toggleReactionPicker(message);
  actions.openReactionSearch();
  actions.reactionIndex = 3;
  actions.reactionQuery = "parrot";
  actions.reactionQueryChanged();
  expect(actions.reactionIndex).toBe(0);
  const left = key("ArrowLeft");
  actions.reactionSearchKeydown(left);
  expect(left.preventDefault).not.toHaveBeenCalled();
  actions.reactionSearchKeydown(key("Enter"));
  expect(chooseReaction).toHaveBeenCalledWith(message, ":party_parrot:");
});

test("Escape leaves the search for the presets and focuses the Add reaction button", () => {
  const { actions, chooseReaction, focused, message } = setup();
  actions.toggleReactionPicker(message);
  actions.openReactionSearch();
  actions.reactionQuery = "tada";
  const escape = key("Escape");
  actions.reactionSearchKeydown(escape);
  expect(escape.stopPropagation).toHaveBeenCalled(); // The picker's own Escape would close it.
  expect(actions.reactionSearch).toBe(false);
  expect(actions.reactionQuery).toBe("");
  expect(actions.openReactionId).toBe("m1");
  expect(focused.at(-1)).toBe(".reaction-search-open");
  expect(chooseReaction).not.toHaveBeenCalled();
});

test("the phone sheet reacts through fromSheet and closing the sheet ends the search", () => {
  const { actions, chooseReaction, dialog, message } = setup();
  actions.toggleThreadMenu(message); // Same state the long press sets.
  actions.openReactionSearch();
  actions.reactWith({ code: "tada", emoji: "🎉" });
  expect(dialog.close).toHaveBeenCalled();
  expect(chooseReaction).toHaveBeenCalledWith(message, "🎉");
  expect(actions.actionMessageId).toBe("");
  expect(actions.reactionSearch).toBe(false);
  actions.toggleThreadMenu(message);
  actions.openReactionSearch();
  actions.closeMessageMenu(false);
  expect(actions.reactionSearch).toBe(false);
});

// Arrow Up/Down step by REACTION_GRID_COLUMNS, so the CSS grid must lay out the same column count.
test("the reaction search grid has the column count the arrow keys step by", async () => {
  const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  expect(css).toContain(`grid-template-columns: repeat(${REACTION_GRID_COLUMNS}, 1fr)`);
});
