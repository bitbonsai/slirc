import "./fixture.ts";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

// SLIRC_AGENTS_ENABLED=false must refuse pairing at the server, before a code is minted or redeemed.
process.env.SLIRC_AGENTS_ENABLED = "false";
const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");

const owner = accountByNick("bitbonsai")!;
const token = "agents-disabled-session";
db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), owner.nick, Date.now());
const cookie = { Cookie: `slirc_session=${token}` };
const off = "Agents are off on this instance.";

test("capabilities report pairing off", async () => {
  const body = await (await app.request("/api/agents/capabilities", { headers: cookie })).json();
  expect(body.enabled).toBe(false);
  expect(body.reason).toBe(off);
});

test("a session can't ask to pair and the CLI hears agents are off", async () => {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const res = await app.request("/api/agent/session/request", {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ protocol: 1, harness: "pi", sessionId: "s", sessionFile: "f" }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe(off);
  expect((db.query("SELECT count(*) AS n FROM agent_connect_requests").get() as { n: number }).n).toBe(0);
  expect(await (await app.request("/api/agent/version")).json()).toMatchObject({ enabled: false, reason: off });
});

test("the session connect route refuses before reading credentials", async () => {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const res = await app.request("/api/agent/session/connect", {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ protocol: 1, harness: "pi", code: "anything", sessionId: "s", sessionFile: "f" }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe(off);
});

test("all other agent session, forward, and channel-member agent routes refuse with 403 when disabled", async () => {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const auth = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  expect((await app.request("/api/agent/session/binding", { headers: auth })).status).toBe(403);
  expect((await app.request("/api/agent/session/attach", { method: "POST", headers: auth, body: "{}" })).status).toBe(403);
  expect((await app.request("/api/agent/session/events/poll", { headers: auth })).status).toBe(403);

  const forwardRes = await app.request("/api/agents/some-binding/forward", {
    method: "POST",
    headers: { ...cookie, Origin: "https://app.example.test", "Content-Type": "application/json", "X-Slirc-Agent": "1" },
    body: JSON.stringify({ channel: "#help", messageId: "m1" }),
  });
  expect(forwardRes.status).toBe(403);

  db.query("INSERT OR IGNORE INTO accounts (nick, email, role, kind, owner, created_at) VALUES ('disabled-bot', 'disabled-bot@agents.invalid', 'member', 'agent', ?, ?)")
    .run(owner.nick, Date.now());
  const memberRes = await app.request("/api/channels/help/members", {
    method: "POST",
    headers: { ...cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ nick: "disabled-bot" }),
  });
  expect(memberRes.status).toBe(403);
});
