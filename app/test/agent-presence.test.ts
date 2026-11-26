import "./fixture.ts";
import { createHash } from "node:crypto";
import { expect, mock, test } from "bun:test";

// Agent presence dots: member and account-detail rows carry `attached` only for agents, true only
// while the bound session holds a live lease and the transport saw the DM JOIN. Local IRC mock.
const irc = await import("../src/irc.ts");
let options: any;
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline"]);
    constructor(value: any) { options = value; }
    async connect() {}
    send(_line: string) { return true; }
    quit() {}
  },
}));
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }) }));

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease, renewLease, invalidateLease } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { connectAgentTransport, syncAgentPresence } = await import("../src/agent-session-transport.ts");
const { subscribe } = await import("../src/live.ts");
const { app } = await import("../src/server.ts");

const owner = accountByNick("bitbonsai")!;
const token = "agent-presence-session";
db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), owner.nick, Date.now());
const headers = { Cookie: `slirc_session=${token}` };
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "presence-test", sessionFile: "/tmp/presence-test.jsonl",
  secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-presence-test";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
for (const nick of [binding.nick, "legacy-presence-agent"]) {
  db.query("INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)").run(nick, `${nick}@agents.invalid`, owner.nick, Date.now());
}
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
db.query("INSERT INTO channels (channel,owner,visibility,topic,created_at) VALUES ('#presence-room',?,'secret','',?)").run(owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
for (const nick of [owner.nick, binding.nick, "legacy-presence-agent"]) db.query("INSERT INTO channel_members (channel,nick) VALUES ('#presence-room',?)").run(nick);

async function attached() {
  const body = await (await app.request("/api/channels/presence-room/members", { headers })).json();
  return Object.fromEntries(body.members.map((row: { nick: string; attached?: boolean }) => [row.nick, row.attached]));
}

test("member rows mark an agent attached only while its harness lease and DM JOIN are live", async () => {
  expect(await attached()).toEqual({ [owner.nick]: undefined, [binding.nick]: false, "legacy-presence-agent": false });
  await connectAgentTransport(binding);
  options.onMessage({ command: "JOIN", params: [binding.dm], tags: {}, prefix: `${binding.nick}!u@host` });
  expect((await attached())[binding.nick]).toBe(false); // IRC alone is not attachment.
  bindLease(binding, "presence-incarnation-000000001");
  expect(await attached()).toEqual({ [owner.nick]: undefined, [binding.nick]: true, "legacy-presence-agent": false });
  db.query("UPDATE agent_session_bindings SET lease_expires_at=? WHERE id=?").run(Date.now() - 1, binding.id);
  expect((await attached())[binding.nick]).toBe(false);
});

test("account details carry the same attachment flag for agents", async () => {
  bindLease(binding, "presence-incarnation-000000002");
  const me = await (await app.request("/auth/me", { headers })).json();
  const details = Object.fromEntries(me.accountDetails.map((row: { nick: string; attached?: boolean }) => [row.nick, row.attached]));
  expect(details[owner.nick]).toBeUndefined();
  expect(details[binding.nick]).toBe(true);
});

test("attachment flips reach the owner and roommates once; renewals and strangers get nothing", () => {
  db.query("INSERT INTO channel_members (channel,nick) VALUES ('#presence-room','presence-roommate')").run();
  syncAgentPresence(); // Catch up on the lease the previous test bound directly.
  const seen: Record<string, unknown[]> = { [owner.nick]: [], "presence-roommate": [], "presence-stranger": [] };
  const stops = Object.keys(seen).map((nick) => subscribe(nick, (event, data) => { if (event === "agent-presence") seen[nick]!.push(data); }));
  try {
    syncAgentPresence(); // Already announced, so silent.
    expect(seen[owner.nick]).toEqual([]);
    db.query("UPDATE agent_session_bindings SET lease_expires_at=? WHERE id=?").run(Date.now() - 1, binding.id);
    syncAgentPresence();
    syncAgentPresence();
    const lease = bindLease(binding, "presence-incarnation-000000003")!;
    renewLease(binding, lease.leaseId);
    syncAgentPresence();
    invalidateLease(binding.id, lease.leaseId);
    syncAgentPresence();
    const flips = [{ nick: binding.nick, attached: false }, { nick: binding.nick, attached: true }, { nick: binding.nick, attached: false }];
    expect(seen[owner.nick]).toEqual(flips);
    expect(seen["presence-roommate"]).toEqual(flips);
    expect(seen["presence-stranger"]).toEqual([]);
  } finally {
    for (const stop of stops) stop();
  }
});
