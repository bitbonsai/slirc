// Reusable membership-granting channel links are disabled end to end:
// creation is refused, legacy tokens fail clearly, and no membership follows.
// Bounded, email-specific invitations keep working.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const invites = await import("../src/email-invites.ts");

const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });
const idOf = (nick: string) => (db.query("SELECT account_id FROM accounts WHERE nick = ?").get(nick) as { account_id: string }).account_id;

const legacyToken = "legacy-copied-room-token";
let ownerId = "";

beforeEach(() => {
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM invites").run();
  db.query("DELETE FROM channel_members").run();
  db.query("DELETE FROM channels").run();
  db.query("DELETE FROM accounts WHERE nick != 'bitbonsai'").run();
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('newbie', 'newbie@example.test', 'member', 1, 1)").run();
  ownerId = idOf("bitbonsai");
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#d-secret', 'bitbonsai', 'secret', 1), ('#d-open-team', 'bitbonsai', 'workspace', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#d-secret', 'bitbonsai'), ('#d-open-team', 'bitbonsai')").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?), (?, 'newbie', ?)")
    .run(sessionHash("owner-session"), Date.now(), sessionHash("newbie-session"), Date.now());
  db.query("INSERT INTO invites (token_hash, channel, created_by, created_at) VALUES (?, '#d-secret', 'bitbonsai', 1)").run(createHash("sha256").update(legacyToken).digest("hex"));
});

test("creating a reusable channel invite link is refused", async () => {
  const response = await app.request("/api/invites", { method: "POST", headers: auth("owner-session"), body: JSON.stringify({ channel: "#d-secret" }) });
  expect(response.status).toBe(410);
  expect((await response.json()).error).toContain("turned off");
  expect(db.query("SELECT COUNT(*) AS count FROM invites WHERE email IS NULL").get()).toEqual({ count: 1 });
});

test("a legacy reusable token fails clearly and grants no membership", async () => {
  const info = await app.request(`/api/join/${legacyToken}`);
  expect(info.status).toBe(410);
  expect((await info.json()).error).toContain("no longer available");

  const accept = await app.request(`/api/join/${legacyToken}`, { method: "POST", headers: auth("newbie-session") });
  expect(accept.status).toBe(410);
  expect(db.query("SELECT 1 FROM channel_members WHERE channel = '#d-secret' AND nick = 'newbie'").get()).toBeNull();

  const guest = await app.request(`/api/join/${legacyToken}/guest`, { method: "POST", headers: auth("newbie-session"), body: JSON.stringify({ email: "newbie@example.test" }) });
  expect(guest.status).toBe(410);
  expect(db.query("SELECT 1 FROM channel_members WHERE channel = '#d-secret' AND nick = 'newbie'").get()).toBeNull();
});

test("bounded email invitations still resolve and grant membership", async () => {
  const row = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: ownerId,
    email: "newbie@example.test", recipientAccountId: idOf("newbie"), destination: { type: "channel", channel: "#d-open-team" } });
  invites.recordEmailInviteDelivery(row.token, "sent");

  const info = await app.request(`/api/join/${row.token}`);
  expect(info.status).toBe(200);
  expect(await info.json()).toEqual({ destination: { type: "channel", channel: "#d-open-team" }, requiresVerifiedEmail: true });

  const accept = await app.request(`/api/join/${row.token}`, { method: "POST", headers: auth("newbie-session") });
  expect(accept.status).toBe(200);
  expect(await accept.json()).toEqual({ type: "channel", channel: "#d-open-team", accepted: true });
  expect(db.query("SELECT 1 FROM channel_members WHERE channel = '#d-open-team' AND nick = 'newbie'").get()).not.toBeNull();
});
