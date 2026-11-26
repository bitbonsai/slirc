import "./fixture.ts";
import { createHash, randomBytes } from "node:crypto";
import { beforeEach, expect, mock, test } from "bun:test";

// The pairing flow from the server's side: a session asks, someone signed in opens the request by
// its link or code and allows or denies it, and the session's poll gets its binding or the answer.
process.chdir(new URL("..", import.meta.url).pathname);
// IRC-side helpers are replaced; SQLite, provisioning and the routes are real.
const transport = await import("../src/agent-session-transport.ts");
mock.module("../src/agent-session-transport.ts", () => ({ ...transport, connectAgentTransport: async () => {} }));
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, createDirectChannel: async () => {}, setAlwaysOn: async () => {} }));
const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const connect = await import("../src/agent-connect.ts");
const { harnesses } = await import("../agent/src/harnesses/index.ts");

const token = "owner-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(createHash("sha256").update(token).digest("hex"), Date.now());
const owner = { Cookie: `slirc_session=${token}`, "Content-Type": "application/json" };
const secret = () => randomBytes(32).toString("base64url");
const session = { harness: "pi", protocol: 1, version: connect.AGENT_VERSION, sessionId: "s1", sessionFile: "/tmp/s1.jsonl", sessionName: "fix login", repo: "slirc", model: "m", machine: "MacBook" };
const ask = (key: string, body: object = session) => app.request("/api/agent/session/request", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const poll = (key: string, body: object = {}) => app.request("/api/agent/session/connect", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const open = (by: object, headers: Record<string, string> = owner) => app.request("/api/agents/requests/open", { method: "POST", headers, body: JSON.stringify(by) });
const decide = (id: string, allow: boolean) => app.request(`/api/agents/requests/${id}`, { method: "POST", headers: owner, body: JSON.stringify({ allow }) });
const tokenOf = (url: string) => url.split("#connect=")[1];

beforeEach(() => {
  connect.resetConnectThrottleForTests();
  db.query("DELETE FROM agent_connect_requests").run();
});

test("version route names the CLI version and the released harnesses", async () => {
  const response = await app.request("/api/agent/version");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.version).toBe(connect.AGENT_VERSION);
  expect(body.harnesses).toEqual(harnesses.filter((harness) => harness.released).map(({ id, name, terminalOnly }) => ({ id, name, ...(terminalOnly ? { terminal: true } : {}) })));
});

test("capabilities give the Agents page both lines for this workspace", async () => {
  expect((await app.request("/api/agents/capabilities")).status).toBe(401);
  const body = await (await app.request("/api/agents/capabilities", { headers: owner })).json();
  expect(body.commands).toEqual({ workspace: "app.example.test", npx: "npx slirc-agent@latest app.example.test", bunx: "bunx slirc-agent@latest app.example.test", session: { pi: "/slirc app.example.test", "claude": "/slirc app.example.test", codex: "slirc app.example.test", opencode: "/slirc app.example.test" } });
  // The copied command spells out app.slirc.org, so a connect code after it can't pass for a workspace.
  expect(connect.connectCommands("app.slirc.org")).toEqual({ workspace: "", npx: "npx slirc-agent@latest app.slirc.org", bunx: "bunx slirc-agent@latest app.slirc.org", session: { pi: "/slirc", "claude": "/slirc", codex: "slirc", opencode: "/slirc" } });
  expect(connect.connectCommands("calango.slirc.app")).toEqual({ workspace: "calango", npx: "npx slirc-agent@latest calango", bunx: "bunx slirc-agent@latest calango", session: { pi: "/slirc calango", "claude": "/slirc calango", codex: "slirc calango", opencode: "/slirc calango" } });
  expect(connect.connectCommands("chat.example.com:8443").npx).toBe("npx slirc-agent@latest chat.example.com:8443");
});

test("a session asks, the owner opens the link and allows, and the poll returns the binding", async () => {
  const key = secret();
  const asked = await (await ask(key)).json();
  expect(asked.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(asked.url).toContain("/agents#connect=");
  expect((await poll(key)).status).toBe(409);

  const card = await (await open({ token: tokenOf(asked.url) })).json();
  expect(card).toMatchObject({ harness: "pi", harnessName: "Pi", sessionName: "fix login", repo: "slirc", machine: "MacBook", code: asked.code });
  expect(card.sessionFile).toBeUndefined();
  const allowed = await decide(card.id, true);
  expect(allowed.status).toBe(200);
  const { nick } = await allowed.json();
  expect(nick).toMatch(/^pi-[0-9a-f]{4}$/);

  const bound = await poll(key);
  expect(bound.status).toBe(200);
  expect((await bound.json()).nick).toBe(nick);
  // Once bound, asking again says so instead of making a new request.
  expect(await (await ask(key)).json()).toEqual({ bound: true });
  // The link was used up.
  expect((await open({ token: tokenOf(asked.url) })).status).toBe(404);
});

test("the typed code opens the same card; dashes, case and look-alikes don't matter", async () => {
  const asked = await (await ask(secret(), { ...session, sessionId: "s2" })).json();
  const typed = asked.code.toLowerCase().replace("-", " ").replace(/1/g, "l").replace(/0/g, "o");
  const response = await open({ code: typed });
  expect(response.status).toBe(200);
  expect((await response.json()).code).toBe(asked.code);
  // Pasted from a terminal with spaces around and inside it.
  const pasted = await open({ code: ` ${asked.code.slice(0, 4)} - ${asked.code.slice(5)}\n` });
  expect(pasted.status).toBe(200);
  expect((await pasted.json()).code).toBe(asked.code);
});

test("deny tells the session; a new ask replaces the old link", async () => {
  const key = secret();
  const first = await (await ask(key, { ...session, sessionId: "s3" })).json();
  const second = await (await ask(key, { ...session, sessionId: "s3" })).json();
  expect((await open({ token: tokenOf(first.url) })).status).toBe(404);
  const card = await (await open({ token: tokenOf(second.url) })).json();
  expect((await decide(card.id, false)).status).toBe(204);
  const denied = await poll(key);
  expect(denied.status).toBe(403);
  expect((await denied.json()).code).toBe("denied");
  expect((await decide(card.id, true)).status).toBe(404);
  // Nothing exists for a session nobody allowed: no binding, no agent account.
  expect(db.query("SELECT COUNT(*) AS n FROM agent_session_bindings WHERE session_id = 's3'").get()).toEqual({ n: 0 });
});

test("an expired request can't be opened and the poll says to start over", async () => {
  const key = secret();
  const asked = await (await ask(key, { ...session, sessionId: "s4" })).json();
  db.query("UPDATE agent_connect_requests SET expires_at = ?").run(Date.now() - 1);
  expect((await open({ token: tokenOf(asked.url) })).status).toBe(404);
  const expired = await poll(key);
  expect(expired.status).toBe(404);
  expect((await expired.json()).code).toBe("expired");
});

test("wrong codes are throttled per account; opening needs a signed-in person", async () => {
  expect((await open({ code: "ZZZZ-ZZZZ" }, { "Content-Type": "application/json" })).status).toBe(401);
  for (let attempt = 0; attempt < 5; attempt++) expect((await open({ code: "ZZZZ-ZZZZ" })).status).toBe(404);
  expect((await open({ code: "ZZZZ-ZZZZ" })).status).toBe(429);
});

test("a 2.x adapter sending a six-digit code is told what to run", async () => {
  const response = await poll(secret(), { code: "123456", harness: "pi", protocol: 1, sessionId: "x", sessionFile: "/tmp/x" });
  expect(response.status).toBe(410);
  expect((await response.json()).error).toBe("Slirc changed how agents connect. Run npx slirc-agent@latest app.example.test in a terminal, then type /slirc in your session.");
});

test("unknown harnesses and other major versions are refused before anything is stored", async () => {
  expect((await ask(secret(), { ...session, harness: "crush" })).status).toBe(400);
  const old = await ask(secret(), { ...session, version: "2.4.1" });
  expect(old.status).toBe(426);
  expect((await old.json()).error).toContain("npx slirc-agent@latest");
  expect(db.query("SELECT COUNT(*) AS n FROM agent_connect_requests").get()).toEqual({ n: 0 });
});

test("pairing IP throttle retains its exact ten-minute boundary", () => {
  const start = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) connect.recordFailure("window", start + i);
  expect(connect.isBlocked("window", start + 4 + 600_000 - 1)).toBe(true);
  expect(connect.isBlocked("window", start + 4 + 600_000)).toBe(false);
});

test("a ticket from the Agents page shows the Allow card to the person who copied it, for the first session only", async () => {
  connect.resetTicketsForTests();
  const { subscribe } = await import("../src/live.ts");
  const sameOrigin = { Origin: "https://app.example.test", "X-Slirc-Connect": "1" };
  const mint = (headers: Record<string, string> = { ...owner, ...sameOrigin }) => app.request("/api/agents/connect-ticket", { method: "POST", headers, body: "{}" });
  // Same origin, JSON and the custom header, like the other routes a page calls with its cookie.
  expect((await mint(owner)).status).toBe(403);
  expect((await mint({ ...owner, ...sameOrigin, Origin: "https://evil.example" })).status).toBe(403);
  expect((await mint({ ...owner, Origin: "https://app.example.test" })).status).toBe(403);
  expect((await mint({ "Content-Type": "application/json", ...sameOrigin })).status).toBe(401);
  const minted = await mint();
  expect(minted.status).toBe(200);
  const { ticket, expiresAt } = await minted.json();
  expect(ticket).toMatch(/^[A-Za-z0-9_-]{12}$/);
  expect(expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);

  const seen: { event: string; data: any }[] = [];
  const unsubscribe = subscribe("bitbonsai", (event, data) => { seen.push({ event, data }); });
  const cards = () => seen.filter((item) => item.event === "agent-connect-request");
  try {
    const first = secret();
    const asked = await (await ask(first, { ...session, ticket })).json();
    expect(asked.code).toMatch(/^.{4}-.{4}$/);
    expect(asked.connectCode).toBeUndefined();
    expect(cards()).toHaveLength(1);
    expect(cards()[0].data).toMatchObject({ harnessName: "Pi", sessionName: "fix login", code: asked.code });
    expect(cards()[0].data.sessionFile).toBeUndefined();

    // Held by the first session: another one presenting it (it read the ticket somewhere), a
    // made-up one and a wrong type only get link and code.
    // Each is told the connect code expired, so the session can say so.
    const held = await ask(secret(), { ...session, sessionId: "s2", ticket });
    expect(held.status).toBe(200);
    expect((await held.json()).connectCode).toBe("expired");
    const madeUp = await ask(secret(), { ...session, sessionId: "s3", ticket: "not-a-real-ticket" });
    expect(madeUp.status).toBe(200);
    expect((await madeUp.json())).toMatchObject({ connectCode: "expired", code: expect.stringMatching(/^.{4}-.{4}$/) });
    expect((await ask(secret(), { ...session, sessionId: "s4", ticket: 42 })).status).toBe(200);
    expect(cards()).toHaveLength(1);
    // The holder asking again is covered below: the route's per-address limit is nearly spent here.

    // Tied to that person: someone else signed in can't open or decide it, even with the code.
    const now = Date.now();
    db.query("INSERT INTO accounts (nick, email, kind, created_at, verified_at) VALUES ('mallory', 'm@example.com', 'human', ?, ?)").run(now, now);
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'mallory', ?)").run(createHash("sha256").update("mallory-session").digest("hex"), now);
    const mallory = { Cookie: "slirc_session=mallory-session", "Content-Type": "application/json" };
    expect((await open({ code: asked.code }, mallory)).status).toBe(404);
    expect((await app.request(`/api/agents/requests/${cards()[0].data.id}`, { method: "POST", headers: mallory, body: JSON.stringify({ allow: true }) })).status).toBe(404);
    expect((await decide(cards()[0].data.id, true)).status).toBe(200);
  } finally { unsubscribe(); }
});

test("a ticket lasts ten minutes and stays with the session that presented it first", () => {
  connect.resetTicketsForTests();
  expect(connect.TICKET_TTL_MS).toBe(10 * 60_000);
  // A first install: Claude Code asks to run the command, installs the plugin and waits for the
  // owner's /reload-plugins before the session asks. Minutes later the ticket still names them.
  const slow = connect.mintTicket("bitbonsai", 1_000);
  expect(connect.redeemTicket(slow.ticket, "a", 1_000 + 5 * 60_000)).toBe("bitbonsai");
  const { ticket } = connect.mintTicket("bitbonsai", 1_000);
  expect(connect.redeemTicket(ticket, "a", 1_000 + connect.TICKET_TTL_MS)).toBeNull();
  const fresh = connect.mintTicket("bitbonsai");
  expect(connect.redeemTicket(fresh.ticket, "a")).toBe("bitbonsai");
  expect(connect.redeemTicket(fresh.ticket, "b")).toBeNull();
  expect(connect.redeemTicket(fresh.ticket, "a")).toBe("bitbonsai");
});
