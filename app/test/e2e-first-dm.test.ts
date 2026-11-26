// First DM end to end through the routes: two people who share a room find each other in
// people search, one opens the DM, and both sides see the same conversation. Oper IRC is faked.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { expect, mock, test } from "bun:test";

const provisioned: string[][] = [];
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({
  ...grants,
  createDirectChannel: async (channel: string, owner: string, members: string[]) => { provisioned.push([channel, ...members]); },
  readDirectChannelReady: async () => false,
}));

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const as = (nick: string) => ({ Cookie: `slirc_session=${nick}-e2e` });
const me = async (nick: string) => (await app.request("/auth/me", { headers: as(nick) })).json();
const directNicks = async (nick: string) => (await me(nick)).directs.map((item: { nick: string }) => item.nick);

for (const nick of ["ada", "ben", "cy"]) {
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES (?, ?, 'member', 1, 1)").run(nick, `${nick}@example.test`);
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(hash(`${nick}-e2e`), nick, Date.now());
}
db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES ('#e2e-shared', 'ada', 'secret', '', 1)").run();
for (const nick of ["ada", "ben"]) db.query("INSERT INTO channel_members (channel, nick) VALUES ('#e2e-shared', ?)").run(nick);

test("people who share a room find each other and open one DM both of them see", async () => {
  const search = await (await app.request("/api/people?q=be", { headers: as("ada") })).json();
  const found = (search.people ?? search).map((person: { nick: string }) => person.nick);
  expect(found).toContain("ben");
  expect(found).not.toContain("cy");
  expect(await directNicks("ada")).not.toContain("ben");

  const opened = await app.request("/api/dms/ben", { method: "POST", headers: as("ada") });
  expect(opened.status).toBe(200);
  const direct = await opened.json() as { channel: string; nick: string };
  expect(direct.nick).toBe("ben");
  expect(provisioned).toHaveLength(1);
  expect(provisioned[0][0]).toBe(direct.channel);
  expect(provisioned[0].slice(1).sort()).toEqual(["ada", "ben"]);

  // Both sides see the same channel; opening it from the other side reuses it.
  expect(await directNicks("ada")).toContain("ben");
  expect(await directNicks("ben")).toContain("ada");
  const back = await (await app.request("/api/dms/ada", { method: "POST", headers: as("ben") })).json();
  expect(back.channel).toBe(direct.channel);
  expect(new Set(provisioned.map(([channel]) => channel))).toEqual(new Set([direct.channel]));

  // Someone with no shared room cannot open a DM by guessing a nick.
  expect((await app.request("/api/dms/ada", { method: "POST", headers: as("cy") })).status).toBe(404);
  expect(await directNicks("cy")).toEqual([]);
});
