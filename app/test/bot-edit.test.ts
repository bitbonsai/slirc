// Admin edits of bot messages: POST /api/messages/bot-edit over a fake IRC server. The edit must go
// out from the bot's own account as a normal +draft/edit replacement plus REDACT, and never for a
// person's or an agent's message.

import "./fixture.ts";

import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

process.chdir(new URL("..", import.meta.url).pathname);
const ORIGIN = "https://slirc.test";
process.env.APP_ORIGIN = ORIGIN;
process.env.BOT_EDIT_TIMEOUT_MS = "300";

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { canAdminEditBotMessage } = await import("@client/presentation.ts");

const CAPS = "sasl message-tags batch draft/multiline echo-message draft/chathistory server-time account-tag draft/message-redaction";

// `author` is who Ergo's history says wrote each msgid. `lines` records commands after the handshake.
function startFakeIrc(author: Record<string, string>) {
  const lines: string[] = [];
  const saslUsers: string[] = [];
  let nick = "";
  let count = 0;
  const server = Bun.listen<{ buffer: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, data) {
        socket.data.buffer += data.toString();
        let end: number;
        while ((end = socket.data.buffer.indexOf("\r\n")) !== -1) {
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          if (line === "CAP LS 302") socket.write(`:test CAP * LS :${CAPS}\r\n`);
          else if (line.startsWith("CAP REQ")) socket.write(`:test CAP * ACK :${line.slice(9)}\r\n`);
          else if (line.startsWith("NICK ")) nick = line.slice(5);
          else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
          else if (line.startsWith("AUTHENTICATE ")) {
            saslUsers.push(Buffer.from(line.slice(13), "base64").toString().split("\0")[1] || "");
            socket.write(":test 903 * :Authentication successful\r\n");
          } else if (line === "CAP END") socket.write(`:test 001 ${nick} :Welcome\r\n`);
          else if (line.startsWith("USER ") || line.startsWith("QUIT ")) { /* ignore */ }
          else {
            lines.push(line);
            const join = line.match(/^JOIN (\S+)/);
            if (join) socket.write(`:${nick}!u@h JOIN ${join[1]}\r\n`);
            const history = line.match(/^CHATHISTORY AROUND (\S+) msgid=(\S+)/);
            if (history) {
              const by = author[history[2]];
              socket.write(`:test BATCH +h1 chathistory ${history[1]}\r\n`);
              if (by) socket.write(`@batch=h1;msgid=${history[2]};account=${by} :${by}!u@h PRIVMSG ${history[1]} :old\r\n`);
              socket.write(":test BATCH -h1\r\n");
            }
            const send = line.match(/^@(\S+) PRIVMSG (\S+) :/);
            if (send) socket.write(`@${send[1]};msgid=new${++count};account=${nick} :${nick}!u@h PRIVMSG ${send[2]} :${line.slice(line.indexOf(" :") + 2)}\r\n`);
            const opener = line.match(/^@(\S+) BATCH (\+\S+) draft\/multiline (\S+)$/);
            if (opener) socket.write(`@${opener[1]};msgid=new${++count};account=${nick} :${nick}!u@h BATCH ${opener[2]} draft/multiline ${opener[3]}\r\n`);
            const redact = line.match(/^REDACT (\S+) (\S+)/);
            if (redact) socket.write(`:${nick}!u@h REDACT ${redact[1]} ${redact[2]} :edited\r\n`);
          }
        }
      },
    },
  });
  return { port: server.port, lines, saslUsers, close: () => server.stop(true) };
}

const adminToken = "bot-edit-admin";
const memberToken = "bot-edit-member";
const headers = (token = adminToken) => ({ Cookie: `slirc_session=${token}`, Origin: ORIGIN, "Content-Type": "application/json", "X-Slirc-Edit": "1" });
let adminId = "";
let memberId = "";
let fake: ReturnType<typeof startFakeIrc> | null = null;
afterEach(() => { fake?.close(); fake = null; });

beforeAll(() => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?), (?, 'alice', ?)").run(hash(adminToken), Date.now(), hash(memberToken), Date.now());
  db.query(`INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at) VALUES
              ('alice', 'alice@example.com', 'member', 'human', NULL, 1, 1),
              ('poll', 'poll@helpers.invalid', 'member', 'bot', NULL, 1, 1),
              ('jobs', 'jobs@bots.invalid', 'member', 'bot', 'bitbonsai', 1, 1),
              ('claude-alice', 'claude-alice@agents.invalid', 'member', 'agent', 'alice', 1, 1)`).run();
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#room-a', 'bitbonsai', 'workspace', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#room-a', 'bitbonsai'), ('#room-a', 'alice')").run();
  adminId = accountByNick("bitbonsai")!.id;
  memberId = accountByNick("alice")!.id;
});

const edit = (body: Record<string, unknown>, token = adminToken, extra: Record<string, string> = {}) =>
  app.request("/api/messages/bot-edit", { method: "POST", headers: { ...headers(token), ...extra }, body: JSON.stringify({ channel: "#room-a", accountId: token === adminToken ? adminId : memberId, ...body }) });

describe("POST /api/messages/bot-edit", () => {
  test("an admin edits a helper's message as the helper: +draft/edit replacement, then REDACT", async () => {
    fake = startFakeIrc({ m1: "poll" });
    process.env.ERGO_PORT = String(fake.port);
    const response = await edit({ msgid: "m1", bot: "poll", text: "Fixed question?" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, msgid: "new1" });
    expect(fake.saslUsers).toEqual(["poll"]);
    expect(fake.lines.some((line) => /^@\+slirc\/cid=[0-9a-f]+;\+draft\/edit=m1 PRIVMSG #room-a :Fixed question\?$/.test(line))).toBe(true);
    expect(fake.lines).toContain("REDACT #room-a m1 :edited");
  });

  test("a managed bot an admin created can be edited too", async () => {
    fake = startFakeIrc({ m2: "jobs" });
    process.env.ERGO_PORT = String(fake.port);
    const response = await edit({ msgid: "m2", bot: "jobs", text: "line one\nline two" });
    expect(response.status).toBe(200);
    expect(fake.saslUsers).toEqual(["jobs"]);
    expect(fake.lines.some((line) => /;\+draft\/edit=m2 BATCH \+edit-\S+ draft\/multiline #room-a$/.test(line))).toBe(true);
  });

  test("people's and agents' messages are refused before any IRC connection", async () => {
    fake = startFakeIrc({ m3: "alice", m4: "claude-alice" });
    process.env.ERGO_PORT = String(fake.port);
    expect((await edit({ msgid: "m3", bot: "alice", text: "x" })).status).toBe(403);
    expect((await edit({ msgid: "m4", bot: "claude-alice", text: "x" })).status).toBe(403);
    expect(fake.saslUsers).toEqual([]);
  });

  test("naming a bot for a message a person wrote sends nothing", async () => {
    fake = startFakeIrc({ m5: "alice" });
    process.env.ERGO_PORT = String(fake.port);
    expect((await edit({ msgid: "m5", bot: "poll", text: "x" })).status).toBe(403);
    expect(fake.lines.some((line) => line.includes("PRIVMSG") || line.startsWith("REDACT"))).toBe(false);
  });

  test("a message Ergo no longer has is not found", async () => {
    fake = startFakeIrc({});
    process.env.ERGO_PORT = String(fake.port);
    expect((await edit({ msgid: "gone", bot: "poll", text: "x" })).status).toBe(404);
  });

  test("members and cross-site requests are refused", async () => {
    fake = startFakeIrc({ m1: "poll" });
    process.env.ERGO_PORT = String(fake.port);
    expect((await edit({ msgid: "m1", bot: "poll", text: "x" }, memberToken)).status).toBe(403);
    expect((await edit({ msgid: "m1", bot: "poll", text: "x" }, adminToken, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await edit({ msgid: "m1", bot: "poll", text: "x" }, adminToken, { "X-Slirc-Edit": "" })).status).toBe(403);
    expect(fake.saslUsers).toEqual([]);
  });
});

describe("canAdminEditBotMessage", () => {
  const message = (author: string) => ({ authorAccount: author, state: "confirmed", serverId: "m1" });
  const isBot = (nick: string) => nick === "poll";
  test("only admins, only bot authors, only confirmed live messages", () => {
    expect(canAdminEditBotMessage(message("poll"), true, isBot)).toBe(true);
    expect(canAdminEditBotMessage(message("poll"), false, isBot)).toBe(false);
    expect(canAdminEditBotMessage(message("alice"), true, isBot)).toBe(false);
    expect(canAdminEditBotMessage({ ...message("poll"), deleted: true }, true, isBot)).toBe(false);
    expect(canAdminEditBotMessage({ ...message("poll"), state: "sending" }, true, isBot)).toBe(false);
  });
});
