import { afterAll, expect, test } from "bun:test";

// Exercised through the REAL readPrivateChannelMode helper against a protocol peer, so the
// 324/403 parameter parsing (recipient, channel, modes) is covered. The transport tests mock this
// helper and therefore cannot catch a param-order or recipient-check bug.
process.env.ERGO_HOST = "127.0.0.1";
process.env.ERGO_OPER_USER = "slirc-org";
process.env.ERGO_OPER_PASS = "oper-pass";
process.env.OPER_PERSISTENT = "0";

const grants = await import("../src/grants.ts");

const modes: Record<string, string> = { "#secret": "+si", "#noinvite": "+s", "#public": "+R" };
let connections = 0;
let sawSajoin = false;

const server = Bun.listen<{ buffer: string; nick: string }>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(socket) { connections += 1; socket.data = { buffer: "", nick: "oper-test" }; },
    data(socket, data) {
      socket.data.buffer += data.toString();
      let end: number;
      while ((end = socket.data.buffer.indexOf("\r\n")) !== -1) {
        const line = socket.data.buffer.slice(0, end);
        socket.data.buffer = socket.data.buffer.slice(end + 2);
        const nick = socket.data.nick;
        if (line.startsWith("NICK ")) socket.data.nick = line.slice(5).trim();
        else if (line.startsWith("CAP LS")) socket.write(":test CAP * LS :sasl\r\n");
        else if (line.startsWith("CAP REQ")) socket.write(":test CAP * ACK :sasl\r\n");
        else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
        else if (line.startsWith("AUTHENTICATE ")) socket.write(":test 903 * :Authentication successful\r\n");
        else if (line === "CAP END") socket.write(`:test 001 ${nick} :Welcome\r\n`);
        else if (line.startsWith("OPER ")) socket.write(":test 381 slirc-org :You are now an IRC operator\r\n");
        else if (line.startsWith("SAJOIN")) sawSajoin = true;
        else if (line.startsWith("MODE ")) {
          const channel = line.slice(5).trim();
          if (channel === "#missing") socket.write(`:test 403 ${nick} #missing :No such channel\r\n`);
          else if (channel === "#wrongrecipient") socket.write(`:test 324 someone-else #wrongrecipient +si\r\n`);
          else if (modes[channel]) socket.write(`:test 324 ${nick} ${channel} ${modes[channel]}\r\n`);
          // Unknown channels get no reply: the helper must time out and fail closed.
        }
      }
    },
  },
});
process.env.ERGO_PORT = String(server.port);

afterAll(() => server.stop(true));

test("readPrivateChannelMode parses recipient/channel/modes and fails closed", async () => {
  expect(await grants.readPrivateChannelMode("#secret")).toEqual({ secret: true, inviteOnly: true });
  expect(await grants.readPrivateChannelMode("#public")).toEqual({ secret: false, inviteOnly: false });
  expect(await grants.readPrivateChannelMode("#noinvite")).toEqual({ secret: true, inviteOnly: false });
  expect(await grants.readPrivateChannelMode("#missing")).toBeNull();
  // A 324 addressed to another client must be ignored, then the probe times out.
  expect(await grants.readPrivateChannelMode("#wrongrecipient", 300)).toBeNull();
  // No SAJOIN is emitted by a read-only existence probe.
  expect(sawSajoin).toBe(false);
  // Each probe opened and closed its own bounded connection, so waiters do not accumulate.
  expect(connections).toBe(5);
  // A good probe still works after the timeout probe.
  expect(await grants.readPrivateChannelMode("#secret")).toEqual({ secret: true, inviteOnly: true });
  expect(connections).toBe(6);
});

test("readPrivateChannelMode rejects a malformed channel before connecting", async () => {
  const before = connections;
  expect(await grants.readPrivateChannelMode("no-channel")).toBeNull();
  expect(connections).toBe(before);
});
