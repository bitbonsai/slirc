import "./fixture.ts";

process.env.APP_ORIGIN = "http://localhost:8080";
process.env.MAGIC_LINK_LOG = "true";
process.env.EMAIL_INVITE_LIMIT = "9";

import { createHash, randomBytes } from "node:crypto";
import { beforeEach, expect, spyOn, test } from "bun:test";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const invites = await import("../src/email-invites.ts");

const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });
let senderId = "";

beforeEach(() => {
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM invites").run();
  db.query("DELETE FROM conversation_operations").run();
  db.query("DELETE FROM email_invite_quota").run();
  db.query("DELETE FROM accounts WHERE nick != 'bitbonsai'").run();
  // The allowance applies to members; admins have none (see the unlimited test below).
  db.query("UPDATE accounts SET role = 'member' WHERE nick = 'bitbonsai'").run();
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('igor', 'igor@example.com', 'member', 1, 1)").run();
  senderId = (db.query("SELECT account_id FROM accounts WHERE nick='bitbonsai'").get() as { account_id: string }).account_id;
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?), (?, 'igor', ?)")
    .run(sessionHash("admin-session"), Date.now(), sessionHash("member-session"), Date.now());
});

test("quota is lifetime, account-scoped, and concurrent reservations cannot exceed nine", async () => {
  const response = await app.request("/api/invites/email", { headers: auth("admin-session") });
  expect(await response.json()).toEqual({ remaining: 9, limit: 9, unlimited: false });
  const reservations = Array.from({ length: 12 }, () => invites.reserveEmailInvite(senderId));
  expect(reservations.filter(Boolean)).toHaveLength(9);
  expect(invites.emailInvitesRemaining(senderId)).toBe(0);
  for (let i = 0; i < 9; i++) invites.settleEmailInvite(senderId, "sent");
  expect(invites.emailInvitesRemaining(senderId)).toBe(0);
});

test("admins have no allowance: an admin at zero still invites by email from every endpoint", async () => {
  db.query("INSERT INTO email_invite_quota (account_id, sent) VALUES (?, 9)").run(senderId);
  expect(await (await app.request("/api/invites/email", { headers: auth("admin-session") })).json()).toEqual({ remaining: 0, limit: 9, unlimited: false });
  db.query("UPDATE accounts SET role = 'admin' WHERE nick = 'bitbonsai'").run();
  expect(await (await app.request("/api/invites/email", { headers: auth("admin-session") })).json()).toEqual({ remaining: null, limit: null, unlimited: true });
  expect(invites.reserveEmailInvites(senderId, 50)).toBe(true);
  const channel = "#admin-invite-test";
  db.query("INSERT OR IGNORE INTO channels (channel, owner, visibility, topic, created_at) VALUES (?, 'bitbonsai', 'secret', '', ?)").run(channel, Date.now());
  db.query("INSERT OR IGNORE INTO channel_members (channel, nick) VALUES (?, 'bitbonsai')").run(channel);
  const requests: [string, unknown][] = [
    ["/api/invites/email", { channel, email: "first@example.com" }],
    ["/api/conversations", { recipients: [{ email: "second@example.com" }], destination: { type: "channel", channel } }],
    ["/api/conversations", { recipients: [{ email: "third@example.com" }] }],
  ];
  for (const [path, body] of requests) {
    const response = await app.request(path, { method: "POST", headers: { ...auth("admin-session"), "Idempotency-Key": randomBytes(18).toString("hex") }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ unlimited: true, remaining: null });
  }
  expect(db.query("SELECT COUNT(*) AS count FROM invites").get()).toEqual({ count: 3 });
  const listed = await (await app.request("/api/invitations", { headers: auth("admin-session") })).json();
  expect(listed).toMatchObject({ unlimited: true, remaining: null, limit: null });
  // A member at zero is still refused.
  db.query("INSERT INTO email_invite_quota (account_id, sent) VALUES ((SELECT account_id FROM accounts WHERE nick = 'igor'), 9)").run();
  expect(await (await app.request("/api/invites/email", { headers: auth("member-session") })).json()).toEqual({ remaining: 0, limit: 9, unlimited: false });
  const refused = await app.request("/api/conversations", { method: "POST", headers: { ...auth("member-session"), "Idempotency-Key": randomBytes(18).toString("hex") }, body: JSON.stringify({ recipients: [{ email: "fourth@example.com" }] }) });
  expect(refused.status).toBe(403);
});

test("confirmed failures release credits while uncertain and sent delivery consume them durably", () => {
  expect(invites.reserveEmailInvites(senderId, 3)).toBe(true);
  invites.settleEmailInvite(senderId, "failed");
  invites.settleEmailInvite(senderId, "uncertain");
  invites.settleEmailInvite(senderId, "sent");
  expect(invites.emailInvitesRemaining(senderId)).toBe(7);
  db.query("DELETE FROM invites WHERE inviter_account_id = ?").run(senderId);
  expect(invites.emailInvitesRemaining(senderId)).toBe(7);
});

test("invite is recipient-bound, expires after seven days, and cancellation invalidates token", () => {
  const recipientId = (db.query("SELECT account_id FROM accounts WHERE nick='igor'").get() as { account_id: string }).account_id;
  const row = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: senderId,
    email: "igor@example.com", recipientAccountId: recipientId, destination: { type: "dm", channel: null } });
  invites.recordEmailInviteDelivery(row.token, "sent");
  expect(invites.emailInviteByToken(row.token)?.destination).toBe("dm");
  expect(invites.emailInviteByToken(row.token, row.expiresAt)).toBeNull();
  expect(invites.acceptEmailInvite(row.token, "igor", "wrong-account", "igor@example.com")).toBeNull();
  expect(invites.acceptEmailInvite(row.token, "igor", recipientId, "other@example.com")).toBeNull();
  expect(invites.acceptEmailInvite(row.token, "igor", recipientId, "igor@example.com")?.email).toBe("igor@example.com");
  expect(invites.acceptEmailInvite(row.token, "igor", recipientId, "igor@example.com")?.id).toBe(row.id);

  const pending = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: senderId,
    email: "cancel@example.com", destination: { type: "channel", channel: "#room" } });
  expect(invites.cancelEmailInvite(pending.id, senderId)).toBe(true);
  expect(invites.emailInviteByToken(pending.token)).toBeNull();
});

test("conversation operation replays stable result and rejects changed payload", () => {
  const key = randomBytes(18).toString("hex");
  expect(invites.beginConversationOperation(senderId, key, "payload-a").status).toBe("new");
  expect(invites.beginConversationOperation(senderId, key, "payload-a").status).toBe("busy");
  const response = { conversation: null, pending: true, invitationId: "stable" };
  invites.completeConversationOperation(senderId, key, response, 207);
  expect(invites.beginConversationOperation(senderId, key, "payload-a")).toEqual({ status: "replay", response, httpStatus: 207 });
  expect(invites.beginConversationOperation(senderId, key, "payload-b").status).toBe("conflict");
});

test("unknown email DM returns pending outcome and idempotent retry sends once", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const key = randomBytes(18).toString("hex");
  const body = JSON.stringify({ recipients: [{ email: "new@example.com" }] });
  const request = () => app.request("/api/conversations", { method: "POST", headers: {
    ...auth("admin-session"), "Idempotency-Key": key,
  }, body });
  try {
    const first = await request();
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result.conversation).toBeNull();
    expect(result.pending).toBe(true);
    expect(result.recipients[0].status).toBe("invited");
    expect(result.recipients[0].invitationId).toBeTruthy();
    expect(result.remaining).toBe(8);
    expect(db.query("SELECT channel, destination_type FROM invites WHERE invitation_id=?").get(result.recipients[0].invitationId)).toEqual({ channel: null, destination_type: "dm" });
    expect((await (await request()).json()).recipients[0].invitationId).toBe(result.recipients[0].invitationId);
    expect(db.query("SELECT COUNT(*) AS count FROM invites").get()).toEqual({ count: 1 });
    const changed = await app.request("/api/conversations", { method: "POST", headers: {
      ...auth("admin-session"), "Idempotency-Key": key,
    }, body: JSON.stringify({ recipients: [{ email: "other@example.com" }] }) });
    expect(changed.status).toBe(409);
  } finally { log.mockRestore(); }
});

test("a fresh request for the same pending email reuses invitation without spending quota", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const request = (address: string) => app.request("/api/conversations", { method: "POST", headers: {
    ...auth("admin-session"), "Idempotency-Key": randomBytes(18).toString("hex"),
  }, body: JSON.stringify({ recipients: [{ email: address }] }) });
  try {
    const first = await (await request("repeat@example.com")).json();
    db.query("UPDATE email_invite_quota SET sent = 9 WHERE account_id = ?").run(senderId);
    const response = await request("REPEAT@example.com");
    expect(response.status).toBe(200);
    const repeated = await response.json();
    expect(repeated.recipients[0].invitationId).toBe(first.recipients[0].invitationId);
    expect(repeated.recipients[0].reused).toBe(true);
    expect(repeated.remaining).toBe(0);
    expect(db.query("SELECT sent, reserved FROM email_invite_quota WHERE account_id = ?").get(senderId)).toEqual({ sent: 9, reserved: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM invites").get()).toEqual({ count: 1 });
    expect(invites.pendingEmailInvite(senderId, "repeat@example.com", { type: "channel", channel: "#other" })).toBeNull();
  } finally { log.mockRestore(); }
});

test("both channel invitation endpoints reuse an active invite at exhausted quota", async () => {
  const channel = "#repeat-invite-test";
  db.query("INSERT OR IGNORE INTO channels (channel, owner, visibility, topic, created_at) VALUES (?, 'bitbonsai', 'secret', '', ?)").run(channel, Date.now());
  db.query("INSERT OR IGNORE INTO channel_members (channel, nick) VALUES (?, 'bitbonsai')").run(channel);
  const invite = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: senderId, email: "channel-repeat@example.com", destination: { type: "channel", channel } });
  invites.recordEmailInviteDelivery(invite.token, "sent");
  db.query("INSERT INTO email_invite_quota (account_id, sent) VALUES (?, 9)").run(senderId);
  for (const path of ["/api/conversations", "/api/invites/email"]) {
    const body = path === "/api/conversations" ? { recipients: [{ email: "channel-repeat@example.com" }], destination: { type: "channel", channel } } : { channel, email: "channel-repeat@example.com" };
    const response = await app.request(path, { method: "POST", headers: { ...auth("admin-session"), "Idempotency-Key": randomBytes(18).toString("hex") }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect((result.recipients?.[0] || result).invitationId).toBe(invite.id);
    expect(result.remaining).toBe(0);
  }
  expect(db.query("SELECT COUNT(*) AS count FROM invites").get()).toEqual({ count: 1 });
});

test("sent invitation cancellation revokes token and remains sender-scoped", async () => {
  const row = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: senderId,
    email: "cancel@example.com", destination: { type: "dm", channel: null } });
  invites.reserveEmailInvite(senderId);
  invites.settleEmailInvite(senderId, "sent");
  invites.recordEmailInviteDelivery(row.token, "sent");
  const listed = await app.request("/api/invitations", { headers: auth("admin-session") });
  expect((await listed.json()).invitations[0]).toMatchObject({ id: row.id, recipientEmail: "cancel@example.com", status: "pending", destination: { type: "dm", channel: null } });
  const denied = await app.request(`/api/invitations/${row.id}`, { method: "DELETE", headers: auth("member-session") });
  expect(denied.status).toBe(404);
  const cancelled = await app.request(`/api/invitations/${row.id}`, { method: "DELETE", headers: auth("admin-session") });
  expect(cancelled.status).toBe(204);
  expect(invites.emailInviteByToken(row.token)).toBeNull();
  expect(invites.emailInvitesRemaining(senderId)).toBe(8);
});

test("resend after recipient verifies adds existing member without email or quota", async () => {
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#garden', 'bitbonsai', 'secret', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#garden', 'bitbonsai'), ('#garden', 'igor')").run();
  const row = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: senderId,
    email: "igor@example.com", destination: { type: "channel", channel: "#garden" } });
  invites.recordEmailInviteDelivery(row.token, "sent");
  db.query("INSERT INTO email_invite_quota (account_id, sent) VALUES (?, 9)").run(senderId);
  const key = randomBytes(18).toString("hex");
  const response = await app.request(`/api/invitations/${row.id}/resend`, { method: "POST", headers: {
    ...auth("admin-session"), "Idempotency-Key": key,
  } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "added", accountId: expect.any(String), remaining: 0 });
  expect(db.query("SELECT sends, accepted_at FROM invites WHERE invitation_id = ?").get(row.id)).toMatchObject({ sends: 1, accepted_at: expect.any(Number) });
  const retry = await app.request(`/api/invitations/${row.id}/resend`, { method: "POST", headers: {
    ...auth("admin-session"), "Idempotency-Key": key,
  } });
  expect(await retry.json()).toMatchObject({ status: "added", remaining: 0 });
});


test("group metadata is exposed through authenticated conversation mapping", async () => {
  db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at, is_group) VALUES ('#g-test', 'bitbonsai', 'secret', 'Igor', 1, 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#g-test', 'bitbonsai')").run();
  const response = await app.request("/auth/me", { headers: auth("admin-session") });
  const data = await response.json();
  expect(data.channels).toContain("#g-test");
  expect(data.channelDetails.find((item: any) => item.channel === "#g-test")).toMatchObject({ isGroup: true, visibility: "secret" });
});

test("people search exposes verified human public fields only", async () => {
  const response = await app.request("/api/people?q=igor", { headers: auth("admin-session") });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ people: [{
    accountId: expect.any(String), nick: "igor", displayName: "igor", avatarUrl: "", avatarVersion: 0,
  }] });
});
