import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionClient, saveState, uploadLinks, type Adapter, type Request } from "../src/adapter-core.ts";

// Uploads linked in a request reach the harness as local files: the real SessionClient against a
// fake Slirc that serves /uploads only to the binding's Bearer secret.

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await pause(10);
  expect(check()).toBe(true);
}

const SECRET = "s".repeat(43);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const enc = new TextEncoder();
const seen: { path: string; auth: string | null }[] = [];
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
let acceptText = "";
let contextText = "";
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let stateRoot: string;

beforeAll(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "slirc-agent-uploads-"));
  server = Bun.serve({ port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization");
    seen.push({ path: url.pathname + url.search, auth });
    if (url.pathname.startsWith("/uploads/")) {
      if (auth !== `Bearer ${SECRET}`) return new Response(null, { status: 401 });
      if (url.pathname === "/uploads/photo1") return new Response(PNG, { headers: { "Content-Type": "image/png" } });
      if (url.pathname === "/uploads/page") return new Response("<html>", { headers: { "Content-Type": "text/html" } });
      return new Response(null, { status: 403 });
    }
    const path = url.pathname.replace("/api/agent/session", "");
    const json = await request.json().catch(() => ({})) as any;
    if (path === "/attach") return Response.json({ leaseId: "lease-1", expiresAt: Date.now() + 45_000, connected: true });
    if (path === "/heartbeat") return Response.json({ expiresAt: Date.now() + 45_000 });
    if (path === "/detach") return new Response(null, { status: 204 });
    if (path === "/events") return new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c; } }), { headers: { "Content-Type": "text/event-stream" } });
    const id = url.pathname.split("/").at(-2)!;
    if (path.endsWith("/accept")) return Response.json({ id, revision: json.revision, destination: "#dm-1", text: acceptText,
      context: contextText ? [{ nick: "friend", text: contextText }] : [] });
    if (path.endsWith("/reply")) return Response.json({ status: "replied" });
    return Response.json({ error: "missing route" }, { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => { await server.stop(true); rmSync(stateRoot, { recursive: true, force: true }); });

async function client(name: string) {
  const delivered: { prompt: string; request: Request }[] = [];
  const notices: string[] = [];
  const adapter: Adapter = { harness: "test", version: "0", noun: "test session",
    deliver: async (prompt, request) => { delivered.push({ prompt, request }); }, notify: (message) => { notices.push(message); } };
  const identity = { sessionId: name, sessionFile: `/work/${name}.jsonl` };
  const path = join(stateRoot, `${name}.json`);
  await saveState(path, { ...identity, origin, secret: SECRET, requests: {},
    binding: { instanceId: "i", ownerAccountId: "o", bindingId: "b", nick: "agent-1", dm: "#dm-1", status: "ready" } });
  const session = (await SessionClient.resume(adapter, path, identity, { name, repo: "", model: "", provider: "" }))!;
  stream = undefined;
  await session.attach();
  await until(() => !!stream);
  return { session, delivered, notices };
}
const offer = (id: string) => stream!.enqueue(enc.encode(`event: requests\ndata: [{"id":"${id}","revision":1,"reply_channel":"#dm-1","text":"look"}]\n\n`));

test("uploadLinks keeps same-origin upload links only, absolute or root-relative, once each", () => {
  const text = `a https://app.test/uploads/abc?type=image b /uploads/def c https://evil.test/uploads/x d https://app.test/other/abc
    e https://app.test/uploads/abc f https://app.test/uploads/../api/x g foo/uploads/zzz`;
  expect(uploadLinks([text], "https://app.test")).toEqual(["https://app.test/uploads/abc", "https://app.test/uploads/def"]);
  expect(uploadLinks([Array.from({ length: 20 }, (_, i) => `/uploads/u${i}`).join(" ")], "https://app.test")).toHaveLength(10);
});

test("linked uploads are downloaded with the token, handed over as private local files, and removed after the reply", async () => {
  acceptText = `what is in ${origin}/uploads/photo1?type=image and /uploads/denied and /uploads/page and https://evil.test/uploads/photo1`;
  contextText = `earlier ${origin}/uploads/ctx9?type=image`;
  seen.length = 0;
  const { session, delivered, notices } = await client("reply");
  offer("req-1");
  await until(() => delivered.length === 1);
  const { prompt, request } = delivered[0];

  const local = prompt.match(/uploads\/photo1: (\S+)/)?.[1];
  expect(local).toBeDefined();
  expect(readFileSync(local!)).toEqual(Buffer.from(PNG));
  expect(statSync(local!).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(local!)).mode & 0o777).toBe(0o700);
  expect(local!.endsWith(".png")).toBe(true);
  expect(prompt).toContain(`${origin}/uploads/denied: could not be downloaded`);
  expect(prompt).toContain(`${origin}/uploads/page: could not be downloaded`);
  expect(prompt).toContain(`${origin}/uploads/ctx9: could not be downloaded`);

  // Every upload fetch carried the Bearer token; nothing went to another origin.
  const uploads = seen.filter((entry) => entry.path.startsWith("/uploads/"));
  expect(uploads.map((entry) => entry.path).sort()).toEqual(["/uploads/ctx9", "/uploads/denied", "/uploads/page", "/uploads/photo1"]);
  expect(uploads.every((entry) => entry.auth === `Bearer ${SECRET}`)).toBe(true);

  // The token never reaches the harness: not in the prompt, the request, a path or a notice.
  expect(prompt).not.toContain(SECRET);
  expect(JSON.stringify(request)).not.toContain(SECRET);
  expect(notices.join("\n")).not.toContain(SECRET);

  await session.reply("req-1", "a photo");
  await until(() => !existsSync(local!) && !existsSync(dirname(local!)));
  session.retire(false);
});

test("retiring the session removes downloads of an unanswered request", async () => {
  acceptText = `see /uploads/photo1`;
  const { session, delivered } = await client("retire");
  offer("req-2");
  await until(() => delivered.length === 1);
  const local = delivered[0].prompt.match(/uploads\/photo1: (\S+)/)![1];
  expect(existsSync(local)).toBe(true);
  session.retire(false);
  await until(() => !existsSync(local) && !existsSync(dirname(local)));
});

test("a request without upload links creates no temp folder and no prompt section", async () => {
  acceptText = "plain request";
  contextText = "no links here";
  seen.length = 0;
  const { session, delivered } = await client("plain");
  offer("req-3");
  await until(() => delivered.length === 1);
  expect(delivered[0].prompt).not.toContain("local files");
  expect(seen.filter((entry) => entry.path.startsWith("/uploads/"))).toEqual([]);
  session.retire(false);
});
