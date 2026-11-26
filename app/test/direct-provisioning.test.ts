import "./fixture.ts";
import { createHash } from "node:crypto";
import { expect, mock, test } from "bun:test";

const grants = await import("../src/grants.ts");
let provision: (channel: string) => Promise<void> = async () => {};
let legacyReady = false;
let legacyProofCalls = 0;
mock.module("../src/grants.ts", () => ({
  ...grants,
  createDirectChannel: (channel: string) => provision(channel),
  readDirectChannelReady: async () => { legacyProofCalls++; return legacyReady; },
}));
const { db } = await import("../src/db.ts");
const rooms = await import("../src/rooms.ts");
const { openDirectConversation } = await import("../src/direct.ts");
const { app } = await import("../src/server.ts");

db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?,'bitbonsai',?)")
  .run(createHash("sha256").update("dm-test-session").digest("hex"), Date.now());
const headers = { Cookie: "slirc_session=dm-test-session" };
const me = async () => (await app.request("/auth/me", { headers })).json();
function peer(nick: string) {
  db.query("INSERT INTO accounts (nick,email,verified_at,created_at) VALUES (?,?,1,1)")
    .run(nick, `${nick}@example.test`);
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("first-flight and failed provisioning never authorize; retry keeps the reserved channel", async () => {
  peer("firstflight");
  const gate = deferred();
  const channels: string[] = [];
  provision = async (channel) => { channels.push(channel); await gate.promise; };
  const opening = openDirectConversation("bitbonsai", "firstflight");
  const outcome = opening.then(() => null, (error) => error);
  await Promise.resolve();
  const channel = rooms.directChannelName("bitbonsai", "firstflight");
  try {
    expect((await me()).directs).not.toContainEqual({ channel, nick: "firstflight" });
    expect((await me()).channels).not.toContain(channel);
    expect(rooms.isMember("bitbonsai", channel)).toBe(false);
    expect(rooms.directConversation("bitbonsai", "firstflight")).toBeNull();
  } finally { gate.reject(new Error("unconfirmed grants")); }
  expect(await outcome).toBeInstanceOf(Error);
  expect((await me()).directs).not.toContainEqual({ channel, nick: "firstflight" });
  expect(rooms.directChannelName("bitbonsai", "firstflight")).toBe(channel);
  provision = async (target) => { channels.push(target); };
  expect(await openDirectConversation("bitbonsai", "firstflight")).toEqual({ channel, nick: "firstflight" });
  expect(channels).toEqual([channel, channel]);
  expect((await me()).directs).toContainEqual({ channel, nick: "firstflight" });
  expect(rooms.isMember("bitbonsai", channel)).toBe(true);
});

test("opposite simultaneous opens share one provisioning flight and return each caller's peer", async () => {
  peer("concurrent");
  const gate = deferred();
  let calls = 0;
  provision = async () => { calls++; await gate.promise; };
  const first = openDirectConversation("bitbonsai", "concurrent");
  const second = openDirectConversation("concurrent", "bitbonsai");
  await Promise.resolve();
  try { expect(calls).toBe(1); } finally { gate.resolve(); }
  const [a, b] = await Promise.all([first, second]);
  expect(a.channel).toBe(b.channel);
  expect(a.nick).toBe("concurrent");
  expect(b.nick).toBe("bitbonsai");
  expect(db.query("SELECT COUNT(*) AS n FROM channel_members WHERE channel=?").get(a.channel)).toEqual({ n: 2 });
});

test("membership removed during provisioning cannot be published or silently recreated", async () => {
  peer("revoked");
  const gate = deferred();
  provision = async () => gate.promise;
  const opening = openDirectConversation("bitbonsai", "revoked");
  const channel = rooms.directChannelName("bitbonsai", "revoked");
  db.query("DELETE FROM channel_members WHERE channel=? AND nick='revoked'").run(channel);
  gate.resolve();
  await expect(opening).rejects.toThrow("membership changed");
  expect((await me()).directs).not.toContainEqual({ channel, nick: "revoked" });
  expect(db.query("SELECT nick FROM channel_members WHERE channel=?").all(channel)).toEqual([{ nick: "bitbonsai" }]);
  expect(rooms.directChannelName("bitbonsai", "revoked")).toBe(channel);
});

test("existing provisioned pairs and group memberships survive a failed reopen", async () => {
  peer("existing");
  provision = async () => {};
  const direct = await openDirectConversation("bitbonsai", "existing");
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#g-proof','bitbonsai','secret',1)").run();
  db.query("INSERT INTO channel_members (channel,nick) VALUES ('#g-proof','bitbonsai')").run();
  provision = async () => { throw new Error("offline"); };
  await expect(openDirectConversation("bitbonsai", "existing")).rejects.toThrow("offline");
  expect((await me()).directs).toContainEqual(direct);
  expect((await me()).channels).toContain("#g-proof");
  expect(rooms.directChannelName("existing", "bitbonsai")).toBe(direct.channel);
});

test("auth never probes or publishes legacy mappings; the operator verifies them outside login", async () => {
  peer("legacy");
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick) VALUES ('#dm-original-legacy','bitbonsai','legacy')").run();
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#dm-original-legacy','bitbonsai','direct',1)").run();
  db.query("INSERT INTO channel_members (channel,nick) VALUES ('#dm-original-legacy','bitbonsai'),('#dm-original-legacy','legacy')").run();
  const memberships = db.query("SELECT * FROM channel_members WHERE channel='#dm-original-legacy' ORDER BY nick").all();
  legacyReady = false;
  expect((await me()).directs).not.toContainEqual({ channel: "#dm-original-legacy", nick: "legacy" });
  expect((await me()).channels).not.toContain("#dm-original-legacy");
  expect(rooms.directChannelName("legacy", "bitbonsai")).toBe("#dm-original-legacy");
  legacyReady = true;
  expect((await me()).directs).not.toContainEqual({ channel: "#dm-original-legacy", nick: "legacy" });
  expect(legacyProofCalls).toBe(0);
  expect(db.query("SELECT provision_ready FROM direct_conversations WHERE channel='#dm-original-legacy'").get()).toEqual({ provision_ready: null });
  const { verifyDirectReadiness } = await import("../src/direct-readiness.ts");
  await verifyDirectReadiness(db, async () => true, async () => {});
  expect((await me()).directs).toContainEqual({ channel: "#dm-original-legacy", nick: "legacy" });
  expect(db.query("SELECT * FROM channel_members WHERE channel='#dm-original-legacy' ORDER BY nick").all()).toEqual(memberships);
  expect(rooms.directConversation("bitbonsai", "legacy")?.channel).toBe("#dm-original-legacy");
});

test("a persisted failed reservation stays unauthorized through a fresh module load and retries the same identity", async () => {
  peer("restart");
  const reservation = rooms.createDirectConversation("bitbonsai", "restart", "bitbonsai", false);
  // Equivalent persisted state after a process died before publication. Only the runtime lock is new.
  const restarted = await import(`../src/direct.ts?restart=${Date.now()}`);
  legacyReady = true; // even a successful legacy probe cannot publish an explicit reservation
  expect((await me()).directs).not.toContainEqual(reservation);
  const gate = deferred();
  provision = async (channel) => { expect(channel).toBe(reservation.channel); await gate.promise; };
  const retry = restarted.openDirectConversation("bitbonsai", "restart");
  try { expect((await me()).directs).not.toContainEqual(reservation); }
  finally { gate.resolve(); }
  expect(await retry).toEqual(reservation);
  expect((await me()).directs).toContainEqual(reservation);
});

test("server authorization then IRC membership and history must all precede outbox delivery", async () => {
  await import("fake-indexeddb/auto");
  const { ClientDatabase } = await import("../client/db.ts");
  const { createOutbox } = await import("../client/outbox.ts");
  const { createSyncEngine } = await import("../client/sync.ts");
  const { clientAccess } = await import("../client/access.ts");
  const { queuedTextFor } = await import("../client/drafts.ts");
  const { conversationId } = await import("../client/model.ts");
  peer("deliveryproof");
  const accountId = (db.query("SELECT account_id FROM accounts WHERE nick='bitbonsai'").get() as { account_id: string }).account_id;
  const peerId = (db.query("SELECT account_id FROM accounts WHERE nick='deliveryproof'").get() as { account_id: string }).account_id;
  const local = new ClientDatabase({ instance: "https://proof.test", accountId, account: "bitbonsai" });
  const lines: string[] = [];
  const sync = createSyncEngine({ db: local, send: (line) => { lines.push(line); return true; }, namesProbeMs: 0 });
  const outbox = createOutbox({
    db: local, transport: { sendText: (operation) => { lines.push(`PRIVMSG ${wire} :${operation.text}`); } },
    isReady: (id) => sync.isReady(id),
    locks: { request: async (_name, _options, callback) => { await callback(); } },
    BroadcastChannelImpl: null,
  });
  const id = conversationId("dm", peerId);
  const wire = rooms.directChannelName("bitbonsai", "deliveryproof");
  const gate = deferred();
  provision = async () => gate.promise;
  const opening = openDirectConversation("bitbonsai", "deliveryproof");
  const refresh = async () => {
    const access = clientAccess(await me(), "https://proof.test");
    expect(access.ok).toBe(true);
    if (access.ok) sync.ensure(access.conversations.filter((item) => item.conversationId === id));
    await outbox.notifyReady();
  };
  const sends = () => lines.filter((line) => line.startsWith("PRIVMSG "));
  try {
    await outbox.start();
    sync.push(":test 001 bitbonsai :welcome\r\n");
    await outbox.enqueueText(queuedTextFor(id, "bitbonsai", { text: "durable first message", revision: "r1" }, "proof-op", Date.now()));
    await refresh();
    expect(lines).not.toContain(`JOIN ${wire}`);
    expect(sends()).toEqual([]);
    gate.resolve();
    await opening;
    await refresh();
    expect(lines).toContain(`JOIN ${wire}`);
    expect(sends()).toEqual([]);
    // A bare NAMES terminator does not prove that this account joined.
    sync.push(`:test 366 bitbonsai ${wire} :End of NAMES\r\n`);
    await sync.whenIdle();
    await outbox.notifyReady();
    expect(sends()).toEqual([]);
    sync.push(`:bitbonsai!u@host JOIN ${wire}\r\n`);
    await sync.whenIdle();
    expect(lines).toContain(`CHATHISTORY LATEST ${wire} * 250`);
    await outbox.notifyReady();
    expect(sends()).toEqual([]);
    sync.push(`BATCH +proof chathistory ${wire}\r\nBATCH -proof\r\n`);
    await sync.whenIdle();
    expect(sync.isReady(id)).toBe(true);
    await outbox.notifyReady();
    expect(sends()).toEqual([`PRIVMSG ${wire} :durable first message`]);
    await refresh();
    expect(sends()).toHaveLength(1);
    expect((await local.operations.get("proof-op"))?.state).toBe("sending");
  } finally {
    gate.resolve();
    await opening;
    outbox.stop();
    sync.onDisconnect();
    await local.delete();
  }
});
