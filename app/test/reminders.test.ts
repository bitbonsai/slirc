import "./fixture.ts";

import { beforeEach, describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const reminders = await import("../src/reminders.ts");
const { afterNick } = await import("../src/mention.ts");
const { deliveryChannel, messageLink, reminderAnswer, reminderReply } = await import("../src/helper-bot.ts");

// Noon, 16 September 2026 in the machine's timezone; clock times are local.
const NOW = new Date(2026, 8, 16, 12, 0, 0).getTime();

describe("reminder parsing", () => {
  test("reads relative times", () => {
    expect(reminders.parseReminder("in 30s stretch", NOW)).toEqual({ fireAt: NOW + 30_000, text: "stretch" });
    expect(reminders.parseReminder("in 20m stretch", NOW)).toEqual({ fireAt: NOW + 20 * 60_000, text: "stretch" });
    expect(reminders.parseReminder("in 1 minute now", NOW)).toEqual({ fireAt: NOW + 60_000, text: "now" });
    expect(reminders.parseReminder("in 2 hours tea", NOW)).toEqual({ fireAt: NOW + 2 * 3_600_000, text: "tea" });
    expect(reminders.parseReminder("in 3 days renew domain", NOW)).toEqual({ fireAt: NOW + 3 * 86_400_000, text: "renew domain" });
    expect(reminders.parseReminder("in 1 year", NOW)).toEqual({ fireAt: NOW + 365 * 86_400_000, text: "" });
  });

  test("reads a span written after the text", () => {
    expect(reminders.parseReminder("of this message in 1 year", NOW)).toEqual({ fireAt: NOW + 365 * 86_400_000, text: "of this message" });
    expect(reminders.parseReminder("pick up cake in 2 days", NOW)).toEqual({ fireAt: NOW + 2 * 86_400_000, text: "pick up cake" });
  });

  test("reads clock times", () => {
    expect(reminders.parseReminder("18:45 dinner", NOW)).toEqual({ fireAt: new Date(2026, 8, 16, 18, 45).getTime(), text: "dinner" });
    expect(reminders.parseReminder("at 1pm lunch", NOW)).toEqual({ fireAt: new Date(2026, 8, 16, 13, 0).getTime(), text: "lunch" });
    expect(reminders.parseReminder("tomorrow 9:00 cake", NOW)).toEqual({ fireAt: new Date(2026, 8, 17, 9, 0).getTime(), text: "cake" });
    // A clock time that already passed today is tomorrow.
    expect(reminders.parseReminder("9:30 standup", NOW)).toEqual({ fireAt: new Date(2026, 8, 17, 9, 30).getTime(), text: "standup" });
  });

  test("reads am/pm and a bare hour after 'at' or 'tomorrow'", () => {
    expect(reminders.parseReminder("tomorrow 9am coffee", NOW)).toEqual({ fireAt: new Date(2026, 8, 17, 9, 0).getTime(), text: "coffee" });
    expect(reminders.parseReminder("tomorrow at 9 coffee", NOW)).toEqual({ fireAt: new Date(2026, 8, 17, 9, 0).getTime(), text: "coffee" });
    expect(reminders.parseReminder("at 9 coffee", NOW)).toEqual({ fireAt: new Date(2026, 8, 17, 9, 0).getTime(), text: "coffee" });
    expect(reminders.parseReminder("9pm wind down", NOW)).toEqual({ fireAt: new Date(2026, 8, 16, 21, 0).getTime(), text: "wind down" });
    expect(reminders.parseReminder("12pm lunch", NOW)).toEqual({ fireAt: new Date(2026, 8, 17, 12, 0).getTime(), text: "lunch" });
    expect(reminders.parseReminder("12am midnight", NOW)).toEqual({ fireAt: new Date(2026, 8, 17, 0, 0).getTime(), text: "midnight" });
    expect(reminders.parseReminder("today 15:00 call", NOW)).toEqual({ fireAt: new Date(2026, 8, 16, 15, 0).getTime(), text: "call" });
    // "today" with a time that already passed still lands tomorrow rather than in the past.
    expect(reminders.parseReminder("today 9:00 call", NOW)).toEqual({ fireAt: new Date(2026, 8, 17, 9, 0).getTime(), text: "call" });
  });

  test("accepts unit spellings and casing", () => {
    expect(reminders.parseReminder("in 30 sec stretch", NOW)?.fireAt).toBe(NOW + 30_000);
    expect(reminders.parseReminder("in 30 secs stretch", NOW)?.fireAt).toBe(NOW + 30_000);
    expect(reminders.parseReminder("in 30 seconds stretch", NOW)?.fireAt).toBe(NOW + 30_000);
    expect(reminders.parseReminder("In 10M stretch", NOW)?.fireAt).toBe(NOW + 10 * 60_000);
    expect(reminders.parseReminder("in 90 minutes tea", NOW)?.fireAt).toBe(NOW + 90 * 60_000);
    expect(reminders.parseReminder("in 1h tea", NOW)?.fireAt).toBe(NOW + 3_600_000);
    expect(reminders.parseReminder("in 2 hrs tea", NOW)?.fireAt).toBe(NOW + 2 * 3_600_000);
    expect(reminders.parseReminder("in 1d tea", NOW)?.fireAt).toBe(NOW + 86_400_000);
    expect(reminders.parseReminder("in 2 yrs tea", NOW)?.fireAt).toBe(NOW + 2 * 365 * 86_400_000);
    expect(reminders.parseReminder("in 10minutes tea", NOW)?.fireAt).toBe(NOW + 10 * 60_000);
  });

  test("does not confuse a unit prefix with a word", () => {
    // "in 5 months" is not supported; it must not parse as five minutes.
    expect(reminders.parseReminder("in 5 months renew", NOW)).toBeNull();
    expect(reminders.parseReminder("in 2 weeks renew", NOW)).toBeNull();
    expect(reminders.parseReminder("in 3 hamsters", NOW)).toBeNull();
  });

  test("strips the helper's name and a leading 'me' before parsing", () => {
    expect(afterNick("@remind me in 20m stretch", "remind")).toBe("in 20m stretch");
    expect(afterNick("remind: in 20m stretch", "remind")).toBe("in 20m stretch");
    expect(afterNick("@remind me of this message in 1 year", "remind")).toBe("of this message in 1 year");
    expect(afterNick("@remind list", "remind")).toBe("list");
    // "me" is only stripped as a standalone word.
    expect(afterNick("@remind meeting in 1h", "remind")).toBe("meeting in 1h");
  });

  test("leaves plain text alone", () => {
    for (const text of ["", "buy milk", "5 apples", "in a while", "25:00 tea", "9:60 tea", "tomorrow", "tomorrow morning", "list", "cancel 3"]) {
      expect(reminders.parseReminder(text, NOW)).toBeNull();
    }
  });

  test("describes when it fires", () => {
    expect(reminders.describeWhen(NOW + 30_000, NOW)).toBe("in 30 seconds");
    expect(reminders.describeWhen(NOW + 20 * 60_000, NOW)).toBe("in 20 minutes");
    expect(reminders.describeWhen(NOW + 60_000, NOW)).toBe("in 1 minute");
    expect(reminders.describeWhen(NOW + 3 * 3_600_000, NOW)).toBe("in 3 hours");
    expect(reminders.describeWhen(NOW + 2 * 86_400_000, NOW)).toBe("in 2 days");
    expect(reminders.describeWhen(NOW + 365 * 86_400_000, NOW)).toBe("in 1 year");
    expect(reminders.describeWhen(NOW + 90 * 60_000, NOW)).toBe("in 2 hours");
    expect(reminders.describeWhen(NOW + 36 * 3_600_000, NOW)).toBe("in 2 days");
    // Never "in 0 seconds", even for something already due.
    expect(reminders.describeWhen(NOW - 5_000, NOW)).toBe("in 1 second");
  });
});

describe("reminder replies", () => {
  beforeEach(() => db.query("DELETE FROM reminders").run());

  test("usage for an empty, help, or unparseable request", () => {
    const usage = reminderReply("remind", "bitbonsai", "#untitled", "");
    expect(usage).toContain("@remind in 20m stretch");
    expect(reminderReply("remind", "bitbonsai", "#untitled", "help")).toBe(usage);
    expect(reminderReply("remind", "bitbonsai", "#untitled", "buy milk")).toBe(usage);
    expect(reminders.pendingReminders("bitbonsai")).toEqual([]);
  });

  test("asks for text when only a time was given", () => {
    expect(reminderReply("remind", "bitbonsai", "#untitled", "in 20m")).toBe("Tell me what to remind you about.");
    expect(reminders.pendingReminders("bitbonsai")).toEqual([]);
  });

  test("schedules in the channel where it was asked", () => {
    const reply = reminderReply("remind", "bitbonsai", "#untitled", "in 20m to stretch");
    expect(reply).toMatch(/^Reminder (?:tomorrow )?at \d{1,2}:\d{2} \(in 20 minutes\): stretch$/);
    const rows = reminders.pendingReminders("bitbonsai");
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("#untitled");
    expect(rows[0].text).toBe("stretch");
  });

  test("a reminder asked in a room stores the link back but confirms without it", async () => {
    const link = "https://slirc.test/?room=%23dev&msg=m1";
    const reply = await reminderAnswer("remind", "bitbonsai", "#dev", "in 20m to stretch", undefined, Date.now(), link);
    expect(reply).toMatch(/\(in 20 minutes\): stretch$/);
    expect(reminders.pendingReminders("bitbonsai")[0].text).toBe(`stretch ${link}`);
  });

  test("message links use the public origin and are empty without one", () => {
    const origin = process.env.APP_ORIGIN;
    try {
      process.env.APP_ORIGIN = "https://slirc.test";
      expect(messageLink("#dev", "a/b")).toBe("https://slirc.test/?room=%23dev&msg=a%2Fb");
      delete process.env.APP_ORIGIN;
      expect(messageLink("#dev", "m1")).toBe("");
    } finally {
      if (origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = origin;
    }
  });

  test("drops a leading \"me to\" from the text", () => {
    expect(reminderReply("remind", "bitbonsai", "#untitled", "me to do something in 1m")).toMatch(/\(in 1 minute\): do something$/);
    expect(reminders.pendingReminders("bitbonsai")[0].text).toBe("do something");
  });

  test("lists with positions and cancels by position, only for the asker", () => {
    expect(reminderReply("remind", "bitbonsai", "#untitled", "list")).toBe("No reminders yet. Try @remind in 20m stretch");
    reminderReply("remind", "bitbonsai", "#untitled", "in 20m stretch");
    reminderReply("remind", "bitbonsai", "#dm-bitbonsai-remind", "in 2 hours tea");
    expect(reminderReply("remind", "bitbonsai", "#untitled", "list")).toMatch(/^Your reminders \(2\):\n1\. (?:In 20 minutes, |Tomorrow at )\d{1,2}:\d{2} · stretch\n2\. .+ · tea\nTo cancel one: @remind cancel 1$/);
    // Other people see their own list, and cannot cancel someone else's.
    expect(reminderReply("remind", "igor", "#untitled", "list")).toBe("No reminders yet. Try @remind in 20m stretch");
    expect(reminderReply("remind", "igor", "#untitled", "cancel 1")).toBe("No reminder with that number.");
    expect(reminderReply("remind", "BitBonsai", "#untitled", "cancel #1")).toBe("Cancelled.");
    expect(reminderReply("remind", "bitbonsai", "#untitled", "delete 2")).toBe("No reminder with that number.");
    expect(reminders.pendingReminders("bitbonsai").map((row) => row.text)).toEqual(["tea"]);
  });

  test("list shows six and says how many remain", () => {
    for (let i = 1; i <= 8; i++) reminderReply("remind", "bitbonsai", "#untitled", `in ${i}h item ${i}`);
    const listed = reminderReply("remind", "bitbonsai", "#untitled", "list");
    expect(listed).toContain("…and 2 more");
    expect(listed).not.toContain("item 7");
  });

  test("uses the configured model shape for natural language", async () => {
    const reply = await reminderAnswer("remind", "bitbonsai", "#untitled", "call Mum tomorrow morning", async () => "```json\n{\"action\":\"create\",\"fireAt\":\"2026-09-17T09:00:00Z\",\"text\":\"call Mum\"}\n```", NOW);
    expect(reply).toContain("call Mum");
    expect(reminders.pendingReminders("bitbonsai")[0]).toMatchObject({ channel: "#untitled", text: "call Mum" });
  });

  test("lets natural language list and cancel through validated intents", async () => {
    reminders.addReminder("bitbonsai", "#untitled", NOW + 60_000, "tea");
    expect(await reminderAnswer("remind", "bitbonsai", "#untitled", "what do I have scheduled?", async () => '{"action":"list"}', NOW)).toContain("tea");
    expect(await reminderAnswer("remind", "bitbonsai", "#untitled", "forget number one", async () => '{"action":"cancel","number":1}', NOW)).toBe("Cancelled.");
  });
});

describe("reminder list format", () => {
  // Thursday 8 October 2026, 12:00 UTC.
  const AT = Date.UTC(2026, 9, 8, 12, 0);
  beforeEach(() => db.query("DELETE FROM reminders").run());

  test("says when as a friendly relative and the clock time in the zone", () => {
    expect(reminders.describeListWhen(AT + 30_000, "UTC", AT)).toBe("In 30 seconds, 12:00");
    expect(reminders.describeListWhen(AT + 20 * 60_000, "UTC", AT)).toBe("In 20 minutes, 12:20");
    expect(reminders.describeListWhen(AT + 3 * 3_600_000, "UTC", AT)).toBe("In 3 hours, 15:00");
    expect(reminders.describeListWhen(Date.UTC(2026, 9, 9, 9, 0), "UTC", AT)).toBe("Tomorrow at 9:00");
    expect(reminders.describeListWhen(Date.UTC(2026, 9, 12, 9, 5), "UTC", AT)).toBe("Monday at 9:05");
    expect(reminders.describeListWhen(Date.UTC(2026, 9, 20, 18, 0), "UTC", AT)).toBe("20 Oct at 18:00");
    expect(reminders.describeListWhen(Date.UTC(2027, 0, 3, 8, 0), "UTC", AT)).toBe("3 Jan 2027 at 8:00");
    expect(reminders.describeListWhen(AT - 60_000, "UTC", AT)).toBe("Due at 11:59");
  });

  test("the confirmation says the clock time, with the relative only for today", () => {
    expect(reminders.describeSetWhen(AT + 60_000, "UTC", AT)).toBe("at 12:01 (in 1 minute)");
    expect(reminders.describeSetWhen(Date.UTC(2026, 9, 9, 9, 0), "UTC", AT)).toBe("tomorrow at 9:00");
    expect(reminders.describeSetWhen(Date.UTC(2026, 9, 12, 9, 5), "UTC", AT)).toBe("Monday at 9:05");
    expect(reminders.describeSetWhen(Date.UTC(2026, 9, 20, 18, 0), "UTC", AT)).toBe("20 Oct at 18:00");
    expect(reminders.describeSetWhen(Date.UTC(2027, 0, 3, 8, 0), "UTC", AT)).toBe("3 Jan 2027 at 8:00");
  });

  test("today and tomorrow follow the asker's zone", () => {
    const late = Date.UTC(2026, 9, 8, 15, 30);
    expect(reminders.describeListWhen(late, "UTC", AT)).toBe("In 4 hours, 15:30");
    expect(reminders.describeListWhen(late, "Asia/Tokyo", AT)).toBe("Tomorrow at 0:30");
    expect(reminders.describeListWhen(AT + 20 * 60_000, "America/Los_Angeles", AT)).toBe("In 20 minutes, 5:20");
  });

  test("one per line, readable part first, message link last", async () => {
    db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at, time_zone) VALUES ('lena', 'lena@example.com', 'member', 'human', 1, 1, 'Europe/Amsterdam') ON CONFLICT DO NOTHING").run();
    reminders.addReminder("lena", "#dm-lena-remind", AT + 20 * 60_000, '"can you review this mention context?" https://slirc.test/?room=%23demo&msg=m1');
    reminders.addReminder("lena", "#dm-lena-remind", Date.UTC(2026, 9, 9, 7, 0), "stretch");
    reminders.addReminder("lena", "#dm-lena-remind", Date.UTC(2026, 9, 9, 8, 0), "https://slirc.test/dm/igor?msg=m2");
    expect(await reminderAnswer("remind", "lena", "#dm-lena-remind", "list", undefined, AT)).toBe([
      "Your reminders (3):",
      '1. In 20 minutes, 14:20 · "can you review this mention context?" · https://slirc.test/?room=%23demo&msg=m1',
      "2. Tomorrow at 9:00 · stretch",
      "3. Tomorrow at 10:00 · https://slirc.test/dm/igor?msg=m2",
      "To cancel one: @remind cancel 1",
    ].join("\n"));
    // Numbers match `cancel N`: the second line is the one cancelled.
    expect(reminderReply("remind", "lena", "#dm-lena-remind", "cancel 2")).toBe("Cancelled.");
    expect(reminders.pendingReminders("lena").map((row) => row.text)).not.toContain("stretch");
  });

  test("clips long text so a line stays short", async () => {
    reminders.addReminder("lena", "#dm-lena-remind", AT + 60_000, "x".repeat(400));
    const line = (await reminderAnswer("remind", "lena", "#dm-lena-remind", "list", undefined, AT)).split("\n")[1]!;
    expect(line).toEndWith("…");
    expect(line.length).toBeLessThan(240);
  });
});

describe("reminder delivery target", () => {
  const reminder = { nick: "BitBonsai", channel: "#Untitled" };

  test("only the asker's provisioned DM, even when the helper is in the room it was asked in", async () => {
    const rooms = await import("../src/rooms.ts");
    expect(deliveryChannel(reminder, new Set(["#untitled"]), "remind")).toBeNull();
    rooms.createDirectConversation("bitbonsai", "remind", "bitbonsai", false);
    expect(deliveryChannel(reminder, new Set(["#untitled", "#dm-bitbonsai-remind"]), "remind")).toBeNull();
    rooms.createDirectConversation("bitbonsai", "remind", "bitbonsai");
    expect(deliveryChannel(reminder, new Set(["#untitled", "#dm-bitbonsai-remind"]), "remind")).toBe("#dm-bitbonsai-remind");
  });
});

test("a day span followed by a clock time lands at that time that day", () => {
  const now = Date.UTC(2026, 9, 13, 15, 19); // Tuesday 17:19 in Amsterdam
  const at = reminders.parseReminder("in 3 days 14:30 dentist", now, "Europe/Amsterdam")!;
  expect(new Date(at.fireAt).toISOString()).toBe("2026-10-16T12:30:00.000Z");
  expect(at.text).toBe("dentist");
  expect(reminders.parseReminder("2d at 9 standup", now, "UTC")!.fireAt).toBe(Date.UTC(2026, 9, 15, 9, 0));
  expect(reminders.parseReminder("1d 9pm call", now, "UTC")!.fireAt).toBe(Date.UTC(2026, 9, 14, 21, 0));
  // Minutes and hours keep the plain span, and a bare number stays text.
  expect(reminders.parseReminder("in 20m 14:30 sync", now, "UTC")).toEqual({ fireAt: now + 20 * 60_000, text: "14:30 sync" });
  expect(reminders.parseReminder("in 3 days 5 apples", now, "UTC")).toEqual({ fireAt: now + 3 * 86_400_000, text: "5 apples" });
});

test("absolute times and confirmations follow the asker's time zone", () => {
  const now = Date.UTC(2026, 9, 7, 19, 0); // 21:00 in Amsterdam (CEST), 15:00 in New York (EDT)
  const ams = reminders.parseReminder("tomorrow 9:00 call", now, "Europe/Amsterdam")!;
  expect(new Date(ams.fireAt).toISOString()).toBe("2026-10-08T07:00:00.000Z");
  const ny = reminders.parseReminder("at 18:30 dinner", now, "America/New_York")!;
  expect(new Date(ny.fireAt).toISOString()).toBe("2026-10-07T22:30:00.000Z");
  // Past today in that zone rolls to tomorrow, across the DST change at the end of October.
  const late = reminders.parseReminder("at 9:00 x", Date.UTC(2026, 9, 24, 12, 0), "Europe/Amsterdam")!;
  expect(new Date(late.fireAt).toISOString()).toBe("2026-10-25T08:00:00.000Z");
  expect(reminders.describeSetWhen(ams.fireAt, "Europe/Amsterdam", now)).toBe("tomorrow at 9:00");
  expect(reminders.describeSetWhen(Date.UTC(2026, 9, 7, 19, 20), "Europe/Amsterdam", now)).toBe("at 21:20 (in 20 minutes)");
  // Relative spans ignore the zone.
  expect(reminders.parseReminder("in 1 min hi", now, "Asia/Tokyo")!.fireAt).toBe(now + 60_000);
});

test("account time zones are validated and fall back to the instance default", () => {
  expect(reminders.validTimeZone("Europe/Amsterdam")).toBe(true);
  expect(reminders.validTimeZone("Mars/Olympus")).toBe(false);
  expect(reminders.validTimeZone(42)).toBe(false);
  db.query("INSERT OR IGNORE INTO accounts (nick, email, role, created_at, account_id) VALUES ('tzuser', 'tz@example.com', 'member', 1, 'acct-tz')").run();
  expect(reminders.userTimeZone("tzuser")).toBe(reminders.defaultTimeZone());
  expect(reminders.setUserTimeZone("acct-tz", "Mars/Olympus")).toBe(false);
  expect(reminders.setUserTimeZone("acct-tz", "America/Sao_Paulo")).toBe(true);
  expect(reminders.userTimeZone("TZUSER")).toBe("America/Sao_Paulo");
});

test("a leading span works without 'in', and plain counts still are not times", () => {
  const now = Date.UTC(2026, 9, 7, 19, 0);
  expect(reminders.parseReminder("1min test", now)).toEqual({ fireAt: now + 60_000, text: "test" });
  expect(reminders.parseReminder("2 hours stretch", now)).toEqual({ fireAt: now + 2 * 3_600_000, text: "stretch" });
  expect(reminders.parseReminder("5 apples", now)).toBeNull();
});
