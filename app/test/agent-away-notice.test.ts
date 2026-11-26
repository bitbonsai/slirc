import "./fixture.ts";
import { expect, mock, test } from "bun:test";

// When an agent's session goes away, the agent tells its owner once, in their DM, how to bring
// that session back and where to delete the agent. Only after a grace period, never for a quick
// reconnect, a lease renewal or an agent that never attached, and never once revoked. A notice owed
// when the app restarts is still posted once.
const irc = await import("../src/irc.ts");
const clients: { options: any; sent: string[] }[] = [];
// With no live runtime the notice goes out over a short-lived connection; this echoes its JOIN and line like Ergo.
const echo = { on: false };
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline"]);
    sent: string[] = [];
    waiters: { match: (message: any) => boolean; resolve: (message: any) => void }[] = [];
    constructor(public options: any) { clients.push(this as any); }
    async connect() {}
    waitFor(match: (message: any) => boolean) { return new Promise((resolve) => this.waiters.push({ match, resolve })); }
    send(line: string) {
      this.sent.push(line);
      if (echo.on) {
        const join = line.match(/^JOIN (\S+)$/);
        const say = line.match(/^(?:@\S+ )?PRIVMSG (\S+) :(.*)$/);
        const message = join ? { command: "JOIN", params: [join[1]] } : say ? { command: "PRIVMSG", params: [say[1], say[2]] } : null;
        if (message) queueMicrotask(() => this.feed({ ...message, prefix: `${this.options.nick}!u@peer` }));
      }
      return true;
    }
    feed(message: any) {
      for (const waiter of this.waiters.splice(0)) {
        if (waiter.match(message)) waiter.resolve(message);
        else this.waiters.push(waiter);
      }
    }
    quit() {}
  },
}));
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }) }));
process.env.APP_ORIGIN = "https://calango.slirc.app";

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease, invalidateLease, renewLease } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { connectAgentTransport, disconnectAgentTransport, resetAgentSessionState, syncAgentPresence, awayNotice, transportTimers } = await import("../src/agent-session-transport.ts");

const owner = accountByNick("bitbonsai")!;
const GRACE = transportTimers.awayGraceMs;
let seq = 0;

async function agent(harness: string, sessionFile: string) {
  const id = `away-${++seq}`;
  const { binding } = testBinding({
    owner: owner.nick, harness, protocol: 1, sessionId: `6ff65ec2-d186-41c3-b9c1-72539400000${seq}`, sessionFile,
    secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
    machine: "fixture", sessionName: "", ownerAccountIdForNick: () => owner.id,
  });
  binding.dm = `#dm-${id}`;
  db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
  db.query("INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)").run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
  for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
  await connectAgentTransport(binding);
  const client = clients.at(-1)!;
  client.options.onMessage({ command: "JOIN", params: [binding.dm], tags: {}, prefix: `${binding.nick}!u@host` });
  await Bun.sleep(10);
  const notices = () => client.sent.filter((line) => line.includes(` PRIVMSG ${binding.dm} :`) && line.includes("went offline"));
  return { binding, notices };
}
const expire = (id: string) => db.query("UPDATE agent_session_bindings SET lease_expires_at=? WHERE id=?").run(Date.now() - 1, id);

test("a session gone past the grace period gets one notice with its exact resume command", async () => {
  const { binding, notices } = await agent("claude", "/Users/ada/bit/slirc");
  const lease = bindLease(binding, "away-incarnation-0000000001")!;
  syncAgentPresence();
  renewLease(binding, lease.leaseId);
  syncAgentPresence();
  expire(binding.id);
  const dropped = Date.now();
  syncAgentPresence(dropped);
  syncAgentPresence(dropped + GRACE - 1_000);
  expect(notices()).toEqual([]);
  syncAgentPresence(dropped + GRACE + 1_000);
  syncAgentPresence(dropped + GRACE + 6_000);
  syncAgentPresence(dropped + 3 * GRACE);
  expect(notices()).toEqual([`@+slirc/agent-offline=claude PRIVMSG ${binding.dm} :My Claude Code session went offline. Run cd /Users/ada/bit/slirc && claude --resume ${binding.session_id} to bring me back. To delete me, use Remove on https://calango.slirc.app/agents`]);
});

test("a quick reconnect inside the grace period says nothing, and the next disconnect gets its own notice", async () => {
  const { binding, notices } = await agent("pi", "/Users/ada/.pi/agent/sessions/x.jsonl");
  bindLease(binding, "away-incarnation-0000000002");
  syncAgentPresence();
  expire(binding.id);
  const dropped = Date.now();
  syncAgentPresence(dropped);
  bindLease(binding, "away-incarnation-0000000003");
  syncAgentPresence();
  syncAgentPresence(Date.now() + 1_000);
  expect(notices()).toEqual([]);
  expire(binding.id);
  const again = Date.now();
  syncAgentPresence(again);
  syncAgentPresence(again + GRACE + 1_000);
  expect(notices()).toEqual([`@+slirc/agent-offline=pi PRIVMSG ${binding.dm} :My Pi session went offline. Run pi --session ${binding.session_id} to bring me back. To delete me, use Remove on https://calango.slirc.app/agents`]);
});

test("brief hourly wakes after a notice add no more notices, and a steady return earns the next one", async () => {
  // calango, 23 Nov 2026: a sleeping Mac's pi session reattached for a minute every hour, and each
  // wake ended in a fresh offline notice, one line per hour all night.
  const { binding, notices } = await agent("pi", "/Users/ada/.pi/agent/sessions/wake.jsonl");
  let at = Date.now();
  let n = 0;
  // Leases here follow the test clock, not the wall clock.
  const leaseUntil = (time: number) => db.query("UPDATE agent_session_bindings SET lease_expires_at=? WHERE id=?").run(time, binding.id);
  const attach = () => { bindLease(binding, `away-incarnation-00000001${String(++n).padStart(2, "0")}`); leaseUntil(at + 24 * 60 * 60_000); syncAgentPresence(at); };
  const drop = () => { leaseUntil(at); syncAgentPresence(at += 1_000); syncAgentPresence(at += GRACE + 1_000); };
  attach();
  drop();
  expect(notices().length).toBe(1);
  for (let hour = 0; hour < 3; hour++) {
    at += 60 * 60_000;
    attach();
    at += 60_000;
    drop();
  }
  expect(notices().length).toBe(1);
  // Back for longer than awaySteadyMs: the next drop is news again.
  at += 60_000;
  attach();
  at += transportTimers.awaySteadyMs + 1_000;
  drop();
  expect(notices().length).toBe(2);
});

test("a revoked or removed agent says nothing, and one never seen attached here says nothing", async () => {
  const revoked = await agent("claude", "/tmp/a");
  bindLease(revoked.binding, "away-incarnation-0000000004");
  syncAgentPresence();
  expire(revoked.binding.id);
  const dropped = Date.now();
  syncAgentPresence(dropped);
  db.query("UPDATE agent_session_bindings SET status='revoked' WHERE id=?").run(revoked.binding.id);
  syncAgentPresence(dropped + GRACE + 1_000);
  expect(revoked.notices()).toEqual([]);

  const removed = await agent("claude", "/tmp/b");
  bindLease(removed.binding, "away-incarnation-0000000005");
  syncAgentPresence();
  expire(removed.binding.id);
  syncAgentPresence(dropped);
  db.query("DELETE FROM agent_session_bindings WHERE id=?").run(removed.binding.id);
  syncAgentPresence(dropped + GRACE + 1_000);
  expect(removed.notices()).toEqual([]);

  // Never attached: the first sweep finds it detached and owes nothing.
  const unseen = await agent("claude", "/tmp/c");
  syncAgentPresence(dropped);
  syncAgentPresence(dropped + GRACE + 1_000);
  expect(unseen.notices()).toEqual([]);
});

const noticesTo = (dm: string) => clients.flatMap((client) => client.sent).filter((line) => line.includes(` PRIVMSG ${dm} :`) && line.includes("went offline"));
const settle = () => Bun.sleep(20);

test("a clean detach with no live runtime posts exactly one notice, as the agent", async () => {
  echo.on = true;
  const { binding } = await agent("claude", "/Users/ada/bit/slirc");
  const lease = bindLease(binding, "away-incarnation-0000000006")!;
  syncAgentPresence();
  disconnectAgentTransport(binding.id);
  invalidateLease(binding.id, lease.leaseId);
  const dropped = Date.now();
  syncAgentPresence(dropped);
  syncAgentPresence(dropped + GRACE + 1_000);
  await settle();
  syncAgentPresence(dropped + GRACE + 6_000);
  syncAgentPresence(dropped + 3 * GRACE);
  await settle();
  expect(noticesTo(binding.dm!)).toEqual([`@+slirc/agent-offline=claude PRIVMSG ${binding.dm} :My Claude Code session went offline. Run cd /Users/ada/bit/slirc && claude --resume ${binding.session_id} to bring me back. To delete me, use Remove on https://calango.slirc.app/agents`]);
  echo.on = false;
});

test("a session detached across an app restart gets one notice, and the next restart repeats none", async () => {
  echo.on = true;
  const { binding } = await agent("pi", "/Users/ada/.pi/agent/sessions/restart.jsonl");
  bindLease(binding, "away-incarnation-0000000007");
  syncAgentPresence();
  const stopped = Date.now();
  disconnectAgentTransport(binding.id);
  resetAgentSessionState(stopped);
  syncAgentPresence(stopped);
  syncAgentPresence(stopped + GRACE + 1_000);
  await settle();
  resetAgentSessionState(stopped + GRACE + 2_000);
  syncAgentPresence(stopped + 3 * GRACE);
  await settle();
  expect(noticesTo(binding.dm!)).toEqual([`@+slirc/agent-offline=pi PRIVMSG ${binding.dm} :My Pi session went offline. Run pi --session ${binding.session_id} to bring me back. To delete me, use Remove on https://calango.slirc.app/agents`]);
  echo.on = false;
});

test("a restart while the agent reattaches inside the grace period says nothing", async () => {
  echo.on = true;
  const { binding } = await agent("claude", "/tmp/restart-attached");
  bindLease(binding, "away-incarnation-0000000008");
  syncAgentPresence();
  const stopped = Date.now();
  disconnectAgentTransport(binding.id);
  resetAgentSessionState(stopped);
  await connectAgentTransport(binding);
  clients.at(-1)!.options.onMessage({ command: "JOIN", params: [binding.dm], tags: {}, prefix: `${binding.nick}!u@host` });
  bindLease(binding, "away-incarnation-0000000009");
  syncAgentPresence(stopped + 1_000);
  syncAgentPresence(stopped + GRACE + 1_000);
  await settle();
  expect(noticesTo(binding.dm!)).toEqual([]);
  echo.on = false;
});

test("a revoked agent with no live runtime gets no notice", async () => {
  echo.on = true;
  const { binding } = await agent("claude", "/tmp/revoked-detached");
  const lease = bindLease(binding, "away-incarnation-0000000010")!;
  syncAgentPresence();
  disconnectAgentTransport(binding.id);
  invalidateLease(binding.id, lease.leaseId);
  db.query("UPDATE agent_session_bindings SET status='revoked' WHERE id=?").run(binding.id);
  syncAgentPresence(Date.now() + GRACE + 1_000);
  await settle();
  expect(noticesTo(binding.dm!)).toEqual([]);
  echo.on = false;
});

test("the notice falls back when the folder or the harness is unknown", () => {
  const id = "6ff65ec2-d186-41c3-b9c1-725394c9be86";
  expect(awayNotice({ harness: "claude", session_id: id, session_file: `claude:${id}` }, "https://x.slirc.app"))
    .toBe(`My Claude Code session went offline. Run claude --resume ${id} in the folder it ran in to bring me back. To delete me, use Remove on https://x.slirc.app/agents`);
  expect(awayNotice({ harness: "claude", session_id: id, session_file: "/Users/me/My Code" }, "https://x.slirc.app"))
    .toContain(`Run cd '/Users/me/My Code' && claude --resume ${id} to bring me back`);
  expect(awayNotice({ harness: "echo", session_id: "", session_file: "" }, "https://x.slirc.app"))
    .toBe("My session went offline. Resume it in the folder it ran in to bring me back. To delete me, use Remove on https://x.slirc.app/agents");
});
