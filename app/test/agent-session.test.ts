import "./fixture.ts";
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { bindSession, bindLease, hashAgentSecret, authenticateBinding, validLease, invalidateLease } = await import("../src/agent-session.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");

// What the owner's Allow does: bind this session to them.
function claim(secret: string, sessionId = "pi-session-one") {
  const owner = accountByNick("bitbonsai")!;
  return { binding: bindSession({
    owner: owner.nick, ownerAccountId: owner.id, harness: "pi", sessionId, sessionFile: `/tmp/${sessionId}.jsonl`,
    machine: "fixture", sessionName: sessionId, secretHash: hashAgentSecret(secret),
  }) };
}

test("allowing a session again keeps its agent and moves it to the new secret; a revoked one starts over", () => {
  db.query("DELETE FROM agent_session_bindings").run();
  const first = randomBytes(32).toString("base64url");
  const winner = claim(first).binding;
  // No password is stored; it derives from the agent account id fixed at bind time.
  expect(winner).not.toHaveProperty("irc_password");
  expect(winner.agent_account_id).toMatch(/^[0-9a-f]{32}$/);
  expect(winner.confirmed_at).toBeTruthy();
  db.query(`INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent','bitbonsai',?)`)
    .run(winner.nick, `${winner.nick}@agents.invalid`, Date.now());
  db.query("UPDATE agent_session_bindings SET status='ready',agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(winner.nick, winner.id);
  expect(authenticateBinding(first)?.id).toBe(winner.id);

  const second = randomBytes(32).toString("base64url");
  expect(claim(second).binding.id).toBe(winner.id);
  expect(authenticateBinding(first)).toBeNull();
  expect(authenticateBinding(second)?.id).toBe(winner.id);
  expect(db.query("SELECT COUNT(*) AS count FROM agent_session_bindings").get()).toEqual({ count: 1 });

  db.query("UPDATE agent_session_bindings SET status='revoked' WHERE id=?").run(winner.id);
  const fresh = claim(randomBytes(32).toString("base64url")).binding;
  expect(fresh.id).not.toBe(winner.id);
  expect(fresh.nick).not.toBe(winner.nick);
});

test("agent nicks are <harness>-<4 hex>, extending to 6 hex only when the short form is taken", () => {
  db.query("DELETE FROM agent_session_bindings").run();
  const first = claim(randomBytes(32).toString("base64url"), "nick-format-one");
  expect(first.binding.nick).toMatch(/^pi-[0-9a-f]{4}$/);
  // Constant randomness makes the short candidate collide with an existing account.
  db.query("DELETE FROM accounts WHERE nick IN ('pi-abab','pi-ababab')").run();
  db.query(`INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES ('pi-abab','pi-abab@agents.invalid','member','agent','bitbonsai',?)`).run(Date.now());
  const original = crypto.getRandomValues.bind(crypto);
  (crypto as any).getRandomValues = (array: Uint8Array) => array.fill(0xab);
  let second: ReturnType<typeof claim>;
  try { second = claim(randomBytes(32).toString("base64url"), "nick-format-two"); }
  finally { (crypto as any).getRandomValues = original; }
  expect(second.binding.nick).toBe("pi-ababab");
  db.query("DELETE FROM accounts WHERE nick='pi-abab'").run();
});

test("opening parent with an agent child grant is rejected even for IRC-origin updates", async () => {
  db.query("DELETE FROM threads WHERE channel='#t-agent-child'").run();
  db.query("DELETE FROM channel_members WHERE channel IN ('#agent-parent','#t-agent-child')").run();
  db.query("DELETE FROM channels WHERE channel IN ('#agent-parent','#t-agent-child')").run();
  db.query("DELETE FROM accounts WHERE nick='agent-open-test'").run();
  const sessionToken = "session-open-test";
  db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?,'bitbonsai',?)").run(createHash("sha256").update(sessionToken).digest("hex"), Date.now());
  db.query(`INSERT INTO accounts (nick,email,role,kind,owner,created_at)
    VALUES ('agent-open-test','agent-open-test@agents.invalid','member','agent','bitbonsai',?)`).run(Date.now());
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#agent-parent','bitbonsai','secret',?)").run(Date.now());
  db.query("INSERT INTO channel_members (channel,nick) VALUES ('#agent-parent','bitbonsai'),('#agent-parent','agent-open-test')").run();
  db.query(`INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#t-agent-child','bitbonsai','secret',?)`).run(Date.now());
  db.query("INSERT INTO channel_members (channel,nick) VALUES ('#t-agent-child','agent-open-test')").run();
  db.query(`INSERT INTO threads (channel,parent,root,title,url,created_by,created_at,last_activity)
    VALUES ('#t-agent-child','#agent-parent','root','test','/thread','bitbonsai',?,?)`).run(Date.now(), Date.now());
  const response = await app.request("/api/channels/agent-parent", {
    method: "PATCH", headers: { Cookie: `slirc_session=${sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "open", source: "irc" }),
  });
  expect(response.status).toBe(409);
  expect((db.query("SELECT visibility FROM channels WHERE channel='#agent-parent'").get() as any).visibility).toBe("secret");
});

test("lease nonce retry is idempotent; sibling lease cannot replace it", () => {
  db.query("DELETE FROM agent_session_bindings").run();
  const secret = randomBytes(32).toString("base64url");
  const binding = claim(secret).binding;
  db.query("UPDATE agent_session_bindings SET status='ready'").run();
  const lease = bindLease(binding, "instance-nonce-00000000000001")!;
  expect(bindLease(binding, "instance-nonce-00000000000001")).toEqual(lease);
  expect(bindLease(binding, "instance-nonce-00000000000002")).toBeNull();
  expect(validLease(binding, lease.leaseId)).toBe(true);
  expect(invalidateLease(binding.id, lease.leaseId)).toBe(true);
  expect(validLease(binding, lease.leaseId)).toBe(false);
});
