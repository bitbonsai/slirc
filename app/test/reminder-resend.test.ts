import "./fixture.ts";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "slirc-reminder-resend-"));
process.env.DB_PATH = join(dir, "chat.sqlite");
const { db } = await import("../src/db.ts");
const reminders = await import("../src/reminders.ts");
const { connectionGoneSince, deliverDueReminders, mayAutoResend, reminderReply, resendUncertainReminder, scanReminderHistory, HELPER_GONE_MS, RECONCILE_PAGE_SIZE } = await import("../src/helper-bot.ts");

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DM = "#dm-bitbonsai-remind";
const ERGO = "Wed, 07 Oct 2026 17:12:59 UTC";
// A connection id from an earlier process: gone since this process started.
const OLD_CONN = "deadbeef:1";
beforeEach(() => {
  db.query("DELETE FROM reminders").run();
  db.query("INSERT OR IGNORE INTO direct_conversations (channel, first_nick, second_nick, provision_ready) VALUES (?, 'bitbonsai', 'remind', 1)").run(DM);
});

const transporter = (cid: string, conn = OLD_CONN, ergoStarted: string | null = ERGO) => {
  const sent: string[] = [];
  return { sent, canEcho: true, cid: () => cid, ergoStarted, conn, send: (line: string) => { sent.push(line); return true; } };
};

// A reminder that fired from an earlier process and was never confirmed.
function uncertain(cid: string, ergoStarted: string | null = ERGO) {
  reminders.addReminder("bitbonsai", "#untitled", Date.now() - 1_000, "call Sam");
  expect(deliverDueReminders(transporter(cid, OLD_CONN, ergoStarted), new Set([DM]), "remind")).toBe(1);
  reminders.markSendingUncertain();
  return reminders.reminderByCid(cid)!;
}

const later = () => Date.now() + HELPER_GONE_MS + 1;
const gone = () => connectionGoneSince(OLD_CONN);

describe("automatic resend of an uncertain reminder", () => {
  test("an attempt records Ergo's start time and its connection", () => {
    const row = uncertain("cid-evidence");
    expect(row.ergo_started).toBe(ERGO);
    expect(row.attempt_conn).toBe(OLD_CONN);
    expect(row.state).toBe("uncertain");
  });

  test("all three conditions resend exactly once with the same CID and body", async () => {
    const row = uncertain("cid-all");
    const proof = await scanReminderHistory(row, "remind", async () => [], Date.now() + 5_000);
    expect(proof).toBe("absent");
    expect(mayAutoResend(row, ERGO, gone(), proof, later())).toBe(true);
    const live = transporter("unused", "live:1");
    expect(resendUncertainReminder(row, live)).toBe(true);
    expect(live.sent).toEqual([`@+slirc/cid=cid-all PRIVMSG ${DM} :call Sam`]);
    const after = reminders.reminderByCid("cid-all")!;
    expect(after.state).toBe("sending");
    expect(after.resent_at).not.toBeNull();
    // Unconfirmed again: never a second automatic resend.
    reminders.markSendingUncertain();
    const again = reminders.reminderByCid("cid-all")!;
    expect(mayAutoResend(again, ERGO, gone(), "absent", later())).toBe(false);
    expect(resendUncertainReminder(row, live)).toBe(false);
    expect(live.sent).toHaveLength(1);
  });

  test("an Ergo restart since the attempt means no resend", () => {
    const row = uncertain("cid-restart");
    expect(mayAutoResend(row, "Thu, 08 Oct 2026 09:00:00 UTC", gone(), "absent", later())).toBe(false);
    expect(mayAutoResend(row, null, gone(), "absent", later())).toBe(false);
    expect(mayAutoResend(uncertain("cid-unknown-ergo", null), ERGO, gone(), "absent", later())).toBe(false);
  });

  test("a sending connection that may still be on Ergo means no resend", () => {
    const row = uncertain("cid-live");
    // Still within Ergo's disconnect timeout since the old process died.
    expect(mayAutoResend(row, ERGO, gone(), "absent", gone()! + HELPER_GONE_MS - 1)).toBe(false);
    // A connection this process still holds has no gone time.
    expect(mayAutoResend(row, ERGO, null, "absent", later())).toBe(false);
  });

  test("history that holds the message settles it and never resends", async () => {
    const row = uncertain("cid-found");
    const echo = { command: "PRIVMSG", params: [DM, "call Sam"], tags: { "+slirc/cid": "cid-found", account: "remind", msgid: "m1", time: new Date().toISOString() }, prefix: "remind!u@h" };
    const proof = await scanReminderHistory(row, "remind", async () => [echo], Date.now() + 5_000);
    expect(proof).toBe("found");
    expect(reminders.reminderByCid("cid-found")!.state).toBe("delivered");
    expect(mayAutoResend(row, ERGO, gone(), proof, later())).toBe(false);
  });

  test("a partial, timed-out or capped history scan proves nothing", async () => {
    const row = uncertain("cid-partial");
    const timedOut = await scanReminderHistory(row, "remind", async () => { throw new Error("history page timed out"); }, Date.now() + 5_000);
    expect(timedOut).toBe("unknown");
    expect(mayAutoResend(row, ERGO, gone(), timedOut, later())).toBe(false);
    // Full pages newer than the attempt until the page cap: not a full scan.
    const full = Array.from({ length: RECONCILE_PAGE_SIZE }, (_, index) => ({ command: "PRIVMSG", params: [DM, `filler ${index}`], tags: { account: "someone", time: new Date(Date.now() + 1_000).toISOString() }, prefix: "someone!u@h" }));
    const capped = await scanReminderHistory(row, "remind", async () => full, Date.now() + 5_000);
    expect(capped).toBe("unknown");
    expect(await scanReminderHistory(row, "remind", async () => [], Date.now() - 1)).toBe("unknown");
    expect(reminders.reminderByCid("cid-partial")!.state).toBe("uncertain");
  });

  test("a full page that reaches back past the attempt is a complete scan", async () => {
    const row = uncertain("cid-back");
    const old = Array.from({ length: RECONCILE_PAGE_SIZE }, (_, index) => ({ command: "PRIVMSG", params: [DM, `old ${index}`], tags: { account: "someone", time: new Date(Date.now() - 3_600_000 + index).toISOString() }, prefix: "someone!u@h" }));
    expect(await scanReminderHistory(row, "remind", async () => old, Date.now() + 5_000)).toBe("absent");
  });
});

describe("owner Send again", () => {
  test("the list marks it and resend sends it again under a new CID", () => {
    uncertain("cid-owner");
    const list = reminderReply("remind", "bitbonsai", DM, "list");
    expect(list).toContain("may not have sent");
    expect(list).toContain("To send one again: @remind resend 1");
    expect(reminderReply("remind", "igor", DM, "resend 1")).toBe("No reminder with that number.");
    expect(reminderReply("remind", "bitbonsai", DM, "resend 1")).toBe("Sending it again now.");
    expect(reminders.reminderByCid("cid-owner")).toBeNull();
    const t = transporter("cid-owner-2", "live:2");
    expect(deliverDueReminders(t, new Set([DM]), "remind")).toBe(1);
    expect(t.sent).toEqual([`@+slirc/cid=cid-owner-2 PRIVMSG ${DM} :call Sam`]);
    expect(reminderReply("remind", "bitbonsai", DM, "resend 1")).toBe("That one is sending now.");
  });

  test("a reminder that has not fired is not resent and the hint stays away", () => {
    reminders.addReminder("bitbonsai", "#untitled", Date.now() + 60_000, "later");
    expect(reminderReply("remind", "bitbonsai", DM, "list")).not.toContain("resend");
    expect(reminderReply("remind", "bitbonsai", DM, "resend 1")).toBe("That one hasn't fired yet.");
    expect(reminderReply("remind", "bitbonsai", DM, "resend 2")).toBe("No reminder with that number.");
  });
});
