import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import slirc from "../src/harnesses/pi/extension.ts";

// Regression: after a failed pairing attempt, a second /slirc in the same saved Pi session must
// keep the original binding secret so a prior ambiguous attempt can still recover its binding.
test("a retry after a failed attempt keeps the binding secret and shows the link and code", async () => {
  const root = mkdtempSync(join(tmpdir(), "slirc-connect-retry-"));
  const config = join(root, "pi-config");
  const cwd = join(root, "work");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(config, { recursive: true }); mkdirSync(cwd, { recursive: true }); writeFileSync(sessionFile, "{}\n");

  const calls: { secret: string }[] = [];
  const asked: { secret: string; body: any }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/agent/session/request") {
        asked.push({ secret: request.headers.get("Authorization")?.slice(7) || "", body: await request.json() });
        return Response.json({ url: `http://${url.host}/agents#connect=${"t".repeat(43)}`, code: "K7QX-M2PD", expiresAt: Date.now() + 600_000 });
      }
      if (url.pathname === "/api/agent/session/connect") {
        calls.push({ secret: request.headers.get("Authorization")?.slice(7) || "" });
        if (calls.length === 1) return new Response("first attempt loses", { status: 500 });
        return Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: "b1", nick: "sa-retry", dm: "#dm-retry", status: "ready" });
      }
      if (url.pathname === "/api/agent/session/attach") return Response.json({ leaseId: "lease-1", expiresAt: Date.now() + 45_000, connected: true });
      if (url.pathname === "/api/agent/session/events") return new Response(new ReadableStream({ start(c) { c.close(); } }), { headers: { "content-type": "text/event-stream" } });
      if (url.pathname.endsWith("/heartbeat")) return Response.json({ expiresAt: Date.now() + 45_000 });
      return Response.json({ error: "missing" }, { status: 404 });
    },
  });

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = config;
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  slirc({
    registerCommand: (name, options) => commands.set(name, options),
    registerTool() {}, on() {},
    sendUserMessage() {},
  } as any);
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => "saved-retry", getSessionFile: () => sessionFile, getSessionName: () => "saved-retry" },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  try {
    { const command = commands.get("slirc"); await command.handler(`127.0.0.1:${server.port}`, ctx); await command.settled; }
    expect(calls).toHaveLength(1);
    expect(notifications).toContain(`Slirc: open http://127.0.0.1:${server.port}/agents#connect=${"t".repeat(43)} to connect this session, or enter K7QX-M2PD under Agents in Slirc.`);
    expect(notifications.some((n) => n.startsWith("Slirc: ") && /HTTP 500|first attempt/i.test(n))).toBe(true);
    { const command = commands.get("slirc"); await command.handler(`127.0.0.1:${server.port}`, ctx); await command.settled; }
    expect(calls).toHaveLength(2);
    expect(asked[0].body).toMatchObject({ harness: "pi", protocol: 1, sessionId: "saved-retry", sessionName: "saved-retry", repo: "work" });
    expect(notifications.at(-1)).toBe(`Connected to 127.0.0.1:${server.port} as sa-retry.`);
    // The second attempt reuses the original secret so a prior ambiguous attempt stays recoverable.
    expect(calls[1].secret).toBe(calls[0].secret);
    const stateDir = join(config, "slirc");
    const file = join(stateDir, readdirSync(stateDir)[0]);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.binding.nick).toBe("sa-retry");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
