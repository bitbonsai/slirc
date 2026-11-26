import { beforeAll, describe, expect, test } from "bun:test";

process.env.ERGO_HOST = "127.0.0.1";
process.env.ERGO_OPER_USER = "slirc-org";
process.env.ERGO_OPER_PASS = "oper-pass";
process.env.OPER_PERSISTENT = "0";

const grants = await import("../src/grants.ts");

async function commandsForOutcome(run: () => Promise<void>): Promise<{ lines: string[]; error: unknown }> {
  const commands: string[] = [];
  let clientNick = "";
  let sneakNames = 0;
  let delayedNames = 0;
  let sneakWho = 0;
  let resolveQuit = () => {};
  const quit = new Promise<void>((resolve) => { resolveQuit = resolve; });
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
          if (line.startsWith("PING ")) { socket.write(`:test PONG test :${line.slice(5)}\r\n`); continue; }
          if (line === "CAP LS 302") socket.write(":test CAP * LS :sasl\r\n");
          else if (line === "CAP REQ :sasl") socket.write(":test CAP * ACK :sasl\r\n");
          else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
          else if (line.startsWith("AUTHENTICATE ")) socket.write(":test 903 * :Authentication successful\r\n");
          else if (line.startsWith("NICK ")) clientNick = line.slice(5);
          else if (line === "CAP END") socket.write(`:test 001 ${clientNick} :Welcome\r\n`);
          else if (line.startsWith("OPER ")) {
            if (!line.startsWith("PING ")) commands.push(line);
            socket.write(":test 381 slirc-org :You are now an IRC operator\r\n");
          } else if (line === "PRIVMSG ChanServ :REGISTER #new") {
            commands.push(line);
            socket.write(":ChanServ!service@test NOTICE slirc-org :Channel #new successfully registered\r\n");
          } else if (line === "PRIVMSG ChanServ :TRANSFER #new alice") {
            commands.push(line);
            socket.write(":ChanServ!service@test NOTICE slirc-org :To confirm your channel transfer, type: /CS TRANSFER #new alice transfer-code\r\n");
          } else if (line === "PRIVMSG ChanServ :TRANSFER #new alice transfer-code") {
            commands.push(line);
            socket.write(":ChanServ!service@test NOTICE slirc-org :Successfully transferred channel #new to account alice\r\n");
          } else if (line === "NAMES #old") {
            commands.push(line);
            socket.write(`:test 353 ${clientNick} = #old :@${clientNick} @alice\r\n:test 366 ${clientNick} #old :End of NAMES list\r\n`);
          } else if (line === "PRIVMSG ChanServ :UNREGISTER #old") {
            commands.push(line);
            socket.write(":ChanServ!service@test NOTICE slirc-org :To confirm, run this command: /CS UNREGISTER #old unregister-code\r\n");
          } else if (line === "PRIVMSG ChanServ :UNREGISTER #old unregister-code") {
            commands.push(line);
            socket.write(":ChanServ!service@test NOTICE slirc-org :Channel #old is now unregistered\r\n");
          } else if (line === "NAMES #t-abc123") {
            commands.push(line);
            socket.write(`:test 353 ${clientNick} = #t-abc123 :@${clientNick} alice\r\n:test 366 ${clientNick} #t-abc123 :End of NAMES list\r\n`);
          } else if (line === "PRIVMSG ChanServ :UNREGISTER #t-abc123") {
            commands.push(line);
            socket.write(":ChanServ!service@test NOTICE slirc-org :That channel is not registered\r\n");
          } else if (line === "NAMES #t-new01") {
            commands.push(line);
            socket.write(`:test 353 ${clientNick} = #t-new01 :@${clientNick}\r\n:test 366 ${clientNick} #t-new01 :End of NAMES list\r\n`);
          } else if (line === "NAMES #t-noop") {
            commands.push(line);
            // Fresh SAJOIN without op: does not prove ownership; helper must PART, never SAMODE/REGISTER.
            socket.write(`:test 353 ${clientNick} = #t-noop :${clientNick}\r\n:test 366 ${clientNick} #t-noop :End of NAMES list\r\n`);
          } else if (line === "NAMES #t-alreadyop") {
            commands.push(line);
            socket.write(`:test 353 ${clientNick} = #t-alreadyop :@${clientNick}\r\n:test 366 ${clientNick} #t-alreadyop :End of NAMES list\r\n`);
          } else if (line === "NAMES #t-bare1") {
            commands.push(line);
            // A 353 for a different channel must not count; the 366 closes the requested channel.
            socket.write(`:test 353 ${clientNick} = #unrelated :@${clientNick}\r\n:test 366 ${clientNick} #t-bare1 :End of NAMES list\r\n`);
          } else if (line === "NAMES #t-bare2") {
            commands.push(line);
            // Bare 366 with no 353 at all proves nothing.
            socket.write(`:test 366 ${clientNick} #t-bare2 :End of NAMES list\r\n`);
          } else if (line === "NAMES #t-evict1") {
            commands.push(line);
            socket.write(`:test 353 ${clientNick} = #t-evict1 :@${clientNick} bob\r\n:test 366 ${clientNick} #t-evict1 :End of NAMES list\r\n`);
          } else if (line === "NAMES #t-taken1") {
            commands.push(line);
            socket.write(`:test 353 ${clientNick} = #t-taken1 :@${clientNick}\r\n:test 366 ${clientNick} #t-taken1 :End of NAMES list\r\n`);
          } else if (line === "NAMES #t-sneak1") {
            commands.push(line);
            sneakNames += 1;
            const names = sneakNames === 1 ? `@${clientNick}` : `@${clientNick} mallory`;
            socket.write(`:test 353 ${clientNick} = #t-sneak1 :${names}\r\n:test 366 ${clientNick} #t-sneak1 :End of NAMES list\r\n`);
          } else if (line === "NAMES #t-delayed") {
            commands.push(line);
            // First NAMES answers immediately; the one after the REGISTER burst is pushed seconds
            // behind the +si/+I commands, the way a loaded Ergo fakelag delivered it in practice.
            delayedNames += 1;
            const reply = `:test 353 ${clientNick} = #t-delayed :@${clientNick}\r\n:test 366 ${clientNick} #t-delayed :End of NAMES list\r\n`;
            if (delayedNames === 1) socket.write(reply);
            else setTimeout(() => { try { socket.write(reply); } catch {} }, 3_000);
          } else if (line === "PRIVMSG ChanServ :REGISTER #t-new01" || line === "PRIVMSG ChanServ :REGISTER #t-alreadyop" || line === "PRIVMSG ChanServ :REGISTER #t-evict1" || line === "PRIVMSG ChanServ :REGISTER #t-delayed" || line === "PRIVMSG ChanServ :REGISTER #t-sneak1") {
            commands.push(line);
            socket.write(`:ChanServ!service@test NOTICE slirc-org :Channel ${line.split(" ").at(-1)} successfully registered\r\n`);
          } else if (line === "PRIVMSG ChanServ :REGISTER #t-taken1") {
            commands.push(line);
            socket.write(":ChanServ!service@test NOTICE slirc-org :Channel #t-taken1 is already registered\r\n");
          } else if (line === "PRIVMSG ChanServ :TRANSFER #t-new01 alice" || line === "PRIVMSG ChanServ :TRANSFER #t-alreadyop alice" || line === "PRIVMSG ChanServ :TRANSFER #t-evict1 alice" || line === "PRIVMSG ChanServ :TRANSFER #t-delayed alice" || line === "PRIVMSG ChanServ :TRANSFER #t-sneak1 alice") {
            commands.push(line);
            const target = line.split(" ").at(-2);
            socket.write(`:ChanServ!service@test NOTICE slirc-org :To confirm your channel transfer, type: /CS TRANSFER ${target} alice transfer-code\r\n`);
          } else if (line === "PRIVMSG ChanServ :TRANSFER #t-new01 alice transfer-code" || line === "PRIVMSG ChanServ :TRANSFER #t-alreadyop alice transfer-code" || line === "PRIVMSG ChanServ :TRANSFER #t-evict1 alice transfer-code" || line === "PRIVMSG ChanServ :TRANSFER #t-delayed alice transfer-code" || line === "PRIVMSG ChanServ :TRANSFER #t-sneak1 alice transfer-code") {
            commands.push(line);
            const target = line.split(" ").at(-3);
            socket.write(`:ChanServ!service@test NOTICE slirc-org :Successfully transferred channel ${target} to account alice\r\n`);
          } else if (/^WHO #\S+ %tna,152$/.test(line)) {
            commands.push(line);
            const channel = line.split(" ")[1];
            // [nick, account] inside each channel; "0" is a connection with no account.
            if (channel === "#sneak") sneakWho += 1;
            const inside: Record<string, [string, string][]> = {
              "#squat": [["squatter", "0"]],
              "#squat-account": [["mallory", "mallory"]],
              "#relay": [["slirc", "slirc"], [`slirc-org-${"a".repeat(6)}`, "slirc-org"]],
              "#sneak": sneakWho === 1 ? [] : [[clientNick, "slirc-org"], ["mallory", "0"]],
            };
            for (const [nick, account] of inside[channel] ?? []) socket.write(`:test 354 ${clientNick} 152 ${nick} ${account}\r\n`);
            socket.write(`:test 315 ${clientNick} ${channel} :End of WHO list\r\n`);
          } else if (/^PRIVMSG ChanServ :REGISTER #(relay|sneak|squat|squat-account)$/.test(line)) {
            commands.push(line);
            socket.write(`:ChanServ!service@test NOTICE slirc-org :Channel ${line.split(" ").at(-1)} successfully registered\r\n`);
          } else if (line === "PRIVMSG ChanServ :REGISTER #taken") {
            commands.push(line);
            socket.write(":ChanServ!service@test NOTICE slirc-org :Channel #taken is already registered\r\n");
          } else if (/^PRIVMSG ChanServ :TRANSFER #(relay|sneak) alice$/.test(line)) {
            commands.push(line);
            socket.write(`:ChanServ!service@test NOTICE slirc-org :To confirm your channel transfer, type: /CS TRANSFER ${line.split(" ").at(-2)} alice transfer-code\r\n`);
          } else if (/^PRIVMSG ChanServ :TRANSFER #(relay|sneak) alice transfer-code$/.test(line)) {
            commands.push(line);
            socket.write(`:ChanServ!service@test NOTICE slirc-org :Successfully transferred channel ${line.split(" ").at(-3)} to account alice\r\n`);
          } else if (line === "QUIT :bye") resolveQuit();
          // operClient's always-on housekeeping is asserted on its own below, not in every command list.
          else if (/^NS (SET|SASET \S+) ALWAYS-ON false$/.test(line)) housekeeping.push(line);
          else if (!line.startsWith("USER ")) commands.push(line);
        }
      },
    },
  });
  process.env.ERGO_PORT = String(server.port);
  let error: unknown = null;
  try {
    await run();
    await Promise.race([quit, Bun.sleep(100)]);
  } catch (thrown) {
    error = thrown;
  } finally {
    server.stop(true);
  }
  return { lines: commands.map((command) => command.replaceAll(clientNick, "<oper>")), error };
}

async function commandsFor(run: () => Promise<void>): Promise<string[]> {
  const { lines, error } = await commandsForOutcome(run);
  if (error) throw error;
  return lines;
}

const login = "OPER slirc-org oper-pass";
const housekeeping: string[] = [];

describe("oper channel grants", () => {
  // The service-account opt-out runs once per process; another file may have used it up.
  beforeAll(() => grants.resetServiceAccountsOptOutForTests());

  test("creates and transfers a channel, locked before the transfer", async () => {
    expect(await commandsFor(() => grants.createChannel("#new", "alice", "secret"))).toEqual([
      login,
      "WHO #new %tna,152",
      "SAJOIN <oper> #new",
      "SAMODE #new +o <oper>",
      "PRIVMSG ChanServ :REGISTER #new",
      "SAMODE #new +si-Rt",
      "SAMODE #new +I slirc",
      "WHO #new %tna,152",
      "PRIVMSG ChanServ :TRANSFER #new alice",
      "PRIVMSG ChanServ :TRANSFER #new alice transfer-code",
    ]);
  });

  // C1: anyone could JOIN a predictable #dm- name before the DM existed and stay through provisioning.
  for (const channel of ["#squat", "#squat-account"]) {
    test(`refuses to create over someone already inside (${channel})`, async () => {
      const { lines, error } = await commandsForOutcome(() => grants.createChannel(channel, "alice", "secret"));
      expect(String(error)).toContain("already has members");
      expect(lines).toEqual([login, `WHO ${channel} %tna,152`]);
    });
  }

  test("refuses to adopt a channel that is already registered", async () => {
    const { lines, error } = await commandsForOutcome(() => grants.createChannel("#taken", "alice", "secret"));
    expect(String(error)).toContain("already registered");
    expect(lines).toContain("PART #taken");
    expect(lines.some((line) => line.startsWith("SAMODE #taken +si") || line.startsWith("PRIVMSG ChanServ :TRANSFER"))).toBe(false);
  });

  test("the relay and the app's own oper connections do not count as occupants", async () => {
    const lines = await commandsFor(() => grants.createChannel("#relay", "alice", "secret"));
    expect(lines).toContain("PRIVMSG ChanServ :TRANSFER #relay alice transfer-code");
    expect(lines.some((line) => line.startsWith("KICK"))).toBe(false);
  });

  test("kicks anyone who slipped in before the lock, before the transfer", async () => {
    const lines = await commandsFor(() => grants.createChannel("#sneak", "alice", "secret"));
    expect(lines).toContain("KICK #sneak mallory :Private conversation");
    expect(lines).not.toContain("KICK #sneak <oper> :Private conversation");
    expect(lines.indexOf("SAMODE #sneak +si-Rt")).toBeLessThan(lines.indexOf("KICK #sneak mallory :Private conversation"));
    expect(lines.indexOf("KICK #sneak mallory :Private conversation")).toBeLessThan(lines.indexOf("PRIVMSG ChanServ :TRANSFER #sneak alice"));
  });

  test("seed scripts may still reconfigure their own existing rooms", async () => {
    const lines = await commandsFor(() => grants.createChannel("#new", "alice", "secret", { adopt: true }));
    expect(lines).not.toContain("WHO #new %tna,152");
    expect(lines).toContain("PRIVMSG ChanServ :TRANSFER #new alice transfer-code");
  });

  test("grants access", async () => {
    expect(await commandsFor(() => grants.grantChannelAccess("#private", "alice"))).toEqual([
      login,
      "SAMODE #private +I alice",
      "SAJOIN <oper> #private",
      "SAMODE #private +o <oper>",
      "INVITE alice #private",
    ]);
  });

  test("revokes access", async () => {
    expect(await commandsFor(() => grants.revokeChannelAccess("#private", "alice"))).toEqual([
      login,
      "SAMODE #private -I alice",
    ]);
  });

  test("kicks a member", async () => {
    expect(await commandsFor(() => grants.kickChannelMember("#private", "alice", "Removed"))).toEqual([
      login,
      "SAJOIN <oper> #private",
      "SAMODE #private +o <oper>",
      "KICK #private alice :Removed",
    ]);
  });

  test("removes someone from a channel's threads, dropping +I only on private ones", async () => {
    expect(await commandsFor(() => grants.removeFromThreadChannels("bob", [{ channel: "#t-priv01", revoke: true }, { channel: "#t-pub001", revoke: false }], "Removed"))).toEqual([
      login,
      "SAJOIN <oper> #t-priv01",
      "SAMODE #t-priv01 +o <oper>",
      "KICK #t-priv01 bob :Removed",
      "SAMODE #t-priv01 -I bob",
      "SAJOIN <oper> #t-pub001",
      "SAMODE #t-pub001 +o <oper>",
      "KICK #t-pub001 bob :Removed",
    ]);
  });

  test("locks a public thread with its parent's members and kicks anyone else in it", async () => {
    expect(await commandsFor(() => grants.makeThreadChannelsSecret(["#t-evict1"], ["alice"]))).toEqual([
      login,
      "SAJOIN <oper> #t-evict1",
      "SAMODE #t-evict1 +o <oper>",
      "SAMODE #t-evict1 +si-R",
      "SAMODE #t-evict1 +II alice slirc",
      "NAMES #t-evict1",
      "KICK #t-evict1 bob :Private thread",
    ]);
  });

  test("sets a topic", async () => {
    expect(await commandsFor(() => grants.setChannelTopic("#private", "Hello"))).toEqual([
      login,
      "SAJOIN <oper> #private",
      "SAMODE #private -t",
      "TOPIC #private :Hello",
    ]);
  });

  test("unregisters and empties a channel", async () => {
    expect(await commandsFor(() => grants.unregisterChannel("#old"))).toEqual([
      login,
      "SAJOIN <oper> #old",
      "SAMODE #old +q <oper>",
      "NAMES #old",
      "SAMODE #old +msi",
      "PRIVMSG ChanServ :UNREGISTER #old",
      "PRIVMSG ChanServ :UNREGISTER #old unregister-code",
      "KICK #old alice :Channel deleted",
      "PART #old",
    ]);
  });

  test("empties a thread channel that was never registered", async () => {
    expect(await commandsFor(() => grants.unregisterChannel("#t-abc123"))).toEqual([
      login,
      "SAJOIN <oper> #t-abc123",
      "SAMODE #t-abc123 +q <oper>",
      "NAMES #t-abc123",
      "SAMODE #t-abc123 +msi",
      "PRIVMSG ChanServ :UNREGISTER #t-abc123",
      "KICK #t-abc123 alice :Channel deleted",
      "PART #t-abc123",
    ]);
  });
  test("proves ownership first, then locks before transfer without self-op", async () => {
    const lines = await commandsFor(() => grants.createThreadChannel("#t-new01", "alice", "secret", ["alice"]));
    expect(lines).toEqual([
      login,
      "SAJOIN <oper> #t-new01",
      "NAMES #t-new01",
      "PRIVMSG ChanServ :REGISTER #t-new01",
      "SAMODE #t-new01 +si-Rt",
      "SAMODE #t-new01 +III alice slirc <oper>",
      "NAMES #t-new01",
      "PRIVMSG ChanServ :TRANSFER #t-new01 alice",
      "PRIVMSG ChanServ :TRANSFER #t-new01 alice transfer-code",
    ]);
    // withOper's default join would SAMODE +o; the no-op join never does, and Ergo's @self is enough.
    expect(lines).not.toContain("SAMODE #t-new01 +o <oper>");
    expect(lines.indexOf("NAMES #t-new01")).toBeLessThan(lines.indexOf("PRIVMSG ChanServ :REGISTER #t-new01"));
    expect(lines.indexOf("PRIVMSG ChanServ :REGISTER #t-new01")).toBeLessThan(lines.indexOf("SAMODE #t-new01 +si-Rt"));
    expect(lines.indexOf("SAMODE #t-new01 +si-Rt")).toBeLessThan(lines.indexOf("PRIVMSG ChanServ :TRANSFER #t-new01 alice"));
  });

  test("grants a large thread's members in batches of ten per line", async () => {
    // Ergo fakelag spaces the oper's lines about 0.5s apart. One +I line per member delayed the
    // second NAMES past its window once a parent had 13 members, and the thread was torn down.
    const members = ["alice", ...Array.from({ length: 12 }, (_, i) => `member${i + 1}`)];
    const lines = await commandsFor(() => grants.createThreadChannel("#t-new01", "alice", "secret", members));
    const invites = lines.filter((line) => line.startsWith("SAMODE #t-new01 +I"));
    expect(invites).toEqual([
      `SAMODE #t-new01 +IIIIIIIIII ${members.slice(0, 10).join(" ")}`,
      `SAMODE #t-new01 +IIIII ${members.slice(10).join(" ")} slirc <oper>`,
    ]);
    expect(lines.at(-1)).toBe("PRIVMSG ChanServ :TRANSFER #t-new01 alice transfer-code");
  });

  test("a fresh join without op fails closed with no SAMODE or REGISTER", async () => {
    const { lines, error } = await commandsForOutcome(() => grants.createThreadChannel("#t-noop", "alice", "secret", ["alice"]));
    expect(error).toBeInstanceOf(Error);
    expect((error as { uncertain?: boolean }).uncertain).toBe(false);
    expect(lines).toContain("NAMES #t-noop");
    expect(lines).toContain("PART #t-noop");
    expect(lines).not.toContain("SAMODE #t-noop +o <oper>");
    expect(lines).not.toContain("SAMODE #t-noop +si-Rt");
    expect(lines.some((line) => line.startsWith("PRIVMSG ChanServ :REGISTER #t-noop"))).toBe(false);
  });

  test("does not op itself when NAMES already shows self op", async () => {
    const lines = await commandsFor(() => grants.createThreadChannel("#t-alreadyop", "alice", "secret", ["alice"]));
    expect(lines).toEqual([
      login,
      "SAJOIN <oper> #t-alreadyop",
      "NAMES #t-alreadyop",
      "PRIVMSG ChanServ :REGISTER #t-alreadyop",
      "SAMODE #t-alreadyop +si-Rt",
      "SAMODE #t-alreadyop +III alice slirc <oper>",
      "NAMES #t-alreadyop",
      "PRIVMSG ChanServ :TRANSFER #t-alreadyop alice",
      "PRIVMSG ChanServ :TRANSFER #t-alreadyop alice transfer-code",
    ]);
    expect(lines.some((line) => line === "SAMODE #t-alreadyop +o <oper>")).toBe(false);
  });

  test("waits out a delayed second NAMES instead of failing the registration", async () => {
    const { lines, error } = await commandsForOutcome(() => grants.createThreadChannel("#t-delayed", "alice", "secret", ["alice"]));
    expect(error).toBeNull();
    // Both proofs ran; the second one arrived after the REGISTER burst, outside the old 2.5s window.
    expect(lines.filter((line) => line === "NAMES #t-delayed")).toHaveLength(2);
    expect(lines).toContain("SAMODE #t-delayed +III alice slirc <oper>");
    expect(lines).toContain("PRIVMSG ChanServ :TRANSFER #t-delayed alice transfer-code");
  }, 12_000);

  test("an unrelated 353 or a bare 366 does not prove ownership", async () => {
    for (const channel of ["#t-bare1", "#t-bare2"]) {
      const { lines, error } = await commandsForOutcome(() => grants.createThreadChannel(channel, "alice", "secret", ["alice"]));
      expect(error).toBeInstanceOf(Error);
      expect(lines).not.toContain(`SAMODE ${channel} +o <oper>`);
      expect(lines.some((line) => line.startsWith(`PRIVMSG ChanServ :REGISTER ${channel}`))).toBe(false);
      expect((error as { uncertain?: boolean }).uncertain).toBe(false);
    }
  });

  test("evicts an occupant who joined during the REGISTER await", async () => {
    const lines = await commandsFor(() => grants.createThreadChannel("#t-sneak1", "alice", "secret", ["alice"]));
    expect(lines).toContain("KICK #t-sneak1 mallory :Private thread");
    expect(lines.indexOf("PRIVMSG ChanServ :REGISTER #t-sneak1")).toBeLessThan(lines.indexOf("KICK #t-sneak1 mallory :Private thread"));
    expect(lines.indexOf("KICK #t-sneak1 mallory :Private thread")).toBeLessThan(lines.indexOf("PRIVMSG ChanServ :TRANSFER #t-sneak1 alice"));
  });

  test("leaves a pre-existing occupied room untouched", async () => {
    const { lines, error } = await commandsForOutcome(() => grants.createThreadChannel("#t-evict1", "alice", "secret", ["alice"]));
    expect(error).toBeInstanceOf(Error);
    expect(lines).toContain("NAMES #t-evict1");
    expect(lines).toContain("PART #t-evict1");
    expect(lines).not.toContain("SAMODE #t-evict1 +si-Rt");
    expect(lines).not.toContain("SAMODE #t-evict1 +o <oper>");
    expect(lines).not.toContain("KICK #t-evict1 bob :Private thread");
    expect(lines.some((line) => line.startsWith("PRIVMSG ChanServ :REGISTER #t-evict1"))).toBe(false);
    expect((error as { uncertain?: boolean }).uncertain).toBe(false);
  });

  test("refuses to adopt an already-registered channel", async () => {
    let thrown: { registered?: boolean } | null = null;
    try {
      await commandsFor(() => grants.createThreadChannel("#t-taken1", "alice", "secret", ["alice"]));
    } catch (error) {
      thrown = error as { registered?: boolean };
    }
    expect(thrown?.registered).toBe(false);
  });

  test("the oper account and service accounts are switched off always-on", () => {
    expect(housekeeping[0]).toBe("NS SET ALWAYS-ON false");
    expect(housekeeping).toContain("NS SASET slirc ALWAYS-ON false");
  });
});
