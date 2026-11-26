// Channel create and invite end to end through the routes: the owner creates an invite-only
// room, adds a member by nick, invites a stranger by email, and the stranger signs up from the
// mailed link and lands in the room. Oper IRC calls and the mail provider are faked.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://app.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
process.env.EMAIL_INVITE_LIMIT = "9";
delete process.env.MAGIC_LINK_LOG;

import { createHash } from "node:crypto";
import { expect, mock, test } from "bun:test";

const oper: string[] = [];
const mail: { to: string; text: string }[] = [];
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({
  ...grants,
  createChannel: async (channel: string, owner: string, visibility: string) => { oper.push(`create ${channel} ${owner} ${visibility}`); },
  grantChannelAccess: async (channel: string, nick: string) => { oper.push(`grant ${channel} ${nick}`); },
  allowChannelAccess: async (channel: string, nick: string) => { oper.push(`allow ${channel} ${nick}`); },
  createDirectChannel: async () => {},
}));
mock.module("resend", () => ({ Resend: class { emails = { send: async (message: any) => { mail.push(message); return { data: { id: "test" }, error: null }; } }; } }));

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const cookie = (token: string) => `slirc_session=${token}`;
const send = (method: string, path: string, token: string, body?: unknown) =>
  app.request(path, { method, headers: { Cookie: cookie(token), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const me = async (token: string) => (await app.request("/auth/me", { headers: { Cookie: cookie(token) } })).json();
const members = async (token: string) => (await (await send("GET", "/api/channels/%23ops-room/members", token)).json()).members.map((row: { nick: string }) => row.nick);

db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(hash("owner-e2e"), Date.now());
for (const nick of ["lena", "outsider"]) {
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES (?, ?, 'member', 1, 1)").run(nick, `${nick}@example.test`);
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(hash(`${nick}-e2e`), nick, Date.now());
}

test("an invite-only room admits people by nick and by email, and nobody else", async () => {
  const created = await send("POST", "/api/channels", "owner-e2e", { name: "Ops-Room", visibility: "secret" });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ channel: "#ops-room", owner: "bitbonsai", visibility: "secret" });
  expect(oper).toEqual(["create #ops-room bitbonsai secret"]);
  expect((await send("POST", "/api/channels", "owner-e2e", { name: "ops-room", visibility: "secret" })).status).toBe(409);
  expect((await me("owner-e2e")).channels).toContain("#ops-room");
  // Invite-only: not listed to others and its members are not readable from outside.
  expect((await me("lena-e2e")).availableChannels.map((item: { channel: string }) => item.channel)).not.toContain("#ops-room");
  expect((await send("GET", "/api/channels/%23ops-room/members", "lena-e2e")).status).toBe(403);
  expect((await send("POST", "/api/channels/ops-room/join", "lena-e2e")).status).toBe(404);

  const added = await send("POST", "/api/channels/%23ops-room/members", "owner-e2e", { nick: "@lena" });
  expect(await added.json()).toEqual({ channel: "#ops-room", nick: "lena", added: true });
  expect(oper).toContain("grant #ops-room lena");
  expect((await me("lena-e2e")).channels).toContain("#ops-room");
  expect(await members("lena-e2e")).toEqual(["bitbonsai", "lena"]);

  const invited = await send("POST", "/api/invites/email", "owner-e2e", { channel: "ops-room", email: "New.Person@Example.test" });
  expect(invited.status).toBe(200);
  // The owner is an admin, so there is no allowance to count down.
  expect(await invited.json()).toMatchObject({ sent: true, unlimited: true, remaining: null });
  expect(mail.map((item) => item.to)).toEqual(["new.person@example.test"]);
  const token = mail[0].text.match(/\/join\/([A-Za-z0-9_-]+)/)![1];
  const pending = await (await send("GET", "/api/channels/%23ops-room/members", "owner-e2e")).json();
  expect(pending.pendingInvitations).toEqual([{ email: "new.person@example.test", status: "pending" }]);

  const signup = await app.request("/auth/invitation/request", {
    method: "POST",
    headers: { Origin: "https://app.example.test", "X-Slirc-Invitation": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ token, name: "New Person" }),
  });
  expect(signup.status).toBe(200);
  const { nick } = await signup.json();
  const session = signup.headers.get("set-cookie")!.match(/slirc_session=([^;]+)/)![1];
  const joined = await send("POST", `/api/join/${token}`, session);
  expect(joined.status).toBe(200);
  expect((await me(session)).channels).toContain("#ops-room");
  expect(await members("owner-e2e")).toEqual(["bitbonsai", "lena", nick].sort());
  expect((await (await send("GET", "/api/channels/%23ops-room/members", "owner-e2e")).json()).pendingInvitations).toEqual([]);

  // A used invitation cannot admit a second account.
  expect((await send("POST", `/api/join/${token}`, "outsider-e2e")).status).toBeGreaterThanOrEqual(400);
  expect((await me("outsider-e2e")).channels).not.toContain("#ops-room");
});
