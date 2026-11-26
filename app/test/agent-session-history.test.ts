import "./fixture.ts";
import { expect, mock, test } from "bun:test";

// Channel context on accepted room mentions and the agent's read-only history route. The IRC peer
// is a local protocol mock that answers CHATHISTORY with a scripted batch.
const irc = await import("../src/irc.ts");
let options: any;
const sent: string[] = [];
const scripted = new Map<string, { nick: string; text: string; msgid: string; lines?: string[] }[]>();
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline", "batch"]);
    constructor(value: any) { options = value; }
    async connect() {}
    send(line: string) {
      sent.push(line);
      const query = line.match(/^CHATHISTORY BEFORE (\S+) /);
      if (query) queueMicrotask(() => answer(query[1]));
      return true;
    }
    quit() {}
  },
}));
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }) }));

function answer(channel: string) {
  const emit = (command: string, params: string[], tags: Record<string, string>, prefix = "peer") => options.onMessage({ command, params, tags, prefix });
  emit("BATCH", ["+h1", "chathistory", channel], {});
  let n = 0;
  for (const item of scripted.get(channel) || []) {
    const tags = { batch: "h1", msgid: item.msgid, time: `2026-10-14T09:00:${String(++n).padStart(2, "0")}.000Z`, account: item.nick };
    if (item.lines) {
      emit("BATCH", [`+ml${n}`, "draft/multiline", channel], tags, `${item.nick}!u@host`);
      for (const line of item.lines) emit("PRIVMSG", [channel, line], { batch: `ml${n}` }, `${item.nick}!u@host`);
      emit("BATCH", [`-ml${n}`], { batch: "h1" });
    } else emit("PRIVMSG", [channel, item.text], tags, `${item.nick}!u@host`);
  }
  emit("BATCH", ["-h1"], {});
}

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { connectAgentTransport, acceptRequest, joinAgentRoomForNick } = await import("../src/agent-session-transport.ts");
const { app } = await import("../src/server.ts");

const owner = accountByNick("bitbonsai")!;
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "history-test", sessionFile: "/tmp/history-test.jsonl",
  secret, machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-history-test";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
db.query("INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)")
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
for (const room of ["#history-room", "#history-other"]) db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'secret',?)").run(room, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick, "history-friend"]) db.query("INSERT INTO channel_members (channel,nick) VALUES ('#history-room',?)").run(nick);
db.query("INSERT INTO channel_members (channel,nick) VALUES ('#history-other',?)").run(owner.nick); // The agent is not a member.
await connectAgentTransport(binding);
const emit = (command: string, params: string[], tags: Record<string, string> = {}, prefix = `${owner.nick}!u@host`) => options.onMessage({ command, params, tags, prefix });
emit("JOIN", [binding.dm], {}, `${binding.nick}!u@host`);
await joinAgentRoomForNick(binding.nick, "#history-room");
emit("JOIN", ["#history-room"], {}, `${binding.nick}!u@host`);
const lease = bindLease(binding, "history-incarnation-0000001")!.leaseId;
scripted.set("#history-room", [
  { nick: owner.nick, text: "before the last reply", msgid: "old-1" },
  { nick: binding.nick, text: "my last reply", msgid: "agent-1" },
  { nick: "history-friend", text: "the build is red", msgid: "ctx-1" },
  { nick: owner.nick, text: "", msgid: "ctx-2", lines: ["log line one", "log line two"] },
]);
const history = (query: string, leaseId = lease) => app.request(`/api/agent/session/history${query}`, { headers: { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": leaseId } });

test("a room mention is accepted with the messages since the agent's last reply there, oldest first", async () => {
  emit("PRIVMSG", ["#history-room", `@${binding.nick} why is it red?`], { account: owner.nick, msgid: "mention-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='mention-1'").get() as { id: string };
  const before = sent.length;
  const envelope = await acceptRequest(binding, lease, row.id, 1);
  expect(sent.slice(before).filter((line) => line.startsWith("CHATHISTORY"))).toEqual(["CHATHISTORY BEFORE #history-room msgid=mention-1 50"]);
  expect(envelope.context).toEqual([
    { messageId: "ctx-1", nick: "history-friend", text: "the build is red", time: "2026-10-14T09:00:03.000Z" },
    { messageId: "ctx-2", nick: owner.nick, text: "log line one\nlog line two", time: "2026-10-14T09:00:04.000Z" },
  ]);
  // History lines are context only; none became a request.
  expect((db.query("SELECT COUNT(*) AS n FROM agent_session_requests").get() as { n: number }).n).toBe(1);
  db.query("UPDATE agent_session_requests SET status='replied' WHERE id=?").run(row.id);
});

test("a DM request carries no room context and asks for no history", async () => {
  emit("PRIVMSG", [binding.dm!, "hello"], { account: owner.nick, msgid: "dm-1" });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid='dm-1'").get() as { id: string };
  const before = sent.length;
  expect((await acceptRequest(binding, lease, row.id, 1)).context).toEqual([]);
  expect(sent.slice(before).some((line) => line.startsWith("CHATHISTORY"))).toBe(false);
  db.query("UPDATE agent_session_requests SET status='replied' WHERE id=?").run(row.id);
});

test("history route reads only rooms the agent may deliver through, with a capped limit", async () => {
  expect((await history("?channel=%23history-room", "wrong-lease")).status).toBe(401);
  const before = sent.length;
  const response = await history("?channel=%23history-room&limit=500&before=mention-1");
  expect(response.status).toBe(200);
  expect(sent.slice(before)).toContain("CHATHISTORY BEFORE #history-room msgid=mention-1 100");
  const body = await response.json();
  expect(body.messages.map((item: any) => item.messageId)).toEqual(["old-1", "agent-1", "ctx-1", "ctx-2"]);
  // Not a member, and an unknown room: refused before any CHATHISTORY is sent.
  const denied = sent.length;
  expect((await history("?channel=%23history-other")).status).toBe(403);
  expect((await history("?channel=%23nowhere")).status).toBe(403);
  expect(sent.slice(denied).some((line) => line.startsWith("CHATHISTORY"))).toBe(false);
  expect((await history("?channel=%23history-room&before=bad%20cursor")).status).toBe(400);
  expect((await history("?channel=history-room")).status).toBe(400);
  // Removal from the room ends access at once.
  db.query("DELETE FROM channel_members WHERE channel='#history-room' AND nick=?").run(binding.nick);
  expect((await history("?channel=%23history-room")).status).toBe(403);
});
