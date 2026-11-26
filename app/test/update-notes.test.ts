import "./fixture.ts";

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { db } = await import("../src/db.ts");
const notes = await import("../src/update-notes.ts");

beforeEach(() => {
  db.query("DELETE FROM meta WHERE key = ?").run(notes.LAST_KEY);
});

describe("instanceFacts", () => {
  test("lists what this instance runs and hides secret channels", () => {
    const saved = { helpers: process.env.SLIRC_HELPERS, agents: process.env.SLIRC_AGENTS_ENABLED };
    process.env.SLIRC_HELPERS = "help,poll,welcome";
    process.env.SLIRC_AGENTS_ENABLED = "false";
    db.query("INSERT OR REPLACE INTO channels (channel, owner, visibility, topic, created_at) VALUES ('#general', 'ada', 'workspace', '', 0)").run();
    db.query("INSERT OR REPLACE INTO channels (channel, owner, visibility, topic, created_at) VALUES ('#hidden', 'ada', 'secret', '', 0)").run();
    try {
      const facts = notes.instanceFacts();
      expect(facts).toContain("- poll helper (runs polls): on");
      expect(facts).toContain("- remind helper (sets reminders): off");
      expect(facts).toContain("- links helper (keeps a library of shared links): off");
      expect(facts).toContain("- coding agents in channels: off");
      expect(facts).toContain("- other bots: none besides the helpers above");
      expect(facts).toMatch(/public channels: .*#general/);
      expect(facts).not.toContain("#hidden");
    } finally {
      db.query("DELETE FROM channels WHERE channel IN ('#general', '#hidden')").run();
      for (const [key, value] of [["SLIRC_HELPERS", saved.helpers], ["SLIRC_AGENTS_ENABLED", saved.agents]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

describe("handNote", () => {
  test("keeps the text as written, minus blank edges and CRs", () => {
    expect(notes.handNote("\n\nWe fixed reconnects.\r\nThreads load faster now.\n\n")).toBe("We fixed reconnects.\nThreads load faster now.");
  });

  test("empty input is an error, not an empty post", () => {
    expect(() => notes.handNote(" \n\t\n")).toThrow("no note on stdin");
  });
});

test("records the last covered commit", () => {
  expect(notes.lastCommit()).toBeNull();
  notes.recordCommit("975eb3ed");
  notes.recordCommit("47977a72");
  expect(notes.lastCommit()).toBe("47977a72");
});

// A bare IRC server: SASL, JOIN and echo-message, enough to prove the post waits for its echo.
function fakeIrc(refuseJoin = false, { store = true, refuseBatch = false } = {}) {
  const lines: string[] = [];
  const stored: string[] = [];
  let open = "";
  let nick = "";
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
          lines.push(line);
          if (line === "CAP LS 302") socket.write(":test CAP * LS :sasl message-tags batch draft/multiline echo-message draft/chathistory server-time\r\n");
          else if (line.startsWith("CAP REQ ")) socket.write(`:test CAP * ACK :${line.slice(8)}\r\n`);
          else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
          else if (line.startsWith("AUTHENTICATE ")) socket.write(":test 903 * :Authentication successful\r\n");
          else if (line === "CAP END") socket.write(`:test 001 ${nick} :Welcome\r\n`);
          else if (line.startsWith("NICK ")) nick = line.slice(5);
          else if (line.startsWith("JOIN ")) socket.write(refuseJoin ? `:test 473 ${nick} ${line.slice(5)} :Cannot join channel (+i)\r\n` : `:${nick}!u@h JOIN ${line.slice(5)}\r\n`);
          else if (line.startsWith("BATCH +")) { open = line.split(" ")[1]!.slice(1); if (refuseBatch) socket.write(":test FAIL BATCH MULTILINE_INVALID :Invalid multiline batch\r\n"); else socket.write(`@msgid=ml1 :${nick}!u@h ${line}\r\n`); if (store && !refuseBatch) stored.push("ml1"); }
          else if (line.startsWith("BATCH -")) { if (!refuseBatch) socket.write(`:${nick}!u@h ${line}\r\n`); open = ""; }
          else if (/^(@\S+ )?PRIVMSG /.test(line)) {
            if (refuseBatch) continue;
            const id = open ? "" : `m${lines.length}`;
            if (id && store) stored.push(id);
            socket.write(`${id ? `@msgid=${id} ` : `@batch=${open} `}:${nick}!u@h ${line.replace(/^@\S+ /, "")}\r\n`);
          } else if (line.startsWith("CHATHISTORY ")) {
            const channel = line.split(" ")[2];
            socket.write(`:test BATCH +h chathistory ${channel}\r\n`);
            for (const id of stored) socket.write(`@batch=h;msgid=${id} :${nick}!u@h PRIVMSG ${channel} :x\r\n`);
            socket.write(":test BATCH -h\r\n");
          }
        }
      },
    },
  });
  return { lines, port: server.port, stop: () => server.stop(true) };
}

describe("postNote", () => {
  test("joins, posts each line and leaves after the echo", async () => {
    const irc = fakeIrc();
    process.env.ERGO_PORT = String(irc.port);
    try {
      await notes.postNote("#open-chat", "We made the connect code easier to copy.\nOld messages now clear on every device.", 5_000);
      for (let i = 0; i < 50 && !irc.lines.includes("QUIT :bye"); i++) await Bun.sleep(10);
      expect(irc.lines).toContain("NS SET ALWAYS-ON false");
      expect(irc.lines).toContain("JOIN #open-chat");
      // Two lines go as one multiline batch, so the app shows one message.
      expect(irc.lines.some((line) => /^BATCH \+\S+ draft\/multiline #open-chat$/.test(line))).toBe(true);
      expect(irc.lines.some((line) => line.endsWith(" PRIVMSG #open-chat :We made the connect code easier to copy."))).toBe(true);
      expect(irc.lines.some((line) => line.endsWith(" PRIVMSG #open-chat :Old messages now clear on every device."))).toBe(true);
      expect(irc.lines).toContain("PART #open-chat");
      const row = db.query("SELECT kind, owner FROM accounts WHERE nick = 'updates'").get() as { kind: string; owner: string | null };
      expect(row).toEqual({ kind: "bot", owner: null });
    } finally {
      irc.stop();
    }
  });

  test("a long hand-written line goes in parts the reader joins again", async () => {
    const irc = fakeIrc();
    process.env.ERGO_PORT = String(irc.port);
    try {
      await notes.postNote("#open-chat", "word ".repeat(120).trim(), 5_000);
      const sent = irc.lines.filter((line) => line.includes(" PRIVMSG #open-chat :"));
      expect(sent.length).toBeGreaterThan(1);
      expect(sent.slice(1).every((line) => line.includes(";draft/multiline-concat "))).toBe(true);
      expect(sent.every((line) => line.replace(/^@\S+ /, "").length < 400)).toBe(true);
    } finally {
      irc.stop();
    }
  });

  test("an echoed note that history did not keep is an error", async () => {
    const irc = fakeIrc(false, { store: false });
    process.env.ERGO_PORT = String(irc.port);
    try {
      await expect(notes.postNote("#open-chat", "Line one.\nLine two.", 5_000)).rejects.toThrow("not in #open-chat's history");
    } finally {
      irc.stop();
    }
  });

  test("Ergo refusing the batch fails at once with its reason", async () => {
    const irc = fakeIrc(false, { refuseBatch: true });
    process.env.ERGO_PORT = String(irc.port);
    try {
      await expect(notes.postNote("#open-chat", "Line one.\nLine two.", 5_000)).rejects.toThrow("MULTILINE_INVALID");
    } finally {
      irc.stop();
    }
  });

  test("a refused join fails without posting", async () => {
    const irc = fakeIrc(true);
    process.env.ERGO_PORT = String(irc.port);
    try {
      await expect(notes.postNote("#open-chat", "Hello", 5_000)).rejects.toThrow("could not join");
      expect(irc.lines.some((line) => line.includes("PRIVMSG"))).toBe(false);
    } finally {
      irc.stop();
    }
  });

  test("serializes concurrent postNote calls so bursts do not collide on the updates nick", async () => {
    const irc = fakeIrc();
    process.env.ERGO_PORT = String(irc.port);
    try {
      await Promise.all([
        notes.postNote("#open-chat", "First update", 5_000),
        notes.postNote("#open-chat", "Second update", 5_000),
      ]);
      const firstPrivmsg = irc.lines.findIndex((line) => line.includes("PRIVMSG #open-chat :First update"));
      const firstPart = irc.lines.findIndex((line, i) => i > firstPrivmsg && line === "PART #open-chat");
      const secondJoin = irc.lines.findIndex((line, i) => i > firstPrivmsg && line === "JOIN #open-chat");
      expect(firstPrivmsg).toBeGreaterThan(-1);
      expect(firstPart).toBeGreaterThan(firstPrivmsg);
      expect(secondJoin).toBeGreaterThan(firstPart);
    } finally {
      irc.stop();
    }
  });
});

describe("update-note CLI", () => {
  const runCli = async (args: string[], { stdin = "", dbPath, env = {} }: { stdin?: string; dbPath: string; env?: Record<string, string> }) => {
    const proc = Bun.spawn([process.execPath, "scripts/update-note.ts", ...args], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, DB_PATH: dbPath, ...env },
      stdin: new Response(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  };

  test("supports last, record, facts, say --dry-run, and rejects post", async () => {
    const dbPath = `${mkdtempSync(join(tmpdir(), "update-note-cli-"))}/chat.sqlite`;

    const initial = await runCli(["last"], { dbPath });
    expect(initial.code).toBe(0);
    expect(initial.out.trim()).toBe("");

    const rec = await runCli(["record", "--to", "47977a72abcd"], { dbPath });
    expect(rec.code).toBe(0);
    expect(rec.out).toContain("recorded 47977a72 as covered");

    const after = await runCli(["last"], { dbPath });
    expect(after.code).toBe(0);
    expect(after.out.trim()).toBe("47977a72abcd");

    const facts = await runCli(["facts"], { dbPath, env: { SLIRC_HELPERS: "help,poll", SLIRC_AGENTS_ENABLED: "false" } });
    expect(facts.code).toBe(0);
    expect(facts.out).toContain("- poll helper (runs polls): on");
    expect(facts.out).toContain("- remind helper (sets reminders): off");
    expect(facts.out).toContain("- coding agents in channels: off");

    const dry = await runCli(["say", "--dry-run"], { dbPath, stdin: "\nWe fixed reconnects.\r\n\n" });
    expect(dry.code).toBe(0);
    expect(dry.out).toBe("We fixed reconnects.\n");

    const removed = await runCli(["post", "--to", "47977a72"], { dbPath, stdin: "abc123 change" });
    expect(removed.code).toBe(2);
    expect(removed.err).toContain("usage: bun scripts/update-note.ts last | facts | say [--dry-run] < note | record --to <sha>");
  });
});
