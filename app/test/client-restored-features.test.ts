// The four tools that came back after the client port: the admin Bots list, channel archive, the
// Cmd+K jump palette and Alt+Up message recall. Pure parts and the page modules, no browser.
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createAdminPage, botSubtitle, cleanAdminBot } from "@client/admin-page.ts";
import { createChannelSettings } from "@client/channel-settings.ts";
import { createClientState, type ClientSession } from "@client/client-state.ts";
import { fuzzyScore, isJumpShortcut, jumpRows, rankJump } from "@client/jump.ts";
import { recallStep, sentTexts } from "@client/composer-history.ts";
import { composerArrowUpTarget, composerRecallDirection } from "@client/presentation.ts";
import { jumpDialogComponent } from "@client/palettes.ts";
import { type Message } from "@client/model.ts";

const reactive = <T extends object>(value: T): T => value;
const nextTick = async (callback?: () => void) => { callback?.(); };
const saved = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown): void {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(() => {
  mock.restore();
  for (const [name, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name);
  saved.clear();
});
const session = (): ClientSession => ({ scope: () => ({ account: "ada" }) as any, key: () => "ada", stopped: () => false, signingOut: () => false });

// --- Bots -------------------------------------------------------------------------------------

test("admin Bots: list, create shows the password once, rotate, remove, all with the CSRF header", async () => {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  let bots = [{ nick: "deploy", createdAt: 1, lastSeen: null }];
  spyOn(globalThis, "fetch").mockImplementation((async (input: any, init: RequestInit = {}) => {
    const method = init.method || "GET";
    calls.push({ url: String(input), method, headers: { ...(init.headers as Record<string, string> | undefined) }, body: init.body as string | undefined });
    if (method === "GET") return Response.json({ bots, limit: 3, used: bots.length });
    if (String(input) === "/api/bots") { bots = [...bots, { nick: "build", createdAt: 2, lastSeen: null }]; return Response.json({ nick: "build", password: "secret-1" }, { status: 201 }); }
    if (String(input).endsWith("/rotate")) return Response.json({ nick: "deploy", password: "secret-2" });
    bots = bots.filter((bot) => bot.nick !== "deploy");
    return new Response(null, { status: 204 });
  }) as any);
  global("document", { querySelector: () => null });
  const admin = createAdminPage(reactive, { core: { authenticated: true, account: "ada" }, session: session() });

  await admin.loadBots();
  expect(admin.bots).toEqual([{ nick: "deploy", lastSeen: null }]);
  expect(admin.botsUsed).toBe(1);

  admin.botName = "  build ";
  await admin.createBot();
  expect(admin.credential).toEqual({ nick: "build", password: "secret-1", rotated: false });
  expect(admin.botName).toBe("");
  expect(admin.bots.map((bot) => bot.nick)).toEqual(["deploy", "build"]);
  // The list never carries a password; Done forgets the one shown.
  expect(JSON.stringify(admin.bots)).not.toContain("secret");
  admin.closeCredential();
  expect(admin.credential).toBeNull();

  await admin.rotateBot(admin.bots[0]!);
  expect(admin.credential).toEqual({ nick: "deploy", password: "secret-2", rotated: true });

  admin.askRemoveBot(admin.bots[0]!, { focus() {}, isConnected: true } as any);
  await admin.confirmRemoveBot();
  expect(admin.botRemoveTarget).toBeNull();
  expect(admin.credential).toBeNull(); // the removed bot's password goes too
  expect(admin.bots.map((bot) => bot.nick)).toEqual(["build"]);

  const writes = calls.filter((call) => call.method !== "GET");
  expect(writes.map((call) => `${call.method} ${call.url}`)).toEqual(["POST /api/bots", "POST /api/bots/deploy/rotate", "DELETE /api/bots/deploy"]);
  for (const write of writes) expect(write.headers).toEqual({ "Content-Type": "application/json", "X-Slirc-Bots": "1" });
  expect(writes[0]!.body).toBe(JSON.stringify({ name: "build" }));
});

test("admin Bots shows the server's error and keeps the name for another try", async () => {
  spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ error: "Bot limit reached." }, { status: 409 })) as any);
  const admin = createAdminPage(reactive, { core: { authenticated: true, account: "ada" }, session: session() });
  admin.botName = "extra";
  await admin.createBot();
  expect(admin.botsError).toBe("Bot limit reached.");
  expect(admin.botName).toBe("extra");
  expect(admin.credential).toBeNull();
  expect(admin.botBusy).toBe("");
});

test("bot rows drop junk and say when a bot last connected", () => {
  expect(cleanAdminBot({ nick: " ci " })).toEqual({ nick: "ci", lastSeen: null });
  expect(cleanAdminBot({ nick: "" })).toBeNull();
  expect(botSubtitle({ nick: "ci", lastSeen: null })).toBe("/invite @ci · never connected");
  expect(botSubtitle({ nick: "ci", lastSeen: 1_000 }, 1_000 + 5 * 60_000)).toBe("/invite @ci · last seen 5 min ago");
});

// --- Archive ----------------------------------------------------------------------------------

test("archive: owner and admins on a real channel only; archive confirms, unarchive goes straight through", async () => {
  global("document", { querySelector: () => ({ open: false, showModal() {}, close() {}, focus() {} }) });
  const core = createClientState(true, false);
  core.account = "eve"; core.isAdmin = false; core.defaultChannel = "#lobby"; core.openRooms = { "#open-chat": true };
  core.channelDetails = [
    { channel: "#a", topic: "", owner: "eve", visibility: "secret" },
    { channel: "#b", topic: "", owner: "bob", visibility: "workspace" },
    { channel: "#lobby", topic: "", owner: "eve", visibility: "workspace" },
    { channel: "#open-chat", topic: "", owner: "eve", visibility: "workspace" },
    { channel: "#dm-eve-bob", topic: "", owner: "eve", visibility: "direct" },
    { channel: "#t-abc", topic: "", owner: "eve", visibility: "secret" },
  ];
  const actions: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (_input: any, init?: RequestInit) => {
    const { action } = JSON.parse(String(init?.body));
    actions.push(action);
    return Response.json({ ...core.channelDetails[0]!, archived: action === "archive" });
  }) as any);
  const prefs = createChannelSettings(reactive, { core, nextTick, session: session(), closeMenu: () => {} });
  const can = (channel: string) => { prefs.openChannelSettings(channel); return prefs.canArchiveChannel(); };
  expect(can("#b")).toBe(false); // not the owner
  for (const channel of ["#lobby", "#open-chat", "#dm-eve-bob", "#t-abc"]) expect(can(channel)).toBe(false);
  core.isAdmin = true;
  expect(can("#b")).toBe(true);
  for (const channel of ["#dm-eve-bob", "#t-abc"]) expect(can(channel)).toBe(false); // admins included
  core.isAdmin = false;

  expect(can("#a")).toBe(true);
  prefs.askArchive();
  expect(prefs.channelArchiveOpen).toBe(true);
  expect(actions).toEqual([]);
  prefs.cancelArchive();
  expect(prefs.channelArchiveOpen).toBe(false);
  prefs.askArchive();
  await prefs.setArchived(true);
  expect(actions).toEqual(["archive"]);
  expect(prefs.channelArchived()).toBe(true);
  expect(prefs.channelArchiveOpen).toBe(false);
  prefs.askArchive(); // archived: this is Unarchive, no confirmation
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(actions).toEqual(["archive", "unarchive"]);
  expect(prefs.channelArchived()).toBe(false);
});

// --- Cmd+K ------------------------------------------------------------------------------------

test("Cmd+K on Apple keyboards, Ctrl+K elsewhere, nothing with extra modifiers", () => {
  const key = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }>) =>
    ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
  expect(isJumpShortcut(key({ metaKey: true }), true)).toBe(true);
  expect(isJumpShortcut(key({ key: "K", metaKey: true }), true)).toBe(true);
  expect(isJumpShortcut(key({ ctrlKey: true }), true)).toBe(false);
  expect(isJumpShortcut(key({ ctrlKey: true }), false)).toBe(true);
  expect(isJumpShortcut(key({ metaKey: true }), false)).toBe(false);
  expect(isJumpShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
  expect(isJumpShortcut(key({ metaKey: true, isComposing: true }), true)).toBe(false);
  expect(isJumpShortcut(key({ key: "j", metaKey: true }), true)).toBe(false);
});

test("jump rows list each place once and rank fuzzy matches", () => {
  const rows = jumpRows({
    channels: [{ wireTarget: "#dev-test", label: "dev-test", secret: true, unread: 0 }, { wireTarget: "#general", label: "general", secret: false, unread: 2 }],
    groups: [{ wireTarget: "#g-1", label: "Ada, Ben", unread: 0 }],
    directs: [{ nick: "Ben", unread: 0 }],
    people: ["ben", "Eve"],
  });
  expect(rows.map((row) => `${row.kind}:${row.label}`)).toEqual(["channel:dev-test", "channel:general", "group:Ada, Ben", "dm:Ben", "person:Eve"]);
  expect(rankJump(rows, "")[0]!.label).toBe("general"); // unread first
  expect(rankJump(rows, "dvt").map((row) => row.label)).toEqual(["dev-test"]);
  expect(rankJump(rows, "#gen")[0]!.label).toBe("general");
  expect(rankJump(rows, "ben").map((row) => row.label)).toEqual(["Ben", "Ada, Ben"]);
  expect(rankJump(rows, "zzz")).toEqual([]);
  expect(fuzzyScore("eve", "eve")).toBeGreaterThan(fuzzyScore("everyone", "eve"));
});

test("jump palette: arrows wrap, Enter picks, Esc closes and gives focus back", () => {
  const events = new EventTarget();
  global("window", events);
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const invoker = { focused: 0, isConnected: true, focus() { this.focused += 1; } };
  global("document", { querySelector: () => dialog, activeElement: invoker, body: {} });
  const palette: any = jumpDialogComponent();
  palette.$nextTick = (callback: () => void) => { callback(); return Promise.resolve(); };
  palette.$refs = { search: { focus() {} }, list: { querySelector: () => null } };
  palette.init();
  const rows = jumpRows({ channels: [{ wireTarget: "#a", label: "a", secret: false, unread: 0 }], groups: [], directs: [{ nick: "ben", unread: 0 }], people: [] });
  const picked: unknown[] = [];
  events.addEventListener("slirc:jump-pick", (event) => picked.push((event as CustomEvent).detail.row.id));
  const key = (name: string) => palette.keydown({ key: name, preventDefault() {}, isComposing: false, ctrlKey: false, metaKey: false, altKey: false });

  events.dispatchEvent(new CustomEvent("slirc:jump-open", { detail: { rows } }));
  expect(dialog.open).toBe(true);
  expect(palette.activeId()).toBe("jump-option-0");
  key("ArrowUp");
  expect(palette.index).toBe(1); // wraps to the last row
  key("ArrowDown");
  expect(palette.index).toBe(0);
  key("Escape");
  expect(dialog.open).toBe(false);
  expect(invoker.focused).toBe(1);
  expect(picked).toEqual([]);

  events.dispatchEvent(new CustomEvent("slirc:jump-open", { detail: { rows } }));
  key("ArrowDown");
  key("Enter");
  expect(picked).toEqual(["dm:ben"]);
  expect(dialog.open).toBe(false);
  expect(invoker.focused).toBe(1); // navigation owns focus after a pick
  palette.destroy();
});

// --- Alt+Up recall ----------------------------------------------------------------------------

const message = (over: Partial<Message>): Message => ({ id: Math.random().toString(36), conversationId: "c", authorAccount: "ada", authorNick: "ada", text: "", time: "", state: "confirmed", ...over });

test("sent history keeps only your own live lines, without repeats in a row", () => {
  const messages = [
    message({ text: "first" }),
    message({ authorAccount: "ben", text: "not mine" }),
    message({ text: "first" }),
    message({ text: "gone", deleted: true }),
    message({ text: "typo", serverId: "s1" }),
    message({ text: "fixed", replaces: "s1" }),
    message({ text: "  " }),
    message({ text: "last" }),
  ];
  expect(sentTexts(messages, "ADA")).toEqual(["first", "fixed", "last"]);
});

test("recall walks back and forward like a shell and gives the draft back", () => {
  const entries = ["one", "two", "three"];
  expect(recallStep(entries, null, 1, "draft")).toBeNull(); // Down with no recall does nothing
  expect(recallStep([], null, -1, "draft")).toBeNull();
  let step = recallStep(entries, null, -1, "draft")!;
  expect(step.text).toBe("three");
  step = recallStep(entries, step.state, -1, step.text)!;
  expect(step.text).toBe("two");
  step = recallStep(entries, step.state, -1, step.text)!;
  expect(step.text).toBe("one");
  expect(recallStep(entries, step.state, -1, step.text)).toBeNull(); // oldest: stay
  step = recallStep(entries, step.state, 1, step.text)!;
  step = recallStep(entries, step.state, 1, step.text)!;
  expect(step.text).toBe("three");
  step = recallStep(entries, step.state, 1, step.text)!;
  expect(step).toEqual({ state: null, text: "draft" });
});

test("Alt+Up recalls; plain Up still selects the newest message", () => {
  const base = { isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, menuOpen: false };
  expect(composerRecallDirection({ ...base, key: "ArrowUp", altKey: true })).toBe(-1);
  expect(composerRecallDirection({ ...base, key: "ArrowDown", altKey: true })).toBe(1);
  expect(composerRecallDirection({ ...base, key: "ArrowUp", altKey: false })).toBe(0);
  expect(composerRecallDirection({ ...base, key: "ArrowUp", altKey: true, menuOpen: true })).toBe(0);
  expect(composerRecallDirection({ ...base, key: "ArrowUp", altKey: true, shiftKey: true })).toBe(0);
  const up = { isDesktop: true, key: "ArrowUp", isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, text: "", menuOpen: false };
  expect(composerArrowUpTarget({ ...up, altKey: false })).toBe(true);
  expect(composerArrowUpTarget({ ...up, altKey: true })).toBe(false);
});
