import "./fixture.ts";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

process.env.APP_ORIGIN = "https://app.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
process.env.WAITLIST_INTERNAL_TOKEN = "test-waitlist-token-that-is-longer-than-32-characters";
process.env.WAITLIST_API_URL = "https://waitlist.example.test";

const sent: any[] = [];
let nextMail: "failed" | "uncertain" | null = null;
mock.module("resend", () => ({ Resend: class { emails = { send: async (message: any, options?: any) => {
  sent.push({ ...message, idempotencyKey: options?.idempotencyKey });
  const outcome = nextMail;
  nextMail = null;
  if (outcome === "uncertain") throw new Error("mock connection loss");
  return outcome === "failed" ? { data: null, error: { message: "mock rejection" } } : { data: { id: "mock" }, error: null };
} }; } }));
const grants = await import("../src/grants.ts");
let failNextDirect = false;
mock.module("../src/grants.ts", () => ({ ...grants, createDirectChannel: async () => {
  if (failNextDirect) { failNextDirect = false; throw new Error("temporary channel failure"); }
} }));

const { db } = await import("../src/db.ts");
const accounts = await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const { ircPasswordFor } = await import("../src/irc-key.ts");
const admissions = await import("../src/admissions.ts");
const originalFetch = globalThis.fetch;
let applications = [{ id: "17", email: "applicant@example.test", selfhost: false, createdAt: 100, revision: 4 }];
const fakeWaitlistFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) !== "https://waitlist.example.test/api/internal/applications") return originalFetch(input, init);
  return Response.json({ applications });
}) as typeof fetch;
globalThis.fetch = fakeWaitlistFetch;
const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}` });
const csrf = (url: string, cookie?: string) => {
  const target = new URL(url);
  return {
    ...(cookie ? { Cookie: cookie } : {}), Host: target.host, Origin: target.origin,
    "X-Slirc-Admission": "1", "Content-Type": "application/json",
  };
};
const addSession = (nick: string, token: string) => db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?,?,?)").run(sessionHash(token), nick, Date.now());
const ownerId = () => accounts.accountByNick("bitbonsai")!.id;

beforeEach(() => {
  globalThis.fetch = fakeWaitlistFetch;
  process.env.ERGO_API_MOCK = "true";
  sent.length = 0;
  nextMail = null;
  failNextDirect = false;
  applications = [{ id: "17", email: "applicant@example.test", selfhost: false, createdAt: 100, revision: 4 }];
  for (const table of ["sessions", "admissions", "direct_conversations", "closed_direct_conversations", "channel_members", "channels", "profiles"]) {
    try { db.query(`DELETE FROM ${table}`).run(); } catch {}
  }
  db.query("DELETE FROM accounts WHERE nick <> 'bitbonsai'").run();
  db.query("UPDATE accounts SET role='admin', verified_at=COALESCE(verified_at, 1) WHERE nick='bitbonsai'").run();
  db.query("INSERT INTO accounts (nick,email,role,kind,verified_at,created_at) VALUES ('help','help@example.test','member','bot',1,1)").run();
  addSession("bitbonsai", "owner-session");
});

afterEach(() => { globalThis.fetch = originalFetch; });

async function ownerApprove(applicationId = "17", revision = 4) {
  const url = "https://app.example.test/api/admissions/approve";
  return app.request("/api/admissions/approve", { method: "POST", headers: csrf(url, "slirc_session=owner-session"), body: JSON.stringify({ applicationId, revision }) });
}

async function approve() {
  const response = await ownerApprove();
  expect(response.status).toBe(202);
  const body = await response.json() as any;
  const token = sent[0].text.match(/#token=([A-Za-z0-9_-]+)&destination=help/)?.[1];
  expect(token).toBeTruthy();
  return { id: body.admission.id as string, token: token as string };
}

function redeemRequest(token: string, browserClaim: string, name = "New Person", headers: Record<string, string> = {}) {
  const url = "https://app.example.test/api/admission/redeem";
  return app.request("/api/admission/redeem", { method: "POST", headers: { ...csrf(url), ...headers }, body: JSON.stringify({ token, browserClaim, name }) });
}

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie")?.match(/slirc_session=([^;]+)/)?.[1];
  expect(value).toBeTruthy();
  return `slirc_session=${value}`;
}

test("approval deduplicates normalized emails across application IDs without changing the bound address", () => {
  const first = admissions.approveApplication(applications[0]!);
  expect(first.created).toBe(true);
  const duplicate = admissions.approveApplication({ ...applications[0]!, id: "another-application", email: " APPLICANT@example.test " });
  expect(duplicate).toMatchObject({ created: false, token: null, conflict: true });
  const changedAddress = admissions.approveApplication({ ...applications[0]!, email: "changed@example.test", revision: 5 });
  expect(changedAddress).toMatchObject({ created: false, token: null, conflict: true });
  expect(db.query("SELECT COUNT(*) AS n FROM admissions").get()).toEqual({ n: 1 });
  expect(admissions.admissionList()[0]!.email).toBe("applicant@example.test");
});

test("approval binds current waitlist revision, sends two fixed fragment links, and creates no account", async () => {
  const stale = await app.request("/api/admissions/approve", { method: "POST", headers: csrf("https://app.example.test/api/admissions/approve", "slirc_session=owner-session"), body: JSON.stringify({ applicationId: "17", revision: 3 }) });
  expect(stale.status).toBe(409);
  expect(db.query("SELECT COUNT(*) AS n FROM admissions").get()).toEqual({ n: 0 });

  const issue = await approve();
  expect((await app.request("/api/admissions")).status).toBe(404);
  // An instance with no waitlist token or API URL has no queue to review: the owner gets 404, not an error.
  const waitlistToken = process.env.WAITLIST_INTERNAL_TOKEN;
  const waitlistApiUrl = process.env.WAITLIST_API_URL;
  delete process.env.WAITLIST_INTERNAL_TOKEN;
  try { expect((await app.request("/api/admissions", { headers: auth("owner-session") })).status).toBe(404); }
  finally { process.env.WAITLIST_INTERNAL_TOKEN = waitlistToken; }
  delete process.env.WAITLIST_API_URL;
  try {
    expect((await app.request("/api/admissions", { headers: auth("owner-session") })).status).toBe(404);
    await expect(admissions.waitlistApplications()).rejects.toThrow("waitlist integration is unavailable");
  } finally { process.env.WAITLIST_API_URL = waitlistApiUrl; }
  const ownerList = await app.request("/api/admissions", { headers: auth("owner-session") });
  expect(ownerList.status).toBe(200);
  expect(await ownerList.json()).toMatchObject({ applications: [{ id: "17", revision: 4 }], admissions: [{ id: issue.id, email: "applicant@example.test" }] });
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe("applicant@example.test");
  expect(sent[0].html).toContain(`#token=${issue.token}&amp;destination=help`);
  expect(sent[0].html).toContain(`#token=${issue.token}&amp;destination=founder`);
  expect(sent[0].html.match(/<a\b/g)).toHaveLength(2);
  expect(accounts.accountByEmail("applicant@example.test")).toBeNull();
  expect((db.query("SELECT token_hash, delivery_state FROM admissions").get() as any).token_hash).not.toBe(issue.token);
  expect(admissions.admissionList()[0]).toMatchObject({ id: issue.id, state: "pending", delivery: "sent" });
});

test("admission lifetime is exactly seven days", async () => {
  const issue = await approve();
  const row = db.query("SELECT created_at, expires_at FROM admissions WHERE id=?").get(issue.id) as { created_at: number; expires_at: number };
  expect(row.expires_at - row.created_at).toBe(admissions.admissionLifetimeMs);
});

test("GET and HEAD scanners do not redeem, provision, send, or create sessions", async () => {
  const issue = await approve();
  for (const method of ["GET", "HEAD"]) {
    const response = await app.request(`/admission#token=${issue.token}&destination=help`, { method });
    expect(response.status).toBe(200);
  }
  expect(db.query("SELECT state FROM admissions WHERE id=?").get(issue.id)).toEqual({ state: "pending" });
  expect(accounts.accountByEmail("applicant@example.test")).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
  expect(sent).toHaveLength(1);
});

test("missing name is rejected without claiming admission", async () => {
  const issue = await approve();
  const response = await app.request("/api/admission/redeem", {
    method: "POST", headers: csrf("https://app.example.test/api/admission/redeem"),
    body: JSON.stringify({ token: issue.token, browserClaim: "N".repeat(43) }),
  });
  expect(response.status).toBe(400);
  expect(db.query("SELECT state, claim_hash FROM admissions WHERE id=?").get(issue.id)).toEqual({ state: "pending", claim_hash: null });
});

test("same-origin CSRF compares HTTPS Origin to configured origin behind internal HTTP; wrong account and browser cannot claim", async () => {
  const issue = await approve();
  const wrongOrigin = await redeemRequest(issue.token, "A".repeat(43), "New Person", { Origin: "https://evil.example" });
  expect(wrongOrigin.status).toBe(403);
  const internalHttpUrl = new URL("http://localhost/api/admissions/approve");
  const httpsOrigin = await app.request(internalHttpUrl, {
    method: "POST",
    headers: { ...csrf("https://app.example.test/api/admissions/approve", "slirc_session=owner-session"), Host: "app.example.test" },
    body: JSON.stringify({ applicationId: "17", revision: 4 }),
  });
  expect(httpsOrigin.status).toBe(200);
  const victim = await accounts.provisionAccount("Wrong Person", "wrong@example.test");
  addSession(victim.nick, "wrong-session");
  const wrongAccount = await redeemRequest(issue.token, "B".repeat(43), "New Person", { Cookie: "slirc_session=wrong-session" });
  expect(wrongAccount.status).toBe(403);
  const attempts = await Promise.all([
    redeemRequest(issue.token, "C".repeat(43)),
    redeemRequest(issue.token, "D".repeat(43)),
  ]);
  expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);
  expect(accounts.accountByEmail("applicant@example.test")).not.toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM accounts WHERE email='applicant@example.test'").get()).toEqual({ n: 1 });
});

test("admission mutation routes remain founder-only", async () => {
  const issue = await approve();
  const outsider = await accounts.provisionAccount("Outsider", "outsider@example.test");
  addSession(outsider.nick, "outsider-session");
  const requests = [
    app.request("/api/admissions/approve", { method: "POST", headers: csrf("https://app.example.test/api/admissions/approve", "slirc_session=outsider-session"), body: JSON.stringify({ applicationId: "17", revision: 4 }) }),
    app.request(`/api/admissions/${issue.id}/cancel`, { method: "POST", headers: csrf(`https://app.example.test/api/admissions/${issue.id}/cancel`, "slirc_session=outsider-session") }),
    app.request(`/api/admissions/${issue.id}/reissue`, { method: "POST", headers: csrf(`https://app.example.test/api/admissions/${issue.id}/reissue`, "slirc_session=outsider-session"), body: JSON.stringify({ revision: 4 }) }),
  ];
  expect((await Promise.all(requests)).map((response) => response.status)).toEqual([404, 404, 404]);
  expect(db.query("SELECT state FROM admissions WHERE id=?").get(issue.id)).toEqual({ state: "pending" });
  expect(sent).toHaveLength(1);
});

test("direct approval after cancellation reuses row and rotates capability without a reservation", async () => {
  const first = await approve();
  const cancelUrl = `https://app.example.test/api/admissions/${first.id}/cancel`;
  expect((await app.request(`/api/admissions/${first.id}/cancel`, { method: "POST", headers: csrf(cancelUrl, "slirc_session=owner-session") })).status).toBe(200);
  const oldRow = admissions.admissionList()[0]!;
  expect(oldRow).toMatchObject({ id: first.id, generation: 2, state: "cancelled" });

  const direct = await ownerApprove();
  expect(direct.status).toBe(202);
  const body = await direct.json() as any;
  const freshToken = sent[1]!.text.match(/#token=([A-Za-z0-9_-]+)&destination=help/)![1]!;
  expect(body).toMatchObject({ created: true, admission: { id: first.id, generation: 3, state: "pending" } });
  expect(sent).toHaveLength(2);
  expect(db.query("SELECT COUNT(*) AS n FROM admissions").get()).toEqual({ n: 1 });
  expect(admissions.admissionForToken(first.token)).toBeNull();
  expect((await redeemRequest(first.token, "A".repeat(43))).status).toBe(410);
  const completed = await redeemRequest(freshToken, "B".repeat(43));
  expect(completed.status).toBe(201);
  expect((await redeemRequest(freshToken, "B".repeat(43))).status).toBe(410);
});

test("direct approval after cancellation preserves reserved new identity and fences old generation", async () => {
  const first = await approve();
  const attempt = admissions.beginRedemption(first.token, "C".repeat(43), "New Person");
  expect(attempt.status).toBe("claimed");
  if (attempt.status !== "claimed") return;
  const identity = await accounts.reserveAdmissionIdentity(first.id, attempt.fence);
  const cancelUrl = `https://app.example.test/api/admissions/${first.id}/cancel`;
  expect((await app.request(`/api/admissions/${first.id}/cancel`, { method: "POST", headers: csrf(cancelUrl, "slirc_session=owner-session") })).status).toBe(200);
  const sibling = admissions.approveApplication({ ...applications[0]!, id: "another-application" });
  expect(sibling).toMatchObject({ created: false, token: null, conflict: true });

  const direct = await ownerApprove();
  expect(direct.status).toBe(202);
  const body = await direct.json() as any;
  const freshToken = sent[1]!.text.match(/#token=([A-Za-z0-9_-]+)&destination=help/)![1]!;
  expect(body).toMatchObject({ created: true, admission: { id: first.id, generation: 3, state: "pending" } });
  const retained = db.query("SELECT reserved_account_id,reserved_nick,reserved_new_account FROM admissions WHERE id=?").get(first.id);
  expect(retained).toEqual({ reserved_account_id: identity.accountId, reserved_nick: identity.nick, reserved_new_account: identity.newAccount ? 1 : 0 });
  expect(admissions.admissionForToken(first.token)).toBeNull();
  const staleSession = "stale-admission-session";
  expect(admissions.finalizeRedemption({ id: first.id, fence: attempt.fence, identity,
    session: { tokenHash: sessionHash(staleSession), createdAt: Date.now(), device: "test" } })).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?").get(sessionHash(staleSession))).toEqual({ n: 0 });
  expect((await redeemRequest(first.token, "C".repeat(43))).status).toBe(410);
  const completed = await redeemRequest(freshToken, "D".repeat(43));
  expect(completed.status).toBe(201);
  expect(cookie(completed)).toContain("slirc_session=");
  expect(accounts.accountByEmail(identity.email)).toMatchObject({ id: identity.accountId, nick: identity.nick });
  expect(db.query("SELECT COUNT(*) AS n FROM accounts WHERE email=?").get(identity.email)).toEqual({ n: 1 });
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE nick=?").get(identity.nick)).toEqual({ n: 1 });
  expect((await redeemRequest(freshToken, "D".repeat(43))).status).toBe(410);
});

test("direct approval after cancellation reuses existing-human reservation", async () => {
  const existing = await accounts.provisionAccount("Existing Human", "applicant@example.test");
  const first = await approve();
  const attempt = admissions.beginRedemption(first.token, "E".repeat(43), "Existing Human");
  expect(attempt.status).toBe("claimed");
  if (attempt.status !== "claimed") return;
  const identity = await accounts.reserveAdmissionIdentity(first.id, attempt.fence);
  expect(identity).toMatchObject({ accountId: existing.id, nick: existing.nick, newAccount: false });
  const cancelUrl = `https://app.example.test/api/admissions/${first.id}/cancel`;
  expect((await app.request(`/api/admissions/${first.id}/cancel`, { method: "POST", headers: csrf(cancelUrl, "slirc_session=owner-session") })).status).toBe(200);
  const direct = await ownerApprove();
  expect(direct.status).toBe(202);
  const body = await direct.json() as any;
  const freshToken = sent[1]!.text.match(/#token=([A-Za-z0-9_-]+)&destination=help/)![1]!;
  expect(body).toMatchObject({ created: true, admission: { id: first.id, generation: 3, state: "pending" } });
  expect(db.query("SELECT reserved_account_id,reserved_nick,reserved_new_account FROM admissions WHERE id=?").get(first.id)).toEqual({
    reserved_account_id: existing.id, reserved_nick: existing.nick, reserved_new_account: 0,
  });
  const staleSession = "stale-existing-session";
  expect(admissions.finalizeRedemption({ id: first.id, fence: attempt.fence, identity,
    session: { tokenHash: sessionHash(staleSession), createdAt: Date.now(), device: "test" } })).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?").get(sessionHash(staleSession))).toEqual({ n: 0 });
  expect((await redeemRequest(first.token, "E".repeat(43))).status).toBe(410);
  const completed = await redeemRequest(freshToken, "F".repeat(43), "Existing Human");
  expect(completed.status).toBe(201);
  expect(accounts.accountByEmail("applicant@example.test")).toMatchObject({ id: existing.id, nick: existing.nick });
  expect(db.query("SELECT COUNT(*) AS n FROM accounts WHERE email='applicant@example.test'").get()).toEqual({ n: 1 });
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE nick=?").get(existing.nick)).toEqual({ n: 1 });
  expect((await redeemRequest(freshToken, "F".repeat(43), "Existing Human")).status).toBe(410);
});

test("direct approval after cancellation rejects revision or email drift without mutation", async () => {
  const first = await approve();
  const attempt = admissions.beginRedemption(first.token, "G".repeat(43), "New Person");
  expect(attempt.status).toBe("claimed");
  if (attempt.status !== "claimed") return;
  const identity = await accounts.reserveAdmissionIdentity(first.id, attempt.fence);
  const cancelUrl = `https://app.example.test/api/admissions/${first.id}/cancel`;
  expect((await app.request(`/api/admissions/${first.id}/cancel`, { method: "POST", headers: csrf(cancelUrl, "slirc_session=owner-session") })).status).toBe(200);
  const before = db.query("SELECT * FROM admissions WHERE id=?").get(first.id);
  expect(before).toMatchObject({ reserved_account_id: identity.accountId, reserved_nick: identity.nick, reserved_new_account: identity.newAccount ? 1 : 0 });

  applications = [{ ...applications[0]!, revision: 5 }];
  expect((await ownerApprove("17", 5)).status).toBe(409);
  applications = [{ ...applications[0]!, revision: 4, email: "changed@example.test" }];
  expect((await ownerApprove()).status).toBe(409);
  expect(sent).toHaveLength(1);
  expect(db.query("SELECT COUNT(*) AS n FROM admissions").get()).toEqual({ n: 1 });
  expect(db.query("SELECT * FROM admissions WHERE id=?").get(first.id)).toEqual(before);
  expect(admissions.admissionForToken(first.token)).toBeNull();

});

test("reissue refuses changed email or current revision instead of changing original approval", async () => {
  const issue = await approve();
  applications = [{ ...applications[0]!, email: "changed@example.test", revision: 5 }];
  const url = `https://app.example.test/api/admissions/${issue.id}/reissue`;
  const response = await app.request(`/api/admissions/${issue.id}/reissue`, { method: "POST", headers: csrf(url, "slirc_session=owner-session"), body: JSON.stringify({ revision: 5 }) });
  expect(response.status).toBe(409);
  expect(admissions.reissueAdmission(issue.id, applications[0]!)).toBeNull();
  expect(admissions.admissionList()[0]).toMatchObject({ id: issue.id, email: "applicant@example.test", revision: 4, generation: 1, state: "pending" });
  expect(sent).toHaveLength(1);
});

test("cancel and reissue invalidate old capability; expired capability cannot redeem", async () => {
  const first = await approve();
  const cancelUrl = `https://app.example.test/api/admissions/${first.id}/cancel`;
  const cancelled = await app.request(`/api/admissions/${first.id}/cancel`, { method: "POST", headers: csrf(cancelUrl, "slirc_session=owner-session") });
  expect(cancelled.status).toBe(200);
  const reissueUrl = `https://app.example.test/api/admissions/${first.id}/reissue`;
  const reissued = await app.request(`/api/admissions/${first.id}/reissue`, { method: "POST", headers: csrf(reissueUrl, "slirc_session=owner-session"), body: JSON.stringify({ revision: 4 }) });
  expect(reissued.status).toBe(202);
  const second = (await reissued.json() as any).admission;
  const oldToken = await redeemRequest(first.token, "E".repeat(43));
  expect(oldToken.status).toBe(410);
  db.query("UPDATE admissions SET expires_at=0 WHERE id=?").run(second.id);
  expect((await redeemRequest(sent[1].text.match(/#token=([A-Za-z0-9_-]+)&destination=help/)![1], "F".repeat(43))).status).toBe(410);
  expect(accounts.accountByEmail("applicant@example.test")).toBeNull();
});

test("redemption response loss requires normal login; matching session can then retry both destinations", async () => {
  const issue = await approve();
  const redeemed = await redeemRequest(issue.token, "G".repeat(43));
  expect(redeemed.status).toBe(201);
  const redeemedCookie = cookie(redeemed);
  const repeated = await redeemRequest(issue.token, "G".repeat(43));
  expect(repeated.status).toBe(410);
  expect(repeated.headers.get("set-cookie")).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE nick<>'bitbonsai'").get()).toEqual({ n: 1 });

  const account = accounts.accountByEmail("applicant@example.test")!;
  const wrongDestination = await app.request("/api/admission/destination", { method: "POST", headers: csrf("https://app.example.test/api/admission/destination", "slirc_session=owner-session"), body: JSON.stringify({ token: issue.token, destination: "help" }) });
  expect(wrongDestination.status).toBe(404);
  const help = await app.request("/api/admission/destination", { method: "POST", headers: csrf("https://app.example.test/api/admission/destination", redeemedCookie), body: JSON.stringify({ token: issue.token, destination: "help" }) });
  expect(help.status).toBe(200);
  expect(await help.json()).toMatchObject({ nick: "help" });
  addSession(account.nick, "independent-admitted-session");
  db.query("UPDATE admissions SET expires_at=0 WHERE id=?").run(issue.id);
  const independentCookie = "slirc_session=independent-admitted-session";
  const founder = await app.request("/api/admission/destination", { method: "POST", headers: csrf("https://app.example.test/api/admission/destination", independentCookie), body: JSON.stringify({ token: issue.token, destination: "founder" }) });
  expect(founder.status).toBe(200);
  expect(await founder.json()).toMatchObject({ nick: "bitbonsai" });
  expect(db.query("SELECT COUNT(*) AS n FROM direct_conversations WHERE first_nick=? OR second_nick=?").get(account.nick, account.nick)).toEqual({ n: 2 });
});

test("unfinished provisioning retries same reserved account; DM failure leaves destination retryable", async () => {
  const issue = await approve();
  const claim = "H".repeat(43);
  const claimed = admissions.beginRedemption(issue.token, claim, "Reserved Person");
  expect(claimed.status).toBe("claimed");
  if (claimed.status !== "claimed") return;
  process.env.ERGO_API_MOCK = "false";
  delete process.env.ERGO_API_TOKEN;
  delete process.env.ERGO_API_TOKEN_FILE;
  const identity = await accounts.reserveAdmissionIdentity(issue.id, claimed.fence);
  await expect(accounts.provisionAdmissionIdentity(identity, issue.id)).rejects.toThrow("ERGO_API_TOKEN required");
  expect(accounts.accountByEmail(identity.email)).toBeNull();
  const retryIdentity = await accounts.reserveAdmissionIdentity(issue.id, claimed.fence);
  expect(retryIdentity).toEqual(identity);
  process.env.ERGO_API_MOCK = "true";
  await accounts.provisionAdmissionIdentity(retryIdentity, issue.id);
  const sessionToken = "admitted-session";
  const completed = admissions.finalizeRedemption({ id: issue.id, fence: claimed.fence, identity: retryIdentity,
    session: { tokenHash: sessionHash(sessionToken), createdAt: Date.now(), device: "test" } });
  expect(completed).toEqual({ nick: identity.nick });
  expect(accounts.accountByEmail(identity.email)?.nick).toBe(identity.nick);
  failNextDirect = true;
  const first = await app.request("/api/admission/destination", { method: "POST", headers: csrf("https://app.example.test/api/admission/destination", "slirc_session=admitted-session"), body: JSON.stringify({ token: issue.token, destination: "founder" }) });
  expect(first.status).toBe(500);
  db.query("UPDATE admissions SET expires_at=0 WHERE id=?").run(issue.id);
  const retry = await app.request("/api/admission/destination", { method: "POST", headers: csrf("https://app.example.test/api/admission/destination", "slirc_session=admitted-session"), body: JSON.stringify({ token: issue.token, destination: "founder" }) });
  expect(retry.status).toBe(200);
  expect(db.query("SELECT COUNT(*) AS n FROM direct_conversations WHERE first_nick=? OR second_nick=?").get(identity.nick, identity.nick)).toEqual({ n: 1 });
});

test("delivery intent and uncertain outcomes persist; retry requires an owner reissue", async () => {
  nextMail = "failed";
  const url = "https://app.example.test/api/admissions/approve";
  const failed = await app.request("/api/admissions/approve", { method: "POST", headers: csrf(url, "slirc_session=owner-session"), body: JSON.stringify({ applicationId: "17", revision: 4 }) });
  expect(failed.status).toBe(500);
  const first = (await failed.json() as any).admission;
  expect(first.delivery).toBe("failed");
  expect(sent).toHaveLength(1);
  const duplicate = await app.request("/api/admissions/approve", { method: "POST", headers: csrf(url, "slirc_session=owner-session"), body: JSON.stringify({ applicationId: "17", revision: 4 }) });
  expect(duplicate.status).toBe(200);
  expect(sent).toHaveLength(1);

  nextMail = "uncertain";
  db.query("UPDATE admissions SET expires_at=0 WHERE id=?").run(first.id);
  const reissueUrl = `https://app.example.test/api/admissions/${first.id}/reissue`;
  const reissued = await app.request(`/api/admissions/${first.id}/reissue`, { method: "POST", headers: csrf(reissueUrl, "slirc_session=owner-session"), body: JSON.stringify({ revision: 4 }) });
  expect(reissued.status).toBe(202);
  expect((await reissued.json() as any).admission.delivery).toBe("uncertain");
  expect(admissions.admissionList()).toHaveLength(1);
  expect(admissions.admissionList()[0]).toMatchObject({ id: first.id, delivery: "uncertain", generation: 2 });
  expect(sent[0].idempotencyKey).not.toBe(sent[1].idempotencyKey);
  expect(sent).toHaveLength(2);
});

test("cancellation and first redemption serialize so only one can win", async () => {
  const issue = await approve();
  const cancelUrl = `https://app.example.test/api/admissions/${issue.id}/cancel`;
  const [cancelled, redeemed] = await Promise.all([
    app.request(`/api/admissions/${issue.id}/cancel`, { method: "POST", headers: csrf(cancelUrl, "slirc_session=owner-session") }),
    redeemRequest(issue.token, "M".repeat(43)),
  ]);
  expect(["200,410", "409,201"]).toContain(`${cancelled.status},${redeemed.status}`);
});

test("cancel and reissue before reservation rejects stale attempt and keeps one admission row", async () => {
  const issue = await approve();
  const stale = admissions.beginRedemption(issue.token, "D".repeat(43), "Stale Name");
  expect(stale.status).toBe("claimed");
  if (stale.status !== "claimed") return;
  expect(admissions.cancelAdmission(issue.id)).toBe(true);
  const next = admissions.reissueAdmission(issue.id, applications[0]!);
  expect(next).not.toBeNull();
  expect(next!.admission.id).toBe(issue.id);
  expect(next!.generation).toBe(3);
  await expect(accounts.reserveAdmissionIdentity(issue.id, stale.fence)).rejects.toThrow("no longer current");
  expect(db.query("SELECT reserved_account_id,reserved_nick,reserved_new_account FROM admissions WHERE id=?").get(issue.id)).toEqual({
    reserved_account_id: null, reserved_nick: null, reserved_new_account: null,
  });
  expect(admissions.beginRedemption(issue.token, "D".repeat(43), "Stale Name").status).toBe("invalid");
  const fresh = admissions.beginRedemption(next!.token, "E".repeat(43), "Fresh Name");
  expect(fresh.status).toBe("claimed");
  expect(db.query("SELECT COUNT(*) AS n FROM admissions").get()).toEqual({ n: 1 });
});

test("owner can cancel and reissue an unfinished claim, retaining reservation and fencing old claim", async () => {
  const issue = await approve();
  const attempt = admissions.beginRedemption(issue.token, "J".repeat(43), "New Person");
  expect(attempt.status).toBe("claimed");
  if (attempt.status !== "claimed") return;
  expect(admissions.beginRedemption(issue.token, "J".repeat(43), "Different Name").status).toBe("name-mismatch");
  expect(admissions.beginRedemption(issue.token, "L".repeat(43), "New Person").status).toBe("claim-mismatch");
  const identity = await accounts.reserveAdmissionIdentity(issue.id, attempt.fence);
  const cancelUrl = `https://app.example.test/api/admissions/${issue.id}/cancel`;
  expect((await app.request(`/api/admissions/${issue.id}/cancel`, { method: "POST", headers: csrf(cancelUrl, "slirc_session=owner-session") })).status).toBe(200);
  const reissueUrl = `https://app.example.test/api/admissions/${issue.id}/reissue`;
  expect((await app.request(`/api/admissions/${issue.id}/reissue`, { method: "POST", headers: csrf(reissueUrl, "slirc_session=owner-session"), body: JSON.stringify({ revision: 4 }) })).status).toBe(202);
  const current = admissions.admissionList()[0]!;
  expect(current).toMatchObject({ id: issue.id, state: "pending", generation: 3 });
  const nextToken = sent[1]!.text.match(/#token=([A-Za-z0-9_-]+)&destination=help/)![1]!;
  expect(admissions.beginRedemption(issue.token, "J".repeat(43), "New Person").status).toBe("invalid");
  const fresh = admissions.beginRedemption(nextToken, "R".repeat(43), "Changed Name");
  expect(fresh.status).toBe("claimed");
  if (fresh.status !== "claimed") return;
  const freshIdentity = await accounts.reserveAdmissionIdentity(issue.id, fresh.fence);
  expect(freshIdentity.accountId).toBe(identity.accountId);
  expect(freshIdentity.nick).toBe(identity.nick);
  expect(freshIdentity.newAccount).toBe(identity.newAccount);
  expect(freshIdentity.fullName).toBe("Changed Name");
});

test("expiry equality rejects unfinished authorization while just-before-expiry commit succeeds", async () => {
  const appOne = { ...applications[0]!, id: "expiry-before", email: "expiry-before@example.test" };
  const first = admissions.approveApplication(appOne);
  const attemptOne = admissions.beginRedemption(first.token!, "V".repeat(43), "Before Expiry");
  expect(attemptOne.status).toBe("claimed");
  if (attemptOne.status !== "claimed") return;
  const identityOne = await accounts.reserveAdmissionIdentity(first.admission.id, attemptOne.fence);
  await accounts.provisionAdmissionIdentity(identityOne, first.admission.id);
  const expiryOne = admissions.admissionList().find((row) => row.id === first.admission.id)!.expiresAt;
  const before = admissions.finalizeRedemption({ id: first.admission.id, fence: attemptOne.fence, identity: identityOne,
    session: { tokenHash: sessionHash("before-expiry"), createdAt: Date.now(), device: "test" } }, expiryOne - 1);
  expect(before).toEqual({ nick: identityOne.nick });

  const appTwo = { ...applications[0]!, id: "expiry-equality", email: "expiry-equality@example.test" };
  const second = admissions.approveApplication(appTwo);
  const attemptTwo = admissions.beginRedemption(second.token!, "W".repeat(43), "At Expiry");
  expect(attemptTwo.status).toBe("claimed");
  if (attemptTwo.status !== "claimed") return;
  const identityTwo = await accounts.reserveAdmissionIdentity(second.admission.id, attemptTwo.fence);
  await accounts.provisionAdmissionIdentity(identityTwo, second.admission.id);
  const expiryTwo = admissions.admissionList().find((row) => row.id === second.admission.id)!.expiresAt;
  expect(admissions.finalizeRedemption({ id: second.admission.id, fence: attemptTwo.fence, identity: identityTwo,
    session: { tokenHash: sessionHash("at-expiry"), createdAt: Date.now(), device: "test" } }, expiryTwo)).toBeNull();
  expect(accounts.accountByEmail(identityTwo.email)).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?").get(sessionHash("at-expiry"))).toEqual({ n: 0 });
  expect(db.query("SELECT state FROM admissions WHERE id=?").get(second.admission.id)).toEqual({ state: "redeeming" });
});

test("completion before owner action wins; owner cancellation or reissue before completion fences it", async () => {
  const first = admissions.approveApplication({ ...applications[0]!, id: "complete-first", email: "complete-first@example.test" });
  const attempt = admissions.beginRedemption(first.token!, "X".repeat(43), "Complete First");
  expect(attempt.status).toBe("claimed");
  if (attempt.status !== "claimed") return;
  const identity = await accounts.reserveAdmissionIdentity(first.admission.id, attempt.fence);
  await accounts.provisionAdmissionIdentity(identity, first.admission.id);
  expect(admissions.finalizeRedemption({ id: first.admission.id, fence: attempt.fence, identity,
    session: { tokenHash: sessionHash("complete-first"), createdAt: Date.now(), device: "test" } })).toEqual({ nick: identity.nick });
  expect(admissions.cancelAdmission(first.admission.id)).toBe(false);
  expect(admissions.reissueAdmission(first.admission.id, { ...applications[0]!, id: "complete-first", email: identity.email })).toBeNull();

  const second = admissions.approveApplication({ ...applications[0]!, id: "owner-first", email: "owner-first@example.test" });
  const pending = admissions.beginRedemption(second.token!, "Y".repeat(43), "Owner First");
  expect(pending.status).toBe("claimed");
  if (pending.status !== "claimed") return;
  const reserved = await accounts.reserveAdmissionIdentity(second.admission.id, pending.fence);
  await accounts.provisionAdmissionIdentity(reserved, second.admission.id);
  expect(admissions.cancelAdmission(second.admission.id)).toBe(true);
  expect(admissions.finalizeRedemption({ id: second.admission.id, fence: pending.fence, identity: reserved,
    session: { tokenHash: sessionHash("owner-first"), createdAt: Date.now(), device: "test" } })).toBeNull();
  expect(accounts.accountByEmail(reserved.email)).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?").get(sessionHash("owner-first"))).toEqual({ n: 0 });
});

test("simultaneous reissues fence old POSTs and mail callbacks on the same row", async () => {
  const issue = await approve();
  const application = applications[0]!;
  const first = admissions.reissueAdmission(issue.id, application)!;
  const second = admissions.reissueAdmission(issue.id, application)!;
  expect(first.admission.id).toBe(issue.id);
  expect(second.admission.id).toBe(issue.id);
  expect([first.generation, second.generation]).toEqual([2, 3]);
  admissions.recordAdmissionDelivery(issue.id, first.generation, "sent");
  expect(admissions.admissionList()[0]).toMatchObject({ generation: 3, delivery: "sending" });
  admissions.recordAdmissionDelivery(issue.id, second.generation, "sent");
  expect(admissions.admissionList()[0]).toMatchObject({ generation: 3, delivery: "sent" });
  expect((await redeemRequest(first.token, "Z".repeat(43))).status).toBe(410);
  const current = await redeemRequest(second.token, "a".repeat(43), "Latest Name");
  expect(current.status).toBe(201);
  expect(db.query("SELECT COUNT(*) AS n FROM admissions").get()).toEqual({ n: 1 });
  expect(db.query("SELECT COUNT(*) AS n FROM accounts WHERE email=?").get("applicant@example.test")).toEqual({ n: 1 });
});

test("normal account provisioning and admission reservation serialize around nickname claims", async () => {
  const appFirst = { ...applications[0]!, id: "reserve-first", email: "reserve-first@example.test" };
  const first = admissions.approveApplication(appFirst);
  const claimFirst = admissions.beginRedemption(first.token!, "1".repeat(43), "Shared Name");
  if (claimFirst.status !== "claimed") throw new Error("claim failed");
  const [reservedFirst, regularSecond] = await Promise.all([
    accounts.reserveAdmissionIdentity(first.admission.id, claimFirst.fence),
    accounts.provisionAccount("Shared Name", "regular-second@example.test"),
  ]);
  expect(regularSecond.nick).not.toBe(reservedFirst.nick);
  await expect(accounts.provisionAccount("Another Person", appFirst.email)).rejects.toThrow("reserved for its admission link");

  const appSecond = { ...applications[0]!, id: "normal-first", email: "normal-first@example.test" };
  const second = admissions.approveApplication(appSecond);
  const claimSecond = admissions.beginRedemption(second.token!, "2".repeat(43), "Other Shared Name");
  if (claimSecond.status !== "claimed") throw new Error("claim failed");
  const regularFirst = await accounts.provisionAccount("Other Shared Name", appSecond.email);
  const reservedSecond = await accounts.reserveAdmissionIdentity(second.admission.id, claimSecond.fence);
  expect(reservedSecond.nick).toBe(regularFirst.nick);
  expect(reservedSecond.accountId).toBe(regularFirst.id);
  expect(reservedSecond.newAccount).toBe(false);
  expect(db.query("SELECT COUNT(*) AS n FROM admissions WHERE reserved_account_id IS NOT NULL").get()).toEqual({ n: 2 });
});

test("fresh process resumes lost claim after successful Ergo registration with the same immutable identity", async () => {
  let registeredNick = "";
  let registeredPassword = "";
  let registrations = 0;
  const ergoServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json() as { accountName: string; passphrase: string };
    if (path === "/v1/ns/saregister") {
      registrations++;
      if (registrations === 1) {
        registeredNick = body.accountName; registeredPassword = body.passphrase;
        return Response.json({ success: true });
      }
      return Response.json({ success: false, errorCode: "ACCOUNT_EXISTS" });
    }
    if (path === "/v1/check_auth") return Response.json({ success: body.accountName === registeredNick && body.passphrase === registeredPassword });
    return new Response(null, { status: 404 });
  } });
  const dbPath = `/tmp/slirc-admission-recovery-${randomUUID()}.sqlite`;
  const childScript = `
    import { db } from "./src/db.ts";
    import { approveApplication, beginRedemption, finalizeRedemption, reissueAdmission } from "./src/admissions.ts";
    import { provisionAdmissionIdentity, reserveAdmissionIdentity } from "./src/accounts.ts";
    const application = { id: "process-app", email: "process@example.test", selfhost: false, createdAt: 1, revision: 7 };
    if (process.env.PHASE === "first") {
      const approval = approveApplication(application);
      const claim = beginRedemption(approval.token, "A".repeat(43), "First Name");
      if (claim.status !== "claimed") throw new Error("first process claim failed");
      const identity = await reserveAdmissionIdentity(approval.admission.id, claim.fence);
      await provisionAdmissionIdentity(identity, approval.admission.id);
      console.log(JSON.stringify({ id: approval.admission.id, token: approval.token, accountId: identity.accountId, nick: identity.nick, newAccount: identity.newAccount }));
    } else {
      const prior = JSON.parse(process.env.PRIOR!);
      const issue = reissueAdmission(prior.id, application);
      if (!issue) throw new Error(JSON.stringify({ prior, row: db.query("SELECT id,application_id,application_revision,state,approved_email,generation FROM admissions WHERE id=?").get(prior.id), application }));
      const claim = beginRedemption(issue.token, "B".repeat(43), "Second Name");
      if (claim.status !== "claimed") throw new Error("new process claim failed");
      const identity = await reserveAdmissionIdentity(prior.id, claim.fence);
      if (identity.accountId !== prior.accountId || identity.nick !== prior.nick || identity.newAccount !== prior.newAccount) throw new Error("reserved identity changed");
      await provisionAdmissionIdentity(identity, prior.id);
      const done = finalizeRedemption({ id: prior.id, fence: claim.fence, identity, session: { tokenHash: "c".repeat(64), createdAt: Date.now(), device: "child" } });
      if (!done) throw new Error("finalization failed");
      console.log(JSON.stringify({ id: prior.id, nick: done.nick, accountCount: db.query("SELECT COUNT(*) AS n FROM accounts WHERE email=?").get(application.email), sessionCount: db.query("SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?").get("c".repeat(64)) }));
    }
  `;
  const runChild = async (phase: string, prior?: unknown) => {
    const child = Bun.spawn([process.execPath, "-e", childScript], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, DB_PATH: dbPath, NODE_ENV: "test", ERGO_API_MOCK: "false",
        ERGO_API_URL: `http://127.0.0.1:${ergoServer.port}`, ERGO_API_TOKEN: "fresh-process-admission",
        ERGO_API_TOKEN_FILE: "/path/that/does/not/exist", OWNER_NICK: "bitbonsai", ADMIN_NICK: "bitbonsai",
        USERS_JSON: JSON.stringify({ bitbonsai: "owner@example.com" }), IRC_PASSWORDS_JSON: JSON.stringify({ bitbonsai: "owner-pass" }),
        PHASE: phase, ...(prior ? { PRIOR: JSON.stringify(prior) } : {}) },
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const status = await child.exited;
    expect(status, stderr).toBe(0);
    return JSON.parse(stdout.trim().split("\\n").at(-1)!);
  };
  try {
    const first = await runChild("first");
    for (const key of ["id", "token", "accountId", "nick"] as const) expect(typeof first[key]).toBe("string");
    expect(first.newAccount).toBe(true);
    const second = await runChild("second", first);
    expect(second).toMatchObject({ id: first.id, nick: first.nick, accountCount: { n: 1 }, sessionCount: { n: 1 } });
    expect(registrations).toBe(2);
    expect(registeredNick).toBe(first.nick);
    expect(registeredPassword).toBe(ircPasswordFor(first.accountId, 0));
  } finally {
    ergoServer.stop(true);
    await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((path) => rm(path, { force: true })));
  }
});

test("cancel and reissue during paused Ergo registration fence the old response without local activation", async () => {
  const issue = await approve();
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let releaseResolve!: () => void;
  const held = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let nick = "";
  let password = "";
  const ergoServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { accountName: string; passphrase: string };
    if (new URL(request.url).pathname !== "/v1/ns/saregister") return new Response(null, { status: 404 });
    nick = body.accountName; password = body.passphrase;
    startedResolve();
    await held;
    return Response.json({ success: true });
  } });
  const old = { mock: process.env.ERGO_API_MOCK, url: process.env.ERGO_API_URL, token: process.env.ERGO_API_TOKEN, tokenFile: process.env.ERGO_API_TOKEN_FILE };
  process.env.ERGO_API_MOCK = "false";
  process.env.ERGO_API_URL = `http://127.0.0.1:${ergoServer.port}`;
  process.env.ERGO_API_TOKEN = "paused-admission-test";
  process.env.ERGO_API_TOKEN_FILE = "/path/that/does/not/exist";
  try {
    const oldPost = redeemRequest(issue.token, "P".repeat(43), "Old Attempt");
    await started;
    const reserved = db.query("SELECT reserved_account_id,reserved_nick,reserved_new_account FROM admissions WHERE id=?").get(issue.id) as any;
    expect(reserved.reserved_account_id).toBeTruthy();
    expect(reserved.reserved_nick).toBe(nick);
    expect(reserved.reserved_new_account).toBe(1);
    expect(password).toBe(ircPasswordFor(reserved.reserved_account_id, 0));
    const cancelUrl = `https://app.example.test/api/admissions/${issue.id}/cancel`;
    expect((await app.request(`/api/admissions/${issue.id}/cancel`, { method: "POST", headers: csrf(cancelUrl, "slirc_session=owner-session") })).status).toBe(200);
    const reissueUrl = `https://app.example.test/api/admissions/${issue.id}/reissue`;
    const reissued = await app.request(`/api/admissions/${issue.id}/reissue`, { method: "POST", headers: csrf(reissueUrl, "slirc_session=owner-session"), body: JSON.stringify({ revision: 4 }) });
    expect(reissued.status).toBe(202);
    const newerToken = sent[1]!.text.match(/#token=([A-Za-z0-9_-]+)&destination=help/)![1]!;
    releaseResolve();
    const oldResponse = await oldPost;
    expect(oldResponse.status).toBe(409);
    expect(oldResponse.headers.get("set-cookie")).toBeNull();
    expect(accounts.accountByEmail("applicant@example.test")).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE nick=?").get(nick)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM founder_welcome_jobs").get()).toEqual({ n: 0 });
    expect(db.query("SELECT reserved_account_id,reserved_nick,reserved_new_account,state,claim_hash FROM admissions WHERE id=?").get(issue.id)).toEqual({
      ...reserved, state: "pending", claim_hash: null,
    });
    expect((await redeemRequest(newerToken, "S".repeat(43), "Current Attempt")).status).toBe(201);
  } finally {
    releaseResolve();
    ergoServer.stop(true);
    if (old.mock === undefined) delete process.env.ERGO_API_MOCK; else process.env.ERGO_API_MOCK = old.mock;
    if (old.url === undefined) delete process.env.ERGO_API_URL; else process.env.ERGO_API_URL = old.url;
    if (old.token === undefined) delete process.env.ERGO_API_TOKEN; else process.env.ERGO_API_TOKEN = old.token;
    if (old.tokenFile === undefined) delete process.env.ERGO_API_TOKEN_FILE; else process.env.ERGO_API_TOKEN_FILE = old.tokenFile;
  }
});

test("Ergo registration response loss retries same immutable reserved account", async () => {
  const issue = await approve();
  const claim = admissions.beginRedemption(issue.token, "K".repeat(43), "Retry Identity");
  expect(claim.status).toBe("claimed");
  if (claim.status !== "claimed") return;
  const identity = await accounts.reserveAdmissionIdentity(issue.id, claim.fence);
  let registered = false;
  let registeredNick = "";
  let registeredPassword = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer admission-test-token") return new Response(null, { status: 401 });
    const body = await request.json() as { accountName: string; passphrase: string };
    if (new URL(request.url).pathname === "/v1/ns/saregister") {
      if (!registered) {
        registered = true;
        registeredNick = body.accountName;
        registeredPassword = body.passphrase;
        return new Response("lost after registration", { status: 503 });
      }
      return Response.json({ success: false, errorCode: "ACCOUNT_EXISTS", error: "exists" });
    }
    if (new URL(request.url).pathname === "/v1/check_auth") {
      return Response.json({ success: body.accountName === registeredNick && body.passphrase === registeredPassword });
    }
    return new Response(null, { status: 404 });
  } });
  const old = { mock: process.env.ERGO_API_MOCK, url: process.env.ERGO_API_URL, token: process.env.ERGO_API_TOKEN, tokenFile: process.env.ERGO_API_TOKEN_FILE };
  process.env.ERGO_API_MOCK = "false";
  process.env.ERGO_API_URL = `http://127.0.0.1:${server.port}`;
  process.env.ERGO_API_TOKEN = "admission-test-token";
  process.env.ERGO_API_TOKEN_FILE = "/path/that/does/not/exist";
  try {
    await expect(accounts.provisionAdmissionIdentity(identity, issue.id)).rejects.toThrow("Ergo API returned 503");
    expect(accounts.accountByEmail(identity.email)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE nick=?").get(identity.nick)).toEqual({ n: 0 });
    const retryIdentity = await accounts.reserveAdmissionIdentity(issue.id, claim.fence);
    expect(retryIdentity).toEqual(identity);
    await accounts.provisionAdmissionIdentity(retryIdentity, issue.id);
    expect(accounts.accountByEmail(identity.email)).toBeNull();
    const completed = admissions.finalizeRedemption({ id: issue.id, fence: claim.fence, identity: retryIdentity,
      session: { tokenHash: sessionHash("response-loss-session"), createdAt: Date.now(), device: "test" } });
    expect(completed).toEqual({ nick: identity.nick });
    expect(db.query("SELECT COUNT(*) AS n FROM accounts WHERE email=?").get(identity.email)).toEqual({ n: 1 });
  } finally {
    server.stop(true);
    if (old.mock === undefined) delete process.env.ERGO_API_MOCK; else process.env.ERGO_API_MOCK = old.mock;
    if (old.url === undefined) delete process.env.ERGO_API_URL; else process.env.ERGO_API_URL = old.url;
    if (old.token === undefined) delete process.env.ERGO_API_TOKEN; else process.env.ERGO_API_TOKEN = old.token;
    if (old.tokenFile === undefined) delete process.env.ERGO_API_TOKEN_FILE; else process.env.ERGO_API_TOKEN_FILE = old.tokenFile;
  }
});

test("cancelled partial admission leaves existing human identity and sessions unchanged", async () => {
  const existing = await accounts.provisionAccount("Existing Human", "applicant@example.test");
  addSession(existing.nick, "existing-session");
  const original = db.query("SELECT account_id,nick,email,irc_password_gen,verified_at,provisional_expires_at FROM accounts WHERE account_id=?").get(existing.id);
  const originalSession = db.query("SELECT token_hash,nick,created_at,device FROM sessions WHERE nick=?").get(existing.nick);
  const issue = await approve();
  const first = admissions.beginRedemption(issue.token, "F".repeat(43), "Chosen Name");
  if (first.status !== "claimed") throw new Error("claim failed");
  const identity = await accounts.reserveAdmissionIdentity(issue.id, first.fence);
  expect(identity.accountId).toBe(existing.id);
  expect(identity.newAccount).toBe(false);
  expect(admissions.cancelAdmission(issue.id)).toBe(true);
  const next = admissions.reissueAdmission(issue.id, applications[0]!);
  expect(next).not.toBeNull();
  expect(await accounts.reserveAdmissionIdentity(issue.id, first.fence).catch(() => null)).toBeNull();
  expect(db.query("SELECT account_id,nick,email,irc_password_gen,verified_at,provisional_expires_at FROM accounts WHERE account_id=?").get(existing.id)).toEqual(original);
  expect(db.query("SELECT token_hash,nick,created_at,device FROM sessions WHERE nick=?").get(existing.nick)).toEqual(originalSession);
  expect(db.query("SELECT state FROM admissions WHERE id=?").get(issue.id)).toEqual({ state: "pending" });
});

test("SQLite failure after Ergo registration retries with same reserved ID and password", async () => {
  const issue = await approve();
  const claim = admissions.beginRedemption(issue.token, "Q".repeat(43), "SQLite Retry");
  expect(claim.status).toBe("claimed");
  if (claim.status !== "claimed") return;
  const identity = await accounts.reserveAdmissionIdentity(issue.id, claim.fence);
  let registeredNick = "";
  let registeredPassword = "";
  let registrations = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer sqlite-admission-test") return new Response(null, { status: 401 });
    const body = await request.json() as { accountName: string; passphrase: string };
    if (new URL(request.url).pathname === "/v1/ns/saregister") {
      registrations++;
      if (registrations === 1) {
        registeredNick = body.accountName;
        registeredPassword = body.passphrase;
        return Response.json({ success: true });
      }
      return Response.json({ success: false, errorCode: "ACCOUNT_EXISTS", error: "exists" });
    }
    if (new URL(request.url).pathname === "/v1/check_auth") {
      return Response.json({ success: body.accountName === registeredNick && body.passphrase === registeredPassword });
    }
    return new Response(null, { status: 404 });
  } });
  const old = { mock: process.env.ERGO_API_MOCK, url: process.env.ERGO_API_URL, token: process.env.ERGO_API_TOKEN, tokenFile: process.env.ERGO_API_TOKEN_FILE };
  const trigger = "fail_admission_session_insert";
  process.env.ERGO_API_MOCK = "false";
  process.env.ERGO_API_URL = `http://127.0.0.1:${server.port}`;
  process.env.ERGO_API_TOKEN = "sqlite-admission-test";
  process.env.ERGO_API_TOKEN_FILE = "/path/that/does/not/exist";
  db.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON sessions WHEN NEW.nick='${identity.nick}' BEGIN SELECT RAISE(FAIL, 'simulated SQLite failure'); END`);
  try {
    await accounts.provisionAdmissionIdentity(identity, issue.id);
    const reservedBefore = db.query("SELECT reserved_account_id,reserved_nick,reserved_new_account FROM admissions WHERE id=?").get(issue.id);
    expect(() => admissions.finalizeRedemption({ id: issue.id, fence: claim.fence, identity,
      session: { tokenHash: sessionHash("sqlite-retry-session"), createdAt: Date.now(), device: "test" } })).toThrow("simulated SQLite failure");
    expect(db.query("SELECT state FROM admissions WHERE id=?").get(issue.id)).toEqual({ state: "redeeming" });
    expect(accounts.accountByEmail(identity.email)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE nick=?").get(identity.nick)).toEqual({ n: 0 });
    db.exec(`DROP TRIGGER ${trigger}`);
    const retryIdentity = await accounts.reserveAdmissionIdentity(issue.id, claim.fence);
    expect(retryIdentity).toEqual(identity);
    await accounts.provisionAdmissionIdentity(retryIdentity, issue.id);
    const completed = admissions.finalizeRedemption({ id: issue.id, fence: claim.fence, identity: retryIdentity,
      session: { tokenHash: sessionHash("sqlite-retry-session"), createdAt: Date.now(), device: "test" } });
    expect(completed).toEqual({ nick: identity.nick });
    expect(db.query("SELECT reserved_account_id,reserved_nick,reserved_new_account FROM admissions WHERE id=?").get(issue.id)).toEqual(reservedBefore);
    expect(registeredNick).toBe(identity.nick);
    expect(registeredPassword).toBe(ircPasswordFor(identity.accountId, 0));
    expect(registrations).toBe(2);
    expect(db.query("SELECT COUNT(*) AS n FROM accounts WHERE email=?").get(identity.email)).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?").get(sessionHash("sqlite-retry-session"))).toEqual({ n: 1 });
  } finally {
    try { db.exec(`DROP TRIGGER IF EXISTS ${trigger}`); } catch {}
    server.stop(true);
    if (old.mock === undefined) delete process.env.ERGO_API_MOCK; else process.env.ERGO_API_MOCK = old.mock;
    if (old.url === undefined) delete process.env.ERGO_API_URL; else process.env.ERGO_API_URL = old.url;
    if (old.token === undefined) delete process.env.ERGO_API_TOKEN; else process.env.ERGO_API_TOKEN = old.token;
    if (old.tokenFile === undefined) delete process.env.ERGO_API_TOKEN_FILE; else process.env.ERGO_API_TOKEN_FILE = old.tokenFile;
  }
});

test("existing member email invitations remain on their existing route", async () => {
  const invite = await import("../src/email-invites.ts");
  const owner = accounts.accountByNick("bitbonsai")!;
  const row = invite.createEmailInvite({ inviter: owner.nick, inviterAccountId: owner.id, email: "invitee@example.test", destination: { type: "dm", channel: null } });
  invite.recordEmailInviteDelivery(row.token, "sent");
  const info = await app.request(`/api/join/${row.token}`);
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({ destination: { type: "dm", channel: null }, requiresVerifiedEmail: true });
  expect(db.query("SELECT COUNT(*) AS n FROM admissions").get()).toEqual({ n: 0 });
});

test("an admission name that breaks the display name rules starts out as the neutral nick", async () => {
  const issue = await approve();
  expect((await redeemRequest(issue.token, "R".repeat(43), "Support")).status).toBe(201);
  const account = accounts.accountByEmail("applicant@example.test")!;
  expect(account.nick).toMatch(/^member\d*$/);
  expect(db.query("SELECT full_name FROM profiles WHERE account=?").get(account.nick)).toEqual({ full_name: account.nick });
});
