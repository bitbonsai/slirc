import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("old mappings migrate unverified and reservations survive a real process restart", () => {
  const scratch = mkdtempSync(join(tmpdir(), "slirc-dm-readiness-"));
  const path = join(scratch, "chat.sqlite");
  const old = new Database(path);
  old.exec(`CREATE TABLE direct_conversations (
    channel TEXT PRIMARY KEY, first_nick TEXT NOT NULL, second_nick TEXT NOT NULL,
    UNIQUE(first_nick,second_nick));
    INSERT INTO direct_conversations VALUES ('#dm-old-identity','alice','bob');`);
  old.close();
  const run = (source: string) => {
    const result = spawnSync(process.execPath, ["-e", source], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH, DB_PATH: path, NODE_ENV: "test", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    const first = run(`
      const { db } = await import('./src/db.ts');
      const rooms = await import('./src/rooms.ts');
      const legacy = db.query('SELECT * FROM direct_conversations').get();
      const reserved = rooms.createDirectConversation('carol','dave','carol',false);
      console.log(JSON.stringify({legacy,reserved}));
      db.close();
    `);
    expect(first.legacy).toEqual({ channel: "#dm-old-identity", first_nick: "alice", second_nick: "bob", provision_ready: null });
    const second = run(`
      const { db } = await import('./src/db.ts');
      const rooms = await import('./src/rooms.ts');
      console.log(JSON.stringify({
        legacy: rooms.directConversation('alice','bob'),
        reserved: rooms.directConversation('carol','dave'),
        channel: rooms.directChannelName('dave','carol'),
        member: rooms.isMember('carol',rooms.directChannelName('carol','dave')),
        members: db.query('SELECT nick FROM channel_members ORDER BY nick').all(),
        state: db.query("SELECT provision_ready FROM direct_conversations WHERE first_nick='carol'").get()
      }));
      db.close();
    `);
    expect(second).toEqual({ legacy: null, reserved: null, channel: first.reserved.channel, member: false,
      members: [{ nick: "carol" }, { nick: "dave" }], state: { provision_ready: 0 } });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

const { assertDirectReadiness, verifyDirectReadiness } = await import("../src/direct-readiness.ts");

function legacyDatabase() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE direct_conversations (channel TEXT PRIMARY KEY, first_nick TEXT, second_nick TEXT, provision_ready INTEGER);
    CREATE TABLE channels (channel TEXT, visibility TEXT, archived_at INTEGER);
    CREATE TABLE channel_members (channel TEXT, nick TEXT);
    CREATE TABLE history_marker (id TEXT, content TEXT);
    INSERT INTO history_marker VALUES ('unchanged-id','untouched history');
    INSERT INTO direct_conversations VALUES ('#dm-a-b','a','b',NULL), ('#dm-c-d','c','d',NULL), ('#dm-e-f','e','f',0);
    INSERT INTO channels VALUES ('#dm-a-b','direct',NULL),('#dm-c-d','direct',NULL),('#dm-e-f','direct',NULL);
    INSERT INTO channel_members VALUES ('#dm-a-b','a'),('#dm-a-b','b'),('#dm-c-d','c'),('#dm-c-d','d');`);
  return db;
}
function snapshot(db: Database) {
  return ["direct_conversations", "channels", "channel_members", "history_marker"].map((table) => db.query(`SELECT * FROM ${table}`).all());
}

test("zero legacy rows boot without IRC, explicit reservations remain hidden", () => {
  const db = legacyDatabase();
  db.exec("UPDATE direct_conversations SET provision_ready=1 WHERE provision_ready IS NULL");
  try { expect(() => assertDirectReadiness(db)).not.toThrow(); } finally { db.close(); }
});

test("unresolved second row rolls back the whole checkpoint and keeps boot closed", async () => {
  const db = legacyDatabase();
  const before = snapshot(db);
  let checkpoint = false;
  try {
    await expect(verifyDirectReadiness(db, async (channel) => channel === "#dm-a-b", async () => { checkpoint = true; }))
      .rejects.toThrow("proof unresolved: #dm-c-d");
    expect(checkpoint).toBe(false);
    expect(snapshot(db)).toEqual(before);
    expect(() => assertDirectReadiness(db)).toThrow("2 legacy DMs");
  } finally { db.close(); }
});

test("host runtime check rejects a resumed writer before any readiness checkpoint commits", async () => {
  const db = legacyDatabase();
  const before = snapshot(db);
  try {
    await expect(verifyDirectReadiness(db, async () => true, async () => { throw new Error("Old app is not stopped"); }))
      .rejects.toThrow("not stopped");
    expect(snapshot(db)).toEqual(before);
  } finally { db.close(); }
});

test("extra metadata membership aborts without repairing or deleting anything", async () => {
  const db = legacyDatabase();
  db.exec("INSERT INTO channel_members VALUES ('#dm-a-b','intruder')");
  const before = snapshot(db);
  let calls = 0;
  try {
    await expect(verifyDirectReadiness(db, async () => { calls++; return true; }, async () => {})).rejects.toThrow("metadata");
    expect(calls).toBe(0);
    expect(snapshot(db)).toEqual(before);
  } finally { db.close(); }
});

test("real IRC multirow proofs commit only after the host checkpoint and preserve identities and history", async () => {
  const net = await import("node:net");
  const sockets = new Set<import("node:net").Socket>();
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "", nick = "";
    socket.on("data", (data) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); lines.push(line);
        const send = (value: string) => socket.write(`${value}\r\n`);
        if (line.startsWith("NICK ")) nick = line.slice(5);
        else if (line === "CAP LS 302") send(":test CAP * LS :sasl");
        else if (line === "CAP REQ :sasl") send(":test CAP * ACK :sasl");
        else if (line === "AUTHENTICATE PLAIN") send("AUTHENTICATE +");
        else if (line.startsWith("AUTHENTICATE ")) send(":test 903 * :ok");
        else if (line === "CAP END") send(`:test 001 ${nick} :welcome`);
        else if (line.startsWith("OPER ")) send(`:test 381 ${nick} :oper`);
        else if (line.startsWith("MODE ")) send(`:test 324 ${nick} ${line.slice(5)} :+nsi`);
        else if (line.startsWith("SAMODE ")) {
          const channel = line.split(" ")[1];
          for (const member of channel === "#dm-a-b" ? ["a", "b"] : ["c", "d"]) send(`:test 346 ${nick} ${channel} ${member}!*@* oper 1`);
          send(`:test 347 ${nick} ${channel} :End`);
        } else if (line.startsWith("PRIVMSG ChanServ :INFO ")) {
          const channel = line.split(" ").at(-1);
          send(`:ChanServ!service@test NOTICE ${nick} :Channel ${channel} is registered`);
          send(`:ChanServ!service@test NOTICE ${nick} :Founder: ${channel === "#dm-a-b" ? "a" : "c"}`);
        } else if (line.startsWith("WHO ")) send(`:test 315 ${nick} ${line.split(" ")[1]} :End of WHO list`);
        else if (line.startsWith("PING ")) send(`:test PONG test :${line.slice(5)}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.ERGO_HOST = "127.0.0.1";
  process.env.ERGO_PORT = String((server.address() as import("node:net").AddressInfo).port);
  process.env.ERGO_OPER_USER = "migration-test";
  process.env.ERGO_OPER_PASS = "test-only";
  const { readDirectChannelReady } = await import("../src/grants.ts");
  const db = legacyDatabase();
  const before = snapshot(db);
  let checkpoints = 0;
  try {
    expect(await verifyDirectReadiness(db, readDirectChannelReady, async () => {
      checkpoints++;
      expect(lines.filter((line) => line.startsWith("PRIVMSG ChanServ :INFO "))).toHaveLength(2);
    })).toBe(2);
    expect(checkpoints).toBe(1);
    expect(() => assertDirectReadiness(db)).not.toThrow();
    const after = snapshot(db);
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(after[0]).toEqual(before[0].map((row: any) => ({ ...row, provision_ready: row.provision_ready === null ? 1 : row.provision_ready })));
    expect(lines.some((line) => /^(SAJOIN|JOIN) |REGISTER|SAMODE .*\+si/.test(line))).toBe(false);
    expect(await verifyDirectReadiness(db, async () => { throw new Error("unexpected IRC"); }, async () => {})).toBe(0);
  } finally {
    db.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("image preflight rejects old rows, and verification without a host pause checkpoint cannot write", () => {
  const scratch = mkdtempSync(join(tmpdir(), "slirc-dm-boot-"));
  const path = join(scratch, "chat.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE direct_conversations (channel TEXT PRIMARY KEY, first_nick TEXT, second_nick TEXT); INSERT INTO direct_conversations VALUES ('#legacy','a','b')");
  db.close();
  const env = { PATH: process.env.PATH, DB_PATH: path, NODE_ENV: "test", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    APP_ORIGIN: "https://test.invalid", ERGO_HOST: "127.0.0.1", ERGO_PORT: "1", ERGO_OPER_USER: "test", ERGO_OPER_PASS: "test" };
  const run = (...args: string[]) => spawnSync(process.execPath, ["src/direct-readiness.ts", ...args], {
    cwd: new URL("..", import.meta.url).pathname, env, encoding: "utf8",
  });
  try {
    const blocked = run("check");
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("refusing startup");
    expect(run("verify", env.APP_ORIGIN, path, "a".repeat(64)).status).toBe(1);
    const unchanged = new Database(path);
    expect(unchanged.query("PRAGMA table_info(direct_conversations)").all()).toHaveLength(3);
    expect(unchanged.query("SELECT * FROM direct_conversations").all()).toHaveLength(1);
    unchanged.exec("DELETE FROM direct_conversations");
    unchanged.close();
    expect(run("check").status).toBe(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("direct server entry cannot serve a database with legacy mappings", () => {
  const scratch = mkdtempSync(join(tmpdir(), "slirc-dm-server-"));
  const path = join(scratch, "chat.sqlite");
  try {
    const result = spawnSync(process.execPath, ["-e", `
      await import('./test/fixture.ts');
      process.env.DB_PATH = ${JSON.stringify(path)};
      const {db} = await import('./src/db.ts');
      db.exec("INSERT INTO direct_conversations (channel,first_nick,second_nick) VALUES ('#legacy','a','b')");
      await import('./src/server.ts');
      console.log('UNSAFE: server loaded');
    `], { cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing startup");
    expect(result.stdout).not.toContain("UNSAFE");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
