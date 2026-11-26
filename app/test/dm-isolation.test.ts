// SEC-05: distinct account pairs must never share a DM wire channel. A readable
// `#dm-first-second` is used only when both nicks lack the `-` delimiter and the join fits 63
// chars; every other pair is hashed. Stored rows always win, and a contaminated legacy mapping
// fails closed with a repair path instead of silently merging access.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

const rooms = await import("../src/rooms.ts");
const { db } = await import("../src/db.ts");

// Same encoding as rooms.directChannelCandidate's hashed branch.
const hash56 = (nick: string, other: string) => {
  const [first, second] = [rooms.asciiFold(nick), rooms.asciiFold(other)].sort();
  return `#dm-${createHash("sha256").update(JSON.stringify([first, second])).digest("hex").slice(0, 56)}`;
};

describe("DM isolation: collision-safe channels", () => {
  test("readable only for hyphen-free pairs, hashed for delimiter-ambiguous ones", () => {
    expect(rooms.directChannelName("reda", "redb")).toBe("#dm-reda-redb");
    const one = rooms.createDirectConversation("hyph-a-b", "c", "hyph-a-b");
    const two = rooms.createDirectConversation("hyph-a", "b-c", "hyph-a");
    expect(one.channel).toBe(hash56("hyph-a-b", "c"));
    expect(two.channel).toBe(hash56("hyph-a", "b-c"));
    expect(one.channel).not.toBe(two.channel);
    expect(one.channel).not.toBe("#dm-hyph-a-b-c");
    expect(one.channel.length).toBeLessThanOrEqual(63);
  });

  test("truncation cannot merge two long pairs", () => {
    const longA = "x".repeat(40), longB = "y".repeat(40);
    const a = rooms.createDirectConversation(longA, longB, "x");
    const b = rooms.createDirectConversation(`${"x".repeat(39)}z`, longB, "x");
    expect(a.channel).toBe(hash56(longA, longB));
    expect(a.channel).not.toBe(b.channel);
    expect(a.channel.length).toBeLessThanOrEqual(63);
  });

  test("reverse order and ASCII case variants resolve to one stored channel", () => {
    const direct = rooms.createDirectConversation("CaseAlice", "CaseBob", "CaseAlice");
    expect(rooms.directConversation("casebob", "CASEALICE")).toEqual({ channel: direct.channel, nick: "CASEALICE" });
    expect(rooms.directConversation("CASEALICE", "casebob")).toEqual({ channel: direct.channel, nick: "casebob" });
    expect(rooms.directChannelName("casebob", "casealice")).toBe(direct.channel);
    expect(rooms.createDirectConversation("CASEBOB", "casealice", "x").channel).toBe(direct.channel);
    expect(db.query("SELECT COUNT(*) AS n FROM direct_conversations WHERE first_nick = 'casealice'").get()).toEqual({ n: 1 });
  });

  test("a stored legacy mapping wins over the new generator", () => {
    db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick) VALUES ('#dm-legacy-pair', 'legacy-a', 'legacy-b')").run();
    db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES ('#dm-legacy-pair', 'legacy-a', 'direct', '', 1)").run();
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#dm-legacy-pair', 'legacy-a'), ('#dm-legacy-pair', 'legacy-b')").run();
    expect(rooms.directChannelName("Legacy-B", "legacy-a")).toBe("#dm-legacy-pair");
    expect(rooms.createDirectConversation("legacy-a", "legacy-b", "legacy-a")).toEqual({ channel: "#dm-legacy-pair", nick: "legacy-b" });
    expect(db.query("SELECT COUNT(*) AS n FROM direct_conversations WHERE channel = '#dm-legacy-pair'").get()).toEqual({ n: 1 });
  });

  test("a legacy row on the readable candidate pushes a new pair to its own hash", () => {
    db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick) VALUES ('#dm-alice-bob', 'oldx', 'oldy')").run();
    db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES ('#dm-alice-bob', 'oldx', 'direct', '', 1)").run();
    const direct = rooms.createDirectConversation("alice", "bob", "alice");
    expect(direct.channel).not.toBe("#dm-alice-bob");
    expect(direct.channel).toBe(hash56("alice", "bob"));
    // The legacy row and its history/membership are untouched.
    expect(db.query("SELECT first_nick, second_nick FROM direct_conversations WHERE channel = '#dm-alice-bob'").get()).toEqual({ first_nick: "oldx", second_nick: "oldy" });
    expect(db.query("SELECT COUNT(*) AS n FROM channel_members WHERE channel = '#dm-alice-bob'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT nick FROM channel_members WHERE channel = ? ORDER BY nick").all(direct.channel)).toEqual([{ nick: "alice" }, { nick: "bob" }]);
  });
});

describe("DM isolation: fail closed", () => {
  test("extra members on a legacy mapping refuse reuse without touching rows", () => {
    db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick) VALUES ('#dm-guard-a-guard-b', 'guard-a', 'guard-b')").run();
    db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES ('#dm-guard-a-guard-b', 'guard-a', 'direct', '', 1)").run();
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#dm-guard-a-guard-b', 'guard-a'), ('#dm-guard-a-guard-b', 'guard-b'), ('#dm-guard-a-guard-b', 'intruder')").run();
    const before = db.query("SELECT COUNT(*) AS n FROM channel_members").get();
    expect(() => rooms.directChannelName("guard-a", "guard-b")).toThrow(/intruder/);
    expect(() => rooms.directConversation("guard-a", "guard-b")).toThrow(/intruder/);
    expect(() => rooms.createDirectConversation("guard-a", "guard-b", "guard-a")).toThrow(/Repair:/);
    expect(db.query("SELECT COUNT(*) AS n FROM channel_members").get()).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS n FROM direct_conversations WHERE first_nick = 'guard-a'").get()).toEqual({ n: 1 });
  });

  test("a pre-existing channel at the hashed target fails before any membership write", () => {
    const channel = hash56("hash-a", "hash-b");
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, 'someone', 'secret', 1)").run(channel);
    const before = db.query("SELECT COUNT(*) AS n FROM channel_members").get();
    expect(() => rooms.directChannelName("hash-a", "hash-b")).toThrow(/already exists/);
    expect(() => rooms.createDirectConversation("hash-a", "hash-b", "hash-a")).toThrow(/already exists/);
    expect(db.query("SELECT COUNT(*) AS n FROM channel_members").get()).toEqual(before);
    expect(db.query("SELECT 1 FROM direct_conversations WHERE channel = ?").get(channel)).toBeNull();
  });

  test("never grafts a DM onto an existing workspace room with the readable name", () => {
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#dm-wsa-wsb', 'admin', 'workspace', 1)").run();
    const direct = rooms.createDirectConversation("wsa", "wsb", "wsa");
    expect(direct.channel).not.toBe("#dm-wsa-wsb");
    expect(db.query("SELECT visibility FROM channels WHERE channel = '#dm-wsa-wsb'").get()).toEqual({ visibility: "workspace" });
    expect(db.query("SELECT COUNT(*) AS n FROM channel_members WHERE channel = '#dm-wsa-wsb'").get()).toEqual({ n: 0 });
  });

  test("explicit deletion remains the escape hatch for a contaminated mapping", async () => {
    db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick) VALUES ('#dm-del-a-del-b', 'del-a', 'del-b')").run();
    db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES ('#dm-del-a-del-b', 'del-a', 'direct', '', 1)").run();
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#dm-del-a-del-b', 'del-a'), ('#dm-del-a-del-b', 'del-b'), ('#dm-del-a-del-b', 'intruder')").run();
    const unregistered: string[] = [];
    expect(await rooms.deleteDirectConversation("del-a", "del-b", async (channel) => { unregistered.push(channel); })).toBe(true);
    expect(unregistered).toEqual(["#dm-del-a-del-b"]);
    expect(db.query("SELECT 1 FROM direct_conversations WHERE channel = '#dm-del-a-del-b'").get()).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM channel_members WHERE channel = '#dm-del-a-del-b'").get()).toEqual({ n: 0 });
  });
});
