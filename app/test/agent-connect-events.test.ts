import "./fixture.ts";
import { createHash, randomBytes } from "node:crypto";
import { expect, mock, test } from "bun:test";

// The Agents page learns about a session asking to connect over /api/events. A proxy or Bun's idle
// timeout drops a silent stream, and the browser reconnects: a request made in that gap must still
// reach the page, and a quiet stream must stay open.
process.chdir(new URL("..", import.meta.url).pathname);
const transport = await import("../src/agent-session-transport.ts");
mock.module("../src/agent-session-transport.ts", () => ({ ...transport, connectAgentTransport: async () => {} }));
const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const connect = await import("../src/agent-connect.ts");
const { eventsTiming } = await import("../src/routes/system.ts");

const token = "owner-events-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(createHash("sha256").update(token).digest("hex"), Date.now());
const owner = { Cookie: `slirc_session=${token}` };
const session = { harness: "pi", protocol: 1, version: connect.AGENT_VERSION, sessionId: "ev1", sessionFile: "/tmp/ev1.jsonl", sessionName: "", repo: "slirc", model: "m", machine: "MacBook" };

// Reads the stream until `done` says so, or gives up.
async function read(done: (text: string) => boolean, ms = 3_000): Promise<string> {
  const response = await app.request("/api/events", { headers: owner });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (!done(text) && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))]);
      if (!next || next.done) break;
      text += decoder.decode(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return text;
}

test("a page whose event stream opens after the session asked still gets the request", async () => {
  connect.resetTicketsForTests();
  const { ticket } = connect.mintTicket("bitbonsai");
  // The session asks while no stream is open (the page is reconnecting).
  const asked = await (await app.request("/api/agent/session/request", { method: "POST", headers: { Authorization: `Bearer ${randomBytes(32).toString("base64url")}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...session, ticket }) })).json();
  expect(asked.onPage).toBe(true);
  const text = await read((seen) => seen.includes("agent-connect-request"));
  expect(text).toContain("event: agent-connect-request");
  expect(text).toContain(`"code":"${asked.code}"`);
  expect(text).toContain('"machine":"MacBook"');
});

test("a quiet stream gets a keepalive line", async () => {
  const saved = eventsTiming.keepaliveMs;
  eventsTiming.keepaliveMs = 50;
  try {
    expect(await read((seen) => seen.includes(": keepalive"), 2_000)).toContain(": keepalive");
  } finally { eventsTiming.keepaliveMs = saved; }
});
