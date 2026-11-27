// Agents page behavior: capability gating, the copied command with its ticket and the runner switch, the Allow
// card from a link or code, copy guards, stale account responses and the honest attachment mapping. No DOM is mounted.
import { afterEach, expect, test } from "bun:test";
import { agentStatus, normalizeExpiry, parseCapability, parseCard, createAgentsPage, stashConnectToken } from "@client/agents-page.ts";

const identity = <T extends object>(value: T): T => value;
const originalFetch = globalThis.fetch;

// A minimal localStorage, as the browser gives the page.
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, String(value)); }, removeItem: (key: string) => { store.delete(key); } };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as unknown as Response;
}

function sessionFor(overrides: { account?: string } = {}) {
  let key = "acct-1";
  return {
    scope: () => ({ instance: "https://slirc.test", accountId: "id-1", account: overrides.account ?? "alice" }),
    key: () => key,
    stopped: () => false,
    signingOut: () => false,
    switchKey: (next: string) => { key = next; },
  };
}

function page(session = sessionFor(), openDm: (nick: string) => void = () => {}) {
  return createAgentsPage(identity, { core: { authenticated: true, account: "alice" }, session, openDm });
}

function clipboard(write: (text: string) => Promise<void>): void {
  Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: write }, configurable: true });
}

test("attachment is never Ready without an explicit ready status", () => {
  expect(agentStatus({ status: "ready", lastSeen: null })).toEqual({ key: "ready", label: "Ready" });
  expect(agentStatus({ status: "working", lastSeen: 1 })).toEqual({ key: "working", label: "Working" });
  expect(agentStatus({ status: "needs-input", lastSeen: 1 })).toEqual({ key: "input", label: "Needs input" });
  // Generic/legacy states are not Ready: an IRC lastSeen is never readiness proof.
  expect(agentStatus({ status: "connected", lastSeen: 1 }).key).toBe("offline");
  expect(agentStatus({ lastSeen: 1_700_000_000_000 }).key).toBe("offline");
  expect(agentStatus({ lastSeen: null }).key).toBe("unverified");
  expect(agentStatus({ status: "something-else", lastSeen: null }).key).toBe("unverified");
  expect(agentStatus({ status: "busy", lastSeen: null }).key).toBe("unverified");
});

test("a failed capability check surfaces a retry instead of a silent disabled page", async () => {
  let capabilityOk = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return capabilityOk ? json({ enabled: true, supportedHarnesses: ["pi"] }) : json({}, false, 404);
    if (url === "/api/agents") return json([]);
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const agents = page();
  await agents.load();
  // The list still loaded, but the page must not pretend capability was checked.
  expect(agents.loaded).toBe(true);
  expect(agents.capability).toBeNull();
  expect(agents.capabilityError).toContain("Could not check");

  capabilityOk = true;
  await agents.load();
  expect(agents.capabilityError).toBe("");
  expect(agents.capability?.enabled).toBe(true);
});

test("a response that lands after an account switch is dropped", async () => {
  const session = sessionFor();
  let releaseCapability: (() => void) | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return await new Promise<Response>((resolve) => { releaseCapability = () => resolve(json({ enabled: true, supportedHarnesses: ["pi"] })); });
    if (url === "/api/agents") return json([{ nick: "pi-bot", machine: "laptop", lastSeen: 1, status: "ready" }]);
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const agents = page(session);
  const loading = agents.load();
  session.switchKey("acct-2");
  releaseCapability?.();
  await loading;

  expect(agents.capability).toBeNull();
  expect(agents.loaded).toBe(false);
  expect(agents.rows).toHaveLength(0);
});

test("removing an agent calls the owner endpoint and drops the row", async () => {
  let deleted = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return json({ enabled: true, supportedHarnesses: [] });
    if (url === "/api/agents") return json([{ nick: "pi-bot", machine: "laptop", lastSeen: 1, status: "ready" }]);
    if (init?.method === "DELETE") { deleted = url; return json(null, true, 204); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const agents = page();
  await agents.load();
  expect(agents.rows).toHaveLength(1);
  agents.askRemove(agents.rows[0]!, null as unknown as HTMLElement);
  await agents.confirmRemove();
  expect(deleted).toBe("/api/agents/pi-bot");
  expect(agents.rows).toHaveLength(0);
  expect(agents.removeTarget).toBeNull();
});

test("renaming an agent posts the trimmed name to the owner endpoint and patches the row", async () => {
  let posted: { url: string; body: unknown } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return json({ enabled: true, supportedHarnesses: ["pi"] });
    if (url === "/api/agents") return json([{ nick: "pi-a143", machine: "laptop", lastSeen: 1, status: "ready", agent: { harness: "pi", name: "old", repo: "slirc", model: "gpt-5.6-sol" } }]);
    if (init?.method === "POST") {
      posted = { url, body: JSON.parse(String(init.body)) };
      return json({ agent: { harness: "pi", name: "deploy fixes", repo: "slirc", model: "gpt-5.6-sol", provider: "openai-codex" } });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const agents = page();
  await agents.load();
  agents.askRename(agents.rows[0]!, null as unknown as HTMLElement);
  expect(agents.renameValue).toBe("old");
  agents.renameValue = "  deploy fixes  ";
  await agents.confirmRename();
  expect(posted).toEqual({ url: "/api/agents/pi-a143/name", body: { name: "deploy fixes" } });
  expect(agents.agentTitle(agents.rows[0]!)).toBe("deploy fixes");
  expect(agents.renameTarget).toBeNull();
});

test("Read my DMs saves the moment it is toggled and goes back when the server refuses", async () => {
  const posts: { url: string; body: unknown; header: string | null }[] = [];
  let refuse = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return json({ enabled: true, supportedHarnesses: ["pi"] });
    if (url === "/api/agents") return json([{ nick: "pi-a143", machine: "laptop", lastSeen: 1, status: "ready", harness: "pi", readDms: false }]);
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)), header: new Headers(init.headers).get("X-Slirc-Agent") });
      return refuse ? json({ error: "agent not found" }, false, 404) : json({ readDms: (JSON.parse(String(init.body)) as { enabled: boolean }).enabled });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

  const agents = page();
  await agents.load();
  expect(agents.rows[0]!.readDms).toBe(false);
  await agents.toggleReadDms(agents.rows[0]!);
  expect(posts).toEqual([{ url: "/api/agents/pi-a143/read-dms", body: { enabled: true }, header: "1" }]);
  expect(agents.rows[0]!.readDms).toBe(true);
  refuse = true;
  await agents.toggleReadDms(agents.rows[0]!);
  expect(posts.at(-1)!.body).toEqual({ enabled: false });
  expect(agents.rows[0]!.readDms).toBe(true);
  expect(agents.error).toBe("agent not found");
});

const capability = {
  enabled: true, reason: "", harnesses: [{ id: "pi", name: "Pi" }, { id: "", name: "nameless" }],
  commands: { workspace: "calango", npx: "npx slirc-agent@latest calango", bunx: "bunx slirc-agent@latest calango", session: { pi: "/slirc calango", other: "/x" } },
};

test("capability and card parsing keep only what the server named, and fail closed", () => {
  expect(parseCapability({})).toEqual({ enabled: false, reason: "", harnesses: [], commands: { workspace: "", npx: "", bunx: "", session: {} } });
  expect(parseCapability(capability)).toEqual({ enabled: true, reason: "", harnesses: [{ id: "pi", name: "Pi" }, { id: "", name: "nameless" }],
    commands: { workspace: "calango", npx: "npx slirc-agent@latest calango", bunx: "bunx slirc-agent@latest calango", session: { pi: "/slirc calango" } } });
  expect(parseCard({ id: "r1", harnessName: "Pi", code: "K7QX-M2PD", expiresAt: 5 })).toMatchObject({ id: "r1", harnessName: "Pi", code: "K7QX-M2PD" });
  expect(parseCard({ id: "r1" })).toBeNull();
  expect(normalizeExpiry(-1)).toBeNull();
});

test("each copy mints a fresh connect code, copies the command with it and waits; the runner choice is remembered", async () => {
  localStorage.removeItem("slirc.agentRunner");
  let minted = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return json(capability);
    if (url === "/api/agents") return json([]);
    if (url === "/api/agents/connect-ticket" && init?.method === "POST") {
      // The server's same-origin check wants JSON and its custom header.
      expect(new Headers(init.headers).get("X-Slirc-Connect")).toBe("1");
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
      minted++;
      return json({ ticket: ["k7f2q9xdpa3m", "n3w2q9xdpa3m"][minted - 1], expiresAt: Date.now() + 120_000 });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const written: string[] = [];
  clipboard(async (text) => { written.push(text); });
  const agents = page();
  await agents.load();
  expect(agents.runner).toBe("bunx");
  // Before copy the box shows the plain command; what was copied shows after.
  expect(agents.firstLine()).toBe("bunx slirc-agent@latest calango");
  expect(agents.waiting).toBe(false);
  await agents.copy();
  expect(agents.copied).toBe("first");
  expect(agents.waiting).toBe(true);
  expect(agents.firstLine()).toBe("bunx slirc-agent@latest calango k7f2q9xdpa3m");
  agents.toggleRunner();
  expect(agents.firstLine()).toBe("npx slirc-agent@latest calango k7f2q9xdpa3m");
  // Copied again: a new code, never the earlier one, which a restart may have dropped or another
  // session may already hold.
  await agents.copy();
  expect(minted).toBe(2);
  expect(written).toEqual(["bunx slirc-agent@latest calango k7f2q9xdpa3m", "npx slirc-agent@latest calango n3w2q9xdpa3m"]);
  expect(page().runner).toBe("npx");
  // The session's request arrives on the event stream: the card replaces the waiting row and the
  // ticket is spent, so the next copy mints a fresh one.
  agents.showRequest({ id: "r1", harnessName: "Pi", sessionName: "", repo: "slirc", machine: "devbox", code: "K7QX-M2PD", expiresAt: Date.now() + 600_000 });
  expect(agents.card?.id).toBe("r1");
  expect(agents.waiting).toBe(false);
  expect(agents.firstLine()).toBe("npx slirc-agent@latest calango");
  agents.showRequest({ nonsense: true });
  expect(agents.card?.id).toBe("r1");
  agents.reset();
  localStorage.removeItem("slirc.agentRunner");
});

test("without a ticket the command still copies, and nothing waits", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return json(capability);
    if (url === "/api/agents") return json([]);
    if (url === "/api/agents/connect-ticket") return json({ error: "Too many tries." }, false, 429);
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const written: string[] = [];
  clipboard(async (text) => { written.push(text); });
  const agents = page();
  await agents.load();
  await agents.copy();
  expect(written).toEqual(["bunx slirc-agent@latest calango"]);
  expect(agents.waiting).toBe(false);
  expect(agents.harnessJoin(0)).toBe("");
});

test("a link's token survives sign-in, opens the Allow card once, and Allow lists the agent", async () => {
  const token = "a".repeat(43);
  expect(stashConnectToken({ hash: `#connect=${token}`, pathname: "/agents", search: "" })).toBe(true);
  const calls: { url: string; body: unknown }[] = [];
  let rows: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/api/agents/capabilities")) return json(capability);
    if (url === "/api/agents") return json(rows);
    if (url === "/api/agents/requests/open") return json({ id: "r1", harnessName: "Pi", sessionName: "fix login", repo: "slirc", machine: "MacBook", code: "K7QX-M2PD", expiresAt: Date.now() + 600_000 });
    if (url === "/api/agents/requests/r1") { rows = [{ nick: "pi-3f2a", machine: "MacBook", lastSeen: null, status: "ready" }]; return json({ nick: "pi-3f2a" }); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const agents = page();
  await agents.load();
  await Bun.sleep(0);
  expect(calls.find((call) => call.url === "/api/agents/requests/open")?.body).toEqual({ token });
  expect(agents.card?.code).toBe("K7QX-M2PD");
  expect(agents.cardTitle(agents.card!)).toBe("Pi wants to connect");
  expect(agents.cardSubtitle(agents.card!)).toBe("slirc · MacBook");
  // The token is spent: a reload does not reopen it.
  expect(stashConnectToken({ hash: "", pathname: "/agents", search: "" })).toBe(false);
  await agents.decide(true);
  expect(agents.card).toBeNull();
  expect(agents.connected).toBe("pi-3f2a");
  expect(agents.rows.map((row) => row.nick)).toEqual(["pi-3f2a"]);
});

test("a typed code opens the card; an empty one asks for the code; a bad one shows the server's words", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return json(capability);
    if (url === "/api/agents") return json([]);
    if (url === "/api/agents/requests/open") {
      const body = JSON.parse(String(init?.body));
      return body.code === "K7QX-M2PD" ? json({ id: "r2", harnessName: "Pi", code: "K7QX-M2PD", expiresAt: Date.now() + 1_000 }) : json({ error: "No session is waiting with that code." }, false, 404);
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const agents = page();
  await agents.load();
  agents.submitCode();
  expect(agents.cardError).toBe("Enter the 8-character code your terminal shows.");
  agents.codeInput = "ZZZZ-ZZZZ";
  agents.submitCode();
  await Bun.sleep(0); await Bun.sleep(0);
  expect(agents.cardError).toBe("No session is waiting with that code.");
  agents.codeInput = "K7QX-M2PD";
  agents.submitCode();
  await Bun.sleep(0); await Bun.sleep(0);
  expect(agents.card?.id).toBe("r2");
  expect(agents.codeInput).toBe("");
});

test("the Works with line names every offered harness, joined the way people write lists", async () => {
  for (const [harnesses, line] of [
    [[{ id: "pi", name: "Pi" }], "Pi"],
    [[{ id: "pi", name: "Pi" }, { id: "claude", name: "Claude Code" }], "Pi and Claude Code"],
    [[{ id: "pi", name: "Pi" }, { id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }], "Pi, Claude Code and Codex"],
  ] as const) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/agents/capabilities")) return json({ ...capability, harnesses });
      if (url === "/api/agents") return json([]);
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const agents = page();
    await agents.load();
    expect(agents.harnessList()).toBe(line);
  }
});

test("Codex is named apart from the harnesses the command is pasted into", async () => {
  const harnesses = [{ id: "pi", name: "Pi" }, { id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex", terminal: true }, { id: "opencode", name: "OpenCode" }];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return json({ ...capability, harnesses });
    if (url === "/api/agents") return json([]);
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const agents = page();
  await agents.load();
  expect(agents.pasteHarnesses().map((harness) => harness.name)).toEqual(["Pi", "Claude Code", "OpenCode"]);
  expect(agents.terminalHarnesses().map((harness) => harness.name)).toEqual(["Codex"]);
  expect(agents.harnessJoin(2, agents.pasteHarnesses().length)).toBe(" or ");
});

test("a row loaded Offline right after Allow turns Ready when the session attaches, and back", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return json(capability);
    if (url === "/api/agents") return json([{ nick: "claude-8fe7", machine: "mac", lastSeen: null, status: "offline" }, { nick: "pi-241e", machine: "mac", lastSeen: null, status: "working" }]);
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const agents = page();
  await agents.load();
  const state = (nick: string) => agents.status(agents.rows.find((row) => row.nick === nick)!).label;
  expect(state("claude-8fe7")).toBe("Offline");
  agents.setPresence("Claude-8fe7", true);
  expect(state("claude-8fe7")).toBe("Ready");
  // An attach doesn't hide work in progress; a drop does end it.
  agents.setPresence("pi-241e", true);
  expect(state("pi-241e")).toBe("Working");
  agents.setPresence("claude-8fe7", false);
  agents.setPresence("pi-241e", false);
  expect(state("claude-8fe7")).toBe("Offline");
  expect(state("pi-241e")).toBe("Offline");
  agents.setPresence("nobody", true);
  // Removed on another device: the row goes without a reload.
  agents.dropRow("PI-241E");
  expect(agents.rows.map((row) => row.nick)).toEqual(["claude-8fe7"]);
});

test("an agent that attached before the list read lands as Ready, not Offline", async () => {
  // Right after Allow the session can attach while the page's list read, made before the attach,
  // is still in flight: the presence event finds no row, and the list then says offline.
  let rows: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/agents/capabilities")) return json(capability);
    if (url === "/api/agents") return json(rows);
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const agents = page();
  await agents.load();
  agents.setPresence("pi-5ec7", true);
  rows = [{ nick: "pi-5ec7", machine: "devbox", lastSeen: null, status: "offline" }];
  await agents.load();
  expect(agents.status(agents.rows[0]!).key).toBe("ready");
  agents.setPresence("PI-5EC7", false);
  expect(agents.status(agents.rows[0]!).key).toBe("offline");
  // A later read agrees with the latest event, and a reset forgets it.
  rows = [{ nick: "pi-5ec7", machine: "devbox", lastSeen: null, status: "ready" }];
  await agents.load();
  expect(agents.status(agents.rows[0]!).key).toBe("offline");
  agents.reset();
});
