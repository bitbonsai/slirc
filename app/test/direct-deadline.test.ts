import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as net from "node:net";

const realConnect = net.connect;
let stalledSocket: net.Socket | undefined;
mock.module("node:net", () => ({
  ...net,
  connect: (...args: Parameters<typeof net.connect>) => stalledSocket ?? realConnect(...args),
}));
process.env.ERGO_HOST = "127.0.0.1";
process.env.ERGO_OPER_USER = "slirc-org";
process.env.ERGO_OPER_PASS = "test-only";
const { readDirectChannelReady } = await import("../src/grants.ts");
const { IrcClient } = await import("../src/irc.ts");

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
afterEach(() => { stalledSocket = undefined; mock.restore(); });

function trackTimers() {
  const active = new Set<ReturnType<typeof setTimeout>>();
  spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const timer = realSetTimeout(() => { active.delete(timer); callback(...args); }, ms);
    active.add(timer);
    return timer;
  }) as typeof setTimeout);
  spyOn(globalThis, "clearTimeout").mockImplementation(((timer: ReturnType<typeof setTimeout>) => {
    active.delete(timer);
    realClearTimeout(timer);
  }) as typeof clearTimeout);
  return active;
}

function fakeErgo(stall = "", capDelay = 0) {
  const sockets = new Set<net.Socket>();
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "", nick = "";
    socket.on("data", (data) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        lines.push(line);
        if (stall && line.startsWith(stall)) continue;
        const send = (reply: string) => socket.write(`${reply}\r\n`);
        if (line.startsWith("NICK ")) nick = line.slice(5);
        else if (line === "CAP LS 302") {
          if (capDelay) realSetTimeout(() => send(":test CAP * LS :sasl"), capDelay);
          else send(":test CAP * LS :sasl");
        } else if (line === "CAP REQ :sasl") send(":test CAP * ACK :sasl");
        else if (line === "AUTHENTICATE PLAIN") send("AUTHENTICATE +");
        else if (line.startsWith("AUTHENTICATE ")) send(":test 903 * :ok");
        else if (line === "CAP END") send(`:test 001 ${nick} :welcome`);
        else if (line.startsWith("OPER ")) send(`:test 381 ${nick} :oper`);
        else if (line === "MODE #dm-a-b") send(`:test 324 ${nick} #dm-a-b :+nsi`);
        else if (line === "SAMODE #dm-a-b +I") {
          send(`:test 346 ${nick} #dm-a-b a!*@* oper 1`);
          send(`:test 346 ${nick} #dm-a-b b!*@* oper 1`);
          send(`:test 347 ${nick} #dm-a-b :End`);
        } else if (line === "PRIVMSG ChanServ :INFO #dm-a-b") {
          send(`:ChanServ!service@test NOTICE ${nick} :Channel #dm-a-b is registered`);
          send(`:ChanServ!service@test NOTICE ${nick} :Founder: a`);
        } else if (line === "WHO #dm-a-b %tna,152") send(`:test 315 ${nick} #dm-a-b :End of WHO list`);
        else if (line.startsWith("PING ")) send(`:test PONG test :${line.slice(5)}`);
      }
    });
  });
  return {
    sockets, lines,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as net.AddressInfo).port;
      process.env.ERGO_PORT = String(port);
      return port;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("a TCP connect that never opens is destroyed within the proof budget", async () => {
  stalledSocket = new net.Socket();
  const timers = trackTimers();
  const start = performance.now();
  expect(await readDirectChannelReady("#dm-a-b", ["a", "b"], 100)).toBe(false);
  expect(performance.now() - start).toBeLessThan(500);
  expect(stalledSocket.destroyed).toBe(true);
  expect(timers.size).toBe(0);
});

for (const stage of ["CAP LS", "CAP REQ", "AUTHENTICATE PLAIN", "AUTHENTICATE AH", "CAP END", "OPER ", "PING "]) {
  test(`stalled ${stage} closes the connection and clears deadline timers`, async () => {
    const ergo = fakeErgo(stage);
    await ergo.start();
    const timers = trackTimers();
    try {
      const start = performance.now();
      expect(await readDirectChannelReady("#dm-a-b", ["a", "b"], 100)).toBe(false);
      expect(performance.now() - start).toBeLessThan(500);
      await new Promise((resolve) => realSetTimeout(resolve, 20));
      expect(ergo.sockets.size).toBe(0);
      expect(timers.size).toBe(0);
    } finally { await ergo.stop(); }
  });
}

test("the proof does not get a new budget after a slow handshake", async () => {
  const ergo = fakeErgo("PING ", 200);
  await ergo.start();
  const timers = trackTimers();
  try {
    const start = performance.now();
    expect(await readDirectChannelReady("#dm-a-b", ["a", "b"], 300)).toBe(false);
    expect(performance.now() - start).toBeLessThan(450);
    expect(ergo.lines.some((line) => line.startsWith("PING "))).toBe(true);
    expect(timers.size).toBe(0);
  } finally { await ergo.stop(); }
});

test("successful proof clears all deadline timers and closes its socket", async () => {
  const ergo = fakeErgo();
  await ergo.start();
  const timers = trackTimers();
  try {
    expect(await readDirectChannelReady("#dm-a-b", ["a", "b"], 500)).toBe(true);
    await new Promise((resolve) => realSetTimeout(resolve, 20));
    expect(ergo.sockets.size).toBe(0);
    expect(timers.size).toBe(0);
  } finally { await ergo.stop(); }
});

test("a stalled TLS handshake is cancelled before any IRC exchange", async () => {
  const ergo = fakeErgo();
  const port = await ergo.start();
  const timers = trackTimers();
  const client = new IrcClient({ host: "localhost", port, nick: "deadline", tls: true, tlsInsecure: true });
  try {
    await expect(client.connect(100)).rejects.toThrow("timed out");
    await new Promise((resolve) => realSetTimeout(resolve, 20));
    expect(ergo.sockets.size).toBe(0);
    expect(timers.size).toBe(0);
    expect(client.send("PING late")).toBe(false);
  } finally { client.disconnect(); await ergo.stop(); }
});
