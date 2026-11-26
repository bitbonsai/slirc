import { expect, test } from "bun:test";
process.env.ERGO_HOST = "127.0.0.1";
process.env.ERGO_OPER_USER = "slirc-org";
process.env.ERGO_OPER_PASS = "test-only";
process.env.OPER_PERSISTENT = "0";
const { createDirectChannel, readDirectChannelReady } = await import("../src/grants.ts");

// The channel does not exist until the app registers it, unless `preexisting` says it was already
// provisioned. `occupants` are [nick, account] pairs inside once it exists (account "0": no login).
type Options = { modes?: string; masks?: string[]; registered?: boolean; recipient?: string; replyChannel?: string; endList?: boolean; pong?: boolean; hold?: boolean; preexisting?: boolean; occupants?: [string, string][] };
function fakeErgo(options: Options = {}) {
  const lines: string[] = [];
  let exists = !!options.preexisting;
  let release!: () => void;
  let reached!: () => void;
  const proofRequested = new Promise<void>((resolve) => { reached = resolve; });
  const server = Bun.listen<{ buffer: string; nick: string }>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(socket) { socket.data = { buffer: "", nick: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        let end: number;
        while ((end = socket.data.buffer.indexOf("\r\n")) >= 0) {
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          lines.push(line);
          const send = (reply: string) => socket.write(`${reply}\r\n`);
          if (line === "CAP LS 302") send(":test CAP * LS :sasl");
          else if (line === "CAP REQ :sasl") send(":test CAP * ACK :sasl");
          else if (line === "AUTHENTICATE PLAIN") send("AUTHENTICATE +");
          else if (line.startsWith("AUTHENTICATE ")) send(":test 903 * :ok");
          else if (line.startsWith("NICK ")) socket.data.nick = line.slice(5);
          else if (line === "CAP END") send(`:test 001 ${socket.data.nick} :welcome`);
          else if (line.startsWith("OPER ")) send(`:test 381 ${socket.data.nick} :oper`);
          else if (line === "PRIVMSG ChanServ :REGISTER #dm-alice-bob" && (exists = true)) send(`:ChanServ!service@test NOTICE ${socket.data.nick} :Channel #dm-alice-bob successfully registered`);
          else if (line === "PRIVMSG ChanServ :TRANSFER #dm-alice-bob alice") send(`:ChanServ!service@test NOTICE ${socket.data.nick} :To confirm your channel transfer, type: /CS TRANSFER #dm-alice-bob alice test-code`);
          else if (line === "PRIVMSG ChanServ :TRANSFER #dm-alice-bob alice test-code") send(`:ChanServ!service@test NOTICE ${socket.data.nick} :Successfully transferred channel #dm-alice-bob to account alice`);
          else if (line === "WHO #dm-alice-bob %tna,152") {
            for (const [nick, account] of exists ? options.occupants ?? [] : []) send(`:test 354 ${socket.data.nick} 152 ${nick} ${account}`);
            send(`:test 315 ${socket.data.nick} #dm-alice-bob :End of WHO list`);
          } else if (!exists && /^(MODE|SAMODE) #dm-alice-bob( \+I)?$/.test(line)) send(`:test 403 ${socket.data.nick} #dm-alice-bob :No such channel`);
          else if (!exists && line === "PRIVMSG ChanServ :INFO #dm-alice-bob") send(`:ChanServ!service@test NOTICE ${socket.data.nick} :Channel #dm-alice-bob is not registered`);
          else if (line === "MODE #dm-alice-bob") {
            send(`:test 324 ${options.recipient || socket.data.nick} ${options.replyChannel || "#dm-alice-bob"} :${options.modes ?? "+nsi"}`);
          } else if (line === "SAMODE #dm-alice-bob +I") {
            const recipient = options.recipient || socket.data.nick;
            const channel = options.replyChannel || "#dm-alice-bob";
            for (const mask of options.masks ?? ["alice!*@*", "bob!*@*", "slirc!*@*"]) send(`:test 346 ${recipient} ${channel} ${mask} oper 1`);
            if (options.endList !== false) send(`:test 347 ${recipient} ${channel} :End of list`);
          } else if (line === "PRIVMSG ChanServ :INFO #dm-alice-bob") {
            send(`:ChanServ!service@test NOTICE ${socket.data.nick} :Channel #dm-alice-bob is ${options.registered === false ? "not " : ""}registered`);
            if (options.registered !== false) send(`:ChanServ!service@test NOTICE ${socket.data.nick} :Founder: alice`);
          } else if (line.startsWith("PING ")) {
            if (line.startsWith("PING dm-proof-")) {
              release = () => send(`:test PONG test :${line.slice(5)}`);
              if (exists) reached();
              if (!exists) release();
              else if (!options.hold && options.pong !== false) release();
            } else send(`:test PONG test :${line.slice(5)}`);
          }
        }
      },
    },
  });
  process.env.ERGO_PORT = String(server.port);
  return { lines, proofRequested, release: () => release(), stop: () => server.stop(true) };
}

test("DM provisioning waits for read-back proof, even when command flush PONGs succeeded", async () => {
  const server = fakeErgo({ hold: true });
  let done = false;
  const provision = createDirectChannel("#dm-alice-bob", "alice", ["alice", "bob"]).then(() => { done = true; });
  try {
    await server.proofRequested;
    expect(done).toBe(false);
    expect(server.lines).toContain("SAMODE #dm-alice-bob +si-R");
    expect(server.lines).toContain("SAMODE #dm-alice-bob +I bob");
    server.release();
    await provision;
    expect(done).toBe(true);
  } finally { server.stop(); }
});

for (const [name, options] of Object.entries({
  "missing private modes": { modes: "+ns" },
  "missing peer grant": { masks: ["alice!*@*", "slirc!*@*"] },
  "unregistered channel": { registered: false },
  "other recipient": { recipient: "someoneelse" },
  "other channel": { replyChannel: "#unrelated" },
  "incomplete invite list": { endList: false },
  // C1: a squatter still inside, or an invite exception a squatter set while it held op.
  "an anonymous squatter inside": { occupants: [["alice", "alice"], ["squatter", "0"]] },
  "a logged-in stranger inside": { occupants: [["alice", "alice"], ["mallory", "mallory"]] },
  "an extra invite exception": { masks: ["alice!*@*", "bob!*@*", "slirc!*@*", "*!*@*"] },
})) {
  test(`DM provisioning rejects ${name} despite PONG`, async () => {
    const server = fakeErgo(options);
    try { await expect(createDirectChannel("#dm-alice-bob", "alice", ["alice", "bob"])).rejects.toThrow("not confirmed"); }
    finally { server.stop(); }
  });
}

test("the proof accepts the members, the relay and the app's own oper connections inside", async () => {
  const server = fakeErgo({ preexisting: true, occupants: [["alice", "alice"], ["bob", "bob"], ["slirc", "slirc"], ["slirc-org-abc123", "slirc-org"]] });
  try { expect(await readDirectChannelReady("#dm-alice-bob", ["alice", "bob"])).toBe(true); }
  finally { server.stop(); }
});

test("a nick that only looks like the app's oper connection does not pass the proof", async () => {
  const server = fakeErgo({ preexisting: true, occupants: [["alice", "alice"], ["slirc-org-abc123", "0"]] });
  try { expect(await readDirectChannelReady("#dm-alice-bob", ["alice", "bob"])).toBe(false); }
  finally { server.stop(); }
});

test("reopening a DM that already passes the proof sends no channel changes", async () => {
  const server = fakeErgo({ preexisting: true, occupants: [["alice", "alice"]] });
  try {
    await createDirectChannel("#dm-alice-bob", "alice", ["alice", "bob"]);
    expect(server.lines.some((line) => /^(SAJOIN|SAMODE #dm-alice-bob (?!\+I$)|KICK|PRIVMSG ChanServ :(REGISTER|TRANSFER))/.test(line))).toBe(false);
  } finally { server.stop(); }
});

test("reopening a DM with a stranger inside fails closed and never re-registers it", async () => {
  const server = fakeErgo({ preexisting: true, occupants: [["alice", "alice"], ["squatter", "0"]] });
  try {
    await expect(createDirectChannel("#dm-alice-bob", "alice", ["alice", "bob"])).rejects.toThrow("already has members");
    expect(server.lines.some((line) => /^(SAJOIN|PRIVMSG ChanServ :(REGISTER|TRANSFER))/.test(line))).toBe(false);
  } finally { server.stop(); }
});

test("legacy proof is read-only and requires a final response", async () => {
  const server = fakeErgo({ pong: false, preexisting: true });
  try {
    // Short budget: without a PONG the proof can only time out, so the default wait proves nothing more.
    expect(await readDirectChannelReady("#dm-alice-bob", ["alice", "bob"], 500)).toBe(false);
    expect(server.lines.some((line) => /^(SAJOIN|SAMODE .* [+-][^I]|PRIVMSG ChanServ :(REGISTER|TRANSFER))/.test(line))).toBe(false);
    expect(server.lines).toContain("SAMODE #dm-alice-bob +I");
  } finally { server.stop(); }
});
