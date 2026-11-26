import "./fixture.ts";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";

// One list: the agent package's harness registry decides what the server accepts, what the Agents
// page, /welcome and /api/agent/version offer, and which harnesses the docs may name as working.
process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const { harnesses } = await import("../agent/src/harnesses/index.ts");

const owner = accountByNick("bitbonsai")!;
const token = "agent-harness-session";
db.query("INSERT OR IGNORE INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), owner.nick, Date.now());
const cookie = { Cookie: `slirc_session=${token}` };
const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const ask = (harness: string) => app.request("/api/agent/session/request", {
  method: "POST", headers: { Authorization: `Bearer ${secret()}`, "Content-Type": "application/json" },
  body: JSON.stringify({ protocol: 1, harness, sessionId: `s-${harness || "none"}`, sessionFile: "/tmp/f.jsonl" }),
});
const released = () => harnesses.filter((harness) => harness.released).map(({ id, name, terminalOnly }) => ({ id, name, ...(terminalOnly ? { terminal: true } : {}) }));
const pi = harnesses.find((harness) => harness.id === "pi")!;
const claudeCode = harnesses.find((harness) => harness.id === "claude")!;
const codex = harnesses.find((harness) => harness.id === "codex")!;
const opencode = harnesses.find((harness) => harness.id === "opencode")!;
afterEach(() => { pi.released = true; claudeCode.released = true; codex.released = true; opencode.released = true; });

test("capabilities, version and /welcome offer exactly the released harnesses", async () => {
  expect(released()).toEqual([{ id: "pi", name: "Pi" }, { id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex", terminal: true }, { id: "opencode", name: "OpenCode" }]);
  expect((await (await app.request("/api/agents/capabilities", { headers: cookie })).json()).harnesses).toEqual(released());
  expect((await (await app.request("/api/agent/version")).json()).harnesses).toEqual(released());
  expect(await (await app.request("/welcome")).text()).toContain("Pi, Claude Code, Codex and OpenCode work today.");
});

test("flipping released is all it takes to stop offering a harness; the connect route still takes it", async () => {
  pi.released = false;
  claudeCode.released = false;
  codex.released = false;
  opencode.released = false;
  const body = await (await app.request("/api/agents/capabilities", { headers: cookie })).json();
  expect(body.harnesses).toEqual([]);
  expect(body.commands.session).toEqual({});
  expect(await (await app.request("/welcome")).text()).not.toContain("<li data-agents>");
  expect((await ask("pi")).status).toBe(200);
});

test("harnesses outside the registry are refused before anything is stored", async () => {
  for (const harness of ["goose", "crush", "claude-desktop", "", "PI"]) expect((await ask(harness)).status).toBe(400);
  expect(db.query("SELECT COUNT(*) AS n FROM agent_connect_requests WHERE harness NOT IN ('pi', 'claude', 'codex', 'opencode')").get()).toEqual({ n: 0 });
});

test("an unreleased harness in the registry pairs on connect but isn't offered", async () => {
  codex.released = false;
  expect((await ask("codex")).status).toBe(200);
  expect((await (await app.request("/api/agent/version")).json()).harnesses.map((harness: { id: string }) => harness.id)).not.toContain("codex");
});

test("a 3.1.0 CLI's claude-code request is accepted and stored as claude", async () => {
  expect((await ask("claude-code")).status).toBe(200);
  expect(db.query("SELECT harness FROM agent_connect_requests ORDER BY rowid DESC LIMIT 1").get()).toEqual({ harness: "claude" });
});

test("an unreleased registered harness pairs on the connect route but is not offered", async () => {
  claudeCode.released = false;
  codex.released = false;
  expect((await ask("claude")).status).toBe(200);
  expect(released().map(({ id }) => id)).not.toContain("claude");
  expect(await (await app.request("/welcome")).text()).toContain("Pi and OpenCode work today.");
});

test("the agents guide and FAQ name as working only released harnesses", async () => {
  const docs = ["docs/agents.md", "docs/faq.md", "public/docs/llms.txt", "public/welcome.html"].map((path) => Bun.file(path).text());
  const text = (await Promise.all(docs)).join("\n");
  for (const name of ["Crush", ...harnesses.filter((harness) => !harness.released).map((harness) => harness.name)]) {
    // Unreleased harnesses may be named as coming, never as something to set up today.
    expect(text).not.toMatch(new RegExp(`${name} (works|is supported|: run)`));
  }
  for (const { name } of released()) expect(text).toContain(name);
  // No unpublished repo or package is pointed at.
  expect(text).not.toContain("bitbonsai/slirc-agents");
  expect(text).not.toContain("slirc-agent@latest install");
});
