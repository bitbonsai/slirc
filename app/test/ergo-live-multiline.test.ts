// Long lines in multiline messages against a real Ergo, the stock Slirc image. Unit tests passed
// while Ergo refused the batch: it checks each line as relayed, ":<nick>!<user>@<host> PRIVMSG
// <target> :<text>", against 512 bytes and fails the whole batch with 417 otherwise. These tests
// send exactly what the web client and the agent transport put on the wire and require Ergo's
// echo to carry the full text back.
//
// The container is started here from the image already on this machine (it is never pulled) and
// removed afterwards. Without podman or docker, or without the image, the tests skip.
// Override the image with SLIRC_TEST_ERGO_IMAGE.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import type { Operation } from "@client/model.ts";
import { serializeOperation } from "@client/protocol.ts";
import { isConcat, joinParts, wireParts } from "../shared/multiline.ts";
import { parseLine } from "../src/irc.ts";

const IMAGE = process.env.SLIRC_TEST_ERGO_IMAGE || "ghcr.io/bitbonsai/slirc-ergo:v2.19.1-63c743a";
const runtime = ["podman", "docker"].find((bin) => Bun.spawnSync(["sh", "-c", `command -v ${bin}`]).exitCode === 0);
const imagePresent = !!runtime && Bun.spawnSync([runtime, "image", "inspect", IMAGE], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const live = test.skipIf(!imagePresent);
if (!imagePresent) console.warn(`ergo-live-multiline: skipped (${runtime ? `image ${IMAGE} not present` : "no podman or docker"})`);

const name = `slirc-test-ergo-${process.pid}`;
let port = 0;

// Stock config with the plaintext listener opened to the container network; nothing else changes,
// so line, multiline and nick limits are Ergo's defaults, the same as Slirc's configs.
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

type Echo = { cid: string; text: string } | { refused: string };

// One registered client in one channel. `send` writes raw wire lines and resolves with Ergo's echo
// of the multiline batch (its text joined back) or the error that refused it.
async function session(nick: string, channel: string) {
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
  const wait = (match: (line: string) => boolean) => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no answer from Ergo")), 5_000);
    const handler = (line: string) => { if (match(line)) { clearTimeout(timer); handlers.splice(handlers.indexOf(handler), 1); resolve(line); } };
    handlers.push(handler);
  });
  const write = (line: string) => socket.write(`${line}\r\n`);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  write("CAP REQ :message-tags batch draft/multiline echo-message");
  write(`NICK ${nick}`);
  write("USER u 0 * :u");
  write("CAP END");
  await wait((line) => / 001 /.test(line));
  write(`JOIN ${channel}`);
  await wait((line) => / JOIN /.test(line));
  return {
    async send(lines: string[]): Promise<Echo> {
      let ref = "";
      let cid = "";
      const parts: { text: string; concat: boolean }[] = [];
      const done = new Promise<Echo>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no echo and no error from Ergo")), 5_000);
        const handler = (line: string) => {
          const message = parseLine(line);
          if (message.command === "417" || message.command === "FAIL") {
            clearTimeout(timer); handlers.splice(handlers.indexOf(handler), 1); resolve({ refused: line }); return;
          }
          if (message.command === "BATCH" && message.params[0]?.startsWith("+") && message.params[1] === "draft/multiline") {
            ref = message.params[0].slice(1); cid = message.tags["+slirc/cid"] || ""; return;
          }
          if (ref && message.command === "PRIVMSG" && message.tags.batch === ref) {
            parts.push({ text: message.params[1] ?? "", concat: isConcat(message.tags) }); return;
          }
          if (ref && message.command === "BATCH" && message.params[0] === `-${ref}`) {
            clearTimeout(timer); handlers.splice(handlers.indexOf(handler), 1); resolve({ cid, text: joinParts(parts) });
          }
        };
        handlers.push(handler);
      });
      for (const line of lines) write(line);
      return done;
    },
    close() { write("QUIT :done"); socket.end(); },
  };
}

// The longest nick Ergo allows, and the longest real target: a Slirc DM channel.
const NICK = "n".repeat(31) + "1";
const DM = "#dm-13caae5e514de9efd3c0b91757249879c0f203fe2ce59f51eaadf863";
const words = Array.from({ length: 110 }, (_, i) => `word${String(i).padStart(3, "0")}`).join(" ");
const LONG = `test 3 long: ${words}\nsecond line after the long one`; // first line 892 bytes, as on calango

live("the web client's multiline message with an 892-byte line reaches the room whole", async () => {
  const client = await session(`w${NICK.slice(1)}`, "#calango");
  try {
    const operation = { id: "op-web", messageId: "m", conversationId: "c", kind: "text", text: LONG, state: "queued", createdAt: 1 } as unknown as Operation;
    expect(await client.send(serializeOperation(operation, "#calango", true, () => "B1"))).toEqual({ cid: "op-web", text: LONG });
  } finally { client.close(); }
}, 20_000);

live("the agent's reply with long, blank and multibyte lines reaches a DM whole under its cid", async () => {
  const client = await session(`a${NICK.slice(1)}`, DM);
  try {
    const text = `Summary\n\n${"é😀".repeat(140)}\n${words}\n\nDone.`;
    const lines = [`@+slirc/cid=cid-agent BATCH +B2 draft/multiline ${DM}`,
      ...wireParts(text, DM).map((part) => `@+slirc/cid=cid-agent;batch=B2${part.concat ? ";draft/multiline-concat" : ""} PRIVMSG ${DM} :${part.text}`),
      "BATCH -B2"];
    expect(await client.send(lines)).toEqual({ cid: "cid-agent", text });
  } finally { client.close(); }
}, 20_000);

live("the old budget, which left out the relayed source, is refused by Ergo with 417", async () => {
  const client = await session(`o${NICK.slice(1)}`, "#calango");
  try {
    // 3.1.2's cut: 512 - 10 - "PRIVMSG <target> :". Ergo adds the source when it checks.
    const oldPart = "x".repeat(512 - 10 - Buffer.byteLength("PRIVMSG #calango :"));
    const outcome = await client.send(["BATCH +B3 draft/multiline #calango", `@batch=B3 PRIVMSG #calango :${oldPart}`, "@batch=B3 PRIVMSG #calango :tail", "BATCH -B3"]);
    expect(outcome).toMatchObject({ refused: expect.stringContaining(" 417 ") });
  } finally { client.close(); }
}, 20_000);
