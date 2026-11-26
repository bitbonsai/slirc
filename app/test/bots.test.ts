import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

// serveStatic resolves "./public" from the cwd; `bun test app` from the repo root would otherwise 404.
process.chdir(new URL("..", import.meta.url).pathname);
const ORIGIN = "https://slirc.test";
process.env.APP_ORIGIN = ORIGIN;

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const agentAccounts = await import("../src/agent-accounts.ts");
const { app } = await import("../src/server.ts");
const { ircPasswordFor } = await import("../src/irc-key.ts");

const ownerToken = "owner-session";
const otherToken = "other-session";
const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
// Writes carry what the Admin page sends: same Origin, JSON and the X-Slirc-Bots header.
const auth = (token = ownerToken) => ({ Cookie: `slirc_session=${token}`, Origin: ORIGIN, "Content-Type": "application/json", "X-Slirc-Bots": "1" });

class FakeIrcClient {
  events: string[] = [];
  private waiters: { predicate: (message: any) => boolean; resolve: () => void }[] = [];

  async connect() {
    this.events.push("connect");
  }

  send(line: string) {
    this.events.push(line);
    const first = line.match(/^PRIVMSG NickServ :(UNREGISTER|ERASE) (\S+)$/);
    if (first) this.emit({ tags: {}, prefix: "NickServ!service@localhost", command: "NOTICE", params: ["bot", `To confirm, run this command: /NS ${first[1]} ${first[2]} confirm-code`] });
    if (/^PRIVMSG NickServ :(UNREGISTER|ERASE) \S+ confirm-code$/.test(line)) {
      const nick = line.split(" ")[3];
      this.emit({ tags: {}, prefix: "NickServ!service@localhost", command: "NOTICE", params: ["bot", `Successfully unregistered account ${nick}`] });
    }
    if (line.startsWith("PRIVMSG NickServ :PASSWD ")) this.emit({ tags: {}, prefix: "NickServ!service@localhost", command: "NOTICE", params: ["bot", "Password changed"] });
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

const createBot = (name: string, token = ownerToken) => app.request("/api/bots", {
  method: "POST",
  headers: { ...auth(token), "Content-Type": "application/json" },
  body: JSON.stringify({ name }),
});

const listBots = async (token = ownerToken) => (await app.request("/api/bots", { headers: auth(token) })).json() as Promise<{ bots: { nick: string }[]; limit: number; used: number }>;

beforeEach(() => {
  db.query("DELETE FROM accounts WHERE kind = 'bot'").run();
  db.query("DELETE FROM sessions").run();
  db.query(`INSERT INTO accounts (nick, email, role, kind, verified_at, provisional_expires_at, created_at)
            VALUES ('igor', 'igor@example.com', 'member', 'human', ?, NULL, ?) ON CONFLICT(nick) DO NOTHING`).run(Date.now(), Date.now());
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sessionHash(ownerToken), Date.now());
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'igor', ?)").run(sessionHash(otherToken), Date.now());
  process.env.ERGO_OPER_USER = "slirc-org";
  delete process.env.ERGO_OPER_PASS;
  agentAccounts.setAgentIrcClientFactoryForTests();
});

describe("user bots", () => {
  test("requires a verified human session", async () => {
    expect((await app.request("/api/bots")).status).toBe(401);
    expect((await createBot("deploy", "nobody")).status).toBe(401);
  });

  test("creates a bot and never repeats the password", async () => {
    const created = await createBot("deploy");
    expect(created.status).toBe(201);
    const body = await created.json() as { nick: string; password: string };
    expect(body.nick).toBe("deploy");
    expect(body.password).toHaveLength(43);
    expect(db.query("SELECT kind, owner FROM accounts WHERE nick = 'deploy'").get()).toEqual({ kind: "bot", owner: "bitbonsai" });
    // Derived from the row's id at counter 0, never stored.
    const row = db.query("SELECT account_id, irc_password_gen FROM accounts WHERE nick = 'deploy'").get() as { account_id: string; irc_password_gen: number };
    expect(body.password).toBe(ircPasswordFor(row.account_id, 0));

    const listed = await listBots();
    expect(listed.limit).toBe(3);
    expect(listed.used).toBe(1);
    expect(listed.bots).toEqual([{ nick: "deploy", createdAt: expect.any(Number), lastSeen: null }]);
    expect(JSON.stringify(listed)).not.toContain(body.password);
  });

  test("qualifies the name when it is already taken", async () => {
    expect((await createBot("deploy")).status).toBe(201);
    const second = await createBot("deploy");
    expect(second.status).toBe(201);
    expect((await second.json() as { nick: string }).nick).toBe("deploy-bitbonsai");
  });

  test("stops at the bot limit", async () => {
    for (const name of ["build", "status", "notify"]) expect((await createBot(name)).status).toBe(201);
    const fourth = await createBot("extra");
    expect(fourth.status).toBe(409);
    expect((await fourth.json() as { error: string }).error).toContain("Bot limit reached");
    expect((await listBots()).used).toBe(3);
  });

  test("rejects reserved names", async () => {
    for (const name of ["remind", "slirc", "help"]) {
      const response = await createBot(name);
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toBe("That name is reserved.");
    }
    expect((await createBot("")).status).toBe(400);
  });

  test("rotates the password and keeps one bot", async () => {
    const created = await (await createBot("deploy")).json() as { password: string };
    const rotated = await app.request("/api/bots/deploy/rotate", { method: "POST", headers: auth() });
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as { nick: string; password: string };
    expect(next.nick).toBe("deploy");
    expect(next.password).toHaveLength(43);
    expect(next.password).not.toBe(created.password);
    const row = db.query("SELECT account_id, irc_password_gen FROM accounts WHERE nick = 'deploy'").get() as { account_id: string; irc_password_gen: number };
    expect(row.irc_password_gen).toBe(1);
    expect(next.password).toBe(ircPasswordFor(row.account_id, 1));
    expect((await listBots()).used).toBe(1);
  });

  test("only an admin can remove a bot; previous owners lose access", async () => {
    expect((await createBot("deploy")).status).toBe(201);
    // Nonadmin (even a former owner) is denied with 403 before any Ergo/DB lookup.
    expect((await app.request("/api/bots/deploy", { method: "DELETE", headers: auth(otherToken) })).status).toBe(403);
    expect((await app.request("/api/bots/deploy/rotate", { method: "POST", headers: auth(otherToken) })).status).toBe(403);

    agentAccounts.setAgentIrcClientFactoryForTests(() => new FakeIrcClient());
    expect((await app.request("/api/bots/deploy", { method: "DELETE", headers: auth() })).status).toBe(204);
    expect(db.query("SELECT 1 FROM accounts WHERE nick = 'deploy'").get()).toBeNull();
    expect((await listBots()).used).toBe(0);
    expect((await app.request("/api/bots/deploy", { method: "DELETE", headers: auth() })).status).toBe(404);
  });
});

describe("admin-only bot management", () => {
  // The mock Ergo helper from fixture is the only Ergo surface; a leak through the gate would
  // show up as a new row in `accounts` (saregister path) or as the password changing. We assert
  // the row stays untouched after each non-admin denial.

  test("POST /api/bots refuses nonadmin before saregister or DB write", async () => {
    const botsBefore = (db.query("SELECT COUNT(*) AS count FROM accounts WHERE kind = 'bot'").get() as { count: number }).count;
    const response = await createBot("deploy", otherToken);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "admin required" });
    expect((db.query("SELECT COUNT(*) AS count FROM accounts WHERE kind = 'bot'").get() as { count: number }).count).toBe(botsBefore);
    expect(db.query("SELECT 1 FROM accounts WHERE nick = 'deploy'").get()).toBeNull();
  });

  test("bot writes refuse cross-site requests before any side effect", async () => {
    expect((await createBot("deploy")).status).toBe(201);
    const passwordBefore = (db.query("SELECT irc_password_gen FROM accounts WHERE nick = 'deploy'").get() as { irc_password_gen: number }).irc_password_gen;
    const forged = [
      { ...auth(), Origin: "https://evil.test" },
      { ...auth(), "X-Slirc-Bots": "" },
      { Cookie: auth().Cookie, Origin: ORIGIN, "X-Slirc-Bots": "1" },
    ];
    for (const headers of forged) {
      const create = await app.request("/api/bots", { method: "POST", headers, body: JSON.stringify({ name: "forged" }) });
      expect(create.status).toBe(403);
      expect(await create.json()).toEqual({ error: "same-origin request required" });
      expect((await app.request("/api/bots/deploy/rotate", { method: "POST", headers })).status).toBe(403);
      expect((await app.request("/api/bots/deploy", { method: "DELETE", headers })).status).toBe(403);
    }
    expect(db.query("SELECT 1 FROM accounts WHERE nick = 'forged'").get()).toBeNull();
    expect(db.query("SELECT nick, irc_password_gen FROM accounts WHERE nick = 'deploy'").get()).toEqual({ nick: "deploy", irc_password_gen: passwordBefore });
  });

  test("GET /api/bots refuses nonadmin", async () => {
    expect((await createBot("deploy")).status).toBe(201);
    const response = await app.request("/api/bots", { headers: auth(otherToken) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "admin required" });
  });

  test("rotate and delete refuse nonadmin before any side effect", async () => {
    expect((await createBot("deploy")).status).toBe(201);
    const passwordBefore = (db.query("SELECT irc_password_gen FROM accounts WHERE nick = 'deploy'").get() as { irc_password_gen: number }).irc_password_gen;
    const rotate = await app.request("/api/bots/deploy/rotate", { method: "POST", headers: auth(otherToken) });
    expect(rotate.status).toBe(403);
    const remove = await app.request("/api/bots/deploy", { method: "DELETE", headers: auth(otherToken) });
    expect(remove.status).toBe(403);
    // Bot row and password unchanged: the deny path never touched Ergo or the DB.
    expect(db.query("SELECT nick, irc_password_gen FROM accounts WHERE nick = 'deploy'").get()).toEqual({ nick: "deploy", irc_password_gen: passwordBefore });
  });

  test("instance helpers (owner NULL) are not in /api/bots and not deletable through it", async () => {
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, provisional_expires_at, created_at)
              VALUES ('remind', 'remind@bots.invalid', 'member', 'bot', NULL, ?, NULL, ?)`)
      .run(Date.now(), Date.now());
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, provisional_expires_at, created_at)
              VALUES ('help', 'help@bots.invalid', 'member', 'bot', NULL, ?, NULL, ?)`)
      .run(Date.now(), Date.now());

    const list = await listBots();
    expect(list.bots.map((bot) => bot.nick).sort()).not.toContain("remind");
    expect(list.bots.map((bot) => bot.nick).sort()).not.toContain("help");

    agentAccounts.setAgentIrcClientFactoryForTests(() => new FakeIrcClient());
    expect((await app.request("/api/bots/remind", { method: "DELETE", headers: auth() })).status).toBe(404);
    expect((await app.request("/api/bots/help", { method: "DELETE", headers: auth() })).status).toBe(404);
    expect((await app.request("/api/bots/remind/rotate", { method: "POST", headers: auth() })).status).toBe(404);

    expect(db.query("SELECT nick FROM accounts WHERE nick = 'remind'").get()).toEqual({ nick: "remind" });
    expect(db.query("SELECT nick FROM accounts WHERE nick = 'help'").get()).toEqual({ nick: "help" });
  });

  test("personal agents (/api/agents) remain owner-scoped, not admin-gated", async () => {
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, machine, verified_at, created_at)
              VALUES ('claude-bitbonsai', 'claude-bitbonsai@bots.invalid', 'member', 'agent', 'bitbonsai', 'mac-mini', ?, ?)`)
      .run(Date.now(), Date.now());
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, machine, verified_at, created_at)
              VALUES ('claude-igor', 'claude-igor@bots.invalid', 'member', 'agent', 'igor', 'laptop', ?, ?)`)
      .run(Date.now(), Date.now());

    const adminAgents = await (await app.request("/api/agents", { headers: auth(ownerToken) })).json() as { nick: string }[];
    const igorAgents = await (await app.request("/api/agents", { headers: auth(otherToken) })).json() as { nick: string }[];
    expect(adminAgents.map((a) => a.nick)).toEqual(["claude-bitbonsai"]);
    expect(igorAgents.map((a) => a.nick)).toEqual(["claude-igor"]);
  });

  test("GET /api/bots used is per-admin, so other admins' bots do not block quota", async () => {
    // A second admin fills their own quota without affecting bitbonsai's.
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at)
              VALUES ('second-admin', 'second@example.com', 'admin', 'human', 'second-admin', ?, ?)`)
      .run(Date.now(), Date.now());
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at)
              VALUES ('bot-alice', 'bot-alice@bots.invalid', 'member', 'bot', 'second-admin', ?, ?)`)
      .run(Date.now(), Date.now());
    db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at)
              VALUES ('bot-bob', 'bot-bob@bots.invalid', 'member', 'bot', 'second-admin', ?, ?)`)
      .run(Date.now(), Date.now());

    // bitbonsai's view: list shows every bot, used counts only their own (zero).
    const listed = await listBots();
    expect(listed.limit).toBe(3);
    expect(listed.used).toBe(0);
    expect(listed.bots.map((bot) => bot.nick).sort()).toEqual(["bot-alice", "bot-bob"]);

    // bitbonsai now creates one — used becomes 1, even though the list still has three rows.
    expect((await createBot("deploy")).status).toBe(201);
    const after = await listBots();
    expect(after.used).toBe(1);
    expect(after.bots).toHaveLength(3);
  });
});
