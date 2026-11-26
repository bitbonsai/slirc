import "./fixture.ts";

process.env.APP_HOST = "app.slirc.org";

import { describe, expect, test } from "bun:test";

const rooms = await import("../src/rooms.ts");

describe("membership", () => {
  test("open channels are open to every account", () => {
    expect(rooms.isMember("anyone", "#help")).toBe(true);
    expect(rooms.isMember("anyone", "#untitled")).toBe(false);
  });

  test("memberChannels includes open channels", () => {
    expect(rooms.memberChannels("brand-new")).toContain("#help");
  });

  test("workspace channels are discoverable and joinable without exposing secret channels", async () => {
    const { db } = await import("../src/db.ts");
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#garden', 'alice', 'workspace', 1), ('#vault', 'alice', 'secret', 1)").run();
    expect(rooms.visibleChannels("bob").map((item) => item.channel)).toEqual(["#garden"]);
    expect(rooms.joinWorkspaceChannel("bob", "#garden")).toBe(true);
    expect(rooms.memberChannels("bob")).toContain("#garden");
    expect(rooms.joinWorkspaceChannel("bob", "#vault")).toBe(false);
    expect(rooms.leaveChannel("alice", "#garden")).toBe(false);
    expect(rooms.leaveChannel("bob", "#garden")).toBe(true);
    expect(rooms.memberChannels("bob")).not.toContain("#garden");
  });
});

describe("direct conversations", () => {
  test("maps a pair to one private channel and keeps it out of contacts", async () => {
    const { db } = await import("../src/db.ts");
    db.query(`INSERT INTO accounts (nick, email, verified_at, created_at) VALUES
              ('testuser-alpha', 'alpha@example.com', 1, 1), ('testuser-beta', 'beta@example.com', 1, 1)`).run();
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#test-shared', 'testuser-alpha', 'secret', 1)").run();
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#test-shared', 'testuser-alpha'), ('#test-shared', 'testuser-beta')").run();
    expect(rooms.sharedContacts("testuser-alpha")).toEqual(["testuser-beta"]);
    const direct = rooms.createDirectConversation("testuser-alpha", "testuser-beta", "testuser-alpha");
    // Both nicks carry the delimiter, so the pair goes to the hashed namespace.
    expect(direct.channel).toMatch(/^#dm-[0-9a-f]{56}$/);
    expect(rooms.directConversation("testuser-beta", "testuser-alpha")).toEqual({ channel: direct.channel, nick: "testuser-alpha" });
    expect(rooms.directConversations("testuser-alpha")).toEqual([{ channel: direct.channel, nick: "testuser-beta" }]);
    expect(rooms.visibleChannels("testuser-alpha").map((item) => item.channel)).not.toContain(direct.channel);
    db.query("DELETE FROM accounts WHERE nick = 'testuser-beta'").run();
    expect(rooms.directConversations("testuser-alpha")).toEqual([]);
  });

  test("short pairs stay readable; long pairs hash instead of truncating, so they never collide", () => {
    expect(rooms.directChannelName("Bob", "alice")).toBe("#dm-alice-bob");
    // Truncating `#dm-<first>-<second>` to 63 characters would give these two pairs one channel.
    const base = "a".repeat(30);
    const one = rooms.directChannelName(`${base}x1`, `${base}y1`);
    const two = rooms.directChannelName(`${base}x1`, `${base}y2`);
    expect(`#dm-${base}x1-${base}y1`.slice(0, 63)).toBe(`#dm-${base}x1-${base}y2`.slice(0, 63));
    expect(one).not.toBe(two);
    expect(one).toMatch(/^#dm-[0-9a-f]{56}$/);
    expect(one.length).toBeLessThanOrEqual(63);
    expect(rooms.directChannelName(`${base}y1`, `${base}x1`)).toBe(one);
  });

  test("close state is account-scoped, survives reload, and reopening preserves pair and channel", async () => {
    const { db } = await import("../src/db.ts");
    db.query(`INSERT INTO accounts (nick, email, verified_at, created_at) VALUES
              ('close-alpha', 'close-alpha@example.com', 1, 1), ('close-beta', 'close-beta@example.com', 1, 1)`).run();
    const alpha = db.query("SELECT account_id FROM accounts WHERE nick = 'close-alpha'").get() as { account_id: string };
    const beta = db.query("SELECT account_id FROM accounts WHERE nick = 'close-beta'").get() as { account_id: string };
    const direct = rooms.createDirectConversation("close-alpha", "close-beta", "close-alpha");

    expect(rooms.closeDirectConversation(alpha.account_id, "close-alpha", "close-beta")).toBe(true);
    expect(rooms.directConversations("close-alpha")).toEqual([]);
    // A fresh auth/list read on another device uses same server-persisted account state.
    expect(rooms.directConversations("close-beta")).toEqual([{ channel: direct.channel, nick: "close-alpha" }]);
    expect(db.query("SELECT channel FROM direct_conversations WHERE channel = ?").get(direct.channel)).toBeTruthy();
    expect(db.query("SELECT channel FROM channels WHERE channel = ?").get(direct.channel)).toBeTruthy();

    rooms.reopenDirectConversation(alpha.account_id, direct.channel);
    expect(rooms.directConversations("close-alpha")).toEqual([{ channel: direct.channel, nick: "close-beta" }]);
    expect(rooms.directConversations("close-beta")).toEqual([{ channel: direct.channel, nick: "close-alpha" }]);
    expect(db.query("SELECT account_id FROM accounts WHERE nick = 'close-beta'").get()).toEqual(beta);
  });

  test("a DM peer stays a contact after closing, and a new message reopens the DM for both", async () => {
    const { db } = await import("../src/db.ts");
    db.query(`INSERT INTO accounts (nick, email, verified_at, created_at) VALUES
              ('reopen-alpha', 'reopen-alpha@example.com', 1, 1), ('reopen-beta', 'reopen-beta@example.com', 1, 1)`).run();
    const alpha = db.query("SELECT account_id FROM accounts WHERE nick = 'reopen-alpha'").get() as { account_id: string };
    const beta = db.query("SELECT account_id FROM accounts WHERE nick = 'reopen-beta'").get() as { account_id: string };
    const direct = rooms.createDirectConversation("reopen-beta", "reopen-alpha", "reopen-beta");
    expect(rooms.sharedContacts("reopen-alpha")).toContain("reopen-beta");
    expect(rooms.sharedContacts("reopen-beta")).toContain("reopen-alpha");

    rooms.closeDirectConversation(alpha.account_id, "reopen-alpha", "reopen-beta");
    rooms.closeDirectConversation(beta.account_id, "reopen-beta", "reopen-alpha");
    expect(rooms.directConversations("reopen-alpha")).toEqual([]);
    expect(rooms.sharedContacts("reopen-alpha")).toContain("reopen-beta");

    expect(rooms.reopenDirectOnMessage(direct.channel.toUpperCase()).sort()).toEqual(["reopen-alpha", "reopen-beta"]);
    expect(rooms.directConversations("reopen-alpha")).toEqual([{ channel: direct.channel, nick: "reopen-beta" }]);
    expect(rooms.directConversations("reopen-beta")).toEqual([{ channel: direct.channel, nick: "reopen-alpha" }]);
    // Rooms and unknown DM names are not pairs and change nothing.
    expect(rooms.reopenDirectOnMessage("#help")).toEqual([]);
    expect(rooms.reopenDirectOnMessage("#dm-nobody")).toEqual([]);
  });

  test("unregisters a direct channel before deleting local records", async () => {
    const { db } = await import("../src/db.ts");
    const direct = rooms.createDirectConversation("delete-alpha", "delete-beta", "delete-alpha");
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#t-direct1', 'delete-alpha', 'secret', 1)").run();
    db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-direct1', ?, 'root', 'DM thread', 'https://example.test/dm', 'delete-alpha', 1, 1)").run(direct.channel);
    const unregistered: string[] = [];

    expect(await rooms.deleteDirectConversation("delete-alpha", "delete-beta", async (channel) => { unregistered.push(channel); })).toBe(true);
    expect(unregistered).toEqual(["#t-direct1", direct.channel]);
    expect(rooms.directConversation("delete-alpha", "delete-beta")).toBeNull();
    expect(db.query("SELECT 1 FROM channels WHERE channel = ?").get(direct.channel)).toBeNull();
    expect(db.query("SELECT 1 FROM channel_members WHERE channel = ?").get(direct.channel)).toBeNull();
  });

  test("clears each DM channel before unregistering it and never touches another pair", async () => {
    const { db } = await import("../src/db.ts");
    const direct = rooms.createDirectConversation("purge-alpha", "purge-beta", "purge-alpha");
    const other = rooms.createDirectConversation("purge-gamma", "purge-delta", "purge-gamma");
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#t-purge1', 'purge-alpha', 'secret', 1)").run();
    db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-purge1', ?, 'root', 'DM thread', 'https://example.test/dm', 'purge-alpha', 1, 1)").run(direct.channel);
    const order: string[] = [];

    await rooms.deleteDirectConversation("purge-alpha", "purge-beta",
      async (channel) => { order.push(`unregister ${channel}`); },
      async (channel) => { order.push(`clear ${channel}`); });

    expect(order).toEqual([
      "clear #t-purge1", "unregister #t-purge1",
      `clear ${direct.channel}`, `unregister ${direct.channel}`,
    ]);
    expect(order.some((line) => line.includes(other.channel))).toBe(false);
  });

  test("a throwing history clear cannot block unregistering the DM", async () => {
    const { db } = await import("../src/db.ts");
    const direct = rooms.createDirectConversation("throw-alpha", "throw-beta", "throw-alpha");
    const unregistered: string[] = [];

    await rooms.deleteDirectConversation("throw-alpha", "throw-beta",
      async (channel) => { unregistered.push(channel); },
      async () => { throw new Error("purge exploded"); });

    expect(unregistered).toEqual([direct.channel]);
    expect(rooms.directConversation("throw-alpha", "throw-beta")).toBeNull();
    expect(db.query("SELECT 1 FROM channels WHERE channel = ?").get(direct.channel)).toBeNull();
  });
});

describe("channel deletion", () => {
  test("unregisters child threads before their parent", async () => {
    const { db } = await import("../src/db.ts");
    db.query(`INSERT INTO channels (channel, owner, visibility, created_at) VALUES
              ('#delete-parent', 'delete-owner', 'secret', 1),
              ('#t-delete1', 'delete-owner', 'secret', 1),
              ('#t-delete2', 'delete-owner', 'secret', 1)`).run();
    db.query(`INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES
              ('#t-delete1', '#delete-parent', 'root-1', 'First', 'https://example.test/1', 'delete-owner', 1, 1),
              ('#t-delete2', '#delete-parent', 'root-2', 'Second', 'https://example.test/2', 'delete-owner', 1, 2)`).run();
    const unregistered: string[] = [];

    await rooms.deleteChannelTree("#delete-parent", async (channel) => { unregistered.push(channel); });

    expect(unregistered).toEqual(["#t-delete2", "#t-delete1", "#delete-parent"]);
    expect(rooms.threadsOf("#delete-parent")).toEqual([]);
    expect(db.query("SELECT 1 FROM channels WHERE channel IN ('#delete-parent', '#t-delete1', '#t-delete2')").get()).toBeNull();
  });

  test("clears every channel and child thread before it unregisters", async () => {
    const { db } = await import("../src/db.ts");
    db.query(`INSERT INTO channels (channel, owner, visibility, created_at) VALUES
              ('#purge-parent', 'purge-owner', 'secret', 1),
              ('#t-purge01', 'purge-owner', 'secret', 1),
              ('#t-purge02', 'purge-owner', 'secret', 1)`).run();
    db.query(`INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES
              ('#t-purge01', '#purge-parent', 'root-1', 'First', 'https://example.test/1', 'purge-owner', 1, 1),
              ('#t-purge02', '#purge-parent', 'root-2', 'Second', 'https://example.test/2', 'purge-owner', 1, 2)`).run();
    const order: string[] = [];

    await rooms.deleteChannelTree("#purge-parent",
      async (channel) => { order.push(`unregister ${channel}`); },
      async (channel) => { order.push(`clear ${channel}`); });

    expect(order).toEqual([
      "clear #t-purge02", "unregister #t-purge02",
      "clear #t-purge01", "unregister #t-purge01",
      "clear #purge-parent", "unregister #purge-parent",
    ]);
  });
});

describe("magic-link next validation", () => {
  test("accepts same-origin paths only", () => {
    expect(rooms.isValidNext("/join/abc-123")).toBe(true);
    expect(rooms.isValidNext("/")).toBe(true);
    expect(rooms.isValidNext("//evil.example")).toBe(false);
    expect(rooms.isValidNext("https://evil.example")).toBe(false);
    expect(rooms.isValidNext("")).toBe(false);
    expect(rooms.isValidNext(undefined)).toBe(false);
  });
});

describe("thread visibility under an open parent", () => {
  // A public parent must not promote a private/DM/legacy child to public. ThreadsFor/threadsOf(nick)
  // must require an explicit child grant.
  test("workspace child stays visible to parent members", async () => {
    const { db } = await import("../src/db.ts");
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#open-chat', 'owner', 'workspace', 1), ('#t-open1', 'owner', 'workspace', 1)").run();
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#open-chat', 'reader')").run();
    db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-open1', '#open-chat', 'root', 'Public thread', 'https://example.test/1', 'owner', 1, 1)").run();
    expect(rooms.threadsOf("#open-chat", "reader").map((t) => t.channel)).toEqual(["#t-open1"]);
    expect(rooms.threadsFor("reader").map((t) => t.channel)).toEqual(["#t-open1"]);
  });

  test("secret child under open parent needs explicit child membership", async () => {
    const { db } = await import("../src/db.ts");
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#help', 'owner', 'workspace', 1), ('#t-help-private', 'owner', 'secret', 1)").run();
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#help', 'reader'), ('#t-help-private', 'owner')").run();
    db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-help-private', '#help', 'root', 'Private', 'https://example.test/2', 'owner', 1, 1)").run();
    // Open parent alone does not promote the secret child.
    expect(rooms.threadsFor("reader").map((t) => t.channel)).not.toContain("#t-help-private");
    expect(rooms.threadsOf("#help", "reader").map((t) => t.channel)).not.toContain("#t-help-private");
    // Granting the child surfaces it.
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#t-help-private', 'reader')").run();
    expect(rooms.threadsFor("reader").map((t) => t.channel)).toContain("#t-help-private");
    expect(rooms.threadsOf("#help", "reader").map((t) => t.channel)).toContain("#t-help-private");
  });

  test("direct child under open parent stays private to its pair", async () => {
    const { db } = await import("../src/db.ts");
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#support', 'owner', 'workspace', 1), ('#t-dm-child', 'alice', 'direct', 1)").run();
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#support', 'alice'), ('#support', 'eve'), ('#t-dm-child', 'alice'), ('#t-dm-child', 'bob')").run();
    db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-dm-child', '#support', 'root', 'DM in public room', 'https://example.test/3', 'alice', 1, 1)").run();
    // alice and bob are DM pair members; eve is in the parent only.
    expect(rooms.threadsFor("alice").map((t) => t.channel)).toContain("#t-dm-child");
    expect(rooms.threadsFor("bob").map((t) => t.channel)).toContain("#t-dm-child");
    expect(rooms.threadsFor("eve").map((t) => t.channel)).not.toContain("#t-dm-child");
    expect(rooms.threadsOf("#support", "eve").map((t) => t.channel)).not.toContain("#t-dm-child");
  });

  test("legacy child with no channels row fails closed under open parent", async () => {
    const { db } = await import("../src/db.ts");
    db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#legacy-room', 'owner', 'workspace', 1)").run();
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#legacy-room', 'reader')").run();
    db.query("INSERT INTO threads (channel, parent, root, title, url, created_by, created_at, last_activity) VALUES ('#t-legacy1', '#legacy-room', 'root', 'Legacy', 'https://example.test/4', 'owner', 1, 1)").run();
    // No `channels` row for #t-legacy1 (legacy association): parent visibility alone must not promote it.
    expect(rooms.threadsFor("reader").map((t) => t.channel)).not.toContain("#t-legacy1");
    expect(rooms.threadsOf("#legacy-room", "reader").map((t) => t.channel)).not.toContain("#t-legacy1");
    // Granting the child channel (the way the IRC relay eventually does) surfaces it.
    db.query("INSERT INTO channel_members (channel, nick) VALUES ('#t-legacy1', 'reader')").run();
    expect(rooms.threadsOf("#legacy-room", "reader").map((t) => t.channel)).toContain("#t-legacy1");
  });
});