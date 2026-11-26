import { expect, test } from "bun:test";
import { IrcClient, parseLine, sanitizeLine } from "../src/irc.ts";

test("parseLine splits tag keys from values and unescapes IRCv3 values", () => {
  const m = parseLine("@batch=1;time=2026-09-12T20:39:29.873Z;bot;+draft/reply=a\\sb\\:c :nick!u@h PRIVMSG #room :hello");
  expect(m.tags).toEqual({ batch: "1", time: "2026-09-12T20:39:29.873Z", bot: "", "+draft/reply": "a b;c" });
  expect(m.prefix).toBe("nick!u@h");
  expect(m.command).toBe("PRIVMSG");
  expect(m.params).toEqual(["#room", "hello"]);
});

test("parseLine handles lines without tags or prefix", () => {
  expect(parseLine("PING :abc")).toEqual({ tags: {}, prefix: undefined, command: "PING", params: ["abc"] });
});

test("sanitizeLine folds CR, LF, and CRLF and drops NUL", () => {
  expect(sanitizeLine("TOPIC #x :hello\r\nSAMODE #x +o evil")).toBe("TOPIC #x :hello SAMODE #x +o evil");
  expect(sanitizeLine("KICK #x nick :a\nb\rc")).toBe("KICK #x nick :a b c");
  expect(sanitizeLine("PRIVMSG #x :a\0b")).toBe("PRIVMSG #x :ab");
  expect(sanitizeLine("\r\n")).toBe(" ");
});

test("sanitizeLine leaves escaped tags and trailing spaces untouched", () => {
  expect(sanitizeLine("@+draft/reply=a\\rb PRIVMSG #x :ok")).toBe("@+draft/reply=a\\rb PRIVMSG #x :ok");
  expect(sanitizeLine("PRIVMSG #x :trailing  ")).toBe("PRIVMSG #x :trailing  ");
});

// The slirc bot never authenticates, so this is the only path that can negotiate account-tag /
// message-tags. Without them Ergo strips the account and msgid tags and public-author evidence
// never records. Offered-but-unrequested capabilities (sasl here) must not be asked for.
test("IrcClient requests only offered capabilities when it does not authenticate", async () => {
  const seen: string[] = [];
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(sock, data) {
        for (const line of data.toString().split("\r\n").filter(Boolean)) {
          seen.push(line);
          if (line === "CAP LS 302") sock.write(":srv CAP * LS :account-tag message-tags\r\n");
          if (line === "CAP REQ :account-tag message-tags") sock.write(":srv CAP * ACK :account-tag message-tags\r\n");
          if (line === "CAP END") sock.write(":srv 001 n :welcome\r\n");
        }
      },
    },
  });
  const client = new IrcClient({ host: "127.0.0.1", port: server.port, nick: "n", capabilities: ["account-tag", "message-tags", "sasl"] });
  await client.connect();
  server.stop(true);
  expect(seen).toContain("CAP REQ :account-tag message-tags");
  expect(seen.some((line) => line.includes("sasl"))).toBe(false);
  expect([...client.enabledCapabilities].sort()).toEqual(["account-tag", "message-tags"]);
});

// The client's read path must decode incrementally: a per-chunk toString() turns a split emoji
// into U+FFFD. Feed two chunks split at every byte boundary and require exactly one clean message.
test("IrcClient decodes a UTF-8 line split at every byte offset", () => {
  const line = ":srv PRIVMSG #room :h\u00e9llo \u{1F600} \u{1F389}\r\n";
  const bytes = Buffer.from(line, "utf8");
  const feedAt = (client: IrcClient, a: Uint8Array, b: Uint8Array) => {
    const onData = (client as unknown as { onData: (chunk: Uint8Array) => void }).onData.bind(client);
    onData(a);
    onData(b);
  };
  for (let split = 0; split <= bytes.length; split++) {
    const seen: string[] = [];
    const client = new IrcClient({ host: "127.0.0.1", port: 1, nick: "n", onMessage: (m) => seen.push(m.params.at(-1) ?? "") });
    feedAt(client, bytes.subarray(0, split), bytes.subarray(split));
    expect(seen).toEqual(["h\u00e9llo \u{1F600} \u{1F389}"]);
  }
});

// Fragmented IRC frames: two lines in one payload, split at every offset (including between the
// two), must both surface, in order, exactly once.
test("IrcClient reassembles multiple fragmented frames in order", () => {
  const payload = ":srv PRIVMSG #room :one\r\n:srv PRIVMSG #room :two \u{1F600}\r\n";
  const bytes = Buffer.from(payload, "utf8");
  for (let split = 0; split <= bytes.length; split++) {
    const seen: string[] = [];
    const client = new IrcClient({ host: "127.0.0.1", port: 1, nick: "n", onMessage: (m) => seen.push(m.params.at(-1) ?? "") });
    const onData = (client as unknown as { onData: (chunk: Uint8Array) => void }).onData.bind(client);
    onData(bytes.subarray(0, split));
    onData(bytes.subarray(split));
    expect(seen).toEqual(["one", "two \u{1F600}"]);
  }
});
