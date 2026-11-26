// Open join links: an admin makes one for a channel, anyone with it can ask to join by email.
// Opening the link (a chat preview) changes nothing; only a new member who proved their mailbox
// takes a place; an existing account signs in and takes none; revoked or expired links fail
// closed; two people racing for the last place get exactly one.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://guild.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";

import { createHash } from "node:crypto";
import { beforeEach, expect, mock, test } from "bun:test";

const mailed: { to: string; key: string }[] = [];
mock.module("resend", () => ({ Resend: class { emails = { send: async (payload: any, options?: any) => {
  if (String(payload.to).startsWith("bounce")) return { data: null, error: { message: "rejected" } };
  mailed.push({ to: payload.to, key: options?.idempotencyKey }); return { data: { id: "m" }, error: null };
} }; } }));
mock.module("../src/grants.ts", () => {
  const noop = async () => {};
  return {
    grantChannelOps: noop,
    operClient: noop, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }), readDirectChannelReady: async () => true,
    serviceCommand: noop, setAlwaysOn: noop, transferChannel: noop, allowChannelAccess: noop,
    grantChannelAccess: noop, createChannel: noop, setChannelMode: noop, setChannelTopic: noop,
    revokeChannelAccess: noop, createDirectChannel: noop, createThreadChannel: noop,
    NotAuthorizedError: class NotAuthorizedError extends Error {}, redactMessage: noop,
    kickChannelMember: noop, makeChannelSecret: noop, makeThreadChannelsSecret: noop, removeFromThreadChannels: noop, makeChannelOpen: noop, clearChannelAccess: noop,
    unregisterChannel: noop, purgeChannelHistory: noop, renameChannel: noop, removeMemberFromIrc: async () => ({ suspended: true }),
  };
});

process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { createEmailInvite } = await import("../src/email-invites.ts");
const { createJoinLink, markInviteFromLink } = await import("../src/join-links.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ORIGIN = "https://guild.example.test";
const json = (extra: Record<string, string> = {}) => ({ "Content-Type": "application/json", Origin: ORIGIN, ...extra });
let ownerId = "";

beforeEach(() => {
  mailed.length = 0;
  db.exec("DELETE FROM join_links; DELETE FROM invites; DELETE FROM sessions; DELETE FROM channel_members; DELETE FROM channels");
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query("UPDATE accounts SET role = 'admin', verified_at = COALESCE(verified_at, 1) WHERE nick = 'bitbonsai'").run();
  ownerId = (db.query("SELECT account_id FROM accounts WHERE nick = 'bitbonsai'").get() as { account_id: string }).account_id;
  for (const channel of ["#guild", "#secret-plans"]) {
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, 'bitbonsai', 'secret', 1)").run(channel);
    db.query("INSERT INTO channel_members (channel, nick) VALUES (?, 'bitbonsai')").run(channel);
  }
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sha("owner-token"), Date.now());
});

function link(options: { maxJoins?: number } = {}) {
  return createJoinLink({ owner: "bitbonsai", ownerAccountId: ownerId, channel: "#guild", ...options });
}
const ask = (token: string, email: string) => app.request(`/api/join-links/${token}/request`, { method: "POST", headers: json({ "X-Slirc-Join": "1" }), body: JSON.stringify({ email }) });
const joinsOf = (id: string) => db.query("SELECT joins, sends FROM join_links WHERE id = ?").get(id) as { joins: number; sends: number };
const signUp = (token: string, name: string) => app.request("/auth/invitation/request", { method: "POST", headers: json({ "X-Slirc-Invitation": "1" }), body: JSON.stringify({ token, name }) });
function inviteFor(linkId: string, email: string): string {
  const invite = createEmailInvite({ inviter: "bitbonsai", inviterAccountId: ownerId, email, destination: { type: "channel", channel: "#guild" } });
  markInviteFromLink(invite.id, linkId);
  db.query("UPDATE invites SET delivery_state = 'sent' WHERE invitation_id = ?").run(invite.id);
  return invite.token;
}

const listLinks = async (cookie = "slirc_session=owner-token") => (await app.request("/api/join-links", { headers: { Cookie: cookie } })).json();

test("an admin makes a link and can read its URL back from the list, and nobody else can", async () => {
  const response = await app.request("/api/join-links", { method: "POST", headers: json({ Cookie: "slirc_session=owner-token", "X-Slirc-Join": "1" }), body: JSON.stringify({ channel: "guild" }) });
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body).toMatchObject({ channel: "#guild", joins: 0, maxJoins: 99, state: "open" });
  const token = String(body.url).split("/j/")[1]!;
  expect(token.length).toBeGreaterThanOrEqual(32);
  const list = await listLinks();
  expect(list.links).toHaveLength(1);
  expect(list.links[0].url).toBe(body.url);
  // Another admin lists only their own links; a member gets none.
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('ada', 'ada@example.com', 'admin', 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'ada', ?)").run(sha("ada-token"), Date.now());
  expect(JSON.stringify(await listLinks("slirc_session=ada-token"))).not.toContain(token);
  db.query("UPDATE accounts SET role = 'member' WHERE nick = 'ada'").run();
  expect(JSON.stringify(await listLinks("slirc_session=ada-token"))).not.toContain(token);
  // The link's own page never carries it beyond its address.
  expect(await (await app.request(`/j/${token}`)).text()).not.toContain(`/j/${token}`);
});

test("revoking or expiring a link clears its stored token; older links have none to copy", async () => {
  const revoked = link(), expired = link(), older = link();
  db.query("UPDATE join_links SET expires_at = ? WHERE id = ?").run(Date.now() - 1, expired.link.id);
  db.query("UPDATE join_links SET token = NULL WHERE id = ?").run(older.link.id);
  expect((await app.request(`/api/join-links/${revoked.link.id}`, { method: "DELETE", headers: json({ Cookie: "slirc_session=owner-token", "X-Slirc-Join": "1" }) })).status).toBe(204);
  const list = await listLinks();
  expect(list.links.map((row: any) => row.url)).toEqual([null, null, null]);
  for (const { token } of [revoked, expired]) expect(JSON.stringify(db.query("SELECT * FROM join_links").all())).not.toContain(token);
  // The older link still works by its hash.
  expect(await (await app.request(`/j/${older.token}`)).text()).toContain('data-state="open"');
});

test("a member who is not an admin cannot make a link", async () => {
  db.query("UPDATE accounts SET role = 'member' WHERE nick = 'bitbonsai'").run();
  const response = await app.request("/api/join-links", { method: "POST", headers: json({ Cookie: "slirc_session=owner-token", "X-Slirc-Join": "1" }), body: JSON.stringify({ channel: "guild" }) });
  expect(response.status).toBe(403);
});

test("opening the link, as a chat preview does, uses no place and sends no mail, and names nobody", async () => {
  const { link: made, token } = link();
  for (let i = 0; i < 3; i++) {
    const page = await app.request(`/j/${token}`, { headers: { "User-Agent": "Slackbot-LinkExpanding 1.0" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<meta property="og:title" content="Join guild.example.test on Slirc">');
    expect(html).toContain('data-state="open"');
    expect(html).not.toContain('data-state="closed"');
    expect(html).not.toContain("bitbonsai");
    expect(html).not.toContain("#guild");
  }
  expect(joinsOf(made.id)).toEqual({ joins: 0, sends: 0 });
  expect(mailed).toHaveLength(0);
});

test("asking to join mails one invitation per address, for the link's channel only", async () => {
  const { link: made, token } = link();
  expect((await ask(token, "Ana@Example.test")).status).toBe(202);
  expect((await ask(token, "ana@example.test")).status).toBe(202);
  expect(mailed.map((mail) => mail.to)).toEqual(["ana@example.test"]);
  expect(mailed[0]!.key.startsWith("invite/")).toBe(true);
  const invites = db.query("SELECT channel, email, join_link_id FROM invites").all();
  expect(invites).toEqual([{ channel: "#guild", email: "ana@example.test", join_link_id: made.id }]);
  // Mailing is not joining.
  expect(joinsOf(made.id)).toEqual({ joins: 0, sends: 1 });
});

test("an address with an account gets a sign-in link, the same answer, and takes no place", async () => {
  const { link: made, token } = link();
  db.query("INSERT INTO accounts (nick, email, role, kind, owner, verified_at, created_at) VALUES ('ben', 'ben@example.test', 'member', 'human', NULL, 1, 1)").run();
  const known = await ask(token, "ben@example.test");
  const unknown = await ask(token, "new@example.test");
  expect(known.status).toBe(unknown.status);
  expect(await known.json()).toEqual(await unknown.json());
  expect(mailed.map((mail) => [mail.to, mail.key.split("/")[0]])).toEqual([["ben@example.test", "invite-signup"], ["new@example.test", "invite"]]);
  const benInvite = (db.query("SELECT token_hash FROM invites WHERE email = 'ben@example.test'").get() as { token_hash: string });
  expect(benInvite).toBeTruthy();
  expect(joinsOf(made.id).joins).toBe(0);
  expect(db.query("SELECT COUNT(*) AS n FROM accounts WHERE email = 'ben@example.test'").get()).toEqual({ n: 1 });
});

test("a new member who signs up takes one place; the cap stops the next", async () => {
  const { link: made } = link({ maxJoins: 1 });
  const first = await signUp(inviteFor(made.id, "one@example.test"), "One");
  expect(first.status).toBe(200);
  expect((await first.json()).signedIn).toBe(true);
  expect(joinsOf(made.id).joins).toBe(1);
  const second = await signUp(inviteFor(made.id, "two@example.test"), "Two");
  expect(second.status).toBe(409);
  expect((await second.json()).error).toBe("This join link is full.");
  expect(db.query("SELECT COUNT(*) AS n FROM accounts WHERE email = 'two@example.test'").get()).toEqual({ n: 0 });
});

test("two people racing for the last place get exactly one", async () => {
  const { link: made } = link({ maxJoins: 1 });
  const results = await Promise.all([signUp(inviteFor(made.id, "a@example.test"), "Aa"), signUp(inviteFor(made.id, "b@example.test"), "Bb")]);
  expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(joinsOf(made.id).joins).toBe(1);
});

test("a full link sends no more mail", async () => {
  const { link: made, token } = link({ maxJoins: 1 });
  await signUp(inviteFor(made.id, "one@example.test"), "One");
  const response = await ask(token, "late@example.test");
  expect(response.status).toBe(409);
  expect(mailed).toHaveLength(0);
  expect(await (await app.request(`/j/${token}`)).text()).toContain('data-state="full"');
});

test("a revoked or expired link fails closed at every step", async () => {
  for (const close of ["revoke", "expire"] as const) {
    db.exec("DELETE FROM join_links; DELETE FROM invites");
    const { link: made, token } = link();
    const pending = inviteFor(made.id, `${close}@example.test`);
    if (close === "revoke") {
      const revoked = await app.request(`/api/join-links/${made.id}`, { method: "DELETE", headers: json({ Cookie: "slirc_session=owner-token", "X-Slirc-Join": "1" }) });
      expect(revoked.status).toBe(204);
    } else db.query("UPDATE join_links SET expires_at = ? WHERE id = ?").run(Date.now() - 1, made.id);
    expect(await (await app.request(`/j/${token}`)).text()).toContain('data-state="closed"');
    expect((await ask(token, "late@example.test")).status).toBe(410);
    // An invitation the link already mailed closes with it.
    expect((await signUp(pending, "Late")).status).toBe(410);
    expect(joinsOf(made.id).joins).toBe(0);
  }
  expect(mailed).toHaveLength(0);
});

test("an unknown or malformed token gets the closed page and refuses requests", async () => {
  expect(await (await app.request("/j/not-a-real-token-at-all-000000")).text()).toContain('data-state="closed"');
  expect((await ask("not-a-real-token-at-all-000000", "a@example.test")).status).toBe(410);
  expect((await ask("x", "a@example.test")).status).toBe(410);
});

test("requests without the same-origin header are refused", async () => {
  const { token } = link();
  const response = await app.request(`/api/join-links/${token}/request`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ email: "a@example.test" }) });
  expect(response.status).toBe(403);
  expect(mailed).toHaveLength(0);
});

test("a mail that fails gives its send back; a link that sent all its mail says so", async () => {
  const { link: made, token } = link({ maxJoins: 1 });
  expect((await ask(token, "bounce@example.test")).status).toBe(500);
  expect(joinsOf(made.id).sends).toBe(0);
  expect((await ask(token, "a@example.test")).status).toBe(202);
  expect((await ask(token, "b@example.test")).status).toBe(202);
  const spent = await ask(token, "c@example.test");
  expect(spent.status).toBe(409);
  expect((await spent.json()).error).toContain("sent all the email it can");
  expect(await (await app.request(`/j/${token}`)).text()).toContain('data-state="spent"');
  const list = await (await app.request("/api/join-links", { headers: { Cookie: "slirc_session=owner-token" } })).json();
  expect(list.links[0].state).toBe("spent");
});

test("without trusted proxies, visitors do not share one IP bucket", async () => {
  delete process.env.SLIRC_TRUSTED_PROXIES;
  const { token } = link();
  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) statuses.push((await ask(token, `person${i}@example.test`)).status);
  expect(statuses.every((status) => status === 202)).toBe(true);
});

test("a join link's invitation cannot be resent, and a personal invitation never reuses it", async () => {
  const { link: made, token } = link();
  await ask(token, "ana@example.test");
  const linkInvite = db.query("SELECT invitation_id AS id FROM invites WHERE email = 'ana@example.test'").get() as { id: string };
  const resend = await app.request(`/api/invitations/${linkInvite.id}/resend`, { method: "POST", headers: json({ Cookie: "slirc_session=owner-token", "Idempotency-Key": "resend-key-0000000000" }) });
  expect(resend.status).toBe(409);
  expect((await resend.json()).error).toBe("This invitation came from a join link and can't be resent.");
  const { pendingEmailInvite } = await import("../src/email-invites.ts");
  expect(pendingEmailInvite(ownerId, "ana@example.test", { type: "channel", channel: "#guild" })).toBeNull();
  expect(made.id).toBeTruthy();
});

test("links cannot target a group DM, and an admin holds at most five open links", async () => {
  db.query("INSERT INTO channels (channel, owner, visibility, created_at, is_group) VALUES ('#g-friends', 'bitbonsai', 'secret', 1, 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#g-friends', 'bitbonsai')").run();
  const make = (channel: string) => app.request("/api/join-links", { method: "POST", headers: json({ Cookie: "slirc_session=owner-token", "X-Slirc-Join": "1" }), body: JSON.stringify({ channel }) });
  expect((await make("g-friends")).status).toBe(403);
  for (let i = 0; i < 5; i++) expect((await make("guild")).status).toBe(201);
  const sixth = await make("guild");
  expect(sixth.status).toBe(409);
  expect((await sixth.json()).error).toContain("5 open join links");
});

test("a signed-in member of the link's channel goes straight to it, whatever the link's state", async () => {
  const { link: made, token } = link();
  const opened = await app.request(`/j/${token}`, { headers: { Cookie: "slirc_session=owner-token" } });
  expect(opened.status).toBe(302);
  expect(opened.headers.get("Location")).toBe("/#guild");
  expect(opened.headers.get("Cache-Control")).toBe("no-store");
  expect(opened.headers.get("Location")).not.toContain(token);
  db.query("UPDATE join_links SET revoked_at = ? WHERE id = ?").run(Date.now(), made.id);
  const closed = await app.request(`/j/${token}`, { headers: { Cookie: "slirc_session=owner-token" } });
  expect(closed.status).toBe(302);
  expect(closed.headers.get("Location")).toBe("/#guild");
  expect(joinsOf(made.id)).toEqual({ joins: 0, sends: 0 });
});

test("a signed-in non-member, a signed-out visitor and a bad token get the page as before", async () => {
  const { token } = link();
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('eve', 'eve@example.test', 'member', 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'eve', ?)").run(sha("eve-token"), Date.now());
  for (const headers of [{ Cookie: "slirc_session=eve-token" }, {} as Record<string, string>]) {
    const page = await app.request(`/j/${token}`, { headers });
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(await page.text()).toContain('data-state="open"');
  }
  const bad = await app.request("/j/not-a-real-token-at-all-000000", { headers: { Cookie: "slirc_session=owner-token" } });
  expect(bad.status).toBe(200);
  expect(bad.headers.get("Cache-Control")).toBe("no-store");
  expect(await bad.text()).toContain('data-state="closed"');
});
