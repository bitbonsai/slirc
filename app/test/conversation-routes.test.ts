import "./fixture.ts";

process.env.APP_ORIGIN = "https://app.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
process.env.EMAIL_INVITE_LIMIT = "9";
delete process.env.MAGIC_LINK_LOG;

import { createHash, randomBytes } from "node:crypto";
import { beforeEach, expect, mock, spyOn, test } from "bun:test";

const provisionedChannels: string[] = [];
const messages: any[] = [];
let sendOverride: ((message: any, options: any) => Promise<any>) | null = null;
let signalSend: (() => void) | null = null;
const emailSend = mock(async (message: any, options: any) => {
  messages.push(message);
  signalSend?.();
  signalSend = null;
  return sendOverride ? sendOverride(message, options) : { data: { id: "test" }, error: null };
});

mock.module("../src/grants.ts", () => {
  const noop = async () => {};
  return {
    grantChannelOps: noop,
    operClient: noop, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }), readDirectChannelReady: async () => false,
    serviceCommand: noop, setAlwaysOn: noop, transferChannel: noop, allowChannelAccess: noop,
    grantChannelAccess: noop, createChannel: async (channel: string) => { provisionedChannels.push(channel); },
    setChannelMode: noop, setChannelTopic: noop, revokeChannelAccess: noop, createDirectChannel: noop,
    createThreadChannel: noop, NotAuthorizedError: class NotAuthorizedError extends Error {}, redactMessage: noop,
    kickChannelMember: noop, makeChannelSecret: noop, makeThreadChannelsSecret: noop, removeFromThreadChannels: noop, makeChannelOpen: noop, clearChannelAccess: noop,
    unregisterChannel: noop, purgeChannelHistory: noop, renameChannel: noop, removeMemberFromIrc: async () => ({ suspended: true }),
  };
});
mock.module("resend", () => ({ Resend: class { emails = { send: emailSend }; } }));

const { db } = await import("../src/db.ts");
const accounts = await import("../src/accounts.ts");
const { app, settleSignIns } = await import("../src/server.ts");
const invites = await import("../src/email-invites.ts");
const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });
const ownerId = () => (db.query("SELECT account_id FROM accounts WHERE nick='bitbonsai'").get() as { account_id: string }).account_id;
const addSession = (nick: string, token: string) => db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?,?,?)").run(sessionHash(token), nick, Date.now());
let igorId = "";

beforeEach(() => {
  process.env.EMAIL_INVITE_LIMIT = "9";
  sendOverride = null;
  signalSend = null;
  messages.length = 0;
  provisionedChannels.length = 0;
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM invites").run();
  db.query("DELETE FROM conversation_operations").run();
  db.query("DELETE FROM email_invite_quota").run();
  db.query("DELETE FROM closed_direct_conversations").run();
  db.query("DELETE FROM direct_conversations").run();
  db.query("DELETE FROM channel_members").run();
  db.query("DELETE FROM channels WHERE channel LIKE '#g-%'").run();
  db.query("DELETE FROM accounts WHERE nick != 'bitbonsai'").run();
  // Quota checks below need a member sender; admins have no allowance.
  db.query("UPDATE accounts SET role = 'member' WHERE nick = 'bitbonsai'").run();
  db.query("INSERT INTO accounts (nick,email,role,verified_at,created_at) VALUES ('igor','igor@example.com','member',1,1)").run();
  igorId = (db.query("SELECT account_id FROM accounts WHERE nick='igor'").get() as { account_id: string }).account_id;
  addSession("bitbonsai", "owner-session");
  addSession("igor", "igor-session");
});

test("DELETE DM closes only current account view; POST reopens shared channel and history mapping", async () => {
  const direct = (await import("../src/rooms.ts")).createDirectConversation("bitbonsai", "igor", "bitbonsai");
  const close = await app.request("/api/dms/igor", { method: "DELETE", headers: auth("owner-session") });
  expect(close.status).toBe(204);
  expect(db.query("SELECT channel FROM direct_conversations WHERE channel=?").get(direct.channel)).toBeTruthy();
  expect(db.query("SELECT channel FROM channels WHERE channel=?").get(direct.channel)).toBeTruthy();
  expect(db.query("SELECT COUNT(*) AS count FROM channel_members WHERE channel=?").get(direct.channel)).toEqual({ count: 2 });
  expect((await import("../src/rooms.ts")).directConversations("bitbonsai")).toEqual([]);
  expect((await import("../src/rooms.ts")).directConversations("igor")).toEqual([{ channel: direct.channel, nick: "bitbonsai" }]);

  const reopen = await app.request("/api/dms/igor", { method: "POST", headers: auth("owner-session") });
  expect(reopen.status).toBe(200);
  expect((await import("../src/rooms.ts")).directConversations("bitbonsai")).toEqual([{ channel: direct.channel, nick: "igor" }]);
});

test("mixed recipients create group invites for unknown emails and acceptance lands in group", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const key = randomBytes(18).toString("hex");
  // igor is discoverable only through a shared room; there is no global human directory.
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#g-shared', 'bitbonsai', 'secret', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#g-shared', 'bitbonsai'), ('#g-shared', 'igor')").run();
  const response = await app.request("/api/conversations", { method: "POST", headers: {
    ...auth("owner-session"), "Idempotency-Key": key,
  }, body: JSON.stringify({ recipients: [{ accountId: igorId }, { email: "guest@example.test" }] }) });
  try {
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.conversation.type).toBe("group");
    const invite = db.query("SELECT channel,destination_type FROM invites WHERE email='guest@example.test'").get();
    expect(invite).toEqual({ channel: result.conversation.channel, destination_type: "group" });
    const topic = (db.query("SELECT topic FROM channels WHERE channel=?").get(result.conversation.channel) as { topic: string }).topic;
    expect(topic).not.toContain("guest@example.test");
    expect(topic).toContain("igor");
    const loggedLink = messages[0].text.match(/https:\/\/[^\s]+\/join\/([A-Za-z0-9_-]+)/)?.[1];
    expect(loggedLink).toBeTruthy();

    const newcomer = await accounts.provisionAccount("Guest", "guest@example.test");
    db.query("UPDATE accounts SET verified_at=? WHERE nick=?").run(Date.now(), newcomer.nick);
    addSession(newcomer.nick, "guest-session");
    const accepted = await app.request(`/api/join/${loggedLink}`, { method: "POST", headers: auth("guest-session") });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ type: "group", channel: result.conversation.channel, accepted: true });
    expect(db.query("SELECT 1 FROM channel_members WHERE channel=? AND nick=?").get(result.conversation.channel, newcomer.nick)).toBeTruthy();
  } finally { log.mockRestore(); }
});

test("two unknown email recipients share one group destination", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const response = await app.request("/api/conversations", { method: "POST", headers: {
    ...auth("owner-session"), "Idempotency-Key": randomBytes(18).toString("hex"),
  }, body: JSON.stringify({ recipients: [{ email: "one@example.test" }, { email: "two@example.test" }] }) });
  try {
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.conversation.type).toBe("group");
    expect(db.query("SELECT DISTINCT channel,destination_type FROM invites").all()).toEqual([{ channel: result.conversation.channel, destination_type: "group" }]);
    const topic = (db.query("SELECT topic FROM channels WHERE channel=?").get(result.conversation.channel) as { topic: string }).topic;
    expect(topic).not.toContain("@example.test");
  } finally { log.mockRestore(); }
});

test("failed partial response replays original 207 without another group or send", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  sendOverride = async () => ({ data: null, error: { message: "confirmed rejection" } });
  const key = randomBytes(18).toString("hex");
  const request = () => app.request("/api/conversations", { method: "POST", headers: {
    ...auth("owner-session"), "Idempotency-Key": key,
  }, body: JSON.stringify({ recipients: [{ email: "one@example.test" }, { email: "two@example.test" }] }) });
  try {
    const first = await request();
    expect(first.status).toBe(207);
    expect((await first.json()).recipients.map((r: any) => r.status)).toEqual(["failed", "failed"]);
    const second = await request();
    expect(second.status).toBe(207);
    expect((await second.json()).recipients.map((r: any) => r.status)).toEqual(["failed", "failed"]);
    expect(provisionedChannels).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS count FROM invites").get()).toEqual({ count: 2 });
    expect(messages).toHaveLength(2);
  } finally { log.mockRestore(); }
});

test("fresh quota rows enforce batch and zero limits before side effects", async () => {
  db.query("INSERT INTO accounts (nick,email,role,verified_at,created_at) VALUES ('fresh','fresh@example.com','member',1,1)").run();
  addSession("fresh", "fresh-session");
  const freshId = (db.query("SELECT account_id FROM accounts WHERE nick='fresh'").get() as { account_id: string }).account_id;
  const body = JSON.stringify({ recipients: Array.from({ length: 10 }, (_, i) => ({ email: `p${i}@example.test` })) });
  const request = (key: string) => app.request("/api/conversations", { method: "POST", headers: {
    ...auth("fresh-session"), "Idempotency-Key": key,
  }, body });
  const key = randomBytes(18).toString("hex");
  expect((await request(key)).status).toBe(403);
  expect((await request(key)).status).toBe(403);
  expect(db.query("SELECT 1 FROM email_invite_quota WHERE account_id=?").get(freshId)).toBeNull();
  expect(db.query("SELECT COUNT(*) AS count FROM invites").get()).toEqual({ count: 0 });
  expect(db.query("SELECT COUNT(*) AS count FROM channels WHERE is_group=1").get()).toEqual({ count: 0 });

  process.env.EMAIL_INVITE_LIMIT = "0";
  const anotherKey = randomBytes(18).toString("hex");
  expect((await app.request("/api/conversations", { method: "POST", headers: {
    ...auth("fresh-session"), "Idempotency-Key": anotherKey,
  }, body: JSON.stringify({ recipients: [{ email: "one@example.test" }] }) })).status).toBe(403);
  expect(db.query("SELECT 1 FROM email_invite_quota WHERE account_id=?").get(freshId)).toBeNull();
  process.env.EMAIL_INVITE_LIMIT = "9";
});

test("concurrent different-key resend cannot rotate while first delivery is pending", async () => {
  const invite = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: ownerId(),
    email: "pending@example.test", destination: { type: "dm", channel: null } });
  invites.reserveEmailInvite(ownerId());
  invites.settleEmailInvite(ownerId(), "sent");
  invites.recordEmailInviteDelivery(invite.token, "sent");
  const oldHash = (db.query("SELECT token_hash FROM invites WHERE invitation_id=?").get(invite.id) as { token_hash: string }).token_hash;
  let release!: (value: any) => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const deferred = new Promise<any>((resolve) => { release = resolve; });
  sendOverride = async () => { entered(); return deferred; };
  const request = (key: string) => app.request(`/api/invitations/${invite.id}/resend`, { method: "POST", headers: {
    ...auth("owner-session"), "Idempotency-Key": key,
  } });
  const firstKey = randomBytes(18).toString("hex");
  const firstPromise = request(firstKey);
  await enteredPromise;
  const claimedHash = (db.query("SELECT token_hash FROM invites WHERE invitation_id=?").get(invite.id) as { token_hash: string }).token_hash;
  expect(claimedHash).not.toBe(oldHash);
  const secondKey = randomBytes(18).toString("hex");
  const second = await request(secondKey);
  expect(second.status).toBe(409);
  expect((await request(secondKey)).status).toBe(409);
  expect((db.query("SELECT token_hash FROM invites WHERE invitation_id=?").get(invite.id) as { token_hash: string }).token_hash).toBe(claimedHash);
  release({ data: null, error: { message: "confirmed failure" } });
  const first = await firstPromise;
  expect(first.status).toBe(500);
  expect((await request(firstKey)).status).toBe(500);
  expect(db.query("SELECT token_hash,delivery_state FROM invites WHERE invitation_id=?").get(invite.id)).toEqual({ token_hash: oldHash, delivery_state: "sent" });
  expect(invites.emailInvitesRemaining(ownerId())).toBe(8);
  sendOverride = async () => { throw new Error("connection dropped"); };
  const uncertain = await request(randomBytes(18).toString("hex"));
  expect(uncertain.status).toBe(200);
  expect(await uncertain.json()).toMatchObject({ status: "uncertain" });
  expect(db.query("SELECT delivery_state FROM invites WHERE invitation_id=?").get(invite.id)).toEqual({ delivery_state: "uncertain" });
  const callsAfterUncertain = messages.length;
  const blocked = await request(randomBytes(18).toString("hex"));
  expect(blocked.status).toBe(409);
  expect(messages).toHaveLength(callsAfterUncertain);
  expect(invites.emailInvitesRemaining(ownerId())).toBe(7);
});

test("invitation signup for an address that already has an account mails a sign-in link instead", async () => {
  const existing = accounts.accountByNick("igor")!;
  const invite = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: ownerId(),
    email: existing.email, destination: { type: "dm", channel: null } });
  invites.recordEmailInviteDelivery(invite.token, "sent");
  const signup = await app.request("/auth/invitation/request", { method: "POST",
    headers: { Origin: "https://app.example.test", "X-Slirc-Invitation": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ token: invite.token, name: "Ignored" }) });
  expect(signup.status).toBe(202);
  expect(await signup.json()).toEqual({ sent: true });
  // A forwarded invitation must not open someone's existing account.
  expect(signup.headers.get("set-cookie")).toBeNull();
  expect(messages.at(-1).to).toBe(existing.email);
  const verificationUrl = messages.at(-1).text.match(/https:\/\/[^\s]+\/auth\/verify\?[^\s]+/)?.[0];
  expect(new URL(verificationUrl!).searchParams.get("next")).toBe(`/join/${invite.token}`);
});

test("invitation signup signs a new address in on the spot and refuses cross-site requests", async () => {
  const invite = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: ownerId(),
    email: "new-person@example.test", destination: { type: "dm", channel: null } });
  invites.recordEmailInviteDelivery(invite.token, "sent");
  const body = JSON.stringify({ token: invite.token, name: "New Person" });
  const sameSite = { Origin: "https://app.example.test", "X-Slirc-Invitation": "1", "Content-Type": "application/json" };
  // A cross-site form or fetch cannot send the custom header or the right Origin: no account, no session.
  for (const headers of [{ "Content-Type": "application/json" }, { ...sameSite, Origin: "https://evil.example" }, { ...sameSite, "X-Slirc-Invitation": "0" }]) {
    const refused = await app.request("/auth/invitation/request", { method: "POST", headers, body });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();
  }
  expect(accounts.accountByEmail("new-person@example.test")).toBeNull();
  const sent = messages.length;
  const signup = await app.request("/auth/invitation/request", { method: "POST", headers: sameSite, body });
  expect(signup.status).toBe(200);
  const person = accounts.accountByEmail("new-person@example.test")!;
  expect(await signup.json()).toEqual({ signedIn: true, accountId: person.id, nick: person.nick });
  // The invitation link proved the mailbox: verified, signed in, and no second email.
  expect(person.verifiedAt).toBeTruthy();
  expect(messages).toHaveLength(sent);
  const cookie = signup.headers.get("set-cookie")?.match(/slirc_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  const accepted = await app.request(`/api/join/${invite.token}`, { method: "POST", headers: auth(cookie!) });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ type: "direct", nick: "bitbonsai" });
  expect(db.query("SELECT 1 FROM direct_conversations WHERE first_nick='bitbonsai' AND second_nick=?").get(person.nick)).toBeTruthy();

  const publicSignup = await app.request("/auth/request", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "not-invited@example.test" }) });
  // This file runs as the public playground, which signs up an unknown address: provisional,
  // unverified and without a session until the mailed link proves it (open-chat-signup.test.ts).
  expect(publicSignup.status).toBe(204);
  await settleSignIns();
  expect(publicSignup.headers.get("set-cookie") || "").not.toMatch(/slirc_session=[^;]/);
  expect(accounts.accountByEmail("not-invited@example.test")?.verifiedAt).toBeNull();
});

test("invitation emails flatten control characters in the inviter's profile name", async () => {
  db.query("INSERT INTO profiles (account, full_name) VALUES ('bitbonsai', ?) ON CONFLICT(account) DO UPDATE SET full_name=excluded.full_name")
    .run("Mallory\r\nBcc: victim@example.test\u0085\u2028Eve <b>x</b>");
  const response = await app.request("/api/conversations", { method: "POST", headers: {
    ...auth("owner-session"), "Idempotency-Key": randomBytes(18).toString("hex"),
  }, body: JSON.stringify({ recipients: [{ email: "header-test@example.test" }] }) });
  expect(response.status).toBe(200);
  const sent = messages.at(-1);
  expect(sent.to).toBe("header-test@example.test");
  // One line, no injected header, and the verified address sits next to the name.
  expect(sent.subject).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
  expect(sent.subject).toBe("Mallory Bcc: victim@example.test Eve <b>x</b> invited you to chat on app.example.test");
  expect(sent.text).toContain("Mallory Bcc: victim@example.test Eve <b>x</b> (");
  expect(sent.html).toContain("Eve &lt;b&gt;x&lt;/b&gt; (");
  expect(sent.html).not.toContain("<b>x</b>");
});

// The invitation page never learns the invited address, so it types the mailed code with the token.
const inviteCodeHeaders = { Origin: "https://app.example.test", "X-Slirc-Invitation": "1", "Content-Type": "application/json" };
const emailCodeHeaders = { Origin: "https://app.example.test", "X-Slirc-Sign-In": "1", "Content-Type": "application/json" };
const postInviteCode = (body: unknown, headers: Record<string, string> = inviteCodeHeaders) =>
  app.request("/auth/code", { method: "POST", headers, body: JSON.stringify(body) });
const mintCode = (nick: string, code: string) => db.query("INSERT INTO magic_links (token_hash, nick, expires_at, created_at, code_hash) VALUES (?, ?, ?, ?, ?)")
  .run(sessionHash(`link-${nick}-${code}-${randomBytes(4).toString("hex")}`), nick, Date.now() + 15 * 60_000, Date.now(), sessionHash(`${nick.toLowerCase()}:${code}`));
function inviteFor(email: string) {
  const invite = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: ownerId(), email, destination: { type: "dm", channel: null } });
  invites.recordEmailInviteDelivery(invite.token, "sent");
  return invite;
}

test("the code mailed for an invitation signs the invited account in with only the token", async () => {
  const { resetRateLimits } = await import("../src/request-security.ts");
  resetRateLimits();
  db.query("DELETE FROM magic_links").run();
  const existing = accounts.accountByNick("igor")!;
  const invite = inviteFor(existing.email);
  const signup = await app.request("/auth/invitation/request", { method: "POST", headers: inviteCodeHeaders, body: JSON.stringify({ token: invite.token }) });
  expect(signup.status).toBe(202);
  const code = messages.at(-1).text.match(/\b(\d{3}) ?(\d{3})\b/)!.slice(1).join("");
  const response = await postInviteCode({ invitation: invite.token, code });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(existing.email);
  expect(response.headers.get("set-cookie")).toContain("slirc_acct=igor");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(db.query("SELECT 1 FROM magic_links WHERE nick = 'igor'").get()).toBeNull();
  // The session it opened can accept the invitation, as the link path does.
  const session = response.headers.get("set-cookie")!.match(/slirc_session=([^;]+)/)![1];
  const accepted = await app.request(`/api/join/${invite.token}`, { method: "POST", headers: auth(session) });
  expect(accepted.status).toBe(200);
});

test("an invitation code needs the same-origin invitation header, and never both an email and a token", async () => {
  const { resetRateLimits } = await import("../src/request-security.ts");
  resetRateLimits();
  db.query("DELETE FROM magic_links").run();
  const existing = accounts.accountByNick("igor")!;
  const invite = inviteFor(existing.email);
  mintCode("igor", "135790");
  for (const headers of [{ "Content-Type": "application/json" }, { ...inviteCodeHeaders, Origin: "https://evil.example" }, { ...inviteCodeHeaders, "X-Slirc-Invitation": "0" }]) {
    const refused = await postInviteCode({ invitation: invite.token, code: "135790" }, headers);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();
  }
  const both = await postInviteCode({ invitation: invite.token, email: existing.email, code: "135790" });
  expect(both.status).toBe(400);
  expect(await both.json()).toEqual({ error: "That code is wrong or expired. Try again, or request a new one." });
  expect(both.headers.get("set-cookie")).toBeNull();
  // Neither refusal spent the code.
  expect((await postInviteCode({ invitation: invite.token, code: "135790" })).status).toBe(200);
});

test("invitation codes miss like email codes: same answers, five misses burn the row", async () => {
  const { resetRateLimits } = await import("../src/request-security.ts");
  resetRateLimits();
  db.query("DELETE FROM magic_links").run();
  const existing = accounts.accountByNick("igor")!;
  const invite = inviteFor(existing.email);
  mintCode("igor", "246802");
  const wrong = { error: "That code is wrong or expired. Try again, or request a new one." };
  // Unknown, malformed, cancelled and expired invitations answer exactly like a wrong code and
  // do not touch the account's live code.
  const cancelled = inviteFor("cancelled@example.test");
  db.query("UPDATE invites SET cancelled_at = ? WHERE invitation_id = ?").run(Date.now(), cancelled.id);
  const expired = inviteFor(existing.email);
  db.query("UPDATE invites SET expires_at = ? WHERE invitation_id = ?").run(Date.now() - 1, expired.id);
  for (const invitation of [randomBytes(24).toString("base64url"), "short", 42, cancelled.token, expired.token]) {
    const response = await postInviteCode({ invitation, code: "246802" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(wrong);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  expect((db.query("SELECT attempts FROM magic_links WHERE nick = 'igor'").get() as { attempts: number }).attempts).toBe(0);
  // An invitation addressed to someone else cannot spend or guess igor's code.
  const other = inviteFor("owner@example.com");
  const crossed = await postInviteCode({ invitation: other.token, code: "246802" });
  expect(crossed.status).toBe(400);
  expect(crossed.headers.get("set-cookie")).toBeNull();
  expect((db.query("SELECT attempts FROM magic_links WHERE nick = 'igor'").get() as { attempts: number }).attempts).toBe(0);
  // An address with no account yet has no code to type.
  expect(await (await postInviteCode({ invitation: inviteFor("nobody-yet@example.test").token, code: "246802" })).json()).toEqual(wrong);
  // Misses through the token and through the email count on the same row.
  for (let i = 0; i < 3; i++) expect(await (await postInviteCode({ invitation: invite.token, code: "000000" })).json()).toEqual(wrong);
  for (let i = 0; i < 2; i++) await app.request("/auth/code", { method: "POST", headers: emailCodeHeaders, body: JSON.stringify({ email: existing.email, code: "000000" }) });
  expect(db.query("SELECT 1 FROM magic_links WHERE nick = 'igor'").get()).toBeNull();
  const late = await postInviteCode({ invitation: invite.token, code: "246802" });
  expect(late.status).toBe(400);
  expect(await late.json()).toEqual(wrong);
  // Only the fixture session exists: no attempt above opened one.
  expect(db.query("SELECT COUNT(*) AS count FROM sessions WHERE nick = 'igor'").get()).toEqual({ count: 1 });
});

test("invitation codes share the per-peer limit with email codes", async () => {
  const { resetRateLimits } = await import("../src/request-security.ts");
  resetRateLimits();
  db.query("DELETE FROM magic_links").run();
  const invite = inviteFor(accounts.accountByNick("igor")!.email);
  for (let i = 0; i < 20; i++) await postInviteCode({ invitation: randomBytes(24).toString("base64url"), code: "999999" });
  mintCode("igor", "112233");
  expect((await postInviteCode({ invitation: invite.token, code: "112233" })).status).toBe(429);
  expect((await app.request("/auth/code", { method: "POST", headers: emailCodeHeaders, body: JSON.stringify({ email: "igor@example.com", code: "112233" }) })).status).toBe(429);
});

test("an invitation code never reaches an unverified account or one the invitation is not bound to", async () => {
  const { resetRateLimits } = await import("../src/request-security.ts");
  resetRateLimits();
  db.query("DELETE FROM magic_links").run();
  const wrong = { error: "That code is wrong or expired. Try again, or request a new one." };
  // Bound to another account id: the invited address resolves to igor, the binding says otherwise.
  const existing = accounts.accountByNick("igor")!;
  const bound = invites.createEmailInvite({ inviter: "bitbonsai", inviterAccountId: ownerId(), email: existing.email, destination: { type: "dm", channel: null }, recipientAccountId: ownerId() });
  invites.recordEmailInviteDelivery(bound.token, "sent");
  mintCode("igor", "314159");
  const mismatch = await postInviteCode({ invitation: bound.token, code: "314159" });
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toEqual(wrong);
  expect(mismatch.headers.get("set-cookie")).toBeNull();
  expect((db.query("SELECT attempts FROM magic_links WHERE nick = 'igor'").get() as { attempts: number }).attempts).toBe(0);
  // An existing but unverified account: the right code still does not sign it in through a token.
  db.query("INSERT INTO accounts (nick, email, role, verified_at, provisional_expires_at, created_at) VALUES ('nova', 'nova@example.test', 'member', NULL, ?, 1)").run(Date.now() + 60_000);
  try {
    const invite = inviteFor("nova@example.test");
    mintCode("nova", "271828");
    const unverified = await postInviteCode({ invitation: invite.token, code: "271828" });
    expect(unverified.status).toBe(400);
    expect(await unverified.json()).toEqual(wrong);
    expect(unverified.headers.get("set-cookie")).toBeNull();
    expect(db.query("SELECT 1 FROM sessions WHERE nick = 'nova'").get()).toBeNull();
    expect((db.query("SELECT verified_at FROM accounts WHERE nick = 'nova'").get() as { verified_at: number | null }).verified_at).toBeNull();
  } finally {
    db.query("DELETE FROM magic_links WHERE nick = 'nova'").run();
    db.query("DELETE FROM accounts WHERE nick = 'nova'").run();
  }
});
