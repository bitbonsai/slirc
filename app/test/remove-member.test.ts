// Removing a member: any admin, never yourself or another admin. The person is signed out
// everywhere, leaves every channel, is suspended on IRC, and cannot come back by email, join link,
// invitation or admission. Their account row and profile stay so past messages keep their name.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://guild.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
delete process.env.MAGIC_LINK_LOG;

import { createHash } from "node:crypto";
import { beforeEach, expect, mock, test } from "bun:test";

const mailed: string[] = [];
const ircRemovals: { nick: string; channels: string[] }[] = [];
const certificatesRemoved: string[] = [];
mock.module("resend", () => ({ Resend: class { emails = { send: async (payload: any) => { mailed.push(String(payload.to)); return { data: { id: "m" }, error: null }; } }; } }));
mock.module("../src/grants.ts", () => {
  const noop = async () => {};
  return {
    operClient: noop, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }), readDirectChannelReady: async () => true,
    serviceCommand: noop, setAlwaysOn: noop, transferChannel: noop, allowChannelAccess: noop,
    grantChannelAccess: noop, createChannel: noop, setChannelMode: noop, setChannelTopic: noop,
    revokeChannelAccess: noop, createDirectChannel: noop, createThreadChannel: noop,
    NotAuthorizedError: class NotAuthorizedError extends Error {}, redactMessage: noop,
    kickChannelMember: noop, makeChannelSecret: noop, makeThreadChannelsSecret: noop, removeFromThreadChannels: noop, makeChannelOpen: noop, clearChannelAccess: noop,
    unregisterChannel: noop, purgeChannelHistory: noop, renameChannel: noop, grantChannelOps: noop,
    removeMemberFromIrc: async (nick: string, channels: string[]) => { ircRemovals.push({ nick, channels }); return { suspended: true }; },
  };
});
mock.module("../src/irc-certificates.ts", () => ({
  addCertificate: async () => {},
  normalizeCertificateFingerprint: (value: string) => value,
  listCertificates: async (account: string) => {
    if (account === "zoe") throw new Error("NickServ CERT failed: Try again later");
    return account === "igor" ? ["aa".repeat(32)] : [];
  },
  removeCertificate: async (account: string, _password: string, fingerprint: string) => { certificatesRemoved.push(`${account}:${fingerprint}`); },
}));

process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
const accounts = await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const { createEmailInvite } = await import("../src/email-invites.ts");
const { createJoinLink, markInviteFromLink } = await import("../src/join-links.ts");
const { trackSocket } = await import("../src/relay.ts");

const ORIGIN = "https://guild.example.test";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const cookie = (token: string) => ({ Cookie: `slirc_session=${token}` });
const json = (extra: Record<string, string> = {}) => ({ "Content-Type": "application/json", Origin: ORIGIN, ...extra });
const remove = (token: string, nick: string) => app.request(`/api/admin/accounts/${nick}`, { method: "DELETE", headers: cookie(token) });
const addSession = (nick: string, token: string) => db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(sha(token), nick, Date.now());
const addHuman = (nick: string, role = "member") =>
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES (?, ?, ?, 1, 1)").run(nick, `${nick}@example.com`, role);
let ownerId = "";

beforeEach(() => {
  mailed.length = 0;
  ircRemovals.length = 0;
  certificatesRemoved.length = 0;
  db.exec("DELETE FROM join_links; DELETE FROM invites; DELETE FROM client_tokens; DELETE FROM sessions; DELETE FROM magic_links; DELETE FROM channel_members; DELETE FROM channels; DELETE FROM subscriptions");
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query("UPDATE accounts SET role = 'admin', verified_at = COALESCE(verified_at, 1), removed_at = NULL WHERE nick = 'bitbonsai'").run();
  ownerId = (db.query("SELECT account_id FROM accounts WHERE nick = 'bitbonsai'").get() as { account_id: string }).account_id;
  addHuman("igor");
  db.query("INSERT INTO profiles (account, full_name) VALUES ('igor', 'Igor Test') ON CONFLICT(account) DO UPDATE SET full_name = excluded.full_name").run();
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#guild', 'bitbonsai', 'secret', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#guild', 'bitbonsai'), ('#guild', 'igor')").run();
  db.query("INSERT INTO subscriptions (endpoint, nick, p256dh, auth, updated_at) VALUES ('https://push.example/igor', 'igor', 'k', 'a', 1)").run();
  db.exec("DELETE FROM irc_devices; DELETE FROM irc_certificates");
  db.query("INSERT INTO irc_devices (id, account, label, created_at) VALUES ('d1', 'igor', 'Halloy', 1)").run();
  db.query("INSERT INTO irc_certificates (id, account, label, fingerprint, created_at) VALUES ('c1', 'igor', 'Laptop', ?, 1)").run("aa".repeat(32));
  addSession("bitbonsai", "admin-token");
  addSession("igor", "igor-phone");
  addSession("igor", "igor-laptop");
});

test("a member can't remove anyone, and the target is untouched", async () => {
  addHuman("ben");
  addSession("ben", "ben-token");
  expect((await remove("ben-token", "igor")).status).toBe(403);
  expect((await remove("igor-phone", "bitbonsai")).status).toBe(403);
  expect(ircRemovals).toEqual([]);
  expect(accounts.accountByNick("igor")?.verifiedAt).toBe(1);
  expect((db.query("SELECT COUNT(*) AS n FROM sessions WHERE nick = 'igor'").get() as { n: number }).n).toBe(2);
});

test("an admin removes a person: signed out everywhere, out of every channel, suspended on IRC", async () => {
  const clientTokenHash = sha("igor-client-token");
  db.query("INSERT INTO client_tokens (token_hash, session_hash, nick, created_at, expires_at) VALUES (?, ?, 'igor', ?, ?)")
    .run(clientTokenHash, sha("igor-phone"), Date.now(), Date.now() + 60_000);
  let closedClientSocket = false;
  trackSocket(clientTokenHash, { close: () => { closedClientSocket = true; }, data: { tokenHash: clientTokenHash, nick: "igor", ip: "127.0.0.1", awaitingAuthenticate: false } });
  expect((await remove("admin-token", "Igor")).status).toBe(204);
  expect(ircRemovals).toHaveLength(1);
  expect(ircRemovals[0]!.nick).toBe("igor");
  expect(ircRemovals[0]!.channels).toEqual(expect.arrayContaining(["#guild", "#help", "#support"]));
  expect(db.query("SELECT 1 FROM sessions WHERE nick = 'igor'").get()).toBeNull();
  expect(db.query("SELECT 1 FROM client_tokens WHERE nick = 'igor'").get()).toBeNull();
  expect(closedClientSocket).toBe(true);
  expect(db.query("SELECT 1 FROM channel_members WHERE nick = 'igor'").get()).toBeNull();
  expect(db.query("SELECT 1 FROM subscriptions WHERE nick = 'igor'").get()).toBeNull();
  // IRC clients lose their password and certificates.
  expect((db.query("SELECT irc_password_gen FROM accounts WHERE nick = 'igor'").get() as { irc_password_gen: number }).irc_password_gen).toBe(1);
  expect(certificatesRemoved).toEqual([`igor:${"aa".repeat(32)}`]);
  expect(db.query("SELECT 1 FROM irc_devices WHERE account = 'igor'").get()).toBeNull();
  expect(db.query("SELECT 1 FROM irc_certificates WHERE account = 'igor'").get()).toBeNull();
  const me = await (await app.request("/auth/me", { headers: cookie("igor-phone") })).json();
  expect(me.authenticated).toBe(false);
  // The row and profile stay so their name still shows on past messages; the flag is the undo handle.
  const row = db.query("SELECT removed_at, verified_at FROM accounts WHERE nick = 'igor'").get() as { removed_at: number | null; verified_at: number | null };
  expect(row.removed_at).toBeGreaterThan(0);
  expect(row.verified_at).toBeNull();
  expect((db.query("SELECT full_name FROM profiles WHERE account = 'igor'").get() as { full_name: string }).full_name).toBe("Igor Test");
  expect(accounts.accountByNick("igor")).toBeNull();
  // Repeating it retries the IRC half without failing.
  expect((await remove("admin-token", "igor")).status).toBe(204);
});

test("any admin can remove a member, but never themselves, another admin or an agent", async () => {
  expect((await remove("admin-token", "bitbonsai")).status).toBe(400);
  db.query("INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at) VALUES ('igorbot', 'bot@agents.invalid', 'member', 'agent', 'igor', 1, 1)").run();
  expect((await remove("admin-token", "igorbot")).status).toBe(404);
  addHuman("ada", "admin");
  addSession("ada", "ada-token");
  // Admins can't remove each other, in either direction, so the last admin always stays.
  const refused = await remove("ada-token", "bitbonsai");
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toBe("You can't remove another admin.");
  expect((await remove("admin-token", "ada")).status).toBe(403);
  expect((await remove("ada-token", "ada")).status).toBe(400);
  // A second admin, not the instance owner, removes a member the same way.
  db.query("DELETE FROM accounts WHERE nick = 'igorbot'").run();
  expect((await remove("ada-token", "igor")).status).toBe(204);
  expect(ircRemovals.map((call) => call.nick)).toEqual(["igor"]);
});

test("a removed person can't sign in or come back by join link, invitation or new signup", async () => {
  expect((await remove("admin-token", "igor")).status).toBe(204);
  // Email sign-in: same quiet answer as an unknown address, and no link is minted.
  expect((await app.request("/auth/request", { method: "POST", headers: json(), body: JSON.stringify({ email: "IGOR@example.com" }) })).status).toBe(204);
  expect(db.query("SELECT 1 FROM magic_links WHERE nick = 'igor'").get()).toBeNull();
  expect(mailed).toEqual([]);
  // A code typed against the old address is rejected.
  expect((await app.request("/auth/code", { method: "POST", headers: json({ "X-Slirc-Sign-In": "1" }), body: JSON.stringify({ email: "igor@example.com", code: "123456" }) })).status).toBe(400);
  // A new signup with the same email is refused and does not replace the row.
  await expect(accounts.provisionAccount("Igor Again", "igor@example.com")).rejects.toThrow("can't join");
  expect((db.query("SELECT COUNT(*) AS n FROM accounts WHERE email = 'igor@example.com'").get() as { n: number }).n).toBe(1);
  // Join link: the request answers like any other, but sends nothing.
  const { link, token } = createJoinLink({ owner: "bitbonsai", ownerAccountId: ownerId, channel: "#guild" });
  const asked = await app.request(`/api/join-links/${token}/request`, { method: "POST", headers: json({ "X-Slirc-Join": "1" }), body: JSON.stringify({ email: "igor@example.com" }) });
  expect(asked.status).toBe(202);
  expect(mailed).toEqual([]);
  // An invitation sent before the removal can't make the account again.
  const invite = createEmailInvite({ inviter: "bitbonsai", inviterAccountId: ownerId, email: "igor@example.com", destination: { type: "channel", channel: "#guild" } });
  markInviteFromLink(invite.id, link.id);
  db.query("UPDATE invites SET delivery_state = 'sent' WHERE invitation_id = ?").run(invite.id);
  const accepted = await app.request("/auth/invitation/request", { method: "POST", headers: json({ "X-Slirc-Invitation": "1" }), body: JSON.stringify({ token: invite.token, name: "Igor" }) });
  expect(accepted.status).toBe(400);
  expect(accepted.headers.get("set-cookie") || "").not.toContain("slirc_session=");
  expect(db.query("SELECT 1 FROM sessions WHERE nick = 'igor'").get()).toBeNull();
  expect(db.query("SELECT 1 FROM channel_members WHERE nick = 'igor'").get()).toBeNull();
  // Nothing re-verifies the row behind the flag's back.
  accounts.markVerified("igor");
  expect(accounts.accountByNick("igor")).toBeNull();
});

test("an IRC failure after the app half comes back as a JSON error the dialog can show", async () => {
  // Not 502: Cloudflare replaces an origin 502 body with its own page, so the message never arrives.
  addHuman("zoe");
  const response = await remove("admin-token", "zoe");
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "NickServ CERT failed: Try again later" });
  expect((db.query("SELECT removed_at FROM accounts WHERE nick = 'zoe'").get() as { removed_at: number | null }).removed_at).toBeGreaterThan(0);
});
