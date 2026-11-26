import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createClientState, type ClientSession } from "@client/client-state.ts";
import { createProfilePage } from "@client/profile-page.ts";
import { createGiphyPicker } from "@client/giphy-picker.ts";
import { createDevicePairing } from "@client/device-pairing.ts";
import { createChannelSettings } from "@client/channel-settings.ts";
import { createMessageActions, localDateTimeValue, nextFullHour, REMIND_PRESETS, reminderAbout, reminderQuote } from "@client/message-actions.ts";
import { createComposerEditor } from "@client/composer-editor.ts";
import { createConversationMenu } from "@client/conversation-menu.ts";
import { createLinkActions } from "@client/link-actions.ts";
import { createPopupOpener } from "@client/popups.ts";
import { slashHelpPanelComponent, mentionPickerComponent } from "@client/composer-pickers.ts";
import { type Message } from "@client/model.ts";
import { NOTES_CONVERSATION_ID } from "@client/navigation.ts";

const reactive = <T extends object>(value: T): T => value;
const nextTick = async (callback?: () => void) => { callback?.(); };
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown): void {
  if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(() => {
  mock.restore();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
});
function session(): ClientSession {
  return { scope: () => ({ instance: "https://slirc.test", accountId: "eve-id", account: "eve" }), key: () => "eve-id", stopped: () => false, signingOut: () => false };
}
function heldFetch() {
  let resolve!: (response: Response) => void;
  spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  return (body: unknown) => resolve(Response.json(body));
}

test("opening another popup replaces menus, reactions and links without stealing focus", async () => {
  global("innerWidth", 1024); global("innerHeight", 768);
  global("window", new EventTarget());
  global("document", { querySelector: () => null });
  const openPopup = createPopupOpener();
  const core = createClientState(true, false);
  const menus = createConversationMenu(reactive, { core, openPopup });
  const actions = createMessageActions(reactive, {
    core, nextTick, openPopup, canEdit: () => false, canDelete: () => false,
    startEdit() {}, quoteMessage() {}, openThreadForMessage: async () => {},
    chooseReaction() {}, focusComposer() {}, deleteMessage: async () => {}, focusAfterDelete() {},
  });
  const links = createLinkActions(reactive, {
    core, nextTick, openPopup, canEdit: () => false, startEdit() {},
    setComposerSelection() {}, displayOffsetAtSource: (_text, offset) => offset,
  });
  const focus = mock(() => {});
  const event = { currentTarget: { getBoundingClientRect: () => ({ top: 20, left: 10, right: 30, bottom: 40 }), focus, isConnected: true } } as unknown as MouseEvent;
  const message = { id: "m1", text: "https://example.test" } as Message;
  menus.openNavMenu(event, "room-a", "room", "#a", "a");
  menus.openCopyFlyout(event, "room-a", "#a");
  actions.toggleThreadMenu(message);
  expect(menus.navMenu).toBeNull();
  expect(menus.copyFlyout).toBeNull();
  expect(actions.actionMessageId).toBe("m1");
  actions.toggleThreadMenu(message);
  expect(actions.actionMessageId).toBe(""); // Same trigger still toggles closed.
  actions.toggleReactionPicker(message);
  expect(actions.openReactionId).toBe("m1");
  menus.openNavMenu(event, "room-a", "room", "#a", "a");
  expect(actions.openReactionId).toBe("");
  links.openLinkPopup(event.currentTarget as HTMLElement, message, { href: "https://example.test" });
  expect(menus.navMenu).toBeNull();
  actions.toggleThreadMenu(message);
  expect(links.linkPopup).toBeNull();
  expect(focus).not.toHaveBeenCalled();
  menus.openNavMenu(event, "room-a", "room", "#a", "a");
  menus.openNavMenu(event, "room-a", "room", "#a", "a");
  expect(menus.navMenu).toBeNull();
  actions.pressStart({ touches: [{ clientX: 0, clientY: 0 }] } as unknown as TouchEvent, message);
  menus.openNavMenu(event, "room-a", "room", "#a", "a");
  await Bun.sleep(450);
  expect(actions.actionMessageId).toBe(""); // Replacing a pending long press cancels its timer.
  openPopup();
  expect(menus.navMenu).toBeNull();
});

test("composer pickers replace other popups and stay dismissed until reset", () => {
  global("window", new EventTarget());
  const openPopup = createPopupOpener();
  const closeMenu = mock(() => {});
  const slash: any = slashHelpPanelComponent(openPopup);
  const mention: any = mentionPickerComponent(openPopup);
  Object.assign(slash, { composer: "/", $refs: {} });
  Object.assign(mention, { composer: "@b", roomMembers: ["ben"], account: "eve", $refs: {} });
  slash.init(); mention.init();
  openPopup(closeMenu);
  slash.sync();
  expect(closeMenu).toHaveBeenCalledTimes(1);
  slash.sync();
  expect(slash.dismissed).toBe(false);
  mention.sync();
  expect(slash.dismissed).toBe(true);
  expect(mention.dismissed).toBe(false);
  openPopup(closeMenu);
  expect(mention.dismissed).toBe(true);
  slash.sync(); mention.sync();
  expect(closeMenu).toHaveBeenCalledTimes(1);
  slash.reset(); slash.sync();
  expect(closeMenu).toHaveBeenCalledTimes(2);
  slash.destroy(); mention.destroy();
});

test("Profile save keeps edits made while its request was in flight", async () => {
  const core = createClientState(true, false);
  core.authenticated = true; core.account = "eve";
  const profile = createProfilePage(reactive, { core, nextTick, session: session(), setName: (name) => { core.me = name; } });
  profile.applyProfile({ badge: "focus" });
  profile.profileForm.fullName = "Submitted";
  const answer = heldFetch();
  const saving = profile.saveProfile();
  profile.profileForm.fullName = "Still typing";
  answer({ fullName: "Submitted", badge: "focus" });
  await saving;
  expect(profile.profileForm.fullName).toBe("Still typing");
  expect(profile.profileSaved.fullName).toBe("Submitted");
  expect(profile.profileForm.badge).toBe("focus");
  expect(profile.profileSaved.badge).toBe("focus");
  expect(profile.profileDirty()).toBe(true);
});

test("badge autosaves immediately without saving unrelated drafts; Online replaces Automatic", async () => {
  const core = createClientState(true, false);
  core.authenticated = true; core.account = "eve";
  const profile = createProfilePage(reactive, { core, nextTick, session: session(), setName() {} });
  profile.applyProfile({ fullName: "Eve", availability: "Out of office until Monday" });
  expect(profile.badgeOption().label).toBe("Online");
  expect(profile.badgeOptions.map((option) => option.label)).not.toContain("Automatic");
  profile.profileForm.fullName = "Still editing";
  profile.profileForm.about = "Unsaved bio";
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    expect(JSON.parse(options!.body as string)).toEqual({ badge: "vacation", accountId: "eve-id" });
    return Response.json({ fullName: "Eve", availability: "Out of office until Monday", badge: "vacation" });
  });
  const saving = profile.chooseBadge("vacation");
  expect(profile.badgeOption().emoji).toBe("🌴");
  expect(profile.badgeSaving).toBe(true);
  await saving;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(profile.profileSaved.badge).toBe("vacation");
  expect(profile.profileForm.fullName).toBe("Still editing");
  expect(profile.profileForm.about).toBe("Unsaved bio");
  expect(profile.profileDirty()).toBe(true);
  profile.resetProfile();
  expect(profile.profileForm.badge).toBe("available");
  expect(profile.profileSaved.badge).toBe("available");
});

test("rapid badge choices update immediately and write in order, with the latest choice winning", async () => {
  const core = createClientState(true, false);
  core.authenticated = true; core.account = "eve";
  const profile = createProfilePage(reactive, { core, nextTick, session: session(), setName() {} });
  const answers: ((response: Response) => void)[] = [];
  const writes: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((_url, options) => {
    writes.push(JSON.parse(options!.body as string).badge);
    return new Promise<Response>((resolve) => { answers.push(resolve); });
  });
  const saving = profile.chooseBadge("focus");
  await profile.chooseBadge("vacation");
  expect(profile.profileForm.badge).toBe("vacation");
  expect(writes).toEqual(["focus"]);
  await profile.saveProfile();
  expect(writes).toEqual(["focus"]); // Full-profile save cannot race the status write.
  answers[0]!(Response.json({ badge: "focus" }));
  await Bun.sleep(0);
  expect(writes).toEqual(["focus", "vacation"]);
  expect(profile.profileForm.badge).toBe("vacation");
  answers[1]!(Response.json({ badge: "vacation" }));
  await saving;
  expect(profile.profileSaved.badge).toBe("vacation");
  expect(profile.profileDirty()).toBe(false);
  expect(profile.badgeSaving).toBe(false);
});

test("failed badge autosave rolls back visibly; reset rejects a late response", async () => {
  const core = createClientState(true, false);
  core.authenticated = true; core.account = "eve";
  const profile = createProfilePage(reactive, { core, nextTick, session: session(), setName() {} });
  profile.applyProfile({ badge: "vacation" });
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "Not saved" }, { status: 500 }));
  const saving = profile.chooseBadge("focus");
  expect(profile.profileForm.badge).toBe("focus");
  await saving;
  expect(profile.profileForm.badge).toBe("vacation");
  expect(profile.badgeError).toBe("Not saved");
  expect(profile.badgeSaving).toBe(false);
  const lateAnswer = heldFetch();
  const late = profile.chooseBadge("busy");
  profile.resetProfile();
  lateAnswer({ badge: "busy" });
  await late;
  expect(profile.profileForm.badge).toBe("available");
  expect(profile.profileSaved.badge).toBe("available");
  expect(profile.badgeError).toBe("");
  expect(profile.badgeSaving).toBe(false);
});

test("GIF selection reset keeps search open; cancellation rejects its late response", async () => {
  global("window", new EventTarget());
  global("document", { querySelector: () => null });
  const core = createClientState(true, false);
  const enqueue = mock(async () => {});
  const picker = createGiphyPicker(reactive, { core, session: session(), openPopup: createPopupOpener(), roomId: () => "room-a", isAuthorized: () => true, queueConversationText: enqueue, saveNote: async () => {} });
  Object.assign(picker, { $refs: {} });
  (picker.init as () => void).call(picker);
  const answer = heldFetch();
  const searching = picker.searchGiphy("cats");
  expect(picker.giphyOpen).toBe(true);
  picker.resetSearch();
  answer({ gifs: [{ url: "https://example.test/not-sent.gif", preview: "https://example.test/preview.gif", title: "Fixture" }] });
  await searching;
  expect(picker.giphyOpen).toBe(false);
  expect(picker.giphyBusy).toBe(false);
  expect(picker.giphyResults).toEqual([]);
  expect(enqueue).not.toHaveBeenCalled();
  const secondSearch = picker.searchGiphy("dogs");
  answer({ gifs: [{ url: "https://example.test/not-sent.gif", preview: "https://example.test/preview.gif", title: "Fixture" }] });
  await secondSearch;
  expect(picker.giphyOpen).toBe(true);
  expect(picker.giphyResults).toHaveLength(1);
  expect(picker.giphyBusy).toBe(false);
  picker.destroy();
});

test("a GIF picked in Notes is saved as a note and never queued for IRC", async () => {
  global("window", new EventTarget());
  global("document", { querySelector: () => null });
  const core = createClientState(true, false);
  const enqueue = mock(async () => {});
  const saved: string[] = [];
  const picker = createGiphyPicker(reactive, { core, session: session(), openPopup: createPopupOpener(), roomId: () => NOTES_CONVERSATION_ID, isAuthorized: (id) => id === NOTES_CONVERSATION_ID, queueConversationText: enqueue, saveNote: async (text) => { saved.push(text); } });
  const answer = heldFetch();
  const searching = picker.searchGiphy("cats");
  answer({ gifs: [{ url: "https://media.giphy.com/media/x/giphy.gif", preview: "https://media.giphy.com/media/x/200.gif", title: "Cat" }] });
  await searching;
  await picker.chooseGiphy(picker.giphyResults[0]!);
  expect(saved).toEqual(["[Giphy: cats] https://media.giphy.com/media/x/giphy.gif"]);
  expect(enqueue).not.toHaveBeenCalled();
  expect(picker.giphyError).toBe("");
  picker.destroy();
});

test("pairing teardown invalidates an in-flight approval lookup", async () => {
  const core = createClientState(true, false);
  const pairing = createDevicePairing(reactive, { core, nextTick, session: session(), suspended: () => false, viewEpoch: () => 0, email: () => "" });
  pairing.pairLookupDraft = "123456";
  const answer = heldFetch();
  const lookup = pairing.lookupPair();
  pairing.stop();
  answer([{ code: "123456" }]);
  await lookup;
  expect(pairing.pendingPair).toBeNull();
  expect(pairing.approvalBusy).toBe(false);
});

test("agent request snapshots clear on stream loss and teardown, and old account streams cannot restore them", () => {
  const streams: any[] = [];
  global("location", { search: "" });
  global("EventSource", class extends EventTarget {
    constructor(_url: string) { super(); streams.push(this); }
    close() {}
  });
  const core = createClientState(true, false);
  core.authenticated = true;
  const received: any[] = [];
  const pairing = createDevicePairing(reactive, { core, nextTick, session: session(), suspended: () => false,
    viewEpoch: () => 0, email: () => "", onAgentRequests: (data) => received.push(data) });
  const snapshot = { accountId: "eve-id", requests: [{ channel: "#dm-a", messageId: "m1", state: "Queued" }] };
  const emit = (stream: EventTarget, data = snapshot) => stream.dispatchEvent(new MessageEvent("agent-requests", { data: JSON.stringify(data) }));
  pairing.authorize("eve-id");
  emit(streams[0]);
  expect(received.at(-1)).toEqual(snapshot);
  streams[0].dispatchEvent(new Event("error"));
  expect(received.at(-1)).toBeNull();
  emit(streams[0]);
  pairing.stop();
  expect(received.at(-1)).toBeNull();
  pairing.authorize("eve-id");
  const before = received.length;
  emit(streams[0]);
  expect(received).toHaveLength(before); // Even reopening the same account rejects the old stream.
  emit(streams[1], { ...snapshot, requests: [{ ...snapshot.requests[0], state: "Working" }] });
  expect(received.at(-1).requests[0].state).toBe("Working");
  pairing.authorize("other-id");
  const afterSwitch = received.length;
  emit(streams[1]);
  expect(received).toHaveLength(afterSwitch);
  expect(received.at(-1)).toBeNull();
  pairing.destroy();
});

test("cancelled channel settings cannot overwrite a later dialog or shared metadata", async () => {
  global("document", { querySelector: () => ({ open: false, showModal() {}, close() {} }) });
  const core = createClientState(true, false);
  core.channelDetails = [{ channel: "#a", topic: "Original", owner: "eve", visibility: "private" }];
  const prefs = createChannelSettings(reactive, { core, nextTick, session: session(), closeMenu: () => {} });
  prefs.openChannelSettings("#a");
  prefs.channelTopicDraft = "Submitted";
  const answer = heldFetch();
  const save = prefs.saveChannelSettings();
  prefs.closeChannelSettings();
  prefs.openChannelSettings("#a");
  prefs.channelTopicDraft = "New dialog";
  answer({ ...core.channelDetails[0], topic: "Submitted" });
  await save;
  expect(prefs.channelSettings).toBe("#a");
  expect(prefs.channelTopicDraft).toBe("New dialog");
  expect(core.channelDetails[0]!.topic).toBe("Original");
  expect(prefs.channelSettingsBusy).toBe(false);
});

test("channel settings saves only what changed, with one Save", async () => {
  global("document", { querySelector: () => ({ open: false, showModal() {}, close() {} }) });
  const core = createClientState(true, false);
  core.account = "eve"; core.isAdmin = false;
  core.channelDetails = [{ channel: "#a", topic: "T", owner: "eve", visibility: "secret", isGroup: false }];
  const calls: { url: string; body: unknown }[] = [];
  spyOn(globalThis, "fetch").mockImplementation((input: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), body });
    const info = { ...core.channelDetails[0]! };
    if (body.action === "open") info.visibility = "workspace";
    if (body.action === "topic") info.topic = body.topic;
    return Promise.resolve(Response.json(info));
  });
  const prefs = createChannelSettings(reactive, { core, nextTick, session: session(), closeMenu: () => {} });
  prefs.openChannelSettings("#a");
  expect(prefs.channelVisibility).toBe("secret");
  expect(prefs.canManageVisibility()).toBe(true);
  expect(prefs.channelSettingsDirty()).toBe(false);
  await prefs.saveChannelSettings();
  expect(calls).toEqual([]);

  // Visibility alone: one request, no topic write.
  prefs.pickVisibility("open");
  expect(prefs.visibilityHint()).toContain("will be able to");
  expect(prefs.channelSettingsDirty()).toBe(true);
  await prefs.saveChannelSettings();
  expect(calls).toEqual([{ url: "/api/channels/a", body: { action: "open", source: "app" } }]);
  expect(core.channelDetails[0]!.visibility).toBe("workspace");
  expect(prefs.channelSettings).toBe("");
  expect(prefs.channelSettingsBusy).toBe(false);

  // Both changed: visibility first, then the topic.
  calls.length = 0;
  prefs.openChannelSettings("#a");
  expect(prefs.visibilityHint()).toBe("Every verified member can find and join it, and read its history.");
  prefs.pickVisibility("secret");
  prefs.channelTopicDraft = "New";
  await prefs.saveChannelSettings();
  expect(calls.map((call) => (call.body as { action: string }).action)).toEqual(["secret", "topic"]);
  expect(core.channelDetails[0]!.topic).toBe("New");

  // A non-manager sees the current state but cannot change it.
  core.account = "bob"; core.isAdmin = false;
  prefs.openChannelSettings("#a");
  expect(prefs.canManageVisibility()).toBe(false);
  prefs.pickVisibility("open");
  expect(prefs.channelSettingsDirty()).toBe(false);

  // A private group carries no open/secret switch.
  core.account = "eve";
  core.channelDetails = [{ channel: "#g-1", topic: "", owner: "eve", visibility: "secret", isGroup: true }];
  prefs.openChannelSettings("#g-1");
  expect(prefs.channelIsGroup).toBe(true);
});

test("only admins see channel delete, never for the default channel, and it needs the typed name", async () => {
  global("document", { querySelector: () => ({ open: false, showModal() {}, close() {}, focus() {} }) });
  const core = createClientState(true, false);
  core.account = "eve"; core.isAdmin = false; core.defaultChannel = "#lobby";
  core.channelDetails = [
    { channel: "#a", topic: "", owner: "eve", visibility: "secret", isGroup: false },
    { channel: "#lobby", topic: "", owner: "eve", visibility: "workspace", isGroup: false },
  ];
  const calls: { url: string; method?: string }[] = [];
  spyOn(globalThis, "fetch").mockImplementation((input: any, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const deleted: string[] = [];
  const prefs = createChannelSettings(reactive, { core, nextTick, session: session(), closeMenu: () => {}, onDeleted: (channel) => deleted.push(channel) });
  prefs.openChannelSettings("#a");
  expect(prefs.canDeleteChannel()).toBe(false); // owner, not admin
  core.isAdmin = true;
  prefs.openChannelSettings("#lobby");
  expect(prefs.canDeleteChannel()).toBe(false);
  prefs.openChannelSettings("#a");
  expect(prefs.canDeleteChannel()).toBe(true);
  prefs.askDelete();
  expect(prefs.channelDeleteOpen).toBe(true);
  prefs.channelDeleteName = "#b";
  await prefs.deleteChannel();
  expect(calls).toEqual([]);
  prefs.channelDeleteName = "A";
  expect(prefs.deleteNameMatches()).toBe(true);
  await prefs.deleteChannel();
  expect(calls).toEqual([{ url: "/api/channels/a", method: "DELETE" }]);
  expect(deleted).toEqual(["#a"]);
  expect(prefs.channelSettings).toBe("");
});

test("phones get the desktop message actions in a long-press sheet", async () => {
  global("window", new EventTarget());
  global("getSelection", () => null);
  const dialog = { close: mock(() => {}), open: false, showModal() {} };
  global("document", { querySelector: (selector: string) => selector === "#message-sheet" || selector === "#delete-dialog" ? dialog : null, querySelectorAll: () => [] });
  const core = createClientState(false, true);
  const message = { id: "m1", serverId: "s1", state: "confirmed", text: "hi" } as Message;
  core.messages = [message];
  const startEdit = mock((_message: Message) => {});
  const openThreadForMessage = mock(async (_message: Message) => {});
  const chooseReaction = mock((_message: Message, _emoji: string) => {});
  const actions = createMessageActions(reactive, {
    core, nextTick, openPopup: createPopupOpener(), canEdit: () => true, canDelete: () => true,
    startEdit, quoteMessage() {}, openThreadForMessage, chooseReaction, focusComposer() {},
    deleteMessage: async () => {}, focusAfterDelete() {},
  });
  const touch = { touches: [{ clientX: 5, clientY: 5 }] } as unknown as TouchEvent;
  const lift = () => { const preventDefault = mock(() => {}); actions.pressEnd({ preventDefault } as unknown as TouchEvent); return preventDefault; };
  const menu = () => { const preventDefault = mock(() => {}); actions.pressContextMenu({ preventDefault } as unknown as Event); return preventDefault; };
  expect(menu()).not.toHaveBeenCalled(); // A right-click with no press keeps the browser menu.
  actions.pressStart(touch, message);
  expect(menu()).toHaveBeenCalledTimes(1); // Android's own long press must not start a selection.
  expect(lift()).not.toHaveBeenCalled(); // A quick tap stays a tap.
  expect(actions.actionMessageId).toBe("");
  const open = async () => { actions.pressStart(touch, message); await Bun.sleep(450); expect(actions.actionMessage()).toBe(message); };
  await open();
  expect(lift()).toHaveBeenCalledTimes(1); // Lifting the finger does not tap the new sheet.
  expect(menu()).toHaveBeenCalledTimes(1); // Nor does a late contextmenu once the sheet is up.
  actions.fromSheet(startEdit);
  expect(startEdit).toHaveBeenCalledWith(message);
  expect(dialog.close).toHaveBeenCalled(); // Closed before the handler so Edit can focus the composer.
  expect(actions.actionMessageId).toBe("");
  actions.toggleThreadMenu(message); // Same state the long press sets, without waiting again.
  actions.fromSheet(openThreadForMessage);
  expect(openThreadForMessage).toHaveBeenCalledWith(message);
  actions.toggleThreadMenu(message);
  actions.fromSheet((item) => chooseReaction(item, "👍"));
  expect(chooseReaction).toHaveBeenCalledWith(message, "👍");
  actions.toggleThreadMenu(message);
  actions.fromSheet(actions.requestDelete);
  expect(actions.deleteCandidate).toBe("m1");
  expect(actions.actionMessageId).toBe("");
  actions.cancelDelete();
  actions.toggleThreadMenu(message);
  actions.closeMessageMenu(false); // Outside tap or Escape.
  expect(actions.actionMessage()).toBeUndefined();
  const onPress = mock(() => {});
  actions.pressStart(touch, message, onPress); // A long press on a link opens the link menu instead.
  await Bun.sleep(450);
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(actions.actionMessageId).toBe("");
  expect(lift()).toHaveBeenCalledTimes(1); // Lifting the finger does not also follow the link.
});

test("the message sheet never starts Android's text selection or context menu", async () => {
  const sheet = await Bun.file(new URL("../partials/message-sheet.html", import.meta.url)).text();
  const transcript = await Bun.file(new URL("../partials/transcript.html", import.meta.url)).text() + await Bun.file(new URL("../partials/message-menu.html", import.meta.url)).text();
  const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  expect(sheet.slice(0, sheet.indexOf(">"))).toContain("x-on:contextmenu.prevent");
  expect(transcript).toContain('x-on:contextmenu="actions.pressContextMenu($event, message)"');
  expect(css).toContain(".sheet-modal { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }");
  expect(css).toContain(".sheet-modal input { user-select: text; -webkit-user-select: text; }");
});

test("a click opens a message link; right-click and long-press open the link menu", async () => {
  const segment = await Bun.file(new URL("../partials/message-segment.html", import.meta.url)).text();
  const link = segment.slice(0, segment.indexOf("</a>"));
  expect(link).toContain('target="_blank" rel="noopener noreferrer"');
  expect(link).toContain('x-on:click="if (segment.route) { $event.preventDefault(); openMessageLink(segment.href) }"');
  expect(link).toContain('x-on:contextmenu="if (!segment.route) { $event.preventDefault(); links.openLinkPopup($el, message, segment) }"');
  expect(link).toContain("actions.pressStart($event, message, () => links.openLinkPopup($el, message, segment))");
  expect(link).not.toContain("x-on:click.prevent");
});

test("a Remind me quote is one short line with no double quotes", () => {
  expect(reminderQuote("  ship\n the  build ")).toBe("ship the build");
  expect(reminderQuote('say "hi" and \u201cbye\u201d')).toBe("say 'hi' and 'bye'");
  const long = reminderQuote("word ".repeat(30));
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long).toEndWith("word\u2026");
  expect(reminderQuote("x".repeat(60))).toBe("x".repeat(60));
  expect(reminderAbout("hi", "https://slirc.test/dm/ada?msg=s1")).toBe('"hi" https://slirc.test/dm/ada?msg=s1');
  expect(reminderAbout("", "https://slirc.test/dm/ada?msg=s1")).toBe("https://slirc.test/dm/ada?msg=s1");
});

test("Remind me sets a preset reminder or a picked date and time from the menu and the sheet", async () => {
  global("window", new EventTarget());
  const dialog = { close: mock(() => { dialog.open = false; }), open: false };
  const focus = mock(() => {});
  const inputFocus = mock(() => {});
  global("document", {
    querySelector: (selector: string) => selector === "#message-sheet" ? dialog : null,
    querySelectorAll: (selector: string) => selector === ".remind-presets button" ? [{ getClientRects: () => [], focus() {} }, { getClientRects: () => [{}], focus }]
      : selector === ".remind-form input" ? [{ getClientRects: () => [], focus() {} }, { getClientRects: () => [{}], focus: inputFocus }] : [],
  });
  const core = createClientState(true, false);
  const message = { id: "m1", serverId: "s1", state: "confirmed", text: 'Ship the "beta" build' } as Message;
  core.messages = [message];
  const setReminder = mock(async (_text: string, _fireAt?: number) => {});
  const actions = createMessageActions(reactive, {
    core, nextTick, openPopup: createPopupOpener(), canEdit: () => false, canDelete: () => false,
    startEdit() {}, quoteMessage() {}, openThreadForMessage: async () => {}, chooseReaction() {}, focusComposer() {},
    deleteMessage: async () => {}, focusAfterDelete() {},
    messageLink: (item) => `https://slirc.test/?room=%23dev&msg=${item.serverId}`, setReminder,
  });
  const about = "\"Ship the 'beta' build\" https://slirc.test/?room=%23dev&msg=s1";

  for (const preset of REMIND_PRESETS) {
    actions.toggleThreadMenu(message);
    actions.openRemind();
    expect(actions.remindOpen).toBe(true);
    await actions.remindAt(preset.when);
    expect(setReminder).toHaveBeenLastCalledWith(`${preset.when} ${about}`);
    expect(actions.actionMessageId).toBe("");
    expect(actions.remindOpen).toBe(false);
  }
  expect(focus).toHaveBeenCalled(); // The first visible time takes focus.

  // Custom… opens the field at the next full hour, no earlier than now, and focuses it.
  actions.toggleThreadMenu(message);
  actions.openRemind();
  const opened = Date.now();
  actions.openRemindForm();
  await nextTick();
  expect(actions.remindForm).toBe(true);
  expect(actions.remindValue).toBe(localDateTimeValue(nextFullHour(opened)));
  expect(actions.remindMin).toBe(localDateTimeValue(opened));
  expect(inputFocus).toHaveBeenCalled();

  // Back returns to the times with the menu still open.
  focus.mockClear();
  actions.remindBack();
  await nextTick();
  expect(actions.remindForm).toBe(false);
  expect(actions.remindOpen).toBe(true);
  expect(actions.actionMessageId).toBe("m1");
  expect(focus).toHaveBeenCalled();

  // A past or empty value stays in the form with a message and sends nothing.
  actions.openRemindForm();
  for (const value of [localDateTimeValue(Date.now() - 60_000), ""]) {
    actions.remindValue = value;
    await actions.remindCustom();
    expect(actions.remindError).toBe("Pick a time in the future");
    expect(actions.remindForm).toBe(true);
  }
  actions.remindValue = localDateTimeValue(Date.now() + 400 * 86_400_000);
  await actions.remindCustom();
  expect(actions.remindError).toBe("Pick a time within a year");
  expect(setReminder).toHaveBeenCalledTimes(REMIND_PRESETS.length);

  // Phone: the sheet stays open for the field and closes when the time is set.
  dialog.open = true;
  const picked = nextFullHour(Date.now() + 86_400_000);
  actions.remindValue = localDateTimeValue(picked);
  await actions.remindCustom();
  expect(setReminder).toHaveBeenLastCalledWith(about, picked);
  expect(dialog.close).toHaveBeenCalled();
  expect(actions.actionMessage()).toBeUndefined();
  expect(actions.remindForm).toBe(false);

  actions.toggleThreadMenu(message);
  actions.openRemind();
  actions.closeMessageMenu(false); // Escape or an outside click.
  expect(actions.remindOpen).toBe(false);
  expect(setReminder).toHaveBeenCalledTimes(REMIND_PRESETS.length + 1);
});

test("the desktop menu is placed again on screen when Remind me swaps in the times or the taller form", async () => {
  // A row near the bottom right of a 1000x800 window, no anchor positioning, no composer.
  global("window", new EventTarget());
  global("innerWidth", 1000);
  global("innerHeight", 800);
  const row = { dataset: { messageId: "m1" }, querySelector: () => null, getBoundingClientRect: () => ({ top: 700, left: 900, right: 990, bottom: 724 }) };
  const menu = { offsetWidth: 160, offsetHeight: 120 };
  global("document", {
    querySelector: (selector: string) => selector === ".message-menu" ? menu : null,
    querySelectorAll: (selector: string) => selector === ".msg[data-message-id]" ? [row] : [],
  });
  const core = createClientState(true, false);
  const message = { id: "m1", serverId: "s1", state: "confirmed", text: "hi" } as Message;
  core.messages = [message];
  const actions = createMessageActions(reactive, {
    core, nextTick, openPopup: createPopupOpener(), canEdit: () => false, canDelete: () => false,
    startEdit() {}, quoteMessage() {}, openThreadForMessage: async () => {}, chooseReaction() {}, focusComposer() {},
    deleteMessage: async () => {}, focusAfterDelete() {}, messageLink: () => "https://slirc.test/", setReminder: async () => {},
  });
  const fits = () => {
    const style = actions.menuStyle();
    const top = Number(/top: (-?[\d.]+)px/.exec(style)![1]);
    const left = Number(/left: (-?[\d.]+)px/.exec(style)![1]);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + menu.offsetHeight).toBeLessThanOrEqual(800);
    expect(left + menu.offsetWidth).toBeLessThanOrEqual(1000);
  };
  actions.toggleThreadMenu(message);
  fits();

  for (const [swap, size] of [[() => actions.openRemind(), { offsetWidth: 170, offsetHeight: 160 }], [() => actions.openRemindForm(), { offsetWidth: 230, offsetHeight: 260 }], [() => actions.remindBack(), { offsetWidth: 170, offsetHeight: 160 }]] as const) {
    const revision = actions.viewportRevision;
    Object.assign(menu, size);
    swap();
    await nextTick();
    expect(actions.viewportRevision).toBeGreaterThan(revision); // menuStyle reads it, so the binding runs again.
    fits();
  }
});

test("the reaction picker sits against its button on a tall message, not below the whole row", () => {
  // A 400px row (a photo) with its add button on the first line, no anchor positioning, no composer.
  global("window", new EventTarget());
  global("innerWidth", 1000);
  global("innerHeight", 800);
  const button = { getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 100, left: 40, right: 72, bottom: 125 }) };
  const row = { dataset: { messageId: "m1" }, querySelector: (selector: string) => selector === ".message-add" ? button : null, getBoundingClientRect: () => ({ top: 92, left: 20, right: 980, bottom: 492 }) };
  const picker = { offsetWidth: 330, offsetHeight: 40 };
  global("document", {
    querySelector: (selector: string) => selector === ".reaction-picker" ? picker : null,
    querySelectorAll: (selector: string) => selector === ".msg[data-message-id]" ? [row] : [],
  });
  const core = createClientState(true, false);
  const message = { id: "m1", serverId: "s1", state: "confirmed", text: "photo" } as Message;
  core.messages = [message];
  const actions = createMessageActions(reactive, {
    core, nextTick, openPopup: createPopupOpener(), canEdit: () => false, canDelete: () => false,
    startEdit() {}, quoteMessage() {}, openThreadForMessage: async () => {}, chooseReaction() {}, focusComposer() {},
    deleteMessage: async () => {}, focusAfterDelete() {}, messageLink: () => "https://slirc.test/", setReminder: async () => {},
  });
  actions.toggleReactionPicker(message);
  const style = actions.pickerStyle();
  expect(Number(/top: (-?[\d.]+)px/.exec(style)![1])).toBe(131); // 6px under the button, not under the row at 492.
  expect(Number(/left: (-?[\d.]+)px/.exec(style)![1])).toBe(40);
});

test("message actions remove viewport listeners and clear their timers on teardown", () => {
  const viewport = new EventTarget();
  const window = Object.assign(new EventTarget(), { visualViewport: viewport });
  global("window", window);
  global("document", { querySelector: () => ({ close() {} }) });
  const actions = createMessageActions(reactive, {
    core: createClientState(true, false), nextTick, openPopup: createPopupOpener(),
    canEdit: () => false, canDelete: () => false, startEdit() {}, quoteMessage() {},
    openThreadForMessage: async () => {}, chooseReaction() {}, focusComposer() {},
    deleteMessage: async () => {}, focusAfterDelete() {},
  });
  actions.init();
  viewport.dispatchEvent(new Event("resize"));
  expect(actions.viewportRevision).toBe(1);
  actions.stamp("root:👍");
  expect(actions.stampedReaction).toBe("root:👍");
  actions.destroy();
  viewport.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("resize"));
  expect(actions.viewportRevision).toBe(1);
  expect(actions.stampedReaction).toBe("");
});

test("composer teardown disconnects observers and removes viewport/focus listeners", () => {
  const css = mock(() => {});
  const input = Object.assign(new EventTarget(), { scrollHeight: 24, style: { height: "" } });
  const composer = { getBoundingClientRect: () => ({ height: 48 }) };
  const viewport = Object.assign(new EventTarget(), { height: 768, offsetTop: 0 });
  const docListeners = new Set<string>();
  global("window", { visualViewport: viewport, innerHeight: 768 });
  global("document", {
    documentElement: { style: { setProperty: css } }, body: { classList: { toggle() {} } },
    activeElement: null,
    addEventListener: (name: string) => { docListeners.add(name); }, removeEventListener: (name: string) => { docListeners.delete(name); },
    querySelector: (selector: string) => selector === "#input" ? input : selector === "#composer" ? composer : selector === "#messages" ? {} : null,
  });
  const observers = new Set<object>();
  global("ResizeObserver", class { observe() { observers.add(this); } disconnect() { observers.delete(this); } });
  const core = createClientState(false, true);
  const editor = createComposerEditor(reactive, {
    core, nextTick, draftComposer: () => null, roomId: () => null, rememberText() {}, updateDraftNavigation() {},
    send: async () => {}, cancelEdit() {}, chooseCommand() {}, closeGiphy() {}, moveGiphy() {},
    onChatScroll() {}, scrollToBottom() {}, coarse: true,
    giphy: { giphyOpen: false, giphyResults: [], giphyError: "" },
    emoji: { isOpen: () => false, move() {}, dismiss() {}, choose() {}, reset() {}, syncCaret() {} },
  });
  editor.init();
  expect(observers.size).toBe(2);
  expect(docListeners.size).toBe(3);
  expect(css).toHaveBeenCalledWith("--composer-space", "64px");
  const calls = css.mock.calls.length;
  editor.destroy();
  viewport.dispatchEvent(new Event("resize")); input.dispatchEvent(new Event("focus"));
  expect(observers.size).toBe(0);
  expect(docListeners.size).toBe(0);
  expect(css.mock.calls).toHaveLength(calls);
});
