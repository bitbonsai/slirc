import { expect, test } from "bun:test";
import { AVATAR_PALETTE, avatarColor, avatarStyle, createMessageView, initial } from "@client/message-view.ts";
import { WORKSPACE_PALETTE } from "@client/workspace-mark.ts";

// The inline palette and hash the transcript and sidebar used before the palette was shared.
const LEGACY = ["#f5c2e7", "#cba6f7", "#eba0ac", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb", "#74c7ec", "#89b4fa", "#b4befe"];
const legacyColor = (key: string) => LEGACY[([...key.toLowerCase()].reduce((v, c) => Math.imul(31, v) + c.charCodeAt(0) | 0, 0) >>> 0) % 11]!;

test("avatars draw from the workspace palette and keep the colours people already have", () => {
  expect(AVATAR_PALETTE).toEqual(LEGACY);
  for (const color of AVATAR_PALETTE) expect(WORKSPACE_PALETTE).toContain(color);
  for (const key of ["ada", "Ben", "eve@example.test", "ai-guild", "juan", "名前", "🙂x", "claude-0ff1"]) expect(avatarColor(key)).toBe(legacyColor(key));
  expect(avatarColor("ADA")).toBe(avatarColor("ada"));
  expect(avatarColor(undefined)).toBe(legacyColor(""));
  expect(avatarStyle("ada")).toBe("background:" + legacyColor("ada") + ";color:#11111b");
  expect(initial("ada")).toBe("A");
  expect(initial("")).toBe("?");
});

const message = { id: "m1", serverId: "s1", text: "see", state: "sent" } as any;
function view(overrides: Record<string, unknown> = {}) {
  const hrefs = ["https://a.test/x", "https://youtu.be/abc", "https://img.test/p.png", "https://bad.test"];
  return createMessageView({
    embeds: () => ({
      "https://a.test/x": { title: "A page", image: "/i.png" },
      "https://img.test/p.png": { kind: "image", title: "photo" },
      "https://bad.test": {},
    }),
    linkSegments: () => hrefs.map((href) => ({ href })).concat([{ href: undefined } as any]),
    messageText: () => "",
    isGiphyUrl: () => false,
    embedImageUrl: (url) => "/proxy" + url,
    playerCard: (href) => (href.includes("youtu") ? { site: "YouTube", title: "YouTube", thumb: "/t.jpg" } : null),
    isMediaError: (href) => href === "/proxy/i.png",
    redactFor: () => ({ state: "uncertain" }),
    stampedReaction: () => "s1:👍",
    ...overrides,
  } as any);
}

test("link cards skip photos, players and links with nothing stored", () => {
  const v = view();
  expect(v.previewCards(message)).toEqual([{ href: "https://a.test/x", title: "A page", description: "", site: "a.test", image: "/proxy/i.png" }]);
  expect(v.showsCardImage(v.previewCards(message)[0]!)).toBe(false);
  expect(v.playerCards(message)).toEqual([{ href: "https://youtu.be/abc", title: "YouTube", site: "YouTube", thumb: "/t.jpg", youtube: true }]);
});

test("labels, chip class and retry state follow the message", () => {
  const v = view();
  expect(v.toggleLabel({ kind: "giphy", href: "" })).toBe("Toggle GIF");
  expect(v.toggleLabel({ kind: "video", href: "" })).toBe("Toggle video");
  expect(v.toggleLabel({ kind: "image", href: "" })).toBe("Toggle image");
  expect(v.openLabel({ kind: "giphy", href: "" })).toBe("Open GIF");
  expect(v.showsFallback({ kind: "image", href: "/proxy/i.png", url: "https://x.test" })).toBe(true);
  expect(v.showsFallback({ kind: "image", href: "/ok.png", url: "https://x.test" })).toBe(false);
  expect(v.chipClass(message, { emoji: "👍", mine: true })).toEqual(["mine", "stamp"]);
  expect(v.canRetryRedact(message)).toBe(true);
  expect(v.retryRedactLabel(message)).toBe("Resend delete");
  expect(view({ redactFor: () => null }).canRetryRedact(message)).toBe(false);
  expect(v.isPending({ ...message, state: "queued" })).toBe(true);
  expect(v.isPending(message)).toBe(false);
  expect(v.replyCountLabel(1)).toBe("1 reply");
  expect(v.replyCountLabel(3)).toBe("3 replies");
});
