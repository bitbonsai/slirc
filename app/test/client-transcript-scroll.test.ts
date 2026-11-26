// The DM with help stopped short of the bottom: sending jumped to the bottom before the new row
// rendered, the scroll event arrived after it, saw a gap and unpinned the list, so the reply that
// followed was left behind the composer. A reader who scrolls up must still stay where they are.
import { afterEach, expect, test } from "bun:test";

const { createTranscript } = await import("../client/transcript.ts");

type Chat = { scrollHeight: number; clientHeight: number; scrollTop: number };
const realDocument = globalThis.document;
afterEach(() => { (globalThis as { document?: unknown }).document = realDocument; });

function setup() {
  let top = 0;
  const chat: Chat = {
    scrollHeight: 2000, clientHeight: 800,
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
  };
  (globalThis as { document?: unknown }).document = { querySelector: (selector: string) => selector === "#chat" ? chat : null };
  const core = { messages: [], threads: [], embeds: {}, currentConversationId: "dm:help", greeting: true };
  // nextTick runs after Alpine's flush; the callback sees the painted, taller row.
  const transcript = createTranscript({ core: core as never, nextTick: async (callback?: () => void) => { callback?.(); }, authorized: () => [], stopped: () => false, linkOpen: () => false, closeLink: () => {} });
  const gap = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  return { chat, transcript, gap, core };
}

const remembered: [string, unknown][] = [];
function setupWith() {
  remembered.length = 0;
  const base = setup();
  const transcript = createTranscript({ core: base.core as never, nextTick: async (callback?: () => void) => { callback?.(); }, authorized: () => [], stopped: () => false, linkOpen: () => false, closeLink: () => {}, rememberEmbed: (url, meta) => { remembered.push([url, meta]); } });
  return { ...base, transcript };
}

test("a row that renders between our jump and its scroll event does not unpin the list", () => {
  const { chat, transcript, gap } = setup();
  transcript.scrollToBottom(true);
  expect(gap()).toBe(0);
  // Send: the jump ran first, then your 94px row rendered, then the jump's scroll event fired.
  chat.scrollHeight += 94;
  transcript.onChatScroll();
  expect(transcript.isPinned()).toBe(true);
  // The reply resizes the list; the resize observer's scroll must still follow it down.
  chat.scrollHeight += 168;
  transcript.scrollToBottom(false);
  expect(gap()).toBe(0);
});

test("scrolling up to read history unpins, and new rows do not pull the reader down", () => {
  const { chat, transcript, gap } = setup();
  transcript.scrollToBottom(true);
  transcript.noteInput();
  chat.scrollTop -= 300;
  transcript.onChatScroll();
  expect(transcript.isPinned()).toBe(false);
  chat.scrollHeight += 168;
  transcript.scrollToBottom(false);
  expect(gap()).toBe(468);
  // Scrolling back down, short of the bottom, keeps them unpinned; reaching it pins again.
  chat.scrollTop += 200;
  transcript.onChatScroll();
  expect(transcript.isPinned()).toBe(false);
  chat.scrollTop += 1000;
  transcript.onChatScroll();
  expect(transcript.isPinned()).toBe(true);
});

// On an iPhone the list opened, or woke, short of the newest message. WebKit reports an image or
// preview settling as a scroll event that moved up while the list grew; nobody touched the screen.
test("a scroll caused by layout, with no input from the person, keeps the list pinned", () => {
  const { chat, transcript, gap } = setup();
  transcript.scrollToBottom(true);
  chat.scrollHeight += 300;
  chat.scrollTop -= 19;
  transcript.onChatScroll();
  expect(transcript.isPinned()).toBe(true);
  transcript.scrollToBottom(false);
  expect(gap()).toBe(0);
});

async function switchTo(transcript: ReturnType<typeof setup>["transcript"], core: { currentConversationId: string }, next: string) {
  transcript.prepare(core.currentConversationId, next, false);
  core.currentConversationId = next;
  transcript.afterPaint({ conversationId: next }, () => true);
  await Promise.resolve(); await Promise.resolve();
}

test("a conversation left at the bottom reopens at the bottom after new messages", async () => {
  const { chat, transcript, gap, core } = setup();
  transcript.scrollToBottom(true);
  transcript.onChatScroll();
  await switchTo(transcript, core, "#other");
  chat.scrollHeight += 400;
  await switchTo(transcript, core, "dm:help");
  expect(gap()).toBe(0);
  expect(transcript.isPinned()).toBe(true);
});

test("a conversation left scrolled up reopens where the reader left it", async () => {
  const { chat, transcript, core } = setup();
  transcript.scrollToBottom(true);
  transcript.noteInput();
  chat.scrollTop = 500;
  transcript.onChatScroll();
  await switchTo(transcript, core, "#other");
  await switchTo(transcript, core, "dm:help");
  expect(chat.scrollTop).toBe(500);
  expect(transcript.isPinned()).toBe(false);
});

// A channel of links: each preview card lands a fetch after its row, and a reader at the bottom
// must not be left behind by the row it grows.
test("a link card that lands after the rows keeps the pinned view at the bottom", async () => {
  const { chat, transcript, gap, core } = setup();
  core.messages = [{ id: "m1", serverId: "s1", text: "see https://example.test/post" }] as never;
  transcript.scrollToBottom(true);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ title: "Post", site: "Example" }), { status: 200 })) as unknown as typeof fetch;
  try {
    const loading = transcript.loadEmbeds(core.messages as never);
    chat.scrollHeight += 90; // the card's row is painted while its request is still in flight
    await loading;
    expect(gap()).toBe(0);
    expect(transcript.isPinned()).toBe(true);
  } finally { globalThis.fetch = realFetch; }
});

test("a reader scrolled up is not pulled down by a card that lands", async () => {
  const { chat, transcript, gap, core } = setup();
  core.messages = [{ id: "m1", serverId: "s1", text: "see https://example.test/post" }] as never;
  transcript.scrollToBottom(true);
  transcript.noteInput();
  chat.scrollTop = 500;
  transcript.onChatScroll();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ title: "Post", site: "Example" }), { status: 200 })) as unknown as typeof fetch;
  try {
    const loading = transcript.loadEmbeds(core.messages as never);
    chat.scrollHeight += 90;
    await loading;
    expect(gap()).toBe(790);
    expect(transcript.isPinned()).toBe(false);
  } finally { globalThis.fetch = realFetch; }
});


// The links bot's summaries carry several cards each. On a reload they landed one by one; cards
// seen before now come from the account's cache, and a fetched card is kept for the next open.
test("a card already known is not fetched again, and a fetched one is remembered", async () => {
  const { transcript, core } = setupWith();
  core.embeds = { "https://known.test/": { title: "Known" } } as never;
  core.messages = [{ id: "m1", serverId: "s1", text: "https://known.test/ and https://new.test/ and https://bare.test/" }] as never;
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const { url } = JSON.parse(String(init.body)) as { url: string };
    asked.push(url);
    return new Response(JSON.stringify(url.includes("new") ? { title: "New", site: "New" } : {}), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await transcript.loadEmbeds(core.messages as never);
    expect(asked).toEqual(["https://new.test/", "https://bare.test/"]);
    // A link with no card is neither shown nor stored, so it never reserves an empty box.
    expect(Object.keys(core.embeds)).toEqual(["https://known.test/", "https://new.test/"]);
    expect(remembered).toEqual([["https://new.test/", { title: "New", site: "New" }]]);
  } finally { globalThis.fetch = realFetch; }
});

test("cards landing under a pinned view never move it up", async () => {
  const { chat, transcript, gap, core } = setupWith();
  core.messages = [1, 2, 3].map((n) => ({ id: `m${n}`, serverId: `s${n}`, text: `https://card.test/${n}` })) as never;
  transcript.scrollToBottom(true);
  const tops: number[] = [chat.scrollTop];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    // Each card grows a row above the bottom; the browser reports it as a scroll nobody made.
    chat.scrollHeight += 96;
    transcript.onChatScroll();
    tops.push(chat.scrollTop);
    return new Response(JSON.stringify({ title: "Card" }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await transcript.loadEmbeds(core.messages as never);
    tops.push(chat.scrollTop);
    expect(gap()).toBe(0);
    expect(transcript.isPinned()).toBe(true);
    for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeGreaterThanOrEqual(tops[i - 1]);
  } finally { globalThis.fetch = realFetch; }
});
