// Signed-out bare root: the peek reads #open-chat only when /auth/me says this is the public
// playground. peek.ts reads the address when it loads, so each case sets it and imports a fresh copy.
// One file per process.
import { expect, test } from "bun:test";

function at(url: string): void {
  const location = new URL(url);
  Object.assign(globalThis, {
    location,
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, activeElement: null, querySelector: () => null }),
  });
}

let copies = 0;
async function view(playground: boolean, openRoom?: string) {
  const { createPeekView } = await import(`../client/peek.ts?copy=${++copies}`);
  const fetched: string[] = [];
  const ui: any = { peekRoom: "", peekSignIn: false, peekPending: false, authenticated: false, booting: false, messages: [], reactions: {}, embeds: {}, avatarVersions: {}, channel: "", direct: false, roomLabel: "", currentConversationId: null, openRooms: {}, activeThread: null, notesOpen: false, sendReason: "" };
  const opened: string[] = [];
  const channel = openRoom || "#open-chat";
  const peek = createPeekView({
    ui, polls: { prime() {} }, scrollToBottom() {}, nextTick: (callback: () => void) => callback(), signedInBefore: () => false,
    openRoom: (room: string) => opened.push(room),
    fetcher: (async (input: string | URL | Request) => { fetched.push(String(input)); return Response.json({ channel, messages: [] }); }) as typeof fetch,
  });
  peek.start();
  peek.signedOut(playground, openRoom);
  await new Promise((resolve) => setTimeout(resolve, 10));
  peek.stop();
  return { fetched, ui, opened };
}

test("on the public playground the signed-out root reads the room; a private workspace keeps the sign-in card", async () => {
  at("https://peek.test/");
  const open = await view(true);
  expect(open.fetched).toEqual(["/api/peek/open-chat"]);
  // The root becomes the room's screen, so a phone leaves the account-only Home tab.
  expect(open.opened).toEqual(["#open-chat"]);
  const closed = await view(false);
  expect(closed.fetched).toEqual([]);
  expect(closed.ui.peekPending).toBe(false);
  expect(closed.opened).toEqual([]);
});

test("a root carrying a pairing code or a failed magic link keeps the sign-in card", async () => {
  for (const url of ["https://peek.test/?pair=123456", "https://peek.test/?login=invalid"]) {
    at(url);
    const { createPeekView } = await import(`../client/peek.ts?copy=${++copies}`);
    // The router drops the code from the address before /auth/me answers; the load-time read still holds.
    at("https://peek.test/");
    const fetched: string[] = [];
    const ui: any = { peekRoom: "", authenticated: false, embeds: {} };
    const peek = createPeekView({ ui, polls: { prime() {} }, scrollToBottom() {}, nextTick: (callback: () => void) => callback(), signedInBefore: () => false,
      fetcher: (async (input: string | URL | Request) => { fetched.push(String(input)); return Response.json({}); }) as typeof fetch });
    peek.signedOut(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    peek.stop();
    expect(fetched).toEqual([]);
  }
});

test("a custom openRoom (#feedback) peeks from /, /feedback and /#feedback without touching #open-chat", async () => {
  at("https://myarc.test/");
  const fromRoot = await view(true, "#feedback");
  expect(fromRoot.fetched).toEqual(["/api/peek/feedback"]);
  expect(fromRoot.opened).toEqual(["#feedback"]);

  at("https://myarc.test/feedback");
  const fromPath = await view(true, "#feedback");
  expect(fromPath.fetched).toEqual(["/api/peek/feedback"]);
  expect(fromPath.opened).toEqual(["#feedback"]);

  at("https://myarc.test/#feedback");
  const fromHash = await view(true, "#feedback");
  expect(fromHash.fetched).toEqual(["/api/peek/feedback"]);
});
