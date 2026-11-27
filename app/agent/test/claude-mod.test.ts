import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Claude Code mod's consent capture: which prompt it hands the listener when an arm file shows
// up. Only a line the person submitted, taken by the main turn it started, counts, and only once.
const root = mkdtempSync(join(tmpdir(), "slirc-mod-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const RECEIPT = "Slirc delivery receipt: 0b1f2c3d-0000-4000-8000-000000000000";
let loads = 0;

async function mod(sessionId: string, out: object[] = []) {
  const { register } = await import(`../src/harnesses/claude/mod/hooks/register.ts?${++loads}`);
  const hooks = new Map<string, any>();
  register(((name: string, filter: any, handler?: any) => {
    const fn = handler ?? filter;
    const key = handler && filter?.tool ? `${name}:${filter.tool}` : handler && filter?.command ? `${name}:${filter.command}` : name;
    hooks.set(key, fn);
  }) as any);
  // What reached the listener: the arm in its spawn config, then each /arm call on its socket.
  const prompts: (string | undefined)[] = [];
  const configs: any[] = [];
  const calls: [string, any][] = [];
  // What the person saw, and what the model was handed.
  const ui: [string, unknown][] = [];
  const submitted: unknown[] = [];
  const state = join(root, sessionId);
  const $ = {
    session: { id: async () => sessionId, cwd: async () => root, model: async () => "", messages: async () => [] },
    env: { get: async (name: string) => (name === "XDG_STATE_HOME" ? state : undefined), set: async () => undefined },
    fs: { exists: async (path: string) => existsSync(path), read: async () => { throw new Error("none"); } },
    plugin: { root },
    clock: { now: async () => Date.now(), sleep: async () => undefined },
    ui: { toast: (text: string) => { ui.push(["toast", text]); }, status: (text?: string) => { ui.push(["status", text]); }, log: (text: string) => { ui.push(["log", text]); } },
    command: { register: async () => undefined, run: async () => undefined },
    prompt: { submit: async (input: unknown) => { submitted.push(input); } },
    tool: { register: async () => undefined },
    http: { fetch: async (url: string, init: any) => { calls.push([url, JSON.parse(init.body)]); prompts.push(JSON.parse(init.body).prompt); return { text: "{}" }; } },
    process: {
      spawn: ({ argv }: { argv: string[] }) => {
        prompts.push(JSON.parse(argv[2]).arm?.prompt);
        configs.push(JSON.parse(argv[2]));
        let sent = false;
        return { [Symbol.asyncIterator]: () => ({
          next: () => sent ? new Promise(() => {}) : (sent = true, Promise.resolve({ done: false, value: { stream: "stdout", text: [{ type: "ready", socket: "/tmp/x.sock", token: "t" }, ...out].map((line) => `${JSON.stringify(line)}\n`).join("") } })),
          return: async () => ({ done: true, value: undefined }),
        }) };
      },
    },
  };
  await hooks.get("session.start")($, { isInteractive: true }, async () => ({}));
  const arm = (name = `${sessionId}.json`) => { mkdirSync(join(state, "slirc-agent", "claude", "arm"), { recursive: true }); writeFileSync(join(state, "slirc-agent", "claude", "arm", name), "{}"); };
  const settle = () => new Promise((done) => setTimeout(done, 20));
  return {
    prompts,
    ui,
    submitted,
    submit: (text: string, extra: object = {}) => hooks.get("prompt.submit")($, { text, origin: { kind: "composer" }, ...extra }, async () => ({})),
    turn: (text: string, agentId?: string) => hooks.get("turn.start")($, { text, turnId: `t${Math.random()}`, ...(agentId ? { agentId } : {}) }, async () => ({})),
    bash: async () => { arm(); await hooks.get("tool.call:Bash")($, { agentId: undefined }, async () => ({})); await settle(); },
    configs,
    calls,
    // The CLI just updated the plugin: its arm waits for /reload-plugins.
    bashBeforeReload: async () => { arm(`${sessionId}.reload.json`); await hooks.get("tool.call:Bash")($, { agentId: undefined }, async () => ({})); await settle(); },
    reload: async () => { await hooks.get("session.start")($, { isInteractive: true }, async () => ({})); await settle(); },
  };
}

test("the person's submitted line, taken by the turn it started, is the consent, once", async () => {
  const session = await mod("cc-typed");
  await session.submit("bunx slirc-agent@latest calango --ticket k7f2q9xdpa3m");
  // The pasted command reaches a listener at once, before the model does anything with it.
  await new Promise((done) => setTimeout(done, 20));
  expect(session.configs).toMatchObject([{ prompted: "bunx slirc-agent@latest calango --ticket k7f2q9xdpa3m" }]);
  expect(session.configs[0].arm).toBeUndefined();
  await session.turn("bunx slirc-agent@latest calango --ticket k7f2q9xdpa3m");
  await session.bash();
  expect(session.prompts).toEqual([undefined, "bunx slirc-agent@latest calango --ticket k7f2q9xdpa3m"]);
  // The model runs it again in the same turn: the prompt was used.
  await session.bash();
  expect(session.prompts).toEqual([undefined, "bunx slirc-agent@latest calango --ticket k7f2q9xdpa3m", undefined]);
  // Lines that aren't the command start nothing.
  const other = await mod("cc-other");
  await other.submit("tidy the README");
  await other.submit("please run slirc-agent calango\nthen stop");
  await new Promise((done) => setTimeout(done, 20));
  expect(other.configs).toEqual([]);
});

test("a turn nobody typed for carries no prompt, even with the person's earlier text", async () => {
  // A background notice or a hook starts a turn: turn.start repeats the newest non-meta user text.
  const automatic = await mod("cc-automatic");
  await automatic.submit("slirc-agent calango");
  await automatic.turn("slirc-agent calango");
  await automatic.turn("slirc-agent calango");
  await automatic.bash();
  expect(automatic.prompts).toEqual([undefined]);

  // An empty turn doesn't keep the earlier prompt either.
  const empty = await mod("cc-empty");
  await empty.submit("slirc-agent calango");
  await empty.turn("");
  await empty.bash();
  expect(empty.prompts).toEqual([undefined]);

  // A Slirc delivery is submitted by the mod and carries a receipt.
  const delivered = await mod("cc-delivered");
  await delivered.submit("slirc-agent calango");
  await delivered.submit(`slirc-agent calango\n\n${RECEIPT}`);
  await delivered.turn(`slirc-agent calango\n\n${RECEIPT}`);
  await delivered.bash();
  expect(delivered.prompts).toEqual([undefined]);

  // Meta rows and slash commands aren't typed prompts; a subagent's turn doesn't take the prompt.
  const meta = await mod("cc-meta");
  await meta.submit("slirc-agent calango", { isMeta: true });
  await meta.turn("slirc-agent calango");
  await meta.bash();
  const sub = await mod("cc-sub");
  await sub.submit("slirc-agent calango");
  await sub.turn("slirc-agent calango", "agent-1");
  await sub.turn("other text");
  await sub.bash();
  // Another plugin's $.prompt.submit arrives with origin "plugin", even as the user.
  const plugin = await mod("cc-plugin");
  await plugin.submit("slirc-agent calango", { origin: { kind: "plugin", name: "other", asUser: true } });
  await plugin.turn("slirc-agent calango");
  await plugin.bash();
  expect([...meta.prompts, ...sub.prompts, ...plugin.prompts]).toEqual([undefined, undefined, undefined]);
});

test("an arm left for after /reload-plugins is handed over only when the plugin starts", async () => {
  const session = await mod("cc-reload");
  await session.submit("bunx slirc-agent@latest calango k7f2q9xdpa3m");
  await session.turn("bunx slirc-agent@latest calango k7f2q9xdpa3m");
  // The pasted line started a listener; the arm waiting for the reload isn't handed to it yet.
  await session.bashBeforeReload();
  expect(session.configs).toHaveLength(1);
  expect(session.calls.filter(([url]) => url.endsWith("/arm"))).toEqual([]);
  await session.reload();
  expect(session.calls.filter(([url]) => url.endsWith("/arm")).map(([, body]) => body)).toMatchObject([{ starting: true }]);
});

test("the link and code stay in the transcript as a display-only row until connected", async () => {
  const link = { type: "link", url: "https://core.slirc.app/agents#connect=abc", code: "RFYK-X321", expiresAt: Date.now() + 600_000 };
  const session = await mod("cc-link", [link, { type: "connected", text: "Connected to core." }]);
  await session.submit("bunx slirc-agent@latest core");
  await session.turn("bunx slirc-agent@latest core");
  await session.bash();
  expect(session.ui).toEqual([
    ["log", "Slirc code RFYK-X321: enter it on the Agents page in Slirc, or open https://core.slirc.app/agents#connect=abc"],
    ["status", "Enter RFYK-X321 on the Agents page in Slirc"],
    ["toast", "Enter RFYK-X321 on the Agents page in Slirc"],
    ["status", undefined],
    ["toast", "Connected to core."],
  ]);
  // Nothing of it reaches the model.
  expect(session.submitted).toEqual([]);
});

test("when the Agents page shows the request, the session says only to choose Allow", async () => {
  const link = { type: "link", url: "https://core.slirc.app/agents#connect=abc", code: "RFYK-X321", expiresAt: Date.now() + 600_000, onPage: true };
  const session = await mod("cc-onpage", [link]);
  await session.submit("bunx slirc-agent@latest core k7f2q9xdpa3m");
  await new Promise((done) => setTimeout(done, 20));
  const allow = "Choose Allow on your Agents page in Slirc. Code RFYK-X321.";
  expect(session.ui).toEqual([["log", allow], ["status", allow], ["toast", allow]]);
  expect(session.submitted).toEqual([]);
});
