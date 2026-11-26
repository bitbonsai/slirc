import { expect, test } from "bun:test";
import { IrcClient } from "../../src/irc.ts";

test("requests agent capabilities once after complete CAP listing", async () => {
  const lines: string[] = [];
  let nick = "";
  const server = Bun.listen<{ buffer: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, data) {
        socket.data.buffer += data.toString();
        let end: number;
        while ((end = socket.data.buffer.indexOf("\r\n")) !== -1) {
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          lines.push(line);
          if (line === "CAP LS 302") socket.write(":test CAP * LS * :sasl batch server-time\r\n:test CAP * LS :message-tags account-tag draft/chathistory draft/multiline\r\n");
          else if (line.startsWith("NICK ")) nick = line.slice(5);
          else if (line.startsWith("CAP REQ ")) socket.write(`:test CAP * ACK :${line.slice(9)}\r\n`);
          else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
          else if (line.startsWith("AUTHENTICATE ")) socket.write(":test 903 * :Authentication successful\r\n");
          else if (line === "CAP END") socket.write(`:test 001 ${nick} :Welcome\r\n`);
        }
      },
    },
  });
  const capabilities = ["server-time", "message-tags", "account-tag", "batch", "draft/chathistory", "draft/multiline"];
  const client = new IrcClient({ host: "127.0.0.1", port: server.port, nick: "agent-bitbonsai", saslUser: "agent-bitbonsai", saslPass: "test-password", capabilities });
  try {
    await client.connect();
    expect(lines.filter((line) => line.startsWith("CAP REQ "))).toEqual([`CAP REQ :sasl ${capabilities.join(" ")}`]);
    expect(client.enabledCapabilities).toEqual(new Set(["sasl", ...capabilities]));
  } finally {
    client.quit();
    server.stop(true);
  }
});
