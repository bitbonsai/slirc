import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrcClient, ParsedMessage } from "../../src/irc.ts";
import { ask, reactionDelay, runPaths, Session } from "../src/session.ts";

const credentials = { nick: "pi-wolff", host: "localhost:8080", password: "x" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fakeIrc() {
  const sent: string[] = [];
  let onMessage: ((m: ParsedMessage) => void) | undefined;
  let onClose: (() => void) | undefined;
  const client = {
    send(line: string) { sent.push(line); return true; },
    quit() { onClose?.(); },
    waitFor() { return Promise.resolve(); },
  } as unknown as IrcClient;
  const connect = async (_c: unknown, handle?: (m: ParsedMessage) => void, close?: () => void) => { onMessage = handle; onClose = close; return client; };
  return { sent, connect, deliver: (m: ParsedMessage) => onMessage?.(m), drop: () => onClose?.() };
}

const privmsg = (text: string, target = "#slirc", msgid = "m1"): ParsedMessage => ({ command: "PRIVMSG", prefix: "wolff!u@h", params: [target, text], tags: { account: "wolff", msgid } });

test("runPaths prefers XDG_RUNTIME_DIR and falls back to ~/.config/slirc/run", () => {
  expect(runPaths("Pi-Wolff", { XDG_RUNTIME_DIR: "/run/user/1" }).socket).toBe("/run/user/1/slirc-agent-pi-wolff.sock");
  expect(runPaths("pi-wolff", { HOME: "/home/w" }).socket).toBe("/home/w/.config/slirc/run/pi-wolff.sock");
});

test("ask resolves undefined when no session is listening", async () => {
  expect(await ask("/nonexistent/slirc-agent.sock", { op: "status" }, 500)).toBeUndefined();
});

test("eyes target one second after server-time", () => {
  expect(reactionDelay("2026-09-18T09:00:00.000Z", 1_000, Date.parse("2026-09-18T09:00:00.250Z"))).toBe(750);
  expect(reactionDelay("2026-09-18T09:00:00.000Z", 1_000, Date.parse("2026-09-18T09:00:02.000Z"))).toBe(0);
  expect(reactionDelay(undefined, 1_000, 0)).toBe(1_000);
});

test("session queues mentions, serves wait and post over the socket, reacts after the delay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slirc-session-"));
  dirs.push(dir);
  const paths = { dir, socket: join(dir, "s.sock"), pid: join(dir, "s.pid"), log: join(dir, "s.log") };
  const irc = fakeIrc();
  const reacted: string[] = [];
  const session = new Session(credentials, paths, {
    connect: irc.connect as any,
    rooms: async () => ["#slirc", "#dm-pi-wolff-wolff"],
    react: async (_client, room, msgid) => { reacted.push(`${room}:${msgid}`); return true; },
    eyesDelayMs: 10,
  });
  const running = session.run();
  for (let i = 0; i < 50 && !(await ask(paths.socket, { op: "status" }, 200)); i++) await Bun.sleep(20);

  expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
  expect(irc.sent).toContain("JOIN #slirc");
  irc.deliver({ command: "JOIN", prefix: "pi-wolff!u@h", params: ["#slirc"], tags: {} });

  // A mention with nobody waiting is queued, acknowledged in chat, and still gets the eyes.
  irc.deliver(privmsg("@pi-wolff first"));
  await Bun.sleep(30);
  expect(reacted).toEqual(["#slirc:m1"]);
  expect(irc.sent).toContain("PRIVMSG #slirc :Got it, I'll reply here shortly.");
  const status = await ask(paths.socket, { op: "status" });
  expect(status).toMatchObject({ ok: true, status: { connected: true, queued: 1, rooms: ["#slirc"] } });

  const queued = await ask(paths.socket, { op: "wait", timeoutMs: 5_000 });
  expect(queued).toMatchObject({ ok: true, mention: { room: "#slirc", text: "@pi-wolff first", msgid: "m1" } });

  // While that task is active, the next mention gets the same warm ack and stays queued.
  irc.deliver(privmsg("@pi-wolff second", "#slirc", "m2"));
  expect(irc.sent.filter((line) => line === "PRIVMSG #slirc :Got it, I'll reply here shortly.").length).toBe(2);
  expect(await ask(paths.socket, { op: "wait", timeoutMs: 5_000 })).toMatchObject({ ok: true, mention: { msgid: "m2" } });

  // A live waiter gets the next mention as it lands.
  const pending = ask(paths.socket, { op: "wait", timeoutMs: 5_000 });
  await Bun.sleep(30);
  irc.deliver(privmsg("@pi-wolff third", "#slirc", "m3"));
  expect(await pending).toMatchObject({ ok: true, mention: { msgid: "m3" } });

  // Short wait times out cleanly; other people's lines are ignored.
  irc.deliver({ ...privmsg("@pi-wolff nope", "#slirc", "m4"), tags: { account: "alice", msgid: "m4" } });
  expect(await ask(paths.socket, { op: "wait", timeoutMs: 50 })).toEqual({ ok: true, timeout: true });

  // Post reuses the connection; an already joined room is not joined again.
  irc.sent.length = 0;
  expect(await ask(paths.socket, { op: "post", room: "#slirc", text: "a\nb" })).toEqual({ ok: true });
  expect(irc.sent.some((line) => line.startsWith("BATCH +") && line.includes("draft/multiline #slirc"))).toBe(true);
  expect(irc.sent).not.toContain("JOIN #slirc");
  expect(await ask(paths.socket, { op: "post", room: "wolff", text: "hi" })).toEqual({ ok: true });
  expect(irc.sent).toContain("PRIVMSG wolff :hi");

  // Pi retries when a socket acknowledgement is lost; the resident session posts an id once.
  irc.sent.length = 0;
  expect(await ask(paths.socket, { op: "post", room: "#slirc", text: "done", id: "pi:m3" })).toEqual({ ok: true });
  expect(await ask(paths.socket, { op: "post", room: "#slirc", text: "done", id: "pi:m3" })).toEqual({ ok: true });
  expect(irc.sent.filter((line) => line === "PRIVMSG #slirc :done")).toHaveLength(1);

  expect(await ask(paths.socket, { op: "stop" })).toEqual({ ok: true });
  expect(await running).toBe(0);
  expect(() => statSync(paths.socket)).toThrow();
  expect(() => statSync(paths.pid)).toThrow();
});
