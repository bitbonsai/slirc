import "./fixture.ts";
import { beforeEach, expect, mock, test } from "bun:test";

// Extra messages and deletions an agent sends for a request: several messages per request, a
// follow-up after it is answered, and deleting only its own messages. The IRC peer is a mock that
// records every line the transport writes; the test plays Ergo's echoes and history answers.
const irc = await import("../src/irc.ts");
let options: any;
const sent: string[] = [];
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline"]);
    constructor(value: any) { options = value; }
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
const { connectAgentTransport, acceptRequest, replyToRequest, sendToRequest, deleteOwnMessage, joinAgentRoomForNick, transportTimers } = await import("../src/agent-session-transport.ts");
transportTimers.historyTimeoutMs = 200;

const owner = accountByNick("bitbonsai")!;
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "actions-test", sessionFile: "/tmp/actions-test.jsonl",
  secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-actions-test";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
db.query("INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)")
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
const thread = "#t-act001";
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'secret',?)").run(thread, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(thread, nick);
await connectAgentTransport(binding);
const self = `${binding.nick}!u@host`;
const emit = (command: string, params: string[], tags: Record<string, string> = {}, prefix = `${owner.nick}!u@host`) => options.onMessage({ command, params, tags, prefix });
emit("JOIN", [binding.dm], {}, self);
await joinAgentRoomForNick(binding.nick, thread);
emit("JOIN", [thread], {}, self);
const lease = bindLease(binding, "actions-incarnation-000001")!.leaseId;
beforeEach(() => { db.query("DELETE FROM agent_session_requests").run(); });

const privmsgs = (from: number) => sent.slice(from).filter((line) => line.includes(" PRIVMSG "));
const cidOf = (line: string) => line.match(/\+slirc\/cid=([^ ;]+)/)![1];
async function nextLine(from: number, match: (line: string) => boolean): Promise<string> {
  for (let i = 0; i < 500; i++) {
    const line = sent.slice(from).find(match);
    if (line) return line;
    await Bun.sleep(1);
  }
  throw new Error("expected line was never sent");
}
async function accepted(room: string, msgid: string): Promise<string> {
  emit("PRIVMSG", [room, room === binding.dm ? "explain it" : `@${binding.nick} explain it`], { account: owner.nick, msgid });
  const row = db.query("SELECT id FROM agent_session_requests WHERE original_msgid=?").get(msgid) as { id: string };
  expect((await acceptRequest(binding, lease, row.id, 1))?.id).toBe(row.id);
  return row.id;
}
// Sends one extra message and plays Ergo's echo of it.
async function send(id: string, text: string, msgid: string) {
  const mark = sent.length;
  const outcome = sendToRequest(binding, lease, id, text);
  const line = await nextLine(mark, (value) => value.includes(" PRIVMSG "));
  emit("PRIVMSG", [line.split(" PRIVMSG ")[1].split(" :")[0], text], { "+slirc/cid": cidOf(line), msgid }, self);
  return outcome;
}
async function reply(id: string, text: string, msgid: string) {
  const mark = sent.length;
  expect(await replyToRequest(binding, lease, id, text)).toBe("replying");
  const line = privmsgs(mark)[0];
  emit("PRIVMSG", [line.split(" PRIVMSG ")[1].split(" :")[0], text], { "+slirc/cid": cidOf(line), msgid }, self);
}
const statusOf = (id: string) => (db.query("SELECT status FROM agent_session_requests WHERE id=?").get(id) as { status: string }).status;
async function answerAround(from: number, room: string, items: { msgid: string; nick: string; text: string }[]) {
  await nextLine(from, (line) => line.startsWith(`CHATHISTORY AROUND ${room} `));
  emit("BATCH", ["+hist", "chathistory", room], {}, "irc.server");
  for (const item of items) emit("PRIVMSG", [room, item.text], { batch: "hist", msgid: item.msgid }, `${item.nick}!u@host`);
  emit("BATCH", ["-hist"], {}, "irc.server");
}

test("several messages for one request land in order in the request's thread", async () => {
  const id = await accepted(thread, "multi-src");
  const mark = sent.length;
  expect(await send(id, "Part 1 of 3", "p1")).toEqual({ status: "sent", messageId: "p1" });
  expect(await send(id, "Part 2 of 3", "p2")).toEqual({ status: "sent", messageId: "p2" });
  expect(statusOf(id)).toBe("accepted"); // Extra messages never answer the request.
  await reply(id, "Part 3 of 3", "p3");
  expect(statusOf(id)).toBe("replied");
  expect(privmsgs(mark).map((line) => line.replace(/^@\S+ /, ""))).toEqual([
    `PRIVMSG ${thread} :Part 1 of 3`, `PRIVMSG ${thread} :Part 2 of 3`, `PRIVMSG ${thread} :Part 3 of 3`,
  ]);
});

test("a follow-up after the request is answered lands in the same DM and nowhere else", async () => {
  const id = await accepted(binding.dm!, "follow-src");
  await reply(id, "Done.", "r1");
  expect(statusOf(id)).toBe("replied");
  const mark = sent.length;
  expect(await send(id, "One more thing: tests pass.", "f1")).toEqual({ status: "sent", messageId: "f1" });
  expect(statusOf(id)).toBe("replied");
  expect(privmsgs(mark).map((line) => line.replace(/^@\S+ /, ""))).toEqual([`PRIVMSG ${binding.dm} :One more thing: tests pass.`]);
});

test("a request this session never accepted, or another lease's, takes no extra messages", async () => {
  emit("PRIVMSG", [binding.dm!, "not accepted"], { account: owner.nick, msgid: "offered-src" });
  const offered = (db.query("SELECT id FROM agent_session_requests WHERE original_msgid='offered-src'").get() as { id: string }).id;
  const mark = sent.length;
  await expect(sendToRequest(binding, lease, offered, "hi")).rejects.toThrow("not accepted or answered");
  await expect(sendToRequest(binding, "wrong-lease", offered, "hi")).rejects.toThrow("session lease expired");
  await expect(deleteOwnMessage(binding, lease, offered, "m1")).rejects.toThrow("not accepted or answered");
  expect(privmsgs(mark)).toEqual([]);
});

test("deleting the owner's or another agent's message is refused and nothing is redacted", async () => {
  const id = await accepted(binding.dm!, "delete-src");
  for (const nick of [owner.nick, "other-agent"]) {
    const mark = sent.length;
    const outcome = deleteOwnMessage(binding, lease, id, `theirs-${nick}`);
    await answerAround(mark, binding.dm!, [{ msgid: `theirs-${nick}`, nick, text: "not yours" }]);
    await expect(outcome).rejects.toThrow("only its own messages");
    expect(sent.slice(mark).some((line) => line.startsWith("REDACT"))).toBe(false);
  }
});

test("an agent deletes its own message once Ergo confirms the REDACT", async () => {
  const id = await accepted(thread, "own-src");
  const mark = sent.length;
  const outcome = deleteOwnMessage(binding, lease, id, "mine-1");
  await answerAround(mark, thread, [{ msgid: "before", nick: owner.nick, text: "hello" }, { msgid: "mine-1", nick: binding.nick, text: "oops" }]);
  expect(await nextLine(mark, (line) => line.startsWith("REDACT"))).toBe(`REDACT ${thread} mine-1`);
  emit("REDACT", [thread, "mine-1"], {}, self);
  expect(await outcome).toBe("deleted");
});

// Plays Ergo's echo of one written PRIVMSG.
const echo = (line: string, msgid: string) => emit("PRIVMSG", [line.split(" PRIVMSG ")[1].split(" :")[0], line.split(" :").slice(1).join(" :")], { "+slirc/cid": cidOf(line), msgid }, self);
const texts = (from: number) => privmsgs(from).map((line) => line.split(" :").slice(1).join(" :"));

test("parallel sends and a reply reach the room one at a time, in call order", async () => {
  const id = await accepted(thread, "order-src");
  const mark = sent.length;
  const calls = Promise.all([
    sendToRequest(binding, lease, id, "Part 1"), sendToRequest(binding, lease, id, "Part 2"),
    sendToRequest(binding, lease, id, "Part 3"), replyToRequest(binding, lease, id, "Part 4"),
  ]);
  for (let index = 1; index <= 4; index++) {
    await nextLine(mark, () => privmsgs(mark).length === index);
    await Bun.sleep(20);
    expect(privmsgs(mark).length).toBe(index); // The next one waits for this one's echo.
    echo(privmsgs(mark)[index - 1], `order-${index}`);
  }
  const [one, two, three, status] = await calls;
  expect([one.messageId, two.messageId, three.messageId, status]).toEqual(["order-1", "order-2", "order-3", "replying"]);
  expect(texts(mark)).toEqual(["Part 1", "Part 2", "Part 3", "Part 4"]);
  expect(statusOf(id)).toBe("replied");
});

test("a failing message in the middle doesn't hold up the ones after it", async () => {
  const id = await accepted(thread, "fail-mid-src");
  const mark = sent.length;
  const first = sendToRequest(binding, lease, id, "Before");
  const bad = sendToRequest(binding, lease, id, "bad\rtext");
  const last = sendToRequest(binding, lease, id, "After");
  await nextLine(mark, () => privmsgs(mark).length === 1);
  echo(privmsgs(mark)[0], "mid-1");
  await expect(bad).rejects.toThrow("invalid");
  await nextLine(mark, () => privmsgs(mark).length === 2);
  echo(privmsgs(mark)[1], "mid-2");
  expect((await first).messageId).toBe("mid-1");
  expect((await last).messageId).toBe("mid-2");
  expect(texts(mark)).toEqual(["Before", "After"]);
});

test("a message waiting for its echo in one room doesn't block another room", async () => {
  const inThread = await accepted(thread, "rooms-thread-src");
  await reply(inThread, "Answered.", "rooms-thread-reply"); // One active request at a time; answered ones take follow-ups.
  const inDm = await accepted(binding.dm!, "rooms-dm-src");
  const mark = sent.length;
  const held = sendToRequest(binding, lease, inThread, "Thread part");
  await nextLine(mark, () => privmsgs(mark).length === 1);
  const free = sendToRequest(binding, lease, inDm, "DM part");
  await nextLine(mark, () => privmsgs(mark).length === 2);
  echo(privmsgs(mark)[1], "rooms-dm");
  expect((await free).messageId).toBe("rooms-dm");
  echo(privmsgs(mark)[0], "rooms-thread");
  expect((await held).messageId).toBe("rooms-thread");
});
