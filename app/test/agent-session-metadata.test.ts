import "./fixture.ts";
import { createHash } from "node:crypto";
import { expect, mock, test } from "bun:test";

// Agent display metadata: what the adapter reports, how it is cleaned, where it is exposed, and the
// live `agent-updated` event. Local IRC mock; no Ergo.
const irc = await import("../src/irc.ts");
mock.module("../src/irc.ts", () => ({
  ...irc,
  IrcClient: class {
    enabledCapabilities = new Set(["echo-message", "draft/multiline"]);
    constructor(_value: any) {}
    async connect() {}
    send(_line: string) { return true; }
    quit() {}
  },
}));
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }) }));

const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { bindLease } = await import("../src/agent-session.ts");
const { testBinding } = await import("./agent-binding.ts");
const { subscribe } = await import("../src/live.ts");
const { app } = await import("../src/server.ts");

const owner = accountByNick("bitbonsai")!;
const token = "agent-metadata-session";
db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), owner.nick, Date.now());
const cookie = { Cookie: `slirc_session=${token}` };
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const { binding } = testBinding({
  owner: owner.nick, harness: "pi", protocol: 1, sessionId: "metadata-test", sessionFile: "/tmp/metadata-test.jsonl",
  secret, machine: "fixture", sessionName: "", repo: "/home/owner/private/slirc.agent-server", model: "gpt-5.6-sol", provider: "openai-codex",
  ownerAccountIdForNick: () => owner.id,
});
binding.dm = "#dm-metadata-test";
db.query("UPDATE agent_session_bindings SET status='ready',dm=? WHERE id=?").run(binding.dm, binding.id);
db.query("INSERT INTO accounts (nick,email,role,kind,owner,created_at) VALUES (?,?,'member','agent',?,?)")
  .run(binding.nick, `${binding.nick}@agents.invalid`, owner.nick, Date.now());
db.query("UPDATE agent_session_bindings SET agent_account_id=(SELECT account_id FROM accounts WHERE nick=?) WHERE id=?").run(binding.nick, binding.id);
db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,'direct',?)").run(binding.dm, owner.nick, Date.now());
db.query("INSERT INTO channels (channel,owner,visibility,topic,created_at) VALUES ('#metadata-room',?,'secret','',?)").run(owner.nick, Date.now());
for (const nick of [owner.nick, binding.nick]) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(binding.dm, nick);
for (const nick of [owner.nick, binding.nick, "metadata-roommate"]) db.query("INSERT INTO channel_members (channel,nick) VALUES ('#metadata-room',?)").run(nick);
const lease = bindLease(binding, "metadata-incarnation-0000001")!.leaseId;
const post = (body: unknown, leaseId = lease) => app.request("/api/agent/session/metadata", {
  method: "POST", body: JSON.stringify(body),
  headers: { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": leaseId, "Content-Type": "application/json" },
});

test("pairing stores only the repo folder name; the display name falls back to it", async () => {
  const me = await (await app.request("/auth/me", { headers: cookie })).json();
  const row = me.accountDetails.find((item: any) => item.nick === binding.nick);
  expect(row.agent).toEqual({ harness: "pi", name: "slirc.agent-server", repo: "slirc.agent-server", model: "gpt-5.6-sol", provider: "openai-codex" });
  expect(JSON.stringify(me)).not.toContain("/home/owner/private");
});

test("metadata route is lease-bound, sanitizes and bounds input, and publishes agent-updated on change only", async () => {
  expect((await post({ name: "x" }, "wrong-lease")).status).toBe(401);
  expect((await post(["not", "an", "object"])).status).toBe(400);
  const seen: Record<string, unknown[]> = { [owner.nick]: [], "metadata-roommate": [], "metadata-stranger": [] };
  const stops = Object.keys(seen).map((nick) => subscribe(nick, (event, data) => { if (event === "agent-updated") seen[nick]!.push(data); }));
  try {
    const response = await post({ name: "  fix\u0007 the\u202e\n  login  " + "y".repeat(200), repo: "C:\\Users\\owner\\work\\api-server\\", model: "claude-opus-5-5", provider: "anthropic" });
    expect(response.status).toBe(200);
    const { agent } = await response.json();
    expect(agent.name.startsWith("fix the login y")).toBe(true);
    expect(agent.name.length).toBe(80);
    expect(agent.repo).toBe("api-server");
    expect(agent.model).toBe("claude-opus-5-5");
    expect(agent.provider).toBe("anthropic");
    await post({ name: agent.name }); // Unchanged: silent.
    await post({ name: "" }); // Cleared name falls back to the repo folder.
    expect(seen[owner.nick]).toEqual([
      { nick: binding.nick, agent },
      { nick: binding.nick, agent: { ...agent, name: "api-server" } },
    ]);
    expect(seen["metadata-roommate"]).toEqual(seen[owner.nick]);
    expect(seen["metadata-stranger"]).toEqual([]);
  } finally {
    for (const stop of stops) stop();
  }
});

test("attach carries a metadata snapshot, and every agent row exposes the same shape", async () => {
  db.query("UPDATE agent_session_bindings SET lease_id=NULL,lease_nonce=NULL,lease_expires_at=NULL WHERE id=?").run(binding.id);
  const attached = await app.request("/api/agent/session/attach", {
    method: "POST", body: JSON.stringify({ nonce: "metadata-incarnation-0000002", metadata: { name: "review", repo: "slirc", model: "gpt-6-sol", provider: "openai-codex" } }),
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
  });
  expect(attached.status).toBe(200);
  const expected = { harness: "pi", name: "review", repo: "slirc", model: "gpt-6-sol", provider: "openai-codex" };
  const members = await (await app.request("/api/channels/metadata-room/members", { headers: cookie })).json();
  expect(members.members.find((row: any) => row.nick === binding.nick).agent).toEqual(expected);
  const contacts = await (await app.request("/api/contacts", { headers: cookie })).json();
  const contact = contacts.accountDetails.find((row: any) => row.nick === binding.nick);
  if (contact) expect(contact.agent).toEqual(expected);
  const agents = await (await app.request("/api/agents", { headers: cookie })).json();
  expect(agents.find((row: any) => row.nick === binding.nick).agent).toEqual(expected);
});

test("owner rename shows at once, reaches the live session over SSE, and the adapter echo closes the loop", async () => {
  // Someone else cannot rename this agent.
  db.query("INSERT OR IGNORE INTO accounts (nick,email,role,kind,created_at) VALUES ('rename-stranger','rename-stranger@example.invalid','member','human',?)").run(Date.now());
  db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, 'rename-stranger', ?)").run(createHash("sha256").update("rename-stranger-session").digest("hex"), Date.now());
  const rename = (name: unknown, headers = cookie) => app.request(`/api/agents/${binding.nick}/name`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  expect((await rename("hijack", { Cookie: "slirc_session=rename-stranger-session" })).status).toBe(404);
  expect((await rename(42)).status).toBe(400);

  const lease = (db.query("SELECT lease_id FROM agent_session_bindings WHERE id=?").get(binding.id) as { lease_id: string }).lease_id;
  const seen: unknown[] = [];
  const stop = subscribe(owner.nick, (event, data) => { if (event === "agent-updated") seen.push(data); });
  try {
    const response = await rename("  deploy\u0007 fixes ");
    expect(response.status).toBe(200);
    expect((await response.json()).agent.name).toBe("deploy fixes");
    expect(seen).toEqual([{ nick: binding.nick, agent: expect.objectContaining({ name: "deploy fixes" }) }]);

    // The attached adapter receives it on its event stream.
    const events = await app.request("/api/agent/session/events", { headers: { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": lease } });
    const reader = events.body!.getReader();
    let text = "";
    const deadline = Date.now() + 2_000;
    while (!text.includes("event: rename") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain(`event: rename\ndata: {"name":"deploy fixes"}`);

    // Until the adapter acks, its stale local name cannot undo the owner's rename.
    const meta = (body: unknown) => app.request("/api/agent/session/metadata", { method: "POST", body: JSON.stringify(body), headers: { Authorization: `Bearer ${secret}`, "X-Slirc-Agent-Lease": lease, "Content-Type": "application/json" } });
    expect((await (await meta({ name: "review" })).json()).agent.name).toBe("deploy fixes");
    // The ack (same name) clears the pending rename and publishes nothing new.
    expect((await (await meta({ name: "deploy fixes" })).json()).agent.name).toBe("deploy fixes");
    expect(seen).toHaveLength(1);
    expect((db.query("SELECT rename_pending FROM agent_session_bindings WHERE id=?").get(binding.id) as any).rename_pending).toBeNull();
    // After that, a rename inside the session flows back to Slirc as before.
    expect((await (await meta({ name: "local rename" })).json()).agent.name).toBe("local rename");
    expect(seen).toHaveLength(2);
  } finally {
    stop();
  }
});
