import "./fixture.ts";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.env.SLIRC_HELPERS_ENABLED = "false";
const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
const { wantsChannelPush } = await import("../src/slirc-bot.ts");
const { isDailyGreeting } = await import("../shared/service-bots.ts");
afterAll(() => db.close());
const accountId = accountByNick("bitbonsai")!.id;
const token = "greeting-fixture-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)")
  .run(createHash("sha256").update(token).digest("hex"), Date.now());
const headers = { "Content-Type": "application/json", Cookie: `slirc_session=${token}` };
const patch = (body: unknown) => app.request("/profile", { method: "PATCH", headers, body: JSON.stringify(body) });
const me = async () => (await app.request("/auth/me", { headers })).json();
const GDAY = "[Giphy: ship it] https://media.giphy.com/media/x/giphy.gif";

test("the G'day greeting is on by default and the setting persists per account", async () => {
  expect((await me()).greeting).toBe(true);
  expect((await patch({ accountId, greeting: false })).status).toBe(200);
  expect((await me()).greeting).toBe(false);
  expect((await patch({ accountId, about: "Unrelated save" })).status).toBe(200);
  expect((await me()).greeting).toBe(false);
  expect((await patch({ accountId, greeting: true })).status).toBe(200);
  expect((await me()).greeting).toBe(true);
  expect(await (await app.request("/auth/me")).json()).not.toHaveProperty("greeting");
});

test("invalid values and changed or missing account ids cannot change the greeting setting", async () => {
  for (const greeting of [null, "off", 0, 1, {}]) expect((await patch({ accountId, greeting })).status).toBe(400);
  expect((await patch({ accountId: "previous-account", greeting: false })).status).toBe(409);
  expect((await patch({ greeting: false })).status).toBe(409);
  expect((await me()).greeting).toBe(true);
});

test("only the welcome helper's gif line counts as the daily greeting", () => {
  expect(isDailyGreeting("welcome", GDAY)).toBe(true);
  expect(isDailyGreeting("Welcome", GDAY)).toBe(true);
  expect(isDailyGreeting("bitbonsai", GDAY)).toBe(false);
  expect(isDailyGreeting("welcome", "Hi there, welcome to #open-chat.")).toBe(false);
});

test("turning the greeting off suppresses only its push, and only for that person", async () => {
  db.query("INSERT INTO notification_prefs (nick, preference) VALUES ('bitbonsai', 'all') ON CONFLICT(nick) DO UPDATE SET preference = 'all'").run();
  expect(wantsChannelPush("bitbonsai", "welcome", GDAY)).toBe(true);
  expect((await patch({ accountId, greeting: false })).status).toBe(200);
  expect(wantsChannelPush("bitbonsai", "welcome", GDAY)).toBe(false);
  expect(wantsChannelPush("bitbonsai", "welcome", "Hi there, welcome to #open-chat.")).toBe(true);
  expect(wantsChannelPush("bitbonsai", "someone", GDAY)).toBe(true);
  const other = (db.query("SELECT nick FROM accounts WHERE nick <> 'bitbonsai' COLLATE NOCASE AND hide_greeting = 0 LIMIT 1").get() as { nick: string } | null)?.nick;
  if (other) expect(wantsChannelPush(other, "welcome", GDAY)).toBe(true);
  expect((await patch({ accountId, greeting: true })).status).toBe(200);
  expect(wantsChannelPush("bitbonsai", "welcome", GDAY)).toBe(true);
});

test("the one-time greeting note is unseen by default and seen persists per account", async () => {
  expect((await me()).greetingNoteSeen).toBe(false);
  for (const greetingNoteSeen of [null, "yes", 1]) expect((await patch({ accountId, greetingNoteSeen })).status).toBe(400);
  expect((await patch({ greetingNoteSeen: true })).status).toBe(409);
  expect((await patch({ accountId, greetingNoteSeen: true })).status).toBe(200);
  expect(await me()).toMatchObject({ greetingNoteSeen: true, greeting: true });
  expect((await patch({ accountId, greeting: false, greetingNoteSeen: true })).status).toBe(200);
  expect(await me()).toMatchObject({ greetingNoteSeen: true, greeting: false });
  expect((await patch({ accountId, greeting: true })).status).toBe(200);
});
