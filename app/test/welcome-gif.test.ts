// The welcome helper keeps one daily gif per room: its own gif echo deletes the previous one with a
// native REDACT. Runs against a fake IRC server; only welcome's "[Giphy: ...]" lines may ever be
// deleted.
import "./fixture.ts";

import { afterEach, beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { startHelpers } = await import("../src/helper-bot.ts");
const { startFakeIrc } = await import("./fake-irc.ts");

const GIF = (msgid: string, time: string, nick = "welcome") => `@msgid=${msgid};account=${nick};time=${time} :${nick}!u@h PRIVMSG #open-chat :[Giphy: tuesday] https://media.giphy.com/${msgid}.gif`;
const GREETING = "@msgid=w1;account=welcome;time=2026-11-02T09:00:00.000Z :welcome!u@h PRIVMSG #open-chat :Welcome, ana! Say hi.";

const saved = { helpers: process.env.SLIRC_HELPERS, enabled: process.env.SLIRC_HELPERS_ENABLED, host: process.env.ERGO_HOST, port: process.env.ERGO_PORT };
const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
let fake: ReturnType<typeof startFakeIrc> | null = null;

beforeEach(() => {
  db.exec("DELETE FROM meta WHERE key LIKE 'ambience:%'");
});
afterEach(() => {
  fake?.close();
  fake = null;
  restore("SLIRC_HELPERS", saved.helpers); restore("SLIRC_HELPERS_ENABLED", saved.enabled); restore("ERGO_HOST", saved.host); restore("ERGO_PORT", saved.port);
});

const until = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  return check();
};

test("welcome's new daily gif deletes only its previous gif, never greetings or other people's lines", async () => {
  db.query("INSERT INTO accounts (nick,email,role,kind,owner,verified_at,created_at) VALUES ('welcome','welcome@helpers.invalid','member','bot',NULL,1,1) ON CONFLICT DO NOTHING").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#open-chat', 'welcome') ON CONFLICT DO NOTHING").run();
  fake = startFakeIrc();
  process.env.ERGO_HOST = "127.0.0.1";
  process.env.ERGO_PORT = String(fake.port);
  process.env.SLIRC_HELPERS = "welcome";
  delete process.env.SLIRC_HELPERS_ENABLED;
  startHelpers();
  const server = fake;
  expect(await until(() => server.lines.includes("JOIN #open-chat"))).toBe(true);
  // welcome asks for redaction; without it Ergo would refuse the REDACT.
  expect(server.lines.find((line) => line.startsWith("CAP REQ"))).toContain("draft/message-redaction");

  server.push(GIF("g1", "2026-11-01T09:00:00.000Z"));
  server.push(GREETING);
  server.push(GIF("o1", "2026-11-02T10:00:00.000Z", "ana"));
  await Bun.sleep(150);
  expect(server.lines.filter((line) => line.startsWith("REDACT"))).toEqual([]);

  server.push(GIF("g2", "2026-11-03T09:00:00.000Z"));
  expect(await until(() => server.lines.some((line) => line.startsWith("REDACT")))).toBe(true);
  server.push(GIF("g3", "2026-11-04T09:00:00.000Z"));
  expect(await until(() => server.lines.filter((line) => line.startsWith("REDACT")).length === 2)).toBe(true);
  expect(server.lines.filter((line) => line.startsWith("REDACT"))).toEqual([
    "REDACT #open-chat g1 :replaced by today's gif",
    "REDACT #open-chat g2 :replaced by today's gif",
  ]);
});
