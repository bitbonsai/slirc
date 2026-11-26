// Agents in the client: the roster merge, the AGENTS sidebar grouping, harness avatars, the
// `repo · model` subtitle on the Agents page and members rail, and agents in `@` and `/invite` completion.
import { afterEach, expect, test } from "bun:test";
import { agentInviteMatches, agentLabel, agentNavRows, agentSubtitle, applyAgentUpdate, forgetAgent, mergeAgents, ownAgentNicks } from "@client/agent-roster.ts";
import { avatarUrl } from "@client/presentation.ts";
import { createAgentsPage } from "@client/agents-page.ts";
import { createMembersPanel, type MembersPanelRow } from "@client/members-panel.ts";
import { mentionPickerComponent } from "@client/composer-pickers.ts";

(globalThis as any).window ??= new EventTarget();
const identity = <T extends object>(value: T): T => value;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const details = [
  { nick: "eve", kind: "human", owner: null },
  { nick: "ada", kind: "human", owner: null },
  { nick: "pi-a143", kind: "agent", owner: "eve", attached: true, agent: { harness: "pi", name: "slirc fixes", repo: "slirc", model: "opus-5.5" } },
  { nick: "sa-9f2c", kind: "agent", owner: "eve", attached: false },
  { nick: "pi-b001", kind: "agent", owner: "zed", agent: { harness: "pi", name: "zed's", repo: null, model: null } },
];

test("the roster keeps agent rows only and a partial source never blanks a richer one", () => {
  let roster = mergeAgents({}, details);
  expect(Object.keys(roster).sort()).toEqual(["pi-a143", "pi-b001", "sa-9f2c"]);
  expect(roster["pi-a143"]).toMatchObject({ owner: "eve", harness: "pi", name: "slirc fixes", repo: "slirc", model: "opus-5.5" });
  // A members row carries kind but no agent object: everything already known stays.
  roster = mergeAgents(roster, [{ nick: "PI-A143", kind: "agent", machine: "devbox" }]);
  expect(roster["pi-a143"]).toMatchObject({ nick: "pi-a143", owner: "eve", harness: "pi", name: "slirc fixes" });
  // Agents page rows are owner-scoped and may lack kind; legacy top-level fields still count.
  roster = mergeAgents(roster, [{ nick: "sa-9f2c", harness: "pi", sessionName: "old session", repo: "dotfiles" }], { owner: "eve", allAgents: true });
  expect(roster["sa-9f2c"]).toMatchObject({ owner: "eve", harness: "pi", name: "old session", repo: "dotfiles" });
  expect(forgetAgent(roster, "SA-9F2C")["sa-9f2c"]).toBeUndefined();
});

test("a live agent-updated patch renames an agent and learns a new one; malformed events are ignored", () => {
  const roster = mergeAgents({}, details);
  const renamed = applyAgentUpdate(roster, { nick: "pi-a143", agent: { harness: "pi", name: "release prep", repo: "slirc", model: null } })!;
  expect(renamed["pi-a143"]).toMatchObject({ name: "release prep", repo: "slirc", model: "opus-5.5", owner: "eve" });
  const added = applyAgentUpdate(renamed, { nick: "pi-c777", agent: { harness: "pi", name: "new pairing", repo: null, model: null } })!;
  expect(agentLabel(added, "PI-C777")).toBe("new pairing");
  expect(applyAgentUpdate(roster, { agent: {} })).toBeNull();
  expect(applyAgentUpdate(roster, null)).toBeNull();
});

test("AGENTS lists agent DMs and own agents without one, by display name, minus starred and other people", () => {
  const roster = mergeAgents({}, details);
  const directs = [{ nick: "ada", channel: "#dm-ada-eve" }, { nick: "pi-a143", channel: "#dm-eve-pi-a143" }];
  expect(agentNavRows(roster, directs, "eve", () => false)).toEqual([
    { nick: "sa-9f2c", label: "sa-9f2c", channel: "" },
    { nick: "pi-a143", label: "slirc fixes", channel: "#dm-eve-pi-a143" },
  ]);
  // A starred agent DM lives in Starred only, like a starred person DM.
  expect(agentNavRows(roster, directs, "eve", (channel) => channel === "#dm-eve-pi-a143").map((row) => row.nick)).toEqual(["sa-9f2c"]);
  expect(agentNavRows({}, directs, "eve", () => false)).toEqual([]);
  expect(ownAgentNicks(roster, "EVE").sort()).toEqual(["pi-a143", "sa-9f2c"]);
});

test("agents draw their harness mark, an unknown harness the generic glyph, and people keep uploads", () => {
  expect(avatarUrl("sa-9f2c", undefined, "pi")).toBe("/icons/agents/pi.svg");
  expect(avatarUrl("sa-9f2c", undefined, "Claude")).toBe("/icons/agents/claude.svg");
  expect(avatarUrl("sa-9f2c", undefined, "")).toBe("/icons/agents/agent.svg");
  expect(avatarUrl("sa-9f2c", undefined, "mystery")).toBe("/icons/agents/agent.svg");
  // A known agent with no harness yet still gets its nick prefix's mark.
  expect(avatarUrl("pi-a143", undefined, "")).toBe("/icons/agents/pi.svg");
  expect(avatarUrl("pi-a143")).toBe("/icons/agents/pi.svg");
  // Not known as an agent: no glyph is invented.
  expect(avatarUrl("sa-9f2c")).toBe("/avatars/sa-9f2c");
  expect(avatarUrl("ada", 3)).toBe("/avatars/ada?v=3");
});

test("subtitles show repo · model, whichever exist", () => {
  expect(agentSubtitle({ repo: "slirc", model: "opus-5.5" })).toBe("slirc · opus-5.5");
  expect(agentSubtitle({ repo: "slirc", model: "" })).toBe("slirc");
  expect(agentSubtitle({ model: "opus-5.5" })).toBe("opus-5.5");
  expect(agentSubtitle({})).toBe("");
  expect(agentSubtitle(undefined)).toBe("");
});

test("Agents page rows use the display name and repo · model instead of harness · machine", async () => {
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/agents/capabilities") return Response.json({ enabled: true, supportedHarnesses: ["pi"] });
    if (url === "/api/agents") return Response.json([
      { nick: "pi-a143", machine: "pi", harness: "pi", status: "ready", lastSeen: 1, kind: "agent", agent: { harness: "pi", name: "slirc fixes", repo: "slirc", model: "opus-5.5" } },
      { nick: "pi-b002", machine: "pi", harness: "pi", status: "offline", lastSeen: 1, agent: { harness: "pi", name: "docs", repo: null, model: null } },
      { nick: "sa-9f2c", machine: "laptop", lastSeen: null },
    ]);
    return Response.json({});
  }) as typeof fetch;
  const learned: unknown[][] = [];
  const page = createAgentsPage(identity, {
    core: { authenticated: true, account: "eve" },
    session: { scope: () => ({ instance: "https://slirc.test", accountId: "eve-id", account: "eve" }), key: () => "k", stopped: () => false, signingOut: () => false },
    openDm: () => {},
    onRows: (rows) => { learned.push(rows); },
  });
  await page.load();
  expect(page.rows.map((row) => [page.agentTitle(row), page.agentSubtitle(row)])).toEqual([
    ["slirc fixes", "slirc · opus-5.5"],
    ["docs", "pi-b002"],
    ["sa-9f2c", "laptop"],
  ]);
  expect(learned).toHaveLength(1);
  // A live update patches the listed row in place.
  page.applyUpdate({ nick: "pi-b002", agent: { harness: "pi", name: "docs", repo: "landing", model: "sonnet-5.5" } });
  expect(page.agentSubtitle(page.rows[1]!)).toBe("landing · sonnet-5.5");
});

test("member rows show an agent's repo · model, falling back to the machine", () => {
  const roster = mergeAgents({}, details);
  const core = { account: "eve", roomMemberRows: [] as MembersPanelRow[], roomMembersOwner: "", roomMembersPublic: false, roomMembersLoading: false, roomMembersError: "" };
  const members = createMembersPanel(identity, {
    core, canShow: () => true, request: () => {}, status: () => "online", label: () => "Online",
    avatarUrl: (nick) => avatarUrl(nick), openProfile: () => {}, openWhois: () => {}, focusToggle: () => {},
    agent: (nick) => roster[nick.toLowerCase()],
  });
  const row = (nick: string, machine: string | null) => ({ nick, kind: "agent", role: "member", machine, availability: "", badge: "", owner: false, presence: "online" }) as MembersPanelRow;
  expect(members.memberNote(row("pi-a143", "pi"))).toBe("slirc · opus-5.5");
  expect(members.memberNote(row("sa-9f2c", "laptop"))).toBe("laptop");
  expect(members.memberNote(row("sa-0000", null))).toBe("Agent");
});

function picker(composer: string, extra: Record<string, unknown> = {}) {
  const component = mentionPickerComponent() as any;
  Object.assign(component, {
    composer, account: "eve", roomMembers: ["ada"], contacts: [], directs: [], messages: [],
    agentProfiles: mergeAgents({}, details), agentAttached: () => true, $nextTick: (callback: () => void) => callback(), ...extra,
  });
  return component;
}

test("`@` completion includes your own agents, and agents in the room, but never other people's", () => {
  expect(picker("hey @").matches()).toEqual(["ada", "pi-a143", "sa-9f2c"]);
  expect(picker("hey @sa").matches()).toEqual(["sa-9f2c"]);
  expect(picker("hey @pi-b").matches()).toEqual([]);
  expect(picker("hey @pi-b", { roomMembers: ["pi-b001"] }).matches()).toEqual(["pi-b001"]);
  // An agent that isn't attached is not offered.
  expect(picker("hey @", { agentAttached: (nick: string) => nick !== "pi-a143" }).matches()).toEqual(["ada", "sa-9f2c"]);
});

test("`/invite @sa-` offers your matching agents before people search answers", () => {
  globalThis.fetch = (async () => new Promise(() => {})) as typeof fetch;
  const component = picker("/invite @sa-");
  expect(component.matches()).toEqual(["sa-9f2c"]);
  // Name matches count too; agents already in the room are skipped like any member.
  expect(picker("/invite slirc").matches()).toEqual(["pi-a143"]);
  expect(picker("/invite @pi", { roomMembers: ["pi-a143"] }).matches()).toEqual([]);
  expect(agentInviteMatches(mergeAgents({}, details), "eve", "")).toEqual([]);
  component.stopInviteSearch();
});
