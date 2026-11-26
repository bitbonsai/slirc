// Owner-only agent attachment to open channels. A maintainer attaches their paired session agent to
// an open room; only that owner's own messages wake it, and the owner can forward one message from
// the room to it. Strangers never dispatch work, even when they mention the agent.
import "./fixture.ts";
import { beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

const irc = await import("../src/irc.ts");
let options: any;
const sent: string[] = [];
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline", "message-tags"]);
    constructor(value: any) { options = value; }
    async connect() {}
    send(line: string) {
      sent.push(line);
      // The peer answers a forwarded-message lookup with one history entry.
      if (line.startsWith("CHATHISTORY AROUND")) {
        const [, , channel, ref] = line.split(" ");
        const msgid = ref.startsWith("msgid=") ? ref.slice(6) : "";
        if (!msgid) return true;
        queueMicrotask(() => {
          const emit = options.onMessage;
          emit({ command: "BATCH", params: ["+hist", "chathistory", channel], tags: {}, prefix: `ergo!${channel}` });
          emit({ command: "PRIVMSG", params: [channel, "the build fails on startup"], tags: { batch: "hist", msgid }, prefix: "eve!u@host" });
          emit({ command: "BATCH", params: ["-hist"], tags: {}, prefix: `ergo!${channel}` });
        });
      }
      return true;
    }
    quit() {}
  },
}));

const grants = await import("../src/grants.ts");
let privateMode = { secret: true, inviteOnly: true };
mock.module("../src/grants.ts", () => ({
  ...grants,
  readPrivateChannelMode: async () => privateMode,
}));

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const transport = await import("../src/agent-session-transport.ts");
const { app } = await import("../src/server.ts");

const ORIGIN = "https://app.example.test";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const as = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });
const asForward = (token: string) => ({ Cookie: `slirc_session=${token}`, Origin: ORIGIN, "Content-Type": "application/json", "X-Slirc-Agent": "1" });
const ownerToken = as("open-channel-owner");
const ownerForward = asForward("open-channel-owner");
const strangerForward = asForward("open-channel-stranger");

const owner = accountByNick("bitbonsai")!;
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "open-channel", sessionFile: "/tmp/open-channel.jsonl",
  secret, machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-open-channel";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
db.query(`INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)`)
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
db.query(`INSERT INTO accounts (nick,email,role,kind,verified_at,created_at) VALUES ('eve','eve@test.invalid','member','human',1,1)`).run();
db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?,?,?), (?,?,?)")
  .run(hash("open-channel-owner"), owner.nick, Date.now(), hash("open-channel-stranger"), "eve", Date.now());

transport.transportTimers.historyTimeoutMs = 200;
transport.transportTimers.roomHoldMs = 100;
await transport.connectAgentTransport(binding);
const emit = (command: string, params: string[], tags: Record<string, string> = {}, prefix = `${owner.nick}!u@host`) =>
  options.onMessage({ command, params, tags, prefix });
const joinSelf = () => emit("JOIN", ["#help"], {}, `${binding.nick}!u@host`);
emit("JOIN", [binding.dm], {}, `${binding.nick}!u@host`);
const requests = () => db.query("SELECT source_channel,reply_channel,author_account_id,text,status FROM agent_session_requests ORDER BY created_at").all() as
  { source_channel: string; reply_channel: string; author_account_id: string; text: string; status: string }[];
const grant = () => db.query("SELECT owner_only FROM channel_members WHERE channel = '#help' AND nick = ?").get(binding.nick) as { owner_only: number } | null;
const attach = (nick = binding.nick, headers = ownerToken) =>
  app.request("/api/channels/help/members", { method: "POST", headers, body: JSON.stringify({ nick }) });

beforeEach(() => {
  db.query("DELETE FROM agent_session_requests").run();
});

test("an owner attaches their agent to an open channel as an owner-only grant", async () => {
  const before = sent.length;
  const response = await attach();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ channel: "#help", nick: binding.nick, added: true });
  // The grant is written with the mandatory owner-only flag and the transport joins the open room.
  expect(grant()).toEqual({ owner_only: 1 });
  expect(sent.slice(before)).toContain(`JOIN #help`);
  expect(transport.agentRuntimeConnected(binding.id)).toBe(true);
  joinSelf();
});

test("a stranger's message, even mentioning the agent, never dispatches work", () => {
  const before = requests().length;
  emit("PRIVMSG", ["#help", `@${binding.nick} please deploy this`], { account: "eve", msgid: "stranger-1" }, "eve!u@host");
  emit("BATCH", ["+s1", "draft/multiline", "#help"], { account: "eve", msgid: "stranger-2" }, "eve!u@host");
  emit("PRIVMSG", ["#help", `@${binding.nick} and again`], { account: "eve", batch: "s1", msgid: "stranger-2" }, "eve!u@host");
  emit("BATCH", ["-s1"], {}, "eve!u@host");
  expect(requests()).toHaveLength(before);
});

test("the owner's mention in that open channel dispatches, and the reply posts publicly", async () => {
  const lease = bindLease(binding, "open-channel-incarnation-01")!;
  emit("PRIVMSG", ["#help", `@${binding.nick} what broke?`], { account: owner.nick, msgid: "owner-1" });
  const [row] = requests();
  expect(row).toMatchObject({ source_channel: "#help", reply_channel: "#help", author_account_id: owner.id, text: `@${binding.nick} what broke?` });
  const accepted = await transport.acceptRequest(binding, lease.leaseId, (db.query("SELECT id FROM agent_session_requests WHERE original_msgid='owner-1'").get() as any).id, 1);
  expect(accepted).not.toBeNull();
  const id = (db.query("SELECT id FROM agent_session_requests WHERE original_msgid='owner-1'").get() as any).id;
  const before = sent.length;
  expect(await transport.replyToRequest(binding, lease.leaseId, id, "The build step failed.")).toBe("replying");
  expect(sent.slice(before).some((line) => line.includes("PRIVMSG #help :The build step failed."))).toBe(true);
});

test("the owner forwards a specific message to their agent; anyone else gets 403", async () => {
  const before = requests().length;
  const url = `/api/agents/${binding.id}/forward`;
  const body = JSON.stringify({ channel: "#help", messageId: "stranger-1", note: "Please help with this report." });
  // Missing CSRF headers returns 403.
  const noCsrf = await app.request(url, { method: "POST", headers: ownerToken, body });
  expect(noCsrf.status).toBe(403);
  // Oversized body (>8192 bytes) returns 413.
  const oversized = await app.request(url, {
    method: "POST",
    headers: ownerForward,
    body: JSON.stringify({ channel: "#help", messageId: "stranger-1", note: "x".repeat(9_000) }),
  });
  expect(oversized.status).toBe(413);
  // A non-owner cannot use the owner's binding, even with a valid session.
  const denied = await app.request(url, { method: "POST", headers: strangerForward, body });
  expect(denied.status).toBe(403);
  expect(requests()).toHaveLength(before);
  const unknown = await app.request(`/api/agents/${crypto.randomUUID()}/forward`, { method: "POST", headers: ownerForward, body });
  expect(unknown.status).toBe(404);
  const response = await app.request(url, { method: "POST", headers: ownerForward, body });
  expect(response.status).toBe(200);
  const forwarded = requests().at(-1)!;
  expect(forwarded.source_channel).toBe("#help");
  expect(forwarded.reply_channel).toBe("#help");
  expect(forwarded.author_account_id).toBe(owner.id);
  expect(forwarded.text).toBe("Please help with this report.\n\nForwarded from eve in #help:\nthe build fails on startup");
});

test("offeredRequests keeps owner-only open-channel work without private mode, and prunes it when the grant is removed", async () => {
  bindLease(binding, "open-channel-incarnation-02");
  privateMode = { secret: false, inviteOnly: false };
  try {
    emit("PRIVMSG", ["#help", `@${binding.nick} check status`], { account: owner.nick, msgid: "owner-open-keep" });
    const offered = await transport.offeredRequests(binding);
    expect(offered.length).toBe(1);

    // Dropping the owner_only grant denies delivery even though #help is an open channel.
    db.query("UPDATE channel_members SET owner_only = 0 WHERE channel = '#help' AND nick = ?").run(binding.nick);
    const afterRevoke = await transport.offeredRequests(binding);
    expect(afterRevoke).toEqual([]);
  } finally {
    privateMode = { secret: true, inviteOnly: true };
    db.query("UPDATE channel_members SET owner_only = 1 WHERE channel = '#help' AND nick = ?").run(binding.nick);
  }
});
