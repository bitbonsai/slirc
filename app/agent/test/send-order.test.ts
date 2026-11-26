import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionClient, saveState, type Adapter } from "../src/adapter-core.ts";

// Parallel slirc_send and slirc_reply calls of one request reach Slirc one at a time, in call
// order: the real SessionClient against a fake Slirc that answers earlier messages slower.

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await pause(10);
  expect(check()).toBe(true);
}

const SECRET = "s".repeat(43);
const enc = new TextEncoder();
const DELAYS: Record<string, number> = { "Part 1": 60, "Part 2": 30, "Part 3": 10 };
const landed: string[] = [];
let inFlight = 0;
let maxInFlight = 0;
let release: (() => void) | undefined;
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let stateRoot: string;

beforeAll(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "slirc-agent-order-"));
  server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace("/api/agent/session", "");
    const json = await request.json().catch(() => ({})) as any;
    if (path === "/attach") return Response.json({ leaseId: "lease-1", expiresAt: Date.now() + 45_000, connected: true });
    if (path === "/heartbeat") return Response.json({ expiresAt: Date.now() + 45_000 });
    if (path === "/detach") return new Response(null, { status: 204 });
    if (path === "/events") return new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c; } }), { headers: { "Content-Type": "text/event-stream" } });
    const id = url.pathname.split("/").at(-2)!;
    if (path.endsWith("/accept")) return Response.json({ id, revision: json.revision, destination: "#dm-1", text: "answer in parts", context: [] });
    if (path.endsWith("/send") || path.endsWith("/reply")) {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        if (json.text === "Hold") await new Promise<void>((done) => { release = done; });
        else await pause(DELAYS[json.text] ?? 0);
        if (json.text === "Boom") return Response.json({ error: "message text is invalid" }, { status: 409 });
        landed.push(`${id}:${json.text}`);
        return path.endsWith("/send") ? Response.json({ status: "sent", messageId: `m-${json.text}` }) : Response.json({ status: "replied" });
      } finally { inFlight--; }
    }
    return Response.json({ error: "missing route" }, { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => { await server.stop(true); });

async function client(name: string) {
  const delivered: string[] = [];
  const adapter: Adapter = { harness: "test", version: "0", noun: "test session",
    deliver: async (_prompt, request) => { delivered.push(request.id); }, notify: () => {} };
  const identity = { sessionId: name, sessionFile: `/work/${name}.jsonl` };
  const path = join(stateRoot, `${name}.json`);
  await saveState(path, { ...identity, origin, secret: SECRET, requests: {},
    binding: { instanceId: "i", ownerAccountId: "o", bindingId: "b", nick: "agent-1", dm: "#dm-1", status: "ready" } });
  const session = (await SessionClient.resume(adapter, path, identity, { name, repo: "", model: "", provider: "" }))!;
  stream = undefined;
  await session.attach();
  await until(() => !!stream);
  return { session, delivered };
}
const offer = (id: string) => stream!.enqueue(enc.encode(`event: requests\ndata: [{"id":"${id}","revision":1,"reply_channel":"#dm-1","text":"look"}]\n\n`));

test("three sends and a reply called at once reach Slirc one at a time, in call order", async () => {
  const { session, delivered } = await client("order");
  offer("req-1");
  await until(() => delivered.length === 1);
  landed.length = 0; maxInFlight = 0;
  const results = await Promise.all([
    session.send("req-1", "Part 1"), session.send("req-1", "Part 2"), session.send("req-1", "Part 3"), session.reply("req-1", "Part 4"),
  ]);
  expect(landed).toEqual(["req-1:Part 1", "req-1:Part 2", "req-1:Part 3", "req-1:Part 4"]);
  expect(maxInFlight).toBe(1);
  expect(results[0]).toContain("m-Part 1");
  expect(results[3]).toContain("replied");
  session.retire(false);
});

test("a failing send is reported to its caller and the calls after it still go out", async () => {
  const { session } = await client("failing");
  landed.length = 0;
  const [before, boom, after] = await Promise.allSettled([
    session.send("req-2", "Part 1"), session.send("req-2", "Boom"), session.send("req-2", "Part 3"),
  ]);
  expect(before.status).toBe("fulfilled");
  expect(boom.status).toBe("rejected");
  expect(String((boom as PromiseRejectedResult).reason)).toContain("message text is invalid");
  expect(after.status).toBe("fulfilled");
  expect(landed).toEqual(["req-2:Part 1", "req-2:Part 3"]);
  session.retire(false);
});

test("a send stuck on one request doesn't hold up another request", async () => {
  const { session } = await client("separate");
  landed.length = 0; release = undefined;
  const held = session.send("req-a", "Hold");
  await until(() => !!release);
  expect(await session.send("req-b", "Part 3")).toContain("m-Part 3");
  release!();
  expect(await held).toContain("m-Hold");
  expect(landed).toEqual(["req-b:Part 3", "req-a:Hold"]);
  session.retire(false);
});
