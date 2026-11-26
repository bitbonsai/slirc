// Reminders end to end: set one from the composer (/remind) and one from Remind me, list them,
// cancel one, then let the helper fire the other into the asker's remind DM and settle on its echo.
// Routes drive the setting; the helper's delivery tick runs with a fake IRC transport.
import "./fixture.ts";

const ORIGIN = "https://slirc.test";
process.env.APP_ORIGIN = ORIGIN;

import { createHash } from "node:crypto";
import { expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { ackReminderEcho, deliverDueReminders } = await import("../src/helper-bot.ts");
const { pendingReminders } = await import("../src/reminders.ts");

const DM = "#dm-remind-noor";
const remind = async (body: unknown) => {
  const response = await app.request("/api/reminders", {
    method: "POST",
    headers: { Cookie: "slirc_session=noor-e2e", "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Remind": "1" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ reply: string; open?: string }>;
};

db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES ('noor', 'noor@example.test', 'member', 'human', 1, 1)").run();
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'noor', ?)").run(createHash("sha256").update("noor-e2e").digest("hex"), Date.now());
db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick, provision_ready) VALUES (?, 'noor', 'remind', 1)").run(DM);

test("set from the composer and from Remind me, list, cancel, then fire into the remind DM", async () => {
  expect((await remind({ text: "in 2h water the plants" })).reply).toStartWith("Reminder ");
  const fireAt = Date.now() + 60_000;
  expect((await remind({ text: "> ship it\nhttps://slirc.test/m/1", fireAt })).reply).toMatch(/^Reminder (?:tomorrow )?at /);
  expect(pendingReminders("noor").map((row) => row.channel)).toEqual([DM, DM]);

  const listed = await remind({ text: "list" });
  expect(listed.open).toBe("remind");
  expect(listed.reply).toContain("water the plants");
  expect(listed.reply).toContain("ship it");

  // List order is by fire time, so the Remind me one (one minute out) is first.
  const cancelled = await remind({ text: "cancel 2" });
  expect(cancelled.reply.toLowerCase()).toContain("cancel");
  const left = pendingReminders("noor");
  expect(left).toHaveLength(1);
  expect(left[0].text).toContain("ship it");

  // Not due yet: the helper sends nothing.
  const sent: string[] = [];
  const transport = { canEcho: true, cid: () => "e2e-cid", send: (line: string) => { sent.push(line); return true; } };
  expect(deliverDueReminders(transport, new Set([DM]), "remind")).toBe(0);

  db.query("UPDATE reminders SET fire_at = ? WHERE id = ?").run(Date.now() - 1_000, left[0].id);
  expect(deliverDueReminders(transport, new Set([DM]), "remind")).toBe(1);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toStartWith(`@+slirc/cid=e2e-cid PRIVMSG ${DM} :`);
  expect(sent[0]).toContain("ship it");
  expect(sent[0]).not.toContain("water the plants");

  const body = sent[0].slice(sent[0].indexOf(" :") + 2);
  expect(ackReminderEcho({ command: "PRIVMSG", params: [DM, body], tags: { "+slirc/cid": "e2e-cid", account: "remind", msgid: "m-e2e", time: "t-e2e" }, prefix: "remind!u@h" }, "remind")).toBe(true);
  expect(pendingReminders("noor")).toEqual([]);
  expect((await remind({ text: "list" })).reply).not.toContain("ship it");
});
