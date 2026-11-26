import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

// serveStatic resolves "./public" from the cwd; `bun test app` from the repo root would otherwise 404.
process.chdir(new URL("..", import.meta.url).pathname);

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
db.query("UPDATE profiles SET avatar_path = 'test' WHERE account = 'bitbonsai'").run();
const pairing = await import("../src/pairing.ts");
const agentAccounts = await import("../src/agent-accounts.ts");
const rooms = await import("../src/rooms.ts");
const { app } = await import("../src/server.ts");
const { ircPasswordFor } = await import("../src/irc-key.ts");
const { resetRateLimits } = await import("../src/request-security.ts");
const { subscribe } = await import("../src/live.ts");

const ownerToken = "owner-session";
const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = (token = ownerToken) => ({ Cookie: `slirc_session=${token}` });

class FakeIrcClient {
  events: string[] = [];
  private waiters: { predicate: (message: any) => boolean; resolve: () => void }[] = [];

  constructor(private connectError?: Error) {}

  async connect() {
    this.events.push("connect");
    if (this.connectError) throw this.connectError;
  }

  send(line: string) {
    this.events.push(line);
    const first = line.match(/^PRIVMSG NickServ :(UNREGISTER|ERASE) (\S+)$/);
    if (first) this.emit({ tags: {}, prefix: "NickServ!service@localhost", command: "NOTICE", params: ["agent", `To confirm, run this command: /NS ${first[1]} ${first[2]} confirm-code`] });
    if (/^PRIVMSG NickServ :(UNREGISTER|ERASE) \S+ confirm-code$/.test(line)) this.emit({ tags: {}, prefix: "NickServ!service@localhost", command: "NOTICE", params: ["agent", "Successfully unregistered account codex-bitbonsai"] });
    if (line.startsWith("PRIVMSG NickServ :PASSWD ")) this.emit({ tags: {}, prefix: "NickServ!service@localhost", command: "NOTICE", params: ["agent", "Password changed"] });
    if (line.startsWith("OPER ")) this.emit({ tags: {}, prefix: "server", command: "381", params: [] });
  }

  quit() {
    this.events.push("quit");
  }

  waitFor(predicate: (message: any) => boolean): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }

  private emit(message: any) {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      if (!this.waiters[index].predicate(message)) continue;
      this.waiters[index].resolve();
      this.waiters.splice(index, 1);
    }
  }
}

beforeEach(() => {
  resetRateLimits();
  db.query("DELETE FROM pair_requests").run();
  db.query("DELETE FROM agent_connect_requests").run();
  db.query("DELETE FROM irc_devices").run();
  db.query("DELETE FROM magic_links").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM accounts WHERE nick <> 'bitbonsai'").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sessionHash(ownerToken), Date.now());
  process.env.ERGO_OPER_USER = "slirc-org";
  delete process.env.ERGO_OPER_PASS;
  agentAccounts.setAgentIrcClientFactoryForTests();
});

const sessionRequest = (ip: string) => pairing.createRequest({ kind: "session", browser: "Chrome", os: "macOS", ip });

// The closed legacy connect route, as a 1.x client calls it.
async function connectAgent(harness: string, machine: string) {
  return app.request("/api/agent/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Real-IP": `connect-${harness}` },
    body: JSON.stringify({ code: "123456", harness, machine }),
  });
}

describe("agent pairing v1 is gone", () => {
  test("agent pairing requests answer 410", async () => {
    const response = await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Real-IP": "pair-agent" },
      body: JSON.stringify({ owner: "bitbonsai", machine: "Mauricio's Mac", tool: "claude" }),
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "agent pairing moved to connect codes" });
    expect(db.query("SELECT COUNT(*) AS count FROM pair_requests").get()).toEqual({ count: 0 });
  });

  test("a leftover agent-kind row cannot be allowed or denied", async () => {
    db.query(`INSERT INTO pair_requests (code, secret_hash, kind, owner, machine, tool, ip, status, expires_at, created_at)
              VALUES ('123456', 'x', 'agent', 'bitbonsai', 'Mac', 'claude', 'old', 'pending', ?, ?)`).run(Date.now() + 60_000, Date.now());
    expect((await app.request("/api/pair/123456/allow", { method: "POST", headers: auth() })).status).toBe(410);
    expect((await app.request("/api/pair/123456/deny", { method: "POST", headers: auth() })).status).toBe(410);
    expect(db.query("SELECT 1 FROM accounts WHERE nick = 'claude-bitbonsai'").get()).toBeNull();
  });
});

describe("agent accounts", () => {
  test("connected agent shows in profiles and the owner's list, and can be removed", async () => {
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, machine, verified_at, created_at)
              VALUES ('codex-bitbonsai', 'codex-bitbonsai@agents.invalid', 'member', 'agent', 'bitbonsai', 'Build host', ?, ?)`)
      .run(Date.now(), Date.now());
    expect(db.query("SELECT kind, owner, machine FROM accounts WHERE nick = 'codex-bitbonsai'").get()).toEqual({ kind: "agent", owner: "bitbonsai", machine: "Build host" });
    const profile = await (await app.request("/profiles/codex-bitbonsai?channel=%23help", { headers: auth() })).json();
    expect(profile).toEqual(expect.objectContaining({ account: "codex-bitbonsai", kind: "agent", owner: "bitbonsai", machine: "Build host" }));
    const listed = await app.request("/api/agents", { headers: auth() });
    expect(await listed.json()).toEqual([{ nick: "codex-bitbonsai", machine: "Build host", lastSeen: null, status: "unknown", agent: null, bindingId: null }]);
    const irc = new FakeIrcClient();
    agentAccounts.setAgentIrcClientFactoryForTests(() => irc);
    // Every open page that shows the agent hears it went, so it drops without a reload.
    const heard: unknown[] = [];
    const stop = subscribe("bitbonsai", (event, data) => { if (event === "agent-removed") heard.push(data); });
    try {
      expect((await app.request("/api/agents/codex-bitbonsai", { method: "DELETE", headers: auth() })).status).toBe(204);
    } finally { stop(); }
    expect(db.query("SELECT 1 FROM accounts WHERE nick = 'codex-bitbonsai'").get()).toBeNull();
    expect(heard).toEqual([{ nick: "codex-bitbonsai" }]);
  });

  test("reconnect returns 409 when stored agent password cannot authenticate", async () => {
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, machine, verified_at, created_at)
              VALUES ('claude-bitbonsai', 'claude-bitbonsai@agents.invalid', 'member', 'agent', 'bitbonsai', 'Old Mac', ?, ?)`)
      .run(Date.now(), Date.now());
    const irc = new FakeIrcClient(new Error("SASL login failed for claude-bitbonsai: invalid credentials"));
    agentAccounts.setAgentIrcClientFactoryForTests(() => irc);
    const response = await connectAgent("claude", "New Mac");
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("password");
    expect(db.query("SELECT irc_password_gen, machine FROM accounts WHERE nick = 'claude-bitbonsai'").get()).toEqual({ irc_password_gen: null, machine: "Old Mac" });
  });

  test("parses NickServ confirmation codes", () => {
    expect(agentAccounts.nickServConfirmationCode("To confirm, run this command: /NS UNREGISTER codex-bitbonsai A1b2", "UNREGISTER", "codex-bitbonsai")).toBe("A1b2");
    expect(agentAccounts.nickServConfirmationCode("unrelated notice", "UNREGISTER", "codex-bitbonsai")).toBeNull();
  });

  test("runs NickServ removal challenge before confirmation", async () => {
    const client = new FakeIrcClient();
    await agentAccounts.unregisterAgent("codex-bitbonsai", "old-password", () => client);
    expect(client.events).toEqual([
      "connect",
      "PRIVMSG NickServ :UNREGISTER codex-bitbonsai",
      "PRIVMSG NickServ :UNREGISTER codex-bitbonsai confirm-code",
      "quit",
    ]);
  });

  test("removes grants and memberships before IRC account, SQLite account last", async () => {
    const events: string[] = [];
    await agentAccounts.removeAgentAccount("codex-bitbonsai", "old-password", ["#one", "#two"], {
      revoke: async (channel) => { events.push(`revoke ${channel}`); },
      deleteMemberships: () => { events.push("delete memberships"); },
      unregister: async () => { events.push("unregister"); },
      erase: async () => { events.push("erase"); },
      deleteAccount: () => { events.push("delete account"); },
    });
    expect(events).toEqual(["revoke #one", "revoke #two", "delete memberships", "unregister", "delete account"]);
  });

  test("unregisters agent direct channels and their threads from Ergo", async () => {
    db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-agent1', '#dm-bitbonsai-codex-bitbonsai', 'root', 'Agent thread', 'https://example.test/agent', 'bitbonsai', 1, 1)").run();
    const events: string[] = [];
    await agentAccounts.removeAgentAccount("codex-bitbonsai", "old-password", ["#room", "#dm-bitbonsai-codex-bitbonsai"], {
      revoke: async (channel) => { events.push(`revoke ${channel}`); },
      unregisterDirect: async (channel) => { events.push(`unregister channel ${channel}`); },
      deleteMemberships: () => { events.push("delete memberships"); },
      deleteDirects: (channels) => { events.push(`delete directs ${channels.join(",")}`); },
      unregister: async () => { events.push("unregister account"); },
      erase: async () => { events.push("erase account"); },
      deleteAccount: () => { events.push("delete account"); },
    });
    expect(events).toEqual([
      "unregister channel #t-agent1",
      "unregister channel #dm-bitbonsai-codex-bitbonsai",
      "revoke #room",
      "delete memberships",
      "delete directs #t-agent1,#dm-bitbonsai-codex-bitbonsai",
      "unregister account",
      "delete account",
    ]);
  });

  test("oper credentials select ERASE removal", async () => {
    process.env.ERGO_OPER_USER = "oper";
    process.env.ERGO_OPER_PASS = "oper-password";
    const events: string[] = [];
    await agentAccounts.removeAgentAccount("codex-bitbonsai", "old-password", [], {
      revoke: async () => {},
      deleteMemberships: () => { events.push("delete memberships"); },
      unregister: async () => { events.push("unregister"); },
      erase: async () => { events.push("erase"); },
      deleteAccount: () => { events.push("delete account"); },
    });
    expect(events).toEqual(["delete memberships", "erase", "delete account"]);
  });

  test("oper ERASE logs in with SASL as the oper under its own nick", async () => {
    // Ergo with require-sasl drops a connection that does not log in, and removal failed with
    // "IRC connection closed" (calango, claude-code-8fe7).
    const client = new FakeIrcClient();
    let options: any;
    await agentAccounts.eraseAgentAsOper("claude-code-8fe7", "slirc-org", "oper-password", (given) => { options = given; return client; });
    expect(options).toEqual(expect.objectContaining({ saslUser: "slirc-org", saslPass: "oper-password" }));
    expect(options.nick).toMatch(/^slirc-org-[0-9a-f]{6}$/);
    expect(client.events).toEqual([
      "connect",
      "NS SET ALWAYS-ON false",
      "OPER slirc-org oper-password",
      "PRIVMSG NickServ :ERASE claude-code-8fe7",
      "PRIVMSG NickServ :ERASE claude-code-8fe7 confirm-code",
      "quit",
    ]);
  });

  test("an Ergo account that is already gone counts as removed", async () => {
    class MissingAccountClient extends FakeIrcClient {
      send(line: string) {
        if (/^PRIVMSG NickServ :UNREGISTER \S+$/.test(line)) {
          this.events.push(line);
          (this as any).emit({ tags: {}, prefix: "NickServ!service@localhost", command: "NOTICE", params: ["agent", "Invalid account name"] });
          return;
        }
        super.send(line);
      }
    }
    const missing = new MissingAccountClient();
    await agentAccounts.unregisterAgent("codex-bitbonsai", "old-password", () => missing);
    expect(missing.events).toEqual(["connect", "PRIVMSG NickServ :UNREGISTER codex-bitbonsai", "quit"]);
    const noLogin = new FakeIrcClient(new Error("SASL login failed for codex-bitbonsai: invalid credentials"));
    await agentAccounts.unregisterAgent("codex-bitbonsai", "old-password", () => noLogin);
    expect(noLogin.events).toEqual(["connect", "quit"]);
  });

  test("removing an agent whose Ergo account is gone revokes and deletes it locally", async () => {
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at)
              VALUES ('claude-code-8fe7', 'claude-code-8fe7@agents.invalid', 'member', 'agent', 'bitbonsai', ?, ?)`).run(Date.now(), Date.now());
    db.query(`INSERT INTO agent_session_bindings (id, instance_id, owner_account_id, owner_nick, harness, session_id, session_file, secret_hash, nick, status, machine, session_name, created_at)
              VALUES ('old-binding', 'calango', 'owner-id', 'bitbonsai', 'claude-code', 's1', '/tmp/s1', 'hash-old-binding', 'claude-code-8fe7', 'ready', 'Mac', 'old', ?)`).run(Date.now());
    agentAccounts.setAgentIrcClientFactoryForTests(() => new FakeIrcClient(new Error("SASL login failed for claude-code-8fe7: invalid credentials")));
    expect((await app.request("/api/agents/claude-code-8fe7", { method: "DELETE", headers: auth() })).status).toBe(204);
    expect(db.query("SELECT 1 FROM accounts WHERE nick = 'claude-code-8fe7'").get()).toBeNull();
    expect(db.query("SELECT status FROM agent_session_bindings WHERE id = 'old-binding'").get()).toEqual({ status: "revoked" });
  });

  test("a failed removal answers 500 with the reason and logs it", async () => {
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at)
              VALUES ('codex-bitbonsai', 'codex-bitbonsai@agents.invalid', 'member', 'agent', 'bitbonsai', ?, ?)`).run(Date.now(), Date.now());
    agentAccounts.setAgentIrcClientFactoryForTests(() => new FakeIrcClient(new Error("IRC connection closed")));
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const response = await app.request("/api/agents/codex-bitbonsai", { method: "DELETE", headers: auth() });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "IRC connection closed" });
    } finally { console.error = original; }
    expect(logged.some((args) => String(args[0]).includes("DELETE /api/agents/codex-bitbonsai failed"))).toBe(true);
    expect(db.query("SELECT 1 FROM accounts WHERE nick = 'codex-bitbonsai'").get()).not.toBeNull();
  });

  test("rotates password through authenticated NickServ command", async () => {
    const client = new FakeIrcClient();
    expect(await agentAccounts.rotateAgentPassword("codex-bitbonsai", "old-password", "new-password", () => client)).toBe(true);
    expect(client.events).toEqual([
      "connect",
      "PRIVMSG NickServ :PASSWD old-password new-password new-password",
      "quit",
    ]);
  });

  test("password rotation reports stale stored credentials", async () => {
    const client = new FakeIrcClient(new Error("SASL login failed for codex-bitbonsai: invalid credentials"));
    expect(await agentAccounts.rotateAgentPassword("codex-bitbonsai", "old-password", "new-password", () => client)).toBe(false);
    expect(client.events).toEqual(["connect", "quit"]);
  });

  test("agent cannot create a channel", async () => {
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, machine, verified_at, created_at)
              VALUES ('claude-bitbonsai', 'claude-bitbonsai@agents.invalid', 'member', 'agent', 'bitbonsai', 'Mac', ?, ?)`)
      .run(Date.now(), Date.now());
    const token = "agent-session";
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'claude-bitbonsai', ?)").run(sessionHash(token), Date.now());
    const response = await app.request("/api/channels", {
      method: "POST",
      headers: { ...auth(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "agent-room" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "agents cannot manage channels" });
  });
});

describe("direct-message threads", () => {
  test("refuses to register a client-made #t- channel under a DM", async () => {
    const direct = rooms.createDirectConversation("bitbonsai", "thread-peer", "bitbonsai");
    const response = await app.request("/api/threads", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "#t-dm1234", parent: "thread-peer", root: "root-dm", title: "DM thread", url: "https://app.slirc.org/?msg=root-dm", rootNick: "thread-peer", rootText: "**Root** message", rootTime: "2026-09-08T11:00:00.000Z" }),
    });

    expect(direct.channel).toBeTruthy();
    expect(response.status).toBe(410);
    expect(db.query("SELECT 1 FROM threads WHERE channel = '#t-dm1234'").get()).toBeNull();
  });
});

describe("browser session pairing", () => {
  test("issues a six-digit code and one-time 32-byte secret, hidden from unrelated owners", async () => {
    const response = await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Real-IP": "pair-issue" },
      body: JSON.stringify({ kind: "session" }),
    });
    const issued = await response.json() as { code: string; secret: string; expiresAt: number };
    expect(response.status).toBe(201);
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(Buffer.from(issued.secret, "base64url")).toHaveLength(32);
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    const stored = db.query("SELECT secret_hash FROM pair_requests WHERE code = ?").get(issued.code) as { secret_hash: string };
    expect(stored.secret_hash).not.toBe(issued.secret);
    const pending = await (await app.request(`/api/pair/pending?code=${issued.code}`, { headers: auth() })).json() as Record<string, unknown>[];
    expect(pending[0]).not.toHaveProperty("secret");
    expect(pending[0]).not.toHaveProperty("secret_hash");
  });

  test("wrong secret returns 404", async () => {
    const issued = sessionRequest("wrong-secret");
    const response = await app.request(`/api/pair/${issued.code}`, { headers: { "X-Pair-Secret": "wrong" } });
    expect(response.status).toBe(404);
  });

  test("expired request cannot be found or delivered", () => {
    const issued = sessionRequest("expired");
    db.query("UPDATE pair_requests SET expires_at = ? WHERE code = ?").run(Date.now() - 1, issued.code);
    expect(pairing.deliverOnce(issued.code, issued.secret)).toBeNull();
    expect(pairing.findByCode(issued.code)).toBeNull();
  });

  test("polling is limited even when untrusted forwarded IP headers rotate", async () => {
    const issued = sessionRequest("poll-request");
    for (let poll = 0; poll < 60; poll++) {
      const response = await app.request(`/api/pair/${issued.code}`, { headers: { "X-Pair-Secret": "wrong", "X-Real-IP": `192.0.2.${poll}`, "X-Forwarded-For": `192.0.2.${poll}` } });
      expect(response.status).toBe(404);
    }
    const limited = await app.request(`/api/pair/${issued.code}`, { headers: { "X-Pair-Secret": "wrong", "X-Real-IP": "poll-limit" } });
    expect(limited.status).toBe(429);
  });

  const desktopUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

  test("links a browser once and lets owner revoke it", async () => {
    const created = await app.request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": desktopUa, "X-Real-IP": "session-link" },
      body: JSON.stringify({ kind: "session" }),
    });
    const issued = await created.json() as { code: string; secret: string };
    expect(created.status).toBe(201);
    expect(await (await app.request("/api/pair/pending", { headers: auth() })).json()).toEqual([]);
    expect(await (await app.request(`/api/pair/pending?code=${issued.code}`, { headers: auth() })).json()).toEqual([
      expect.objectContaining({ code: issued.code, kind: "session", browser: "Chrome", os: "macOS" }),
    ]);
    // The code as another device shows it, "123 456", pasted with its space.
    const spaced = encodeURIComponent(` ${issued.code.slice(0, 3)} ${issued.code.slice(3)} `);
    expect(await (await app.request(`/api/pair/pending?code=${spaced}`, { headers: auth() })).json()).toEqual([
      expect.objectContaining({ code: issued.code }),
    ]);

    expect((await app.request(`/api/pair/${issued.code}/allow`, { method: "POST", headers: auth() })).status).toBe(200);
    const delivered = await app.request(`/api/pair/${issued.code}`, { headers: { "X-Pair-Secret": issued.secret, "X-Real-IP": "session-poll" } });
    const { loginToken } = await delivered.json() as { loginToken: string };
    expect(loginToken).toHaveLength(43);

    const exchanged = await app.request(`/api/pair/${issued.code}/session?token=${encodeURIComponent(loginToken)}`, { headers: { "User-Agent": desktopUa } });
    expect(exchanged.status).toBe(302);
    const desktopCookie = exchanged.headers.get("set-cookie")?.match(/slirc_session=([^;]+)/)?.[1];
    expect(desktopCookie).toBeTruthy();
    const signedIn = await (await app.request("/auth/me", { headers: auth(desktopCookie) })).json();
    expect(signedIn).toEqual(expect.objectContaining({ authenticated: true, nick: "bitbonsai" }));
    expect((await app.request(`/api/pair/${issued.code}/session?token=${encodeURIComponent(loginToken)}`)).status).toBe(404);

    const sessions = await (await app.request("/api/sessions", { headers: auth() })).json() as { id: string; device: string; current: boolean }[];
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ device: "Unknown device", current: true }),
      expect.objectContaining({ device: "Chrome · macOS", current: false }),
    ]));
    const desktop = sessions.find((item) => item.device === "Chrome · macOS")!;
    expect((await app.request(`/api/sessions/${desktop.id}`, { method: "DELETE", headers: auth() })).status).toBe(204);
    expect(await (await app.request("/auth/me", { headers: auth(desktopCookie) })).json()).toEqual({ authenticated: false, serviceNicks: ["slirc", "slirc-org"], signup: true, openRoom: "#open-chat" });
    const current = sessions.find((item) => item.current)!;
    expect((await app.request(`/api/sessions/${current.id}`, { method: "DELETE", headers: auth() })).status).toBe(204);
    expect(await (await app.request("/auth/me", { headers: auth() })).json()).toEqual({ authenticated: false, serviceNicks: ["slirc", "slirc-org"], signup: true, openRoom: "#open-chat" });
  });

  test("not me blocks another session request from same IP", async () => {
    const issued = pairing.createRequest({ kind: "session", browser: "Chrome", os: "macOS", ip: "denied-session" });
    expect((await app.request(`/api/pair/${issued.code}/deny`, { method: "POST", headers: auth() })).status).toBe(204);
    expect(() => pairing.createRequest({ kind: "session", browser: "Chrome", os: "macOS", ip: "denied-session" })).toThrow("blocked");
  });

  test("session approval requires a verified human", async () => {
    const issued = pairing.createRequest({ kind: "session", browser: "Chrome", os: "macOS", ip: "agent-approver" });
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at)
              VALUES ('agent-bitbonsai', 'agent-bitbonsai@agents.invalid', 'member', 'agent', 'bitbonsai', ?, ?)`).run(Date.now(), Date.now());
    const token = "agent-approver-session";
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'agent-bitbonsai', ?)").run(sessionHash(token), Date.now());
    expect((await app.request(`/api/pair/${issued.code}/allow`, { method: "POST", headers: auth(token) })).status).toBe(403);
  });
});

const ownerIrc = () => db.query("SELECT account_id, irc_password_gen FROM accounts WHERE nick = 'bitbonsai'").get() as
  { account_id: string; irc_password_gen: number };

describe("IRC devices", () => {
  test("adds a device, rotates the account password, and returns it once", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { path: string; body: Record<string, string> }[] = [];
    process.env.ERGO_API_MOCK = "false";
    process.env.ERGO_API_TOKEN = "test-token";
    globalThis.fetch = async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body || "{}")) });
      return Response.json({ success: true });
    };
    try {
      const response = await app.request("/api/irc/devices", { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify({ label: "Halloy on MacBook" }) });
      const result = await response.json() as { device: { id: string; label: string; createdAt: number }; password: string };

      expect(response.status).toBe(201);
      expect(result.device).toEqual(expect.objectContaining({ label: "Halloy on MacBook" }));
      const row = ownerIrc();
      expect(result.password).toBe(ircPasswordFor(row.account_id, row.irc_password_gen));
      expect(calls).toEqual([{ path: "/v1/ns/passwd", body: { accountName: "bitbonsai", passphrase: result.password } }]);
      expect(db.query("SELECT account, label FROM irc_devices WHERE id = ?").get(result.device.id)).toEqual({ account: "bitbonsai", label: "Halloy on MacBook" });
      expect(await (await app.request("/api/irc/devices", { headers: auth() })).json()).toEqual([result.device]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.ERGO_API_MOCK = "true";
      delete process.env.ERGO_API_TOKEN;
    }
  });

  test("removes one row, keeps the others, and rotates again", async () => {
    const originalFetch = globalThis.fetch;
    let changedPassword = "";
    process.env.ERGO_API_MOCK = "false";
    process.env.ERGO_API_TOKEN = "test-token";
    globalThis.fetch = async (_input, init) => {
      changedPassword = JSON.parse(String(init?.body || "{}")).passphrase;
      return Response.json({ success: true });
    };
    db.query("INSERT INTO irc_devices VALUES ('abcdefghijklmnop', 'bitbonsai', 'Senpai', 1), ('qrstuvwxyzABCDEF', 'bitbonsai', 'WeeChat', 2)").run();
    try {
      const response = await app.request("/api/irc/devices/abcdefghijklmnop", { method: "DELETE", headers: auth() });
      const result = await response.json() as { password: string };
      expect(response.status).toBe(200);
      expect(db.query("SELECT id FROM irc_devices ORDER BY created_at").all()).toEqual([{ id: "qrstuvwxyzABCDEF" }]);
      expect(result.password).toBe(changedPassword);
      expect(changedPassword).toBe(ircPasswordFor(ownerIrc().account_id, ownerIrc().irc_password_gen));
      expect(changedPassword).not.toBe("owner-pass");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.ERGO_API_MOCK = "true";
      delete process.env.ERGO_API_TOKEN;
    }
  });

  test("New password bumps the counter, sets Ergo to the new derived value and clears the reset note", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { path: string; body: Record<string, string> }[] = [];
    process.env.ERGO_API_MOCK = "false";
    process.env.ERGO_API_TOKEN = "test-token";
    globalThis.fetch = async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body || "{}")) });
      return Response.json({ success: true });
    };
    db.query("UPDATE accounts SET irc_password_gen = 4, irc_reset_notice = 3 WHERE nick = 'bitbonsai'").run();
    try {
      const response = await app.request("/api/irc/password", { method: "POST", headers: auth() });
      expect(response.status).toBe(200);
      const { password } = await response.json() as { password: string };
      const row = ownerIrc();
      expect(row.irc_password_gen).toBe(5);
      expect(password).toBe(ircPasswordFor(row.account_id, 5));
      expect(password).not.toBe(ircPasswordFor(row.account_id, 4));
      expect(calls).toEqual([{ path: "/v1/ns/passwd", body: { accountName: "bitbonsai", passphrase: password } }]);
      // Only the clients bit goes; the bots note stays until a bot gets a new password.
      expect((db.query("SELECT irc_reset_notice FROM accounts WHERE nick = 'bitbonsai'").get() as any).irc_reset_notice).toBe(2);
      expect((await (await app.request("/auth/me", { headers: auth() })).json() as any).ircReset).toEqual({ clients: false, bots: true });
      expect((await app.request("/api/irc/reset-notice", { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify({ kind: "bots" }) })).status).toBe(204);
      expect((db.query("SELECT irc_reset_notice FROM accounts WHERE nick = 'bitbonsai'").get() as any).irc_reset_notice).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.ERGO_API_MOCK = "true";
      delete process.env.ERGO_API_TOKEN;
    }
  });

  test("leaves SQLite unchanged when Ergo rejects rotation", async () => {
    const originalFetch = globalThis.fetch;
    const before = ownerIrc();
    process.env.ERGO_API_MOCK = "false";
    process.env.ERGO_API_TOKEN = "test-token";
    globalThis.fetch = async () => Response.json({ success: false });
    try {
      const response = await app.request("/api/irc/devices", { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify({ label: "Textual" }) });
      expect(response.status).toBe(500);
      expect(db.query("SELECT COUNT(*) AS count FROM irc_devices").get()).toEqual({ count: 0 });
      expect(ownerIrc()).toEqual(before);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.ERGO_API_MOCK = "true";
      delete process.env.ERGO_API_TOKEN;
    }
  });

  test("requires a verified web session and a device name", async () => {
    expect((await app.request("/api/irc/devices")).status).toBe(401);
    const response = await app.request("/api/irc/devices", { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify({ label: "\n" }) });
    expect(response.status).toBe(400);
  });
});
