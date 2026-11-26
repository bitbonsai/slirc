// Client checks: real /auth/me mapping, text validation, and the bridge's
// control/framing lifecycle feeding the sync assembler exactly once. fake-indexeddb must load
// before the Dexie-backed modules, so the client modules are imported dynamically.
import "fake-indexeddb/auto";
import { afterEach, expect, spyOn, test } from "bun:test";

const { SLASH_COMMANDS } = await import("@client/commands.ts");
const { validateText, missingRequiredCaps, RelayBridge, LineFramer, DATA_CAPS, MAX_TEXT_BYTES, serializeOperation } = await import("@client/protocol.ts");
const { clientAccess, authorizedThreads, contactsWithoutDirects, wireTargetForOperation, requiresLogoutConfirmation, recoveryTargets, defaultConversationIdFor } = await import("@client/access.ts");
const { profileFields, sameProfileFields, reconcileProfileFields, prepareProfilePhoto } = await import("@client/profile.ts");
const { Composer, queuedTextFor } = await import("@client/drafts.ts");
const { formatTime, avatarUrl, rememberAvatarVersions, messageDateLabel, dateDividerLabel, groupsWithPrevious, enterSends, nearBottom, nextMessageIndex, composerArrowUpTarget, mountUrl, routeFromMount, signInNext, isGiphyUrl, historyAvailability, giphyResultsFrom, hasMoreRight, giphyPickerIntent, collapsedMediaFromStorage, starredIdsFromStorage, excludeStarred, draftNavigationItems, visibleDraftNavigationItems, fenceHtml } = await import("@client/presentation.ts");
const { placePopup, usablePopupViewport, popupSide, popupMaxHeight, popupAnchorName, anchorPopupStyle, supportsAnchorPositioning, composerPopupPlacement } = await import("@client/popups.ts");
const { pairRequestUrl, pairDeliveryUrl, normalizePairCode, pairRequestSummary, formatPairCode, editPairCode, validSignInEmail, isPairCodeComplete, pairDigitInput } = await import("@client/pairing.ts");
const { giphyPickerComponent, slashHelpPanelComponent } = await import("@client/composer-pickers.ts");
const { tooltipText, tooltipPlacement } = await import("@client/tooltips.ts");
const { closeUnclosedCodeFence, displaySegments, embedImageUrl, hasUnclosedCodeFence, linkPasteReplacement, listEnter, textSegments, youtubeId } = await import("@client/render.ts");
const { glow } = await import("../public/vendor/nueglow.js");
const { messageLinkLabel, parseRoute } = await import("@client/navigation.ts");
const { conversationId, scopeKey } = await import("@client/model.ts");
import type { Message } from "@client/model.ts";
const { ClientDatabase } = await import("@client/db.ts");
const { createSyncEngine } = await import("@client/sync.ts");

const dbs: InstanceType<typeof ClientDatabase>[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});

function open(accountId = "acct-1") {
  const db = new ClientDatabase({ instance: "https://slirc.test", accountId, account: "bitbonsai" });
  dbs.push(db);
  return db;
}

// ---------------------------------------------------------------------------
// Text validation: one line, bounded bytes.
// ---------------------------------------------------------------------------

test("single-line text inside the byte cap is accepted", () => {
  expect(validateText("hello").ok).toBe(true);
  expect(validateText("a".repeat(MAX_TEXT_BYTES)).ok).toBe(true);
});

test("CR, LF, NUL, DEL, empty, and oversized text are rejected", () => {
  expect(validateText("two\nlines").ok).toBe(false);
  expect(validateText("two\rlines").ok).toBe(false);
  expect(validateText("nul\u0000byte").ok).toBe(false);
  expect(validateText("del\u007fbyte").ok).toBe(false);
  expect(validateText("bell\u0007").ok).toBe(false);
  expect(validateText("").ok).toBe(false);
  expect(validateText("   ").ok).toBe(false);
  expect(validateText("a".repeat(MAX_TEXT_BYTES + 1)).ok).toBe(false);
  // Multi-byte characters count as bytes, not code units.
  expect(validateText("é".repeat(MAX_TEXT_BYTES / 2)).ok).toBe(true);
  expect(validateText("é".repeat(MAX_TEXT_BYTES / 2 + 1)).ok).toBe(false);
});

// ---------------------------------------------------------------------------
// /auth/me mapping: immutable account id plus #dev-test membership, no guest cache.
// ---------------------------------------------------------------------------

test("a guest gets no scope", () => {
  const result = clientAccess({ authenticated: false, channels: ["#dev-test"] }, "https://slirc.test");
  expect(result.ok).toBe(false);
});

test("a missing immutable account id is refused", () => {
  const result = clientAccess({ authenticated: true, nick: "bitbonsai", channels: ["#dev-test"] }, "https://slirc.test");
  expect(result.ok).toBe(false);
});

test("any room admits an account; only an account with no conversations is refused", () => {
  const other = clientAccess(
    { authenticated: true, accountId: "acct-1", nick: "bitbonsai", channels: ["#other"] },
    "https://slirc.test",
  );
  expect(other.ok).toBe(true);
  if (other.ok) expect(other.conversation.wireTarget).toBe("#other");
  const empty = clientAccess({ authenticated: true, accountId: "acct-1", nick: "bitbonsai", channels: [] }, "https://slirc.test");
  expect(empty.ok).toBe(false);
});

test("authorized channels and stored DMs map to server-owned targets and immutable peer ids", () => {
  const result = clientAccess({ authenticated: true, accountId: "self", nick: "eve", channels: ["#dev-test", "#other"], directs: [{ nick: "ada", channel: "#dm-ada-eve" }], accountDetails: [{ id: "peer-ada", nick: "ada" }] }, "https://slirc.test");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.conversations.map((item) => item.wireTarget)).toEqual(["#dev-test", "#other", "#dm-ada-eve"]);
  expect(result.conversations[2]).toEqual({ conversationId: conversationId("dm", "peer-ada"), wireTarget: "#dm-ada-eve", kind: "dm" });
});

test("contacts exclude peers already listed in direct messages", () => {
  expect(contactsWithoutDirects(["Ada", "Ben", "Eve"], [{ nick: "ben" }, { nick: "eve" }])).toEqual(["Ada"]);
});

test("outbox target resolves only through authorized conversation mapping", () => {
  const allowed = { conversationId: conversationId("dm", "peer-ada"), wireTarget: "#dm-ada-eve", kind: "dm" as const };
  const operation = { id: "o", messageId: "m", conversationId: allowed.conversationId, kind: "text" as const, text: "hi", state: "queued" as const, createdAt: 1 };
  expect(wireTargetForOperation(operation, [allowed])).toBe("#dm-ada-eve");
  expect(wireTargetForOperation({ ...operation, conversationId: "unknown" }, [allowed])).toBeUndefined();
});

test("recovery adopts grants only for the captured account scope", () => {
  const member = { authenticated: true, accountId: "eve-id", nick: "eve", channels: ["#dev-test"] };
  const eve = clientAccess(member, "https://slirc.test");
  const ben = clientAccess({ ...member, accountId: "ben-id", nick: "ben" }, "https://slirc.test");
  expect(eve.ok).toBe(true);
  if (!eve.ok || !ben.ok) return;
  const captured = scopeKey(eve.scope);
  expect(recoveryTargets(eve, captured)?.map((item) => item.wireTarget)).toContain("#dev-test");
  // The cookie moved to Ben without this tab reconnecting: never adopt Ben's grants for Eve.
  expect(recoveryTargets(ben, captured)).toBeNull();
  expect(recoveryTargets({ ok: false, reason: "session expired" }, captured)).toBeNull();
});

test("a stored DM without its real account mapping is not authorized locally", () => {
  const result = clientAccess({ authenticated: true, accountId: "self", nick: "eve", channels: ["#dev-test"], directs: [{ nick: "ada", channel: "#dm-ada-eve" }] }, "https://slirc.test");
  expect(result.ok && result.conversations.some((item) => item.kind === "dm")).toBe(false);
});

test("authorized threads map to canonical ids, parent context, and server metadata", () => {
  const access = clientAccess({
    authenticated: true,
    accountId: "self",
    nick: "eve",
    channels: ["#dev-test"],
    directs: [{ nick: "ada", channel: "#dm-ada-eve" }],
    accountDetails: [{ id: "peer-ada", nick: "ada" }],
    threads: [
      { channel: "#t-290868", parent: "#dev-test", title: "Phone layout review", root: "r1", rootNick: "eve", rootText: "root text", rootTime: "2026-09-28T07:00:00.000Z", lastActivity: 2, createdBy: "eve" },
      { channel: "#t-2ef0e4", parent: "#dm-ada-eve", title: "Private draft check", root: "r2", rootNick: "ada", rootText: "secret", rootTime: "", lastActivity: 1 },
      { channel: "#t-bad", parent: "#not-a-member", title: "orphan", root: "r3", rootNick: "x", rootText: "", rootTime: "", lastActivity: 0 },
      { channel: "not-a-thread", parent: "#dev-test", title: "junk", root: "r4", rootNick: "x", rootText: "", rootTime: "", lastActivity: 0 },
    ],
  }, "https://slirc.test");
  expect(access.ok).toBe(true);
  if (!access.ok) return;
  expect(access.threads.map((thread) => thread.channel)).toEqual(["#t-290868", "#t-2ef0e4"]);
  expect(access.threads[0]).toEqual({
    channel: "#t-290868",
    conversationId: conversationId("thread", "#t-290868"),
    parent: "#dev-test",
    parentLabel: "dev-test",
    title: "Phone layout review",
    root: "r1",
    rootNick: "eve",
    rootText: "root text",
    rootTime: "2026-09-28T07:00:00.000Z",
    lastActivity: 2,
    createdBy: "eve",
  });
  expect(access.threads[1].parentLabel).toBe("ada");
});

test("threads whose parent is not an authorized conversation fail closed", () => {
  const conversations = [{ conversationId: conversationId("room", "#dev-test"), wireTarget: "#dev-test", kind: "room" as const }];
  expect(authorizedThreads({ threads: [{ channel: "#t-abc123", parent: "#elsewhere", root: "r", title: "t" }] }, conversations)).toEqual([]);
  expect(authorizedThreads({}, conversations)).toEqual([]);
});

test("null and non-object thread rows are ignored, not thrown on", () => {
  const conversations = [{ conversationId: conversationId("room", "#dev-test"), wireTarget: "#dev-test", kind: "room" as const }];
  const me = { directs: [null, "junk"], threads: [null, 3, { channel: "#t-abc123", parent: "#dev-test", title: "ok" }] };
  expect(authorizedThreads(me, conversations).map((thread) => thread.channel)).toEqual(["#t-abc123"]);
});

test("profile reconciliation adopts a clean server reply but keeps in-flight edits", () => {
  const clean = profileFields({ fullName: "Mauricio", about: "", availability: "" });
  const server = profileFields({ fullName: "Mauricio Wolff", about: "hi", availability: "late", badge: "vacation" });
  expect(sameProfileFields(clean, { ...clean })).toBe(true);
  expect(reconcileProfileFields(clean, clean, server)).toEqual({ form: server, saved: server });
  const dirty = profileFields({ fullName: "Mauricio typing", about: "", availability: "", badge: "busy" });
  expect(reconcileProfileFields(dirty, clean, server)).toEqual({ form: dirty, saved: server });
});

test("profileFields sanitizes junk before it reaches the form or the wire", () => {
  expect(profileFields(null)).toEqual({ fullName: "", about: "", availability: "", badge: "available" });
  expect(profileFields({ fullName: 5, about: "ok", availability: false, badge: "<img>" })).toEqual({ fullName: "", about: "ok", availability: "", badge: "available" });
  expect(profileFields({ badge: "vacation" }).badge).toBe("vacation");
});

test("a signed-in member maps to the scoped room", () => {
  const result = clientAccess(
    { authenticated: true, accountId: "acct-1", nick: "bitbonsai", channels: ["#DEV-TEST"] },
    "https://slirc.test/some/path",
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.scope).toEqual({
    instance: "https://slirc.test",
    accountId: "acct-1",
    account: "bitbonsai",
    caseMapping: "ascii",
  });
  expect(result.conversation).toEqual({
    conversationId: conversationId("room", "#dev-test"),
    wireTarget: "#dev-test",
    kind: "room",
  });
});

test("missing required capabilities are reported", () => {
  expect(missingRequiredCaps(["sasl", ...DATA_CAPS])).toEqual([]);
  const missing = missingRequiredCaps(["sasl", "batch", "server-time", "account-tag", "message-tags", "draft/chathistory"]);
  expect(missing).toEqual(["echo-message", "draft/event-playback"]);
});

// ---------------------------------------------------------------------------
// Bridge framing + control, and the single event lane into sync.
// ---------------------------------------------------------------------------

test("optional multiline is requested when offered but never required", () => {
  const h = bridgeHarness();
  h.bridge.onOpen();
  h.bridge.feed(":server CAP * LS :sasl batch draft/multiline\r\n");
  expect(h.sent.at(-1)).toBe("CAP REQ :sasl batch draft/multiline");
  expect(missingRequiredCaps(["sasl", "batch", "draft/multiline"])).not.toContain("draft/multiline");
});

test("multiline wire tags every constituent PRIVMSG with @batch and keeps +slirc/cid on the opener", () => {
  const operation = { id: "op1", messageId: "m1", conversationId: "c1", kind: "text", text: "↳ eve in #dev-test\nroot text", state: "queued", createdAt: 1 } as never;
  expect(serializeOperation(operation, "#t-abc123", true, () => "B1")).toEqual([
    "@+slirc/cid=op1 BATCH +B1 draft/multiline #t-abc123",
    "@batch=B1 PRIVMSG #t-abc123 :↳ eve in #dev-test",
    "@batch=B1 PRIVMSG #t-abc123 :root text",
    "BATCH -B1",
  ]);
  expect(serializeOperation({ ...(operation as object), text: "hi" } as never, "#r", true)).toEqual(["@+slirc/cid=op1 PRIVMSG #r :hi"]);
  expect(() => serializeOperation(operation, "#r", false)).toThrow("multiline not supported");
});

test("a fragmented line is held until its boundary arrives", () => {
  const framer = new LineFramer();
  expect(framer.push("PING :x\r")).toEqual([]);
  expect(framer.push("\n")).toEqual(["PING :x"]);
  expect(framer.push("a\r\nb\n")).toEqual(["a", "b"]);
});

function bridgeHarness() {
  const sent: string[] = [];
  const pushed: string[] = [];
  const missing: string[][] = [];
  const state = { authenticated: 0 };
  const bridge = new RelayBridge({
    nick: "bitbonsai",
    saslToken: "cHJldmlldw==",
    send: (line) => sent.push(line),
    push: (line) => pushed.push(line),
    onCaps: (_enabled, absent) => missing.push(absent),
    onAuthenticated: () => { state.authenticated += 1; },
  });
  return { bridge, sent, pushed, missing, state };
}

test("CAP negotiation requests the offered caps and completes SASL", () => {
  const h = bridgeHarness();
  h.bridge.onOpen();
  expect(h.sent).toEqual(["CAP LS 302", "NICK bitbonsai", "USER bitbonsai 0 * :bitbonsai"]);

  h.bridge.feed(`:server CAP * LS :${["sasl", ...DATA_CAPS].join(" ")}\r\n`);
  expect(h.sent.at(-1)).toBe(`CAP REQ :${["sasl", ...DATA_CAPS].join(" ")}`);

  h.bridge.feed(":server CAP * ACK :sasl batch server-time account-tag message-tags draft/chathistory\r\n");
  expect(h.missing.at(-1)).toEqual(["echo-message", "draft/event-playback"]);
  expect(h.sent.at(-1)).toBe("AUTHENTICATE PLAIN");

  h.bridge.feed("AUTHENTICATE +\r\n");
  expect(h.sent.at(-1)).toBe("AUTHENTICATE cHJldmlldw==");

  h.bridge.feed(":server 903 slirc :SASL authentication successful\r\n");
  expect(h.sent.at(-1)).toBe("CAP END");
  expect(h.state.authenticated).toBe(1);
});

test("PING is answered without duplicating the pushed event lane", () => {
  const h = bridgeHarness();
  h.bridge.feed("PING :keepalive\r\n");
  expect(h.sent).toEqual(["PONG :keepalive"]);
  expect(h.pushed).toEqual(["PING :keepalive\r\n"]);
});

test("one PRIVMSG reaches the durable projection exactly once", async () => {
  const db = open();
  const room = { conversationId: conversationId("room", "#dev-test"), wireTarget: "#dev-test", kind: "room" as const };
  const sync = createSyncEngine({ db, send: () => true, nick: "bitbonsai" });
  sync.recover([room]);
  // Same wiring the page uses: the bridge pushes each complete line into the sync assembler once.
  const routed = new RelayBridge({
    nick: "bitbonsai",
    saslToken: "x",
    send: () => {},
    push: (line) => sync.push(line),
  });
  routed.feed("@time=2026-09-27T10:00:00.000Z;msgid=m1;account=eve :eve!e@h PRIVMSG #dev-test :hi\r\n");
  await sync.whenIdle();
  expect(await db.messages.count()).toBe(1);
  expect((await db.messages.toArray())[0]?.text).toBe("hi");
});

// ---------------------------------------------------------------------------
// Draft durability: the send snapshot is captured before awaits, and newer input survives.
// ---------------------------------------------------------------------------

function composerHarness() {
  const rows = new Map<string, { revision: string; text: string }>();
  let n = 0;
  const composer = new Composer("#dev-test", {
    put: async (draft) => { rows.set(draft.conversationId, { revision: draft.revision, text: draft.text }); },
  }, () => 1, () => `rev-${++n}`);
  return { composer, rows };
}

test.each(["second", "first"])("newer edit %s during a blocked send keeps its own revision", async (newerText) => {
  const { composer, rows } = composerHarness();
  composer.edit("first");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];

  const committing = composer.commit(async (snapshot) => {
    seen.push(snapshot.revision);
    // Mirror db.queueText: only the captured revision's row may be removed.
    const row = rows.get("#dev-test");
    if (row?.revision === snapshot.revision) rows.delete("#dev-test");
    await gate;
  });
  await Promise.resolve();
  composer.edit(newerText);
  release();
  expect(await committing).toBe(true);

  expect(seen).toEqual(["rev-1"]); // the send used the captured revision, not a re-read one
  expect(composer.text).toBe(newerText);
  expect(composer.revision).toBe("rev-2");
  expect(rows.get("#dev-test")?.text).toBe(newerText);
});

test("a send with no newer edit clears the composer and its revision", async () => {
  const { composer } = composerHarness();
  composer.edit("only");
  const revisions: string[] = [];
  expect(await composer.commit(async (snapshot) => { revisions.push(snapshot.revision); })).toBe(true);
  expect(revisions).toEqual(["rev-1"]);
  expect(composer.text).toBe("");
  expect(composer.revision).toBeNull();
  expect(composer.snapshot()).toBeNull();
});

test("a save that finishes after room switch retains original operation target", async () => {
  const { composer } = composerHarness();
  composer.edit("in room A");
  let currentRoom = "room-a";
  const capturedRoom = currentRoom;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let queued: ReturnType<typeof queuedTextFor> | undefined;
  const commit = composer.commit(async (snapshot) => {
    await gate;
    queued = queuedTextFor(capturedRoom, "eve", snapshot, "op-1", 1);
  });
  currentRoom = "room-b";
  release();
  await commit;
  expect(currentRoom).toBe("room-b");
  expect(queued?.operation.conversationId).toBe("room-a");
});

test("sign-out confirmation includes saved drafts in other conversations", () => {
  expect(requiresLogoutConfirmation(1, 0, "", [""])).toBe(true);
  expect(requiresLogoutConfirmation(0, 0, "", ["unsaved elsewhere"])).toBe(true);
  expect(requiresLogoutConfirmation(0, 0, "", [""])).toBe(false);
});

test("pairing request and delivery URLs retain pairing tokens", () => {
  expect(pairRequestUrl("https://slirc.test", "123456")).toBe("https://slirc.test/pair/123456");
  expect(pairDeliveryUrl("123456", "a+b/c")).toBe("/api/pair/123456/session?token=a%2Bb%2Fc");
});

test("pair request copy names the requesting browser and system, with safe fallbacks", () => {
  expect(pairRequestSummary({ browser: "Safari", os: "iOS" }, "bitbonsai"))
    .toBe("A device using Safari on iOS wants to sign in as @bitbonsai.");
  expect(pairRequestSummary({ browser: "  ", os: 5 }, "bitbonsai"))
    .toBe("A device using another browser on an unknown system wants to sign in as @bitbonsai.");
  expect(pairRequestSummary(null, "bitbonsai")).toContain("another browser");
});

test("pair codes format for display and normalize for lookup", () => {
  expect(formatPairCode("123456")).toBe("123 456");
  expect(formatPairCode("123 456")).toBe("123 456");
  expect(formatPairCode("12345")).toBe("");
  expect(formatPairCode(123456)).toBe("");
  expect(normalizePairCode("123 456")).toBe("123456");
  expect(normalizePairCode("12345")).toBeNull();
});

test("a full six-digit paste fills every slot from any position", () => {
  expect(editPairCode("", 0, "123456")).toEqual({ value: "123456", focus: 5 });
  expect(editPairCode("12", 1, "987654")).toEqual({ value: "987654", focus: 5 });
  expect(editPairCode("12345", 5, " 987 654 ")).toEqual({ value: "987654", focus: 5 });
});

test("partial paste distributes digits from the focused slot onward", () => {
  expect(editPairCode("123456", 2, "78")).toEqual({ value: "127856", focus: 4 });
  expect(editPairCode("1", 1, "23")).toEqual({ value: "123", focus: 3 });
});

test("typing replaces one slot and a middle deletion leaves an interior gap", () => {
  expect(editPairCode("123", 3, "4")).toEqual({ value: "1234", focus: 4 });
  expect(editPairCode("123456", 2, "")).toEqual({ value: "12 456", focus: 2 });
  expect(editPairCode("12 456", 3, "9")).toEqual({ value: "12 956", focus: 4 });
});

test("spaced and invalid input is preserved or ignored without losing slots", () => {
  expect(editPairCode("12 456", 5, "")).toEqual({ value: "12 45", focus: 5 });
  expect(editPairCode("12", 2, "abc")).toEqual({ value: "12", focus: 2 });
  expect(editPairCode("12345", 0, "1234567")).toEqual({ value: "12345", focus: 0 });
});

test("review is only enabled for a complete six-digit code", () => {
  expect(isPairCodeComplete("123456")).toBe(true);
  expect(isPairCodeComplete("123 456")).toBe(true);
  expect(isPairCodeComplete("12345")).toBe(false);
  expect(isPairCodeComplete("12 456")).toBe(false);
  expect(isPairCodeComplete("")).toBe(false);
  expect(isPairCodeComplete(undefined)).toBe(false);
});

test("a typed digit replaces its slot even with the caret at the end", () => {
  // The browser hands the field value old+new ("69"); taking only InputEvent.data keeps 9.
  expect(pairDigitInput("insertText", "9", "69")).toBe("9");
  expect(editPairCode("123456", 5, pairDigitInput("insertText", "9", "69"))).toEqual({ value: "123459", focus: 5 });
  // Paste and autofill still carry the full text.
  expect(pairDigitInput("insertFromPaste", "123456", "6")).toBe("6");
  expect(pairDigitInput("insertReplacementText", "123 456", "6")).toBe("6");
  expect(pairDigitInput("insertText", "ab", "69")).toBe("69");
});

test("sign-in link only enables for an email-shaped address", () => {
  expect(validSignInEmail("eve@example.test")).toBe(true);
  expect(validSignInEmail("  eve@example.test  ")).toBe(true);
  expect(validSignInEmail("eve")).toBe(false);
  expect(validSignInEmail("eve@example")).toBe(false);
  expect(validSignInEmail("eve @example.test")).toBe(false);
  expect(validSignInEmail("")).toBe(false);
});

test("a second commit while one is pending is refused", async () => {
  const { composer } = composerHarness();
  composer.edit("first");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = composer.commit(async () => { await gate; });
  expect(composer.committing).toBe(true);
  expect(await composer.commit(async () => {})).toBe(false);
  release();
  expect(await first).toBe(true);
});

test("starred conversations persist safely and stay out of regular lists", () => {
  expect(starredIdsFromStorage('["room:one","dm:two","room:one",3,null]')).toEqual(["room:one", "dm:two"]);
  expect(starredIdsFromStorage("invalid")).toEqual([]);
  expect(starredIdsFromStorage(null)).toEqual([]);
  expect(excludeStarred([{ id: "room:one" }, { id: "room:two" }], ["room:one"], (item) => item.id)).toEqual([{ id: "room:two" }]);
});

test("collapsed media storage ignores malformed ids and recovers from invalid JSON", () => {
  expect(collapsedMediaFromStorage('["m1", 3, "m2"]')).toEqual({ m1: true, m2: true });
  expect(collapsedMediaFromStorage("not json")).toEqual({});
});

test("draft navigation shows only saved drafts for authorized rooms with current labels", () => {
  const room = { conversationId: "room", wireTarget: "#general", kind: "room" as const };
  const direct = { conversationId: "dm", wireTarget: "#dm-ada", kind: "dm" as const };
  const thread = { conversationId: "thread", wireTarget: "#t-abc123", kind: "thread" as const };
  const items = draftNavigationItems([
    { conversationId: "room", revision: "r1", text: "older", updatedAt: 1 },
    { conversationId: "dm", revision: "r2", text: "direct draft", updatedAt: 3 },
    { conversationId: "thread", revision: "r3", text: "thread draft", updatedAt: 2 },
    { conversationId: "revoked", revision: "r4", text: "hidden", updatedAt: 4 },
    { conversationId: "room", revision: "r5", text: "  ", updatedAt: 5 },
  ], [room, direct, thread], [{ channel: "#DM-ADA", nick: "Ada" }], [
    { channel: "#t-abc123", conversationId: "thread", parent: "#general", parentLabel: "general", title: "Thread title", root: "root", rootNick: "Ada", rootText: "", rootTime: "", lastActivity: 2 },
  ]);
  expect(items.map(({ label, text }) => [label, text])).toEqual([
    ["Ada", "direct draft"],
    ["Thread title", "thread draft"],
    ["#general", "older"],
  ]);
});

test("draft navigation reacts when active conversation changes", () => {
  const draft = { conversationId: "dm-ada", revision: "r1", text: "hello", updatedAt: 1, label: "Ada" };
  expect(visibleDraftNavigationItems([draft], "dm-ada", true)).toEqual([]);
  expect(visibleDraftNavigationItems([draft], "#general", true)).toEqual([draft]);
  expect(visibleDraftNavigationItems([draft], "dm-ada", false)).toEqual([draft]);
});

test("Composer.discard deletes saved text after earlier edits finish", async () => {
  const stored = new Map<string, string>();
  const composer = new Composer("room", {
    put: async (draft) => { stored.set(draft.conversationId, draft.text); },
    delete: async (id) => { stored.delete(id); },
  });
  composer.edit("unfinished message");
  expect(await composer.discard()).toBe(true);
  expect(stored.has("room")).toBe(false);
  expect(composer.text).toBe("");
});

test("Composer.discard preserves newer text typed while deletion waits", async () => {
  const stored = new Map<string, string>();
  let deleteStarted!: () => void;
  let releaseDelete!: () => void;
  const started = new Promise<void>((resolve) => { deleteStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const composer = new Composer("room", {
    put: async (draft) => { stored.set(draft.conversationId, draft.text); },
    delete: async (id) => { deleteStarted(); await gate; stored.delete(id); },
  });
  composer.edit("old draft");
  const discarded = composer.discard();
  await started;
  composer.edit("newer draft");
  releaseDelete();
  expect(await discarded).toBe(false);
  await composer.commit(async () => {});
  expect(stored.get("room")).toBe("newer draft");
});

test("Composer.load refuses a draft from a different conversation", () => {
  const { composer } = composerHarness();
  composer.load({ conversationId: "#other-room", revision: "stored-x", text: "wrong room", updatedAt: 1 });
  expect(composer.text).toBe("");
  expect(composer.revision).toBeNull();
  composer.load({ conversationId: "#dev-test", revision: "stored-y", text: "right room", updatedAt: 1 });
  expect(composer.text).toBe("right room");
  expect(composer.revision).toBe("stored-y");
});

test("Composer.load refuses to clobber a newer edit with delayed stored text", () => {
  const { composer } = composerHarness();
  composer.edit("user just typed");
  composer.load({ conversationId: "#dev-test", revision: "stored-old", text: "older draft", updatedAt: 1 });
  expect(composer.text).toBe("user just typed");
  expect(composer.revision).toBe("rev-1");
});

test("Composer.load refuses to resurrect sent text after a successful commit", async () => {
  const { composer } = composerHarness();
  composer.edit("hello");
  expect(await composer.commit(async () => {})).toBe(true);
  // After the send, the composer is empty. A late load of the stored draft must not bring it back.
  expect(composer.text).toBe("");
  expect(composer.revision).toBeNull();
  composer.load({ conversationId: "#dev-test", revision: "stored-pre-send", text: "old draft", updatedAt: 1 });
  expect(composer.text).toBe("");
  expect(composer.revision).toBeNull();
});

// ---------------------------------------------------------------------------
// Shipped-PWA presentation helpers: grouping, date labels, avatars, Enter, mount routes.
// ---------------------------------------------------------------------------

const localIso = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const now = new Date(2026, 8, 27, 12, 0);

function row(overrides: Partial<Message> = {}): Message {
  return {
    id: "m", conversationId: "c", authorAccount: "eve", authorNick: "eve",
    text: "x", time: localIso(27, 10), state: "confirmed",
    ...overrides,
  };
}

test("time and avatar helpers stay renderable for junk input", () => {
  expect(formatTime("not a date")).toBe("");
  expect(formatTime(localIso(27, 9, 5))).toMatch(/^\d{2}:\d{2}$/);
  expect(avatarUrl("")).toBe("");
  expect(avatarUrl("  ")).toBe("");
  expect(avatarUrl("a b")).toBe("/avatars/a%20b");
  expect(avatarUrl("a b", 42)).toBe("/avatars/a%20b?v=42");
  expect(avatarUrl("", 42)).toBe("");
});

test("avatar versions from server rows are kept per folded nick and junk is skipped", () => {
  const versions: Record<string, number> = { ada: 1 };
  rememberAvatarVersions(versions, [{ nick: "Ada", avatarVersion: 5 }, { nick: "bob", avatarVersion: 0 }, { nick: "eve" }, null, { nick: 3, avatarVersion: 9 }]);
  expect(versions).toEqual({ ada: 5, bob: 0 });
  expect(avatarUrl("Ada", versions.ada)).toBe("/avatars/Ada?v=5");
  expect(avatarUrl("bob", versions.bob)).toBe("/avatars/bob");
});

test("bots, the service nick and agent accounts get local marks before the avatar endpoint", () => {
  expect(avatarUrl("slirc")).toBe("/icons/slirc.svg");
  expect(avatarUrl("help")).toMatch(/^data:image\/svg\+xml,/);
  // A different helper keeps its own mark, not the first one's.
  expect(avatarUrl("remind")).toMatch(/^data:image\/svg\+xml,/);
  expect(avatarUrl("remind")).not.toBe(avatarUrl("help"));
  // The update notes bot is not a running helper but draws the same mark, in its own yellow.
  expect(decodeURIComponent(avatarUrl("updates"))).toContain("#f9e2af");
  expect(avatarUrl("PI-abc123")).toBe("/icons/agents/pi.svg");
  expect(avatarUrl("pi")).toBe("/avatars/pi");
});

test("profile photos resize before encoding, allow PNG fallback, and release failed decodes", async () => {
  const originalImage = globalThis.Image, originalDocument = globalThis.document;
  const revoke = spyOn(URL, "revokeObjectURL");
  let decodeFails = false;
  let dimensions = [4000, 3000];
  let encoded = "data:image/webp;base64,AQ==";
  let drawn: number[] = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (_image: unknown, ...args: number[]) => { drawn = args; } }), toDataURL: () => encoded };
  Object.assign(globalThis, {
    Image: class { naturalWidth = dimensions[0]; naturalHeight = dimensions[1]; async decode() { if (decodeFails) throw Error("decode"); } },
    document: { createElement: () => canvas },
  });
  try {
    // Input can exceed the wire limit: it gets resized, not rejected for being a phone photo.
    const photo = new File([new Uint8Array(5 * 1024 * 1024)], "phone.jpg", { type: "image/jpeg" });
    expect(await prepareProfilePhoto(photo)).toEqual({ mime: "image/webp", data: "AQ==" });
    expect(drawn).toEqual([0, 0, 640, 480]);
    dimensions = [320, 640]; encoded = "data:image/png;base64,Ag==";
    expect(await prepareProfilePhoto(photo)).toEqual({ mime: "image/png", data: "Ag==" });
    expect([canvas.width, canvas.height]).toEqual([320, 640]);
    decodeFails = true;
    await expect(prepareProfilePhoto(photo)).rejects.toThrow("Could not read this photo");
    expect(revoke).toHaveBeenCalledTimes(3);
    await expect(prepareProfilePhoto(new File(["bad"], "text.txt", { type: "text/plain" }))).rejects.toThrow("Choose a photo");
    await expect(prepareProfilePhoto(new File([], "empty.png", { type: "image/png" }))).rejects.toThrow("Choose a photo");
    expect(revoke).toHaveBeenCalledTimes(3);
  } finally {
    Object.assign(globalThis, { Image: originalImage, document: originalDocument });
    revoke.mockRestore();
  }
});

test("date labels read Today, Yesterday, then a weekday", () => {
  expect(messageDateLabel(localIso(27, 9), now)).toBe("Today");
  expect(messageDateLabel(localIso(26, 9), now)).toBe("Yesterday");
  const older = messageDateLabel(localIso(20, 9), now);
  expect(older).not.toBe("Today");
  expect(older.length).toBeGreaterThan(0);
  expect(dateDividerLabel([], 0)).toBe("");
  expect(dateDividerLabel([row({ time: localIso(27, 9) }), row({ time: localIso(27, 11), id: "m2" })], 1)).toBe("");
  expect(dateDividerLabel([row({ time: localIso(26, 9) }), row({ time: localIso(27, 9), id: "m2" })], 1, now)).toBe("Today");
});

test("grouping needs the same author, five minutes, and the same day", () => {
  const a = row({ time: localIso(27, 10, 0) });
  const soon = row({ time: localIso(27, 10, 4), id: "m2" });
  const later = row({ time: localIso(27, 10, 6), id: "m3" });
  const other = row({ time: localIso(27, 10, 1), id: "m4", authorAccount: "ada", authorNick: "ada" });
  const nextDay = row({ time: localIso(28, 9, 0), id: "m5" });
  expect(groupsWithPrevious([a], 0)).toBe(false);
  expect(groupsWithPrevious([a, soon], 1)).toBe(true);
  expect(groupsWithPrevious([a, later], 1)).toBe(false);
  expect(groupsWithPrevious([a, other], 1)).toBe(false);
  expect(groupsWithPrevious([a, nextDay], 1)).toBe(false);
});

test("Enter sends only on desktop, never mid-composition or with Shift", () => {
  expect(enterSends({ key: "Enter", isDesktop: true })).toBe(true);
  expect(enterSends({ key: "Enter", isDesktop: true }, true)).toBe(false);
  expect(enterSends({ key: "Enter", isDesktop: true, shiftKey: true })).toBe(false);
  expect(enterSends({ key: "Enter", isDesktop: true, isComposing: true })).toBe(false);
  expect(enterSends({ key: "Enter", isDesktop: false })).toBe(false);
  expect(enterSends({ key: "a", isDesktop: true })).toBe(false);
});

test("near-bottom follows a growing list, not a reader scrolled up", () => {
  expect(nearBottom(1000, 900, 200)).toBe(true);
  expect(nearBottom(1000, 700, 200)).toBe(false);
});

test("message arrow navigation stops at the newest/oldest without wrapping", () => {
  expect(nextMessageIndex(1, 3, "ArrowUp")).toBe(0);
  expect(nextMessageIndex(1, 3, "ArrowDown")).toBe(2);
  // Oldest row: ArrowUp stays put. Newest row: ArrowDown hands back to the composer.
  expect(nextMessageIndex(0, 3, "ArrowUp")).toBe("stay");
  expect(nextMessageIndex(2, 3, "ArrowDown")).toBe("composer");
  expect(nextMessageIndex(0, 1, "ArrowDown")).toBe("composer");
  expect(nextMessageIndex(0, 1, "ArrowUp")).toBe("stay");
});

test("popups flip above a low trigger and clamp to the visual viewport", () => {
  const viewport = { top: 0, left: 0, right: 400, bottom: 800 };
  // Room below: place under the trigger.
  expect(placePopup({ top: 100, left: 40, right: 140, bottom: 124 }, { width: 200, height: 80 }, viewport)).toEqual({ top: 130, left: 40, maxHeight: undefined });
  // Last row near the composer: not enough below, so flip above.
  expect(placePopup({ top: 700, left: 40, right: 140, bottom: 724 }, { width: 200, height: 80 }, viewport).top).toBe(614);
  // Composer covers bottom of viewport; popup must use its top as the usable edge.
  const chatViewport = usablePopupViewport(viewport, 300);
  expect(chatViewport.bottom).toBe(292);
  expect(placePopup({ top: 245, left: 40, right: 140, bottom: 265 }, { width: 200, height: 100 }, chatViewport).top).toBe(139);
  // Right edge clamps inside the viewport.
  expect(placePopup({ top: 100, left: 380, right: 480, bottom: 124 }, { width: 200, height: 80 }, viewport).left).toBe(196);
  // Neither side fits: cap the height so the popup scrolls instead of overflowing.
  const tiny = placePopup({ top: 140, left: 10, right: 110, bottom: 164 }, { width: 200, height: 300 }, { top: 0, left: 0, right: 400, bottom: 300 });
  expect(tiny.maxHeight).toBeGreaterThan(0);
  expect(tiny.maxHeight).toBeLessThan(300);
});

test("native anchor popups derive safe names and a side-aware fallback", () => {
  const viewport = { top: 0, left: 0, right: 400, bottom: 800 };
  const trigger = { top: 100, left: 40, right: 140, bottom: 124 };
  // Names stay a valid dashed-ident and distinct ids cannot collapse after punctuation stripping.
  const name = popupAnchorName("msg/1:2");
  expect(name).toMatch(/^--slirc-popup-[A-Za-z0-9_-]+$/);
  expect(popupAnchorName("msg/1:2")).toBe(name);
  expect(popupAnchorName("msg.1.2")).not.toBe(name);
  expect(popupAnchorName("<<>>")).toBe("--slirc-popup-3c-3c-3e-3e");
  // Side flips only when below is too short and above is roomier; the same decision drives both paths.
  expect(popupSide(trigger, { width: 200, height: 80 }, viewport)).toBe("below");
  expect(popupSide({ ...trigger, top: 700, bottom: 724 }, { width: 200, height: 80 }, viewport)).toBe("above");
  expect(popupMaxHeight({ ...trigger, top: 700, bottom: 724 }, { width: 200, height: 80 }, viewport, "above")).toBeUndefined();
  // Native placement keeps the anchor reference and the chosen block edge.
  expect(anchorPopupStyle("--slirc-popup-x", "above")).toContain("bottom: calc(anchor(top) + 6px)");
  expect(anchorPopupStyle("--slirc-popup-x", "below")).toContain("top: calc(anchor(bottom) + 6px)");
  expect(anchorPopupStyle("--slirc-popup-x", "below")).toContain("position-try-fallbacks: flip-inline");
  // A runtime without complete CSS anchor support falls back to the pixel path.
  expect(supportsAnchorPositioning({})).toBe(false);
  expect(supportsAnchorPositioning({ supports: (property) => property !== "position-try-fallbacks" })).toBe(false);
  expect(supportsAnchorPositioning({ supports: () => true })).toBe(true);
  // WebKit misplaces anchored popups inside a scrolled transcript, so it takes the pixel path too.
  const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
  expect(supportsAnchorPositioning({ supports: () => true }, safari)).toBe(false);
  expect(supportsAnchorPositioning({ supports: () => true }, chrome)).toBe(true);
});

test("composer ArrowUp enters messages only from an empty desktop draft with no list or modifier", () => {
  const base = { isDesktop: true, key: "ArrowUp", isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, text: "", menuOpen: false };
  expect(composerArrowUpTarget(base)).toBe(true);
  expect(composerArrowUpTarget({ ...base, text: "draft" })).toBe(false);
  expect(composerArrowUpTarget({ ...base, isComposing: true })).toBe(false);
  expect(composerArrowUpTarget({ ...base, ctrlKey: true })).toBe(false);
  expect(composerArrowUpTarget({ ...base, shiftKey: true })).toBe(false);
  expect(composerArrowUpTarget({ ...base, menuOpen: true })).toBe(false);
  expect(composerArrowUpTarget({ ...base, isDesktop: false })).toBe(false);
  expect(composerArrowUpTarget({ ...base, key: "ArrowDown" })).toBe(false);
});

test("link and YouTube parsing keeps unsafe text inert", () => {
  expect(textSegments("hi javascript:alert(1) https://example.test/x.")).toEqual([
    { text: "hi javascript:alert(1) " }, { text: "https://example.test/x", href: "https://example.test/x", raw: "https://example.test/x", sourceStart: 23 }, { text: "." },
  ]);
  expect(youtubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(youtubeId("http://youtu.be/dQw4w9WgXcQ")).toBeNull();
  expect(youtubeId("https://youtube.com/watch?v=bad")).toBeNull();
  expect(embedImageUrl("https://cdn.example.test/cover?a=1&b=2")).toBe("/api/embed/image?url=https%3A%2F%2Fcdn.example.test%2Fcover%3Fa%3D1%26b%3D2");
});

test("a link to a message here shows a short label and keeps the full URL; other links stay as written", () => {
  const origin = "https://slirc.test";
  const label = (href: string) => messageLinkLabel(href, origin);
  expect(label("https://slirc.test/?room=%23demo-dev&msg=jhj7rph42")).toBe("View in #demo-dev");
  expect(label("https://slirc.test/dm/igor?msg=m2")).toBe("View in DM with igor");
  expect(label("https://slirc.test/?room=%23t-558f6d&msg=m3")).toBe("View in thread");
  expect(label("https://slirc.test/?room=%23demo-dev")).toBeNull();
  expect(label("https://evil.test/?room=%23demo-dev&msg=m1")).toBeNull();
  expect(label("https://example.test/a")).toBeNull();
  const room = "https://slirc.test/?room=%23demo-dev&msg=m1";
  expect(displaySegments(`see ${room} and https://example.test/a`, textSegments, label)).toEqual([
    { text: "see " }, { text: "View in #demo-dev", href: room, raw: room, sourceStart: 4, route: true },
    { text: " and " }, { text: "https://example.test/a", href: "https://example.test/a", raw: "https://example.test/a", sourceStart: 52 },
  ]);
  // A Markdown link keeps the label its author wrote.
  expect(displaySegments(`[here](${room})`, textSegments, label)[0]).toMatchObject({ text: "here", href: room });
});

test("a line starting with > shows as a quote block, with a link that ends it kept after the block", () => {
  const room = "https://slirc.test/?room=%23demo-dev&msg=m1";
  const label = (href: string) => messageLinkLabel(href, "https://slirc.test");
  expect(displaySegments(`> @bitbonsai can you review this? ${room}`, textSegments, label)).toEqual([
    { text: "@bitbonsai can you review this?", quote: true },
    { text: "View in #demo-dev", href: room, raw: room, sourceStart: 34, route: true },
  ]);
  // The Quote action's format: the quote, then the reply on the next line.
  expect(displaySegments("> rita: ship it?\nyes, today", textSegments)).toEqual([{ text: "rita: ship it?", quote: true }, { text: "yes, today" }]);
  // Not a quote: no space after >, an empty quote, or inside a code fence.
  expect(displaySegments(">implying", textSegments).some((segment) => segment.quote)).toBe(false);
  expect(displaySegments("> ", textSegments).some((segment) => segment.quote)).toBe(false);
  expect(displaySegments("```\n> code\n```", textSegments).some((segment) => segment.quote)).toBe(false);
});

test("lines starting with - , * or a number show as list items with their own inline parts", () => {
  const text = "plan:\n- **ship** it\n* see https://example.test/a\n12. last\nthanks";
  const segments = displaySegments(text, textSegments);
  expect(segments.map((segment) => segment.marker ?? null)).toEqual([null, "•", "•", "12.", null]);
  expect(segments[0]).toEqual({ text: "plan:\n" });
  expect(segments[1]!.parts).toEqual([{ text: "ship", format: "strong", raw: "**ship**", sourceStart: 8 }, { text: " it" }]);
  // Offsets still point into the source, so link actions find the right occurrence.
  expect(segments[2]!.parts![1]).toMatchObject({ href: "https://example.test/a", sourceStart: text.indexOf("https") });
  expect(segments[4]).toEqual({ text: "thanks" });
  // Not a list: no space, an empty marker, bold at line start, or inside a code fence.
  for (const plain of ["-dash", "- ", "**bold** text", "1.5 litres", "```\n- code\n```"]) {
    expect(displaySegments(plain, textSegments).some((segment) => segment.marker)).toBe(false);
  }
});

test("lines starting with a typed • show as list items too", () => {
  const text = "Next:\n\n• Clicking a link opens it\n• Miro's Slack emoji";
  const segments = displaySegments(text, textSegments);
  expect(segments).toEqual([
    { text: "Next:\n\n" },
    { text: "Clicking a link opens it", marker: "•", parts: [{ text: "Clicking a link opens it" }] },
    { text: "Miro's Slack emoji", marker: "•", parts: [{ text: "Miro's Slack emoji" }] },
  ]);
  for (const plain of ["•dot", "• ", "a • b"]) {
    expect(displaySegments(plain, textSegments).some((segment) => segment.marker)).toBe(false);
  }
});

test("Enter on a list line continues the list, counts up, and ends it on an empty item", () => {
  expect(listEnter("- milk", 6)).toEqual({ start: 6, end: 6, insert: "\n- " });
  expect(listEnter("todo\n* eggs", 11)).toEqual({ start: 11, end: 11, insert: "\n* " });
  expect(listEnter("9. nine", 7)).toEqual({ start: 7, end: 7, insert: "\n10. " });
  // "• " lists pasted from notes continue and end the same way.
  expect(listEnter("• milk", 6)).toEqual({ start: 6, end: 6, insert: "\n• " });
  expect(listEnter("• milk\n• ", 9)).toEqual({ start: 7, end: 9, insert: "" });
  // Mid-item splits the item; the caret inside the marker is a plain newline.
  expect(listEnter("- milk", 4)).toEqual({ start: 4, end: 4, insert: "\n- " });
  expect(listEnter("- milk", 1)).toBeNull();
  // An empty item removes its marker and leaves the line empty.
  expect(listEnter("- milk\n- ", 9)).toEqual({ start: 7, end: 9, insert: "" });
  expect(listEnter("1. a\n2.  \nafter", 9)).toEqual({ start: 5, end: 9, insert: "" });
  expect(listEnter("plain text", 10)).toBeNull();
  expect(listEnter("", 0)).toBeNull();
});

test("Markdown formatting parses with Glow-ready fenced code and safe links", () => {
  const segments = textSegments("**bold** __also bold__ *italic* _also italic_ `@code` [site](https://example.test/a) ```ts\nconst answer = 42\n```");
  expect(segments.filter((segment) => segment.format).map(({ text, format, lang }) => ({ text, format, lang }))).toEqual([
    { text: "bold", format: "strong", lang: undefined }, { text: "also bold", format: "strong", lang: undefined },
    { text: "italic", format: "em", lang: undefined }, { text: "also italic", format: "em", lang: undefined },
    { text: "@code", format: "code", lang: undefined }, { text: "const answer = 42", format: "fence", lang: "ts" },
  ]);
  expect(segments.find((segment) => segment.href)).toMatchObject({ text: "site", href: "https://example.test/a" });
  expect(textSegments("**markdown*").some((segment) => segment.format)).toBe(false);
  expect(textSegments("__markdown_").some((segment) => segment.format)).toBe(false);
  expect(textSegments("[bad](javascript:alert(1))").some((segment) => segment.href)).toBe(false);
});

test("unclosed code fences close on send and stay open while typing", () => {
  const open = "```ts\nconst value = 1";
  expect(hasUnclosedCodeFence(open)).toBe(true);
  expect(hasUnclosedCodeFence(`${open}\n\`\`\``)).toBe(false);
  expect(closeUnclosedCodeFence(open)).toBe(`${open}\n\`\`\``);
  expect(closeUnclosedCodeFence(`${open}\n\`\`\``)).toBe(`${open}\n\`\`\``);
});

test("Glow escapes code before its HTML reaches the renderer", () => {
  const html = glow(["<script>alert(1)</script>"], "js");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;");
});

test("code fences escape markup in comments, quotes, headings and plain text", () => {
  const payload = "<img src=x onerror=alert(1)>";
  const cases: Array<[string, string]> = [
    [`// ${payload}`, "js"],
    [`# ${payload}`, "py"],
    [`> ${payload}`, "md"],
    [`# ${payload}`, "md"],
    [`x = 1 ${payload}`, ""],
    [`<b>${payload}</b>`, "html"],
  ];
  for (const [code, lang] of cases) {
    const html = fenceHtml({ code, lang });
    expect(html).not.toContain("<img");
    expect(html.replace(/<[^>]+>/g, "")).toContain("&lt;img src=x onerror=alert(1)&gt;");
  }
  expect(fenceHtml({ code: 'a && "x<y"', lang: "js" })).not.toContain("&amp;lt;");
});

test("URL paste over selected text creates a safe Markdown link", () => {
  expect(linkPasteReplacement("say hello", 4, 9, "https://example.test/a(b) ")).toBe("[hello](https://example.test/a(b%29)");
  expect(linkPasteReplacement("hello", 0, 5, "javascript:alert(1)")).toBeNull();
  expect(linkPasteReplacement("hello", 2, 2, "https://example.test")).toBeNull();
});

test("mentions preserve spacing and leave email, links and inline code alone", () => {
  const text = "Hi @bitbonsai, meet (@eve)! a@ben.test https://example.test/@ada `@ben` <b>@Ada</b>";
  const segments = textSegments(text);
  expect(segments.map((segment) => segment.raw || segment.text).join("")).toBe(text);
  expect(segments.filter((segment) => segment.nick).map((segment) => segment.nick)).toEqual(["bitbonsai", "eve", "Ada"]);
  expect(segments.find((segment) => segment.href)?.href).toBe("https://example.test/@ada");
  expect(textSegments("@" + "a".repeat(33)).some((segment) => segment.nick)).toBe(false);
  expect(textSegments("@@eve .@eve").some((segment) => segment.nick)).toBe(false);
});

test("client mount urls are canonical root routes", () => {
  expect(mountUrl("/")).toBe("/");
  expect(mountUrl("/#dev-test")).toBe("/#dev-test");
  expect(mountUrl("/dm/eve")).toBe("/dm/eve");
  expect(routeFromMount("/", "")).toBe("/");
  expect(routeFromMount("/", "#dev-test")).toBe("/#dev-test");
  expect(routeFromMount("/dm/eve", "")).toBe("/dm/eve");
  expect(routeFromMount("/", "", "?room=%23dev-test&msg=m1")).toBe("/?room=%23dev-test&msg=m1");
  // The server redirects a `#/…` fragment to the app root; the alias must still canonicalize
  // there instead of falling back to Home.
  expect(routeFromMount("/", "#/dm/ada")).toBe("/dm/ada");
  expect(routeFromMount("/", "#/dm/ada?msg=x")).toBe("/dm/ada?msg=x");
  expect(routeFromMount("/", "#/profile")).toBe("/profile");
  expect(routeFromMount("/", "#/dms")).toBe("/dms");
  expect(routeFromMount("/", "#/more")).toBe("/more");
  // A plain room hash is not the alias form and stays a room route.
  expect(routeFromMount("/", "#dev-test")).toBe("/#dev-test");
  // Public rooms are real routes, not a Home fallback.
  expect(parseRoute(routeFromMount("/open-chat", ""), "https://app.slirc.org")).toEqual({ kind: "room", room: "#open-chat" });
  expect(parseRoute(routeFromMount("/help", ""), "https://app.slirc.org")).toEqual({ kind: "room", room: "#help" });
  // The redirected DM alias resolves to a DM screen, not Home.
  expect(parseRoute(routeFromMount("/", "#/dm/ada"), "https://app.slirc.org")).toEqual({ kind: "dm", nick: "ada" });
});

test("sign-in next returns a safe root route, never a hardcoded mount", () => {
  expect(signInNext(routeFromMount("/", ""), "https://app.slirc.org")).toBe("/");
  expect(signInNext(routeFromMount("/dm/help", ""), "https://app.slirc.org")).toBe("/dm/help");
  expect(signInNext("/profile", "https://app.slirc.org")).toBe("/profile");
  expect(signInNext("/#dev-test", "https://app.slirc.org")).toBe("/");
  expect(signInNext("https://evil.example/x", "https://app.slirc.org")).toBe("/");
});

// Giphy rendering decision: only https Giphy media gets the clamped one-line link and loses the
// generic OG card. Every other URL, including an http or lookalike host, keeps normal behavior;
// the wire text and href are never rewritten here.
test("only https Giphy media is treated as the inline GIF for rendering", () => {
  expect(isGiphyUrl("https://media.giphy.com/media/abc/giphy.gif")).toBe(true);
  expect(isGiphyUrl("https://media1.giphy.com/media/abc/giphy.gif")).toBe(true);
  expect(isGiphyUrl("https://giphy.com/gifs/cats-abc")).toBe(true);
  expect(isGiphyUrl("https://example.com/cats.gif")).toBe(false);
  expect(isGiphyUrl("http://media.giphy.com/media/abc/giphy.gif")).toBe(false);
  expect(isGiphyUrl("https://notgiphy.com/x")).toBe(false);
  expect(isGiphyUrl("https://giphy.com.evil.example/x")).toBe(false);
  expect(isGiphyUrl("/uploads/abc123?type=image")).toBe(false);
  expect(isGiphyUrl("https://user:pass@media.giphy.com/x.gif")).toBe(false);
  expect(isGiphyUrl(undefined)).toBe(false);
  expect(isGiphyUrl("")).toBe(false);
  expect(isGiphyUrl("not a url")).toBe(false);
});

test("history chevrons derive from the router position, disabled at the ends", () => {
  expect(historyAvailability(-1, 0)).toEqual({ back: false, forward: false });
  expect(historyAvailability(0, 1)).toEqual({ back: false, forward: false });
  expect(historyAvailability(0, 3)).toEqual({ back: false, forward: true });
  expect(historyAvailability(1, 3)).toEqual({ back: true, forward: true });
  expect(historyAvailability(2, 3)).toEqual({ back: true, forward: false });
  expect(historyAvailability(2, 2)).toEqual({ back: true, forward: false });
});

// Direct-entry fallback: a reload on /profile (or any routed screen with no conversation behind it)
// still needs a real authorized conversation in the desktop pane.
test("direct-entry fallback prefers the default room, then any room, then a DM, else null", () => {
  const room = (wire: string) => ({ conversationId: conversationId("room", wire), wireTarget: wire, kind: "room" as const });
  const dm = (wire: string) => ({ conversationId: conversationId("dm", wire), wireTarget: wire, kind: "dm" as const });
  expect(defaultConversationIdFor([room("#other"), dm("#dm-a-b"), room("#dev-test")])).toBe(conversationId("room", "#dev-test"));
  expect(defaultConversationIdFor([dm("#dm-a-b"), room("#other")])).toBe(conversationId("room", "#other"));
  expect(defaultConversationIdFor([dm("#dm-a-b")])).toBe(conversationId("dm", "#dm-a-b"));
  expect(defaultConversationIdFor([])).toBeNull();
});

// Giphy picker logic (separate from a sent message's Giphy URL): normalization preserves the
// genuine count, the fade tracks real overflow, Enter semantics never fall through to a send, and
// the panel lines up with the composer.
test("giphy results normalization drops invalid rows and keeps a genuine count within the DOM cap", () => {
  const body = { gifs: [
    { preview: "https://media.giphy.com/a.gif", url: "https://media.giphy.com/a.gif", title: "a" },
    null,
    { url: "https://media.giphy.com/b.gif" }, // missing preview
    { preview: "https://media.giphy.com/c.gif", url: "https://media.giphy.com/c.gif", title: "c" },
    "nope",
  ] };
  const rows = giphyResultsFrom(body);
  expect(rows.map((row) => row.url)).toEqual(["https://media.giphy.com/a.gif", "https://media.giphy.com/c.gif"]);
  expect(rows).toHaveLength(2);
  // The cap bounds DOM only; the returned length is what the picker reports.
  expect(giphyResultsFrom(body, 1)).toHaveLength(1);
  expect(giphyResultsFrom({})).toEqual([]);
  expect(giphyResultsFrom(null)).toEqual([]);
  expect(giphyResultsFrom({ gifs: "not an array" })).toEqual([]);
});

test("giphy results keep a valid size and drop a bad one", () => {
  const row = { preview: "https://media.giphy.com/a.gif", url: "https://media.giphy.com/a.gif", title: "a" };
  expect(giphyResultsFrom({ gifs: [{ ...row, width: 480, height: 270 }] })).toEqual([{ ...row, width: 480, height: 270 }]);
  expect(giphyResultsFrom({ gifs: [{ ...row, width: 0, height: 270 }] })[0]).toEqual(row);
  expect(giphyResultsFrom({ gifs: [{ ...row, width: "480", height: null }] })[0]).toEqual(row);
});

test("the right fade shows only while the strip still has content to the right", () => {
  expect(hasMoreRight(0, 600, 300)).toBe(true);
  expect(hasMoreRight(250, 600, 300)).toBe(true); // 600-300-250 = 50 > 1
  expect(hasMoreRight(300, 600, 300)).toBe(false); // fully scrolled
  expect(hasMoreRight(299.5, 600, 300)).toBe(false); // sub-pixel remainder is not overflow
  expect(hasMoreRight(0, 300, 300)).toBe(false); // no overflow at all
  expect(hasMoreRight(0, 0, 0)).toBe(false);
});

test("Enter while the Giphy picker is open picks or is swallowed, never sends the draft", () => {
  const key = (k: string) => ({ key: k });
  expect(giphyPickerIntent(key("Enter"), 3)).toBe("pick");
  expect(giphyPickerIntent(key("Enter"), 0)).toBe("ignore");
  expect(giphyPickerIntent(key("Escape"), 0)).toBe("close");
  expect(giphyPickerIntent(key("ArrowRight"), 2)).toBe("next");
  expect(giphyPickerIntent(key("ArrowLeft"), 2)).toBe("prev");
  expect(giphyPickerIntent(key("ArrowRight"), 0)).toBe("ignore");
  expect(giphyPickerIntent(key("ArrowLeft"), 0)).toBe("ignore");
  // Composition and modifiers are not ours: the composer keeps its normal behavior.
  expect(giphyPickerIntent({ key: "Enter", isComposing: true }, 3)).toBeNull();
  expect(giphyPickerIntent({ key: "Enter", ctrlKey: true }, 3)).toBeNull();
  expect(giphyPickerIntent({ key: "Enter", metaKey: true }, 3)).toBeNull();
  expect(giphyPickerIntent({ key: "Enter", altKey: true }, 3)).toBeNull();
  expect(giphyPickerIntent(key("a"), 3)).toBeNull();
});

test("the Giphy tray and slash palette share composer placement", () => {
  const composer = { left: 40, width: 500, top: 600 };
  const desktop = composerPopupPlacement(composer, true, { width: 1200, height: 800 });
  expect(desktop).toEqual({ left: 40, right: null, width: 384, bottom: 208 });
  // Right-edge clamp keeps the panel inside the viewport.
  expect(composerPopupPlacement({ left: 1000, width: 500, top: 600 }, true, { width: 1200, height: 800 }).left).toBe(808);
  // A narrow composer never grows past its own width.
  expect(composerPopupPlacement({ left: 10, width: 260, top: 600 }, true, { width: 1200, height: 800 }).width).toBe(260);
  // Phones span the width as an 8px sheet on both edges.
  expect(composerPopupPlacement(composer, false, { width: 390, height: 800 })).toEqual({ left: 8, right: 8, width: null, bottom: 208 });
});

// Tooltip: one shared surface, text from data-tooltip or the control's aria-label, placed inside the
// viewport and never allowed to overflow the right edge or fall behind the composer.
function fakeEl(attrs: Record<string, string>) {
  return { getAttribute: (name: string) => attrs[name] ?? null };
}

test("tooltip text prefers data-tooltip and falls back to the accessible name", () => {
  expect(tooltipText(fakeEl({ "aria-label": "Add reaction" }))).toBe("Add reaction");
  expect(tooltipText(fakeEl({ "data-tooltip": "Send", "aria-label": "Send message" }))).toBe("Send");
  expect(tooltipText(fakeEl({ "aria-label": "  " }))).toBe("");
  expect(tooltipText(fakeEl({}))).toBe("");
});

test("tooltip placement prefers above, flips below, and clamps into the viewport", () => {
  const viewport = { width: 1000, height: 800 };
  const tip = { width: 100, height: 30 };
  // Centered above the trigger.
  expect(tooltipPlacement({ left: 450, top: 400, right: 550, bottom: 430, width: 100, height: 30 }, tip, viewport)).toEqual({ left: 450, top: 364, placement: "top" });
  // No room above: flips below.
  expect(tooltipPlacement({ left: 450, top: 10, right: 550, bottom: 40, width: 100, height: 30 }, tip, viewport)).toMatchObject({ top: 46, placement: "bottom" });
  // Right edge clamps so the tip stays inside the margin.
  expect(tooltipPlacement({ left: 980, top: 400, right: 990, bottom: 430, width: 10, height: 30 }, tip, viewport).left).toBe(892);
  // Left edge clamps too.
  expect(tooltipPlacement({ left: 0, top: 400, right: 10, bottom: 430, width: 10, height: 30 }, tip, viewport).left).toBe(8);
  // A trigger below the fold stays clamped above the bottom margin.
  expect(tooltipPlacement({ left: 450, top: 800, right: 550, bottom: 805, width: 100, height: 5 }, tip, viewport).top).toBe(762);
});

test("giphy picker sync derives the fade from the live scroll box", () => {
  const picker = giphyPickerComponent() as any;
  picker.$refs = { results: null };
  picker._results = { getClientRects: () => [1], scrollLeft: 0, scrollWidth: 600, clientWidth: 300 };
  picker.sync();
  expect(picker.moreRight).toBe(true);
  picker._results.scrollLeft = 300; // fully scrolled
  picker.sync();
  expect(picker.moreRight).toBe(false);
  picker._results = { getClientRects: () => [], scrollLeft: 0, scrollWidth: 600, clientWidth: 300 };
  picker.sync();
  expect(picker.moreRight).toBe(false); // hidden row has no overflow
  picker._results = null;
  picker.sync();
  expect(picker.moreRight).toBe(false);
});

test("giphy picker owns the horizontal selection index", () => {
  const picker = giphyPickerComponent() as any;
  picker.reset([{}, {}, {}]);
  picker.$nextTick = (fn: () => void) => fn();
  picker.$refs = { results: { querySelector: () => null } };
  picker.move(1); expect(picker.index).toBe(1);
  picker.move(1); expect(picker.index).toBe(2);
  picker.move(1); expect(picker.index).toBe(0); // wraps
  picker.move(-1); expect(picker.index).toBe(2);
  picker.reset(); expect(picker.index).toBe(0);
  picker.reset([]);
  picker.move(1); expect(picker.index).toBe(0); // empty list is a no-op
});

test("slash help component owns matching, selection, and dismissal", () => {
  const help = slashHelpPanelComponent() as any;
  help.$nextTick = (fn: () => void) => fn();
  help.$refs = { list: { querySelector: () => null } };
  help.composer = "/g";
  expect(help.matches().map((command: any) => command.name)).toEqual(["giphy"]);
  help.composer = "/";
  expect(help.matches().map((command: any) => command.name)).toContain("remind");
  // An instance that does not run remind does not offer /remind.
  help.helpers = ["help"];
  expect(help.matches().map((command: any) => command.name)).not.toContain("remind");
  delete help.helpers;
  help.index = 0;
  help.move(1); expect(help.index).toBe(1);
  help.move(-1); expect(help.index).toBe(0);
  help.move(-1); expect(help.index).toBe(help.matches().length - 1); // wraps
  help.dismiss();
  expect(help.matches()).toEqual([]);
  help.reset();
  expect(help.matches()).toHaveLength(SLASH_COMMANDS.length);
  expect(help.index).toBe(0);
  expect(help.dismissed).toBe(false);
});

// Inventory guard: opted-in controls use the shared directive and no native title tooltip is left
// on any client trigger.
test("client tooltip inventory has no native title attrs", async () => {
  const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
  expect(html).toContain("x-tooltip");
  expect(html).not.toMatch(/\stitle="/);
  expect(html).not.toMatch(/\s:title=/);
});
