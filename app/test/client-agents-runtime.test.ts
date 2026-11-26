// Real-runtime acceptance for the AGENTS section: agent DMs move out of Direct messages, carry the
// harness mark and display name, and a freshly paired agent appears from live events without a
// reload. Browser APIs are shims and the server is a fetch stub.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { installBrowserShims } from "./support/browser-shims.ts";

const PEOPLE_DM = { nick: "ada", channel: "#dm-ada-eve" };
const AGENT_DM = { nick: "pi-a143", channel: "#dm-eve-pi-a143" };
const NEW_DM = { nick: "sa-9f2c", channel: "#dm-eve-sa-9f2c" };

function shims(origin: string, listeners: Map<string, (event: { data: string }) => void>): void {
  installBrowserShims({ origin, userAgent: "agents-runtime-test", EventSource: class { addEventListener(name: string, listener: (event: { data: string }) => void) { listeners.set(name, listener); } close() {} } });
}

function authBody(paired: boolean) {
  const directs = [PEOPLE_DM, AGENT_DM, ...(paired ? [NEW_DM] : [])];
  return {
    authenticated: true, account: "eve", accountId: "eve-agents-id", nick: "eve",
    channels: ["#dev-test"], directs, contacts: ["ada"],
    accountDetails: [
      { nick: "eve", id: "eve-agents-id", kind: "human" },
      { nick: "ada", id: "ada-id", kind: "human" },
      { nick: "pi-a143", id: "pi-a143-id", kind: "agent", owner: "eve", attached: true, agent: { harness: "pi", name: "slirc fixes", repo: "slirc", model: "opus-5.5" } },
      ...(paired ? [{ nick: "sa-9f2c", id: "sa-9f2c-id", kind: "agent", owner: "eve", attached: true, agent: { harness: "pi", name: "new pairing", repo: null, model: null } }] : []),
    ],
    profile: {}, role: "member", threads: [], channelDetails: [], openChannels: [],
  };
}

test("agent DMs sit under AGENTS with their harness mark, and a new pairing appears live", async () => {
  const listeners = new Map<string, (event: { data: string }) => void>();
  shims("https://agents-runtime.test", listeners);
  const originalFetch = globalThis.fetch;
  let meCalls = 0;
  let paired = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/auth/me") { meCalls += 1; return Response.json(authBody(paired)); }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const ui = client.ui as any;
  try {
    await client.connect();
    expect(ui.directList().map((item: { nick: string }) => item.nick)).toEqual(["ada"]);
    expect(ui.agentList()).toEqual([{ nick: "pi-a143", label: "slirc fixes", channel: AGENT_DM.channel }]);
    expect(ui.avatarUrl("pi-a143")).toBe("/icons/agents/pi.svg");
    expect(ui.avatarStatus("pi-a143")).toBe("online");

    ui.direct = true;
    ui.channel = "pi-a143";
    ui.roomLabel = "pi-a143";
    expect(ui.headerTitle()).toBe("slirc fixes");
    expect(ui.headerSubtitle()).toBe("Pi · pi-a143");
    expect(ui.headerTooltip()).toBe(`slirc fixes · Pi · pi-a143 · ${ui.avatarStatusLabel("pi-a143")}`);

    ui.activeThread = { title: "A thread" };
    ui.roomLabel = "A thread";
    expect(ui.headerTitle()).toBe("A thread");
    expect(ui.headerSubtitle()).toBe("");
    ui.activeThread = null;
    ui.channel = "ada";
    ui.roomLabel = "ada";
    expect(ui.headerTitle()).toBe("ada");
    expect(ui.headerSubtitle()).toBe("");
    expect(ui.headerTooltip()).toBe(`ada · ${ui.avatarStatusLabel("ada")}`);
    ui.direct = false;
    ui.channel = "#dev-test";
    ui.roomLabel = "dev-test";
    expect(ui.headerTitle()).toBe("dev-test");
    expect(ui.headerSubtitle()).toBe("");
    expect(ui.headerTooltip()).toBe("");

    // The server pairs a new agent: its first live event names a nick this tab has never seen.
    const before = meCalls;
    paired = true;
    listeners.get("agent-updated")!({ data: JSON.stringify({ nick: "sa-9f2c", agent: { harness: "pi", name: "new pairing", repo: null, model: null } }) });
    await settle();
    expect(meCalls).toBe(before + 1);
    expect(ui.agentList().map((row: { label: string }) => row.label)).toEqual(["new pairing", "slirc fixes"]);
    expect(ui.directList().map((item: { nick: string }) => item.nick)).toEqual(["ada"]);
    // `sa-` has no prefix mark; the harness from the roster decides.
    expect(ui.avatarUrl("sa-9f2c")).toBe("/icons/agents/pi.svg");

    // A rename of a known agent with a DM patches the label without another /auth/me.
    listeners.get("agent-updated")!({ data: JSON.stringify({ nick: "pi-a143", agent: { harness: "pi", name: "release prep", repo: "slirc", model: "opus-5.5" } }) });
    listeners.get("agent-updated")!({ data: "not json" });
    await settle();
    expect(meCalls).toBe(before + 1);
    expect(ui.agentList().map((row: { label: string }) => row.label)).toEqual(["new pairing", "release prep"]);
    ui.direct = true;
    ui.channel = "pi-a143";
    ui.roomLabel = "pi-a143";
    expect(ui.headerTitle()).toBe("release prep");
    expect(ui.headerSubtitle()).toBe("Pi · pi-a143");
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);

test("removing an agent from its own DM lands on the default room and drops it from the sidebar", async () => {
  const listeners = new Map<string, (event: { data: string }) => void>();
  shims("https://agents-runtime.test", listeners);
  const originalFetch = globalThis.fetch;
  let removed = false;
  let deleted = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/auth/me") {
      const body = authBody(false);
      if (removed) { body.directs = body.directs.filter((item) => item.nick !== AGENT_DM.nick); body.accountDetails = body.accountDetails.filter((item) => item.nick !== AGENT_DM.nick); }
      return Response.json(body);
    }
    if (path === "/api/agents/pi-a143" && init?.method === "DELETE") { deleted = path; removed = true; return new Response(null, { status: 204 }); }
    return Response.json({});
  }) as typeof fetch;

  const { createClient } = await import("../client/runtime.ts");
  const client = createClient({ reactive: (value: object) => value, nextTick: (callback?: () => void) => Promise.resolve().then(callback) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const ui = client.ui as any;
  try {
    await client.connect();
    await ui.openDirect("pi-a143");
    await settle();
    expect(ui.direct).toBe(true);
    expect(ui.channel).toBe("pi-a143");

    // The offline card's button opens the shared dialog, and Cancel leaves everything as it was.
    client.agents.askRemove({ nick: "pi-a143" }, null as unknown as HTMLElement);
    expect(client.agents.removeTarget?.nick).toBe("pi-a143");
    client.agents.closeRemove();
    expect(client.agents.removeTarget).toBeNull();
    expect(ui.channel).toBe("pi-a143");
    expect(ui.agentList().map((row: { nick: string }) => row.nick)).toEqual(["pi-a143"]);

    client.agents.askRemove({ nick: "pi-a143" }, null as unknown as HTMLElement);
    await client.agents.confirmRemove();
    await settle();
    expect(deleted).toBe("/api/agents/pi-a143");
    expect(client.agents.removeTarget).toBeNull();
    expect(ui.direct).toBe(false);
    expect(ui.channel).toBe("#dev-test");
    expect(ui.note).toBe("pi-a143 was removed.");
    expect(ui.agentList()).toEqual([]);
    expect(ui.directList().map((item: { nick: string }) => item.nick)).toEqual(["ada"]);
  } finally {
    client.ui.destroy();
    globalThis.fetch = originalFetch;
  }
}, 5000);
