// Server-enforced native moderation delete: the grants helper over a fake IRC socket, and the
// POST /api/messages/redact HTTP matrix. No live IRC, no real Ergo: the fake answers the capability
// handshake, OPER, the MODE existence probe, SAJOIN, and the REDACT echo/FAIL itself.

import "./fixture.ts";

process.env.ERGO_OPER_USER = "slirc-org";
process.env.ERGO_OPER_PASS = "oper-pass";
process.env.OPER_PERSISTENT = "0";
process.env.REDACT_TIMEOUT_MS = "150";

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { redactMessage, NotAuthorizedError } = await import("../src/grants.ts");
const { app } = await import("../src/server.ts");
const { accountByNick } = await import("../src/accounts.ts");

type Behavior = { missing?: Set<string>; redact?: (channel: string, msgid: string) => "ack" | "fail" | "gone" | "silent" };

// One fake IRC server per scenario. `lines` records every post-handshake command it received.
function startFakeIrc(behavior: Behavior = {}) {
  const lines: string[] = [];
  let clientNick = "";
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
          if (line.startsWith("PING ")) { socket.write(`:test PONG test :${line.slice(5)}\r\n`); continue; }
          if (line === "CAP LS 302") socket.write(":test CAP * LS :sasl draft/message-redaction\r\n");
          else if (line.startsWith("CAP REQ")) socket.write(":test CAP * ACK :sasl draft/message-redaction\r\n");
          else if (line.startsWith("NICK ")) clientNick = line.slice(5);
          else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
          else if (line.startsWith("AUTHENTICATE ")) socket.write(":test 903 * :Authentication successful\r\n");
          else if (line === "CAP END") socket.write(`:test 001 ${clientNick} :Welcome\r\n`);
          else if (line.startsWith("USER ")) { /* ignore */ }
          else if (line.startsWith("OPER ")) {
            lines.push(line);
            socket.write(`:test 381 ${clientNick} :You are now an IRC operator\r\n`);
          } else if (line.startsWith("MODE ")) {
            lines.push(line);
            const channel = line.split(" ")[1];
            if (behavior.missing?.has(channel)) socket.write(`:test 403 ${clientNick} ${channel} :No such channel\r\n`);
            else socket.write(`:test 324 ${clientNick} ${channel} +nt\r\n`);
          } else if (line.startsWith("SAJOIN ")) {
            lines.push(line);
            socket.write(`:${clientNick}!u@h JOIN ${line.split(" ")[2]}\r\n`);
          } else if (line.startsWith("SAMODE ")) {
            lines.push(line);
          } else if (line.includes("REDACT ")) {
            lines.push(line);
            const match = line.match(/REDACT (\S+) (\S+)/);
            const channel = match?.[1] || "";
            const msgid = match?.[2] || "";
            const outcome = behavior.redact ? behavior.redact(channel, msgid) : "ack";
            if (outcome === "ack") socket.write(`@msgid=rd;time=2026-01-01T00:00:00.000Z;account=slirc-org :${clientNick}!u@h REDACT ${channel} ${msgid}\r\n`);
            else if (outcome === "fail") socket.write(`:test FAIL REDACT REDACT_FORBIDDEN ${channel} ${msgid} :You are not authorized to delete this message\r\n`);
            else if (outcome === "gone") socket.write(`:test FAIL REDACT UNKNOWN_MSGID ${channel} ${msgid} :This message does not exist or is too old\r\n`);
            // "silent" leaves the client waiting for the timeout.
          }
        }
      },
    },
  });
  return { port: server.port, lines, close: () => server.stop(true) };
}

const token = "redact-admin-session";
const memberToken = "redact-member-session";
const auth = (value = token) => ({ Cookie: `slirc_session=${value}`, "Content-Type": "application/json" });

let adminId = "";
let aliceId = "";

beforeAll(() => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?), (?, 'alice', ?)")
    .run(hash(token), Date.now(), hash(memberToken), Date.now());
  db.query(`INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES
              ('alice', 'alice@example.com', 'member', 'human', 1, 1),
              ('dave', 'dave@example.com', 'member', 'human', 1, 1),
              ('eve', 'eve@example.com', 'member', 'human', 1, 1),
              ('frank', 'frank@example.com', 'member', 'human', 1, 1)`).run();
  db.query(`INSERT INTO channels (channel, owner, visibility, created_at) VALUES
              ('#room-a', 'bitbonsai', 'workspace', 1),
              ('#room-b', 'alice', 'workspace', 1),
              ('#t-thread1', 'bitbonsai', 'workspace', 1),
              ('#t-thread2', 'alice', 'workspace', 1),
              ('#dm-eve-frank', 'eve', 'direct', 1)`).run();
  db.query(`INSERT INTO channel_members (channel, nick) VALUES
              ('#room-a', 'bitbonsai'), ('#room-a', 'alice'),
              ('#room-b', 'alice'),
              ('#t-thread1', 'bitbonsai'),
              ('#t-thread2', 'bitbonsai'),
              ('#dm-eve-frank', 'eve'), ('#dm-eve-frank', 'frank')`).run();
  db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick) VALUES ('#dm-eve-frank', 'eve', 'frank')").run();
  const thread = "INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES (?, ?, 'root', 't', '', 'bitbonsai', 'root', '', 'bitbonsai', 1, 1)";
  db.query(thread).run("#t-thread1", "#room-a");
  db.query(thread).run("#t-thread2", "#room-b");
  adminId = accountByNick("bitbonsai")!.id;
  aliceId = accountByNick("alice")!.id;
});

describe("redactMessage helper (fake IRC)", () => {
  test("resolves only after Ergo echoes the exact channel and msgid", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      await redactMessage("#room-a", "m1");
      expect(fake.lines).toContain("REDACT #room-a m1");
      expect(fake.lines).toContain("MODE #room-a");
      expect(fake.lines.some((line) => line.startsWith("SAJOIN "))).toBe(true);
    } finally {
      fake.close();
    }
  });

  test("rejects a FAIL without claiming success", async () => {
    const fake = startFakeIrc({ redact: () => "fail" });
    process.env.ERGO_PORT = String(fake.port);
    try {
      await expect(redactMessage("#room-a", "m1")).rejects.toThrow(/REDACT/);
    } finally {
      fake.close();
    }
  });

  test("resolves gone when Ergo no longer has the message", async () => {
    const fake = startFakeIrc({ redact: () => "gone" });
    process.env.ERGO_PORT = String(fake.port);
    try {
      expect(await redactMessage("#room-a", "m1")).toBe("gone");
    } finally {
      fake.close();
    }
  });

  test("rejects a silent REDACT after the timeout window", async () => {
    const fake = startFakeIrc({ redact: () => "silent" });
    process.env.ERGO_PORT = String(fake.port);
    try {
      await expect(redactMessage("#room-a", "m1")).rejects.toThrow(/not confirmed/);
    } finally {
      fake.close();
    }
  });

  test("never SAJOINs a channel Ergo does not have", async () => {
    const fake = startFakeIrc({ missing: new Set(["#room-a"]) });
    process.env.ERGO_PORT = String(fake.port);
    try {
      await expect(redactMessage("#room-a", "m1")).rejects.toThrow(/does not exist/);
      expect(fake.lines.some((line) => line.startsWith("SAJOIN "))).toBe(false);
    } finally {
      fake.close();
    }
  });

  test("a revoked guard stops the REDACT before it is sent", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      await expect(redactMessage("#room-a", "m1", undefined, () => false)).rejects.toBeInstanceOf(NotAuthorizedError);
      expect(fake.lines.some((line) => line.includes("REDACT "))).toBe(false);
    } finally {
      fake.close();
    }
  });
});

describe("POST /api/messages/redact", () => {
  test("admin deletes another author's message in a readable room", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#room-a", msgid: "m1", accountId: adminId }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(fake.lines).toContain("REDACT #room-a m1");
    } finally {
      fake.close();
    }
  });

  test("a message Ergo no longer has answers ok with gone, not an error", async () => {
    const fake = startFakeIrc({ redact: () => "gone" });
    process.env.ERGO_PORT = String(fake.port);
    try {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#room-a", msgid: "m1", accountId: adminId }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, gone: true });
    } finally {
      fake.close();
    }
  });

  test("an optional correlation id rides the native REDACT as a client tag", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#room-a", msgid: "m2", accountId: adminId, clientId: "corr-1" }) });
      expect(response.status).toBe(200);
      expect(fake.lines).toContain("@+slirc/cid=corr-1 REDACT #room-a m2");
    } finally {
      fake.close();
    }
  });

  test("admins may moderate a configured open channel that has no channels row", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#help", msgid: "m9", accountId: adminId }) });
      expect(response.status).toBe(200);
      expect(fake.lines).toContain("REDACT #help m9");
    } finally {
      fake.close();
    }
  });

  test("admins may moderate a thread they can read", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#t-thread1", msgid: "m3", accountId: adminId }) });
      expect(response.status).toBe(200);
      expect(fake.lines).toContain("REDACT #t-thread1 m3");
    } finally {
      fake.close();
    }
  });

  test("a member is refused with no IRC command at all", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(memberToken), body: JSON.stringify({ channel: "#room-a", msgid: "m1", accountId: aliceId }) });
      expect(response.status).toBe(403);
      expect(fake.lines).toEqual([]);
    } finally {
      fake.close();
    }
  });

  test("missing auth is 401", async () => {
    const response = await app.request("/api/messages/redact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: "#room-a", msgid: "m1", accountId: adminId }) });
    expect(response.status).toBe(401);
  });

  test("a stale account id is 409, not a delete", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#room-a", msgid: "m1", accountId: aliceId }) });
      expect(response.status).toBe(409);
      expect(fake.lines).toEqual([]);
    } finally {
      fake.close();
    }
  });

  test("a DM the admin is not part of is not readable, even for an admin", async () => {
    const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#dm-eve-frank", msgid: "m1", accountId: adminId }) });
    expect(response.status).toBe(404);
  });

  test("a thread whose parent the admin cannot read is refused", async () => {
    const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#t-thread2", msgid: "m1", accountId: adminId }) });
    expect(response.status).toBe(404);
  });

  test("malformed and injection-shaped identifiers are 400", async () => {
    for (const body of [
      { channel: "#room-a", msgid: "m1;DROP", accountId: adminId },
      { channel: "#room-a", msgid: "m1", accountId: adminId, clientId: "x;y" },
      { channel: "#room-a\r\nOPER evil", msgid: "m1", accountId: adminId },
      { channel: "#room-a", accountId: adminId },
      { channel: "#room-a", msgid: "m1" },
    ]) {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
  });

  test("the request body is bounded", async () => {
    const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: `#${"a".repeat(8000)}`, msgid: "m1", accountId: adminId }) });
    expect(response.status).toBe(413);
  });

  test("an Ergo refusal is an honest 500, not a success", async () => {
    const fake = startFakeIrc({ redact: () => "fail" });
    process.env.ERGO_PORT = String(fake.port);
    try {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#room-a", msgid: "m1", accountId: adminId }) });
      expect(response.status).toBe(500);
      expect((await response.json()).ok).toBeUndefined();
    } finally {
      fake.close();
    }
  });

  test("a REDACT timeout is an honest 500, not a success", async () => {
    const fake = startFakeIrc({ redact: () => "silent" });
    process.env.ERGO_PORT = String(fake.port);
    try {
      const response = await app.request("/api/messages/redact", { method: "POST", headers: auth(), body: JSON.stringify({ channel: "#room-a", msgid: "m1", accountId: adminId }) });
      expect(response.status).toBe(500);
      expect((await response.json()).ok).toBeUndefined();
    } finally {
      fake.close();
    }
  });
});

afterAll(() => {
  db.close();
});
