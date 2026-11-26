// Right members rail: grouping/labels/presence buckets, empty/error/loading states, self vs peer
// clicks, toggle/dismiss state, visibility gating, the request-generation guard, and the
// partial/header contract. The component is pure over injected accessors; the runtime owns the
// single authorized member fetch (see client-members-runtime.test.ts for the lifecycle cases).
import { expect, test } from "bun:test";
import { createMembersPanel, memberResponseApplies, membersPanelVisible, type MembersPanelRow } from "@client/members-panel.ts";

const identity = <T extends object>(value: T): T => value;

function setup(canShow = () => true) {
  const core = {
    account: "alice", roomMemberRows: [] as MembersPanelRow[], roomMembersOwner: "",
    roomMembersPublic: false, roomMembersLoading: false, roomMembersError: "",
  };
  const opened: string[] = [];
  const requests: number[] = [];
  const focused: number[] = [];
  const members = createMembersPanel(identity, {
    core,
    canShow,
    request: () => { requests.push(1); },
    status: (nick: string) => nick === "awaybob" ? "away" : nick === "offbob" ? "offline" : "online",
    label: (nick: string) => nick === "awaybob" ? "Away" : nick === "offbob" ? "Offline" : "Online",
    avatarUrl: (nick: string) => `/avatars/${nick}`,
    openProfile: () => { opened.push("self"); },
    openWhois: (nick: string) => { opened.push(nick); },
    focusToggle: () => { focused.push(1); },
  });
  return { core, members, opened, requests, focused };
}

function member(nick: string, overrides: Partial<MembersPanelRow> = {}): MembersPanelRow {
  return { nick, kind: "human", role: "member", machine: null, availability: "", badge: "", ...overrides } as MembersPanelRow;
}

test("an authorized room groups members online/away/offline with the owner first", () => {
  const { core, members } = setup();
  core.roomMembersOwner = "ownerbob";
  core.roomMemberRows = [
    member("botbob", { kind: "bot" }),
    member("awaybob"),
    member("agentbob", { kind: "agent", machine: "laptop" }),
    member("ownerbob"),
    member("offbob"),
    member("adminbob", { role: "admin" }),
  ];
  expect(members.rows().map((row) => row.nick)).toEqual(["ownerbob", "adminbob", "agentbob", "botbob", "awaybob", "offbob"]);
  expect(members.groups().map((group) => [group.label, group.rows.length])).toEqual([["Online", 4], ["Away", 1], ["Offline", 1]]);
  expect(members.countLabel()).toBe("6 members");
  const rows = members.rows();
  const note = (nick: string) => members.memberNote(rows.find((row) => row.nick === nick)!);
  expect(note("ownerbob")).toBe("Owner");
  expect(note("agentbob")).toBe("laptop");
  expect(note("botbob")).toBe("Bot");
  expect(note("awaybob")).toBe("Away");
  expect(note("adminbob")).toBe("");
  expect(members.statusLabel(rows[0]!)).toBe("Online");
});

test("self opens the own profile and a peer opens the existing profile card", () => {
  const { members, opened } = setup();
  members.openMember(member("alice"));
  members.openMember(member("bob"));
  expect(opened).toEqual(["self", "bob"]);
});

test("empty state distinguishes loading, error and an unlisted public room, and error() drives retry", () => {
  const { core, members } = setup();
  expect(members.emptyText()).toBe("Nobody here right now.");
  expect(members.error()).toBe("");
  core.roomMembersLoading = true;
  expect(members.emptyText()).toBe("Loading members…");
  core.roomMembersLoading = false; core.roomMembersError = "Could not load members (502).";
  expect(members.error()).toBe("Could not load members (502).");
  expect(members.emptyText()).toBe("Could not load members (502).");
  core.roomMembersError = ""; core.roomMembersPublic = true;
  expect(members.emptyText()).toBe("Public room. Membership isn't listed.");
});

test("the panel starts closed and opens only on toggle, including after reset", () => {
  const { members, requests, focused } = setup();
  expect(members.open).toBe(false);
  expect(requests.length).toBe(0);
  members.toggle();
  expect(members.open).toBe(true);
  expect(requests.length).toBe(1);
  members.close();
  expect(members.open).toBe(false);
  expect(focused.length).toBe(0); // programmatic close does not steal focus
  members.toggle();
  members.dismiss();
  expect(members.open).toBe(false);
  expect(focused.length).toBe(1);
  members.toggle();
  members.reset();
  expect(members.open).toBe(false);
  members.toggle();
  expect(members.open).toBe(true);
  members.destroy();
  expect(members.open).toBe(false);
  expect(setup().members.open).toBe(false); // a new session does not restore an open rail
  const hidden = setup(() => false);
  hidden.members.toggle();
  expect(hidden.members.open).toBe(false);
  expect(hidden.requests.length).toBe(0);
});

test("the panel shows only for an authorized chat route: never DM, thread, other route, #help or an open channel", () => {
  const base = { authenticated: true, stopped: false, direct: false, threaded: false, channel: "#dev-test", route: false, authorized: true, publicRoom: false };
  expect(membersPanelVisible(base)).toBe(true);
  expect(membersPanelVisible({ ...base, direct: true })).toBe(false);
  expect(membersPanelVisible({ ...base, threaded: true })).toBe(false);
  expect(membersPanelVisible({ ...base, channel: "#help" })).toBe(false);
  expect(membersPanelVisible({ ...base, channel: "#HELP" })).toBe(false);
  expect(membersPanelVisible({ ...base, route: true })).toBe(false);
  expect(membersPanelVisible({ ...base, authorized: false })).toBe(false);
  expect(membersPanelVisible({ ...base, stopped: true })).toBe(false);
  expect(membersPanelVisible({ ...base, authenticated: false })).toBe(false);
  expect(membersPanelVisible({ ...base, channel: "bob" })).toBe(false);
  expect(membersPanelVisible({ ...base, publicRoom: true })).toBe(false);
});

test("a member response applies only for its current generation, room, scope and live grant", () => {
  const current = { conversationId: "room-1", scope: "acct-1", generation: 7, stopped: false, authorized: true };
  const response = { conversationId: "room-1", scope: "acct-1", generation: 7 };
  expect(memberResponseApplies(response, current)).toBe(true);
  expect(memberResponseApplies({ ...response, generation: 6 }, current)).toBe(false); // older request
  expect(memberResponseApplies({ ...response, conversationId: "room-2" }, current)).toBe(false); // A -> B
  expect(memberResponseApplies({ ...response, scope: "acct-2" }, current)).toBe(false); // account switch
  expect(memberResponseApplies(response, { ...current, stopped: true })).toBe(false); // disconnect/teardown
  expect(memberResponseApplies(response, { ...current, authorized: false })).toBe(false); // revoked grant
});
