// Public playground with a custom OPEN_CHAT_ROOM / OPEN_CHANNELS (#feedback instead of #open-chat).
// Verifies /auth/me, /feedback shell route, /api/peek/feedback, /auth/verify next handling,
// room-ambience note copy, and coexistence with an existing `channels` row. One file per process.
import "./fixture.ts";

process.chdir(new URL("..", import.meta.url).pathname);
process.env.APP_ORIGIN = "https://myarc.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
delete process.env.MAGIC_LINK_LOG;
process.env.SLIRC_MODE = "public_playground";
process.env.OPEN_CHANNELS = "#feedback";
process.env.OPEN_CHAT_ROOM = "#feedback";

import { beforeEach, expect, mock, test } from "bun:test";
import { parseLine, type ParsedMessage } from "../src/irc.ts";

const mail: { to: string; text: string }[] = [];
const sent: string[] = [];
const history: Record<string, string[]> = {
  "#feedback": [
    "@msgid=f1;time=2026-11-24T08:00:00.000Z :ada!ada@slirc PRIVMSG #feedback :first feedback note",
    "@msgid=f2;time=2026-11-24T08:01:00.000Z :ben!ben@slirc PRIVMSG #feedback :+1 on this",
  ],
};

function fakeReader() {
  const waiters: { pred: (m: ParsedMessage) => boolean; resolve: () => void }[] = [];
  const emit = (line: string) => {
    const m = parseLine(line);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.pred(m)) { waiters[i]!.resolve(); waiters.splice(i, 1); }
  };
  const nick = "slirc-myarc-abc123";
  return {
    nick,
    waitFor: (pred: (m: ParsedMessage) => boolean) => new Promise<void>((resolve) => { waiters.push({ pred, resolve }); }),
    send(line: string) {
      sent.push(line);
      const join = line.match(/^JOIN (#\S+)$/);
      if (join) queueMicrotask(() => emit(`:${nick}!x@slirc JOIN ${join[1]}`));
      const query = line.match(/^CHATHISTORY BEFORE (#\S+) /);
      if (query) queueMicrotask(() => {
        emit(`BATCH +b1 chathistory ${query[1]}`);
        for (const row of history[query[1]!] || []) emit(`@batch=b1;${row.slice(1)}`);
        emit("BATCH -b1");
      });
      return true;
    },
    quit() {},
  };
}

const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, operClient: async () => fakeReader(), createDirectChannel: async () => {}, readDirectChannelReady: async () => false }));
mock.module("resend", () => ({ Resend: class { emails = { send: async (message: any) => { mail.push(message); return { data: { id: "test" }, error: null }; } }; } }));

const { db } = await import("../src/db.ts");
const { app, settleSignIns } = await import("../src/server.ts");
const { leaveChannel, memberChannels, openChannels } = await import("../src/rooms.ts");
const { resetRateLimits } = await import("../src/request-security.ts");
const { noteLine } = await import("../src/room-ambience.ts");

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const mailedLink = (text: string) => new URL(text.match(/https:\/\/\S+\/auth\/verify\?[^\s)]+/)![0]);
const sessionCookie = (response: Response) => response.headers.get("set-cookie")?.match(/slirc_session=[^;]+/)?.[0] || "";

beforeEach(() => {
  mail.length = 0;
  sent.length = 0;
  resetRateLimits();
  for (const table of ["sessions", "magic_links", "used_magic_links", "mail_counts", "signup_counts"]) db.query(`DELETE FROM ${table}`).run();
  db.query("DELETE FROM accounts WHERE email LIKE '%custom.test'").run();
});

test("signed-out /auth/me advertises the configured openRoom and /feedback serves the app shell", async () => {
  const me = await (await app.request("/auth/me")).json();
  expect(me).toMatchObject({ authenticated: false, signup: true, openRoom: "#feedback" });

  const shell = await app.request("/feedback");
  expect(shell.status).toBe(200);
  expect(shell.headers.get("content-type")).toContain("text/html");
  expect(await shell.text()).toContain('x-data="client()"');
});

test("signed-out peek serves #feedback and refuses #open-chat", async () => {
  const ok = await app.request("/api/peek/feedback");
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body.channel).toBe("#feedback");
  expect(body.messages).toEqual([
    { id: "f1", time: "2026-11-24T08:00:00.000Z", nick: "ada", text: "first feedback note" },
    { id: "f2", time: "2026-11-24T08:01:00.000Z", nick: "ben", text: "+1 on this" },
  ]);

  expect((await app.request("/api/peek/open-chat")).status).toBe(404);
});

test("email verification with next=/feedback recognizes the configured open room and lands in #feedback", async () => {
  const response = await post("/auth/request", { email: "alex@custom.test", name: "Alex", next: "/feedback" });
  await settleSignIns();
  expect(response.status).toBe(204);
  expect(mail).toHaveLength(1);

  const link = mailedLink(mail[0]!.text);
  const verified = await app.request(link.pathname + link.search);
  expect(verified.status).toBe(200);
  const html = await verified.text();
  expect(html).toContain("You're logged in.");
  expect(html).toContain('localStorage.setItem("slirc-authenticated", "/feedback")');

  const cookie = sessionCookie(verified);
  expect(cookie).toBeTruthy();
  const me = await (await app.request("/auth/me", { headers: { Cookie: cookie } })).json();
  expect(me).toMatchObject({
    authenticated: true,
    openChannels: ["#feedback"],
    openRoom: "#feedback",
  });
  expect(me.channels).toContain("#feedback");
});

test("an existing #feedback row in channels does not duplicate membership or allow leaving", () => {
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#feedback', 'bitbonsai', 'workspace', 1) ON CONFLICT DO NOTHING").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#feedback', 'bitbonsai') ON CONFLICT DO NOTHING").run();
  expect(openChannels).toEqual(["#feedback"]);
  expect(memberChannels("bitbonsai").filter((channel) => channel === "#feedback")).toEqual(["#feedback"]);
  expect(leaveChannel("bitbonsai", "#feedback")).toBe(false);
});

test("room ambience welcome note names the configured open room", () => {
  expect(noteLine()).toContain("#feedback");
  expect(noteLine()).not.toContain("#open-chat");
});
