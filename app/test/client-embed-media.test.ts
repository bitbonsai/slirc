// Direct images render as inline photos, not link cards. The discriminator is the server's
// validated `kind: "image"` marker; a webpage with an og:image stays a card. Giphy's wire text
// keeps its raw URL in IRC and storage, but the body shows only the bracketed label as a link.
import { describe, expect, test } from "bun:test";
import { collapsesOlderGiphy, directImageMedia, giphyWireText, hideDirectImageUrls, isOlderGiphy, messageBodyText, stripGiphyWire } from "@client/media.ts";
import { createMediaView } from "@client/media-view.ts";
import type { Message } from "@client/model.ts";
import { embedMetaFromResponse } from "@client/embed.ts";

const PEXELS = "https://images.pexels.com/photos/3184338/pexels-photo-3184338.jpeg?auto=compress&cs=tinysrgb&w=1200";

describe("direct image links", () => {
  test("a validated image URL becomes proxied inline media, not a card", () => {
    expect(directImageMedia(PEXELS, "image")).toEqual({
      kind: "image",
      href: `/api/embed/image?url=${encodeURIComponent(PEXELS)}`,
      alt: "Photo",
      url: PEXELS,
    });
  });

  test("an ordinary page with an og:image stays a card", () => {
    expect(directImageMedia("https://example.test/post", undefined)).toBeNull();
    expect(directImageMedia("https://example.test/post", "link")).toBeNull();
    const meta = embedMetaFromResponse({ title: "Post", image: "https://example.test/og.png" });
    expect(meta?.kind).toBeUndefined();
    expect(directImageMedia("https://example.test/post", meta?.kind)).toBeNull();
  });

  test("the server marker survives embed normalization", () => {
    expect(embedMetaFromResponse({ kind: "image", image: "https://x.test/a.jpg" })).toMatchObject({ kind: "image" });
  });
});

test("image dimensions survive metadata normalization, invalid sizes do not", () => {
  expect(embedMetaFromResponse({ kind: "image", image: PEXELS, width: 1200, height: 800 })).toMatchObject({ width: 1200, height: 800 });
  expect(embedMetaFromResponse({ kind: "image", image: PEXELS, width: -1, height: 800 })?.width).toBeUndefined();
});

describe("direct image text", () => {
  test("the URL is hidden once its photo renders, but the caption stays", () => {
    expect(hideDirectImageUrls(`Pexels image ${PEXELS}`, (href) => href === PEXELS)).toBe("Pexels image ");
  });

  test("ordinary page links and labelled links are untouched", () => {
    const text = "GitHub card check https://github.com/ergochat/ergo";
    expect(hideDirectImageUrls(text, () => false)).toBe(text);
    expect(hideDirectImageUrls(`[photo](${PEXELS})`, (href) => href === PEXELS)).toBe(`[photo](${PEXELS})`);
  });

  test("a collapsed photo does not reveal the raw URL", async () => {
    const partial = await Bun.file(new URL("../partials/message-body.html", import.meta.url)).text();
    const anchor = partial.match(/<a class="media-fallback"[^>]*>/)?.[0];
    expect(anchor).toBeDefined();
    // The URL fallback exists only when the proxied image failed to load. Collapsing the photo is
    // not a reason to print the validation-hidden URL back into the message.
    expect(anchor).toContain("mediaView.isMediaError(media.href)");
    expect(anchor).not.toContain("isMediaCollapsed");
  });
});

describe("message body text hides links that render as images", () => {
  const ORIGIN = "https://app.test";
  const UPLOAD = `${ORIGIN}/uploads/abc123?type=image`;
  const UPLOAD2 = `${ORIGIN}/uploads/def456?type=image`;
  const GIF = giphyWireText("cats", "https://media.giphy.com/x.gif");
  const body = (text: string, direct: string[] = []) => messageBodyText(text, ORIGIN, (href) => direct.includes(href));

  test("text plus an uploaded image keeps only the text", () => {
    expect(body(`look at this\n${UPLOAD}`)).toBe("look at this");
  });

  test("an image alone prints nothing", () => {
    expect(body(UPLOAD)).toBe("");
    expect(body(GIF)).toBe("");
    expect(body(PEXELS, [PEXELS])).toBe("");
  });

  test("two images both drop out", () => {
    expect(body(`${UPLOAD}\n${UPLOAD2}`)).toBe("");
    expect(body(`two\n${UPLOAD}\n${GIF}`)).toBe("two");
  });

  test("a normal link next to an image stays visible", () => {
    expect(body(`see https://github.com/ergochat/ergo\n${UPLOAD}`)).toBe("see https://github.com/ergochat/ergo");
    expect(body(`see https://github.com/ergochat/ergo ${PEXELS}`, [PEXELS])).toBe("see https://github.com/ergochat/ergo ");
  });

  test("an upload link that does not render as an image stays visible", () => {
    // Only a line that is the upload URL becomes media; one inside prose stays a link.
    expect(body(`shared ${UPLOAD} earlier`)).toBe(`shared ${UPLOAD} earlier`);
    expect(body("https://other.test/uploads/abc123")).toBe("https://other.test/uploads/abc123");
  });
});

describe("giphy presentation", () => {
  test("the raw wire stays in storage; only the bracketed label links", () => {
    const wire = giphyWireText("cats", "https://media.giphy.com/x.gif");
    expect(wire).toBe("[Giphy: cats] https://media.giphy.com/x.gif");
    expect(stripGiphyWire(`caption\n${wire}`)).toBe("caption");
  });

  test("a sized wire line is stripped from the body like any other", () => {
    const wire = giphyWireText("cats", "https://media.giphy.com/x.gif", 480, 270);
    expect(stripGiphyWire(`caption\n${wire}`)).toBe("caption");
    expect(messageBodyText(wire, "https://app.test", () => false)).toBe("");
  });

  test("an unvalidated giphy-shaped line is not stripped", () => {
    expect(stripGiphyWire("[Giphy: dogs] https://evil.test/d.gif")).toBe("[Giphy: dogs] https://evil.test/d.gif");
  });
});

describe("older GIFs in an open channel on a phone", () => {
  const gif = (id: string, query: string) => ({ id, text: giphyWireText(query, `https://media.giphy.com/${query}.gif`) }) as Message;
  const messages = [gif("a", "gday"), { id: "b", text: "morning" } as Message, gif("c", "cats"), { id: "d", text: "ha" } as Message];

  test("only the last Giphy stays expanded", () => {
    expect(messages.map((message) => isOlderGiphy(messages, message))).toEqual([true, false, false, false]);
  });

  test("a tap opens an older GIF and the next GIF collapses the previous last one", () => {
    const list = [...messages];
    const view = createMediaView((value) => value, {
      core: { embeds: {} }, nextTick: async () => {}, openPopup: () => {}, origin: "https://app.test",
      session: { scope: () => null } as never,
      autoCollapsed: (message) => isOlderGiphy(list, message),
    });
    expect(view.isMediaCollapsed(list[0]!)).toBe(true);
    expect(view.isMediaCollapsed(list[2]!)).toBe(false);
    view.setMediaCollapsed(list[0]!, false);
    expect(view.isMediaCollapsed(list[0]!)).toBe(false);
    list.push(gif("e", "dogs"));
    // <details> fires toggle when its default flips; that must not become a stored choice.
    view.setMediaCollapsed(list[2]!, true);
    expect(view.collapsedMedia).toEqual({});
    expect(view.isMediaCollapsed(list[2]!)).toBe(true);
    expect(view.isMediaCollapsed(list[4]!)).toBe(false);
  });
});

describe("older GIFs rendered before the room is known to be open", () => {
  const gif = (id: string, query: string) => ({ id, text: giphyWireText(query, `https://media.giphy.com/${query}.gif`) }) as Message;
  // A tiny stand-in for the transcript: `render` is Alpine's flush applying `:open`, a changed
  // `open` queues one coalesced `toggle`, and `fire` is the later task that runs x-on:toggle.
  function setup(sync: boolean) {
    const list = [gif("a", "gday"), { id: "b", text: "morning" } as Message, gif("c", "cats"), gif("e", "dogs")];
    const room = { open: false };
    const view = createMediaView((value) => value, {
      core: { embeds: {} }, nextTick: async () => {}, openPopup: () => {}, origin: "https://app.test",
      session: { scope: () => null } as never,
      autoCollapsed: (message) => room.open && isOlderGiphy(list, message),
    });
    const dom: Record<string, boolean> = {};
    const queued = new Set<string>();
    const gifs = () => list.filter((message) => message.text.startsWith("[Giphy"));
    const fire = () => { for (const id of [...queued]) { queued.delete(id); view.setMediaCollapsed(list.find((m) => m.id === id)!, !dom[id]); } };
    const render = () => {
      for (const message of gifs()) {
        const open = !view.isMediaCollapsed(message);
        if ((dom[message.id] ?? false) === open) continue;
        dom[message.id] = open;
        queued.add(message.id);
        if (sync) fire();
      }
    };
    return { room, view, dom, render, fire };
  }

  for (const [name, order, modes] of [
    ["toggles fire before /auth/me lands", ["render", "fire", "open", "render", "fire"], [false, true]],
    ["/auth/me lands before the toggles fire", ["render", "open", "render", "fire"], [false, true]],
    ["toggle dispatched synchronously", ["render", "open", "render"], [true]],
  ] as const) {
    for (const sync of modes) test(`${name}${sync && modes.length > 1 ? " (sync toggle)" : ""}`, () => {
      const t = setup(sync);
      for (const step of order) step === "open" ? (t.room.open = true) : t[step]();
      t.fire();
      expect(t.dom).toEqual({ a: false, c: false, e: true });
      expect(t.view.expandedMedia).toEqual({});
      expect(t.view.collapsedMedia).toEqual({});
    });
  }
});

describe("where older GIFs start collapsed", () => {
  const view = { channel: "#open-chat", coarse: false, open: true, direct: false, thread: false };

  test("#open-chat collapses on a desktop too", () => {
    expect(collapsesOlderGiphy(view)).toBe(true);
    expect(collapsesOlderGiphy({ ...view, channel: "#Open-Chat", open: false })).toBe(true);
  });

  test("other open channels keep the phone-only rule", () => {
    expect(collapsesOlderGiphy({ ...view, channel: "#dev-open" })).toBe(false);
    expect(collapsesOlderGiphy({ ...view, channel: "#dev-open", coarse: true })).toBe(true);
    expect(collapsesOlderGiphy({ ...view, channel: "#secret", coarse: true, open: false })).toBe(false);
  });

  test("never in a DM or a thread", () => {
    expect(collapsesOlderGiphy({ ...view, direct: true })).toBe(false);
    expect(collapsesOlderGiphy({ ...view, thread: true })).toBe(false);
  });
});

// Opening a channel full of links: every thumbnail's box is reserved before its bytes arrive, so
// the rows do not grow under the reader as pictures load.
describe("reserved thumbnail space", () => {
  const ORIGIN = "https://app.test";
  const mediaView = (embeds: Record<string, unknown> = {}) => createMediaView((value) => value, {
    core: { embeds } as never, nextTick: async () => {}, openPopup: () => {}, origin: ORIGIN,
    session: { scope: () => null } as never,
  });

  test("an upload's stored size reserves its box before the picture loads", async () => {
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ abc123: { width: 900, height: 1600 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const view = mediaView();
      const text = `look\n${ORIGIN}/uploads/abc123?type=image`;
      expect(view.messageMedia(text)[0]?.width).toBeUndefined();
      await view.loadUploadDims([{ id: "m1", text } as Message]);
      expect(asked).toEqual(["/api/uploads/dims?ids=abc123"]);
      const media = view.messageMedia(text)[0]!;
      expect([media.width, media.height]).toEqual([900, 1600]);
      expect(view.mediaAspectStyle(media.href, media.width, media.height)).toContain("aspect-ratio: 900 / 1600");
      // One request per upload id, however often the rows repaint.
      await view.loadUploadDims([{ id: "m1", text } as Message]);
      expect(asked.length).toBe(1);
    } finally { globalThis.fetch = realFetch; }
  });

  test("a failed size lookup leaves the picture's default box alone", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    try {
      const view = mediaView();
      const text = `${ORIGIN}/uploads/gone?type=image`;
      await view.loadUploadDims([{ id: "m1", text } as Message]);
      const media = view.messageMedia(text)[0]!;
      expect(media.width).toBeUndefined();
      expect(view.mediaAspectStyle(media.href, media.width, media.height)).toBe("");
    } finally { globalThis.fetch = realFetch; }
  });

  test("a video keeps its own pixel size", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ clip: { width: 1080, height: 1920 } }), { status: 200 })) as unknown as typeof fetch;
    try {
      const view = mediaView();
      const text = `${ORIGIN}/uploads/clip?type=video`;
      await view.loadUploadDims([{ id: "m1", text } as Message]);
      expect(view.mediaAspectStyle(`${ORIGIN}/uploads/clip?type=video`, view.messageMedia(text)[0]?.width, view.messageMedia(text)[0]?.height)).toContain("aspect-ratio: 1080 / 1920");
    } finally { globalThis.fetch = realFetch; }
  });

  test("a direct image's size from the server reserves its box", () => {
    const view = mediaView({ [PEXELS]: { kind: "image", image: PEXELS, width: 1200, height: 800 } });
    const media = view.messageMedia(`${PEXELS}`)[0]!;
    expect([media.width, media.height]).toEqual([1200, 800]);
  });

  test("every thumbnail in the body is a reserved frame with a width and height", async () => {
    const partial = await Bun.file(new URL("../partials/message-body.html", import.meta.url)).text();
    const thumbs = partial.match(/<img class="thumb-img"[^>]*>/g) ?? [];
    expect(thumbs.length).toBe(4); // photo, card image, two player posters
    for (const thumb of thumbs) {
      expect(thumb).toContain("width=");
      expect(thumb).toContain("height=");
      expect(thumb).toContain("mediaView.markLoaded($el)");
    }
    // The photo's own aspect ratio, not a fixed one, is what reserves its box.
    const photo = thumbs.find((tag) => tag.includes("media.href"))!;
    expect(photo).toContain('mediaView.mediaAspectStyle(media.href, media.width, media.height)');
    // A stored card keeps a fixed frame cropped to it, so a preview saved without a size cannot jump.
    const card = thumbs.find((tag) => tag.includes("embeds[segment.href]"))!;
    expect(card).toContain('width="112" height="80"');
    expect(partial).toContain('<video class="message-video" :src="media.href + \'#t=0.001\'" :width="media.width || null" :height="media.height || null"');
  });

  test("the frame's quiet fill and fade stay out of the way when motion is reduced", async () => {
    const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
    expect(css).toContain(".thumb-img { background: color-mix(in srgb, var(--panel) 82%, transparent); }");
    expect(css).toContain(".thumb-img.thumb-loaded { animation: thumb-in var(--dur-fast) var(--ease-standard); }");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.thumb-img\.thumb-loaded \{ animation: none; \} \}/);
  });
});
