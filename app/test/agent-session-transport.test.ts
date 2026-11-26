import "./fixture.ts";
import { beforeEach, expect, mock, test } from "bun:test";

const irc = await import("../src/irc.ts");
let options: any;
const clientOptions: any[] = [];
const sent: string[] = [];
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline"]);
    constructor(value: any) { clientOptions.push(value); options = value; }
    async connect() {}
    send(line: string) { sent.push(line); return true; }
    quit() {}
  },
}));

// Live private-mode proof is mocked here so the test does not need an oper connection. Default is a
// valid +s/+i room; tests override one channel to prove fail-closed behavior.
const grants = await import("../src/grants.ts");
const modeResults = new Map<string, { secret: boolean; inviteOnly: boolean } | null>();
let probeGate: Promise<void> | null = null;
mock.module("../src/grants.ts", () => ({
  ...grants,
  readPrivateChannelMode: async (channel: string) => {
    if (probeGate) await probeGate;
    return modeResults.has(channel) ? modeResults.get(channel)! : { secret: true, inviteOnly: true };
  },
}));

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease, invalidateLease, LEASE_MS } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { connectAgentTransport, introduceAgent, acceptRequest, replyToRequest, offeredRequests, joinAgentRoomForNick, confirmOfflineRequest, MAX_QUEUED_REQUESTS, resetAgentSessionState, sendPendingReview, transportTimers, replyParts, MAX_REPLY_BYTES } = await import("../src/agent-session-transport.ts");
// The mock IRC peer never answers CHATHISTORY; a short budget keeps context reads from waiting 2 s.
transportTimers.historyTimeoutMs = 200;
transportTimers.roomHoldMs = 100; // Most replies here get no echo; don't hold the room for long.

const owner = accountByNick("bitbonsai")!;
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "transport-test", sessionFile: "/tmp/transport-test.jsonl",
  secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-transport-test";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
db.query(`INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)`)
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
await connectAgentTransport(binding);
const emit = (command: string, params: string[], tags: Record<string, string> = {}, prefix = `${owner.nick}!u@host`) =>
  clientOptions[0].onMessage({ command, params, tags, prefix });
emit("JOIN", [binding.dm], {}, `${binding.nick}!u@host`);
const count = () => (db.query("SELECT COUNT(*) AS n FROM agent_session_requests").get() as { n: number }).n;
const activeCount = (bindingId = binding.id) => (db.query("SELECT COUNT(*) AS n FROM agent_session_requests WHERE binding_id=? AND status IN ('accepted','replying','failing')").get(bindingId) as { n: number }).n;
// One-active is per binding, so tests start from a clean slate; a test that needs an active request
// creates and completes it within the test.
beforeEach(() => {
  db.query("DELETE FROM agent_session_requests").run();
  db.query("UPDATE agent_session_bindings SET intro_state='pending',intro_cid=NULL,intro_text=NULL,intro_msgid=NULL WHERE id=?").run(binding.id);
});
const ensureLease = (nonce: string): string => {
  const row = db.query("SELECT lease_id,lease_expires_at FROM agent_session_bindings WHERE id=?").get(binding.id) as { lease_id: string | null; lease_expires_at: number | null };
  if (row?.lease_id && (row.lease_expires_at || 0) > Date.now()) return row.lease_id;
  return bindLease(binding, nonce)!.leaseId;
};

test("transport creates requests and introduction using native crypto; invalid leases cannot accept or reply", async () => {
  expect(options.tls).toBeUndefined(); // Internal Ergo endpoint uses plaintext, like grants.ts.
  expect(options.capabilities).toContain("draft/message-redaction");
  const lease = bindLease(binding, "transport-incarnation-00001")!;
  expect(introduceAgent(binding, lease.leaseId)).toBe("sending");
  // Session names are quoted plainly, never with literal backslashes.
  expect(sent.find((line) => line.includes("Connected to your Pi"))).toContain(`Connected to your Pi session "fixture". Talk to me here`);
  expect(sent.find((line) => line.includes("Connected to your Pi"))).not.toContain("\\");
  emit("PRIVMSG", [binding.dm!, "inspect this"], { account: owner.nick, msgid: "request-1" });
  const row = db.query("SELECT id,status FROM agent_session_requests WHERE original_msgid='request-1'").get() as any;
  expect(row.status).toBe("offered");
  expect(await acceptRequest(binding, "wrong-lease", row.id, 1)).toBeNull();
  expect(await acceptRequest(binding, lease.leaseId, row.id, 1)).toMatchObject({ text: "inspect this", author: binding.owner_nick });
  await expect(replyToRequest(binding, "wrong-lease", row.id, "wrong")).rejects.toThrow("session lease expired");
  expect(await replyToRequest(binding, lease.leaseId, row.id, "done")).toBe("replying");

  emit("PRIVMSG", [binding.dm!, "queued"], { account: owner.nick, msgid: "request-2" });
  expect(invalidateLease(binding.id, "wrong-lease")).toBe(false);
  expect(invalidateLease(binding.id, lease.leaseId)).toBe(true);
  // The reply is already on the wire: losing the lease leaves it replying for its echo to decide.
  expect((db.query("SELECT status,text FROM agent_session_requests WHERE id=?").get(row.id) as any)).toEqual({ status: "replying", text: "inspect this" });
  expect((db.query("SELECT status FROM agent_session_requests WHERE original_msgid='request-2'").get() as any).status).toBe("needs_confirmation");
  const resumed = bindLease(binding, "transport-incarnation-00002")!;
  const queued = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='request-2'").get() as any;
  expect(await acceptRequest(binding, resumed.leaseId, queued.id, 1)).toBeNull();
});

test("over-limit and unknown multiline batches cannot execute their trailing lines", () => {
  const before = count();
  emit("BATCH", ["+big", "draft/multiline", binding.dm!], { account: owner.nick, msgid: "big" });
  emit("PRIVMSG", [binding.dm!, "x".repeat(8001)], { account: owner.nick, batch: "big", msgid: "part-1" });
  emit("PRIVMSG", [binding.dm!, "must not execute"], { account: owner.nick, batch: "big", msgid: "part-2" });
  emit("BATCH", ["-big"]);
  emit("PRIVMSG", [binding.dm!, "unknown batch"], { account: owner.nick, batch: "unknown", msgid: "part-3" });
  expect(count()).toBe(before);
  emit("BATCH", ["+small", "draft/multiline", binding.dm!], { account: owner.nick, msgid: "small" });
  emit("PRIVMSG", [binding.dm!, "one"], { account: owner.nick, batch: "small" });
  emit("PRIVMSG", [binding.dm!, "two"], { account: owner.nick, batch: "small" });
  emit("BATCH", ["-small"]);
  expect(count()).toBe(before + 1);
  expect((db.query("SELECT text FROM agent_session_requests WHERE original_msgid='small'").get() as any).text).toBe("one\ntwo");
});

const currentLease = () => (db.query("SELECT lease_id FROM agent_session_bindings WHERE id=?").get(binding.id) as { lease_id: string }).lease_id;
function seedSecretRoom(channel: string, parent?: string) {
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'secret',?)").run(channel, owner.nick, Date.now());
  for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(channel, nick);
  if (parent) db.query(`INSERT INTO threads (channel,parent,root,title,url,created_by,created_at,last_activity) VALUES (?,?,?,'test','/thread',?,?,?)`)
    .run(channel, parent, `r-${channel}`, owner.nick, Date.now(), Date.now());
}

test("a channel Ergo does not report as secret+invite-only is never JOINed", async () => {
  seedSecretRoom("#public-mode");
  modeResults.set("#public-mode", { secret: false, inviteOnly: true });
  const before = sent.length;
  await joinAgentRoomForNick(binding.nick, "#public-mode");
  expect(sent.slice(before).some((line) => line.includes("JOIN #public-mode"))).toBe(false);
  // Unknown channel (null mode) fails closed the same way.
  modeResults.set("#unknown-mode", null);
  const beforeUnknown = sent.length;
  await joinAgentRoomForNick(binding.nick, "#unknown-mode");
  expect(sent.slice(beforeUnknown).some((line) => line.includes("JOIN #unknown-mode"))).toBe(false);
});

test("a MODE that drops +s evicts the room and cancels unaccepted work", async () => {
  seedSecretRoom("#vault-mode");
  await joinAgentRoomForNick(binding.nick, "#vault-mode");
  emit("JOIN", ["#vault-mode"], {}, `${binding.nick}!u@host`);
  const lease = currentLease();
  emit("PRIVMSG", ["#vault-mode", `@${binding.nick} do it`], { account: owner.nick, msgid: "vault-1" });
  const row = db.query("SELECT id,status FROM agent_session_requests WHERE original_msgid='vault-1'").get() as any;
  expect(row.status).toBe("offered");
  emit("MODE", ["#vault-mode", "-s"]);
  expect(sent.some((line) => line === "PART #vault-mode :Channel is no longer private")).toBe(true);
  expect(await acceptRequest(binding, lease, row.id, 1)).toBeNull();
  // No new work is created from the now-public room.
  const before = count();
  emit("PRIVMSG", ["#vault-mode", `@${binding.nick} again`], { account: owner.nick, msgid: "vault-2" });
  expect(count()).toBe(before);
});

test("revoked parent membership blocks offered delivery", async () => {
  seedSecretRoom("#parent-vault");
  seedSecretRoom("#t-parent-vault", "#parent-vault");
  await joinAgentRoomForNick(binding.nick, "#t-parent-vault");
  emit("JOIN", ["#t-parent-vault"], {}, `${binding.nick}!u@host`);
  emit("PRIVMSG", ["#t-parent-vault", `@${binding.nick} do it`], { account: owner.nick, msgid: "parent-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='parent-1'").get() as any;
  expect(row).toBeTruthy();
  expect((await offeredRequests(binding)).some((request: any) => request.source_channel === "#t-parent-vault")).toBe(true);
  db.query("DELETE FROM channel_members WHERE channel='#parent-vault' AND nick=?").run(binding.nick);
  expect((await offeredRequests(binding)).some((request: any) => request.source_channel === "#t-parent-vault")).toBe(false);
  expect(await acceptRequest(binding, currentLease(), row.id, 1)).toBeNull();
});

test("delivery re-proves live private modes on ancestors, not just SQLite", async () => {
  seedSecretRoom("#parent-live");
  seedSecretRoom("#t-parent-live", "#parent-live");
  await joinAgentRoomForNick(binding.nick, "#t-parent-live");
  emit("JOIN", ["#t-parent-live"], {}, `${binding.nick}!u@host`);
  emit("PRIVMSG", ["#t-parent-live", `@${binding.nick} go`], { account: owner.nick, msgid: "live-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='live-1'").get() as any;
  modeResults.set("#parent-live", { secret: false, inviteOnly: true });
  expect(await acceptRequest(binding, currentLease(), row.id, 1)).toBeNull();
  modeResults.delete("#parent-live");
  expect((await acceptRequest(binding, currentLease(), row.id, 1))?.source).toBe("#t-parent-live");
});

test("offered content is cleared when an ancestor stops being provably private", async () => {
  seedSecretRoom("#parent-offer");
  seedSecretRoom("#t-parent-offer", "#parent-offer");
  await joinAgentRoomForNick(binding.nick, "#t-parent-offer");
  emit("JOIN", ["#t-parent-offer"], {}, `${binding.nick}!u@host`);
  emit("PRIVMSG", ["#t-parent-offer", `@${binding.nick} secret child text`], { account: owner.nick, msgid: "offer-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='offer-1'").get() as any;
  expect((await offeredRequests(binding)).some((request: any) => request.id === row.id)).toBe(true);
  modeResults.set("#parent-offer", { secret: false, inviteOnly: true });
  expect((await offeredRequests(binding)).some((request: any) => request.id === row.id)).toBe(false);
  const cleared = db.query("SELECT status,text FROM agent_session_requests WHERE id=?").get(row.id) as any;
  expect(cleared.status).toBe("cancelled");
  expect(cleared.text).toBe("");
});

test("a removed membership blocks offered delivery even while the socket stays joined", async () => {
  emit("PRIVMSG", [binding.dm!, "still here"], { account: owner.nick, msgid: "member-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='member-1'").get() as any;
  expect(row).toBeTruthy();
  db.query("DELETE FROM channel_members WHERE channel=? AND nick=?").run(binding.dm, binding.nick);
  expect((await offeredRequests(binding)).some((request: any) => request.id === row.id)).toBe(false);
  expect(await acceptRequest(binding, currentLease(), row.id, 1)).toBeNull();
  db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, binding.nick);
});

test("a lease revoked during the live probe cannot accept or write", async () => {
  emit("PRIVMSG", [binding.dm!, "deferred accept"], { account: owner.nick, msgid: "defer-1" });
  const row = db.query("SELECT id,status FROM agent_session_requests WHERE original_msgid='defer-1'").get() as any;
  const lease = currentLease();
  let release!: () => void;
  probeGate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const outcome = acceptRequest(binding, lease, row.id, 1);
    await Bun.sleep(0);
    invalidateLease(binding.id, lease);
    release();
    expect(await outcome).toBeNull();
  } finally {
    probeGate = null;
  }
  expect((db.query("SELECT status FROM agent_session_requests WHERE id=?").get(row.id) as any).status).not.toBe("accepted");
  expect(sent.some((line) => line.includes("deferred accept"))).toBe(false);
  bindLease(binding, "transport-incarnation-00003");
});

test("a lease revoked during the reply probe cannot send", async () => {
  emit("PRIVMSG", [binding.dm!, "deferred reply"], { account: owner.nick, msgid: "defer-2" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='defer-2'").get() as any;
  const lease = currentLease();
  expect(await acceptRequest(binding, lease, row.id, 1)).not.toBeNull();
  let release!: () => void;
  probeGate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const outcome = replyToRequest(binding, lease, row.id, "will not send");
    await Bun.sleep(0);
    invalidateLease(binding.id, lease);
    release();
    await expect(outcome).rejects.toThrow("session lease expired");
  } finally {
    probeGate = null;
  }
  expect(sent.some((line) => line.includes("will not send"))).toBe(false);
  expect((db.query("SELECT status FROM agent_session_requests WHERE id=?").get(row.id) as any).status).not.toBe("replied");
});

test("pending queue is bounded; an overflow request is not stored", () => {
  for (let i = 0; i < MAX_QUEUED_REQUESTS + 5; i++) {
    emit("PRIVMSG", [binding.dm!, `queued ${i}`], { account: owner.nick, msgid: `bound-${i}` });
  }
  const queued = db.query(`SELECT COUNT(*) AS n FROM agent_session_requests
    WHERE binding_id=? AND status IN ('pending','offered','needs_confirmation')`).get(binding.id) as { n: number };
  expect(queued.n).toBe(MAX_QUEUED_REQUESTS);
});

test("concurrent accepts on one binding yield exactly one winner, loser stays offered", async () => {
  const lease = ensureLease("race-incarnation-0000001");
  emit("PRIVMSG", [binding.dm!, "first work"], { account: owner.nick, msgid: "race-1" });
  emit("PRIVMSG", [binding.dm!, "second work"], { account: owner.nick, msgid: "race-2" });
  const a = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='race-1'").get() as any;
  const b = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='race-2'").get() as any;
  const results = await Promise.all([
    acceptRequest(binding, lease, a.id, 1),
    acceptRequest(binding, lease, b.id, 1),
  ]);
  expect(results.filter((result) => result !== null)).toHaveLength(1);
  expect(activeCount()).toBe(1);
  const loser = results[0] ? b.id : a.id;
  expect((db.query("SELECT status FROM agent_session_requests WHERE id=?").get(loser) as any).status).toBe("offered");
});

test("a second binding accepts independently while the first is active", async () => {
  const leaseA = ensureLease("sep-a-incarnation-00001");
  emit("PRIVMSG", [binding.dm!, "A first"], { account: owner.nick, msgid: "sep-a1" });
  const a1 = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='sep-a1'").get() as any;
  expect(await acceptRequest(binding, leaseA, a1.id, 1)).not.toBeNull();
  emit("PRIVMSG", [binding.dm!, "A second"], { account: owner.nick, msgid: "sep-a2" });
  const a2 = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='sep-a2'").get() as any;
  expect(await acceptRequest(binding, leaseA, a2.id, 1)).toBeNull();
  expect(activeCount()).toBe(1);

  const secondOwner = accountByNick("bitbonsai")!;
  const { binding: bindingB } = testBinding({
    owner: secondOwner.nick, harness: "pi", protocol: 1, sessionId: "transport-test-b", sessionFile: "/tmp/transport-test-b.jsonl",
    secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
    machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => secondOwner.id,
  });
  db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run("#dm-transport-b", bindingB.id);
  bindingB.dm = "#dm-transport-b";
  db.query(`INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)`)
    .run(bindingB.nick, `${bindingB.nick}@agents.invalid`, secondOwner.nick, Date.now());
  db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(bindingB.nick, bindingB.id);
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run("#dm-transport-b", secondOwner.nick, Date.now());
  for (const nick of [secondOwner.nick, bindingB.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run("#dm-transport-b", nick);
  await connectAgentTransport(bindingB);
  const bOptions = options; // connectAgentTransport(bindingB) was the most recent client
  bOptions.onMessage({ command: "JOIN", params: ["#dm-transport-b"], tags: {}, prefix: `${bindingB.nick}!u@host` });
  const leaseB = bindLease(bindingB, "sep-b-incarnation-00001")!;
  bOptions.onMessage({ command: "PRIVMSG", params: ["#dm-transport-b", "B work"], tags: { account: secondOwner.nick, msgid: "sep-b1" }, prefix: `${secondOwner.nick}!u@host` });
  const b1 = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='sep-b1'").get() as any;
  expect(await acceptRequest(bindingB, leaseB.leaseId, b1.id, 1)).not.toBeNull();
  expect(activeCount(bindingB.id)).toBe(1);
});

test("a prune probe never rewrites a terminal reply or turns a concurrent accept into cancelled", async () => {
  emit("PRIVMSG", [binding.dm!, "race content"], { account: owner.nick, msgid: "prune-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='prune-1'").get() as any;
  modeResults.set(binding.dm!, { secret: false, inviteOnly: true });
  let release!: () => void;
  probeGate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const promise = offeredRequests(binding);
    await Bun.sleep(0);
    db.query("UPDATE agent_session_requests SET status='replied',text='kept' WHERE id=?").run(row.id);
    release();
    await promise;
  } finally { probeGate = null; modeResults.delete(binding.dm!); }
  expect(db.query("SELECT status,text FROM agent_session_requests WHERE id=?").get(row.id)).toEqual({ status: "replied", text: "kept" });

  emit("PRIVMSG", [binding.dm!, "accepted content"], { account: owner.nick, msgid: "prune-2" });
  const accepted = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='prune-2'").get() as any;
  modeResults.set(binding.dm!, { secret: false, inviteOnly: true });
  probeGate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const promise = offeredRequests(binding);
    await Bun.sleep(0);
    db.query("UPDATE agent_session_requests SET status='accepted',text='executing' WHERE id=?").run(accepted.id);
    release();
    await promise;
  } finally { probeGate = null; modeResults.delete(binding.dm!); }
  expect((db.query("SELECT status FROM agent_session_requests WHERE id=?").get(accepted.id) as any).status).toBe("uncertain");
});

test("pending edit/redact and superseded-id redaction follow the source contract", () => {
  emit("PRIVMSG", [binding.dm!, "original"], { account: owner.nick, msgid: "edit-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='edit-1'").get() as any;
  emit("PRIVMSG", [binding.dm!, "edited text"], { account: owner.nick, msgid: "edit-2", "+draft/edit": "edit-1" });
  expect(db.query("SELECT status,revision,text,current_msgid FROM agent_session_requests WHERE id=?").get(row.id)).toEqual({ status: "needs_confirmation", revision: 2, text: "edited text", current_msgid: "edit-2" });
  // Redaction of the superseded id must not cancel the replacement.
  emit("REDACT", [binding.dm!, "edit-1"]);
  expect((db.query("SELECT status FROM agent_session_requests WHERE id=?").get(row.id) as any).status).toBe("needs_confirmation");
  // A moderator REDACT carries no owner account tag but is still authoritative.
  emit("REDACT", [binding.dm!, "edit-2"], {}, "oper!u@host");
  expect(db.query("SELECT status,text FROM agent_session_requests WHERE id=?").get(row.id)).toEqual({ status: "cancelled", text: "" });
});

test("post-acceptance edit and redact preserve execution state and clear deleted text", async () => {
  const lease = ensureLease("post-accept-incarnation-1");
  emit("PRIVMSG", [binding.dm!, "execute me"], { account: owner.nick, msgid: "post-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='post-1'").get() as any;
  expect(await acceptRequest(binding, lease, row.id, 1)).not.toBeNull();
  emit("PRIVMSG", [binding.dm!, "updated while running"], { account: owner.nick, msgid: "post-2", "+draft/edit": "post-1" });
  expect(db.query("SELECT status,current_msgid,revision FROM agent_session_requests WHERE id=?").get(row.id)).toEqual({ status: "accepted", current_msgid: "post-2", revision: 2 });
  emit("REDACT", [binding.dm!, "post-2"], {}, "oper!u@host");
  expect(db.query("SELECT status,text FROM agent_session_requests WHERE id=?").get(row.id)).toEqual({ status: "accepted", text: "" });
});

test("redaction clears a terminal reply's text but never rewrites its status", () => {
  db.query(`INSERT INTO agent_session_requests (id,binding_id,source_channel,reply_channel,original_msgid,current_msgid,author_account_id,revision,text,context,status,created_at,updated_at)
    VALUES ('term-row',?,?,?, 'term-1','term-1',?,1,'done','[]','replied',?,?)`)
    .run(binding.id, binding.dm, binding.dm, binding.owner_account_id, Date.now(), Date.now());
  emit("REDACT", [binding.dm!, "term-1"], {}, "oper!u@host");
  expect(db.query("SELECT status,text FROM agent_session_requests WHERE id='term-row'").get()).toEqual({ status: "replied", text: "" });
});

test("confirmation needs the exact revision and current access, and never executes by itself", () => {
  emit("PRIVMSG", [binding.dm!, "confirm me"], { account: owner.nick, msgid: "conf-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='conf-1'").get() as any;
  db.query("UPDATE agent_session_requests SET status='needs_confirmation',revision=1 WHERE id=?").run(row.id);
  expect(confirmOfflineRequest(binding, row.id, 2)).toBe(false);
  expect(confirmOfflineRequest(binding, row.id, 1)).toBe(true);
  expect((db.query("SELECT status FROM agent_session_requests WHERE id=?").get(row.id) as any).status).toBe("offered");
  db.query("UPDATE agent_session_requests SET status='needs_confirmation',revision=3,text='v3' WHERE id=?").run(row.id);
  db.query("DELETE FROM channel_members WHERE channel=? AND nick=?").run(binding.dm, binding.nick);
  expect(confirmOfflineRequest(binding, row.id, 3)).toBe(false);
  db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, binding.nick);
});

const statusOf = (id: string) => (db.query("SELECT status FROM agent_session_requests WHERE id=?").get(id) as any).status;
async function acceptedRequest(msgid: string): Promise<{ id: string; lease: string }> {
  emit("PRIVMSG", [binding.dm!, "source"], { account: owner.nick, msgid });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid=?").get(msgid) as any;
  const lease = ensureLease(`echo-${msgid}-incarnation`);
  expect((await acceptRequest(binding, lease, row.id, 1))?.id).toBe(row.id);
  return { id: row.id, lease };
}

// Attach before the mention arrives so it is offered to a live lease (an unattached one is only
// needs_confirmation and cannot be accepted).
async function attachedRequest(msgid: string): Promise<{ id: string; lease: string }> {
  const lease = ensureLease(`attached-${msgid}-incarnation`);
  emit("PRIVMSG", [binding.dm!, "source"], { account: owner.nick, msgid });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid=?").get(msgid) as any;
  expect((await acceptRequest(binding, lease, row.id, 1))?.id).toBe(row.id);
  return { id: row.id, lease };
}

test("a single-line reply is replied only after an exact self echo", async () => {
  const { id, lease } = await acceptedRequest("echo-single");
  const before = sent.length;
  expect(await replyToRequest(binding, lease, id, "done")).toBe("replying");
  const outgoing = sent.slice(before);
  const cid = outgoing.join("\n").match(/\+slirc\/cid=([^ ;\n]+)/)![1];
  // Wrong destination and a spoofed prefix are never confirmations.
  emit("PRIVMSG", ["#other-room", "done"], { "+slirc/cid": cid, msgid: "d" }, `${binding.nick}!u@host`);
  emit("PRIVMSG", [binding.dm!, "done"], { "+slirc/cid": cid, msgid: "s" }, "mallory!u@host");
  expect(statusOf(id)).toBe("replying");
  emit("PRIVMSG", [binding.dm!, "done"], { "+slirc/cid": cid, msgid: "e1" }, `${binding.nick}!u@host`);
  expect(statusOf(id)).toBe("replied");
});

test("a multiline reply confirms only on the matching closing BATCH with complete content", async () => {
  const { id, lease } = await acceptedRequest("echo-multi");
  const before = sent.length;
  expect(await replyToRequest(binding, lease, id, "one\ntwo")).toBe("replying");
  const outgoing = sent.slice(before);
  const cid = outgoing.join("\n").match(/\+slirc\/cid=([^ ;\n]+)/)![1];
  const batch = outgoing.join("\n").match(/BATCH \+(\S+)/)![1];
  const dest = binding.dm!;
  const line = (text: string, msgid: string, withCid = false) =>
    emit("PRIVMSG", [dest, text], withCid ? { "+slirc/cid": cid, batch, msgid } : { batch, msgid }, `${binding.nick}!u@host`);
  // Opener + one of two lines + close: incomplete, never replied.
  emit("BATCH", ["+" + batch, "draft/multiline", dest], { "+slirc/cid": cid, msgid: "op1" }, `${binding.nick}!u@host`);
  line("one", "l1");
  emit("BATCH", ["-" + batch], {}, `${binding.nick}!u@host`);
  expect(statusOf(id)).toBe("replying");
  // Opener-only cid, shared line msgids, both lines in order, then close: replied.
  emit("BATCH", ["+" + batch, "draft/multiline", dest], { "+slirc/cid": cid, msgid: "op2" }, `${binding.nick}!u@host`);
  line("one", "shared");
  line("two", "shared");
  emit("BATCH", ["-" + batch], {}, `${binding.nick}!u@host`);
  expect(statusOf(id)).toBe("replied");
});

test("a wrong echoed multiline line makes the outcome uncertain, not replied", async () => {
  const { id, lease } = await acceptedRequest("echo-wrong");
  const before = sent.length;
  await replyToRequest(binding, lease, id, "alpha\nbeta");
  const outgoing = sent.slice(before);
  const cid = outgoing.join("\n").match(/\+slirc\/cid=([^ ;\n]+)/)![1];
  const batch = outgoing.join("\n").match(/BATCH \+(\S+)/)![1];
  const dest = binding.dm!;
  emit("BATCH", ["+" + batch, "draft/multiline", dest], { "+slirc/cid": cid, msgid: "op" }, `${binding.nick}!u@host`);
  emit("PRIVMSG", [dest, "alpha"], { batch, msgid: "l1" }, `${binding.nick}!u@host`);
  emit("PRIVMSG", [dest, "WRONG"], { batch, msgid: "l2" }, `${binding.nick}!u@host`);
  emit("BATCH", ["-" + batch], {}, `${binding.nick}!u@host`);
  expect(statusOf(id)).toBe("uncertain");
});

test("the introduction is sent once and a retry does not duplicate it", async () => {
  const lease = ensureLease("intro-echo-incarnation");
  const before = sent.length;
  expect(introduceAgent(binding, lease)).toBe("sending");
  const outgoing = sent.slice(before).find((line) => line.includes("Connected to your Pi"))!;
  const cid = outgoing.match(/\+slirc\/cid=([^ ]+)/)![1];
  const introText = (db.query("SELECT intro_text FROM agent_session_bindings WHERE id=?").get(binding.id) as any).intro_text;
  emit("PRIVMSG", [binding.dm!, introText], { "+slirc/cid": cid, msgid: "intro-e" }, `${binding.nick}!u@host`);
  expect((db.query("SELECT intro_state FROM agent_session_bindings WHERE id=?").get(binding.id) as any).intro_state).toBe("sent");
  const after = sent.length;
  expect(introduceAgent(binding, lease)).toBe("sent");
  expect(sent.length).toBe(after);
});

test("oversized or malformed replies are rejected before reserving", async () => {
  const { id, lease } = await acceptedRequest("echo-limits");
  const tooManyLines = Array.from({ length: 31 }, (_, i) => `line ${i}`).join("\n");
  await expect(replyToRequest(binding, lease, id, tooManyLines)).rejects.toThrow("too long");
  await expect(replyToRequest(binding, lease, id, "first\n" + "x".repeat(8_001))).rejects.toThrow("too long");
  await expect(replyToRequest(binding, lease, id, "bad\rtext")).rejects.toThrow("invalid");
  expect(statusOf(id)).toBe("accepted");
  expect((db.query("SELECT reply_cid FROM agent_session_requests WHERE id=?").get(id) as any).reply_cid).toBeNull();
});

test("Ergo's server-assigned batch ref with opener-only cid confirms the multiline", async () => {
  const { id, lease } = await acceptedRequest("echo-server-ref");
  const before = sent.length;
  expect(await replyToRequest(binding, lease, id, "alpha\nbeta")).toBe("replying");
  const outgoing = sent.slice(before).join("\n");
  const cid = outgoing.match(/\+slirc\/cid=([^ ;\n]+)/)![1];
  const ourBatch = outgoing.match(/BATCH \+(\S+)/)![1];
  const serverRef = "1"; // Ergo rewrites the sender's batch ref on echo and strips the cid from lines
  expect(serverRef).not.toBe(ourBatch);
  const dest = binding.dm!;
  emit("BATCH", ["+" + serverRef, "draft/multiline", dest], { "+slirc/cid": cid, msgid: "op" }, `${binding.nick}!u@host`);
  emit("PRIVMSG", [dest, "alpha"], { batch: serverRef }, `${binding.nick}!u@host`);
  emit("PRIVMSG", [dest, "beta"], { batch: serverRef }, `${binding.nick}!u@host`);
  emit("BATCH", ["-" + serverRef], {}, `${binding.nick}!u@host`);
  expect(statusOf(id)).toBe("replied");
});


test("a new app process scrubs pre-gap unaccepted and in-flight rows only", () => {
  const insert = (id: string, status: string, text = "secret") => db.query(
    `INSERT INTO agent_session_requests (id,binding_id,source_channel,reply_channel,original_msgid,current_msgid,author_account_id,revision,text,context,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,'[]',?,?,?)`).run(id, binding.id, binding.dm, binding.dm, id, id, binding.owner_account_id, text, status, Date.now(), Date.now());
  for (const [id, status] of [["gap-pending", "pending"], ["gap-offered", "offered"], ["gap-needs", "needs_confirmation"], ["gap-accepted", "accepted"], ["gap-replying", "replying"], ["gap-replied", "replied"], ["gap-cancelled", "cancelled"]] as const) insert(id, status);
  db.query("UPDATE agent_session_bindings SET lease_id='lease-x',lease_nonce='nonce-x',lease_expires_at=? WHERE id=?").run(Date.now() + 60000, binding.id);
  expect(() => resetAgentSessionState()).not.toThrow();
  expect((db.query("SELECT lease_id,lease_nonce,lease_expires_at FROM agent_session_bindings WHERE id=?").get(binding.id) as any)).toEqual({ lease_id: null, lease_nonce: null, lease_expires_at: null });
  for (const id of ["gap-pending", "gap-offered", "gap-needs", "gap-accepted", "gap-replying"]) {
    expect(db.query("SELECT status,text FROM agent_session_requests WHERE id=?").get(id)).toEqual({ status: "uncertain", text: "" });
  }
  expect((db.query("SELECT status,text FROM agent_session_requests WHERE id='gap-replied'").get() as any)).toEqual({ status: "replied", text: "secret" });
  expect((db.query("SELECT confirm_revision FROM agent_session_requests WHERE id='gap-needs'").get() as any).confirm_revision).toBeNull();
  expect((db.query("SELECT status,text FROM agent_session_requests WHERE id='gap-cancelled'").get() as any)).toEqual({ status: "cancelled", text: "secret" });
});

test("adapter reattach sends one bounded review list of offline requests, once per lease", async () => {
  invalidateLease(binding.id, currentLease());
  for (let i = 1; i <= 7; i++) emit("PRIVMSG", [binding.dm!, `offline ${i}\nsecond line`], { account: owner.nick, msgid: `review-${i}` });
  const ids = (db.query("SELECT id FROM agent_session_requests WHERE status='needs_confirmation' ORDER BY created_at").all() as { id: string }[]).map((row) => row.id);
  expect(ids).toHaveLength(7);
  const lease = bindLease(binding, "transport-incarnation-review")!.leaseId;
  const before = sent.length;
  expect(sendPendingReview(binding, lease)).toBe(true);
  expect(sendPendingReview(binding, lease)).toBe(false);
  const notices = sent.slice(before);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toStartWith(`PRIVMSG ${binding.dm} :Slirc has 7 request(s) awaiting review.`);
  for (const id of ids.slice(0, 5)) expect(notices[0]).toContain(`${id} (rev 1): offline`);
  for (const id of ids.slice(5)) expect(notices[0]).not.toContain(id);
  expect(notices[0]).not.toContain("\n");
  // Listing is not confirmation: nothing became offered.
  expect((db.query("SELECT COUNT(*) AS n FROM agent_session_requests WHERE status='offered'").get() as { n: number }).n).toBe(0);
  // A later reattach (new lease) lists again; a stale lease never sends.
  invalidateLease(binding.id, lease);
  expect(sendPendingReview(binding, lease)).toBe(false);
  const next = bindLease(binding, "transport-incarnation-review2")!.leaseId;
  expect(sendPendingReview(binding, next)).toBe(true);
});

test("a lease change while a reply awaits its echo keeps the reply text and the echo still confirms it", async () => {
  const { id, lease } = await attachedRequest("lease-churn-reply");
  const before = sent.length;
  expect(await replyToRequest(binding, lease, id, "done")).toBe("replying");
  const cid = sent.slice(before).join("\n").match(/\+slirc\/cid=([^ ;\n]+)/)![1];
  // The old lease lapses (no heartbeat for LEASE_MS) and the adapter attaches again mid-echo.
  const next = bindLease(binding, "lease-churn-incarnation-2", Date.now() + LEASE_MS + 1)!;
  try {
    expect(statusOf(id)).toBe("replying");
    expect(db.query("SELECT reply_text,reply_cid FROM agent_session_requests WHERE id=?").get(id)).toEqual({ reply_text: "done", reply_cid: cid });
    emit("PRIVMSG", [binding.dm!, "done"], { "+slirc/cid": cid, msgid: "churn-echo" }, `${binding.nick}!u@host`);
    expect(statusOf(id)).toBe("replied");
  } finally {
    invalidateLease(binding.id, next.leaseId);
  }
});

test("an uncertain reply resends the same text under its original cid from a new lease, and confirms on echo", async () => {
  const { id, lease } = await attachedRequest("uncertain-retry");
  const before = sent.length;
  const savedTimeout = transportTimers.echoTimeoutMs;
  transportTimers.echoTimeoutMs = 20;
  try {
    expect(await replyToRequest(binding, lease, id, "done")).toBe("replying");
  } finally {
    transportTimers.echoTimeoutMs = savedTimeout;
  }
  const cid = sent.slice(before).join("\n").match(/\+slirc\/cid=([^ ;\n]+)/)![1];
  // No echo arrives in time: the server records uncertainty and keeps the text for a resend.
  await Bun.sleep(60);
  expect(statusOf(id)).toBe("uncertain");
  expect(db.query("SELECT reply_text FROM agent_session_requests WHERE id=?").get(id)).toEqual({ reply_text: "done" });
  invalidateLease(binding.id, lease);
  const next = bindLease(binding, "uncertain-retry-incarnation-2")!;
  try {
    await expect(replyToRequest(binding, next.leaseId, id, "changed text")).rejects.toThrow("different reply");
    const resent = sent.length;
    // The room's history has no message with this cid, so the reply is resent.
    const retried = replyToRequest(binding, next.leaseId, id, "done");
    await answerHistory(resent, binding.dm!, []);
    expect(await retried).toBe("replying");
    expect(sent.slice(resent).join("\n")).toContain(`@+slirc/cid=${cid} PRIVMSG ${binding.dm} :done`);
    expect(await replyToRequest(binding, next.leaseId, id, "done")).toBe("replying");
    expect(sent.slice(resent).filter((line) => line.includes("PRIVMSG")).length).toBe(1);
    emit("PRIVMSG", [binding.dm!, "done"], { "+slirc/cid": cid, msgid: "uncertain-retry-echo" }, `${binding.nick}!u@host`);
    expect(statusOf(id)).toBe("replied");
  } finally {
    invalidateLease(binding.id, next.leaseId);
  }
});

// Answer the next CHATHISTORY the transport sends after `mark`, as Ergo would. `null` stays silent.
async function answerHistory(mark: number, channel: string, items: { text: string; msgid: string; cid?: string }[] | null): Promise<void> {
  for (let i = 0; i < 200 && !sent.slice(mark).some((line) => line.startsWith(`CHATHISTORY BEFORE ${channel}`)); i++) await Bun.sleep(1);
  expect(sent.slice(mark).some((line) => line.startsWith(`CHATHISTORY BEFORE ${channel}`))).toBe(true);
  if (!items) return;
  emit("BATCH", ["+hist", "chathistory", channel], {}, "irc.server");
  for (const item of items) emit("PRIVMSG", [channel, item.text], { batch: "hist", msgid: item.msgid, ...(item.cid ? { "+slirc/cid": item.cid } : {}) }, `${binding.nick}!u@host`);
  emit("BATCH", ["-hist"], {}, "irc.server");
}

// An uncertain reply whose cid is already in room history, from a reply that landed but whose
// echo did not match.
async function uncertainReply(msgid: string, text: string): Promise<{ id: string; cid: string; lease: string }> {
  const { id, lease } = await attachedRequest(msgid);
  const before = sent.length;
  expect(await replyToRequest(binding, lease, id, text)).toBe("replying");
  const cid = sent.slice(before).join("\n").match(/\+slirc\/cid=([^ ;\n]+)/)![1];
  db.query("UPDATE agent_session_requests SET status='uncertain' WHERE id=?").run(id);
  return { id, cid, lease };
}

test("a resend finds the first send in room history by its cid and marks it replied without posting again", async () => {
  const { id, cid, lease } = await uncertainReply("dedupe-found", "landed");
  const mark = sent.length;
  const outcome = replyToRequest(binding, lease, id, "landed");
  await answerHistory(mark, binding.dm!, [{ text: "landed", msgid: "landed-msgid", cid }]);
  expect(await outcome).toBe("replied");
  expect(sent.slice(mark).some((line) => line.includes("PRIVMSG"))).toBe(false);
  expect(db.query("SELECT status,reply_msgid FROM agent_session_requests WHERE id=?").get(id)).toEqual({ status: "replied", reply_msgid: "landed-msgid" });
});

test("a resend is refused when room history does not answer, and nothing is posted", async () => {
  const { id, lease } = await uncertainReply("dedupe-silent", "maybe landed");
  const mark = sent.length;
  const outcome = replyToRequest(binding, lease, id, "maybe landed");
  await answerHistory(mark, binding.dm!, null);
  await expect(outcome).rejects.toThrow("history could not be checked");
  expect(sent.slice(mark).some((line) => line.includes("PRIVMSG"))).toBe(false);
  expect(statusOf(id)).toBe("uncertain");
});

test("a reply line longer than Ergo's 512-byte line goes out as concat parts that each fit, and their echo confirms it", async () => {
  const { id, lease } = await attachedRequest("long-line");
  const long = "é".repeat(700); // 1400 bytes, cut on character boundaries
  const text = `Summary\n\n${long}`;
  const before = sent.length;
  expect(await replyToRequest(binding, lease, id, text)).toBe("replying");
  const out = sent.slice(before);
  const privmsgs = out.filter((line) => line.includes(" PRIVMSG "));
  expect(privmsgs.length).toBe(replyParts(text, binding.dm!).length);
  expect(privmsgs.length).toBeGreaterThan(3);
  for (const line of privmsgs) expect(Buffer.byteLength(line.slice(line.indexOf(" ") + 1), "utf8") + 2).toBeLessThanOrEqual(512);
  expect(privmsgs.filter((line) => line.includes("draft/multiline-concat")).length).toBe(privmsgs.length - 3);
  const parts = replyParts(text, binding.dm!);
  expect(parts.filter((part) => !part.concat).map((part) => part.text).slice(0, 2)).toEqual(["Summary", ""]);
  expect(parts.slice(2).map((part) => part.text).join("")).toBe(long);
  // Ergo's echo: opener with the cid, then every part under its own batch ref.
  const cid = out[0].match(/\+slirc\/cid=([^ ;]+)/)![1];
  emit("BATCH", ["+srv1", "draft/multiline", binding.dm!], { "+slirc/cid": cid, msgid: "long-op" }, `${binding.nick}!u@host`);
  for (const part of parts) emit("PRIVMSG", [binding.dm!, part.text], { batch: "srv1", ...(part.concat ? { "draft/multiline-concat": "" } : {}) }, `${binding.nick}!u@host`);
  expect(statusOf(id)).toBe("replying");
  emit("BATCH", ["-srv1"], {}, `${binding.nick}!u@host`);
  expect(statusOf(id)).toBe("replied");
});

test("a reply larger than Ergo's multiline byte limit is refused before anything is sent", async () => {
  const { id, lease } = await attachedRequest("too-big");
  const before = sent.length;
  await expect(replyToRequest(binding, lease, id, "x".repeat(MAX_REPLY_BYTES + 1))).rejects.toThrow("too long");
  expect(sent.length).toBe(before);
  expect(statusOf(id)).toBe("accepted");
});

test("an owner's multiline request with concat parts reaches the agent as one line, not several", () => {
  emit("BATCH", ["+concat", "draft/multiline", binding.dm!], { account: owner.nick, msgid: "concat-request" });
  emit("PRIVMSG", [binding.dm!, "Please read"], { account: owner.nick, batch: "concat" });
  emit("PRIVMSG", [binding.dm!, "a long line, first part, "], { account: owner.nick, batch: "concat" });
  emit("PRIVMSG", [binding.dm!, "and its second part"], { account: owner.nick, batch: "concat", "draft/multiline-concat": "" });
  emit("BATCH", ["-concat"]);
  expect((db.query("SELECT text FROM agent_session_requests WHERE original_msgid='concat-request'").get() as any).text)
    .toBe("Please read\na long line, first part, and its second part");
});
