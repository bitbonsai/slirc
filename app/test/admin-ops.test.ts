// Instance admins become IRC channel operators through ChanServ AMODE: which channels qualify, who
// counts as an admin, and the boot backfill over a fake IRC server that answers like ChanServ.

import "./fixture.ts";

process.env.ERGO_OPER_PASS = "oper-pass";
process.env.OPER_PERSISTENT = "0";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
// Loading accounts seeds the owner, bitbonsai, as the first admin.
await import("../src/accounts.ts");
const { adminNicks, adminOpChannels, backfillAdminOps, opAdmins } = await import("../src/admin-ops.ts");

// One fake IRC server per scenario. `amodes` records every ChanServ AMODE the oper asked for;
// `refuse` makes ChanServ answer a channel with an error instead.
function startFakeIrc(refuse = new Set<string>()) {
  const amodes: string[] = [];
  const granted = new Set<string>();
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
          if (line.startsWith("PING ")) socket.write(`:test PONG test :${line.slice(5)}\r\n`);
          else if (line === "CAP LS 302") socket.write(":test CAP * LS :sasl\r\n");
          else if (line.startsWith("CAP REQ")) socket.write(":test CAP * ACK :sasl\r\n");
          else if (line.startsWith("NICK ")) clientNick = line.slice(5);
          else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
          else if (line.startsWith("AUTHENTICATE ")) socket.write(":test 903 * :Authentication successful\r\n");
          else if (line === "CAP END") socket.write(`:test 001 ${clientNick} :Welcome\r\n`);
          else if (line.startsWith("OPER ")) socket.write(`:test 381 ${clientNick} :You are now an IRC operator\r\n`);
          else if (line.startsWith("PRIVMSG ChanServ :AMODE ")) {
            const [channel, mode, nick] = line.slice("PRIVMSG ChanServ :AMODE ".length).split(" ");
            amodes.push(`${channel} ${mode} ${nick}`);
            const key = `${channel} ${nick}`;
            const reply = refuse.has(channel!) ? `Channel ${channel} is not registered`
              : granted.has(key) ? "No changes were made"
              : `Successfully set persistent mode ${mode} on ${nick}`;
            granted.add(key);
            socket.write(`:ChanServ!ChanServ@localhost NOTICE ${clientNick} :${reply}\r\n`);
          }
        }
      },
    },
  });
  return { port: server.port, amodes, close: () => server.stop(true) };
}

beforeAll(() => {
  db.query(`INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES
              ('ada', 'ada@example.com', 'admin', 'human', 1, 1),
              ('ben', 'ben@example.com', 'member', 'human', 1, 1),
              ('cy', 'cy@example.com', 'admin', 'human', NULL, 1),
              ('agentx', 'agentx@example.com', 'admin', 'agent', 1, 1)`).run();
  db.query(`INSERT INTO channels (channel, owner, visibility, created_at, is_group) VALUES
              ('#general', 'ben', 'workspace', 1, 0),
              ('#secret', 'ben', 'secret', 1, 0),
              ('#dm-ben-eve', 'ben', 'direct', 1, 0),
              ('#g-abc', 'ben', 'secret', 1, 1),
              ('#t-chan01', 'ben', 'secret', 1, 0),
              ('#t-open01', 'ben', 'workspace', 1, 0),
              ('#t-dm0001', 'ben', 'secret', 1, 0),
              ('#t-grp001', 'ben', 'secret', 1, 0),
              ('#t-orphan', 'ben', 'secret', 1, 0)`).run();
  const thread = "INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES (?, ?, 'root', 't', '', 'ben', 'root', '', 'ben', 1, 1)";
  db.query(thread).run("#t-chan01", "#secret");
  db.query(thread).run("#t-open01", "#help");
  db.query(thread).run("#t-dm0001", "#dm-ben-eve");
  db.query(thread).run("#t-grp001", "#g-abc");
});

afterAll(() => { delete process.env.ERGO_PORT; });

describe("who and where", () => {
  test("admins are verified human accounts with the admin role", () => {
    expect(adminNicks()).toEqual(["ada", "bitbonsai"]);
  });

  test("channels and their threads qualify; DMs, groups, their threads and orphan thread channels do not", () => {
    const channels = adminOpChannels();
    for (const channel of ["#help", "#support", "#general", "#secret", "#t-chan01", "#t-open01"]) expect(channels).toContain(channel);
    for (const channel of ["#dm-ben-eve", "#g-abc", "#t-dm0001", "#t-grp001", "#t-orphan"]) expect(channels).not.toContain(channel);
  });
});

describe("granting", () => {
  test("a new thread under a channel ops every admin", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      await opAdmins("#t-chan01");
      expect(fake.amodes).toEqual(["#t-chan01 +o ada", "#t-chan01 +o bitbonsai"]);
    } finally {
      fake.close();
    }
  });

  test("a DM thread gets no grant and no IRC traffic", async () => {
    const fake = startFakeIrc();
    process.env.ERGO_PORT = String(fake.port);
    try {
      await opAdmins("#t-dm0001");
      expect(fake.amodes).toEqual([]);
    } finally {
      fake.close();
    }
  });

  test("a refused grant is logged, never thrown, so creation still succeeds", async () => {
    const fake = startFakeIrc(new Set(["#general"]));
    process.env.ERGO_PORT = String(fake.port);
    try {
      await expect(opAdmins("#general")).resolves.toBeUndefined();
    } finally {
      fake.close();
    }
  });

  test("the boot backfill covers every qualifying channel and is safe to run twice", async () => {
    const fake = startFakeIrc(new Set(["#support"]));
    process.env.ERGO_PORT = String(fake.port);
    try {
      const first = await backfillAdminOps();
      const channels = adminOpChannels();
      expect(first.channels).toBe(channels.length);
      expect(first.failed).toBe(1);
      expect(first.firstError).toContain("#support");
      // A channel ChanServ does not know fails fast and the backfill moves on to the next one.
      for (const channel of channels.filter((item) => item !== "#support")) expect(fake.amodes).toContain(`${channel} +o bitbonsai`);
      expect(fake.amodes.some((line) => /^#(dm|g)-|#t-(dm0001|grp001|orphan)/.test(line))).toBe(false);
      const sent = fake.amodes.length;
      const second = await backfillAdminOps();
      expect(second.failed).toBe(1);
      expect(fake.amodes.length).toBe(sent * 2);
    } finally {
      fake.close();
    }
  });
});
