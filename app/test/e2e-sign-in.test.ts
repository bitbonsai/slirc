// Sign-in end to end through the routes: ask for a link, read it out of the mail, open it, use
// the session, sign out. Only the mail provider is faked; the link and code are the real ones.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://app.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
delete process.env.MAGIC_LINK_LOG;
// A private workspace: an unknown address must still get nothing (open-chat-signup.test.ts covers
// the public playground's signup).
process.env.SLIRC_MODE = "private_workspace";
process.env.OPEN_CHANNELS = "";

import { beforeEach, expect, mock, test } from "bun:test";

const mail: { to: string; text: string }[] = [];
// Signing in opens the help DM; its oper calls are out of scope here.
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, createDirectChannel: async () => {}, readDirectChannelReady: async () => false }));
mock.module("resend", () => ({ Resend: class { emails = { send: async (message: any) => { mail.push(message); return { data: { id: "test" }, error: null }; } }; } }));

const { db } = await import("../src/db.ts");
const { app, settleSignIns } = await import("../src/server.ts");
const { resetRateLimits } = await import("../src/request-security.ts");

// /auth/request answers before it mails, so wait for that work as a person waits for the email.
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  await settleSignIns();
  return response;
};
const mailedLink = (text: string) => new URL(text.match(/https:\/\/\S+\/auth\/verify\?[^\s)]+/)![0]);
const mailedCode = (text: string) => text.match(/\b(\d{3}) (\d{3})\b/)!.slice(1).join("");
const sessionCookie = (response: Response) => response.headers.get("set-cookie")!.match(/slirc_session=[^;]+/)![0];
const me = async (cookie: string) => (await app.request("/auth/me", { headers: { Cookie: cookie } })).json();

beforeEach(() => {
  mail.length = 0;
  resetRateLimits();
  for (const table of ["sessions", "magic_links", "used_magic_links"]) db.query(`DELETE FROM ${table}`).run();
  db.query("DELETE FROM accounts WHERE nick = 'mara'").run();
  db.query("INSERT INTO accounts (nick, email, role, verified_at, created_at) VALUES ('mara', 'mara@example.test', 'member', 1, 1)").run();
});

test("a mailed link signs in once, the session reads the account, and sign-out ends it", async () => {
  expect((await post("/auth/request", { email: "Mara@Example.test", next: "/settings" })).status).toBe(204);
  expect(mail).toHaveLength(1);
  expect(mail[0].to).toBe("mara@example.test");
  const link = mailedLink(mail[0].text);
  expect(link.origin).toBe("https://app.example.test");

  const verified = await app.request(link.pathname + link.search);
  expect(verified.status).toBe(302);
  expect(verified.headers.get("location")).toBe("/settings");
  const cookie = sessionCookie(verified);
  expect(await me(cookie)).toMatchObject({ authenticated: true, nick: "mara", email: "mara@example.test" });
  const sessions = await (await app.request("/api/sessions", { headers: { Cookie: cookie } })).json();
  expect(sessions).toHaveLength(1);
  expect(sessions[0].current).toBe(true);

  // The same link cannot open a second session.
  const replay = await app.request(link.pathname + link.search);
  expect(replay.headers.get("set-cookie") || "").not.toMatch(/slirc_session=[^;]/);
  expect((db.query("SELECT COUNT(*) n FROM sessions WHERE nick = 'mara'").get() as { n: number }).n).toBe(1);

  expect((await app.request("/auth/logout", { method: "POST", headers: { Cookie: cookie } })).status).toBe(204);
  expect(await me(cookie)).toMatchObject({ authenticated: false });
  expect((await app.request("/api/sessions", { headers: { Cookie: cookie } })).status).toBe(401);
});

test("the code from the same mail signs in another tab and burns the link", async () => {
  expect((await post("/auth/request", { email: "mara@example.test" })).status).toBe(204);
  const { text } = mail[0];
  const signedIn = await post("/auth/code", { email: "mara@example.test", code: mailedCode(text) }, { Origin: "https://app.example.test", "X-Slirc-Sign-In": "1" });
  expect(signedIn.status).toBe(200);
  expect(await me(sessionCookie(signedIn))).toMatchObject({ authenticated: true, nick: "mara" });
  const link = mailedLink(text);
  expect((await (await app.request(`/auth/link-status?token=${link.searchParams.get("token")}`)).json()).used).toBe(true);
  const late = await app.request(link.pathname + link.search);
  expect(late.headers.get("set-cookie") || "").not.toMatch(/slirc_session=[^;]/);
});

test("an unknown address gets the same answer and no mail", async () => {
  const response = await post("/auth/request", { email: "stranger@example.test" });
  expect(response.status).toBe(204);
  expect(mail).toHaveLength(0);
  expect(db.query("SELECT 1 FROM accounts WHERE email = 'stranger@example.test'").get()).toBeNull();
});
