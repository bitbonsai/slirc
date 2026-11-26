// Multi-instance Starred migration, deduplication, MultiInstanceStore, and RemoteInstanceClient.
import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { conversationId } from "../client/model.ts";
import type {
  RemoteInstanceSocket,
  StarredEntry,
  StorageLike,
} from "../client/multi-instance.ts";

// Dexie captures its IndexedDB globals at module-eval time; load it only after fake-indexeddb/auto.
const {
  MultiInstanceStore,
  parseStarredEntries,
  RemoteInstanceManager,
} = await import("../client/multi-instance.ts");

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

class MockSocket implements RemoteInstanceSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(line: string): void {
    this.onmessage?.({ data: `${line}\r\n` });
  }

  send(data: string): void {
    this.sent.push(data.replace(/\r?\n$/, ""));
  }

  close(): void {
    this.readyState = 3;
    this.closed = true;
    this.onclose?.({});
  }
}

describe("parseStarredEntries and legacy migration", () => {
  test("migrates legacy string[] conversationIds scoped to defaultOrigin", () => {
    const roomId = conversationId("room", "#general");
    const dmId = conversationId("dm", "acct-ada");
    const raw = JSON.stringify([roomId, dmId, roomId]); // includes duplicate

    const entries = parseStarredEntries(raw, "https://app.slirc.org", (id) => {
      if (id === dmId) return { kind: "dm", wireTarget: "#dm-ada-ben", label: "ada", nick: "ada" };
      return null;
    });

    expect(entries).toEqual([
      {
        origin: "https://app.slirc.org",
        conversationId: roomId,
        kind: "room",
        wireTarget: "#general",
        label: "general",
      },
      {
        origin: "https://app.slirc.org",
        conversationId: dmId,
        kind: "dm",
        wireTarget: "#dm-ada-ben",
        label: "ada",
        nick: "ada",
      },
    ]);
  });

  test("handles malformed storage values safely", () => {
    expect(parseStarredEntries(null, "https://app.slirc.org")).toEqual([]);
    expect(parseStarredEntries("{bad json", "https://app.slirc.org")).toEqual([]);
    expect(parseStarredEntries(JSON.stringify([{ origin: "ftp://bad", conversationId: "x", kind: "room" }]), "https://app.slirc.org")).toEqual([]);
  });
});

describe("MultiInstanceStore", () => {
  test("adds, deduplicates, toggles, and removes starred items across multiple origins", () => {
    const generalId = conversationId("room", "#general");
    const opsId = conversationId("room", "#ops");
    const storage = memoryStorage({
      "slirc2-starred:acct-1": JSON.stringify([generalId]),
    });
    const store = new MultiInstanceStore("acct-1", "https://app.slirc.org", storage);

    // Migrates legacy string[] on read.
    expect(store.getStarred()).toEqual([
      {
        origin: "https://app.slirc.org",
        conversationId: generalId,
        kind: "room",
        wireTarget: "#general",
        label: "general",
      },
    ]);

    // Same conversationId on a SECOND origin is distinct and preserved.
    const remoteGeneral: StarredEntry = {
      origin: "https://team.slirc.app/", // trailing slash normalized
      conversationId: generalId,
      kind: "room",
      wireTarget: "#general",
      label: "general",
    };
    const remoteOps: StarredEntry = {
      origin: "https://team.slirc.app",
      conversationId: opsId,
      kind: "room",
      wireTarget: "#ops",
      label: "ops",
    };

    store.addStarred(remoteGeneral);
    store.addStarred(remoteOps);
    // Re-adding the same (origin, conversationId) deduplicates instead of duplicating.
    store.addStarred({ ...remoteGeneral, label: "General (Team)" });

    const all = store.getStarred();
    expect(all).toHaveLength(3);
    expect(all[0]?.origin).toBe("https://app.slirc.org");
    expect(all[1]).toEqual({
      origin: "https://team.slirc.app",
      conversationId: generalId,
      kind: "room",
      wireTarget: "#general",
      label: "General (Team)",
    });
    expect(all[2]?.wireTarget).toBe("#ops");

    // Removing from one origin leaves the other origin's identical conversationId intact.
    store.removeStarred("https://team.slirc.app", generalId);
    expect(store.hasStarred("https://app.slirc.org", generalId)).toBe(true);
    expect(store.hasStarred("https://team.slirc.app", generalId)).toBe(false);
    expect(store.hasStarred("https://team.slirc.app", opsId)).toBe(true);

    // Toggle removes when present, adds when absent.
    const off = store.toggleStarred(remoteOps);
    expect(off.starred).toBe(false);
    expect(store.hasStarred("https://team.slirc.app", opsId)).toBe(false);
    const on = store.toggleStarred(remoteOps);
    expect(on.starred).toBe(true);
    expect(store.hasStarred("https://team.slirc.app", opsId)).toBe(true);
  });

  test("stores, retrieves, lists, and removes per-origin bearer tokens", () => {
    const storage = memoryStorage();
    const store = new MultiInstanceStore("acct-1", "https://app.slirc.org", storage);

    store.setToken("https://team.slirc.app/", "tok-team");
    store.setToken("https://lab.slirc.app", "tok-lab");
    expect(store.getToken("https://team.slirc.app")).toBe("tok-team");
    expect(store.getToken("https://lab.slirc.app")).toBe("tok-lab");
    expect(store.listOrigins()).toEqual(["https://team.slirc.app", "https://lab.slirc.app"]);

    store.removeToken("https://team.slirc.app");
    expect(store.getToken("https://team.slirc.app")).toBeNull();
    expect(store.listOrigins()).toEqual(["https://lab.slirc.app"]);

    store.clearTokens();
    expect(store.listOrigins()).toEqual([]);
  });
});

describe("RemoteInstanceClient and RemoteInstanceManager", () => {
  test("connects to remote /auth/me + WebSocket with bearer token, syncs history, and sends messages in its own origin-scoped DB", async () => {
    const remoteOrigin = "https://team.slirc.app";
    const remoteRoomId = conversationId("room", "#ops");
    let fetchHeaders: HeadersInit | undefined;
    let fetchCredentials: RequestCredentials | undefined;
    let fetchRedirect: RequestRedirect | undefined;
    let wsUrl = "";
    let wsProtocols: string | string[] | undefined;
    const socket = new MockSocket();

    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchHeaders = init?.headers;
      fetchCredentials = init?.credentials;
      fetchRedirect = init?.redirect;
      return new Response(
        JSON.stringify({
          authenticated: true,
          accountId: "remote-acct-1",
          nick: "ada",
          channels: ["#ops"],
          directs: [],
          accountDetails: [{ id: "remote-acct-1", nick: "ada" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const storage = memoryStorage();
    const store = new MultiInstanceStore("primary-acct", "https://app.slirc.org", storage);
    store.setToken(remoteOrigin, "bearer-xyz");

    const manager = new RemoteInstanceManager(store, {
      fetch: mockFetch,
      createWebSocket: (url, protocols) => {
        wsUrl = url;
        wsProtocols = protocols;
        return socket;
      },
      namesProbeMs: 0,
    });

    const { client, access } = await manager.openConversation(remoteOrigin, remoteRoomId);
    expect(access?.ok).toBe(true);
    expect(fetchCredentials).toBe("omit");
    expect(fetchRedirect).toBe("error");
    expect((fetchHeaders as Record<string, string>)?.Authorization).toBe("Bearer bearer-xyz");
    expect(wsUrl).toBe("wss://team.slirc.app/irc");
    expect(wsProtocols).toEqual(["slirc-token.bearer-xyz"]);
    expect(client.db?.scope.instance).toBe(remoteOrigin);
    expect(client.db?.scope.accountId).toBe("remote-acct-1");
    expect(manager.activeTarget).toEqual({ origin: remoteOrigin, conversationId: remoteRoomId });

    // Drive IRC handshake + room JOIN + empty CHATHISTORY batch.
    socket.open();
    socket.receive(":ergo CAP * LS :sasl echo-message batch server-time account-tag message-tags draft/chathistory draft/event-playback draft/multiline");
    socket.receive(":ergo CAP * ACK :sasl echo-message batch server-time account-tag message-tags draft/chathistory draft/event-playback draft/multiline");
    socket.receive("AUTHENTICATE +");
    socket.receive(":ergo 903 ada :SASL authentication successful");
    socket.receive(":ergo 001 ada :Welcome");
    expect(client.status).toBe("connected");

    socket.receive(":ada!u@h JOIN #ops");
    await new Promise((r) => setTimeout(r, 20));
    expect(socket.sent.some((line) => line.startsWith("CHATHISTORY LATEST #ops"))).toBe(true);
    socket.receive(":ergo BATCH +b1 chathistory #ops");
    socket.receive("@batch=b1;msgid=m1;time=2026-01-01T00:00:00.000Z;account=ben :ben!u@h PRIVMSG #ops :hello from remote");
    socket.receive(":ergo BATCH -b1");
    await new Promise((r) => setTimeout(r, 20));

    expect(client.isReady(remoteRoomId)).toBe(true);
    const messages = await client.getMessages(remoteRoomId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("hello from remote");

    // Send a message to the remote room.
    const op = await client.sendMessage(remoteRoomId, "reply from primary UI");
    expect(socket.sent.some((line) => line.includes(`+slirc/cid=${op.id}`) && line.includes("PRIVMSG #ops :reply from primary UI"))).toBe(true);

    const afterSend = await client.getMessages(remoteRoomId);
    expect(afterSend).toHaveLength(2);
    expect(afterSend[1]?.text).toBe("reply from primary UI");

    manager.disconnectAll();
    expect(socket.closed).toBe(true);
    expect(client.status).toBe("disconnected");
  });
});
