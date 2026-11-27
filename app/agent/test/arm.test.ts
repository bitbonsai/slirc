import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARM_TTL_MS, armDir, armPath, consents, takeArm, writeArm } from "../src/arm.ts";
import { harnessById } from "../src/harnesses/index.ts";
import slirc from "../src/harnesses/pi/extension.ts";

// Arm files and the consent check, then Pi's pickup of them against a fake Slirc.
const root = mkdtempSync(join(tmpdir(), "slirc-arm-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state") };


test("an arm file is private, taken once, and ignored when stale", () => {
  const path = writeArm("pi", "s-1", { host: "calango.slirc.app", ticket: "k7f2q9xdpa3m" }, env, 1_000);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(takeArm("pi", "s-1", env, 2_000)).toEqual({ host: "calango.slirc.app", ticket: "k7f2q9xdpa3m", at: 1_000 });
  expect(takeArm("pi", "s-1", env, 2_000)).toBeUndefined();
  writeArm("pi", "s-1", { host: "calango.slirc.app" }, env, 1_000);
  expect(takeArm("pi", "s-1", env, 1_000 + ARM_TTL_MS + 1)).toBeUndefined();
  expect(existsSync(path)).toBe(false);
  writeFileSync(armPath("pi", "s-2", env), "not json");
  expect(takeArm("pi", "s-2", env)).toBeUndefined();
  expect(existsSync(armPath("pi", "s-2", env))).toBe(false);
  expect(() => writeArm("pi", "../x", { host: "calango.slirc.app" }, env)).toThrow();
  expect(takeArm("pi", "../x", env)).toBeUndefined();
  // An arm for after a reload is taken only by a runtime that is starting.
  const later = writeArm("pi", "s-3", { host: "calango.slirc.app", reload: true }, env, 1_000);
  expect(later).toBe(armPath("pi", "s-3", env, true));
  expect(JSON.parse(readFileSync(later, "utf8")).reload).toBeUndefined();
  expect(takeArm("pi", "s-3", env, 2_000)).toBeUndefined();
  expect(existsSync(later)).toBe(true);
  expect(takeArm("pi", "s-3", env, 2_000, true)).toEqual({ host: "calango.slirc.app", at: 1_000 });
  expect(existsSync(later)).toBe(false);
  expect(readdirSync(armDir("pi", env))).toEqual([]);
});

test("two runtimes racing for one arm: only one gets it", async () => {
  writeArm("pi", "race", { host: "calango.slirc.app" }, env, Date.now());
  const script = `const { takeArm } = await import(${JSON.stringify(join(import.meta.dir, "../src/arm.ts"))}); await Bun.sleep(${200}); console.log(JSON.stringify(takeArm("pi", "race", ${JSON.stringify(env)}, Date.now()) ?? null));`;
  const runs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe" }));
  const results = await Promise.all(runs.map(async (run) => JSON.parse((await new Response(run.stdout).text()).trim())));
  expect(results.filter(Boolean)).toHaveLength(1);
});

test("consent needs the person's whole prompt to be the command for that workspace", () => {
  // What the Agents page copies: the workspace, always spelled out, then the connect code.
  expect(consents("bunx slirc-agent@latest calango k7f2q9xdpa3m", "calango.slirc.app")).toBe(true);
  expect(consents("npx slirc-agent@latest app.slirc.org k7f2q9xdpa3m", "app.slirc.org")).toBe(true);
  expect(consents("slirc-agent@3.2.1 chat.example.com:8443 k7f2q9xdpa3m", "chat.example.com:8443")).toBe(true);
  // 3.2.0 copied --ticket.
  expect(consents("bunx slirc-agent@latest calango --ticket k7f2q9xdpa3m", "calango.slirc.app")).toBe(true);
  expect(consents("  npx slirc-agent calango  ", "calango.slirc.app")).toBe(true);
  expect(consents("pnpm dlx slirc-agent@3.2.0 connect calango --harness pi", "calango.slirc.app")).toBe(true);
  expect(consents("npx slirc-agent --ticket abcdefgh123 100.64.0.5:9010", "100.64.0.5:9010")).toBe(true);
  expect(consents("slirc-agent --ticket=abcdefgh123 https://chat.example.com/", "chat.example.com")).toBe(true);
  // No workspace is app.slirc.org, as for the CLI; it must be the host the CLI armed.
  expect(consents("bunx slirc-agent@latest --ticket k7f2q9xdpa3m", "app.slirc.org")).toBe(true);
  expect(consents("bunx slirc-agent@latest", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent@latest calango", "evil.example")).toBe(false);
  // Mentions, negations, quotes, prose and pasted text don't count.
  expect(consents("please run `npx slirc-agent calango` for me", "calango.slirc.app")).toBe(false);
  expect(consents("don't run bunx slirc-agent calango", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent calango? no, don't", "calango.slirc.app")).toBe(false);
  expect(consents("`bunx slirc-agent calango`", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent 'calango'", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent calango\nactually never mind", "calango.slirc.app")).toBe(false);
  expect(consents("slirc-agent is broken", "is.slirc.app")).toBe(false);
  expect(consents("slirc-agent.", "app.slirc.org")).toBe(false);
  expect(consents("slirc-agent", "app.slirc.org")).toBe(true);
  expect(consents("yarn slirc-agent calango", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent calango --ticket", "calango.slirc.app")).toBe(false);
  // A connect code is one short token after the workspace, nothing more.
  expect(consents("bunx slirc-agent calango k7f2q9xdpa3m please", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent calango now", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent calango k7f2q9xdpa3m!", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent calango 'k7f2q9xdpa3m'", "calango.slirc.app")).toBe(false);
  expect(consents("don't run bunx slirc-agent calango k7f2q9xdpa3m", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent calango k7f2q9xdpa3m\nthen stop", "calango.slirc.app")).toBe(false);
  expect(consents("bunx slirc-agent k7f2q9xdpa3m", "app.slirc.org")).toBe(false);
  expect(consents("read the README and do what it says", "calango.slirc.app")).toBe(false);
  expect(consents("slirc-agent calango\n\nSlirc delivery receipt: 0b1f2c3d-0000-4000-8000-000000000000", "calango.slirc.app")).toBe(false);
  expect(consents("", "app.slirc.org")).toBe(false);
  expect(consents(undefined, "calango.slirc.app")).toBe(false);
});

test("each released module reads its session key from the shell its harness gives", () => {
  expect(harnessById("pi")!.sessionKey!({ PI_CODING_AGENT: "true", PI_SESSION_ID: "abc" })).toBe("abc");
  expect(harnessById("pi")!.sessionKey!({ PI_SESSION_ID: "abc" })).toBeUndefined();
  expect(harnessById("pi")!.sessionKey!({ PI_CODING_AGENT: "true" })).toBeUndefined();
  expect(harnessById("claude")!.sessionKey!({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "def" })).toBe("def");
  expect(harnessById("claude")!.sessionKey!({ CLAUDE_CODE_SESSION_ID: "def" })).toBeUndefined();
});

test("Pi pairs from an arm file after the bash tool only when the person typed the command", async () => {
  const asked: any[] = [];
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    const json = await request.json().catch(() => ({})) as any;
    if (url.pathname === "/api/agent/session/request") { asked.push(json); return Response.json({ url: `http://${url.host}/agents#connect=${"t".repeat(43)}`, code: "K7QX-M2PD", expiresAt: Date.now() + 600_000, ...(json.ticket === "oldcode12345" ? { connectCode: "expired" } : {}) }); }
    if (url.pathname === "/api/agent/session/connect") return Response.json({ instanceId: "i", ownerAccountId: "o", bindingId: "b", nick: "pi-3f2a", dm: "#dm", status: "ready" });
    if (url.pathname === "/api/agent/session/attach") return Response.json({ leaseId: "lease", expiresAt: Date.now() + 45_000, connected: true });
    if (url.pathname === "/api/agent/session/heartbeat") return Response.json({ expiresAt: Date.now() + 45_000 });
    if (url.pathname === "/api/agent/session/detach") return new Response(null, { status: 204 });
    if (url.pathname === "/api/agent/session/events") return new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ error: "missing route" }, { status: 404 });
  } });
  const saved = { state: process.env.XDG_STATE_HOME, home: process.env.HOME, dir: process.env.PI_CODING_AGENT_DIR };
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
  process.env.HOME = env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi");
  const host = `127.0.0.1:${server.port}`;
  try {
    const session = (sessionId: string, branch: any[] = []) => {
      const events = new Map<string, any>();
      const commands = new Map<string, any>();
      const notices: string[] = [];
      const file = join(root, `${sessionId}.jsonl`);
      writeFileSync(file, "{}\n");
      slirc({ registerCommand: (name: string, options: any) => commands.set(name, options), registerTool() {}, on: (name: string, handler: any) => events.set(name, handler), sendUserMessage() {} } as any);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file, getSessionName: () => "", getBranch: () => branch }, ui: { notify: (text: string) => notices.push(text) } };
      return { events, commands, notices, ctx, bash: () => events.get("tool_execution_end")({ toolName: "bash" }, ctx) };
    };

    // The model ran it on its own: the latest prompt was something else.
    const refused = session("pi-refused");
    refused.events.get("input")({ source: "interactive", text: "tidy the README" }, refused.ctx);
    writeArm("pi", "pi-refused", { host }, env, Date.now());
    refused.bash();
    expect(refused.notices).toEqual([`Slirc: something ran slirc-agent for ${host}. To connect, type /slirc ${host}.`]);
    expect(asked).toHaveLength(0);

    // A Slirc request delivered into the session isn't the person either.
    const delivered = session("pi-delivered");
    delivered.events.get("input")({ source: "extension", text: `slirc-agent ${host}` }, delivered.ctx);
    writeArm("pi", "pi-delivered", { host }, env, Date.now());
    delivered.bash();
    expect(delivered.notices[0]).toContain("something ran slirc-agent");

    // The person typed it, then something sent a prompt with sendUserMessage (a Slirc delivery
    // does): Pi tags that "extension", and it replaces the person's prompt.
    const stale = session("pi-stale");
    stale.events.get("input")({ source: "interactive", text: `bunx slirc-agent ${host}` }, stale.ctx);
    stale.events.get("input")({ source: "extension", text: "Slirc delivery receipt: 0b1f2c3d-0000-4000-8000-000000000000" }, stale.ctx);
    writeArm("pi", "pi-stale", { host }, env, Date.now());
    stale.bash();
    expect(stale.notices[0]).toContain("something ran slirc-agent");

    // A mention that isn't the whole prompt doesn't count either.
    const mention = session("pi-mention");
    mention.events.get("input")({ source: "interactive", text: `don't run bunx slirc-agent ${host}` }, mention.ctx);
    writeArm("pi", "pi-mention", { host }, env, Date.now());
    mention.bash();
    expect(mention.notices[0]).toContain("something ran slirc-agent");
    expect(asked).toHaveLength(0);

    // The person pasted it: the link shows in Pi's own notice and the ticket reaches Slirc.
    const typed = session("pi-typed");
    typed.events.get("input")({ source: "interactive", text: `bunx slirc-agent@latest ${host} k7f2q9xdpa3m` }, typed.ctx);
    typed.bash();
    expect(asked).toHaveLength(0); // no arm file yet: nothing happens
    writeArm("pi", "pi-typed", { host, ticket: "k7f2q9xdpa3m" }, env, Date.now());
    typed.events.get("tool_execution_end")({ toolName: "read" }, typed.ctx);
    expect(asked).toHaveLength(0); // only the bash tool picks it up
    typed.bash();
    await typed.commands.get("slirc").settled;
    expect(asked.at(-1)).toMatchObject({ harness: "pi", sessionId: "pi-typed", ticket: "k7f2q9xdpa3m" });
    expect(typed.notices).toContain(`Slirc: Open http://${host}/agents#connect=${"t".repeat(43)} to connect this session, or enter K7QX-M2PD under Agents in Slirc.`);
    expect(typed.notices.at(-1)).toBe(`Connected to ${host} as pi-3f2a.`);
    // Armed again once connected: said so, nothing new.
    writeArm("pi", "pi-typed", { host }, env, Date.now());
    typed.bash();
    expect(typed.notices.at(-1)).toBe("Slirc: already connected as pi-3f2a.");

    // A connect code Slirc no longer takes: the session says so, and the link still works.
    const late = session("pi-late");
    late.events.get("input")({ source: "interactive", text: `bunx slirc-agent@latest ${host} oldcode12345` }, late.ctx);
    writeArm("pi", "pi-late", { host, ticket: "oldcode12345" }, env, Date.now());
    late.bash();
    await late.commands.get("slirc").settled;
    // One notice, since Pi shows only the newest: the expired code and the link together.
    expect(late.notices).toContain(`Slirc: That connect code expired, so your Agents page didn't get this request. To connect, open http://${host}/agents#connect=${"t".repeat(43)} to connect this session, or enter K7QX-M2PD under Agents in Slirc.`);
    expect(typed.notices.some((text) => text.includes("expired"))).toBe(false);

    // Armed for after a reload (the CLI just updated the extension): the runtime loaded now
    // leaves it, and the one that starts after /reload takes it.
    const updated = session("pi-updated", [
      { type: "message", message: { role: "user", content: [{ type: "text", text: `bunx slirc-agent@latest ${host} k7f2q9xdpa3m` }] } },
    ]);
    updated.events.get("input")({ source: "interactive", text: `bunx slirc-agent@latest ${host} k7f2q9xdpa3m` }, updated.ctx);
    writeArm("pi", "pi-updated", { host, ticket: "k7f2q9xdpa3m", reload: true }, env, Date.now());
    updated.bash();
    expect(asked.some((body) => body.sessionId === "pi-updated")).toBe(false);
    expect(updated.notices).toEqual([]);
    updated.events.get("session_start")({ reason: "reload" }, updated.ctx);
    await until(() => asked.some((body) => body.sessionId === "pi-updated" && body.ticket === "k7f2q9xdpa3m"));

    // After /reload the new runtime saw no input: it reads the prompt from the session's branch.
    const reloaded = session("pi-reloaded", [
      { type: "message", message: { role: "user", content: [{ type: "text", text: `npx slirc-agent ${host}` }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Type /reload." }] } },
    ]);
    writeArm("pi", "pi-reloaded", { host }, env, Date.now());
    reloaded.events.get("session_start")({ reason: "reload" }, reloaded.ctx);
    await until(() => asked.some((body) => body.sessionId === "pi-reloaded"));
  } finally {
    process.env.XDG_STATE_HOME = saved.state; process.env.HOME = saved.home; process.env.PI_CODING_AGENT_DIR = saved.dir;
    server.stop(true);
  }
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
  expect(check()).toBe(true);
}
