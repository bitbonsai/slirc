// Pure composer logic: slash catalog, photo picker rules, inline-media recognition, and the
// embed/player sanitizer. Plus one Dexie round-trip for the media-draft bytes.
import "fake-indexeddb/auto";
import { afterEach, expect, test } from "bun:test";
import { hiddenCommands, kickNotice, parseKick, parseSlash, slashCommand, slashSelection, slashSuggestions, unknownCommandMessage, commandHelpText, SLASH_COMMANDS } from "@client/commands.ts";
import { ATTACH_ACCEPT, giphyWireText, IMAGE_MIMES, inlineMedia, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, parseGiphyText, pickAttachment, removeInlineMedia, splitInlineMedia, VIDEO_MIMES } from "@client/media.ts";
import { embedMetaFromResponse, isCompactPlayer, playerAspect, playerHostKind, sanitizePlayer } from "@client/embed.ts";
import { HELP_TOPICS } from "@client/help.ts";
import type { AccountScope } from "@client/model.ts";

const { bytesToBase64 } = await import("@client/protocol.ts");
const { ClientDatabase } = await import("@client/db.ts");

// The slash panel (shared with the Giphy tray placement) advertises only the supported catalog.
// `/giphy` filters the same way every time; an unknown name parses (so it can error) but is never
// resolved to a command or forwarded as a message.
test("slash suggestions are case-insensitive prefixes; help lists the catalog; unknown names stay unresolved", () => {
  expect(slashSuggestions("/g").map((command) => command.name)).toEqual(["giphy"]);
  expect(slashSuggestions("/G").map((command) => command.name)).toEqual(["giphy"]);
  expect(slashSuggestions("/giph").map((command) => command.name)).toEqual(["giphy"]);
  expect(slashSuggestions("/giphy").map((command) => command.name)).toEqual(["giphy"]);
  expect(slashSuggestions("/h").map((command) => command.name)).toEqual(["help"]);
  expect(slashSuggestions("/giphy ")).toEqual([]);
  expect(slashSuggestions("/giphy cats")).toEqual([]);
  expect(slashSuggestions("hello")).toEqual([]);
  expect(slashSuggestions("")).toEqual([]);
  const lines = commandHelpText().split("\n");
  expect(lines).toHaveLength(SLASH_COMMANDS.length);
  for (const command of SLASH_COMMANDS) expect(commandHelpText()).toContain(`/${command.name} — ${command.description}`);
  expect(parseSlash("/giphyx cats")?.name).toBe("giphyx");
  expect(slashCommand("giphyx")).toBeUndefined();
  expect(unknownCommandMessage("giphyx")).toContain("/giphyx");
});

// /kick is an admin command: listed in the menu and help for admins only, parsed as nick then reason.
test("/kick shows only for admins, parses the nick and reason, and words the channel notice", () => {
  expect(slashSuggestions("/k", hiddenCommands([], true)).map((command) => command.name)).toEqual(["kick"]);
  expect(slashSuggestions("/k", hiddenCommands([], false))).toEqual([]);
  expect(slashSelection(slashCommand("kick")!)).toBe("/kick ");
  expect(HELP_TOPICS.some((topic) => topic.command === "/kick …")).toBe(true);
  expect(parseKick("@ben spamming links")).toEqual({ nick: "ben", reason: "spamming links" });
  expect(parseKick("  ben  ")).toEqual({ nick: "ben", reason: "" });
  expect(parseKick("")).toEqual({ nick: "", reason: "" });
  expect(kickNotice("ben", "#lounge", "spam")).toBe("removed ben from #lounge: spam");
  expect(kickNotice("ben", "#lounge", "")).toBe("removed ben from #lounge");
});

test("slash parsing and selection never send a bare command token", () => {
  expect(parseSlash("/giphy cats")?.argument).toBe("cats");
  expect(parseSlash("/help")?.name).toBe("help");
  expect(slashSelection(slashCommand("giphy")!)).toBe("/giphy ");
  expect(slashSelection(slashCommand("help")!)).toBe("/help");
  expect(slashSelection(slashCommand("threads")!)).toBe("/threads ");
  expect(parseSlash("/threads first reply")).toEqual({ name: "threads", argument: "first reply" });
  expect(slashCommand("shrug")).toBeUndefined();
  expect(unknownCommandMessage("shrug")).toContain("/shrug");
});

test("attachment picker takes photos and videos, refuses GIFs, HEIC, and oversize files with a clear step", () => {
  for (const mime of IMAGE_MIMES) expect(pickAttachment({ type: mime, size: 1000 })).toMatchObject({ ok: true, kind: "image" });
  for (const mime of VIDEO_MIMES) expect(pickAttachment({ type: mime, size: 1000 })).toMatchObject({ ok: true, kind: "video" });
  expect(pickAttachment({ type: "image/gif" })).toMatchObject({ ok: false });
  expect(pickAttachment({ type: "video/x-matroska" })).toMatchObject({ ok: false });
  expect(pickAttachment({ type: "video/mp4", size: MAX_VIDEO_BYTES + 1 })).toMatchObject({ ok: false, error: "Videos must be under 30 MB." });
  // A browser that compresses first takes the bigger clip; the compressed result must still fit.
  expect(pickAttachment({ type: "video/quicktime", size: MAX_VIDEO_BYTES + 1 }, { compressible: true })).toMatchObject({ ok: true, kind: "video" });
  expect(pickAttachment({ type: "video/quicktime", size: 501 * 1024 * 1024 }, { compressible: true })).toMatchObject({ ok: false, error: "Videos must be under 500 MB." });
  expect(pickAttachment({ type: "image/heic" })).toMatchObject({ ok: false });
  expect(pickAttachment({ type: "application/pdf" })).toMatchObject({ ok: false });
  expect(pickAttachment({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toMatchObject({ ok: false });
  expect((pickAttachment({ type: "image/heic" }) as { error: string }).error).toContain("JPEG");
});

// iOS filters its photo picker by the input's accept list; image-only types show "No Results"
// in a library of videos.
test("the composer file input accepts every type the picker allows, videos included", async () => {
  const partial = await Bun.file(new URL("../partials/composer.html", import.meta.url)).text();
  const accept = partial.match(/x-ref="mediaInput"[^>]*accept="([^"]+)"/)?.[1];
  expect(accept).toBe(ATTACH_ACCEPT);
  expect(accept).toContain("video/quicktime");
  expect(accept).toContain("video/mp4");
});

test("an uploaded video line is inline video media", () => {
  const origin = "https://app.test";
  expect(inlineMedia("look\n/uploads/abc123?type=video", origin)).toEqual([{ kind: "video", href: "https://app.test/uploads/abc123?type=video", alt: "Video", uploadId: "abc123" }]);
  expect(inlineMedia("/uploads/abc123", origin)[0]?.kind).toBe("image");
});

test("message media recognises our uploads and Giphy lines only", () => {
  const origin = "https://app.test";
  expect(inlineMedia("caption\n/uploads/abc123?type=image", origin)).toEqual([
    { kind: "image", href: "https://app.test/uploads/abc123?type=image", alt: "Photo", uploadId: "abc123" },
  ]);
  const giphy = inlineMedia(giphyWireText("cats", "https://media.giphy.com/x.gif"), origin);
  expect(giphy).toEqual([{ kind: "giphy", href: "https://media.giphy.com/x.gif", alt: "cats", label: "[Giphy: cats]", url: "https://media.giphy.com/x.gif" }]);
  expect(parseGiphyText("[Giphy: dogs] https://media.giphy.com/d.gif")).toEqual({ query: "dogs", url: "https://media.giphy.com/d.gif" });
  // Only https Giphy hosts count as inline GIFs; anything else stays text.
  expect(parseGiphyText("[Giphy: dogs] https://evil.test/d.gif")).toBeNull();
  expect(parseGiphyText("[Giphy: dogs] http://media.giphy.com/d.gif")).toBeNull();
  expect(parseGiphyText("[Giphy: dogs] https://media.giphy.com@evil.test/d.gif")).toBeNull();
  expect(inlineMedia("[Giphy: dogs] https://evil.test/d.gif", origin)).toEqual([]);
  // Cross-origin "uploads" and ordinary links stay text.
  expect(inlineMedia("https://evil.test/uploads/abc123", origin)).toEqual([]);
  expect(inlineMedia("https://example.test/page", origin)).toEqual([]);
});

test("a Giphy line carries its size in the URL fragment and reserves the box from it", () => {
  const origin = "https://app.test";
  const base = "https://media.giphy.com/media/x/giphy.gif?cid=abc";
  const wire = giphyWireText("cats", base, "480", 270);
  expect(wire).toBe(`[Giphy: cats] ${base}#w=480&h=270`);
  expect(parseGiphyText(wire)).toEqual({ query: "cats", url: base, width: 480, height: 270 });
  // The fragment never reaches what the browser loads or links.
  expect(inlineMedia(wire, origin)).toEqual([{ kind: "giphy", href: base, alt: "cats", label: "[Giphy: cats]", url: base, width: 480, height: 270 }]);
  // Unknown or out-of-range sizes are left off the wire, and a bad fragment falls back to the default box.
  expect(giphyWireText("cats", base, 0, 270)).toBe(`[Giphy: cats] ${base}`);
  expect(giphyWireText("cats", base, 8193, 270)).toBe(`[Giphy: cats] ${base}`);
  expect(giphyWireText("cats", base)).toBe(`[Giphy: cats] ${base}`);
  for (const fragment of ["w=0&h=270", "w=9000&h=270", "w=1.5&h=2", "w=480", "h=270&w=480", "w=-4&h=3", "junk"]) {
    const parsed = parseGiphyText(`[Giphy: cats] ${base}#${fragment}`);
    expect(parsed).toEqual({ query: "cats", url: base });
    expect(inlineMedia(`[Giphy: cats] ${base}#${fragment}`, origin)[0]).not.toHaveProperty("width");
  }
  expect(parseGiphyText(`[Giphy: cats] ${base}#w=8192&h=1`)).toEqual({ query: "cats", url: base, width: 8192, height: 1 });
  // A sized line is still one attachment, removable by the href it renders.
  expect(removeInlineMedia(`${wire}\ncaption`, base, origin)).toBe("caption");
});

test("removing an edit attachment removes only its media line, not caption or other media", () => {
  const origin = "https://app.test";
  const photo = "https://app.test/uploads/abc123?type=image";
  const other = "https://app.test/uploads/def456?type=image";
  expect(removeInlineMedia(`caption\n${photo}\n${other}`, photo, origin)).toBe(`caption\n${other}`);
  expect(removeInlineMedia(`[Giphy: cats] https://media.giphy.com/x.gif\ncaption`, "https://media.giphy.com/x.gif", origin)).toBe("caption");
  expect(splitInlineMedia(`caption\n${photo}`, origin)).toEqual({ text: "caption", attachments: [photo] });
  expect(splitInlineMedia(`[Giphy: cats] https://media.giphy.com/x.gif`, origin)).toEqual({ text: "", attachments: ["[Giphy: cats] https://media.giphy.com/x.gif"] });
  expect(removeInlineMedia(`caption\n${photo}`, "https://app.test/uploads/unknown?type=image", origin)).toBe(`caption\n${photo}`);
});

test("player embeds keep only allowlisted https hosts", () => {
  expect(sanitizePlayer({ src: "https://open.spotify.com/embed/track/x", width: 456, height: 152 })?.src).toContain("spotify");
  expect(sanitizePlayer({ src: "https://evil.test/embed" })).toBeNull();
  expect(sanitizePlayer({ src: "http://open.spotify.com/embed" })).toBeNull();
  expect(sanitizePlayer({ src: "javascript:alert(1)" })).toBeNull();
  expect(sanitizePlayer({ src: "https://open.spotify.com@evil.test/embed" })).toBeNull();
  const meta = embedMetaFromResponse({ title: "Song", site: "Spotify", player: { src: "https://open.spotify.com/embed/track/x", width: 456, height: 152 } });
  expect(meta?.player?.src).toContain("spotify");
  expect(embedMetaFromResponse({})).toBeNull();
  expect(playerAspect(meta?.player)).toBeCloseTo(3, 1);
  expect(isCompactPlayer(meta?.player)).toBe(true);
  expect(playerHostKind("https://open.spotify.com/embed/track/x")).toBe("audio");
  expect(playerHostKind("https://player.vimeo.com/video/1")).toBe("video");
});

test("base64 encoding round-trips binary bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 128]);
  const encoded = bytesToBase64(bytes);
  expect(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))).toEqual(bytes);
});

const scope: AccountScope = { instance: "https://slirc.test", accountId: "acct-media", account: "alice" };
const databases: ClientDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});

test("a staged photo's bytes survive a Dexie round-trip and clear on delete", async () => {
  const db = new ClientDatabase(scope);
  databases.push(db);
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await db.mediaDrafts.put({ conversationId: "room-conv", name: "photo.png", mime: "image/png", bytes, updatedAt: 1 });
  const restored = await db.mediaDrafts.get("room-conv");
  expect(restored?.mime).toBe("image/png");
  expect(new Uint8Array(restored!.bytes)).toEqual(bytes);
  await db.mediaDrafts.put({ conversationId: "room-conv", name: "photo.png", mime: "image/png", bytes, uploadedUrl: "https://app.test/uploads/x", updatedAt: 2 });
  expect((await db.mediaDrafts.get("room-conv"))?.uploadedUrl).toBe("https://app.test/uploads/x");
  await db.mediaDrafts.delete("room-conv");
  expect(await db.mediaDrafts.get("room-conv")).toBeUndefined();
});

test("/invite is an argument-taking command handled only for ordinary channels", async () => {
  expect(slashSelection(slashCommand("invite")!)).toBe("/invite ");
  const runtime = await Bun.file(new URL("../client/runtime.ts", import.meta.url)).text();
  const start = runtime.indexOf('case "invite":');
  const end = runtime.indexOf('case "threads":', start);
  const branch = runtime.slice(start, end);
  expect(branch).toContain('item.kind !== "room" || isGroupRoom(item.wireTarget)');
  // An email gets the inline note with Invite by email; nothing is sent until that is pressed.
  expect(branch).toMatch(/validSignInEmail\(target\)[\s\S]*addPrompts\.offerEmail\(/);
  expect(branch).toContain("addPrompts.offer(");
});

test("no advertised help command lacks a runSlash case", async () => {
  const names = new Set(SLASH_COMMANDS.map((command) => command.name));
  for (const topic of HELP_TOPICS) {
    if (!topic.command.startsWith("/")) continue;
    const token = topic.command.slice(1).split(/[\s<[(]/)[0]!;
    expect(names.has(token)).toBe(true);
  }
  const runtime = await Bun.file(new URL("../client/runtime.ts", import.meta.url)).text();
  const start = runtime.indexOf("async function runSlash");
  const end = runtime.indexOf("function queueConversationText");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = runtime.slice(start, end);
  for (const name of names) expect(block).toContain(`case "${name}":`);
});

test("the phone composer is a pill on one line and an 18px frame once attachments or lines make it tall", async () => {
  // A 999px pill stayed on when a compressing video made the composer tall: the chip's corner and the
  // send button sat outside the curve. The compressing chip never set tall, and the pill could not
  // ease into the frame.
  const html = await Bun.file(new URL("../partials/composer.html", import.meta.url)).text();
  expect(html).toContain(":class=\"[(editor.composerTall || media || mediaCompress || (isEditing() && editingMedia().length)) && 'tall'");
  const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  const coarse = css.slice(css.indexOf("@media (pointer: coarse) {\n  .reaction-tooltip"));
  expect(coarse).toContain(".composer { border-radius: calc(1.375rem + .5rem + 1px); }");
  expect(coarse).toContain(".composer.tall { border-radius: 18px; }");
  expect(coarse).toMatch(/\.composer \{[^}]*transition: translate var\(--dur-micro\) ease-out, border-radius var\(--dur-fast\) ease;/);
});
