// D2 independent checks: IRC parsing/batch assembly and the paged recovery sync engine over a real
// (fake-indexeddb) ClientDatabase. Protocol shapes come from .plans/instant-checks.md C1/C6 and are
// exercised against a runnable fake; live Ergo behavior is not verified here. One file per process.
import { afterEach, expect, test } from "bun:test";
import "fake-indexeddb/auto";

const { ClientDatabase } = await import("../client/db.ts");
const { BatchAssembler, parseIrcLine } = await import("../client/irc.ts");
const { buildJoinCommands, buildMarkReadCommand, createSyncEngine, eventsFromBatch, checkpointOf } = await import("../client/sync.ts");
const { conversationId } = await import("../client/model.ts");

const T = "2026-09-27T10:00:00.000Z";
const dbs: InstanceType<typeof ClientDatabase>[] = [];

function open(accountId: string) {
  const db = new ClientDatabase({ instance: "https://slirc.test", accountId, account: "alice" });
  dbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});

function harness(db: InstanceType<typeof ClientDatabase>, { hooks: extraHooks = {}, ...extra }: { hooks?: Record<string, unknown>; [key: string]: unknown } = {}) {
  const sent: string[] = [];
  const errors: Error[] = [];
  const ready = new Set<string>();
  const unready: string[] = [];
  const engine = createSyncEngine({
    db,
    send: (line) => {
      sent.push(line);
      return true;
    },
    hooks: {
      onReady: (conversation) => ready.add(conversation.conversationId),
      onUnready: (conversation) => unready.push(conversation.conversationId),
      onError: (_conversation, error) => errors.push(error),
      ...extraHooks,
    },
    namesProbeMs: 0, // tests drive NAMES explicitly unless they opt into the probe timer
    ...extra,
  });
  return { engine, sent, errors, ready, unready };
}

function historyBatch(
  target: string,
  messages: { id: string; time?: string; text?: string; account?: string }[],
  id = "h1",
): string {
  let out = `BATCH +${id} chathistory ${target}\r\n`;
  for (const message of messages) {
    out += `@batch=${id};msgid=${message.id};time=${message.time ?? T};account=${message.account ?? "alice"} :alice!u@h PRIVMSG ${target} :${message.text ?? message.id}\r\n`;
  }
  out += `BATCH -${id}\r\n`;
  return out;
}

function multilineBatch(target: string, cid: string, msgid: string, lines: string[], id = "L"): string {
  let out = `@+slirc/cid=${cid};msgid=${msgid};time=${T};account=alice :alice!u@h BATCH +${id} draft/multiline ${target}\r\n`;
  for (const line of lines) out += `@batch=${id} :alice!u@h PRIVMSG ${target} :${line}\r\n`;
  out += `BATCH -${id}\r\n`;
  return out;
}

// A CHATHISTORY reply whose multiline message replays as a nested draft/multiline batch (C1).
function historyWithMultiline(target: string, cid: string, msgid: string, lines: string[], id = "h9"): string {
  let out = `BATCH +${id} chathistory ${target}\r\n`;
  out += `@batch=${id};+slirc/cid=${cid};msgid=${msgid};time=${T};account=alice :alice!u@h BATCH +n1 draft/multiline ${target}\r\n`;
  for (const line of lines) out += `@batch=n1 :alice!u@h PRIVMSG ${target} :${line}\r\n`;
  out += `BATCH -n1\r\nBATCH -${id}\r\n`;
  return out;
}

function reactionBatch(target: string, replyTo: string, reactId: string, time: string, id = "hr"): string {
  return (
    `BATCH +${id} chathistory ${target}\r\n` +
    `@batch=${id};msgid=${reactId};time=${time};account=bob;+draft/reply=${replyTo};+draft/react=👍 :bob!u@h TAGMSG ${target}\r\n` +
    `BATCH -${id}\r\n`
  );
}

const WELCOME = ":srv 001 alice :welcome\r\n";
const join = (target: string) => `:alice!u@h JOIN ${target}\r\n`;

async function readyRoom(engine: ReturnType<typeof harness>["engine"], db: InstanceType<typeof ClientDatabase>, wire: string, cid: string) {
  engine.recover([{ conversationId: cid, wireTarget: wire }]);
  engine.push(WELCOME);
  engine.push(join(wire));
  await engine.whenIdle();
}

test("the same server msgid in two conversations cannot collide or merge their history", async () => {
  const db = open("cross-room-server-id");
  const { engine, errors } = harness(db);
  const a = conversationId("room", "#a");
  const b = conversationId("room", "#b");
  engine.recover([{ conversationId: a, wireTarget: "#a" }, { conversationId: b, wireTarget: "#b" }]);
  engine.push(WELCOME + join("#a") + join("#b"));
  await engine.whenIdle();
  engine.push(historyBatch("#a", [{ id: "shared", text: "room A" }], "ha"));
  engine.push(historyBatch("#b", [{ id: "shared", text: "room B" }], "hb"));
  await engine.whenIdle();
  expect(errors).toEqual([]);
  const rows = await db.messages.toArray();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  expect(rows.map((row) => [row.conversationId, row.text]).sort()).toEqual([[a, "room A"], [b, "room B"]].sort());
});

test("an old page finishing its transaction after reconnect cannot ready the new connection", async () => {
  const db = open("epoch-during-commit");
  const { engine } = harness(db);
  const cid = conversationId("room", "#race");
  await readyRoom(engine, db, "#race", cid);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const apply = db.applyBatch.bind(db);
  db.applyBatch = async (batch) => { await gate; await apply(batch); };
  engine.push(historyBatch("#race", [{ id: "old-page" }]));
  engine.onDisconnect();
  engine.push(WELCOME);
  release();
  await engine.whenIdle();
  expect(engine.isReady(cid)).toBe(false);
  engine.push(join("#race"));
  await engine.whenIdle();
  engine.push(historyBatch("#race", [{ id: "old-page" }], "new-page"));
  await engine.whenIdle();
  expect(engine.isReady(cid)).toBe(true);
  engine.recover([{ conversationId: cid, wireTarget: "#race" }]);
  expect(engine.isReady(cid)).toBe(false);
});

// --- irc.ts ------------------------------------------------------------------------------------

test("parseIrcLine unescapes IRCv3 tags and splits prefix, command, and trailing params", () => {
  const message = parseIrcLine(
    "@batch=1;time=2026-09-12T20:39:29.873Z;bot;+draft/reply=a\\sb\\:c :nick!u@h PRIVMSG #room :hello world",
  );
  expect(message).not.toBeNull();
  expect(message!.tags.batch).toBe("1");
  expect(message!.tags.bot).toBe("");
  expect(message!.tags["+draft/reply"]).toBe("a b;c");
  expect(message!.prefix).toBe("nick!u@h");
  expect(message!.command).toBe("PRIVMSG");
  expect(message!.params).toEqual(["#room", "hello world"]);
  expect(parseIrcLine("PING :abc")).toEqual({ tags: {}, prefix: undefined, command: "PING", params: ["abc"] });
  expect(parseIrcLine("")).toBeNull();
  expect(parseIrcLine("@onlytags")).toBeNull();
});

test("assembler rejoins fragmented lines and a UTF-8 character split across reads", () => {
  const lines: ReturnType<typeof parseIrcLine>[] = [];
  const assembler = new BatchAssembler({ onLine: (message) => lines.push(message), onBatch: () => {} });
  assembler.push(":n!u@h PRIVMSG #r :par");
  assembler.push("tial\r\nPING :x\r");
  expect(lines.map((message) => message!.command)).toEqual(["PRIVMSG"]);
  const bytes = new TextEncoder().encode("\n:alice!u@h PRIVMSG #r :héllo\r\n");
  for (const byte of bytes) assembler.push(new Uint8Array([byte]));
  expect(lines.map((message) => message!.command)).toEqual(["PRIVMSG", "PING", "PRIVMSG"]);
  expect(lines[2]!.params[1]).toBe("héllo");
});

test("a multiline batch is delivered only on close, with +slirc/cid on the opener", () => {
  const batches: any[] = [];
  const assembler = new BatchAssembler({ onLine: () => {}, onBatch: (batch) => batches.push(batch) });
  assembler.push("@+slirc/cid=c2 :alice!u@h BATCH +1 draft/multiline #r\r\n");
  assembler.push("@batch=1 :alice!u@h PRIVMSG #r :first\r\n");
  expect(batches).toHaveLength(0);
  assembler.push(`@batch=1 :alice!u@h PRIVMSG #r :second\r\nBATCH -1\r\n`);
  expect(batches).toHaveLength(1);
  expect(batches[0].complete).toBe(true);
  expect(batches[0].tags["+slirc/cid"]).toBe("c2");
  expect(batches[0].items.filter((item: any) => item.kind === "line")).toHaveLength(2);
});

test("nested chathistory/multiline resolves the inner batch before the outer one closes", () => {
  const batches: any[] = [];
  const assembler = new BatchAssembler({ onLine: () => {}, onBatch: (batch) => batches.push(batch) });
  assembler.push(`BATCH +10 chathistory #r\r\n`);
  assembler.push(`@batch=10 :alice!u@h PRIVMSG #r :one\r\n`);
  assembler.push(`@batch=10;+slirc/cid=c9;msgid=m2 :alice!u@h BATCH +11 draft/multiline #r\r\n`);
  assembler.push(`@batch=11 :alice!u@h PRIVMSG #r :line1\r\n`);
  assembler.push(`@batch=11 :alice!u@h PRIVMSG #r :line2\r\n`);
  assembler.push(`BATCH -11\r\n`);
  expect(batches).toHaveLength(0);
  assembler.push(`BATCH -10\r\n`);
  expect(batches).toHaveLength(1);
  const nested = batches[0].items.find((item: any) => item.kind === "batch")!;
  expect(nested.batch.type).toBe("draft/multiline");
  expect(nested.batch.complete).toBe(true);
});

test("bounds drop an oversized line and poison an oversized batch", () => {
  const dropped: [string, string][] = [];
  const batches: any[] = [];
  const line = new BatchAssembler({
    onLine: () => {},
    onBatch: () => {},
    onDrop: (id, reason) => dropped.push([id, reason]),
    maxLineBytes: 8,
  });
  line.push("this line has no newline and is too long");
  expect(dropped).toContainEqual(["", "line-too-long"]);

  const batch = new BatchAssembler({
    onLine: () => {},
    onBatch: (value) => batches.push(value),
    onDrop: (id, reason) => dropped.push([id, reason]),
    maxBatchLines: 2,
  });
  batch.push("BATCH +b draft/multiline #r\r\n");
  batch.push("@batch=b :a!u@h PRIVMSG #r :1\r\n");
  batch.push("@batch=b :a!u@h PRIVMSG #r :2\r\n");
  batch.push("@batch=b :a!u@h PRIVMSG #r :3\r\n");
  batch.push("BATCH -b\r\n");
  expect(dropped).toContainEqual(["b", "batch-too-many-lines"]);
  expect(batches).toHaveLength(0);
});

test("reset drops an unfinished batch without delivery", () => {
  const dropped: [string, string][] = [];
  const batches: any[] = [];
  const assembler = new BatchAssembler({
    onLine: () => {},
    onBatch: (batch) => batches.push(batch),
    onDrop: (id, reason) => dropped.push([id, reason]),
  });
  assembler.push("BATCH +b chathistory #r\r\n@batch=b :a!u@h PRIVMSG #r :half\r\n");
  assembler.reset("disconnect");
  expect(dropped).toContainEqual(["b", "disconnect"]);
  assembler.push("BATCH -b\r\n");
  expect(batches).toHaveLength(0);
});

// --- sync.ts -----------------------------------------------------------------------------------

test("001 joins every conversation in one comma-list line, not one fakelagged line each", async () => {
  const db = open("sync-join-batch");
  const { engine, sent } = harness(db);
  const rooms = ["#a", "#b", "#c"].map((target) => ({ conversationId: conversationId("room", target), wireTarget: target }));
  engine.recover(rooms);
  engine.push(WELCOME);
  expect(sent).toEqual(["JOIN #a,#b,#c"]);
  // Each echo still starts that room's history on its own.
  engine.push(join("#b"));
  await engine.whenIdle();
  expect(sent.some((line) => line.startsWith("CHATHISTORY") && line.includes(" #b "))).toBe(true);
  expect(sent.some((line) => line.startsWith("CHATHISTORY") && line.includes(" #a "))).toBe(false);
});

test("comma-list JOIN lines stay under the length cap", () => {
  const targets = Array.from({ length: 30 }, (_, i) => `#dm-bitbonsai-person-${String(i).padStart(2, "0")}`);
  const lines = buildJoinCommands(targets);
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(400);
  expect(lines.flatMap((line) => line.slice("JOIN ".length).split(","))).toEqual(targets);
  expect(buildJoinCommands([])).toEqual([]);
});

test("a room only becomes ready after JOIN echo and an applied history page", async () => {
  const db = open("sync-ready");
  const { engine, sent, ready } = harness(db);
  engine.recover([{ conversationId: conversationId("room", "#r"), wireTarget: "#r" }]);
  engine.push(WELCOME);
  expect(sent).toEqual(["JOIN #r"]);
  expect(engine.isReady(conversationId("room", "#r"))).toBe(false);

  engine.push(join("#r"));
  await engine.whenIdle();
  expect(sent).toContain("CHATHISTORY LATEST #r * 250");
  expect(engine.isReady(conversationId("room", "#r"))).toBe(false);

  engine.push(historyBatch("#r", [{ id: "m1" }]));
  await engine.whenIdle();
  expect(engine.isReady(conversationId("room", "#r"))).toBe(true);
  expect(ready.has(conversationId("room", "#r"))).toBe(true);
  expect((await db.messages.toArray()).map((message) => message.serverId)).toEqual(["m1"]);
});

test("PRIVMSG +reply survives live and chathistory parsing; multiline reads opener tag", () => {
  const line = parseIrcLine(`@msgid=reply-1;time=${T};account=alice;+reply=root-1 :alice!u@h PRIVMSG #r :reply`)!;
  const ordinary = eventsFromBatch("room-r", { id: "live", type: "privmsg", params: ["#r"], tags: {}, complete: true, items: [{ kind: "line", message: line }] });
  expect(ordinary[0]).toMatchObject({ type: "message", message: { replyTo: "root-1" } });
  const legacyLine = parseIrcLine(`@msgid=reply-2;time=${T};account=alice;+draft/reply=root-2 :alice!u@h PRIVMSG #r :legacy`)!;
  const legacy = eventsFromBatch("room-r", { id: "hist", type: "chathistory", params: ["#r"], tags: {}, complete: true, items: [{ kind: "line", message: legacyLine }] });
  expect(legacy[0]).toMatchObject({ type: "message", message: { replyTo: "root-2" } });
  const assembler = new BatchAssembler({ onLine: () => {}, onBatch: (batch) => {
    if (batch.type === "draft/multiline") expect(eventsFromBatch("room-r", batch)[0]).toMatchObject({ type: "message", message: { replyTo: "root-3" } });
  } });
  assembler.push(`@+reply=root-3 :alice!u@h BATCH +m1 draft/multiline #r\r\n@batch=m1 :alice!u@h PRIVMSG #r :one\r\nBATCH -m1\r\n`);
});

test("protocol events carry their own position, separate from a reaction/redaction target", () => {
  const reactionLine = parseIrcLine(
    `@batch=h;msgid=re1;time=${T};account=bob;+draft/reply=m1;+draft/react=👍 :bob!u@h TAGMSG #r`,
  )!;
  const redactLine = parseIrcLine(`@batch=h;msgid=rd1;time=2026-09-27T10:00:03.000Z;account=bob :bob!u@h REDACT #r m1`)!;
  const batch = { id: "h", type: "chathistory", params: ["#r"], tags: {}, complete: true as const, items: [
    { kind: "line" as const, message: reactionLine },
    { kind: "line" as const, message: redactLine },
  ] };
  const events = eventsFromBatch("#r", batch);
  expect(events[0]).toMatchObject({
    type: "reaction",
    position: { serverId: "re1", time: T },
    reaction: { messageServerId: "m1", account: "bob", emoji: "👍", ordering: { source: "history", seq: 0, batch: "h", time: T, eventId: "re1" } },
  });
  expect(events[1]).toMatchObject({ type: "redaction", serverId: "m1", position: { serverId: "rd1", time: "2026-09-27T10:00:03.000Z" } });
  expect(checkpointOf("#r", events)).toEqual({ conversationId: "#r", serverId: "rd1", time: "2026-09-27T10:00:03.000Z" });
});

test("TAGMSG reactions read +reply, the same target a normal reply uses", () => {
  const react = parseIrcLine(`@msgid=rx1;time=${T};account=bob;+reply=m1;+draft/react=👍 :bob!u@h TAGMSG #r`)!;
  const unreact = parseIrcLine(`@msgid=rx2;time=${T};account=bob;+reply=m1;+draft/unreact=👍 :bob!u@h TAGMSG #r`)!;
  const events = eventsFromBatch("#r", { id: "h", type: "chathistory", params: ["#r"], tags: {}, complete: true, items: [
    { kind: "line", message: react },
    { kind: "line", message: unreact },
  ] });
  expect(events[0]).toMatchObject({ type: "reaction", remove: false, reaction: { messageServerId: "m1", emoji: "👍" } });
  expect(events[1]).toMatchObject({ type: "reaction", remove: true, reaction: { messageServerId: "m1", emoji: "👍" } });
});

test("reaction targets follow reply precedence and reject malformed values", () => {
  const batchFor = (tags: string) => eventsFromBatch("#r", { id: "h", type: "chathistory", params: ["#r"], tags: {}, complete: true, items: [
    { kind: "line", message: parseIrcLine(`@msgid=x;time=${T};account=bob;${tags} :bob!u@h TAGMSG #r`)! },
  ] });
  // +reply wins over +draft/reply, exactly like PRIVMSG.
  expect(batchFor("+reply=root-1;+draft/reply=root-2;+draft/react=👍")[0]).toMatchObject({ type: "reaction", reaction: { messageServerId: "root-1" } });
  // The legacy tag still works on its own.
  expect(batchFor("+draft/reply=root-2;+draft/react=👍")[0]).toMatchObject({ type: "reaction", reaction: { messageServerId: "root-2" } });
  // A missing or malformed target invents no reaction.
  expect(batchFor("+draft/react=👍")).toEqual([]);
  expect(batchFor("+reply=a b;+draft/react=👍")).toEqual([]);
});

test("a live TAGMSG reaction with only +reply is persisted and removable", async () => {
  const db = open("sync-reply-react");
  const { engine } = harness(db);
  const room = conversationId("room", "#r");
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", [{ id: "m1", time: T }]));
  await engine.whenIdle();
  engine.push(`@msgid=rx1;time=${T};account=bob;+reply=m1;+draft/react=👍 :bob!u@h TAGMSG #r\r\n`);
  engine.push(`@msgid=rx2;time=${T};account=bob;+reply=m1;+draft/unreact=👍 :bob!u@h TAGMSG #r\r\n`);
  await engine.whenIdle();
  expect(await db.reactions.toArray()).toEqual([
    expect.objectContaining({ conversationId: room, messageServerId: "m1", account: "bob", emoji: "👍", active: false }),
  ]);
});

test("a live TAGMSG typing tag reaches the live hook; a history page never does", async () => {
  const db = open("sync-typing-live");
  const live: string[] = [];
  const { engine } = harness(db, { hooks: { onLive: (_conversation: unknown, message: { tags: Record<string, string> }) => {
    const value = message.tags["+typing"] ?? message.tags["+draft/typing"];
    if (value) live.push(value);
  } } });
  const room = conversationId("room", "#r");
  await readyRoom(engine, db, "#r", room);
  // A typing tag replayed inside the awaited chathistory page is ignored: the hook is live-only.
  engine.push(`BATCH +h chathistory #r\r\n@batch=h;time=${T};account=bob;+typing=active :bob!u@h TAGMSG #r\r\nBATCH -h\r\n`);
  await engine.whenIdle();
  expect(live).toEqual([]);
  // Live lines do reach it, on both the final tag and the draft-era alias.
  engine.push(`@time=${T};account=bob;+typing=active :bob!u@h TAGMSG #r\r\n`);
  engine.push(`@time=${T};account=bob;+draft/typing=done :bob!u@h TAGMSG #r\r\n`);
  await engine.whenIdle();
  expect(live).toEqual(["active", "done"]);
});

test("a reaction-only page advances the checkpoint to the reaction's own msgid/time", async () => {
  const db = open("sync-reaction");
  const { engine } = harness(db);
  const room = conversationId("room", "#r");
  await readyRoom(engine, db, "#r", room);
  const reactTime = "2026-09-27T10:00:07.000Z";
  engine.push(reactionBatch("#r", "m1", "re1", reactTime));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
  expect(await db.progress.get(room)).toEqual({ conversationId: room, serverId: "re1", time: reactTime });
});

test("a checkpoint older than stored progress does not regress it", async () => {
  const db = open("sync-regress");
  const room = conversationId("room", "#r");
  const storedTime = "2026-09-27T11:00:00.000Z";
  await db.progress.put({ conversationId: room, serverId: "newer", time: storedTime });
  const { engine } = harness(db);
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", [{ id: "old1", time: "2026-09-27T09:00:00.000Z" }]));
  await engine.whenIdle();
  // The resume page lacked the checkpoint message, so one LATEST page re-checks before ready.
  engine.push(historyBatch("#r", [{ id: "old1", time: "2026-09-27T09:00:00.000Z" }], "h2"));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
  expect(await db.progress.get(room)).toEqual({ conversationId: room, serverId: "newer", time: storedTime });
});

test("a full page pages forward by the final applied msgid, then a short page completes", async () => {
  const db = open("sync-pages");
  // ponytail: three rows exercise the page boundary without a production-sized fixture.
  const { engine, sent } = harness(db, { pageLimit: 3 });
  const room = conversationId("room", "#r");
  const equal = Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, time: T }));
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", equal));
  await engine.whenIdle();
  expect(sent).toContain("CHATHISTORY AFTER #r msgid=m2 3");
  expect(engine.isReady(room)).toBe(false);

  engine.push(historyBatch("#r", [{ id: "m3", time: T }], "h2"));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
  expect(await db.messages.where("conversationId").equals(room).count()).toBe(4);
});

test("checkpoint is the final applied server msgid/time, never the request wall clock", async () => {
  const db = open("sync-checkpoint");
  const { engine } = harness(db, { now: () => new Date("2030-01-01T00:00:00.000Z") });
  const room = conversationId("room", "#r");
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", [{ id: "m1", time: T }, { id: "m2", time: "2026-09-27T10:00:05.000Z" }]));
  await engine.whenIdle();
  expect(await db.progress.get(room)).toEqual({
    conversationId: room,
    serverId: "m2",
    time: "2026-09-27T10:00:05.000Z",
  });
});

test("a refused page leaves the room unready and untouched", async () => {
  const db = open("sync-refused");
  const { engine, errors, sent } = harness(db);
  const room = conversationId("room", "#r");
  engine.recover([{ conversationId: room, wireTarget: "#r" }]);
  engine.push(WELCOME);
  engine.push(join("#r"));
  await engine.whenIdle();
  expect(sent).toContain("CHATHISTORY LATEST #r * 250");

  engine.push("FAIL CHATHISTORY INVALID_TARGET #r :Messages could not be retrieved\r\n");
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(false);
  expect(errors.some((error) => /refused/.test(error.message))).toBe(true);
  expect(await db.progress.get(room)).toBeUndefined();
});

test("a cycling msgid cursor is rejected instead of paging forever", async () => {
  const db = open("sync-cycling");
  const room = conversationId("room", "#r");
  await db.progress.put({ conversationId: room, serverId: "c2", time: T });
  const { engine, errors, sent } = harness(db, { pageLimit: 3 });
  engine.recover([{ conversationId: room, wireTarget: "#r" }]);
  engine.push(WELCOME);
  engine.push(join("#r"));
  await engine.whenIdle();
  // The resume anchors on time; paging from there is by msgid, which is where a cycle shows.
  expect(sent).toContain("CHATHISTORY AFTER #r timestamp=2026-09-27T09:59:59.999Z 3");
  const page = () => historyBatch("#r", Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, time: T })));
  engine.push(page());
  await engine.whenIdle();
  expect(sent.at(-1)).toBe("CHATHISTORY AFTER #r msgid=c2 3");

  engine.push(page());
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(false);
  expect(errors.some((error) => /did not advance/.test(error.message))).toBe(true);
});

test("51 authorized conversations all join and sync (no capped TARGETS truncation)", async () => {
  const db = open("sync-51");
  const { engine, sent, ready } = harness(db);
  const conversations = Array.from({ length: 51 }, (_, i) => ({
    conversationId: conversationId("room", `#room${i}`),
    wireTarget: `#room${i}`,
  }));
  engine.recover(conversations);
  engine.push(WELCOME);
  const joined = sent.filter((line) => line.startsWith("JOIN ")).flatMap((line) => line.slice("JOIN ".length).split(","));
  expect(joined).toHaveLength(51);
  expect(sent.filter((line) => line.startsWith("JOIN ")).length).toBeLessThan(5);

  for (const conversation of conversations) engine.push(join(conversation.wireTarget));
  await engine.whenIdle();
  expect(sent.filter((line) => line.startsWith("CHATHISTORY LATEST "))).toHaveLength(51);
  for (const conversation of conversations) {
    engine.push(historyBatch(conversation.wireTarget, [{ id: `${conversation.wireTarget}-m1` }]));
  }
  await engine.whenIdle();
  expect(ready.size).toBe(51);
  for (const conversation of conversations) expect(engine.isReady(conversation.conversationId)).toBe(true);
  expect(await db.messages.count()).toBe(51);
});

test("a rejected Dexie transaction advances neither progress nor readiness", async () => {
  const db = open("sync-abort");
  const { engine, errors } = harness(db);
  const room = conversationId("room", "#r");
  await readyRoom(engine, db, "#r", room);

  // Two messages with the same server msgid but different accounts: db.applyBatch rejects the
  // conflict, so the first page and its checkpoint never commit and the room stays unready.
  engine.push(
    `BATCH +bad chathistory #r\r\n` +
      `@batch=bad;msgid=dup;time=${T};account=alice :alice!u@h PRIVMSG #r :first\r\n` +
      `@batch=bad;msgid=dup;time=${T};account=bob :bob!u@h PRIVMSG #r :second\r\n` +
      `BATCH -bad\r\n`,
  );
  await engine.whenIdle();
  expect(errors.length).toBeGreaterThan(0);
  expect(engine.isReady(room)).toBe(false);
  expect(await db.progress.get(room)).toBeUndefined();
  expect(await db.messages.where("conversationId").equals(room).count()).toBe(0);
});

test("disconnect clears readiness and makes a late batch from the old epoch a no-op", async () => {
  const db = open("sync-epoch");
  const { engine, sent, ready } = harness(db);
  const room = conversationId("room", "#r");
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", [{ id: "m1" }]));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);

  engine.onDisconnect();
  expect(engine.isReady(room)).toBe(false);
  expect(engine.isAuthenticated()).toBe(false);

  engine.push(historyBatch("#r", [{ id: "stale" }]));
  await engine.whenIdle();
  expect(await db.messages.where("conversationId").equals(room).count()).toBe(1);

  engine.push(WELCOME);
  engine.push(join("#r"));
  await engine.whenIdle();
  expect(sent.filter((line) => line === "JOIN #r")).toHaveLength(2);
  engine.push(historyBatch("#r", [{ id: "m1" }, { id: "m2" }], "h3"));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
  expect(await db.messages.where("conversationId").equals(room).count()).toBe(2);
});

test("an auth refusal stays unauthenticated and later recovers on a fresh 001", async () => {
  const db = open("sync-auth");
  const { engine, errors, sent } = harness(db);
  const room = conversationId("room", "#r");
  engine.recover([{ conversationId: room, wireTarget: "#r" }]);
  engine.push(":srv 904 alice :SASL authentication failed\r\n");
  expect(engine.isAuthenticated()).toBe(false);
  expect(engine.isReady(room)).toBe(false);
  expect(sent).toHaveLength(0);
  expect(errors.some((error) => /authentication/.test(error.message))).toBe(true);

  engine.push(WELCOME);
  expect(engine.isAuthenticated()).toBe(true);
  expect(sent).toContain("JOIN #r");
});

test("live multiline and the same message replayed by history dedup to one row", async () => {
  const db = open("sync-dedup");
  const { engine } = harness(db);
  const room = conversationId("room", "#r");
  await readyRoom(engine, db, "#r", room);

  engine.push(multilineBatch("#r", "cid-7", "s2", ["first", "second"]));
  await engine.whenIdle();
  expect(await db.messages.where("conversationId").equals(room).count()).toBe(1);
  const live = await db.messages.where("[conversationId+serverId]").equals([room, "s2"]).first();
  expect(live?.text).toBe("first\nsecond");
  expect(live?.clientId).toBe("cid-7");

  engine.push(historyWithMultiline("#r", "cid-7", "s2", ["first", "second"]));
  await engine.whenIdle();
  expect(await db.messages.where("conversationId").equals(room).count()).toBe(1);
});

test("ensure adds a new conversation without rejoining a ready one", async () => {
  const db = open("sync-ensure-add");
  const { engine, sent, ready } = harness(db);
  const a = conversationId("room", "#a");
  const b = conversationId("room", "#b");
  await readyRoom(engine, db, "#a", a);
  engine.push(historyBatch("#a", [{ id: "a1" }]));
  await engine.whenIdle();
  expect(engine.isReady(a)).toBe(true);

  engine.ensure([{ conversationId: a, wireTarget: "#a" }, { conversationId: b, wireTarget: "#b" }]);
  expect(sent.filter((line) => line === "JOIN #a")).toHaveLength(1);
  expect(sent.filter((line) => line === "JOIN #b")).toHaveLength(1);
  expect(engine.isReady(a)).toBe(true); // an existing ready room is untouched
  expect(engine.isReady(b)).toBe(false);

  // A second identity sync must not re-issue JOIN or history for either conversation.
  engine.ensure([{ conversationId: a, wireTarget: "#a" }, { conversationId: b, wireTarget: "#b" }]);
  expect(sent.filter((line) => line === "JOIN #a")).toHaveLength(1);
  expect(sent.filter((line) => line === "JOIN #b")).toHaveLength(1);

  engine.push(join("#b"));
  await engine.whenIdle();
  engine.push(historyBatch("#b", [{ id: "b1" }]));
  await engine.whenIdle();
  expect(ready.has(b)).toBe(true);
});

test("ensure recovers fresh when the server-owned target changes", async () => {
  const db = open("sync-ensure-retarget");
  const { engine, sent, unready } = harness(db);
  const a = conversationId("room", "#a");
  await readyRoom(engine, db, "#a", a);
  engine.push(historyBatch("#a", [{ id: "a1" }]));
  await engine.whenIdle();
  expect(engine.isReady(a)).toBe(true);

  engine.ensure([{ conversationId: a, wireTarget: "#a-renamed" }]);
  // The old target no longer describes the conversation: readiness drops and it re-joins.
  expect(engine.isReady(a)).toBe(false);
  expect(unready).toContain(a);
  expect(sent.filter((line) => line === "JOIN #a-renamed")).toHaveLength(1);

  // A repeat identity update for the same new target is a no-op.
  engine.ensure([{ conversationId: a, wireTarget: "#a-renamed" }]);
  expect(sent.filter((line) => line === "JOIN #a-renamed")).toHaveLength(1);

  engine.push(":alice!u@h JOIN #a-renamed\r\n");
  await engine.whenIdle();
  engine.push(historyBatch("#a-renamed", [{ id: "a1" }, { id: "a2" }], "hr"));
  await engine.whenIdle();
  expect(engine.isReady(a)).toBe(true);
  expect(sent.filter((line) => line === "JOIN #a")).toHaveLength(1);
});

test("a self-JOIN seen before authorization never readies or skips the membership proof", async () => {
  const db = open("sync-early-join");
  const { engine, sent } = harness(db, { nick: "alice", namesProbeMs: 10 });
  const a = conversationId("room", "#a");
  const b = conversationId("room", "#b");
  engine.recover([{ conversationId: a, wireTarget: "#a" }]);
  engine.push(WELCOME);
  await engine.whenIdle();
  expect(sent).toContain("JOIN #a");

  // Ergo multiclient joins this connection to #b before the client knows #b is authorized. That
  // JOIN is not metadata and is ignored; the later JOIN + NAMES probe is the actual proof.
  engine.push(":alice!u@h JOIN #b\r\n");
  await engine.whenIdle();
  expect(engine.isReady(b)).toBe(false);

  engine.ensure([{ conversationId: a, wireTarget: "#a" }, { conversationId: b, wireTarget: "#b" }]);
  await engine.whenIdle();
  expect(sent).toContain("JOIN #b");
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(sent).toContain("NAMES #b");
  expect(engine.isReady(b)).toBe(false); // NAMES is only sent; it has not proven anything yet

  engine.push(":srv 353 alice = #b :~alice\r\n");
  await engine.whenIdle();
  expect(sent).toContain("CHATHISTORY LATEST #b * 250");
  engine.push(historyBatch("#b", [{ id: "b1" }]));
  await engine.whenIdle();
  expect(engine.isReady(b)).toBe(true);
});

test("without a known nick a 353/366 never proves membership", async () => {
  const db = open("sync-nick-missing");
  const { engine, sent } = harness(db); // no nick
  const room = conversationId("room", "#r");
  engine.recover([{ conversationId: room, wireTarget: "#r" }]);
  engine.push(WELCOME);
  engine.push(":srv 353 eve = #r :~eve\r\n:srv 366 eve #r :End of /NAMES list\r\n");
  await engine.whenIdle();
  expect(sent).not.toContain("CHATHISTORY LATEST #r * 250");
  expect(engine.isReady(room)).toBe(false);

  // The ordinary JOIN echo is still proof, so conversations do not stall merely because the
  // bridge has not reported our nick yet.
  engine.push(join("#r"));
  await engine.whenIdle();
  expect(sent).toContain("CHATHISTORY LATEST #r * 250");
});

test("a 353 listing our own nick stands in for a suppressed JOIN echo", async () => {
  const db = open("sync-names-join");
  const { engine, sent } = harness(db, { nick: "eve" });
  const room = conversationId("room", "#r");
  engine.recover([{ conversationId: room, wireTarget: "#r" }]);
  engine.push(WELCOME);
  expect(sent).toEqual(["JOIN #r"]);

  // The server already holds the membership, so it answers the JOIN with NAMES, not JOIN. Owner
  // prefixes must not hide our nick.
  engine.push(":srv 353 eve @ #r :~slirc-org ~eve\r\n:srv 366 eve #r :End of /NAMES list\r\n");
  await engine.whenIdle();
  expect(sent).toContain("CHATHISTORY LATEST #r * 250");
  expect(engine.isReady(room)).toBe(false);

  engine.push(historyBatch("#r", [{ id: "m1" }]));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
});

test("a 353 without our nick, and 366 alone, never start history", async () => {
  const db = open("sync-names-unknown");
  const { engine, sent } = harness(db, { nick: "eve" });
  const room = conversationId("room", "#r");
  engine.recover([{ conversationId: room, wireTarget: "#r" }]);
  engine.push(WELCOME);
  // A NAMES reply for a room we are not in lists someone else; a bare 366 proves nothing.
  engine.push(":srv 353 eve = #r :~ada\r\n:srv 366 eve #r :End of /NAMES list\r\n");
  await engine.whenIdle();
  expect(sent).not.toContain("CHATHISTORY LATEST #r * 250");
  expect(engine.isReady(room)).toBe(false);
});

test("a silent JOIN is recovered by a NAMES probe listing our nick", async () => {
  const db = open("sync-names-probe");
  const { engine, sent } = harness(db, { nick: "eve", namesProbeMs: 10 });
  const room = conversationId("room", "#r");
  engine.recover([{ conversationId: room, wireTarget: "#r" }]);
  engine.push(WELCOME);
  expect(sent).toEqual(["JOIN #r"]);

  // The JOIN gets no reply at all; the probe must ask NAMES and then history must still gate.
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(sent).toContain("NAMES #r");
  engine.push(":srv 353 eve = #r :~eve\r\n");
  await engine.whenIdle();
  expect(sent).toContain("CHATHISTORY LATEST #r * 250");
  expect(engine.isReady(room)).toBe(false);

  engine.push(historyBatch("#r", [{ id: "m1" }]));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
});

test("ensure drops a conversation that is no longer authorized and unreadies it", async () => {
  const db = open("sync-ensure-drop");
  const { engine, unready } = harness(db);
  const a = conversationId("room", "#a");
  await readyRoom(engine, db, "#a", a);
  engine.push(historyBatch("#a", [{ id: "a1" }]));
  await engine.whenIdle();
  expect(engine.isReady(a)).toBe(true);

  engine.ensure([]);
  expect(engine.isReady(a)).toBe(false);
  expect(unready).toContain(a);
});

test("an empty complete page is caught up, not a failure", async () => {
  const db = open("sync-empty");
  const { engine, errors } = harness(db);
  const room = conversationId("room", "#r");
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", []));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
  expect(errors).toHaveLength(0);
  expect(await db.progress.get(room)).toBeUndefined();
});

// Ergo answers `AFTER msgid=<unknown>` with an empty batch, no FAIL (sqliteHistorySequence.Between).
// A checkpoint on a message deleted or edited later froze the room at that message for good.
test("a resume anchors on the checkpoint time, so a deleted checkpoint message cannot freeze the room", async () => {
  const db = open("sync-stale-checkpoint");
  const room = conversationId("room", "#r");
  const { engine, sent } = harness(db);
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", [{ id: "gone", time: T }]));
  await engine.whenIdle();
  expect(await db.progress.get(room)).toEqual({ conversationId: room, serverId: "gone", time: T });

  // Reconnect after "gone" was redacted on the server and newer messages arrived.
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  expect(sent.at(-1)).toBe("CHATHISTORY AFTER #r timestamp=2026-09-27T09:59:59.999Z 250");
  expect(sent.some((line) => line.includes("msgid=gone"))).toBe(false);
  engine.push(historyBatch("#r", [
    { id: "same-ms", time: T },
    { id: "newer", time: "2026-09-27T10:05:00.000Z" },
  ], "h2"));
  await engine.whenIdle();
  // "gone" was not replayed, so the room re-checks with LATEST before it is ready.
  expect(sent.at(-1)).toBe("CHATHISTORY LATEST #r * 250");
  expect(engine.isReady(room)).toBe(false);
  engine.push(historyBatch("#r", [
    { id: "same-ms", time: T },
    { id: "newer", time: "2026-09-27T10:05:00.000Z" },
  ], "h3"));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
  expect(await db.progress.get(room)).toEqual({ conversationId: room, serverId: "newer", time: "2026-09-27T10:05:00.000Z" });
  const rows = await db.messages.where("conversationId").equals(room).toArray();
  expect(rows.map((row) => row.serverId).sort()).toEqual(["newer", "same-ms"]);
});

// --- history reset: cached rows the server no longer has ---------------------------------------

const H = (minute: number) => `2026-09-27T10:${String(minute).padStart(2, "0")}:00.000Z`;

async function seeded(name: string, ids: string[]) {
  const db = open(name);
  const room = conversationId("room", "#r");
  const { engine, sent, errors } = harness(db, { pageLimit: 3 });
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", ids.map((id, i) => ({ id, time: H(i) }))));
  await engine.whenIdle();
  return { db, room, engine, sent, errors };
}

const serverIds = async (db: InstanceType<typeof ClientDatabase>, room: string) =>
  (await db.messages.where("conversationId").equals(room).toArray()).map((row) => row.serverId ?? `local:${row.text}`).sort();

test("after a history reset, a reload drops cached messages the server no longer has", async () => {
  const { db, room, engine, sent, errors } = await seeded("reset-empty", ["poll", "m1"]);
  expect(await serverIds(db, room)).toEqual(["m1", "poll"]);
  // Reset: Ergo now has nothing. Resume AFTER comes back empty, then LATEST comes back empty.
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  expect(sent.at(-1)).toStartWith("CHATHISTORY AFTER #r timestamp=");
  engine.push(historyBatch("#r", [], "r1"));
  await engine.whenIdle();
  expect(sent.at(-1)).toBe("CHATHISTORY LATEST #r * 3");
  engine.push(historyBatch("#r", [], "r2"));
  await engine.whenIdle();
  expect(errors).toEqual([]);
  expect(engine.isReady(room)).toBe(true);
  expect(await serverIds(db, room)).toEqual([]);
});

test("after a reset with new messages, old cached rows go and new ones stay", async () => {
  const { db, room, engine } = await seeded("reset-new", ["old-a", "old-b"]);
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  engine.push(historyBatch("#r", [{ id: "new-1", time: H(30) }], "r1"));
  await engine.whenIdle();
  engine.push(historyBatch("#r", [{ id: "new-1", time: H(30) }], "r2"));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
  expect(await serverIds(db, room)).toEqual(["new-1"]);
});

test("a full LATEST page prunes only from its oldest message on, never older cache", async () => {
  const { db, room, engine } = await seeded("reset-full-latest", ["a", "b"]);
  // Reset, then three new messages fill the page; the cache before H(10) was not asked about.
  await db.messages.put({ id: "early", conversationId: room, serverId: "early", authorAccount: "alice", authorNick: "alice", text: "early", time: "2026-09-27T09:00:00.000Z", state: "confirmed" });
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  engine.push(historyBatch("#r", [], "r1"));
  await engine.whenIdle();
  engine.push(historyBatch("#r", [{ id: "n1", time: H(10) }, { id: "n2", time: H(11) }, { id: "n3", time: H(12) }], "r2"));
  await engine.whenIdle();
  // The empty AFTER page covered the checkpoint b, so b goes. a and "early" are older than the
  // full LATEST page's first message: nothing was asked about them, so they stay.
  expect(await serverIds(db, room)).toEqual(["a", "early", "n1", "n2", "n3"]);
});

test("a message deleted elsewhere inside the fetched AFTER window is dropped", async () => {
  const { db, room, engine } = await seeded("window-after", ["a", "b"]);
  // Cached c sits after the checkpoint but the server no longer has it.
  await db.messages.put({ id: "c", conversationId: room, serverId: "c", authorAccount: "bob", authorNick: "bob", text: "c", time: H(5), state: "confirmed" });
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  engine.push(historyBatch("#r", [{ id: "b", time: H(1) }, { id: "d", time: H(6) }], "r1"));
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(true);
  expect(await serverIds(db, room)).toEqual(["a", "b", "d"]);
});

test("a partial or refused fetch prunes nothing", async () => {
  const { db, room, engine, sent } = await seeded("no-prune-partial", ["a", "b"]);
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  // An unterminated batch is dropped on disconnect and never applied.
  engine.push("BATCH +p1 chathistory #r\r\n");
  engine.onDisconnect();
  expect(await serverIds(db, room)).toEqual(["a", "b"]);
  // A refused page fails the room and leaves the cache alone.
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  engine.push("FAIL CHATHISTORY MESSAGE_ERROR #r :Messages could not be retrieved\r\n");
  await engine.whenIdle();
  expect(engine.isReady(room)).toBe(false);
  expect(await serverIds(db, room)).toEqual(["a", "b"]);
  expect(sent.filter((line) => line.startsWith("CHATHISTORY LATEST")).length).toBe(1);
});

test("a full page bounds its window at its last message, so later cache waits for the next page", async () => {
  const { db, room, engine } = await seeded("window-full", ["a"]);
  await db.messages.put({ id: "late", conversationId: room, serverId: "late", authorAccount: "bob", authorNick: "bob", text: "late", time: H(20), state: "confirmed" });
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  engine.push(historyBatch("#r", [{ id: "a", time: H(0) }, { id: "x", time: H(1) }, { id: "y", time: H(2) }], "r1"));
  await engine.whenIdle();
  expect(await serverIds(db, room)).toEqual(["a", "late", "x", "y"]);
  // The next page still lacks "late": now it is inside a returned window and goes.
  engine.push(historyBatch("#r", [{ id: "z", time: H(21) }], "r2"));
  await engine.whenIdle();
  expect(await serverIds(db, room)).toEqual(["a", "x", "y", "z"]);
});

test("pending and failed local messages survive a reset prune", async () => {
  const { db, room, engine } = await seeded("pending-survive", ["a"]);
  for (const [id, state] of [["q", "queued"], ["s", "sending"], ["u", "uncertain"], ["f", "failed"]] as const) {
    await db.messages.put({ id, conversationId: room, clientId: id, authorAccount: "alice", authorNick: "alice", text: id, time: H(3), state });
  }
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  engine.push(historyBatch("#r", [], "r1"));
  await engine.whenIdle();
  engine.push(historyBatch("#r", [], "r2"));
  await engine.whenIdle();
  expect(await serverIds(db, room)).toEqual(["local:f", "local:q", "local:s", "local:u"]);
});

test("a live message that lands while a page is in flight is not pruned by that page", async () => {
  const { db, room, engine } = await seeded("live-during-page", ["a"]);
  engine.push(WELCOME + join("#r"));
  await engine.whenIdle();
  engine.push(historyBatch("#r", [], "r1"));
  await engine.whenIdle();
  // LATEST is in flight; a live line arrives first and the server snapshot predates it.
  engine.push(`@msgid=live1;time=${H(40)};account=bob :bob!u@h PRIVMSG #r :hi\r\n`);
  await engine.whenIdle();
  engine.push(historyBatch("#r", [], "r2"));
  await engine.whenIdle();
  expect(await serverIds(db, room)).toEqual(["live1"]);
});

test("FAIL REDACT UNKNOWN_MSGID removes the message locally and settles the delete", async () => {
  const db = open("redact-unknown");
  const room = conversationId("room", "#r");
  const refused: string[] = [];
  const { engine } = harness(db, { hooks: { onRedactRefused: (msgid: string) => refused.push(msgid) } });
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", [{ id: "ghost" }]));
  await engine.whenIdle();
  await db.operations.put({ id: "op1", messageId: "", conversationId: room, kind: "redact", text: "", redactId: "ghost", state: "sending", createdAt: 1 });
  engine.push("FAIL REDACT UNKNOWN_MSGID #r ghost :This message does not exist or is too old\r\n");
  await engine.whenIdle();
  expect(refused).toEqual([]);
  const row = (await db.messages.toArray())[0]!;
  expect(row.deleted).toBe(true);
  expect(row.text).toBe("");
  expect((await db.operations.get("op1"))?.state).toBe("confirmed");
  expect(await db.tombstones.get([room, "ghost"])).toBeTruthy();
});

test("FAIL REDACT with any other code still reports a refusal", async () => {
  const db = open("redact-forbidden");
  const room = conversationId("room", "#r");
  const refused: string[] = [];
  const { engine } = harness(db, { hooks: { onRedactRefused: (msgid: string) => refused.push(msgid) } });
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", [{ id: "keep" }]));
  await engine.whenIdle();
  engine.push("FAIL REDACT REDACT_FORBIDDEN #r keep :nope\r\n");
  await engine.whenIdle();
  expect(refused).toEqual(["keep"]);
  expect((await db.messages.toArray())[0]!.deleted).toBeFalsy();
});

// WHOIS numerics carry our nick as params[0], so they never map to a conversation. The hook is the
// only route the page has to render a lookup.
test("routes WHOIS numerics to the onWhois hook", () => {
  const db = open("whois");
  const seen: string[] = [];
  const { engine } = harness(db, { hooks: { onWhois: (message) => seen.push(message.command) } });
  engine.push(":server 311 alice bob user host * :Bob Real\r\n");
  engine.push(":server 312 alice bob irc.example :Example server\r\n");
  engine.push(":server 330 alice bob bobacct :is logged in as\r\n");
  engine.push(":server 318 alice bob :End of WHOIS\r\n");
  expect(seen).toEqual(["311", "312", "330", "318"]);
});

test("FAIL REDACT reaches onRedactRefused with the message id and reason", async () => {
  const db = open("sync-redact-refused");
  const refused: Array<[string, string]> = [];
  const { engine } = harness(db, { hooks: { onRedactRefused: (msgid: string, reason: string) => refused.push([msgid, reason]) } });
  engine.push(WELCOME);
  engine.push("FAIL REDACT REDACT_FORBIDDEN #t-8b5084 m123 :You are not authorized to delete this message\r\n");
  await engine.whenIdle();
  expect(refused).toEqual([["m123", "You are not authorized to delete this message"]]);
});

test("MARKREAD reaches onReadMarker for a known target, ignores unknown ones and never writes a message", async () => {
  const db = open("sync-markread");
  const markers: [string, string][] = [];
  const { engine, errors } = harness(db, { hooks: { onReadMarker: (conversation: { conversationId: string }, timestamp: string) => markers.push([conversation.conversationId, timestamp]) } });
  const room = conversationId("room", "#r");
  await readyRoom(engine, db, "#r", room);
  engine.push(historyBatch("#r", [{ id: "m1" }]));
  await engine.whenIdle();
  const rows = await db.messages.count();
  engine.push(":irc.test MARKREAD #r timestamp=2026-09-27T10:00:05.000Z\r\n");
  engine.push(":irc.test MARKREAD #R *\r\n");
  engine.push(":irc.test MARKREAD #r timestamp=garbage\r\n");
  engine.push(":irc.test MARKREAD #elsewhere timestamp=2026-09-27T10:00:06.000Z\r\n");
  await engine.whenIdle();
  expect(markers).toEqual([[room, "2026-09-27T10:00:05.000Z"], [room, ""], [room, ""]]);
  expect(await db.messages.count()).toBe(rows);
  expect(errors).toHaveLength(0);
  expect(buildMarkReadCommand("#r", "2026-09-27T10:00:05.000Z")).toBe("MARKREAD #r timestamp=2026-09-27T10:00:05.000Z");
});

test("being kicked from a conversation is reported once, and someone else's KICK is not", async () => {
  const db = open("kick-hook");
  const kicked: string[] = [];
  const { engine } = harness(db, { nick: "alice", hooks: { onKicked: (conversation: { conversationId: string }) => kicked.push(conversation.conversationId) } });
  const cid = conversationId("thread", "#t-abc123");
  await readyRoom(engine, db, "#t-abc123", cid);
  engine.push(":srv KICK #t-abc123 bob :Channel deleted\r\n");
  await engine.whenIdle();
  expect(kicked).toEqual([]);
  engine.push(":srv KICK #t-abc123 alice :Channel deleted\r\n");
  await engine.whenIdle();
  expect(kicked).toEqual([cid]);
});

// --- message links: CHATHISTORY AROUND ---------------------------------------------------------

test("a link lookup loads history around an old message without moving the sync checkpoint", async () => {
  const db = open("around-found");
  const { engine, sent, errors } = harness(db);
  const cid = conversationId("room", "#links");
  await readyRoom(engine, db, "#links", cid);
  engine.push(historyBatch("#links", [{ id: "new-1", time: "2026-09-27T12:00:00.000Z" }], "latest"));
  await engine.whenIdle();
  expect(engine.isReady(cid)).toBe(true);
  const checkpoint = await db.progress.get(cid);

  const answer = engine.around(cid, "old-2");
  expect(sent.at(-1)).toBe("CHATHISTORY AROUND #links msgid=old-2 100");
  engine.push(historyBatch("#links", [
    { id: "old-1", time: "2026-09-20T10:00:00.000Z" },
    { id: "old-2", time: "2026-09-20T10:01:00.000Z" },
    { id: "old-3", time: "2026-09-20T10:02:00.000Z" },
  ], "around"));
  expect(await answer).toBe(true);
  await engine.whenIdle();
  expect(errors).toEqual([]);
  expect((await db.messages.where("conversationId").equals(cid).toArray()).map((row) => row.serverId).sort()).toEqual(["new-1", "old-1", "old-2", "old-3"]);
  expect(await db.progress.get(cid)).toEqual(checkpoint);
  expect(engine.isReady(cid)).toBe(true);
});

test("a link to a message the server does not have answers false and keeps the room ready", async () => {
  const db = open("around-missing");
  const { engine, errors } = harness(db);
  const cid = conversationId("room", "#links");
  await readyRoom(engine, db, "#links", cid);
  engine.push(historyBatch("#links", [{ id: "new-1" }], "latest"));
  await engine.whenIdle();

  const empty = engine.around(cid, "gone");
  engine.push("BATCH +a1 chathistory #links\r\nBATCH -a1\r\n");
  expect(await empty).toBe(false);

  const refused = engine.around(cid, "gone");
  engine.push(":srv FAIL CHATHISTORY MESSAGE_ERROR AROUND #links :Messages could not be retrieved\r\n");
  expect(await refused).toBe(false);
  await engine.whenIdle();
  expect(engine.isReady(cid)).toBe(true);
  expect(errors).toEqual([]);
});

test("a link lookup never asks for a conversation that is not ready or not authorized", async () => {
  const db = open("around-unready");
  const { engine, sent } = harness(db);
  const cid = conversationId("room", "#links");
  engine.recover([{ conversationId: cid, wireTarget: "#links" }]);
  engine.push(WELCOME + join("#links"));
  await engine.whenIdle();
  expect(engine.isReady(cid)).toBe(false); // its first page is still in flight
  const before = sent.length;
  expect(await engine.around(cid, "m1")).toBeNull();
  expect(await engine.around(conversationId("room", "#secret"), "m1")).toBeNull();
  expect(sent.length).toBe(before);
});

test("a refresh page asked behind a link lookup still gets its own answer", async () => {
  const db = open("around-then-page");
  const { engine, sent } = harness(db);
  const cid = conversationId("room", "#links");
  await readyRoom(engine, db, "#links", cid);
  engine.push(historyBatch("#links", [{ id: "new-1", time: "2026-09-27T12:00:00.000Z" }], "latest"));
  await engine.whenIdle();

  const answer = engine.around(cid, "old-1");
  const caught = engine.catchUp([cid]);
  await engine.whenIdle();
  expect(sent.slice(-2)[0]).toBe("CHATHISTORY AROUND #links msgid=old-1 100");
  expect(sent.at(-1)).toMatch(/^CHATHISTORY AFTER #links /);
  engine.push(historyBatch("#links", [{ id: "old-1", time: "2026-09-20T10:00:00.000Z" }], "around"));
  engine.push(historyBatch("#links", [{ id: "new-1", time: "2026-09-27T12:00:00.000Z" }, { id: "new-2", time: "2026-09-27T12:05:00.000Z" }], "after"));
  expect(await answer).toBe(true);
  expect(await caught).toBe(true);
  await engine.whenIdle();
  expect((await db.messages.where("conversationId").equals(cid).toArray()).map((row) => row.serverId).sort()).toEqual(["new-1", "new-2", "old-1"]);
  expect((await db.progress.get(cid))?.serverId).toBe("new-2");
});
