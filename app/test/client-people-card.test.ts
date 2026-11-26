// Profile card shared-conversation policy. The pure helper is the security boundary: WHOIS
// membership is only ever intersected with the viewer's authorized conversations, group titles
// come from authorized channel metadata, and a thread needs an authorized parent. The component
// checks that a row opens the existing authorized conversation and closes the card.
import { expect, test } from "bun:test";
import { createPeopleCard, sharedConversations, type SharedConversationRow } from "@client/people-card.ts";
import { SyncEngine, type AuthorizedConversation } from "@client/sync.ts";
import type { ThreadGrant } from "@client/access.ts";

const identity = <T extends object>(value: T): T => value;

const room = (wire: string, id = wire): AuthorizedConversation => ({ conversationId: id, wireTarget: wire, kind: "room" });
const dm = (wire: string, id: string): AuthorizedConversation => ({ conversationId: id, wireTarget: wire, kind: "dm" });

const base = {
  whoisChannels: [] as string[],
  conversations: [] as AuthorizedConversation[],
  directs: [] as { nick: string; channel: string }[],
  channelDetails: [] as { channel: string; topic?: string; isGroup?: boolean }[],
  threads: [] as ThreadGrant[],
  targetNick: "bob",
};

test("shared channels are the authorized intersection, never a raw WHOIS channel", () => {
  const result = sharedConversations({
    ...base,
    whoisChannels: ["#dev-open", "#other-secret"],
    conversations: [room("#dev-open"), room("#mine-only")],
  });
  expect(result.channels.map((row) => row.wireTarget)).toEqual(["#dev-open"]);
  expect(result.channels[0]!.label).toBe("dev-open");
});

test("a 1:1 DM with the viewed person is shared; other people's DMs are not", () => {
  const result = sharedConversations({
    ...base,
    directs: [{ nick: "Bob", channel: "#dm-bob" }, { nick: "eve", channel: "#dm-eve" }],
    conversations: [dm("#dm-bob", "dm:bob"), dm("#dm-eve", "dm:eve")],
  });
  expect(result.dms.map((row) => row.nick)).toEqual(["Bob"]);
});

test("a custom group title stays intact and its authorized member list supplies the capped avatar pile", () => {
  const result = sharedConversations({
    ...base,
    whoisChannels: ["#g-1234"],
    conversations: [room("#g-1234", "room:g"), room("#t-a", "thread:a")],
    channelDetails: [{ channel: "#g-1234", topic: "Launch crew", isGroup: true }],
    groupMembers: { "#g-1234": ["Ada", "Ben", "Eve", "Zed"] },
  });
  expect(result.dms).toHaveLength(1);
  expect(result.dms[0]!.label).toBe("Launch crew");
  expect(result.dms[0]!.people).toEqual(["Ada", "Ben", "Eve"]);
  expect(result.dms[0]!.extra).toBe(1);
});

test("a group without an authorized label is omitted instead of leaking its raw id", () => {
  const result = sharedConversations({
    ...base,
    whoisChannels: ["#g-1234"],
    conversations: [room("#g-1234", "room:g")],
    channelDetails: [{ channel: "#g-1234", topic: "", isGroup: true }],
  });
  expect(result.dms).toEqual([]);
});

test("a thread needs both an authorized parent and a genuine membership signal", () => {
  const thread = (overrides: Partial<ThreadGrant>): ThreadGrant => ({
    channel: "#t-a", conversationId: "thread:a", parent: "#dev-open", parentLabel: "dev-open",
    title: "Root", root: "msg1", rootNick: "carol", rootText: "hi", rootTime: "", lastActivity: 0, ...overrides,
  });
  const result = sharedConversations({
    ...base,
    whoisChannels: ["#t-a"],
    conversations: [room("#dev-open"), room("#t-a"), room("#t-b"), room("#t-c"), room("#t-d")],
    threads: [
      thread({ channel: "#t-a", conversationId: "thread:a" }),
      thread({ channel: "#t-b", conversationId: "thread:b", rootNick: "bob" }),
      thread({ channel: "#t-c", conversationId: "thread:c", parent: "#gone" }),
      thread({ channel: "#t-d", conversationId: "thread:d", rootNick: "bob" }),
    ],
  });
  expect(result.threads.map((row) => row.conversationId)).toEqual(["thread:a"]);
});

test("a thread is excluded when only its parent is authorized", () => {
  const result = sharedConversations({
    ...base,
    whoisChannels: ["#t-a"],
    conversations: [room("#dev-open")],
    threads: [{ channel: "#t-a", conversationId: "thread:a", parent: "#dev-open", parentLabel: "dev-open",
      title: "Root", root: "msg1", rootNick: "bob", rootText: "hi", rootTime: "", lastActivity: 0 }],
  });
  expect(result.threads).toEqual([]);
});

test("a group-parented thread uses the authorized group label, not the raw id", () => {
  const result = sharedConversations({
    ...base,
    whoisChannels: ["#t-a"],
    conversations: [room("#g-1234", "room:g"), room("#t-a", "thread:a")],
    channelDetails: [{ channel: "#g-1234", topic: "Launch crew", isGroup: true }],
    threads: [{
      channel: "#t-a", conversationId: "thread:a", parent: "#g-1234", parentLabel: "g-1234",
      title: "Root", root: "msg1", rootNick: "carol", rootText: "hi", rootTime: "", lastActivity: 0,
    }],
  });
  expect(result.threads[0]!.parentLabel).toBe("Launch crew");
});

test("clicking a shared row opens the existing authorized conversation and closes the card", () => {
  const openedRooms: string[] = [];
  const openedDms: string[] = [];
  const people = createPeopleCard(identity, {
    core: { channel: "#dev-open", me: "alice" },
    openPopup: () => {},
    sendWhois: () => {},
    activeChannel: () => "#dev-open",
    openRoom: (channel) => { openedRooms.push(channel); },
    openDirect: async (nick) => { openedDms.push(nick); },
    conversations: () => [room("#dev-open"), dm("#dm-bob", "dm:bob")],
    directs: () => [{ nick: "bob", channel: "#dm-bob" }],
    channelDetails: () => [],
    threads: () => [],
  });
  people.whoisNick = "bob";
  const channelRow: SharedConversationRow = { kind: "channel", conversationId: "c", wireTarget: "#dev-open", label: "dev-open" };
  people.openShared(channelRow);
  expect(openedRooms).toEqual(["#dev-open"]);
  expect(people.whoisNick).toBe("");
  people.whoisNick = "bob";
  people.openShared({ kind: "dm", conversationId: "dm:bob", wireTarget: "#dm-bob", label: "bob", nick: "bob" });
  expect(openedDms).toEqual(["bob"]);
  expect(people.whoisNick).toBe("");
});

const card = (overrides: Partial<Parameters<typeof createPeopleCard>[1]> = {}) => createPeopleCard(identity, {
  core: { channel: "#dev-open", me: "alice" },
  openPopup: () => {},
  sendWhois: () => {},
  activeChannel: () => "#dev-open",
  openRoom: () => {},
  openDirect: async () => {},
  conversations: () => [],
  directs: () => [],
  channelDetails: () => [],
  threads: () => [],
  whoisTimeoutMs: 500,
  ...overrides,
} as any);

test("a mention opens the card immediately and keeps loading until WHOIS ends", () => {
  const sent: string[] = [];
  const people = card({ sendWhois: (nick: string) => sent.push(nick) });
  people.openWhois("juno");
  expect(people.whoisNick).toBe("juno"); // the click opens it; no timer or reply gate
  expect(people.whoisInfo()?.loading).toBe(true); // IRC details show Loading… from the click
  expect(people.whoisInfo()?.profileLoading).toBe(true); // profile fields show a skeleton until HTTP returns
  expect(sent).toEqual(["juno"]);
  people.applyWhois({ command: "311", params: ["alice", "juno", "u", "h", "Juno Real"] } as any);
  people.applyWhois({ command: "319", params: ["alice", "juno", "#dev-open"] } as any);
  expect(people.whoisInfo()?.loading).toBe(true); // intermediate numerics keep the Loading state
  people.applyWhois({ command: "318", params: ["alice", "juno", "End of WHOIS"] } as any);
  expect(people.whoisInfo()?.loading).toBe(false);
});

test("a WHOIS error ends loading instead of spinning forever", () => {
  const people = card();
  people.openWhois("ghost");
  expect(people.whoisInfo()?.loading).toBe(true);
  people.applyWhois({ command: "401", params: ["alice", "ghost", "No such nick"] } as any);
  expect(people.whoisInfo()?.loading).toBe(false);
});

test("a silent server reports unavailable at the deadline and ignores late success", async () => {
  const people = card({ whoisTimeoutMs: 8 });
  people.openWhois("silent");
  expect(people.whoisInfo()?.loading).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(people.whoisInfo()?.loading).toBe(false);
  expect(people.whoisInfo()?.error).toContain("Try again");
  people.applyWhois({ command: "311", params: ["alice", "silent", "late", "host", "Late"] } as any);
  people.applyWhois({ command: "318", params: ["alice", "silent", "End"] } as any);
  expect(people.whoisInfo()?.user).toBeUndefined();
  expect(people.whoisInfo()?.error).toContain("Try again");
});

test("a late WHOIS reply for a switched-away nick is dropped, not mixed in", () => {
  const people = card();
  people.openWhois("juno");
  people.openWhois("other");
  people.applyWhois({ command: "318", params: ["alice", "juno", "End of WHOIS"] } as any);
  expect(people.whoisInfo()?.nick).toBe("other");
  expect(people.whoisInfo()?.loading).toBe(true); // juno's end did not finish other
  people.applyWhois({ command: "318", params: ["alice", "other", "End of WHOIS"] } as any);
  expect(people.whoisInfo()?.loading).toBe(false);
});

test("a late profile response never lands on a different person", async () => {
  const original = globalThis.fetch;
  const pending: Array<(value: Response) => void> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => { pending.push(resolve); })) as typeof fetch;
  try {
    const people = card();
    people.openWhois("juno");
    people.openWhois("other");
    pending[0]!(new Response(JSON.stringify({ account: "juno", fullName: "Juno" })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(people.whoisInfo()?.profile).toBeUndefined();
    pending[1]!(new Response(JSON.stringify({ account: "other", fullName: "Other" })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(people.whoisInfo()?.profile?.account).toBe("other");
  } finally { globalThis.fetch = original; }
});

test("opening a profile does not focus the composer; only the Message action does", async () => {
  let focused = 0;
  const people = card({ focusComposer: () => { focused += 1; } });
  people.openWhois("juno");
  expect(focused).toBe(0);
  await people.messageMention("juno");
  expect(focused).toBe(1);
});

test("the Message action opens the DM and focuses the composer", async () => {
  const opened: string[] = []; let focused = 0;
  const people = card({ openDirect: async (nick: string) => { opened.push(nick); }, focusComposer: () => { focused += 1; } });
  people.openWhois("juno");
  await people.messageMention("juno");
  expect(opened).toEqual(["juno"]);
  expect(focused).toBe(1);
  expect(people.whoisNick).toBe("");
});

test("a profile response before WHOIS is kept and does not end the WHOIS loading state", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ account: "juno", fullName: "Juno" }))) as typeof fetch;
  try {
    const people = card();
    people.openWhois("juno");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(people.whoisInfo()?.profile?.fullName).toBe("Juno");
    expect(people.whoisInfo()?.loading).toBe(true); // HTTP success must not complete the WHOIS lookup
    people.applyWhois({ command: "311", params: ["alice", "juno", "u", "h", "Juno Real"] } as any);
    expect(people.whoisInfo()?.profile?.fullName).toBe("Juno"); // numerics merge without clobbering the profile
    expect(people.whoisInfo()?.user).toBeUndefined(); // partial IRC data stays unpublished
    people.applyWhois({ command: "318", params: ["alice", "juno", "End of WHOIS"] } as any);
    expect(people.whoisInfo()?.loading).toBe(false);
  } finally { globalThis.fetch = original; }
});

test("late WHOIS and profile replies after close never reopen the card", async () => {
  const original = globalThis.fetch;
  const pending: Array<(value: Response) => void> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => { pending.push(resolve); })) as typeof fetch;
  try {
    const people = card();
    people.openWhois("juno");
    people.closeWhois();
    pending[0]!(new Response(JSON.stringify({ account: "juno", fullName: "Juno" })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    people.applyWhois({ command: "318", params: ["alice", "juno", "End of WHOIS"] } as any);
    expect(people.whoisNick).toBe("");
    expect(people.whoisInfo()).toBe(null);
  } finally { globalThis.fetch = original; }
});

test("late WHOIS and profile replies after reset are dropped", async () => {
  const original = globalThis.fetch;
  const pending: Array<(value: Response) => void> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => { pending.push(resolve); })) as typeof fetch;
  try {
    const people = card();
    people.openWhois("juno");
    people.reset();
    pending[0]!(new Response(JSON.stringify({ account: "juno", fullName: "Juno" })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    people.applyWhois({ command: "318", params: ["alice", "juno", "End of WHOIS"] } as any);
    expect(people.whoisNick).toBe("");
    expect(people.whoisInfo()).toBe(null);
  } finally { globalThis.fetch = original; }
});


test("WHOIS publishes details and shared rows together at 318, after more than two seconds", async () => {
  const people = card({ whoisTimeoutMs: 4000, conversations: () => [room("#dev-open")],
    directs: () => [{ nick: "juno", channel: "#dm-juno" }] });
  people.openWhois("juno");
  people.applyWhois({ command: "311", params: ["alice", "juno", "u", "h", "Juno"] } as any);
  people.applyWhois({ command: "319", params: ["alice", "juno", "#dev-open #private"] } as any);
  expect(people.whoisShared().channels).toEqual([]);
  expect(people.whoisInfo()?.user).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect(people.whoisInfo()?.loading).toBe(true);
  expect(people.whoisShared().channels).toEqual([]);
  people.applyWhois({ command: "318", params: ["alice", "juno", "End"] } as any);
  expect(people.whoisInfo()?.user).toBe("u");
  expect(people.whoisShared().channels.map((row) => row.wireTarget)).toEqual(["#dev-open"]);
  people.destroy();
});

test("popup cleanup runs before the new profile request epoch is captured", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ account: "juno", fullName: "Juno" }))) as typeof fetch;
  try {
    const people = card({ openPopup: (close) => close?.() });
    people.openWhois("juno");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(people.whoisInfo()?.profile?.fullName).toBe("Juno");
    expect(people.whoisInfo()?.profileLoading).toBe(false);
    people.destroy();
  } finally { globalThis.fetch = original; }
});

test("same-nick reopening joins the outstanding WHOIS instead of mixing duplicate replies", () => {
  const sent: string[] = [];
  const people = card({ sendWhois: (nick) => sent.push(nick) });
  people.openWhois("juno");
  people.applyWhois({ command: "311", params: ["alice", "juno", "u", "h", "Juno"] } as any);
  people.closeWhois();
  people.openWhois("JUNO");
  expect(sent).toEqual(["juno"]);
  expect(people.whoisInfo()?.user).toBeUndefined();
  people.applyWhois({ command: "318", params: ["alice", "juno", "End"] } as any);
  expect(people.whoisInfo()?.user).toBe("u");
  people.destroy();
});

test("group avatars stay pending until members HTTP completes and stale responses are ignored", async () => {
  const original = globalThis.fetch;
  let complete: (value: Response) => void = () => {};
  globalThis.fetch = ((url: string) => url.startsWith("/profiles/")
    ? Promise.resolve(new Response(JSON.stringify({ account: "juno" })))
    : new Promise<Response>((resolve) => { complete = resolve; })) as typeof fetch;
  try {
    const people = card({ conversations: () => [room("#g-one")],
      channelDetails: () => [{ channel: "#g-one", topic: "Crew", isGroup: true }] });
    people.openWhois("juno");
    people.applyWhois({ command: "319", params: ["alice", "juno", "#g-one"] } as any);
    expect(people.groupMemberState).toEqual({});
    people.applyWhois({ command: "318", params: ["alice", "juno", "End"] } as any);
    expect(people.whoisInfo()?.loading).toBe(false);
    expect(people.groupMembersState("#g-one")).toBe("loading");
    complete(new Response(JSON.stringify({ members: [{ nick: "juno" }, { nick: "alice" }] })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(people.groupMembersState("#g-one")).toBe("ready");
    expect(people.whoisShared().dms[0]?.people).toEqual(["juno", "alice"]);
    people.retryGroupMembers();
    expect(people.groupMembersState("#g-one")).toBe("loading");
    people.openWhois("other");
    complete(new Response(JSON.stringify({ members: [{ nick: "stale" }] })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(people.groupMembers).toEqual({});
    people.destroy();
  } finally { globalThis.fetch = original; }
});

test("failed group-member HTTP reports unavailable, and retry completes from a real response", async () => {
  const original = globalThis.fetch;
  let fail = true;
  globalThis.fetch = (async (url: string) => url.startsWith("/profiles/")
    ? new Response(JSON.stringify({ account: "juno" }))
    : fail ? new Response("", { status: 503 }) : new Response(JSON.stringify({ members: [] }))) as typeof fetch;
  try {
    const people = card({ conversations: () => [room("#g-one")],
      channelDetails: () => [{ channel: "#g-one", topic: "Crew", isGroup: true }] });
    people.openWhois("juno");
    people.applyWhois({ command: "319", params: ["alice", "juno", "#g-one"] } as any);
    people.applyWhois({ command: "318", params: ["alice", "juno", "End"] } as any);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(people.groupMembersState("#g-one")).toBe("error");
    fail = false;
    people.retryGroupMembers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(people.groupMembersState("#g-one")).toBe("ready");
    people.destroy();
  } finally { globalThis.fetch = original; }
});


test("the real sync dispatch delivers WHOIS errors to the open card", () => {
  const people = card();
  const engine = new SyncEngine({ db: {} as any, send: () => true,
    hooks: { onWhois: (message) => people.applyWhois(message) } });
  people.openWhois("ghost");
  engine.push(":server 401 alice ghost :No such nick\r\n");
  expect(people.whoisInfo()?.loading).toBe(false);
  expect(people.whoisInfo()?.error).toContain("offline or unavailable");
  people.destroy();
});


test("a closed socket is unavailable immediately and retry sends after reconnection", () => {
  let connected = false; let attempts = 0;
  const people = card({ sendWhois: () => { attempts++; return connected; } });
  people.openWhois("juno");
  expect(people.whoisInfo()?.loading).toBe(false);
  expect(people.whoisInfo()?.error).toContain("offline");
  connected = true;
  people.retryWhois();
  expect(attempts).toBe(2);
  expect(people.whoisInfo()?.loading).toBe(true);
  people.applyWhois({ command: "318", params: ["alice", "juno", "End"] } as any);
  expect(people.whoisInfo()?.error).toBe("");
  people.destroy();
});

test("an admin whose display name folds to a member's account still sees Remove member", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ account: "mauricio", fullName: "Mauricio", kind: "human" }))) as typeof fetch;
  try {
    // ui.me holds the display name; the account is the identity.
    const people = card({ core: { channel: "#ai-guild", me: "Mauricio", account: "bitbonsai", isAdmin: true } });
    people.openWhois("mauricio");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(people.isMe("mauricio")).toBe(false);
    expect(people.isMe("BitBonsai")).toBe(true);
    expect(people.canRemove()).toBe(true);
    people.destroy();
  } finally { globalThis.fetch = original; }
});

test("WHOIS 671 never replaces the 311 real name", () => {
  const people = card();
  const engine = new SyncEngine({ db: {} as any, send: () => true,
    hooks: { onWhois: (message) => people.applyWhois(message) } });
  people.openWhois("juno");
  engine.push(":server 311 alice juno u h * :Juno Real\r\n");
  engine.push(":server 671 alice juno :is using a secure connection\r\n");
  engine.push(":server 318 alice juno :End of WHOIS\r\n");
  expect(people.whoisInfo()?.realname).toBe("Juno Real");
  people.destroy();
});
