// Pull-to-refresh: the gesture's threshold and edge cases (pull-refresh.ts), and the catch-up the
// release runs (SyncEngine.catchUp over a fake-indexeddb ClientDatabase). One file per process.
import { afterEach, expect, test } from "bun:test";
import "fake-indexeddb/auto";

const { createPullGesture, pullOffset, PULL_THRESHOLD, PULL_MAX } = await import("../client/pull-refresh.ts");
const { ClientDatabase } = await import("../client/db.ts");
const { createSyncEngine } = await import("../client/sync.ts");
const { conversationId } = await import("../client/model.ts");

function fakeScroller(scrollTop = 0) {
  const listeners = new Map<string, (event: any) => void>();
  return {
    scrollTop,
    addEventListener: (type: string, listener: (event: any) => void) => { listeners.set(type, listener); },
    removeEventListener: (type: string) => { listeners.delete(type); },
    fire(type: string, x?: number, y?: number) {
      const event = { touches: x === undefined ? [] : [{ clientX: x, clientY: y }], cancelable: true, prevented: false, preventDefault() { this.prevented = true; } };
      listeners.get(type)?.(event);
      return event;
    },
  };
}

function gesture({ scrollTop = 0, typing = false, result = "current" as const } = {}) {
  const scroller = fakeScroller(scrollTop);
  const states: string[] = [];
  let refreshes = 0;
  const g = createPullGesture({
    scroller,
    enabled: () => true,
    typing: () => typing,
    width: () => 390,
    wait: async () => {},
    refresh: async () => { refreshes += 1; return result; },
    render: (state) => { if (states.at(-1) !== state) states.push(state); },
  });
  const pull = async (dy: number, x = 200, dx = 0) => {
    scroller.fire("touchstart", x, 100);
    const move = scroller.fire("touchmove", x + dx, 100 + dy);
    scroller.fire("touchend");
    await new Promise((resolve) => setTimeout(resolve, 0));
    return move;
  };
  return { g, scroller, states, pull, refreshes: () => refreshes };
}

test("the chip follows the finger with resistance and never passes its limit", () => {
  expect(pullOffset(0)).toBe(0);
  expect(pullOffset(-40)).toBe(0);
  expect(pullOffset(40)).toBeGreaterThan(25);
  expect(pullOffset(40)).toBeLessThan(40);
  expect(pullOffset(120)).toBeGreaterThanOrEqual(PULL_THRESHOLD);
  expect(pullOffset(100)).toBeLessThan(PULL_THRESHOLD);
  expect(pullOffset(2000)).toBeLessThanOrEqual(PULL_MAX);
});

test("a short pull springs back without refreshing", async () => {
  const t = gesture();
  const move = await t.pull(60);
  expect(move.prevented).toBe(true);
  expect(t.refreshes()).toBe(0);
  expect(t.states).toEqual(["pulling", "idle"]);
});

test("a pull past the threshold refreshes once, says it is up to date, then springs back", async () => {
  const t = gesture();
  await t.pull(200);
  expect(t.refreshes()).toBe(1);
  expect(t.states).toEqual(["pulling", "refreshing", "current", "idle"]);
});

test("offline is reported instead of up to date", async () => {
  const t = gesture({ result: "offline" as any });
  await t.pull(200);
  expect(t.states).toEqual(["pulling", "refreshing", "offline", "idle"]);
});

test("no pull below the real top, at the screen edges, sideways, or while typing", async () => {
  for (const [t, pull] of [
    [gesture({ scrollTop: 30 }), (t: any) => t.pull(200)],
    [gesture(), (t: any) => t.pull(200, 10)],
    [gesture(), (t: any) => t.pull(200, 380)],
    [gesture(), (t: any) => t.pull(40, 150, 120)],
    [gesture({ typing: true }), (t: any) => t.pull(200)],
  ] as const) {
    const move = await (pull as any)(t);
    expect(move.prevented).toBe(false);
    expect((t as any).refreshes()).toBe(0);
    expect((t as any).states).toEqual([]);
  }
});

// --- catch-up -------------------------------------------------------------------------------

const T = "2026-11-25T10:00:00.000Z";
const T2 = "2026-11-25T10:05:00.000Z";
const dbs: InstanceType<typeof ClientDatabase>[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) await db.delete(); });

function historyBatch(target: string, messages: { id: string; time: string }[], id: string): string {
  let out = `BATCH +${id} chathistory ${target}\r\n`;
  for (const m of messages) out += `@batch=${id};msgid=${m.id};time=${m.time};account=alice :alice!u@h PRIVMSG ${target} :${m.id}\r\n`;
  return out + `BATCH -${id}\r\n`;
}

async function readyEngine(name: string) {
  const db = new ClientDatabase({ instance: "https://slirc.test", accountId: name, account: "alice" });
  dbs.push(db);
  const sent: string[] = [];
  const ready: string[] = [];
  const engine = createSyncEngine({ db, send: (line) => { sent.push(line); return true; }, hooks: { onReady: (c) => ready.push(c.conversationId) }, namesProbeMs: 0 });
  const cid = conversationId("room", "#pull");
  engine.recover([{ conversationId: cid, wireTarget: "#pull" }]);
  engine.push(":srv 001 alice :welcome\r\n:alice!u@h JOIN #pull\r\n");
  await engine.whenIdle();
  engine.push(historyBatch("#pull", [{ id: "m1", time: T }], "h1"));
  await engine.whenIdle();
  expect(engine.isReady(cid)).toBe(true);
  return { db, engine, sent, ready, cid };
}

test("catch-up pages history after the stored checkpoint without a new JOIN", async () => {
  const { db, engine, sent, ready, cid } = await readyEngine("pull-catch-up");
  sent.length = 0;
  const done = engine.catchUp([cid]);
  await engine.whenIdle();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatch(/^CHATHISTORY AFTER #pull timestamp=/);
  expect(sent.some((line) => line.startsWith("JOIN"))).toBe(false);
  engine.push(historyBatch("#pull", [{ id: "m1", time: T }, { id: "m2", time: T2 }], "h2"));
  expect(await done).toBe(true);
  expect((await db.messages.toArray()).map((row) => row.serverId).sort()).toEqual(["m1", "m2"]);
  expect(engine.isReady(cid)).toBe(true);
  expect(ready).toEqual([cid]); // no second onReady: the room never went unready
});

test("catch-up fails when the connection drops before the page lands", async () => {
  const { engine, cid } = await readyEngine("pull-drop");
  const done = engine.catchUp([cid]);
  await engine.whenIdle();
  engine.onDisconnect();
  expect(await done).toBe(false);
  expect(await engine.catchUp([cid])).toBe(false);
});
