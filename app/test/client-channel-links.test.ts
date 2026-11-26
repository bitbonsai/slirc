// #channel mentions: a link into the app for a channel the reader has, plain text otherwise.
import { expect, test } from "bun:test";

const { channelLinks, displaySegments, textSegments } = await import("@client/render.ts");
const { parseRoute } = await import("@client/navigation.ts");

const origin = "https://app.slirc.test";
const mine = new Set(["#general", "#open-chat"]);
const canOpen = (channel: string) => mine.has(channel);
const shown = (text: string) => displaySegments(text, (part) => channelLinks(textSegments(part), canOpen, origin));

test("a channel the reader has becomes an in-app link to it", () => {
  const [before, link, after] = shown("see #General, then #open-chat.");
  expect(before).toEqual({ text: "see " });
  expect(link).toMatchObject({ text: "#General", href: `${origin}/#general`, route: true });
  expect(parseRoute(link!.href!, origin)).toMatchObject({ kind: "room", room: "#general" });
  expect(after).toEqual({ text: ", then " });
  expect(shown("see #General, then #open-chat.")[3]).toMatchObject({ text: "#open-chat", route: true });
});

test("a channel the reader lacks, or that does not exist, stays plain text", () => {
  const segments = shown("job board in #jobs and #secret-ops");
  expect(segments.some((segment) => segment.href || segment.channel)).toBe(false);
  expect(segments.map((segment) => segment.text).join("")).toBe("job board in #jobs and #secret-ops");
});

test("hashes that are not channel mentions are left alone", () => {
  for (const text of ["C# rocks", "issue #12", "# heading", "`#general`", "a##general", "x@y#general", "slirc.test/#general"]) {
    expect(shown(text).some((segment) => segment.route)).toBe(false);
  }
  // A full link keeps being the link it was, not a channel mention inside it.
  expect(shown("https://app.slirc.test/#general")).toEqual([{ text: "https://app.slirc.test/#general", href: "https://app.slirc.test/#general", raw: "https://app.slirc.test/#general", sourceStart: 0 }]);
});
