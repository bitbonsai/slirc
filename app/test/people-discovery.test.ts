// Regular members need membership evidence, except for public admin contacts.
// Admins can discover all verified humans. Search and DM creation share the gate.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://app.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
process.env.EMAIL_INVITE_LIMIT = "9";

import { createHash, randomBytes } from "node:crypto";
import { beforeEach, expect, mock, test } from "bun:test";

mock.module("../src/grants.ts", () => {
  const noop = async () => {};
  return {
    grantChannelOps: noop,
    operClient: noop, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }), readDirectChannelReady: async () => false,
    serviceCommand: noop, setAlwaysOn: noop, transferChannel: noop, allowChannelAccess: noop,
    grantChannelAccess: noop, createChannel: noop, setChannelMode: noop, setChannelTopic: noop,
    revokeChannelAccess: noop, createDirectChannel: noop, createThreadChannel: noop,
    NotAuthorizedError: class NotAuthorizedError extends Error {}, redactMessage: noop,
    kickChannelMember: noop, makeChannelSecret: noop, makeThreadChannelsSecret: noop, removeFromThreadChannels: noop, makeChannelOpen: noop, clearChannelAccess: noop,
    unregisterChannel: noop, purgeChannelHistory: noop, renameChannel: noop, removeMemberFromIrc: async () => ({ suspended: true }),
  };
});
mock.module("resend", () => ({ Resend: class { emails = { send: async () => ({ data: { id: "test" }, error: null }) }; } }));

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const rooms = await import("../src/rooms.ts");
const { reopenDirect } = await import("../src/slirc-bot.ts");
const { subscribe } = await import("../src/live.ts");

const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });
const addSession = (nick: string, token: string) => db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?,?,?)").run(sessionHash(token), nick, Date.now());
const idOf = (nick: string) => (db.query("SELECT account_id FROM accounts WHERE nick = ?").get(nick) as { account_id: string }).account_id;

function addHuman(nick: string, options: { kind?: string; owner?: string | null; verified?: boolean; fullName?: string } = {}): string {
  db.query("INSERT INTO accounts (nick,email,role,kind,owner,verified_at,created_at) VALUES (?,?,?,?,?,?,1)")
    .run(nick, `${nick}@example.test`, "member", options.kind ?? "human", options.owner ?? null, options.verified === false ? null : 1);
  if (options.fullName) db.query("INSERT INTO profiles (account, full_name) VALUES (?, ?)").run(nick, options.fullName);
  return idOf(nick);
}

function channel(name: string, visibility: "workspace" | "secret", owner = "bitbonsai", archived = false): void {
  db.query("INSERT INTO channels (channel,owner,visibility,created_at,archived_at) VALUES (?,?,?,1,?)").run(name, owner, visibility, archived ? 1 : null);
}

function members(name: string, nicks: string[]): void {
  for (const nick of nicks) db.query("INSERT INTO channel_members (channel,nick) VALUES (?,?)").run(name, nick);
}

// Keep the profile route hermetic: pre-mark the gravatar check so no test reaches the network.
function gravatarChecked(...nicks: string[]): void {
  for (const nick of nicks) db.query("INSERT INTO profiles (account, gravatar_checked_at) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET gravatar_checked_at = excluded.gravatar_checked_at").run(nick, Date.now());
}

let ownerId = "";
beforeEach(() => {
  process.env.EMAIL_INVITE_LIMIT = "9";
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM invites").run();
  db.query("DELETE FROM conversation_operations").run();
  db.query("DELETE FROM email_invite_quota").run();
  db.query("DELETE FROM direct_conversations").run();
  db.query("DELETE FROM closed_direct_conversations").run();
  db.query("DELETE FROM channel_members").run();
  db.query("DELETE FROM public_author_evidence").run();
  db.query("DELETE FROM channels").run();
  db.query("DELETE FROM profiles").run();
  db.query("DELETE FROM accounts WHERE nick != 'bitbonsai'").run();
  db.query("UPDATE accounts SET role = 'member' WHERE nick = 'bitbonsai'").run();
  addSession("bitbonsai", "owner-session");
  ownerId = idOf("bitbonsai");
});

test("discovery follows membership evidence, not the global directory", () => {
  const pub = addHuman("pubpeer");
  const shared = addHuman("sharedpeer");
  const hidden = addHuman("hiddenpeer");
  const dmpeer = addHuman("dmpeer");
  const stale = addHuman("stalepeer");
  const archivedDm = addHuman("archivedpeer");
  const missing = addHuman("missingpeer");
  const dirty = addHuman("contaminatedpeer");
  const arch = addHuman("archpeer");
  const orphan = addHuman("orphanpeer");
  const thread = addHuman("threadpeer");
  const foreignA = addHuman("carol");
  const foreignB = addHuman("dave");
  channel("#d-public", "workspace");
  channel("#d-secret", "secret");
  channel("#d-vault", "secret", "someone");
  channel("#d-arch", "workspace", "bitbonsai", true);
  channel("#d-thread", "secret", "someone");
  members("#d-public", ["pubpeer"]);
  members("#d-secret", ["bitbonsai", "sharedpeer"]);
  members("#d-vault", ["hiddenpeer"]);
  members("#d-arch", ["archpeer"]);
  members("#d-missing", ["orphanpeer"]); // no channels row
  members("#d-thread", ["threadpeer"]);

  // A live, uncontaminated pair: direct channel plus exactly both member rows and the mapping.
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#dm-x','bitbonsai','direct',1)").run();
  members("#dm-x", ["bitbonsai", "dmpeer"]);
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick,provision_ready) VALUES ('#dm-x','bitbonsai','dmpeer',1)").run();
  // A bare mapping with a missing half is not a pair.
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#dm-stale','bitbonsai','direct',1)").run();
  members("#dm-stale", ["bitbonsai"]);
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick,provision_ready) VALUES ('#dm-stale','bitbonsai','stalepeer',1)").run();
  // An archived direct channel grants nothing.
  db.query("INSERT INTO channels (channel,owner,visibility,created_at,archived_at) VALUES ('#dm-arch','bitbonsai','direct',1,1)").run();
  members("#dm-arch", ["bitbonsai", "archivedpeer"]);
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick,provision_ready) VALUES ('#dm-arch','bitbonsai','archivedpeer',1)").run();
  // A mapping whose channel row is gone grants nothing.
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick,provision_ready) VALUES ('#dm-missing','bitbonsai','missingpeer',1)").run();
  // A third member contaminates the pair.
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#dm-dirty','bitbonsai','direct',1)").run();
  members("#dm-dirty", ["bitbonsai", "contaminatedpeer", "intruder"]);
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick,provision_ready) VALUES ('#dm-dirty','bitbonsai','contaminatedpeer',1)").run();
  // A pair between two other people never exposes either of them.
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick,provision_ready) VALUES ('#dm-other','carol','dave',1)").run();

  // Explicit public/workspace membership, a shared secret room, and a live pair all count.
  expect(rooms.discoverableHuman("bitbonsai", pub)?.nick).toBe("pubpeer");
  expect(rooms.discoverableHuman("bitbonsai", shared)?.nick).toBe("sharedpeer");
  expect(rooms.discoverableHuman("bitbonsai", dmpeer)?.nick).toBe("dmpeer");
  // Secret-only outsider, archived/orphan/thread-only grants, and stale/missing/contaminated pairs all fail.
  expect(rooms.discoverableHuman("bitbonsai", hidden)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", stale)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", archivedDm)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", missing)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", dirty)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", arch)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", orphan)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", thread)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", foreignA)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", foreignB)).toBeNull();
});

test("validated public authors are discoverable without exposing silent readers", async () => {
  const author = addHuman("publicauthor");
  const silent = addHuman("silentreader");
  const secretAuthor = addHuman("secretauthor");
  const unverified = addHuman("unverifiedauthor", { verified: false });
  channel("#d-public", "workspace");
  channel("#d-secret", "secret");

  expect(rooms.recordValidatedPublicAuthorMessage(author, "#d-public", "msg-public-1")).toBe(true);
  expect(rooms.recordValidatedPublicAuthorMessage(secretAuthor, "#d-secret", "msg-secret-1")).toBe(false);
  expect(rooms.recordValidatedPublicAuthorMessage(unverified, "#d-public", "msg-public-2")).toBe(false);
  expect(rooms.discoverableHuman("bitbonsai", author)?.nick).toBe("publicauthor");
  expect(rooms.discoverableHuman("bitbonsai", silent)).toBeNull();
  expect(rooms.sharedContacts("bitbonsai")).toContain("publicauthor");
  expect(rooms.sharedContacts("bitbonsai")).not.toContain("silentreader");

  const opened = await app.request("/api/dms/publicauthor", { method: "POST", headers: auth("owner-session") });
  expect(opened.status).toBe(200);
  expect((await app.request("/api/dms/silentreader", { method: "POST", headers: auth("owner-session") })).status).toBe(404);
});

test("public author evidence follows immutable account id, not nick reuse", () => {
  const priorId = addHuman("reusednick");
  channel("#d-public", "workspace");
  expect(rooms.recordValidatedPublicAuthorMessage(priorId, "#d-public", "msg-prior")).toBe(true);
  db.query("DELETE FROM accounts WHERE nick = 'reusednick'").run();
  const replacementId = addHuman("reusednick");
  expect(replacementId).not.toBe(priorId);
  expect(rooms.discoverableHuman("bitbonsai", replacementId)).toBeNull();
});

// Configured open channels (#help, #support) have no channels row in production, so the
// workspace join alone would never match the room newcomers actually meet in.
test("open channels without a channels row still record public-author evidence", () => {
  const author = addHuman("openauthor");
  const lurker = addHuman("openlurker");
  expect(rooms.channelInfo("#help")).toBeNull();
  expect(rooms.recordValidatedPublicAuthorMessage(author, "#help", "msg-help-1")).toBe(true);
  expect(rooms.recordValidatedPublicAuthorMessage(author, "#unknown", "msg-unknown-1")).toBe(false);
  expect(rooms.discoverableHuman("bitbonsai", author)?.nick).toBe("openauthor");
  expect(rooms.discoverableHuman("bitbonsai", lurker)).toBeNull();
  // Discovery only: posting in an open channel is not a relationship, so neither is a Contact.
  expect(rooms.sharedContacts("bitbonsai")).not.toContain("openauthor");
  expect(rooms.sharedContacts("bitbonsai")).not.toContain("openlurker");
});

// The beta report: a newcomer saw an #open-chat poster under Direct messages. Open-channel posts and
// membership never make a Contact or a DM row; real DMs, private rooms and admins still do.
test("open-channel posters stay out of contacts and directs while real relationships stay", async () => {
  db.query("UPDATE accounts SET role = 'admin' WHERE nick = 'bitbonsai'").run();
  const newcomer = addHuman("newcomer");
  const poster = addHuman("poster");
  addHuman("roommate");
  addHuman("dmpeer");
  addSession("newcomer", "newcomer-session");
  // Posts in both open channels; #support also has a stored row and membership rows.
  rooms.recordValidatedPublicAuthorMessage(poster, "#help", "msg-help-poster");
  channel("#support", "workspace");
  members("#support", ["newcomer", "poster"]);
  rooms.recordValidatedPublicAuthorMessage(poster, "#support", "msg-support-poster");
  rooms.recordValidatedPublicAuthorMessage(newcomer, "#help", "msg-help-newcomer");
  channel("#d-private", "secret", "newcomer");
  members("#d-private", ["newcomer", "roommate"]);
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#dm-dmpeer-newcomer','dmpeer','direct',1)").run();
  members("#dm-dmpeer-newcomer", ["dmpeer", "newcomer"]);
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick,provision_ready) VALUES ('#dm-dmpeer-newcomer','dmpeer','newcomer',1)").run();

  expect(rooms.sharedContacts("newcomer")).toEqual(["bitbonsai", "dmpeer", "roommate"]);
  expect(rooms.sharedContacts("poster")).toEqual(["bitbonsai"]);
  const me = await (await app.request("/auth/me", { headers: auth("newcomer-session") })).json();
  expect(me.directs).toEqual([{ channel: "#dm-dmpeer-newcomer", nick: "dmpeer" }]);
  expect(me.contacts).toEqual(["bitbonsai", "dmpeer", "roommate"]);
  expect(me.accountDetails.map((item: { nick: string }) => item.nick)).not.toContain("poster");
  // Discovery is unchanged: search finds the poster and a deliberate DM still opens.
  expect(rooms.discoverableHuman("newcomer", poster)?.nick).toBe("poster");
  expect((await app.request("/api/dms/poster", { method: "POST", headers: auth("newcomer-session") })).status).toBe(200);
});

// A newcomer who shares only #help DMs the owner. The DM is the relationship: it lands in the
// owner's Directs, stays a Contact and searchable after either side closes it, and a new message
// reopens it. The open channel itself still grants no Contact.
test("anyone you have a DM with stays a contact and searchable, and a new message reopens a closed DM", async () => {
  const newcomer = addHuman("newbie");
  addSession("newbie", "newbie-session");
  rooms.recordValidatedPublicAuthorMessage(ownerId, "#help", "msg-help-owner");
  rooms.recordValidatedPublicAuthorMessage(newcomer, "#help", "msg-help-newbie");
  expect(rooms.sharedContacts("bitbonsai")).not.toContain("newbie");
  expect(rooms.sharedContacts("newbie")).not.toContain("bitbonsai");

  expect((await app.request("/api/dms/bitbonsai", { method: "POST", headers: auth("newbie-session") })).status).toBe(200);
  const channel = rooms.directConversation("bitbonsai", "newbie")!.channel;
  const me = async (token = "owner-session") => (await app.request("/auth/me", { headers: auth(token) })).json();
  const search = async () => ((await (await app.request("/api/people?q=newbie", { headers: auth("owner-session") })).json()).people as { nick: string }[]).map((person) => person.nick);
  // (a) First contact: the recipient holds the DM, the person is a Contact both ways, and searchable.
  expect((await me()).directs).toEqual([{ channel, nick: "newbie" }]);
  expect((await me()).contacts).toContain("newbie");
  expect((await me("newbie-session")).contacts).toContain("bitbonsai");
  // The DM alone is the evidence: drop the #help posts and the relationship stays.
  db.query("DELETE FROM public_author_evidence").run();
  expect(await search()).toEqual(["newbie"]);

  // (b) Closing hides the DM only; the person stays in Contacts and search.
  expect((await app.request("/api/dms/newbie", { method: "DELETE", headers: auth("owner-session") })).status).toBe(204);
  expect((await me()).directs).toEqual([]);
  expect((await me()).contacts).toContain("newbie");
  expect(await search()).toEqual(["newbie"]);
  expect((await me("newbie-session")).directs).toEqual([{ channel, nick: "bitbonsai" }]);

  // A new message reopens it for the person who closed it and wakes both people's tabs.
  const events: string[] = [];
  const stopOwner = subscribe("bitbonsai", (event, data) => events.push(`bitbonsai ${event} ${(data as { channel: string }).channel}`));
  const stopPeer = subscribe("newbie", (event, data) => events.push(`newbie ${event} ${(data as { channel: string }).channel}`));
  try {
    reopenDirect(channel);
    reopenDirect("#help");
    reopenDirect("#dm-nobody-nothing");
  } finally { stopOwner(); stopPeer(); }
  expect(events.sort()).toEqual([`bitbonsai direct ${channel}`, `newbie direct ${channel}`]);
  expect((await me()).directs).toEqual([{ channel, nick: "newbie" }]);

  // (d) Closed again, the owner can still message them back from Contacts without a shared room.
  expect((await app.request("/api/dms/newbie", { method: "DELETE", headers: auth("owner-session") })).status).toBe(204);
  expect((await app.request("/api/dms/newbie", { method: "POST", headers: auth("owner-session") })).status).toBe(200);
  expect((await me()).directs).toEqual([{ channel, nick: "newbie" }]);
});

// (c) Presence is not part of the gate. A DM to someone with no session opens, and it is waiting
// in their Directs, with the sender as a Contact, when they next sign in.
test("a DM to someone who is offline opens and is waiting for them when they return", async () => {
  addHuman("away");
  channel("#d-crew", "secret");
  members("#d-crew", ["bitbonsai", "away"]);
  expect(db.query("SELECT 1 FROM sessions WHERE nick = 'away'").get()).toBeNull();
  const opened = await app.request("/api/dms/away", { method: "POST", headers: auth("owner-session") });
  expect(opened.status).toBe(200);
  const { channel: dm } = await opened.json() as { channel: string };
  // Leaving the shared room afterwards does not orphan the DM relationship.
  db.query("DELETE FROM channel_members WHERE channel = '#d-crew'").run();
  addSession("away", "away-session");
  const me = await (await app.request("/auth/me", { headers: auth("away-session") })).json();
  expect(me.directs).toEqual([{ channel: dm, nick: "bitbonsai" }]);
  expect(me.contacts).toContain("bitbonsai");
});

// Personal agents stay owner-scoped and bots never become Contacts through a DM; a pair with a
// third member is contaminated and grants nothing.
test("DM contacts are verified humans in a clean pair only", async () => {
  addHuman("myagent2", { kind: "agent", owner: "bitbonsai" });
  addHuman("botty", { kind: "bot" });
  addHuman("pairpeer");
  addHuman("intruder");
  for (const peer of ["myagent2", "botty"]) {
    expect((await app.request(`/api/dms/${peer}`, { method: "POST", headers: auth("owner-session") })).status).toBe(200);
    expect((await app.request(`/api/dms/${peer}`, { method: "DELETE", headers: auth("owner-session") })).status).toBe(204);
  }
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#dm-bitbonsai-pairpeer','bitbonsai','direct',1)").run();
  members("#dm-bitbonsai-pairpeer", ["bitbonsai", "pairpeer"]);
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick,provision_ready) VALUES ('#dm-bitbonsai-pairpeer','bitbonsai','pairpeer',1)").run();
  expect(rooms.sharedContacts("bitbonsai")).toEqual(["pairpeer"]);
  expect(rooms.sharedContacts("intruder")).toEqual([]);
  members("#dm-bitbonsai-pairpeer", ["intruder"]);
  expect(rooms.sharedContacts("bitbonsai")).toEqual([]);
  expect(rooms.sharedContacts("pairpeer")).toEqual([]);
});

test("bots, agents and unverified accounts are never discoverable", () => {
  const bot = addHuman("botpeer", { kind: "bot" });
  const agent = addHuman("agentpeer", { kind: "agent", owner: "bitbonsai" });
  const unverified = addHuman("unverifiedpeer", { verified: false });
  channel("#d-public", "workspace");
  members("#d-public", ["botpeer", "agentpeer", "unverifiedpeer"]);
  expect(rooms.discoverableHuman("bitbonsai", bot)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", agent)).toBeNull();
  expect(rooms.discoverableHuman("bitbonsai", unverified)).toBeNull();
});

test("people search hides secret-only outsiders by nick and display name", async () => {
  addHuman("pubpeer", { fullName: "Pia Public" });
  addHuman("sharedpeer", { fullName: "Sam Shared" });
  addHuman("tom", { fullName: "Tom Hidden" });
  channel("#d-public", "workspace");
  channel("#d-secret", "secret");
  channel("#d-vault", "secret", "someone");
  members("#d-public", ["pubpeer"]);
  members("#d-secret", ["bitbonsai", "sharedpeer"]);
  members("#d-vault", ["tom"]);

  const search = async (q: string): Promise<string[]> => {
    const response = await app.request(`/api/people?q=${encodeURIComponent(q)}`, { headers: auth("owner-session") });
    expect(response.status).toBe(200);
    return (await response.json() as { people: { nick: string }[] }).people.map((person) => person.nick);
  };
  expect(await search("pubpeer")).toContain("pubpeer");
  expect(await search("Pia Public")).toContain("pubpeer");
  expect(await search("sharedpeer")).toContain("sharedpeer");
  expect(await search("tom")).toEqual([]);
  expect(await search("Tom Hidden")).toEqual([]);
});

test("people search matches the start of the nick or display name, or of a word in either, prefix first", async () => {
  addHuman("zed-bob", { fullName: "Zed Smith" });
  addHuman("bobby", { fullName: "Robert Jones" });
  addHuman("carol", { fullName: "Carol Bob" });
  addHuman("steve", { fullName: "Steve Jones" });
  channel("#d-public", "workspace");
  members("#d-public", ["zed-bob", "bobby", "carol", "steve"]);
  const search = async (q: string): Promise<string[]> => {
    const response = await app.request(`/api/people?q=${encodeURIComponent(q)}`, { headers: auth("owner-session") });
    return (await response.json() as { people: { nick: string }[] }).people.map((person) => person.nick);
  };
  expect(await search("bob")).toEqual(["bobby", "carol", "zed-bob"]);
  expect(await search("BOB")).toEqual(["bobby", "carol", "zed-bob"]);
  expect(await search("smith")).toEqual(["zed-bob"]);
  expect(await search("ev")).toEqual([]);
});

test("a guessed hidden accountId fails generically before any side effect", async () => {
  const tom = addHuman("tom");
  channel("#d-vault", "secret", "someone");
  members("#d-vault", ["tom"]);
  const key = randomBytes(18).toString("hex");
  const request = (accountId: string) => app.request("/api/conversations", { method: "POST", headers: {
    ...auth("owner-session"), "Idempotency-Key": key,
  }, body: JSON.stringify({ recipients: [{ accountId }] }) });

  const hidden = await request(tom);
  expect(hidden.status).toBe(404);
  expect(await hidden.json()).toEqual({ error: "verified person not found" });
  const unknown = await request("00000000-0000-0000-0000-000000000000");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "verified person not found" });

  expect(db.query("SELECT COUNT(*) AS c FROM direct_conversations").get()).toEqual({ c: 0 });
  expect(db.query("SELECT COUNT(*) AS c FROM channels WHERE is_group = 1").get()).toEqual({ c: 0 });
  expect(db.query("SELECT COUNT(*) AS c FROM channel_members").get()).toEqual({ c: 1 }); // tom's vault row only
  expect(db.query("SELECT COUNT(*) AS c FROM conversation_operations").get()).toEqual({ c: 0 });
  expect(db.query("SELECT 1 FROM email_invite_quota WHERE account_id = ?").get(ownerId)).toBeNull();
});

test("direct-by-nick cannot reach a hidden human but opens a discoverable DM", async () => {
  addHuman("tom");
  addHuman("peer");
  channel("#d-vault", "secret", "someone");
  channel("#d-shared", "secret");
  members("#d-vault", ["tom"]);
  members("#d-shared", ["bitbonsai", "peer"]);

  const blocked = await app.request("/api/dms/tom", { method: "POST", headers: auth("owner-session") });
  expect(blocked.status).toBe(404);
  expect(await blocked.json()).toEqual({ error: "contact not found" });

  const opened = await app.request("/api/dms/peer", { method: "POST", headers: auth("owner-session") });
  expect(opened.status).toBe(200);
});

test("exact-email matching still reaches a verified human as its own authorized path", async () => {
  addHuman("hidden", { fullName: "Hidden Person" });
  channel("#d-vault", "secret", "someone");
  members("#d-vault", ["hidden"]);
  const response = await app.request("/api/conversations", { method: "POST", headers: {
    ...auth("owner-session"), "Idempotency-Key": randomBytes(18).toString("hex"),
  }, body: JSON.stringify({ recipients: [{ email: "hidden@example.test" }] }) });
  expect(response.status).toBe(200);
  expect((await response.json() as { conversation: { type: string } }).conversation.type).toBe("direct");
});

test("self and discoverable peers keep their profile; hidden, unknown and foreign agents return null", async () => {
  addHuman("sharedpeer", { fullName: "Sam Shared" });
  addHuman("pubpeer", { fullName: "Pia Public" });
  addHuman("dmpeer", { fullName: "Dana Dm" });
  addHuman("tom", { fullName: "Tom Hidden" });
  addHuman("myagent", { kind: "agent", owner: "bitbonsai" });
  addHuman("foreignagent", { kind: "agent", owner: "someone" });
  channel("#d-shared", "secret");
  channel("#d-public", "workspace");
  channel("#d-vault", "secret", "someone");
  members("#d-shared", ["bitbonsai", "sharedpeer"]);
  members("#d-public", ["pubpeer"]);
  members("#d-vault", ["tom"]);
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES ('#dm-pair','bitbonsai','direct',1)").run();
  members("#dm-pair", ["bitbonsai", "dmpeer"]);
  db.query("INSERT INTO direct_conversations (channel,first_nick,second_nick,provision_ready) VALUES ('#dm-pair','bitbonsai','dmpeer',1)").run();
  gravatarChecked("bitbonsai", "sharedpeer", "pubpeer", "dmpeer", "tom");

  const profile = async (path: string) => (await app.request(path, { headers: auth("owner-session") })).json();
  expect(await profile("/profiles/bitbonsai")).toMatchObject({ account: "bitbonsai" });
  expect(await profile("/profiles/sharedpeer")).toMatchObject({ account: "sharedpeer" });
  expect(await profile("/profiles/pubpeer")).toMatchObject({ account: "pubpeer" });
  expect(await profile("/profiles/dmpeer")).toMatchObject({ account: "dmpeer" });
  // An open-channel query proves nothing; hidden, unknown and another owner's agent all answer null.
  expect(await profile("/profiles/tom?channel=%23help")).toBeNull();
  expect(await profile("/profiles/ghost?channel=%23help")).toBeNull();
  expect(await profile("/profiles/foreignagent")).toBeNull();
  expect(await profile("/profiles/myagent")).toMatchObject({ account: "myagent" });
});

test("admin can discover and DM verified humans without shared rooms", async () => {
  db.query("UPDATE accounts SET role = 'admin' WHERE nick = 'bitbonsai'").run();
  const ahmed = addHuman("ahmed");
  const second = addHuman("anotherpeer");
  addHuman("pending", { verified: false });
  addHuman("foreignagent", { kind: "agent", owner: "someone" });
  expect(rooms.discoverableHuman("bitbonsai", ahmed)?.nick).toBe("ahmed");
  expect(rooms.sharedContacts("bitbonsai")).toEqual(["ahmed", "anotherpeer"]);
  const search = await app.request("/api/people?q=ahmed", { headers: auth("owner-session") });
  expect((await search.json()).people).toEqual([expect.objectContaining({ accountId: ahmed, nick: "ahmed" })]);
  const contacts = await app.request("/api/contacts", { headers: auth("owner-session") });
  expect((await contacts.json()).contacts).toContain("ahmed");
  expect((await app.request("/api/dms/ahmed", { method: "POST", headers: auth("owner-session") })).status).toBe(200);
  const created = await app.request("/api/conversations", { method: "POST", headers: {
    ...auth("owner-session"), "Idempotency-Key": randomBytes(18).toString("hex"),
  }, body: JSON.stringify({ recipients: [{ accountId: second }] }) });
  expect(created.status).toBe(200);
  expect((await app.request("/api/dms/foreignagent", { method: "POST", headers: auth("owner-session") })).status).toBe(404);
});

test("verified member can discover and DM an admin without shared rooms", async () => {
  db.query("UPDATE accounts SET role = 'admin' WHERE nick = 'bitbonsai'").run();
  addHuman("ahmed");
  const hidden = addHuman("hiddenpeer");
  addSession("ahmed", "member-session");
  expect(rooms.sharedContacts("ahmed")).toEqual(["bitbonsai"]);
  expect(rooms.discoverableHuman("ahmed", ownerId)?.nick).toBe("bitbonsai");
  expect(rooms.discoverableHuman("ahmed", hidden)).toBeNull();
  db.query("INSERT INTO profiles (account, avatar_path, avatar_version) VALUES ('bitbonsai', '/tmp/none', 7) ON CONFLICT(account) DO UPDATE SET avatar_path = excluded.avatar_path, avatar_version = excluded.avatar_version").run();
  const search = await app.request("/api/people?q=bitbonsai", { headers: auth("member-session") });
  expect((await search.json()).people).toEqual([expect.objectContaining({ nick: "bitbonsai", avatarVersion: 7, avatarUrl: "/avatars/bitbonsai?v=7" })]);
  expect((await app.request("/api/dms/bitbonsai", { method: "POST", headers: auth("member-session") })).status).toBe(200);
});

test("admin discovery grants no access to another person's private room", async () => {
  db.query("UPDATE accounts SET role = 'admin' WHERE nick = 'bitbonsai'").run();
  const hidden = addHuman("hiddenpeer");
  channel("#d-vault", "secret", "hiddenpeer");
  members("#d-vault", ["hiddenpeer"]);
  expect(rooms.discoverableHuman("bitbonsai", hidden)?.nick).toBe("hiddenpeer");
  expect(rooms.isMember("bitbonsai", "#d-vault")).toBe(false);
  expect(rooms.visibleChannels("bitbonsai")).toEqual([]);
  expect((await app.request("/api/channels/%23d-vault/members", { headers: auth("owner-session") })).status).toBe(403);
});

test("legacy guest routes are gone and cannot mail members or provision newcomers", async () => {
  addHuman("mailtarget");
  const before = db.query("SELECT COUNT(*) AS count FROM accounts").get() as { count: number };
  for (const path of ["/api/guest", "/api/help"]) {
    for (const email of ["new@example.test", "mailtarget@example.test"]) {
      const response = await app.request(path, { method: "POST", headers: auth("owner-session"), body: JSON.stringify({ name: "New Person", email }) });
      expect(response.status).toBe(404);
    }
  }
  expect(db.query("SELECT 1 FROM magic_links WHERE nick = 'mailtarget'").get()).toBeNull();
  expect((db.query("SELECT COUNT(*) AS count FROM accounts").get() as { count: number }).count).toBe(before.count);
  expect(db.query("SELECT 1 FROM accounts WHERE email = 'new@example.test'").get()).toBeNull();

  channel("#d-public", "workspace");
  // A legacy reusable token no longer grants access; insert one directly since creation is disabled.
  const legacyToken = "legacy-copied-room-token";
  db.query("INSERT INTO invites (token_hash, channel, created_by, created_at) VALUES (?, '#d-public', 'bitbonsai', 1)").run(rooms.hash(legacyToken));
  const oldGuest = await app.request(`/api/join/${legacyToken}/guest`, { method: "POST", headers: auth("owner-session"), body: JSON.stringify({ name: "New Person", email: "new@example.test" }) });
  expect(oldGuest.status).toBe(410);
  expect(db.query("SELECT 1 FROM accounts WHERE email = 'new@example.test'").get()).toBeNull();

  addHuman("pending", { verified: false });
  addSession("pending", "pending-session");
  const author = addHuman("publicauthor");
  rooms.recordValidatedPublicAuthorMessage(author, "#d-public", "msg-public");
  expect((await app.request(`/api/join/${legacyToken}`, { method: "POST", headers: auth("pending-session") })).status).toBe(403);
  expect((await app.request("/api/contacts", { headers: auth("pending-session") })).status).toBe(403);
  expect((await app.request("/api/dms/publicauthor", { method: "POST", headers: auth("pending-session") })).status).toBe(403);
  expect((await app.request("/api/channels/d-public/join", { method: "POST", headers: auth("pending-session") })).status).toBe(403);
  expect(rooms.isMember("pending", "#d-public")).toBe(false);

  addHuman("robot", { kind: "bot" });
  addSession("robot", "robot-session");
  expect((await app.request("/api/contacts", { headers: auth("robot-session") })).status).toBe(403);
  expect((await app.request("/api/dms/publicauthor", { method: "POST", headers: auth("robot-session") })).status).toBe(403);
});

test("foreign personal agents are refused by guessed nick; own agents and helper bots keep DM access", async () => {
  addHuman("myagent", { kind: "agent", owner: "bitbonsai" });
  addHuman("foreignagent", { kind: "agent", owner: "someone" });
  addHuman("helper", { kind: "bot" });

  const foreign = await app.request("/api/dms/foreignagent", { method: "POST", headers: auth("owner-session") });
  expect(foreign.status).toBe(404);
  expect(await foreign.json()).toEqual({ error: "contact not found" });
  // Refusal happens before any write.
  expect(db.query("SELECT 1 FROM direct_conversations WHERE first_nick = 'bitbonsai' AND second_nick = 'foreignagent'").get()).toBeNull();
  expect(db.query("SELECT 1 FROM channel_members WHERE nick = 'foreignagent'").get()).toBeNull();

  expect((await app.request("/api/dms/myagent", { method: "POST", headers: auth("owner-session") })).status).toBe(200);
  expect((await app.request("/api/dms/helper", { method: "POST", headers: auth("owner-session") })).status).toBe(200);
});
