import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");

const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });
const patch = (who: string, nick: string, email: string) =>
  app.request(`/api/admin/accounts/${nick}`, { method: "PATCH", headers: auth(who), body: JSON.stringify({ email }) });

beforeEach(() => {
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM accounts WHERE nick != 'bitbonsai'").run();
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('igor', 'igor@example.com', 'member', 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sessionHash("admin-session"), Date.now());
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'igor', ?)").run(sessionHash("member-session"), Date.now());
});

test("members cannot change anyone's email, not even their own", async () => {
  expect((await patch("member-session", "igor", "new@example.com")).status).toBe(403);
  expect((await app.request("/profile/email", { method: "POST", headers: auth("member-session"), body: "{}" })).status).toBe(404);
});

test("admins can set another account's email, uniqueness enforced", async () => {
  const ok = await patch("admin-session", "igor", "Igor.New@Example.com");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ nick: "igor", email: "igor.new@example.com" });
  expect((await patch("admin-session", "igor", "owner@example.com")).status).toBe(409);
  expect((await patch("admin-session", "igor", "not-an-email")).status).toBe(400);
  expect((await patch("admin-session", "nobody", "x@example.com")).status).toBe(404);
});

test("profile payload carries the email only for admins", async () => {
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#room', 'bitbonsai'), ('#room', 'igor')").run();
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#room', 'bitbonsai', 'secret', 1)").run();
  const asAdmin = await (await app.request("/profiles/igor?channel=%23room", { headers: auth("admin-session") })).json();
  const asMember = await (await app.request("/profiles/bitbonsai?channel=%23room", { headers: auth("member-session") })).json();
  expect(asAdmin.email).toBe("igor@example.com");
  expect(asMember.email).toBeUndefined();
});

test("an admin cannot move another admin's or a bot's email", async () => {
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('ada', 'ada@example.com', 'admin', 1, 1)").run();
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('robo', 'robo@example.com', 'member', 'bot', 1, 1)").run();
  expect((await patch("admin-session", "ada", "attacker@example.com")).status).toBe(403);
  expect((await patch("admin-session", "robo", "attacker@example.com")).status).toBe(403);
  expect(db.query("SELECT email FROM accounts WHERE nick IN ('ada', 'robo') ORDER BY nick").all()).toEqual([{ email: "ada@example.com" }, { email: "robo@example.com" }]);
  expect((await patch("admin-session", "bitbonsai", "owner2@example.com")).status).toBe(200);
});
