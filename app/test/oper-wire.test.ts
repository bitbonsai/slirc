// SEC-02 behavioral proof: CR/LF/NUL in an interpolated oper field can never introduce a second
// IRC command at the socket. Every case drives the public IrcClient.send or the public grants
// topic/kick helpers over a real loopback TCP listener that plays a minimal Ergo handshake and
// records each line it receives (so the assertion is about bytes on the wire, not a helper's
// return value). Read grants.ts; it is not edited here.

import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "bun:test";
import { IrcClient } from "../src/irc.ts";

process.env.ERGO_OPER_USER = "slirc-org";
process.env.ERGO_OPER_PASS = "oper-wire-pass";
process.env.OPER_PERSISTENT = "0";

type FakeErgo = { port: number; lines: string[]; close: () => Promise<void> };

// Minimal Ergo: answers CAP/SASL/OPER so operClient() connects, and echoes PING so grants' flush
// round trip finishes. Only the line bytes matter to the test.
async function startFakeErgo(): Promise<FakeErgo> {
  const lines: string[] = [];
  const conns = new Set<{ destroy: () => void }>();
  const server = createServer((sock) => {
    conns.add(sock);
    sock.on("close", () => conns.delete(sock));
    let nick = "tester";
    let pending = "";
    sock.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const raw = pending.slice(0, nl).replace(/\r$/, "");
        pending = pending.slice(nl + 1);
        if (!raw) continue;
        lines.push(raw);
        const [command, first = ""] = raw.split(" ");
        if (command === "NICK") nick = first;
        else if (command === "CAP" && first === "LS") sock.write(":srv CAP * LS :sasl\r\n");
        else if (command === "CAP" && first === "REQ") sock.write(":srv CAP * ACK :sasl\r\n");
        else if (command === "CAP" && first === "END") sock.write(`:srv 001 ${nick} :welcome\r\n`);
        else if (command === "AUTHENTICATE" && first === "PLAIN") sock.write("AUTHENTICATE +\r\n");
        else if (command === "AUTHENTICATE") sock.write(`:srv 903 ${nick} :SASL success\r\n`);
        else if (command === "OPER") sock.write(`:srv 381 ${nick} :You are now an IRC operator\r\n`);
        else if (command === "PING") sock.write(`:srv PONG srv :${raw.slice(5)}\r\n`);
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    lines,
    close: () =>
      new Promise<void>((resolve) => {
        for (const sock of conns) sock.destroy();
        server.close(() => resolve());
      }),
  };
}

async function waitForLine(ergo: FakeErgo, needle: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ergo.lines.includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connectClient(ergo: FakeErgo): Promise<IrcClient> {
  const client = new IrcClient({ host: "127.0.0.1", port: ergo.port, nick: "wire-test", realname: "wire test" });
  await client.connect();
  return client;
}

describe("IrcClient.send over a real socket", () => {
  test("CR/LF and NUL in a field cannot add a second command", async () => {
    const ergo = await startFakeErgo();
    try {
      const client = await connectClient(ergo);
      expect(client.send("TOPIC #room :hello\r\nSAMODE #room +o attacker")).toBe(true);
      // NUL is dropped, so the bytes around it join: c + d.
      expect(client.send("KICK #room victim :a\nb\rc\0d")).toBe(true);
      await waitForLine(ergo, "KICK #room victim :a b cd");
      expect(ergo.lines).toContain("TOPIC #room :hello SAMODE #room +o attacker");
      expect(ergo.lines).toContain("KICK #room victim :a b cd");
      expect(ergo.lines.some((line) => line === "SAMODE #room +o attacker")).toBe(false);
      client.quit();
    } finally {
      await ergo.close();
    }
  });

  test("escaped tags and multiline batches survive unchanged", async () => {
    const ergo = await startFakeErgo();
    try {
      const client = await connectClient(ergo);
      const tagged = "@+draft/reply=a\\rb;time=2026-01-01T00:00:00.000Z PRIVMSG #room :ok";
      const expected = [tagged, "BATCH +abc draft/multiline #room", "@batch=abc PRIVMSG #room :first", "BATCH -abc"];
      for (const line of expected) client.send(line);
      client.send("PRIVMSG #room :trailing  ");
      await waitForLine(ergo, "PRIVMSG #room :trailing  ");
      for (const line of expected) expect(ergo.lines).toContain(line);
    } finally {
      await ergo.close();
    }
  });

  test("a whitespace-only line is refused instead of written", async () => {
    const ergo = await startFakeErgo();
    try {
      const client = await connectClient(ergo);
      const before = ergo.lines.length;
      expect(client.send("")).toBe(false);
      expect(client.send("\r\n")).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ergo.lines.length).toBe(before);
    } finally {
      await ergo.close();
    }
  });
});

describe("grants oper writes over a real socket", () => {
  test("a topic with CRLF cannot smuggle a SAMODE", async () => {
    const ergo = await startFakeErgo();
    process.env.ERGO_HOST = "127.0.0.1";
    process.env.ERGO_PORT = String(ergo.port);
    try {
      const { setChannelTopic } = await import("../src/grants.ts");
      await setChannelTopic("#room", "hello\r\nSAMODE #room +o attacker");
      expect(ergo.lines).toContain("TOPIC #room :hello SAMODE #room +o attacker");
      expect(ergo.lines).not.toContain("SAMODE #room +o attacker");
    } finally {
      await ergo.close();
    }
  });

  test("a kick reason with CRLF cannot smuggle an OPER", async () => {
    const ergo = await startFakeErgo();
    process.env.ERGO_HOST = "127.0.0.1";
    process.env.ERGO_PORT = String(ergo.port);
    try {
      const { kickChannelMember } = await import("../src/grants.ts");
      await kickChannelMember("#room", "victim", "bye\r\nOPER attacker secret");
      expect(ergo.lines).toContain("KICK #room victim :bye OPER attacker secret");
      expect(ergo.lines).not.toContain("OPER attacker secret");
    } finally {
      await ergo.close();
    }
  });
});
