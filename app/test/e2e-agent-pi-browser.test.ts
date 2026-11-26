import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Opt-in: this uses a live dev app and Ergo, a private browser, and a real Pi runtime.
// Only the model is replaced. Creates labelled @example.test fixtures; never resets server data.
const run = process.env.SLIRC_PI_BROWSER_E2E === "true" ? test : test.skip;
const origin = process.env.SLIRC_E2E_ORIGIN || "https://dev.example.test:8443";
const host = new URL(origin).host;

run("browser pairs Pi, exchanges DMs, queues busy work, and resumes the same DM without offline replay", async () => {
  const piBin = Bun.which("pi");
  expect(piBin, "Install Pi before running the browser end-to-end check").toBeTruthy();
  const root = mkdtempSync("/tmp/slirc-pi-browser-e2e-");
  const marker = `pi-e2e-${crypto.randomUUID().slice(0, 8)}`;
  const name = `Pi E2E ${marker}`;
  const agentDir = join(root, "agent");
  const sessions = join(root, "sessions");
  mkdirSync(agentDir);
  mkdirSync(sessions);
  const extension = resolve(import.meta.dir, "../agent/dist/pi-extension.js");
  const calls: { requestId?: string; text: string }[] = [];
  let releaseLocal: (() => void) | undefined;
  let releaseRemote: (() => void) | undefined;
  const textOf = (message: any): string => typeof message?.content === "string" ? message.content : (message?.content || []).map((part: any) => part.text || "").join("");
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
    const body = await request.json() as any;
    const last = body.messages.at(-1);
    const text = textOf(last);
    const requestId = last.role !== "tool" ? text.match(/Slirc request ([0-9a-f-]{36})/)?.[1] : undefined;
    const base = { id: "e2e", object: "chat.completion.chunk", created: 1, model: body.model };
    let frames: any[];
    if (requestId) {
      calls.push({ requestId, text });
      const reply = text.split("Request:\n")[1]?.split("\n")[0];
      if (reply === `${marker}-busy`) await new Promise<void>((resolve) => { releaseRemote = resolve; });
      frames = [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requestId.slice(0, 8)}`, type: "function", function: { name: "slirc_reply", arguments: JSON.stringify({ requestId, text: `E2E reply: ${reply}` }) } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
    } else {
      if (last.role !== "tool") {
        calls.push({ text });
        if (text === `${marker}-hold-local`) await new Promise<void>((resolve) => { releaseLocal = resolve; });
      }
      frames = [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `${marker}-local-only` }, finish_reason: "stop" }] }];
    }
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "local-fixture", models: [{ id: "pi-e2e" }] } } }));

  async function until<T>(check: () => T | Promise<T>, label: string, timeout = 30_000): Promise<NonNullable<T>> {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await check(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
    throw new Error(`Timed out: ${label}`);
  }
  const browserName = marker;
  async function browser(...args: string[]): Promise<any> {
    const executable = Bun.which("chromium");
    const proc = Bun.spawn(["bunx", "agent-browser", "--session", browserName, "--json", ...(executable ? ["--executable-path", executable] : []), ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    let result: any;
    try { result = JSON.parse(out); } catch { throw new Error(`Browser ${args[0]} did not return JSON (exit ${code})`); }
    if (code || !result.success) throw new Error(`Browser ${args[0]} failed: ${String(result.error).replace(/token=[^&\s"]+/g, "token=[redacted]")}`);
    return result.data;
  }
  const evaluate = async (js: string) => (await browser("eval", js)).result;
  const waitBrowser = (js: string) => browser("wait", "--fn", js);
  const messagesJs = "[...document.querySelectorAll('[data-message-id]')].filter(el => el.getClientRects().length).map(el => el.innerText)";
  const hasReply = (text: string) => `[...document.querySelectorAll('[data-message-id]')].some(el => el.getClientRects().length && el.querySelector('.message-copy')?.innerText === ${JSON.stringify(`E2E reply: ${text}`)})`;
  const visibleMessages = () => evaluate(messagesJs) as Promise<string[]>;
  const statusJs = (text: string) => `[...document.querySelectorAll('[data-message-id]')].filter(el => el.getClientRects().length && el.querySelector('.message-copy')?.innerText === ${JSON.stringify(text)}).map(el => [...el.querySelectorAll('.agent-request-status')].filter(status => status.getClientRects().length).map(status => status.innerText)).flat()`;
  async function waitStatus(text: string, status: string) {
    try { await waitBrowser(`JSON.stringify(${statusJs(text)}) === ${JSON.stringify(JSON.stringify(status ? [status] : []))}`); }
    catch (error) {
      const diagnostic = await evaluate(`[...document.querySelectorAll('[data-message-id]')].filter(el => el.getClientRects().length).map(el => ({ text: el.querySelector('.message-copy')?.innerText, status: el.querySelector('.agent-request-status')?.outerHTML }))`);
      writeFileSync(join(root, "status-diagnostic.json"), JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
      throw new Error(`Expected ${status || 'no status'} beside ${text}; private diagnostic: ${root}/status-diagnostic.json`, { cause: error });
    }
  }
  async function send(nick: string, text: string) {
    await browser("find", "role", "textbox", "fill", text, "--name", `Message ${nick}`);
    await browser("find", "role", "button", "click", "--name", "Send message");
  }

  type Pi = { proc: ReturnType<typeof Bun.spawn>; events: any[] };
  const runtimes: Pi[] = [];
  function startPi(session?: string): Pi {
    const proc = Bun.spawn([piBin!, "--mode", "rpc", "--provider", "fixture", "--model", "pi-e2e", "--name", name, "--session-dir", sessions, "--no-extensions", "-e", extension, "--no-builtin-tools", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", ...(session ? ["--session", session] : [])], {
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOSTNAME: "slirc-e2e" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const pi = { proc, events: [] as any[] };
    runtimes.push(pi);
    void new Response(proc.stderr).text();
    void (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { const event = JSON.parse(line); if (event.type !== "message_update") pi.events.push(event); } catch {}
        }
      }
    })();
    return pi;
  }
  let sequence = 0;
  async function rpc(pi: Pi, command: any): Promise<any> {
    const id = `e2e-${++sequence}`;
    (pi.proc.stdin as any).write(`${JSON.stringify({ ...command, id })}\n`);
    (pi.proc.stdin as any).flush();
    const response = await until(() => pi.events.find((event) => event.type === "response" && event.id === id), command.type);
    expect(response.success, response.error).toBe(true);
    return response.data;
  }
  async function prompt(pi: Pi, message: string) {
    const before = pi.events.length;
    const response = await rpc(pi, { type: "prompt", message });
    if (response?.disposition !== "handled") await until(() => pi.events.slice(before).some((event) => event.type === "agent_settled"), "Pi settled");
  }
  async function stopPi(pi: Pi) {
    if (pi.proc.exitCode !== null) return;
    (pi.proc.stdin as any).end();
    const exited = await Promise.race([pi.proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!exited) { pi.proc.kill(); await pi.proc.exited; }
  }

  try {
    await browser("open", origin);
    // Auth setup is local-only: this endpoint returns a link only in the isolated dev profile.
    // Redeem inside the browser so neither the token nor cookie appears in CLI output.
    expect(await evaluate(`(async () => {
      const response = await fetch('/auth/request', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email:${JSON.stringify(`${marker}@example.test`)}}) });
      const data = await response.json();
      if (!data.devLink) throw new Error('This is not the isolated dev sign-in flow');
      const link = new URL(data.devLink, location.origin);
      if (link.origin !== location.origin || link.pathname !== '/auth/verify') throw new Error('Unexpected sign-in destination');
      await fetch(link.href);
      const me = await (await fetch('/auth/me')).json();
      return me.authenticated && me.email === ${JSON.stringify(`${marker}@example.test`)};
    })()`)).toBe(true);
    await browser("open", `${origin}/agents`);
    await browser("wait", "--text", "First time on this computer");
    // The session line names this workspace, so /slirc <workspace> pairs with no other input.
    const command = await evaluate("[...document.querySelectorAll('code')].find(el => el.getClientRects().length && el.innerText.startsWith('/slirc')).innerText");
    expect(command).toBe(`/slirc ${host}`);

    let pi = startPi();
    await prompt(pi, `${marker}-local-setup`); // A saved session exists before pairing.
    const saved = await rpc(pi, { type: "get_state" });
    await rpc(pi, { type: "prompt", message: command });
    // Pi shows the link; the owner opens it and allows the session on the card.
    const link = await until(() => pi.events.find((event) => event.type === "extension_ui_request" && /#connect=/.test(event.message || "")), "Pi link");
    const url = link.message.match(/open (\S+) to connect/)![1];
    await browser("open", url);
    await browser("wait", "--text", "Connect this coding session?");
    await browser("find", "role", "button", "click", "--name", "Allow");
    const paired = await until(() => pi.events.find((event) => event.type === "extension_ui_request" && /^Connected to \S+ as pi-[0-9a-f]{4}\./.test(event.message || "")), "Pi paired");
    const nick = paired.message.match(/ as (pi-[0-9a-f]{4})\./)![1];
    await browser("open", `${origin}/dm/${nick}`);
    await waitBrowser(`Boolean(document.querySelector('[role="textbox"][aria-label=${JSON.stringify(`Message ${nick}`)}]'))`);
    const headerJs = `(() => {
      const title = document.querySelector('#room-title .room-title-text > span:first-child');
      const subtitle = document.querySelector('#room-title .room-subtitle');
      const avatar = document.querySelector('#room-title .peer-avatar');
      return { title: title?.innerText, subtitle: subtitle?.innerText, visible: !!title?.getClientRects().length && !!subtitle?.getClientRects().length,
        topAligned: !!title && !!avatar && Math.abs(title.getBoundingClientRect().top - avatar.getBoundingClientRect().top) < 1 };
    })()`;
    await waitBrowser(`(${headerJs}).title === ${JSON.stringify(name)} && (${headerJs}).subtitle === ${JSON.stringify(`Pi · ${nick}`)} && (${headerJs}).visible`);
    expect(await evaluate(headerJs)).toEqual({ title: name, subtitle: `Pi · ${nick}`, visible: true, topAligned: true });
    await browser("screenshot", join(root, "agent-header.png"));
    const first = `${marker}-first`;
    await send(nick, first);
    await waitBrowser(hasReply(first));
    expect(calls.filter((call) => call.requestId && call.text.includes(`Request:\n${first}`))).toHaveLength(1);
    await prompt(pi, `${marker}-local-after-pair`);
    expect((await visibleMessages()).some((text) => text.includes(`${marker}-local-only`))).toBe(false);

    await rpc(pi, { type: "prompt", message: `${marker}-hold-local` });
    await until(() => releaseLocal, "controlled busy turn");
    const eventsBefore = pi.events.length;
    const busy = `${marker}-busy`;
    await send(nick, busy);
    await until(() => pi.events.slice(eventsBefore).some((event) => event.type === "queue_update" && JSON.stringify(event.followUp).includes(busy)), "DM in native follow-up queue");
    expect(calls.some((call) => call.requestId && call.text.includes(`Request:\n${busy}`))).toBe(false);
    expect(await evaluate(hasReply(busy))).toBe(false);
    await waitStatus(busy, "Queued");
    expect(await evaluate(statusJs(busy))).toEqual(["Queued"]);
    releaseLocal!(); releaseLocal = undefined;
    await until(() => releaseRemote, "controlled remote turn");
    await waitStatus(busy, "Working");
    expect(await evaluate(statusJs(busy))).toEqual(["Working"]);
    // Reopening the DM restores current state, not a stale browser-only busy flag.
    await browser("open", `${origin}/dm/${nick}`);
    await waitStatus(busy, "Working");
    expect(await evaluate(statusJs(busy))).toEqual(["Working"]);
    const sibling = `${marker}-sibling`;
    await send(nick, sibling);
    await waitStatus(sibling, "Queued");
    expect(await evaluate(statusJs(busy))).toEqual(["Working"]);
    expect(await evaluate(statusJs(sibling))).toEqual(["Queued"]);
    releaseRemote!(); releaseRemote = undefined;
    await waitBrowser(hasReply(busy));
    await waitStatus(busy, "");
    expect(await evaluate(statusJs(busy))).toEqual([]);
    await waitBrowser(hasReply(sibling));
    await waitStatus(sibling, "");
    expect(await evaluate(statusJs(sibling))).toEqual([]);
    expect(calls.filter((call) => call.requestId && call.text.includes(`Request:\n${busy}`))).toHaveLength(1);
    await until(async () => !(await rpc(pi, { type: "get_state" })).isStreaming, "Pi idle after queued reply");

    await stopPi(pi);
    const agentsJs = "(async () => await (await fetch('/api/agents')).json())()";
    await until(async () => (await evaluate(agentsJs)).some((agent: any) => agent.nick === nick && agent.status === "offline"), "agent detached");
    const offline = `${marker}-offline`;
    await send(nick, offline);
    await waitBrowser(`(${messagesJs}).some(text => text.includes('is waiting for your confirmation') && text.includes(${JSON.stringify(offline)}))`);
    expect(await evaluate(statusJs(offline))).toEqual([]);
    pi = startPi(saved.sessionFile);
    await until(() => pi.events.some((event) => event.type === "extension_ui_request" && event.message === "Slirc connected."), "same session reconnected");
    const agents = await evaluate(agentsJs);
    expect(agents).toHaveLength(1);
    expect(agents[0].nick).toBe(nick);
    expect(agents[0].sessionId).toBe(saved.sessionId);
    expect(await evaluate("location.pathname")).toBe(`/dm/${nick}`);
    expect(calls.some((call) => call.requestId && call.text.includes(`Request:\n${offline}`))).toBe(false);
    const review = (await visibleMessages()).find((text) => text.includes("is waiting for your confirmation") && text.includes(offline))!;
    const requestId = review.match(/Slirc request ([0-9a-f-]{36})/)![1];
    await send(nick, `confirm ${requestId} 1`);
    await waitBrowser(hasReply(offline));
    expect(calls.filter((call) => call.requestId === requestId)).toHaveLength(1);
    expect((await visibleMessages()).filter((text) => text.endsWith(`\nE2E reply: ${offline}`))).toHaveLength(1);
    expect((await visibleMessages()).filter((text) => text.includes("Connected to your Pi session"))).toHaveLength(1);
    console.log(`Browser/Pi E2E passed; retained local fixture ${marker}, private runtime files ${root}`);
  } finally {
    releaseLocal?.();
    releaseRemote?.();
    for (const pi of runtimes) await stopPi(pi);
    await browser("close").catch(() => {});
    model.stop(true);
  }
}, 120_000);

test.todo("expose interruption only after a native abort-and-resume path is verified");
