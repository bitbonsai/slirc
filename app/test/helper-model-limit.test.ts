import "./fixture.ts";

import { describe, expect, test } from "bun:test";

process.env.SLIRC_HELPER_DAILY_LIMIT = "2";
const { REMINDER_LIMIT_REPLY, helpReply, modelLimitReply, reminderAnswer, underModelLimit } = await import("../src/helper-bot.ts");
const { helperDailyLimit } = await import("../src/config.ts");

// helpReply reads the clock, so the budget runs on real time here.
const NOW = Date.now();
const DAY = 24 * 60 * 60_000;

describe("helper model budget", () => {
  test("one account shares a daily budget across both bots and every nick it uses", async () => {
    let calls = 0;
    const ask = async () => { calls++; return '{"action":"help"}'; };
    await reminderAnswer("remind", "alice", "#dm-alice-remind", "sometime soonish call Sam", ask, NOW, "", "alice");
    await reminderAnswer("remind", "alice_", "#dm-alice-remind", "sometime soonish call Sam", ask, NOW, "", "Alice");
    expect(calls).toBe(2);

    const blocked = await reminderAnswer("remind", "alice", "#dm-alice-remind", "sometime soonish call Sam", ask, NOW, "", "alice");
    expect(calls).toBe(2);
    expect(blocked.startsWith(REMINDER_LIMIT_REPLY)).toBe(true);
    // Short forms never reach the model, so they keep working.
    expect(await reminderAnswer("remind", "alice", "#dm-alice-remind", "in 20m stretch", ask, NOW, "", "alice")).toStartWith("Reminder");

    expect(await helpReply("alice-phone", "how do invites work?", false, undefined, "alice")).toEqual({ react: false, text: modelLimitReply() });
    expect(await helpReply("alice", "help")).not.toEqual({ react: false, text: modelLimitReply() });

    // Another account has its own budget, and the day rolls over.
    expect(underModelLimit("bob", NOW)).toBe(true);
    expect(underModelLimit("alice", NOW + DAY + 1)).toBe(true);
  });

  test("the limit comes from SLIRC_HELPER_DAILY_LIMIT", () => {
    const saved = process.env.SLIRC_HELPER_DAILY_LIMIT;
    try {
      delete process.env.SLIRC_HELPER_DAILY_LIMIT;
      expect(helperDailyLimit()).toBe(100);
      process.env.SLIRC_HELPER_DAILY_LIMIT = "250";
      expect(helperDailyLimit()).toBe(250);
      process.env.SLIRC_HELPER_DAILY_LIMIT = "0";
      expect(() => helperDailyLimit()).toThrow("SLIRC_HELPER_DAILY_LIMIT");
    } finally {
      process.env.SLIRC_HELPER_DAILY_LIMIT = saved;
    }
  });
});
