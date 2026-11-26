// POST /api/reminders: /remind from the app sets the reminder directly and answers with the
// confirmation for a notice. No IRC: the asker's remind DM already exists.

import "./fixture.ts";

const ORIGIN = "https://slirc.test";
process.env.APP_ORIGIN = ORIGIN;

import { createHash } from "node:crypto";
import { beforeAll, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { REMIND_PRESETS, reminderAbout } = await import("../client/message-actions.ts");

const token = "remind-route-session";
const headers = (extra: Record<string, string> = {}) => ({
  Cookie: `slirc_session=${token}`, "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Remind": "1", ...extra,
});
const post = (body: unknown, extra?: Record<string, string>) =>
  app.request("/api/reminders", { method: "POST", headers: headers(extra), body: JSON.stringify(body) });

beforeAll(() => {
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('rita', 'rita@example.com', 'member', 'human', 1, 1)").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'rita', ?)").run(createHash("sha256").update(token).digest("hex"), Date.now());
  db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick, provision_ready) VALUES ('#dm-remind-rita', 'remind', 'rita', 1)").run();
});

test("cross-site, signed-out and empty requests are refused before anything is stored", async () => {
  const before = (db.query("SELECT COUNT(*) n FROM reminders").get() as { n: number }).n;
  expect((await post({ text: "in 5m x" }, { Origin: "https://evil.test" })).status).toBe(403);
  expect((await post({ text: "in 5m x" }, { "X-Slirc-Remind": "" })).status).toBe(403);
  expect((await app.request("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Remind": "1" }, body: "{}" })).status).toBe(401);
  expect((await post({ text: "   " })).status).toBe(400);
  expect((db.query("SELECT COUNT(*) n FROM reminders").get() as { n: number }).n).toBe(before);
});

test("each Remind me preset is read locally and keeps the quote and link as the text", async () => {
  const about = reminderAbout('Ship the "beta" build, then tell everyone in 5 min', "https://slirc.test/?room=%23dev&msg=s1");
  for (const preset of REMIND_PRESETS) {
    const before = Date.now();
    const response = await post({ text: `${preset.when} ${about}` });
    expect(response.status).toBe(200);
    expect((await response.json() as { reply: string }).reply).toStartWith("Reminder ");
    const row = db.query("SELECT fire_at, text FROM reminders WHERE nick = 'rita' ORDER BY id DESC").get() as { fire_at: number; text: string };
    expect(row.text).toBe(about);
    if (preset.when === "in 20m") expect(row.fire_at - before).toBeWithin(20 * 60_000 - 1_000, 20 * 60_000 + 1_000);
    if (preset.when === "in 1h") expect(row.fire_at - before).toBeWithin(3_600_000 - 1_000, 3_600_000 + 1_000);
    if (preset.when === "tomorrow 9:00") expect(row.fire_at - before).toBeWithin(0, 2 * 86_400_000);
  }
});

test("Custom… stores the exact picked time and skips reading a time from the text", async () => {
  const about = reminderAbout("Call back in 5 min", "https://slirc.test/?room=%23dev&msg=s2");
  const fireAt = Date.now() + 3 * 86_400_000 + 1_234;
  const response = await post({ text: about, fireAt });
  expect(response.status).toBe(200);
  const reply = (await response.json() as { reply: string }).reply;
  expect(reply).toMatch(/^Reminder \w+ at \d{1,2}:\d{2}: /);
  expect(reply).toEndWith(`: ${about}`);
  const row = db.query("SELECT channel, fire_at, text FROM reminders WHERE nick = 'rita' ORDER BY id DESC").get();
  expect(row).toEqual({ channel: "#dm-remind-rita", fire_at: fireAt, text: about });
});

test("a past, far-off or non-number fireAt is refused before anything is stored", async () => {
  const before = (db.query("SELECT COUNT(*) n FROM reminders").get() as { n: number }).n;
  const text = reminderAbout("x", "https://slirc.test/?room=%23dev&msg=s3");
  for (const fireAt of [Date.now() - 1_000, Date.now() + 366 * 86_400_000, String(Date.now() + 60_000), null, true]) {
    const response = await post({ text, fireAt });
    expect(response.status).toBe(400);
  }
  expect((await (await post({ text, fireAt: Date.now() - 1_000 })).json() as { error: string }).error).toBe("Pick a time in the future.");
  expect((await post({ text: "", fireAt: Date.now() + 60_000 })).status).toBe(400);
  expect((db.query("SELECT COUNT(*) n FROM reminders").get() as { n: number }).n).toBe(before);
});
