import "./fixture.ts";

import { beforeEach, describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const ambience = await import("../src/room-ambience.ts");

// Wednesday 16 September 2026, 10:00 local.
const WED_10 = new Date(2026, 8, 16, 10, 0, 0).getTime();
const WED_08 = new Date(2026, 8, 16, 8, 0, 0).getTime();
const HOUR = 60 * 60_000;

beforeEach(() => {
  db.exec("DELETE FROM meta WHERE key LIKE 'ambience:%'");
});

describe("daily note", () => {
  test("due once a day from nine, and never before", () => {
    expect(ambience.dueNote(WED_08)).toBe(false);
    expect(ambience.dueNote(WED_10)).toBe(true);
    ambience.markNote(WED_10);
    expect(ambience.dueNote(WED_10 + 3 * HOUR)).toBe(false);
    expect(ambience.dueNote(WED_10 + 24 * HOUR)).toBe(true);
  });

  test("a restart on the same day does not post again", () => {
    ambience.markNote(WED_10);
    expect(ambience.lastNoteDay()).toBe("2026-09-16");
    expect(ambience.dueNote(WED_10 + HOUR, ambience.lastNoteDay())).toBe(false);
  });
});

describe("gif of the day", () => {
  test("posts in the same shape as the PWA's /giphy pick", () => {
    expect(ambience.gifLine("ship it", "https://media.giphy.com/media/x/giphy.gif")).toBe("[Giphy: ship it] https://media.giphy.com/media/x/giphy.gif");
  });

  test("no key, no gif; a bad response is silent", async () => {
    expect(await ambience.giphyUrl("x", "")).toBeNull();
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await ambience.giphyUrl("x", "key", failing)).toBeNull();
    const ok = (async () => Response.json({ data: [{ images: { original: { url: "https://media.giphy.com/media/y/giphy.gif" } } }] })) as unknown as typeof fetch;
    expect(await ambience.giphyUrl("x", "key", ok)).toBe("https://media.giphy.com/media/y/giphy.gif");
  });

  test("the gif's size rides in the URL fragment when Giphy sends a valid one", async () => {
    const reply = (width: string, height: string) => (async () => Response.json({ data: [{ images: { original: { url: "https://media.giphy.com/media/y/giphy.gif", width, height } } }] })) as unknown as typeof fetch;
    expect(await ambience.giphyUrl("x", "key", reply("480", "270"))).toBe("https://media.giphy.com/media/y/giphy.gif#w=480&h=270");
    expect(await ambience.giphyUrl("x", "key", reply("0", "270"))).toBe("https://media.giphy.com/media/y/giphy.gif");
    expect(await ambience.giphyUrl("x", "key", reply("9000", "270"))).toBe("https://media.giphy.com/media/y/giphy.gif");
    expect(await ambience.giphyUrl("x", "key", reply("4.5", "270"))).toBe("https://media.giphy.com/media/y/giphy.gif");
  });
});
