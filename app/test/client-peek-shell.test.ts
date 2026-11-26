// Signed-out /open-chat: the real createClient runtime fills the shared transcript state from
// /api/peek, never opens a WebSocket and fetches nothing beyond /auth/me, the peek and
// /api/version. Signing in hands the same shell back to the normal app. Browser APIs are shims.
// One file per process.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { installBrowserShims } from "./support/browser-shims.ts";

const sockets: unknown[] = [];
const fetched: string[] = [];
let signedIn = false;

const peekBody = {
  channel: "#open-chat",
  messages: [
    { id: "a1", time: "2026-11-19T10:00:00.000Z", nick: "ada", text: "hello **everyone** https://example.com/x" },
    { id: "a2", time: "2026-11-19T10:00:02.000Z", nick: "ben", text: "waves", action: true },
    { id: "p1", time: "2026-11-19T10:00:03.000Z", nick: "poll", text: "Poll: lunch?", poll: { id: 7, kind: "card" }, reactions: [{ emoji: "👍", count: 2, accounts: ["ada", "ben"] }] },
    { id: "p2", time: "2026-11-19T10:00:04.000Z", nick: "poll", text: "Poll: old", poll: { id: 8, kind: "card" } },
  ],
  polls: { 7: { id: 7, channel: "#open-chat", creator: "ada", question: "lunch?", multi: false, anonymous: true, createdAt: 1, closesAt: null, closedAt: null, options: [{ label: "soup", count: 2 }], voters: 2, mine: [1], winners: [], canClose: true } },
  embeds: { "https://example.com/x": { title: "Example", site: "example.com" } },
  avatars: { ada: 42 },
};

function installShims(): void {
  installBrowserShims({ url: "https://peek.test/open-chat", WebSocket: class { static OPEN = 1; readyState = 0; onopen: (() => void) | null = null; onmessage: ((event: unknown) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; constructor() { sockets.push(this); } close() {} send() {} } });
    globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url === "/auth/me") return signedIn
      ? Response.json({ authenticated: true, account: "mara", accountId: "acct-1", channels: ["#open-chat"], directs: [], accountDetails: [], profile: {} })
      : Response.json({ authenticated: false, signup: true });
    if (url === "/api/peek/open-chat") return Response.json(peekBody);
    return Response.json({});
  }) as typeof fetch;
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 20)); };

test("signed out at /open-chat, the shell shows the room read only from the peek alone", async () => {
  installShims();
  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: <T extends object>(value: T) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  try {
    await client.connect(); await settle();
    const ui = client.ui;
    expect(ui.authenticated).toBe(false);
    expect(ui.peekRoom).toBe("#open-chat");
    expect(ui.peekPending).toBe(false);
    expect(ui.signupOpen).toBe(true);
    // The transcript's own model: stable ids, actions as CTCP text, the room as the open conversation.
    expect(ui.channel).toBe("#open-chat");
    expect(ui.isOpenRoom("#open-chat")).toBe(true);
    expect(ui.messages.map((m: any) => [m.id, m.authorNick, m.text, m.state])).toEqual([
      ["peek:a1", "ada", "hello **everyone** https://example.com/x", "confirmed"],
      ["peek:a2", "ben", "\x01ACTION waves\x01", "confirmed"],
      ["peek:p1", "poll", "Poll: lunch?", "confirmed"],
      ["peek:p2", "poll", "Poll: old", "confirmed"],
    ]);
    expect(ui.isAction(ui.messages[1])).toBe(true);
    expect(ui.reactions.p1).toEqual([{ emoji: "👍", count: 2, mine: false, accounts: ["ada", "ben"] }]);
    expect(ui.reactionsReady()).toBe(true);
    expect(ui.embeds["https://example.com/x"]?.title).toBe("Example");
    expect(ui.avatarUrl("ada")).toBe("/avatars/ada?v=42");
    // The payload's poll draws as a card with nothing marked as this visitor's; one without a view stays text.
    const card = client.ui.polls.card(ui.messages[2]);
    expect(card && card !== "loading" && [card.question, card.mine, card.canClose]).toEqual(["lunch?", [], false]);
    expect(client.ui.polls.card(ui.messages[3])).toBe(null);
    // No IRC: no socket, and nothing fetched beyond who-am-I, the peek and the app's own update check.
    expect(sockets).toHaveLength(0);
    expect([...new Set(fetched)].sort()).toEqual(["/api/peek/open-chat", "/api/version", "/auth/me"]);

    // Signing in: the normal app takes over and the peek stops.
    signedIn = true;
    await client.connect(); await settle();
    expect(ui.authenticated).toBe(true);
    expect(ui.peekRoom).toBe("");
    expect(sockets.length).toBeGreaterThan(0);
  } finally { client.ui.destroy(); }
});

test("both addresses of the room land on the peek, and nothing else does", async () => {
  const { peekPath } = await import("../client/peek.ts");
  expect(peekPath("/open-chat")).toBe("open-chat");
  expect(peekPath("/", "#open-chat")).toBe("open-chat");
  expect(peekPath("/", "#Open-Chat")).toBe("open-chat");
  for (const [path, hash] of [["/", ""], ["/", "#help"], ["/help", ""], ["/dm/ana", ""], ["/open-chat/x", ""], ["/", "#open-chat-2"]]) expect(peekPath(path!, hash)).toBe("");
  expect(peekPath("/feedback", "", "#feedback")).toBe("feedback");
  expect(peekPath("/", "#feedback", "#feedback")).toBe("feedback");
  expect(peekPath("/", "#Feedback", "#feedback")).toBe("feedback");
  expect(peekPath("/open-chat", "", "#feedback")).toBe("");
});

test("the bare root lands on the peek only on the public playground", async () => {
  const { rootPeekPath } = await import("../client/peek.ts");
  expect(rootPeekPath("/", "", "", true)).toBe("open-chat");
  expect(rootPeekPath("/", "#", "?", true)).toBe("open-chat");
  expect(rootPeekPath("/", "", "", true, "#feedback")).toBe("feedback");
  expect(rootPeekPath("/", "", "", false)).toBe("");
  for (const [path, hash, search] of [["/", "", "?pair=123456"], ["/", "", "?login=invalid"], ["/", "#help", ""], ["/help", "", ""], ["/join/abc", "", ""], ["/auth/verify", "", "?token=x"]]) expect(rootPeekPath(path!, hash!, search!, true)).toBe("");
});
