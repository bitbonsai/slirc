// Wire-level tests for the shared channel-history clearer. A real IrcClient runs against a fake
// IRC server, so this covers the exact operator sequence and channel targeting, not just wiring.
import { expect, test } from "bun:test";
import { IrcClient } from "../src/irc.ts";

const CAPS = "sasl batch draft/chathistory message-tags server-time draft/event-playback echo-message";
const user = "slirc-org";
process.env.ERGO_OPER_USER = user;
process.env.ERGO_OPER_PASS = "oper-pass";
const grants = await import("../src/grants.ts");
const history = await import("../src/history.ts");

interface ServerState {
  nick: string;
  lines: string[];
  pages: Map<string, HistoryRow[]>;
}

// `event` replaces the default PRIVMSG, e.g. "NICK :newnick" or "QUIT :bye", as Ergo replays
// stored events under draft/event-playback.
type HistoryRow = { msgid: string; time: string; event?: string };

function startServer(pages: Record<string, HistoryRow[]> = {}): { port: number; lines: string[]; stop: () => void } {
  const state: ServerState = { nick: "", lines: [], pages: new Map(Object.entries(pages)) };
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
          state.lines.push(line);
          if (line === "CAP LS 302") { socket.write(`:test CAP * LS :${CAPS}\r\n`); continue; }
          if (line.startsWith("CAP REQ ")) { socket.write(`:test CAP * ACK :${line.slice(8)}\r\n`); continue; }
          if (line === "AUTHENTICATE PLAIN") { socket.write("AUTHENTICATE +\r\n"); continue; }
          if (line.startsWith("AUTHENTICATE ")) { socket.write(":test 903 * :Authentication successful\r\n"); continue; }
          if (line === "CAP END") { socket.write(`:test 001 ${state.nick} :Welcome\r\n`); continue; }
          if (line.startsWith("NICK ")) { state.nick = line.slice(5); continue; }
          if (line.startsWith("USER ")) continue;
          if (line === `OPER ${user} oper-pass`) { socket.write(`:test 381 ${state.nick} :You are now an IRC operator\r\n`); continue; }
          if (/^NS (SET|SASET \S+) ALWAYS-ON false$/.test(line)) continue;
          if (line.startsWith("SAJOIN ")) {
            const channel = line.split(" ").at(-1)!;
            socket.write(`:${state.nick}!u@h JOIN ${channel}\r\n`);
            continue;
          }
          if (line.startsWith("CHATHISTORY BEFORE ")) {
            const [, , channel, before, count] = line.split(" ");
            const all = state.pages.get(channel) || [];
            // Newest-first, honoring the timestamp cursor and page size for the test.
            const after = before === "*" ? all : all.filter((m) => m.time < before.slice("timestamp=".length));
            const page = after.slice(0, Number(count));
            const id = `b${state.lines.length}`;
            socket.write(`@batch=${id} :test BATCH +${id} chathistory ${channel}\r\n`);
            for (const m of page) socket.write(`@batch=${id};msgid=${m.msgid};time=${m.time} :peer!u@h ${m.event ?? `PRIVMSG ${channel} :hi`}\r\n`);
            socket.write(`:test BATCH -${id}\r\n`);
            continue;
          }
          if (line.startsWith("PART ")) {
            const channel = line.split(" ")[1];
            socket.write(`@msgid=part1 :${state.nick}!u@h PART ${channel}\r\n`);
            continue;
          }
          if (line.startsWith("PRIVMSG HistServ :DELETE ")) {
            const channel = line.split(" ")[3];
            socket.write(`:HistServ!HistServ@localhost NOTICE ${state.nick} :Successfully deleted message\r\n`);
            // Record only the target so a wrong-channel delete is visible.
            state.lines.push(`DELETE-TARGET ${channel}`);
            continue;
          }
          if (line === "QUIT :bye") continue;
        }
      },
    },
  });
  return { port: server.port, lines: state.lines, stop: () => server.stop(true) };
}

test("purge clears one channel end to end: oper, join, paged CHATHISTORY, per-msgid DELETE, part", async () => {
  const server = startServer({ "#dm-a-b": [{ msgid: "m2", time: "2026-01-01T00:00:02Z" }, { msgid: "m1", time: "2026-01-01T00:00:01Z" }] });
  process.env.ERGO_HOST = "127.0.0.1";
  process.env.ERGO_PORT = String(server.port);
  let result: Awaited<ReturnType<typeof grants.purgeChannelHistory>> | null = null;
  try {
    result = await grants.purgeChannelHistory("#dm-a-b");
    await Bun.sleep(25);
  } finally {
    server.stop();
  }
  expect(result).toMatchObject({ channel: "#dm-a-b", scanned: 2, deleted: 3, failed: 0, partial: false });
  const ops = server.lines.map((line) => line.replaceAll(/slirc-org-[0-9a-f]{6}/g, "<oper>"));
  expect(ops).toContain("SAJOIN <oper> #dm-a-b");
  expect(ops.some((line) => line.startsWith("CHATHISTORY BEFORE #dm-a-b * "))).toBe(true);
  expect(ops).toContain("PRIVMSG HistServ :DELETE #dm-a-b m2");
  expect(ops).toContain("PRIVMSG HistServ :DELETE #dm-a-b m1");
  expect(ops).toContain("DELETE-TARGET #dm-a-b");
  expect(ops).toContain("PART #dm-a-b");
  expect(ops).toContain("PRIVMSG HistServ :DELETE #dm-a-b part1");
  expect(ops.every((line) => !line.includes("#other"))).toBe(true);
});

test("clear paginates with the BEFORE cursor and never targets another channel", async () => {
  const server = startServer({
    "#big": [
      { msgid: "m4", time: "2026-01-01T00:00:04Z" },
      { msgid: "m3", time: "2026-01-01T00:00:03Z" },
      { msgid: "m2", time: "2026-01-01T00:00:02Z" },
    ],
    "#other": [{ msgid: "x1", time: "2026-01-01T00:00:01Z" }],
  });
  let result: Awaited<ReturnType<typeof history.clearChannelHistory>> | null = null;
  const client = new IrcClient({ host: "127.0.0.1", port: server.port, nick: "plain", capabilities: ["batch", "draft/chathistory", "message-tags", "server-time"] });
  try {
    await client.connect();
    await history.joinHistoryChannel(client, "#big");
    result = await history.clearChannelHistory(client, "#big", { pageSize: 2, pageTimeoutMs: 1_000, deleteTimeoutMs: 1_000 });
  } finally {
    client.quit();
    server.stop();
  }
  expect(result).toMatchObject({ scanned: 3, deleted: 3, failed: 0, partial: false });
  const chats = server.lines.filter((line) => line.startsWith("CHATHISTORY BEFORE #big "));
  expect(chats).toHaveLength(2);
  expect(chats[0]).toContain(" * 2");
  expect(chats[1]).toContain("timestamp=2026-01-01T00:00:03Z 2");
  const deletes = server.lines.filter((line) => line.startsWith("DELETE-TARGET "));
  expect(deletes).toEqual(["DELETE-TARGET #big", "DELETE-TARGET #big", "DELETE-TARGET #big"]);
  expect(server.lines.some((line) => line.includes("#other"))).toBe(false);
});

test("reaching the page cap reports an incomplete purge", async () => {
  const server = startServer({ "#cap": [
    { msgid: "m2", time: "2026-01-01T00:00:02Z" },
    { msgid: "m1", time: "2026-01-01T00:00:01Z" },
  ] });
  const client = new IrcClient({ host: "127.0.0.1", port: server.port, nick: "cap", capabilities: ["batch", "draft/chathistory", "message-tags", "server-time"] });
  let result: Awaited<ReturnType<typeof history.clearChannelHistory>> | null = null;
  try {
    await client.connect();
    await history.joinHistoryChannel(client, "#cap");
    result = await history.clearChannelHistory(client, "#cap", { pageSize: 1, maxPages: 1, pageTimeoutMs: 1_000, deleteTimeoutMs: 1_000 });
  } finally {
    client.quit();
    server.stop();
  }
  expect(result).toMatchObject({ scanned: 1, deleted: 1, partial: true });
});

test("event-playback msgids are stripped to the stored id before DELETE", async () => {
  const server = startServer({ "#ev": [{ msgid: "_real1", time: "2026-01-01T00:00:01Z" }] });
  const client = new IrcClient({ host: "127.0.0.1", port: server.port, nick: "plain2", capabilities: ["batch", "draft/chathistory", "message-tags", "server-time"] });
  let result: Awaited<ReturnType<typeof history.clearChannelHistory>> | null = null;
  try {
    await client.connect();
    await history.joinHistoryChannel(client, "#ev");
    result = await history.clearChannelHistory(client, "#ev", { pageTimeoutMs: 1_000, deleteTimeoutMs: 1_000 });
    await Bun.sleep(25);
  } finally {
    client.quit();
    server.stop();
  }
  expect(result).toMatchObject({ scanned: 1, deleted: 1, failed: 0, partial: false });
  expect(history.storedHistoryMsgid("_real1")).toBe("real1");
  expect(history.storedHistoryMsgid("real1")).toBe("real1");
  expect(server.lines).toContain("PRIVMSG HistServ :DELETE #ev real1");
});

test("purge leaves NICK and QUIT rows, whose msgid other channels share", async () => {
  const server = startServer({ "#t-abc123": [
    { msgid: "quit1", time: "2026-01-01T00:00:04Z", event: "QUIT :Quit: bye" },
    { msgid: "m2", time: "2026-01-01T00:00:03Z" },
    { msgid: "nick1", time: "2026-01-01T00:00:02Z", event: "NICK :peer2" },
    { msgid: "m1", time: "2026-01-01T00:00:01Z" },
  ] });
  process.env.ERGO_HOST = "127.0.0.1";
  process.env.ERGO_PORT = String(server.port);
  let result: Awaited<ReturnType<typeof grants.purgeChannelHistory>> | null = null;
  try {
    result = await grants.purgeChannelHistory("#t-abc123");
    await Bun.sleep(25);
  } finally {
    server.stop();
  }
  // m1, m2 and the purge's own PART go; the two shared events stay and do not make it partial.
  expect(result).toMatchObject({ scanned: 4, deleted: 3, failed: 0, skipped: 2, partial: false });
  expect(server.lines.some((line) => line.startsWith("CAP REQ ") && line.includes("draft/event-playback"))).toBe(true);
  expect(server.lines).toContain("PRIVMSG HistServ :DELETE #t-abc123 m1");
  expect(server.lines).toContain("PRIVMSG HistServ :DELETE #t-abc123 m2");
  expect(server.lines.some((line) => /DELETE \S+ (nick1|quit1)$/.test(line))).toBe(false);
  const shared = (["NICK", "QUIT", "PRIVMSG", "JOIN"] as const).filter((command) => history.sharedHistoryEvent({ command } as any));
  expect(shared).toEqual(["NICK", "QUIT"]);
});

test("purge never rejects when the oper connection fails", async () => {
  process.env.ERGO_HOST = "127.0.0.1";
  process.env.ERGO_PORT = "1";
  const result = await grants.purgeChannelHistory("#dm-x-y");
  expect(result).toMatchObject({ channel: "#dm-x-y", scanned: 0, deleted: 0, failed: 0, skipped: 0, partial: true });
});

test("purge refuses an invalid channel without touching the wire", async () => {
  const result = await grants.purgeChannelHistory("not a channel");
  expect(result).toMatchObject({ scanned: 0, deleted: 0, partial: true });
});
