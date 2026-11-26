import "./fixture.ts";
import { expect, mock, test } from "bun:test";

// SSE recheck proof: the transport's offeredRequests is blocked in a live privacy probe while the
// lease is revoked. The route must recheck lease+stream+binding before writing, so no request
// content may reach the client. Protocol-peer/local mock only; not live-Ergo or Pi evidence.
process.env.AGENT_SSE_KEEPALIVE_MS = "50";
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
let probeGate: Promise<void> | null = null;
mock.module("../src/grants.ts", () => ({
  ...grants,
  readPrivateChannelMode: async () => {
    if (probeGate) await probeGate;
    return { secret: true, inviteOnly: true };
  },
}));

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { connectAgentTransport } = await import("../src/agent-session-transport.ts");
const { app } = await import("../src/server.ts");

const owner = accountByNick("bitbonsai")!;
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "sse-test", sessionFile: "/tmp/sse-test.jsonl",
  secret, machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-sse-test";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
db.query(`INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)`)
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
await connectAgentTransport(binding);
options.onMessage({ command: "JOIN", params: [binding.dm], tags: {}, prefix: `${binding.nick}!u@host` });
const lease = bindLease(binding, "sse-incarnation-00000000001")!;

test("SSE writes no content when the lease is revoked while a privacy probe waits", async () => {
  options.onMessage({ command: "PRIVMSG", params: [binding.dm, "top secret content"], tags: { account: owner.nick, msgid: "sse-1" }, prefix: `${owner.nick}!u@host` });
  expect((db.query("SELECT status FROM agent_session_requests WHERE original_msgid='sse-1'").get() as any).status).toBe("offered");

  let release!: () => void;
  probeGate = new Promise<void>((resolve) => { release = resolve; });
  let text = "";
  try {
    const response = await app.request("/api/agent/session/events", {
      headers: { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": lease.leaseId },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await Bun.sleep(20); // let the loop reach the blocked privacy probe
    // Revoke the lease without changing the request row, so only the route's pre-write recheck
    // can stop the already-fetched offered content from being disclosed.
    db.query("UPDATE agent_session_bindings SET lease_id=NULL,lease_nonce=NULL,lease_expires_at=NULL WHERE id=?").run(binding.id);
    release();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } finally {
    probeGate = null;
  }
  expect(text).not.toContain("top secret content");
  expect(text).not.toContain("sse-1");
}, 10_000);

test("the event stream opens with a keepalive comment and repeats it while quiet", async () => {
  db.query("DELETE FROM agent_session_requests WHERE binding_id=?").run(binding.id);
  const fresh = bindLease(binding, "sse-incarnation-00000000002")!;
  const response = await app.request("/api/agent/session/events", {
    headers: { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": fresh.leaseId },
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2_000;
  while (!text.includes(": keepalive") && Date.now() < deadline) {
    const { done, value } = await Promise.race([reader.read(), Bun.sleep(100).then(() => ({ done: false, value: undefined }))]);
    if (done) break;
    if (value) text += decoder.decode(value);
  }
  await reader.cancel();
  expect(text).toContain(": keepalive\n\n");
  expect(text).not.toContain("event:");
});
