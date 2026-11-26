import "./fixture.ts";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

// A one-shot oper client: OPER_PERSISTENT=0 makes each grant connect, prove and quit, so the fake
// IRC server only has to answer one connection at a time. Set before importing the server.
process.env.OPER_PERSISTENT = "0";
process.env.ERGO_OPER_PASS = "oper-pass";
process.env.ERGO_HOST = "127.0.0.1";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const { resetRateLimits } = await import("../src/request-security.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function mint(nick: string): string {
  const token = `tok-${nick}-${Math.floor(Math.random() * 1e9)}`;
  db.query("INSERT INTO magic_links (token_hash, nick, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sha(token), nick, Date.now() + 15 * 60_000, Date.now());
  return token;
}

// Answers just enough of the oper grant sequence to provision one secret DM: REGISTER, TRANSFER,
// SAMODEs and the release PING. It records REGISTER lines so a second verify is visible.
function fakeErgo() {
  const registered: string[] = [];
  const owners = new Map<string, string>();
  const masks = new Map<string, Set<string>>();
  const server = Bun.listen<{ buffer: string; nick: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) { socket.data = { buffer: "", nick: "slirc-org" }; },
      data(socket, data) {
        socket.data.buffer += data.toString();
        let end: number;
        while ((end = socket.data.buffer.indexOf("\r\n")) !== -1) {
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          if (line.startsWith("PING ")) { socket.write(`:test PONG test :${line.slice(5)}\r\n`); continue; }
          if (line.startsWith("NICK ")) { socket.data.nick = line.slice(5); continue; }
          const nick = socket.data.nick;
          if (line.startsWith("WHO ")) {
            socket.write(`:test 315 ${nick} ${line.split(" ")[1]} :End of WHO list\r\n`);
          } else if (line.startsWith("MODE ")) {
            socket.write(`:test 324 ${nick} ${line.slice(5)} :+nsi\r\n`);
          } else if (/^SAMODE \S+ \+I$/.test(line)) {
            const channel = line.split(" ")[1]!;
            for (const mask of masks.get(channel) ?? []) socket.write(`:test 346 ${nick} ${channel} ${mask}!*@* oper 1\r\n`);
            socket.write(`:test 347 ${nick} ${channel} :End\r\n`);
          } else if (/^SAMODE \S+ \+I \S+$/.test(line)) {
            const [, channel, , member] = line.split(" ");
            if (!masks.has(channel!)) masks.set(channel!, new Set());
            masks.get(channel!)!.add(member!);
          } else if (line.startsWith("PRIVMSG ChanServ :INFO ")) {
            const channel = line.split(" ").at(-1)!;
            socket.write(`:ChanServ!service@test NOTICE ${nick} :Channel ${channel} is registered\r\n`);
            socket.write(`:ChanServ!service@test NOTICE ${nick} :Founder: ${owners.get(channel)}\r\n`);
          } else if (line === "CAP LS 302") socket.write(":test CAP * LS :sasl\r\n");
          else if (line === "CAP REQ :sasl") socket.write(":test CAP * ACK :sasl\r\n");
          else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
          else if (line.startsWith("AUTHENTICATE ")) socket.write(":test 903 * :Authentication successful\r\n");
          else if (line === "CAP END") socket.write(":test 001 slirc-org :Welcome\r\n");
          else if (line.startsWith("OPER ")) socket.write(":test 381 slirc-org :You are now an IRC operator\r\n");
          else if (line.startsWith("PRIVMSG ChanServ :REGISTER ")) {
            registered.push(line.split(" ").at(-1) || "");
            socket.write(`:ChanServ!service@test NOTICE slirc-org :Channel ${line.split(" ").at(-1)} successfully registered\r\n`);
          } else if (/^PRIVMSG ChanServ :TRANSFER \S+ \S+$/.test(line)) {
            const target = line.split(" ").at(-2);
            socket.write(`:ChanServ!service@test NOTICE slirc-org :To confirm your channel transfer, type: /CS TRANSFER ${target} alice transfer-code\r\n`);
          } else if (/^PRIVMSG ChanServ :TRANSFER \S+ \S+ \S+$/.test(line)) {
            const target = line.split(" ").at(-3);
            owners.set(target!, line.split(" ").at(-2)!);
            socket.write(`:ChanServ!service@test NOTICE slirc-org :Successfully transferred channel ${target} to account alice\r\n`);
          }
        }
      },
    },
  });
  return { server, registered };
}

let fake: ReturnType<typeof fakeErgo> | null = null;
afterEach(() => { fake?.server.stop(true); fake = null; });

function startFake(): ReturnType<typeof fakeErgo> {
  fake = fakeErgo();
  process.env.ERGO_PORT = String(fake.server.port);
  return fake;
}

function account(nick: string, verified: boolean) {
  db.query("INSERT INTO accounts (nick, email, role, kind, owner, verified_at, provisional_expires_at, created_at) VALUES (?, ?, 'member', 'human', NULL, ?, ?, ?)")
    .run(nick, `${nick}@example.com`, verified ? Date.now() : null, Date.now() + 60_000, 1);
}

const verify = (token: string, next = "/") => app.request(`/auth/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`);

beforeEach(() => {
  delete process.env.SLIRC_HELPERS_ENABLED;
  resetRateLimits();
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM magic_links");
  db.exec("DELETE FROM used_magic_links");
  db.exec("DELETE FROM direct_conversations");
  db.exec("DELETE FROM channels");
  db.exec("DELETE FROM channel_members");
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.exec("DELETE FROM meta WHERE key LIKE 'onboarding-pending:%'");
});

test("first verified sign-in with a default return lands in the help DM once it is real", async () => {
  const ergo = startFake();
  account("ana", false);
  const token = mint("ana");
  const response = await verify(token, "/");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/dm/help");
  expect(ergo.registered).toHaveLength(1);
  // The account is stamped and the welcome is pending until the bot flushes; never silently lost.
  expect((db.query("SELECT onboarded_at FROM accounts WHERE nick = 'ana'").get() as { onboarded_at: number }).onboarded_at).toBeGreaterThan(0);
  expect(db.query("SELECT 1 FROM meta WHERE key = 'onboarding-pending:ana'").get()).not.toBeNull();
});

test("a second verification for the same person does not provision again", async () => {
  const ergo = startFake();
  account("ana", false);
  await verify(mint("ana"), "/");
  const second = await verify(mint("ana"), "/");
  expect(second.status).toBe(302);
  expect(second.headers.get("location")).toBe("/");
  expect(ergo.registered).toHaveLength(1);
});

test("an existing verified user is never redirected or re-provisioned", async () => {
  startFake();
  account("ana", true);
  const response = await verify(mint("ana"), "/");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");
});

test("an explicit destination wins over the help DM", async () => {
  startFake();
  account("ana", false);
  const response = await verify(mint("ana"), "/dms");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/dms");
});

test("helpers disabled keeps sign-in working and does not forge a DM", async () => {
  process.env.SLIRC_HELPERS_ENABLED = "false";
  account("ana", false);
  const response = await verify(mint("ana"), "/");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");
  expect((db.query("SELECT verified_at FROM accounts WHERE nick = 'ana'").get() as { verified_at: number }).verified_at).toBeGreaterThan(0);
});

test("an unavailable helper fails safe and keeps the requested destination", async () => {
  account("ana", false);
  // No listener on this port: the oper connect is refused, and sign-in must still complete.
  process.env.ERGO_PORT = "1";
  const response = await verify(mint("ana"), "/");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");
});
