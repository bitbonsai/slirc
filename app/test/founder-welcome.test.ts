// Founder-only welcome queue: opt-in gating, first-verification only, identity exclusions,
// cross-device claim, and delivered-only-on-proof. Server tests; the client drain is tested
// separately in client-founder-welcome.test.ts.
import "./fixture.ts";

import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.env.SLIRC_HELPERS_ENABLED = "false";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const welcome = await import("../src/founder-welcome.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });
const idOf = (nick: string) => (db.query("SELECT account_id FROM accounts WHERE nick = ?").get(nick) as { account_id: string }).account_id;

function addSession(nick: string, token: string) {
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(sha(token), nick, Date.now());
}

function addHuman(nick: string, options: { role?: string; kind?: string; owner?: string | null; verified?: boolean } = {}): string {
  db.query("INSERT INTO accounts (nick, email, role, kind, owner, verified_at, provisional_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
    .run(nick, `${nick}@example.test`, options.role ?? "member", options.kind ?? "human", options.owner ?? null, options.verified === false ? null : Date.now(), Date.now() + 60_000);
  return idOf(nick);
}

function jobs() {
  return db.query("SELECT id, recipient_nick, state, claim_id FROM founder_welcome_jobs ORDER BY created_at").all() as { id: string; recipient_nick: string; state: string; claim_id: string | null }[];
}

function mint(nick: string): string {
  const token = `tok-${nick}-${Math.floor(Math.random() * 1e9)}`;
  db.query("INSERT INTO magic_links (token_hash, nick, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sha(token), nick, Date.now() + 15 * 60_000, Date.now());
  return token;
}

let owner: ReturnType<typeof welcome.founderAccount> = null;
beforeEach(() => {
  process.env.SLIRC_HELPERS_ENABLED = "false";
  db.exec("DELETE FROM founder_welcome_jobs");
  db.exec("DELETE FROM founder_welcome_optin");
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM magic_links");
  db.exec("DELETE FROM used_magic_links");
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.exec("UPDATE accounts SET role = 'admin', kind = 'human', verified_at = COALESCE(verified_at, 1) WHERE nick = 'bitbonsai'");
  owner = welcome.founderAccount();
  addSession("bitbonsai", "owner-session");
});

test("the configured owner is the only founder; the setting is off by default", () => {
  expect(owner?.nick).toBe("bitbonsai");
  expect(welcome.isFounder(owner)).toBe(true);
  expect(welcome.welcomeEnabled()).toBe(false);
  const member = addHuman("member");
  expect(welcome.isFounder(welcome.founderAccount()) && member !== owner?.id).toBe(true);
  expect(welcome.setWelcomeEnabled({ ...owner!, id: member }, true)).toBe(false);
  expect(welcome.setWelcomeEnabled(owner!, true)).toBe(true);
  expect(welcome.welcomeEnabled()).toBe(true);
});

test("only a verified human other than the founder is queued, once", () => {
  welcome.setWelcomeEnabled(owner!, true);
  addHuman("ana");
  addHuman("bot", { kind: "bot" });
  addHuman("agent", { kind: "agent", owner: "bitbonsai" });
  addHuman("pending", { verified: false });
  welcome.enqueueWelcomeJob("ana");
  welcome.enqueueWelcomeJob("bot");
  welcome.enqueueWelcomeJob("agent");
  welcome.enqueueWelcomeJob("pending");
  welcome.enqueueWelcomeJob("bitbonsai"); // founder self-send
  welcome.enqueueWelcomeJob("ana"); // duplicate
  expect(jobs().map((job) => job.recipient_nick)).toEqual(["ana"]);
  expect(jobs()[0]?.state).toBe("pending");
});

test("nothing is queued before opt-in and enabling does not scan existing members", () => {
  addHuman("ana");
  welcome.enqueueWelcomeJob("ana");
  expect(jobs()).toHaveLength(0);
  welcome.setWelcomeEnabled(owner!, true);
  // Turning it on does not retroactively queue anyone already verified.
  expect(jobs()).toHaveLength(0);
});

test("only the first verification of a human through the auth path creates a job", async () => {
  welcome.setWelcomeEnabled(owner!, true);
  addHuman("ana", { verified: false });
  const first = await app.request(`/auth/verify?token=${encodeURIComponent(mint("ana"))}&next=/`);
  expect(first.status).toBe(302);
  expect(jobs().map((job) => job.recipient_nick)).toEqual(["ana"]);

  // A second verification is not a first verification: no second job (idempotent either way).
  await app.request(`/auth/verify?token=${encodeURIComponent(mint("ana"))}&next=/`);
  expect(jobs()).toHaveLength(1);

  // An already-verified existing member never enters the queue.
  addHuman("older");
  await app.request(`/auth/verify?token=${encodeURIComponent(mint("older"))}&next=/`);
  expect(jobs().map((job) => job.recipient_nick)).toEqual(["ana"]);
});

test("a claim is exclusive and the job survives until proven delivery", () => {
  welcome.setWelcomeEnabled(owner!, true);
  addHuman("ana");
  welcome.enqueueWelcomeJob("ana");
  const job = jobs()[0]!;
  const claim = welcome.claimWelcomeJob(owner!, job.id);
  expect(claim).toBeTruthy();
  // A second tab or device cannot claim the same job.
  expect(welcome.claimWelcomeJob(owner!, job.id)).toBeNull();
  // A wrong token cannot mark it delivered; the right one can.
  expect(welcome.markWelcomeDelivered(owner!, job.id, "not-the-claim", null)).toBe(false);
  expect(jobs()[0]?.state).toBe("claimed");
  expect(welcome.markWelcomeDelivered(owner!, job.id, claim!, "msgid-1")).toBe(true);
  expect(jobs()[0]?.state).toBe("delivered");
});

test("a refused or unenqueued delivery releases the claim for a safe retry", () => {
  welcome.setWelcomeEnabled(owner!, true);
  addHuman("ana");
  welcome.enqueueWelcomeJob("ana");
  const job = jobs()[0]!;
  const claim = welcome.claimWelcomeJob(owner!, job.id)!;
  expect(welcome.releaseWelcomeJob(owner!, job.id, "wrong")).toBe(false);
  expect(welcome.releaseWelcomeJob(owner!, job.id, claim)).toBe(true);
  expect(jobs()[0]?.state).toBe("pending");
  expect(welcome.claimWelcomeJob(owner!, job.id)).toBeTruthy();
});

test("a missing or demoted founder queues nothing and exposes no control", async () => {
  addHuman("ana");
  db.query("UPDATE accounts SET role = 'member' WHERE nick = 'bitbonsai'").run();
  expect(welcome.founderAccount()).toBeNull();
  expect(welcome.welcomeEnabled()).toBe(false);
  welcome.enqueueWelcomeJob("ana");
  expect(jobs()).toHaveLength(0);
  expect((await app.request("/api/welcome", { headers: auth("owner-session") })).status).toBe(404);
});

test("the founder endpoints are founder-only and never leak the queue", async () => {
  welcome.setWelcomeEnabled(owner!, true);
  addHuman("ana");
  welcome.enqueueWelcomeJob("ana");
  addHuman("member");

  // A verified non-founder gets 404 everywhere, including the queue.
  expect((await app.request("/api/welcome", { headers: auth("member-session") })).status).toBe(404);
  addSession("member", "member-session");
  expect((await app.request("/api/welcome", { headers: auth("member-session") })).status).toBe(404);
  expect((await app.request("/api/welcome/jobs", { headers: auth("member-session") })).status).toBe(404);

  const settings = await app.request("/api/welcome", { headers: auth("owner-session") });
  expect(settings.status).toBe(200);
  expect(await settings.json()).toEqual({ enabled: true, pending: 1 });

  const list = await app.request("/api/welcome/jobs", { headers: auth("owner-session") });
  const body = await list.json() as { enabled: boolean; jobs: { id: string; recipientNick: string; state: string }[] };
  expect(body.enabled).toBe(true);
  expect(body.jobs).toHaveLength(1);
  expect(body.jobs[0]?.recipientNick).toBe("ana");

  const jobId = body.jobs[0]!.id;
  const claim = await app.request(`/api/welcome/jobs/${jobId}/claim`, { method: "POST", headers: auth("owner-session") });
  expect(claim.status).toBe(200);
  const { claimId } = await claim.json() as { claimId: string };
  // A concurrent claim loses.
  expect((await app.request(`/api/welcome/jobs/${jobId}/claim`, { method: "POST", headers: auth("owner-session") })).status).toBe(409);
  // Delivery requires the exact claim.
  expect((await app.request(`/api/welcome/jobs/${jobId}/delivered`, { method: "POST", headers: auth("owner-session"), body: JSON.stringify({ claimId: "nope" }) })).status).toBe(409);
  expect((await app.request(`/api/welcome/jobs/${jobId}/delivered`, { method: "POST", headers: auth("owner-session"), body: JSON.stringify({ claimId, msgid: "m1" }) })).status).toBe(200);
  expect(jobs()[0]?.state).toBe("delivered");
});

test("disabling stops new enqueue and claims; delivered history stays", async () => {
  welcome.setWelcomeEnabled(owner!, true);
  addHuman("ana");
  addHuman("ben");
  welcome.enqueueWelcomeJob("ana");
  welcome.enqueueWelcomeJob("ben");
  expect(jobs()).toHaveLength(2);
  // Deliver ana, leave ben claimed, then switch off.
  const ana = jobs().find((entry) => entry.recipient_nick === "ana")!;
  const ben = jobs().find((entry) => entry.recipient_nick === "ben")!;
  const anaClaim = welcome.claimWelcomeJob(owner!, ana.id)!;
  welcome.markWelcomeDelivered(owner!, ana.id, anaClaim, "m1");
  const benClaim = welcome.claimWelcomeJob(owner!, ben.id)!;
  expect(benClaim).toBeTruthy();
  expect(welcome.setWelcomeEnabled(owner!, false)).toBe(true);
  addHuman("later");
  welcome.enqueueWelcomeJob("later");
  expect(jobs().map((entry) => entry.recipient_nick)).toEqual(["ana", "ben"]);

  // The disabled feed still reports `enabled` and the claimed row so the client can ack/protect it.
  const feed = await (await app.request("/api/welcome/jobs", { headers: auth("owner-session") })).json() as { enabled: boolean; jobs: { id: string; recipientNick: string; state: string }[] };
  expect(feed.enabled).toBe(false);
  expect(feed.jobs.map((entry) => entry.recipientNick)).toEqual(["ben"]);
  expect(feed.jobs[0]?.state).toBe("claimed");
  expect((await app.request(`/api/welcome/jobs/${ben.id}/claim`, { method: "POST", headers: auth("owner-session") })).status).toBe(409);
});
