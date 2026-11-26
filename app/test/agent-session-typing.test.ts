import "./fixture.ts";
import { expect, mock, test } from "bun:test";

// IRCv3 typing from the server transport while an accepted request runs. The IRC peer is a local
// protocol mock that records every line the transport writes.
const irc = await import("../src/irc.ts");
let options: any;
let client: any;
const sent: string[] = [];
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline", "message-tags"]);
    constructor(value: any) { options = value; client = this; }
    async connect() {}
    send(line: string) { sent.push(line); return true; }
    quit() {}
  },
}));
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }) }));

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { connectAgentTransport, acceptRequest, replyToRequest, failRequest, transportTimers } = await import("../src/agent-session-transport.ts");
const TYPING_REFRESH_MS = 500;
transportTimers.typingRefreshMs = TYPING_REFRESH_MS;
transportTimers.roomHoldMs = 100; // Replies here get no echo; don't hold the room for long.

const owner = accountByNick("bitbonsai")!;
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "typing-test", sessionFile: "/tmp/typing-test.jsonl",
  secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-typing-test";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
db.query("INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)")
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
await connectAgentTransport(binding);
const emit = (command: string, params: string[], tags: Record<string, string> = {}, prefix = `${owner.nick}!u@host`) => options.onMessage({ command, params, tags, prefix });
emit("JOIN", [binding.dm], {}, `${binding.nick}!u@host`);
const lease = bindLease(binding, "typing-incarnation-00000001")!.leaseId;
const typing = (from: number) => sent.slice(from).filter((line) => line.includes("TAGMSG"));
const offer = (msgid: string) => {
  emit("PRIVMSG", [binding.dm!, `do ${msgid}`], { account: owner.nick, msgid });
  return (db.query("SELECT id FROM agent_session_requests WHERE original_msgid=?").get(msgid) as { id: string }).id;
};

test("accepted work shows typing in its destination, refreshed until the reply, then done before the reply line", async () => {
  const start = sent.length;
  const id = offer("typing-1");
  expect(typing(start)).toEqual([]); // Offered is not accepted work.
  expect(await acceptRequest(binding, lease, id, 1)).not.toBeNull();
  expect(typing(start)).toEqual([`@+typing=active TAGMSG ${binding.dm}`]);
  await Bun.sleep(TYPING_REFRESH_MS + 200);
  expect(typing(start)).toEqual([`@+typing=active TAGMSG ${binding.dm}`, `@+typing=active TAGMSG ${binding.dm}`]);
  const beforeReply = sent.length;
  await replyToRequest(binding, lease, id, "answer");
  const after = sent.slice(beforeReply);
  expect(after[0]).toBe(`@+typing=done TAGMSG ${binding.dm}`);
  expect(after[1]).toContain(`PRIVMSG ${binding.dm} :answer`);
  await Bun.sleep(TYPING_REFRESH_MS + 200);
  expect(typing(beforeReply)).toEqual([`@+typing=done TAGMSG ${binding.dm}`]);
});

test("an explicit failure ends typing the same way", async () => {
  db.query("UPDATE agent_session_requests SET status='replied' WHERE binding_id=? AND status IN ('accepted','replying','failing')").run(binding.id);
  const id = offer("typing-2");
  await acceptRequest(binding, lease, id, 1);
  const before = sent.length;
  await failRequest(binding, lease, id, "cannot");
  expect(sent.slice(before)[0]).toBe(`@+typing=done TAGMSG ${binding.dm}`);
});

test("without negotiated message-tags no typing line is ever sent", async () => {
  db.query("UPDATE agent_session_requests SET status='replied' WHERE binding_id=? AND status IN ('accepted','replying','failing')").run(binding.id);
  client.enabledCapabilities.delete("message-tags");
  const start = sent.length;
  const id = offer("typing-3");
  await acceptRequest(binding, lease, id, 1);
  await replyToRequest(binding, lease, id, "quiet");
  expect(typing(start)).toEqual([]);
});
