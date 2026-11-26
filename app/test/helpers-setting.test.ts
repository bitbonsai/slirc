// SLIRC_HELPERS picks which helpers an instance runs. A helper left out gets no account, never
// connects, and is missing from lookups. help and remind are contacts and searchable for every
// verified member where they run; poll and welcome never appear in Contacts or search.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { contactHelpers, enabledHelpers, inactiveHelper } = await import("../src/config.ts");
const { ensureHelperAccounts, startHelpers } = await import("../src/helper-bot.ts");
const { sharedContacts } = await import("../src/rooms.ts");

const saved = { list: process.env.SLIRC_HELPERS, enabled: process.env.SLIRC_HELPERS_ENABLED, host: process.env.ERGO_HOST, port: process.env.ERGO_PORT };
const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
afterEach(() => {
  restore("SLIRC_HELPERS", saved.list); restore("SLIRC_HELPERS_ENABLED", saved.enabled);
  restore("ERGO_HOST", saved.host); restore("ERGO_PORT", saved.port);
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}` });
const HELPERS = ["help", "remind", "poll", "welcome"];

function bot(nick: string): void {
  db.query("INSERT INTO accounts (nick,email,role,kind,owner,verified_at,created_at) VALUES (?,?,'member','bot',NULL,1,1)").run(nick, `${nick}@helpers.invalid`);
}

beforeEach(() => {
  delete process.env.SLIRC_HELPERS; delete process.env.SLIRC_HELPERS_ENABLED;
  db.exec("DELETE FROM channel_members; DELETE FROM channels; DELETE FROM sessions");
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query("INSERT INTO accounts (nick,email,role,kind,owner,verified_at,created_at) VALUES ('ana','ana@example.test','member','human',NULL,1,1)").run();
  db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?,?,?)").run(sha("ana-token"), "ana", Date.now());
});

test("unset runs every helper, a list picks some, the off switch wins, and a typo throws", () => {
  expect(enabledHelpers()).toEqual(HELPERS);
  // links is opt-in: an instance that never named it does not gain a helper on upgrade.
  expect(enabledHelpers()).not.toContain("links");
  expect(inactiveHelper("links")).toBe(true);
  process.env.SLIRC_HELPERS = "help,links";
  expect(enabledHelpers()).toEqual(["help", "links"]);
  process.env.SLIRC_HELPERS = " Remind , help ";
  expect(enabledHelpers()).toEqual(["help", "remind"]);
  expect(inactiveHelper("poll")).toBe(true);
  expect(inactiveHelper("help")).toBe(false);
  expect(inactiveHelper("ana")).toBe(false);
  process.env.SLIRC_HELPERS_ENABLED = "false";
  expect(enabledHelpers()).toEqual([]);
  delete process.env.SLIRC_HELPERS_ENABLED;
  process.env.SLIRC_HELPERS = "help,pol";
  expect(() => enabledHelpers()).toThrow("SLIRC_HELPERS names unknown helpers: pol");
});

test("a helper left out gets no account and no room membership", async () => {
  process.env.SLIRC_HELPERS = "help,remind";
  await ensureHelperAccounts();
  const nicks = (db.query("SELECT nick FROM accounts WHERE kind = 'bot' ORDER BY nick").all() as { nick: string }[]).map((row) => row.nick);
  expect(nicks).toEqual(["help", "remind"]);
  const rooms = (db.query("SELECT nick FROM channel_members ORDER BY nick").all() as { nick: string }[]).map((row) => row.nick);
  expect(rooms).toEqual(["help"]);
});

test("a helper left out never connects, even with an account from an earlier boot", async () => {
  for (const nick of HELPERS) bot(nick);
  const seen: string[] = [];
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1", port: 0,
    socket: { data(_socket, data) { for (const match of data.toString().matchAll(/^NICK (\S+)/gm)) seen.push(match[1]!.toLowerCase()); } },
  });
  process.env.ERGO_HOST = "127.0.0.1";
  process.env.ERGO_PORT = String(server.port);
  process.env.SLIRC_HELPERS = "remind";
  startHelpers();
  await Bun.sleep(400);
  server.stop(true);
  expect([...new Set(seen)]).toEqual(["remind"]);
});

test("help and remind are contacts for every verified member; poll and welcome never are", async () => {
  for (const nick of HELPERS) bot(nick);
  // A private channel shared with poll and welcome must not make them contacts.
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#design','ana','secret',1)").run();
  for (const nick of ["ana", "poll", "welcome"]) db.query("INSERT INTO channel_members (channel,nick) VALUES ('#design',?)").run(nick);
  expect(sharedContacts("ana").filter((nick) => HELPERS.includes(nick))).toEqual(["help", "remind"]);
  const me = await (await app.request("/auth/me", { headers: auth("ana-token") })).json();
  expect(me.contacts.filter((nick: string) => HELPERS.includes(nick))).toEqual(["help", "remind"]);
  expect(me.helpers).toEqual(HELPERS);

  process.env.SLIRC_HELPERS = "help,poll";
  expect(contactHelpers()).toEqual(["help"]);
  expect(sharedContacts("ana").filter((nick) => HELPERS.includes(nick))).toEqual(["help"]);
  process.env.SLIRC_HELPERS_ENABLED = "false";
  expect(sharedContacts("ana").filter((nick) => HELPERS.includes(nick))).toEqual([]);
});

test("New DM search finds help and remind where they run, never poll or welcome", async () => {
  for (const nick of HELPERS) bot(nick);
  const search = async (q: string) => ((await (await app.request(`/api/people?q=${q}`, { headers: auth("ana-token") })).json()).people as { nick: string; kind?: string }[]);
  expect((await search("hel")).map((person) => [person.nick, person.kind])).toEqual([["help", "bot"]]);
  expect((await search("remind")).map((person) => person.nick)).toEqual(["remind"]);
  expect(await search("poll")).toEqual([]);
  expect(await search("welc")).toEqual([]);
  process.env.SLIRC_HELPERS = "help";
  expect(await search("remind")).toEqual([]);
});

test("a helper left out is missing from member lookups and cannot be DMed", async () => {
  for (const nick of HELPERS) bot(nick);
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#design','ana','secret',1)").run();
  db.query("INSERT INTO channel_members (channel,nick) VALUES ('#design','ana')").run();
  process.env.SLIRC_HELPERS = "help,remind";
  const lookup = await app.request("/api/channels/design/members/poll", { headers: auth("ana-token") });
  expect(lookup.status).toBe(404);
  expect((await lookup.json()).error).toBe("person not found");
  expect((await app.request("/api/channels/design/members/help", { headers: auth("ana-token") })).status).toBe(200);
  const dm = await app.request("/api/dms/poll", { method: "POST", headers: auth("ana-token") });
  expect(dm.status).toBe(404);
});

test("the client offers /remind only when the instance runs remind", async () => {
  const { hiddenCommands, slashSuggestions } = await import("../client/commands.ts");
  expect(slashSuggestions("/rem", hiddenCommands(HELPERS)).map((command) => command.name)).toEqual(["remind"]);
  expect(slashSuggestions("/rem", hiddenCommands(["help"]))).toEqual([]);
  expect(slashSuggestions("/rem").map((command) => command.name)).toEqual(["remind"]);
});
