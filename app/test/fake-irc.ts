// A fake Ergo for the helper and script tests. It answers the capability and SASL handshake, OPER,
// the MODE probe, JOIN, SAJOIN (refused without OPER, and always for #gone), one CHATHISTORY page
// from `history`, HistServ DELETE and REDACT. `lines` records every line a client sent.
const CAPS = "sasl message-tags batch draft/multiline account-tag server-time echo-message draft/chathistory draft/message-redaction draft/event-playback";
export function startFakeIrc(history: string[] = []) {
  const lines: string[] = [];
  const sockets = new Set<{ write(data: string): number }>();
  const server = Bun.listen<{ buffer: string; nick: string; oper: boolean }>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(socket) { socket.data = { buffer: "", nick: "", oper: false }; sockets.add(socket); },
      close(socket) { sockets.delete(socket); },
      data(socket, data) {
        socket.data.buffer += data.toString();
        let end: number;
        while ((end = socket.data.buffer.indexOf("\r\n")) !== -1) {
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          const nick = socket.data.nick;
          lines.push(line);
          if (line.startsWith("QUIT")) socket.end();
          else if (line === "CAP LS 302") socket.write(`:test CAP * LS :${CAPS}\r\n`);
          else if (line.startsWith("CAP REQ :")) socket.write(`:test CAP * ACK :${line.slice(9)}\r\n`);
          else if (line.startsWith("NICK ")) socket.data.nick = line.slice(5);
          else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
          else if (line.startsWith("AUTHENTICATE ")) socket.write(":test 903 * :Authentication successful\r\n");
          else if (line === "CAP END") socket.write(`:test 001 ${nick} :Welcome\r\n`);
          else if (line.startsWith("OPER ")) socket.data.oper = true, socket.write(`:test 381 ${nick} :You are now an IRC operator\r\n`);
          else if (line.startsWith("MODE #")) socket.write(`:test 324 ${nick} ${line.split(" ")[1]} +nt\r\n`);
          // Like Ergo: SAJOIN from a connection that never sent OPER is refused.
          else if (line.startsWith("SAJOIN ") && line.endsWith(" #gone")) socket.write(`:test 403 ${nick} #gone :No such channel\r\n`);
          else if (line.startsWith("SAJOIN ")) socket.write(socket.data.oper ? `:${nick}!u@h JOIN ${line.split(" ")[2]}\r\n` : `:test 481 ${nick} :Permission Denied - You're not an IRC operator\r\n`);
          else if (line.startsWith("JOIN ")) socket.write(`:${nick}!u@h JOIN ${line.split(" ")[1]}\r\n`);
          else if (line.startsWith("CHATHISTORY BEFORE ")) {
            const channel = line.split(" ")[2];
            const page = line.split(" ")[3] === "*" ? history : [];
            socket.write([`:test BATCH +h1 chathistory ${channel}`, ...page.map((item) => `@batch=h1;${item.slice(1)}`), ":test BATCH -h1"].join("\r\n") + "\r\n");
          } else if (line.startsWith("PRIVMSG HistServ :DELETE ")) {
            socket.write(`:HistServ!HistServ@localhost NOTICE ${nick} :Successfully deleted message ${line.split(" ").at(-1)}\r\n`);
          } else if (line.startsWith("REDACT ")) {
            const [, channel, msgid] = line.split(" ");
            socket.write(`@msgid=rd;account=slirc-org :${nick}!u@h REDACT ${channel} ${msgid}\r\n`);
          }
        }
      },
    },
  });
  return { port: server.port, lines, push: (line: string) => { for (const socket of sockets) socket.write(line + "\r\n"); }, close: () => server.stop(true) };
}
