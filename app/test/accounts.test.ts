import "./fixture.ts";

// The owner is "bitbonsai" (from the fixture). Another person's account sits under "mauricio",
// the founder's first nick: owner setup once merged that nick into the owner on every start,
// which deleted the account and handed its sessions to the admin.
process.env.USERS_JSON = JSON.stringify({ bitbonsai: "owner@example.com" });

import { describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('bitbonsai', 'old@example.com', 'member', 1, 1)").run();
db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('mauricio', 'someone@example.com', 'member', 1, 1)").run();
db.query("INSERT INTO profiles (account, full_name) VALUES ('mauricio', 'Someone else')").run();
db.query("INSERT INTO channel_members (channel, nick) VALUES ('#private', 'mauricio')").run();
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES ('member-session', 'mauricio', 1)").run();
const accounts = await import("../src/accounts.ts");

describe("accounts", () => {
  test("signup registers the password derived from the id it then stores, and stores no password", async () => {
    const { ircPasswordFor } = await import("../src/irc-key.ts");
    const old = process.env.ERGO_API_MOCK;
    const registered: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    process.env.ERGO_API_MOCK = "false";
    process.env.ERGO_API_TOKEN = "t";
    globalThis.fetch = (async (_url: string, init: RequestInit) => { registered.push(JSON.parse(String(init.body))); return Response.json({ success: true }); }) as typeof fetch;
    try {
      const created = await accounts.provisionAccount("Derived Person", "derived@example.test");
      const row = db.query("SELECT account_id, irc_password_gen FROM accounts WHERE nick = ?").get(created.nick) as any;
      expect(row.irc_password_gen).toBe(0);
      expect(registered).toEqual([{ accountName: created.nick, passphrase: ircPasswordFor(row.account_id, 0) }]);
      expect(created.ircPassword).toBe(ircPasswordFor(row.account_id, 0));
    } finally {
      globalThis.fetch = realFetch;
      process.env.ERGO_API_MOCK = old;
      delete process.env.ERGO_API_TOKEN;
    }
  });

  test("owner setup makes the owner admin and leaves every other account alone", () => {
    const { ircPasswordFor } = require("../src/irc-key.ts");
    const owner = accounts.accountByNick("bitbonsai")!;
    expect(owner).toEqual(expect.objectContaining({ email: "owner@example.com", role: "admin" }));
    expect(owner.ircPassword).toBe(ircPasswordFor(owner.id, 0));
    expect(accounts.accountByNick("mauricio")).toEqual(expect.objectContaining({ email: "someone@example.com", role: "member" }));
    expect(db.query("SELECT full_name FROM profiles WHERE account = 'mauricio'").get()).toEqual({ full_name: "Someone else" });
    expect(db.query("SELECT nick FROM channel_members WHERE channel = '#private'").get()).toEqual({ nick: "mauricio" });
    expect(db.query("SELECT nick FROM sessions WHERE token_hash = 'member-session'").get()).toEqual({ nick: "mauricio" });
  });

  test("cache identity survives nick changes but not account recreation", () => {
    const insert = db.query("INSERT INTO accounts (nick, email, verified_at, created_at) VALUES (?, 'cache@example.test', 1, 1)");
    insert.run("cache-old");
    const id = accounts.accountByNick("cache-old")!.id;
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    db.query("UPDATE accounts SET nick = 'cache-new' WHERE nick = 'cache-old'").run();
    expect(accounts.accountByNick("cache-new")!.id).toBe(id);
    db.query("DELETE FROM accounts WHERE nick = 'cache-new'").run();
    insert.run("cache-new");
    expect(accounts.accountByNick("cache-new")!.id).not.toBe(id);
    db.query("DELETE FROM accounts WHERE nick = 'cache-new'").run();
  });

  test("derives IRC-safe account names", () => {
    expect(accounts.accountNick("João da Silva")).toBe("joaodasilva");
    expect(accounts.accountNick("123 !!!")).toBe("member");
  });

  test("creates unverified accounts and avoids nickname collisions", async () => {
    const first = await accounts.provisionAccount("Ana Lima", "ana@example.com");
    const second = await accounts.provisionAccount("Ana Lima", "other@example.com");
    expect(first).toEqual(expect.objectContaining({ nick: "analima", verifiedAt: null, role: "member" }));
    expect(second.nick).toBe("analima2");
  });

  test("rejects one-character email suffixes", async () => {
    await expect(accounts.provisionAccount("Test User", "g@g.m")).rejects.toThrow("valid email");
  });

  test("expires provisional accounts after 24 hours", async () => {
    const account = await accounts.provisionAccount("Short Visit", "short@example.com");
    db.query("UPDATE accounts SET provisional_expires_at = ? WHERE nick = ?").run(Date.now() - 1, account.nick);
    expect(accounts.accountByNick(account.nick)).toBeNull();
    expect(accounts.accountByEmail(account.email)).toBeNull();
  });

  // Integration fix: a browser tab opened during the first (now-expired) provisional window
  // keeps a live relay socket for the old nick/token; re-signing up with the same email must
  // close that socket before the old account row (and its session) disappear underneath it.
  test("closes a live relay socket before reusing an expired provisional account's email", async () => {
    const { openSocketCount, trackSocket } = await import("../src/relay.ts");
    const first = await accounts.provisionAccount("Renew Me", "renew@example.com");
    db.query("UPDATE accounts SET provisional_expires_at = ? WHERE nick = ?").run(Date.now() - 1, first.nick);
    const tokenHash = "renew-session-hash";
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(tokenHash, first.nick, Date.now());
    let closed = false;
    trackSocket(tokenHash, { close: () => { closed = true; } } as any);
    await accounts.provisionAccount("Renew Me Again", "renew@example.com");
    expect(closed).toBe(true);
    expect(openSocketCount()).toBe(0);
  });
});
