import "./fixture.ts";
import { beforeEach, expect, mock, test } from "bun:test";

// Focused regression coverage for provisionBinding's ambiguous-registration recovery. The real
// Ergo API is mocked, but the fixed decision logic and DB effects run for real.
const accounts = await import("../src/accounts.ts");
let ergoImpl: (path: string, body: Record<string, unknown>) => Promise<any> = async () => ({ success: true });
mock.module("../src/accounts.ts", () => ({ ...accounts, ergo: (path: string, body: Record<string, unknown>) => ergoImpl(path, body) }));

const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, setAlwaysOn: async () => {}, createDirectChannel: async () => {} }));

const rooms = await import("../src/rooms.ts");
mock.module("../src/rooms.ts", () => ({
  ...rooms,
  directConversation: () => null,
  directChannelName: () => "#dm-reg-test",
  createDirectConversation: () => ({ channel: "#dm-reg-test", nick: "agent" }),
}));

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { provisionBinding } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");

const owner = accountByNick("bitbonsai")!;
let counter = 0;
function reservedBinding() {
  const { binding } = testBinding({
    owner: owner.nick, harness: "pi", protocol: 1, sessionId: `reg-${++counter}`, sessionFile: `/tmp/reg-${counter}.jsonl`,
    secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
    machine: "fixture", sessionName: "fixture", ownerAccountIdForNick: () => owner.id,
  });
  // The owner's Allow; provisioning refuses a session that never got one.
  db.query("UPDATE agent_session_bindings SET confirmed_at=? WHERE id=?").run(Date.now(), binding.id);
  return { ...binding, confirmed_at: Date.now() };
}

beforeEach(() => {
  db.query("DELETE FROM agent_session_bindings").run();
  db.query("DELETE FROM agent_connect_requests").run();
  db.query("DELETE FROM accounts WHERE nick LIKE 'pi-%' AND kind='agent'").run();
  ergoImpl = async () => ({ success: true });
});

test("ACCOUNT_EXISTS with the reserved credentials finishes provisioning without rotation", async () => {
  const binding = reservedBinding();
  ergoImpl = async (path) => path === "/v1/ns/saregister"
    ? { success: false, errorCode: "ACCOUNT_EXISTS", error: "account exists" }
    : { success: true };
  const ready = await provisionBinding(binding);
  expect(ready.status).toBe("ready");
  const row = db.query("SELECT agent_account_id FROM agent_session_bindings WHERE id=?").get(binding.id) as any;
  expect(row.agent_account_id).toBe(binding.agent_account_id);
  expect((db.query("SELECT irc_password_gen FROM accounts WHERE nick=?").get(binding.nick) as any).irc_password_gen).toBe(0);
  // The agent account names the host it runs on, not its harness.
  expect(accountByNick(binding.nick)?.machine).toBe("fixture");
});

test("ACCOUNT_EXISTS with wrong reserved credentials refuses rather than taking over", async () => {
  const binding = reservedBinding();
  ergoImpl = async (path) => path === "/v1/ns/saregister"
    ? { success: false, errorCode: "ACCOUNT_EXISTS", error: "account exists" }
    : { success: false, error: "bad password", errorCode: "INVALID_PASSPHRASE" };
  await expect(provisionBinding(binding)).rejects.toThrow("reserved agent account needs recovery");
  expect((db.query("SELECT status FROM agent_session_bindings WHERE id=?").get(binding.id) as any).status).toBe("provisioning");
});

test("a non-ACCOUNT_EXISTS registration failure still refuses", async () => {
  const binding = reservedBinding();
  ergoImpl = async () => ({ success: false, errorCode: "INVALID_ACCOUNT_NAME", error: "bad name" });
  await expect(provisionBinding(binding)).rejects.toThrow("bad name");
});

test("an existing reserved account with wrong credentials refuses", async () => {
  const binding = reservedBinding();
  db.query(`INSERT INTO accounts (nick,email,irc_password_gen,account_id,role,kind,owner,created_at) VALUES (?,?,0,?,'member','agent',?,?)`)
    .run(binding.nick, `${binding.nick}@agents.invalid`, binding.agent_account_id, owner.nick, Date.now());
  ergoImpl = async () => ({ success: false, error: "bad password", errorCode: "INVALID_PASSPHRASE" });
  await expect(provisionBinding(binding)).rejects.toThrow("reserved agent account needs recovery");
});

test("an agent account with another id is not taken over by the binding", async () => {
  const binding = reservedBinding();
  db.query(`INSERT INTO accounts (nick,email,irc_password_gen,role,kind,owner,created_at) VALUES (?,?,0,'member','agent',?,?)`)
    .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
  await expect(provisionBinding(binding)).rejects.toThrow("reserved agent identity is unavailable");
});

test("registration uses the password derived from the binding's agent account id, and the row keeps that id", async () => {
  const { ircPasswordFor } = await import("../src/irc-key.ts");
  const binding = reservedBinding();
  const seen: string[] = [];
  ergoImpl = async (path, body) => { if (path === "/v1/ns/saregister") seen.push(String(body.passphrase)); return { success: true }; };
  await provisionBinding(binding);
  expect(binding.agent_account_id).toMatch(/^[0-9a-f]{32}$/);
  expect(seen).toEqual([ircPasswordFor(binding.agent_account_id!, 0)]);
  const row = db.query("SELECT account_id, irc_password_gen FROM accounts WHERE nick = ?").get(binding.nick) as any;
  expect(row).toEqual({ account_id: binding.agent_account_id, irc_password_gen: 0 });
});

test("a newly provisioned agent DM fires the owner's live direct event once", async () => {
  const { subscribe } = await import("../src/live.ts");
  const seen: unknown[] = [];
  const stop = subscribe(owner.nick, (event, data) => { if (event === "direct") seen.push(data); });
  try {
    const binding = reservedBinding();
    await provisionBinding(binding);
    expect(seen).toEqual([{ channel: "#dm-reg-test" }]);
    await provisionBinding(binding); // Already ready: nothing new to show.
    expect(seen).toHaveLength(1);
  } finally {
    stop();
  }
});

test("a session the owner has not allowed is never provisioned", async () => {
  const binding = reservedBinding();
  db.query("UPDATE agent_session_bindings SET confirmed_at=NULL WHERE id=?").run(binding.id);
  const calls: string[] = [];
  ergoImpl = async (path) => { calls.push(path); return { success: true }; };
  await expect(provisionBinding(binding)).rejects.toThrow("waiting for the owner to allow this session");
  expect(calls).toEqual([]);
  expect(db.query("SELECT 1 FROM accounts WHERE nick=?").get(binding.nick)).toBeNull();
});
