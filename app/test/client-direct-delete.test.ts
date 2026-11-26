// Close DM hides this account's list entry without deleting local history; failures restore it.
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createDirectDelete } from "@client/direct-delete.ts";
import { cachedDirectIsAuthorized } from "@client/access.ts";
import { type ClientSession } from "@client/client-state.ts";
import { type AuthorizedConversation } from "@client/sync.ts";

const reactive = <T extends object>(value: T): T => value;
const nextTick = async (callback?: () => void) => { callback?.(); };
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown): void {
  if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(() => {
  mock.restore();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals.clear();
});

const CONVERSATION = JSON.stringify(["dm", "ada-id"]);
const DIRECT = { nick: "ada", channel: "#dm-ada-eve" };
function session(): ClientSession {
  return { scope: () => ({ instance: "https://slirc.test", accountId: "eve-id", account: "eve" }), key: () => "eve-id", stopped: () => false, signingOut: () => false };
}
function harness(screen: { kind: string; nick?: string } = { kind: "tab" }) {
  const core = { channels: [{ wireTarget: "#dev-test" }], directs: [DIRECT], mutedRooms: [`dm:${CONVERSATION}`], starred: [CONVERSATION], threads: [] as { channel: string; parent: string }[] };
  const authorized: AuthorizedConversation[] = [{ conversationId: CONVERSATION, wireTarget: DIRECT.channel, kind: "dm" }];
  const open = mock((_state: unknown) => {});
  const nav = { $state: { get: () => ({ screen }) }, open } as never;
  const connect = mock(async () => {});
  global("document", { querySelector: () => ({ close: mock(() => {}), showModal: mock(() => {}) }) });
  global("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const directDelete = createDirectDelete(reactive, { core: core as never, nextTick, session: session(), authorized: () => authorized, nav, connect, closeMenu: () => {} });
  return { core, authorized, open, connect, directDelete };
}
function heldFetch() {
  let resolve!: (response: Response) => void;
  spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  return (response: Response) => resolve(response);
}

test("close hides only this account's DM, preserves preferences/history and navigates away", async () => {
  const { core, open, connect, directDelete } = harness({ kind: "dm", nick: "ada" });
  const answer = heldFetch();
  directDelete.directDeleteCandidate = "ada";
  const running = directDelete.closeDirect();
  expect(core.directs).toEqual([]);
  expect(core.starred).toEqual([CONVERSATION]);
  expect(core.mutedRooms).toEqual([`dm:${CONVERSATION}`]);
  expect(open).toHaveBeenCalledWith({ kind: "room", room: "#dev-test" });
  answer(new Response(null, { status: 204 }));
  await running;
  expect(connect).toHaveBeenCalledTimes(1);
});

test("server failure restores the DM and surfaces the error", async () => {
  const { core, connect, directDelete } = harness();
  const answer = heldFetch();
  directDelete.directDeleteCandidate = "ada";
  const running = directDelete.closeDirect();
  expect(core.directs).toEqual([]);
  answer(Response.json({ error: "server said no" }, { status: 502 }));
  await running;
  expect(core.directs).toEqual([DIRECT]);
  expect(directDelete.directDeleteError).toBe("server said no");
  expect(connect).not.toHaveBeenCalled();
  expect(directDelete.directDeleteBusy).toBe(false);
});

test("a cached direct is trusted only while the server still authorizes its conversation", () => {
  const authorized: AuthorizedConversation[] = [{ conversationId: CONVERSATION, wireTarget: DIRECT.channel, kind: "dm" }];
  expect(cachedDirectIsAuthorized(DIRECT, authorized)).toBe(true);
  expect(cachedDirectIsAuthorized(DIRECT, [])).toBe(false);
  expect(cachedDirectIsAuthorized(undefined, authorized)).toBe(false);
  expect(cachedDirectIsAuthorized(DIRECT, [{ conversationId: "x", wireTarget: DIRECT.channel, kind: "room" }])).toBe(false);
});
