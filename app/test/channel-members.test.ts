import "./fixture.ts";

import { createHash } from "node:crypto";
import { expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { createEmailInvite, recordEmailInviteDelivery } = await import("../src/email-invites.ts");
const token = "member-test-session";
const auth = { Cookie: `slirc_session=${token}`, "Content-Type": "application/json" };

test("secret-channel pending emails are visible only to their inviter", async () => {
  const channel = "#pending-members-test";
  db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(createHash("sha256").update(token).digest("hex"), Date.now());
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('pending-viewer', 'viewer@example.test', 'member', 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'pending-viewer', ?)").run(createHash("sha256").update("pending-viewer-session").digest("hex"), Date.now());
  db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES (?, 'bitbonsai', 'secret', '', ?)").run(channel, Date.now());
  for (const nick of ["bitbonsai", "pending-viewer"]) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?)").run(channel, nick);
  const senderId = (db.query("SELECT account_id FROM accounts WHERE nick = 'bitbonsai'").get() as { account_id: string }).account_id;
  const invite = createEmailInvite({ inviter: "bitbonsai", inviterAccountId: senderId, email: "pending@example.test", destination: { type: "channel", channel } });
  recordEmailInviteDelivery(invite.token, "sent");
  const own = await (await app.request(`/api/channels/${encodeURIComponent(channel)}/members`, { headers: auth })).json();
  expect(own.pendingInvitations).toEqual([{ email: "pending@example.test", status: "pending" }]);
  expect(own.members).toHaveLength(2);
  db.query("INSERT INTO profiles (account, avatar_path, avatar_version) VALUES ('pending-viewer', '/tmp/none', 42) ON CONFLICT(account) DO UPDATE SET avatar_path = excluded.avatar_path, avatar_version = excluded.avatar_version").run();
  const versions = (await (await app.request(`/api/channels/${encodeURIComponent(channel)}/members`, { headers: auth })).json()).members.map((row: { nick: string; avatarVersion: number }) => [row.nick, row.avatarVersion]);
  expect(versions).toContainEqual(["pending-viewer", 42]);
  const other = await (await app.request(`/api/channels/${encodeURIComponent(channel)}/members`, { headers: { Cookie: "slirc_session=pending-viewer-session" } })).json();
  expect(other.pendingInvitations).toEqual([]);
});

test("inviting a bot to an open room records the membership its join loop watches", async () => {
  db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(createHash("sha256").update(token).digest("hex"), Date.now());
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('test-helper', 'test-helper@helpers.invalid', 'member', 'bot', 1, 1)").run();

  const first = await app.request("/api/channels/help/members", { method: "POST", headers: auth, body: JSON.stringify({ nick: "test-helper", invite: "self" }) });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ channel: "#help", nick: "test-helper", added: true });
  expect(db.query("SELECT 1 FROM channel_members WHERE channel = '#help' AND nick = 'test-helper'").get()).toBeTruthy();

  const again = await app.request("/api/channels/help/members", { method: "POST", headers: auth, body: JSON.stringify({ nick: "test-helper", invite: "self" }) });
  expect(await again.json()).toEqual({ channel: "#help", nick: "test-helper", added: false });

  const human = await app.request("/api/channels/help/members", { method: "POST", headers: auth, body: JSON.stringify({ nick: "bitbonsai", invite: "self" }) });
  expect(await human.json()).toEqual({ channel: "#help", nick: "bitbonsai", added: false });
  expect(db.query("SELECT 1 FROM channel_members WHERE channel = '#help' AND nick = 'bitbonsai'").get()).toBeNull();
});
