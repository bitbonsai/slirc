// Poll announcements against a real Ergo, the stock Slirc image. The card depends on the client-only
// +slirc/poll tag the helper puts on its multiline BATCH opener, so these tests check that Ergo
// relays it live and keeps it when CHATHISTORY replays the batch on reload. They also send a
// question in emoji: under the character limit, but past 512 bytes on the wire.
//
// Same container setup as ergo-live-multiline.test.ts: started from the image already on this
// machine (never pulled) and removed afterwards; without podman or docker, or the image, it skips.
import "./fixture.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { parseLine } from "../src/irc.ts";

const polls = await import("../src/polls.ts");

const IMAGE = process.env.SLIRC_TEST_ERGO_IMAGE || "ghcr.io/bitbonsai/slirc-ergo:v2.19.1-63c743a";
const runtime = ["podman", "docker"].find((bin) => Bun.spawnSync(["sh", "-c", `command -v ${bin}`]).exitCode === 0);
const imagePresent = !!runtime && Bun.spawnSync([runtime, "image", "inspect", IMAGE], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const live = test.skipIf(!imagePresent);
if (!imagePresent) console.warn(`ergo-live-poll: skipped (${runtime ? `image ${IMAGE} not present` : "no podman or docker"})`);

const name = `slirc-test-ergo-poll-${process.pid}`;
let port = 0;
const start = `sed -e 's/"127.0.0.1:6667":/":6667":/' -e '/"\\[::1\\]:6667":/d' -e 's|path: languages|path: /ircd-bin/languages|' /ircd-bin/default.yaml > /ircd/ircd.yaml && /ircd-bin/ergo mkcerts >/dev/null 2>&1 && exec /ircd-bin/ergo run`;

beforeAll(async () => {
  if (!imagePresent) return;
  const run = Bun.spawnSync([runtime!, "run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::6667", "--entrypoint", "sh", IMAGE, "-c", start]);
  if (run.exitCode !== 0) throw new Error(`could not start Ergo: ${run.stderr.toString()}`);
  const mapped = Bun.spawnSync([runtime!, "port", name, "6667"]).stdout.toString().trim().split("\n")[0];
  port = Number(mapped.split(":").at(-1));
  for (let i = 0; i < 100; i++) {
    const open = await new Promise<boolean>((resolve) => {
      const probe = connect(port, "127.0.0.1");
      probe.once("data", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => resolve(false));
      probe.write("PING :ready\r\n");
      setTimeout(() => { probe.destroy(); resolve(false); }, 300);
    });
    if (open) return;
    await Bun.sleep(200);
  }
  throw new Error("Ergo did not start listening");
}, 30_000);

afterAll(() => {
  if (imagePresent) Bun.spawnSync([runtime!, "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
});

// A registered client with the helper's capabilities, joined to one channel. `collect` gathers
// every parsed line until `done` says stop.
async function client(nick: string, channel: string) {
  const socket: Socket = connect(port, "127.0.0.1");
  let buffer = "";
  const handlers: ((line: string) => void)[] = [];
  socket.on("data", (data) => {
    buffer += data.toString();
    let end: number;
    while ((end = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (line.startsWith("PING")) socket.write(`PONG ${line.slice(5)}\r\n`);
      for (const handler of [...handlers]) handler(line);
    }
  });
  const until = (done: (message: ReturnType<typeof parseLine>) => boolean) => new Promise<ReturnType<typeof parseLine>[]>((resolve, reject) => {
    const seen: ReturnType<typeof parseLine>[] = [];
    const timer = setTimeout(() => reject(new Error(`no answer from Ergo; saw ${seen.map((m) => m.command).join(" ")}`)), 5_000);
    const handler = (line: string) => {
      const message = parseLine(line);
      seen.push(message);
      if (done(message)) { clearTimeout(timer); handlers.splice(handlers.indexOf(handler), 1); resolve(seen); }
    };
    handlers.push(handler);
  });
  const write = (line: string) => socket.write(`${line}\r\n`);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  write("CAP REQ :message-tags batch draft/multiline echo-message server-time draft/chathistory");
  write(`NICK ${nick}`);
  write("USER u 0 * :u");
  write("CAP END");
  await until((message) => message.command === "001");
  write(`JOIN ${channel}`);
  await until((message) => message.command === "JOIN");
  return { write, until, close() { write("QUIT :done"); socket.end(); } };
}

// What the helper's say() writes for a multiline message with tags on the opener.
const announcement = (ref: string, channel: string, lines: string[], tags = "+slirc/poll=7") => [
  `@${tags} BATCH +${ref} draft/multiline ${channel}`,
  ...lines.map((line) => `@batch=${ref} PRIVMSG ${channel} :${line}`),
  `BATCH -${ref}`,
];

const isMultilineOpen = (message: ReturnType<typeof parseLine>) => message.command === "BATCH" && message.params[0]?.startsWith("+") && message.params[1] === "draft/multiline";

live("the +slirc/poll tag on a multiline opener reaches the room and survives a CHATHISTORY replay", async () => {
  const helper = await client("poll", "#polls");
  const reader = await client("rita", "#polls");
  try {
    const lines = ["Poll by rita: Lunch?", "1. pizza", "2. sushi", "Vote with @poll 1, @poll 2 and so on."];
    const relayed = reader.until((message) => message.command === "BATCH" && message.params[0]?.startsWith("-"));
    for (const line of announcement("P1", "#polls", lines)) helper.write(line);
    const seen = await relayed;
    const opener = seen.find(isMultilineOpen)!;
    expect(opener.tags["+slirc/poll"]).toBe("7");
    expect(seen.filter((message) => message.command === "PRIVMSG").map((message) => message.params[1])).toEqual(lines);

    // A reload reads the room back through CHATHISTORY: the replayed multiline batch keeps the tag.
    let outer = "";
    const replay = reader.until((message) => {
      if (message.command === "BATCH" && message.params[1] === "chathistory") outer = message.params[0]!.slice(1);
      return !!outer && message.command === "BATCH" && message.params[0] === `-${outer}`;
    });
    reader.write("CHATHISTORY LATEST #polls * 10");
    const history = await replay;
    const replayed = history.find(isMultilineOpen);
    expect(replayed?.tags["+slirc/poll"]).toBe("7");
  } finally { helper.close(); reader.close(); }
}, 20_000);

live("an 800-byte emoji question is refused with 417, and the byte cap keeps announcements postable", async () => {
  const channel = `#${"c".repeat(48)}`;
  const helper = await client("poll", channel);
  try {
    const raw = `Poll by ${"r".repeat(30)}: ${"😀".repeat(200)}`;
    // Ergo answers the long line with 417 but still echoes the rest of the batch, so wait for the
    // batch to close; stopping at the 417 lets that echo end the next wait early.
    const refused = helper.until((message) => message.command === "FAIL" || (message.command === "BATCH" && message.params[0]?.startsWith("-")));
    for (const line of announcement("P2", channel, [raw, "1. a", "2. b"])) helper.write(line);
    expect((await refused).some((message) => message.command === "417" || message.command === "FAIL")).toBe(true);
    // The longest question the server accepts now, in 4-byte characters, from the longest nick.
    const question = `${"😀".repeat(Math.floor((polls.MAX_QUESTION_BYTES - 1) / 4))}?`;
    expect(polls.parsePoll(`${question} a, b`)).not.toHaveProperty("error");
    expect(polls.parsePoll(`😀${question} a, b`)).toHaveProperty("error");
    const poll = { id: 8, channel, creator: "r".repeat(32), question, options: ["😀".repeat(polls.MAX_OPTION_BYTES / 4), "b"], named: false, multi: true, created_at: 0, closes_at: null, closed_at: null };
    const lines = polls.announceLines(poll);
    const echoed = helper.until((message) => ["417", "FAIL"].includes(message.command) || (message.command === "BATCH" && message.params[0]?.startsWith("-")));
    for (const line of announcement("P3", channel, lines)) helper.write(line);
    const seen = await echoed;
    expect(seen.find((message) => message.command === "417" || message.command === "FAIL")).toBeUndefined();
    expect(seen.filter((message) => message.command === "PRIVMSG").map((message) => message.params[1])).toEqual(lines);
  } finally { helper.close(); }
}, 20_000);
