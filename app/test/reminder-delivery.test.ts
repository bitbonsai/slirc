import "./fixture.ts";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real file, not :memory:, so a spawned process reads the same rows. Reminder recovery is a
// cross-process behavior: a crash survivor must be reconciled by the next process, not by memory.
const dir = mkdtempSync(join(tmpdir(), "slirc-reminder-delivery-"));
process.env.DB_PATH = join(dir, "chat.sqlite");
const { db } = await import("../src/db.ts");
const reminders = await import("../src/reminders.ts");
const { afterNick } = await import("../src/mention.ts");
const { ackReminderEcho, deliveredReminderText, deliverDueReminders, dropReplayMessage, reminderReply, scanReminderHistory, RECONCILE_PAGE_SIZE } = await import("../src/helper-bot.ts");

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Reminders fire only in the asker's DM with remind, so every test has that DM mapped and joined.
const DM = "#dm-bitbonsai-remind";
beforeEach(() => {
  db.query("DELETE FROM reminders").run();
  db.query("INSERT OR IGNORE INTO direct_conversations (channel, first_nick, second_nick, provision_ready) VALUES (?, 'bitbonsai', 'remind', 1)").run(DM);
});

const past = (offset = 1_000) => Date.now() - offset;
const future = () => Date.now() + 60_000;
// The helper is in the room the reminder was asked in as well as the DM.
const joinedRoom = () => new Set(["#untitled", DM]);
// A fixed-cid fake transport. The CID is what the persisted attempt is keyed on.
const transporter = (cid: string, ok = true, canEcho = true) => {
  const sent: string[] = [];
  return { sent, canEcho, cid: () => cid, send: (line: string) => { sent.push(line); return ok; } };
};
const message = (params: string[], tags: Record<string, string> = {}, prefix = "remind!u@h") => ({ command: "PRIVMSG", params, tags, prefix });
const echo = (cid: string, text = "call") => message([DM, text], { "+slirc/cid": cid, account: "remind", msgid: `m-${cid}`, time: `t-${cid}` });

// Runs a script through the app's own modules in a fresh OS process. dbPath defaults to the shared
// fixture; the old-schema migration test points it at an isolated file.
function freshProcess(script: string, dbPath = process.env.DB_PATH): string {
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, DB_PATH: dbPath, ERGO_API_MOCK: "true" },
    encoding: "utf8",
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout.trim();
}

// A child that claims the due row and dies. `evidence` set means the line reached the wire first.
function crashScript(cid: string, evidence?: string): string {
  const send = evidence
    ? `(line) => { fs.appendFileSync(${JSON.stringify(evidence)}, line + '\\n'); process.exit(0); }`
    : `() => { process.exit(0); }`;
  return `const fs = await import('node:fs');
    const { deliverDueReminders } = await import('./src/helper-bot.ts');
    deliverDueReminders({ canEcho: true, cid: () => ${JSON.stringify(cid)}, send: ${send} }, new Set(['#untitled', ${JSON.stringify(DM)}]), 'remind');`;
}

describe("reminder confirmation and dispatch", () => {
  test("dispatch claims then settles only on a validated echo; a duplicate echo is harmless", () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "call");
    const t = transporter("cid-1");
    expect(deliverDueReminders(t, joinedRoom(), "remind")).toBe(1);
    expect(t.sent).toEqual(["@+slirc/cid=cid-1 PRIVMSG #dm-bitbonsai-remind :call"]);
    expect(reminders.pendingReminders("bitbonsai")[0].state).toBe("sending");
    // A send is not an ack: nothing is due again, but nothing is marked delivered either.
    expect(reminders.dueReminders()).toEqual([]);
    expect(ackReminderEcho(echo("cid-1"), "remind")).toBe(true);
    const deliveredAt = reminders.reminderByCid("cid-1")!.delivered_at;
    expect(reminders.reminderByCid("cid-1")!.state).toBe("delivered");
    expect(ackReminderEcho(echo("cid-1"), "remind")).toBe(false);
    expect(reminders.reminderByCid("cid-1")!.delivered_at).toBe(deliveredAt);
    expect(reminders.dueReminders()).toEqual([]);
  });

  test("without a negotiated echo capability the helper never takes the write", () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "call");
    const t = transporter("cid-2", true, false);
    expect(deliverDueReminders(t, joinedRoom(), "remind")).toBe(0);
    expect(t.sent).toEqual([]);
    expect(reminders.dueReminders()).toHaveLength(1);
    expect(reminders.pendingReminders("bitbonsai")[0].state).toBe("pending");
  });

  test("a proven pre-write refusal returns the row to pending", () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "call");
    const t = transporter("cid-3", false, true);
    expect(deliverDueReminders(t, joinedRoom(), "remind")).toBe(0);
    expect(t.sent).toHaveLength(1);
    expect(reminders.reminderByCid("cid-3")).toBeNull();
    expect(reminders.pendingReminders("bitbonsai")[0].state).toBe("pending");
    expect(reminders.dueReminders()).toHaveLength(1);
  });

  test("frozen body is the sanitized wire body, so a newline-containing reminder can be acked", () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "line one\nline two");
    const t = transporter("cid-newline");
    expect(deliverDueReminders(t, joinedRoom(), "remind")).toBe(1);
    // IrcClient.send folds the newline to a space; the persisted body must be what actually went out.
    expect(reminders.reminderByCid("cid-newline")!.body).toBe("line one line two");
    expect(t.sent).toEqual(["@+slirc/cid=cid-newline PRIVMSG #dm-bitbonsai-remind :line one line two"]);
    expect(ackReminderEcho(message([DM, "line one line two"], { "+slirc/cid": "cid-newline", account: "remind" }), "remind")).toBe(true);
    expect(reminders.reminderByCid("cid-newline")!.state).toBe("delivered");
  });

  test("a Remind me reminder fires as a quote line with its link after it, and acks on that body", () => {
    const link = "https://slirc.test/?room=%23demo-dev&msg=jhj7rph42jxsc4hgdaqtxdtyhe";
    reminders.addReminder("bitbonsai", "#untitled", past(), `"@bitbonsai can you review this mention context?" ${link}`);
    const t = transporter("cid-quote");
    expect(deliverDueReminders(t, joinedRoom(), "remind")).toBe(1);
    expect(t.sent).toEqual([`@+slirc/cid=cid-quote PRIVMSG ${DM} :> @bitbonsai can you review this mention context? ${link}`]);
    expect(ackReminderEcho(message([DM, `> @bitbonsai can you review this mention context? ${link}`], { "+slirc/cid": "cid-quote", account: "remind" }), "remind")).toBe(true);
    // Anything else is delivered as written.
    expect(deliveredReminderText("stretch")).toBe("stretch");
    expect(deliveredReminderText(link)).toBe(link);
    expect(deliveredReminderText('call "Mum" later')).toBe('call "Mum" later');
  });

  test("overlapping ticks claim a row once", () => {
    const id = reminders.addReminder("bitbonsai", "#untitled", past(), "call");
    expect(reminders.claimReminder(id, "cid-a", "#untitled", "@bitbonsai call")).toBe(true);
    expect(reminders.claimReminder(id, "cid-b", "#untitled", "@bitbonsai call")).toBe(false);
    expect(reminders.dueReminders()).toEqual([]);
    expect(deliverDueReminders(transporter("cid-c"), joinedRoom(), "remind")).toBe(0);
  });

  test("a socket throw after a possible write stays uncertain, never pending", () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "throw");
    const throwing = { canEcho: true, cid: () => "cid-throw", send: () => { throw new Error("socket died"); } };
    expect(deliverDueReminders(throwing, joinedRoom(), "remind")).toBe(0);
    expect(reminders.reminderByCid("cid-throw")!.state).toBe("sending");
    expect(reminders.dueReminders()).toEqual([]);
    reminders.markSendingUncertain();
    expect(reminders.reminderByCid("cid-throw")!.state).toBe("uncertain");
  });

  test("a live send whose echo never arrives ages into visible uncertainty without resending", () => {
    const id = reminders.addReminder("bitbonsai", "#untitled", past(), "stale");
    expect(deliverDueReminders(transporter("cid-stale"), joinedRoom(), "remind")).toBe(1);
    expect(reminders.markStaleSendingUncertain(Date.now() + 1)).toBe(1);
    expect(reminders.reminderByCid("cid-stale")!.state).toBe("uncertain");
    expect(reminders.dueReminders()).toEqual([]);
    expect(id).toBeGreaterThan(0);
  });

  test("a reminder asked in a channel remind is in fires in the DM, never the channel", () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "stretch");
    const t = transporter("cid-dm");
    expect(deliverDueReminders(t, joinedRoom(), "remind")).toBe(1);
    expect(t.sent).toEqual([`@+slirc/cid=cid-dm PRIVMSG ${DM} :stretch`]);
    expect(reminders.reminderByCid("cid-dm")!.target).toBe(DM);
    // An echo in the channel is not this attempt; only the DM echo settles it.
    expect(ackReminderEcho(message(["#untitled", "@bitbonsai stretch"], { "+slirc/cid": "cid-dm", account: "remind" }), "remind")).toBe(false);
    expect(ackReminderEcho(echo("cid-dm", "stretch"), "remind")).toBe(true);
    expect(deliverDueReminders(transporter("cid-dm-2"), joinedRoom(), "remind")).toBe(0);
  });

  test("an old pending row stored with a channel target goes to the DM", () => {
    db.query("INSERT INTO reminders (nick, channel, fire_at, text, created_at) VALUES ('bitbonsai', '#Untitled', ?, 'legacy', ?)").run(past(), past());
    const t = transporter("cid-legacy");
    expect(deliverDueReminders(t, joinedRoom(), "remind")).toBe(1);
    expect(t.sent).toEqual([`@+slirc/cid=cid-legacy PRIVMSG ${DM} :legacy`]);
  });

  test("an attempt frozen on a channel before DM-only delivery keeps its target and is never resent", () => {
    const id = reminders.addReminder("bitbonsai", "#untitled", past(), "frozen");
    // Claimed by an older build that still posted in the room it was asked in.
    expect(reminders.claimReminder(id, "cid-4", "#untitled", "@bitbonsai frozen")).toBe(true);
    reminders.markSendingUncertain();
    const t = transporter("cid-5");
    expect(deliverDueReminders(t, joinedRoom(), "remind")).toBe(0);
    expect(t.sent).toEqual([]);
    const row = reminders.reminderByCid("cid-4")!;
    expect(row.state).toBe("uncertain");
    expect(row.target).toBe("#untitled");
    expect(row.body).toBe("@bitbonsai frozen");
    // Matching history for the frozen channel attempt still settles it.
    expect(ackReminderEcho(message(["#untitled", "@bitbonsai frozen"], { "+slirc/cid": "cid-4", account: "remind" }), "remind")).toBe(true);
    expect(reminders.reminderByCid("cid-4")!.state).toBe("delivered");
  });

  test("a target that is not joined stays pending and is never sent elsewhere", () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "wait");
    // The DM is mapped (beforeEach) but not joined; the room it was asked in is joined.
    const t = transporter("cid-6");
    expect(deliverDueReminders(t, new Set(["#untitled", "#help"]), "remind")).toBe(0);
    expect(t.sent).toEqual([]);
    expect(reminders.dueReminders()).toHaveLength(1);
  });
});

describe("reminder crash recovery (fake transport evidence)", () => {
  test("a crash before the write and a crash after it both leave durable uncertainty, neither resends", async () => {
    const evidence = join(dir, "attempts.log");
    // Row A: the process dies at the write boundary, before any bytes reach the wire.
    reminders.addReminder("bitbonsai", "#untitled", past(2_000), "before");
    freshProcess(crashScript("cid-before"));
    expect(reminders.reminderByCid("cid-before")!.state).toBe("sending");
    // Row B: the line reaches the wire, then the process dies before any ack is stored.
    reminders.addReminder("bitbonsai", "#untitled", past(1_000), "after");
    freshProcess(crashScript("cid-after", evidence));
    expect(reminders.reminderByCid("cid-after")!.state).toBe("sending");

    // The next process cannot tell either outcome, so both become visible uncertainty, not pending.
    reminders.markSendingUncertain();
    expect(reminders.unresolvedReminders().map((row) => row.state)).toEqual(["uncertain", "uncertain"]);
    expect(reminders.dueReminders()).toEqual([]);
    // Only the one that actually wrote has a line; the other was never resent.
    expect(readFileSync(evidence, "utf8").trim().split("\n")).toEqual(["@+slirc/cid=cid-after PRIVMSG #dm-bitbonsai-remind :after"]);

    // Positive history settles the written row and leaves the unwritten one uncertain.
    expect(await scanReminderHistory(reminders.reminderByCid("cid-after")!, "remind", async () => [echo("cid-after", "after")], Date.now() + 5_000)).toBe("found");
    expect(reminders.reminderByCid("cid-after")!.state).toBe("delivered");
    expect(reminders.reminderByCid("cid-before")!.state).toBe("uncertain");
    expect(reminders.dueReminders()).toEqual([]);
  });

  test("an echo whose local stamp was lost is recovered from matching history with no second PRIVMSG", async () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "call");
    expect(deliverDueReminders(transporter("cid-echo"), joinedRoom(), "remind")).toBe(1);
    expect(reminders.reminderByCid("cid-echo")!.state).toBe("sending");
    reminders.markSendingUncertain();
    const sends: string[] = [];
    const loadPage = async () => [echo("cid-echo")];
    expect(await scanReminderHistory(reminders.reminderByCid("cid-echo")!, "remind", loadPage, Date.now() + 5_000)).toBe("found");
    expect(reminders.reminderByCid("cid-echo")!.state).toBe("delivered");
    expect(reminders.reminderByCid("cid-echo")!.msgid).toBe("m-cid-echo");
    expect(sends).toEqual([]);
  });

  test("a match beyond the first page settles; empty, partial and expired replays do not", async () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "deep");
    expect(deliverDueReminders(transporter("cid-page"), joinedRoom(), "remind")).toBe(1);
    reminders.markSendingUncertain();
    const filler = Array.from({ length: RECONCILE_PAGE_SIZE }, (_, index) => message([DM, `filler ${index}`], { account: "someone", time: `t${String(index).padStart(3, "0")}` }));
    let pages = 0;
    const loadPage = async () => {
      pages++;
      return pages === 1 ? filler : [echo("cid-page", "deep")];
    };
    expect(await scanReminderHistory(reminders.reminderByCid("cid-page")!, "remind", loadPage, Date.now() + 5_000)).toBe("found");
    expect(pages).toBe(2);
    expect(reminders.reminderByCid("cid-page")!.state).toBe("delivered");

    reminders.addReminder("bitbonsai", "#untitled", past(), "empty");
    expect(deliverDueReminders(transporter("cid-empty"), joinedRoom(), "remind")).toBe(1);
    reminders.markSendingUncertain();
    expect(await scanReminderHistory(reminders.reminderByCid("cid-empty")!, "remind", async () => [], Date.now() + 5_000)).toBe("absent");
    expect(reminders.reminderByCid("cid-empty")!.state).toBe("uncertain");
    expect(reminders.dueReminders()).toEqual([]);

    // An expired deadline pages nothing and cannot settle.
    expect(await scanReminderHistory(reminders.reminderByCid("cid-empty")!, "remind", async () => [echo("cid-empty")], Date.now() - 1)).toBe("unknown");
    expect(reminders.reminderByCid("cid-empty")!.state).toBe("uncertain");
  });

  test("wrong sender, target, body, missing account tag and copied CID never confirm", () => {
    reminders.addReminder("bitbonsai", "#untitled", past(), "call");
    expect(deliverDueReminders(transporter("cid-neg"), joinedRoom(), "remind")).toBe(1);
    const rejected = [
      message([DM, "call"], { "+slirc/cid": "other", account: "remind" }),
      message([DM, "call"], { "+slirc/cid": "cid-neg" }),
      message([DM, "call"], { "+slirc/cid": "cid-neg", account: "someone-else" }),
      message(["#untitled", "call"], { "+slirc/cid": "cid-neg", account: "remind" }),
      message([DM, "other"], { "+slirc/cid": "cid-neg", account: "remind" }),
      message([DM, "call"], { "+slirc/cid": "cid-neg", account: "remind" }, "imposter!u@h"),
    ];
    for (const candidate of rejected) {
      expect(ackReminderEcho(candidate, "remind")).toBe(false);
      expect(reminders.reminderByCid("cid-neg")!.state).toBe("sending");
    }
    expect(ackReminderEcho(echo("cid-neg"), "remind")).toBe(true);
    expect(reminders.reminderByCid("cid-neg")!.state).toBe("delivered");
  });

  test("top-level, nested and deeper CHATHISTORY replay commands create no reminder; live multiline still does", () => {
    const replay = new Set<string>();
    // Mirror an Ergo history page: a chathistory batch containing a multiline batch containing
    // another batch. Every descendant item must be recognized as replay, not dispatched.
    const page = [
      { command: "BATCH", params: ["+hist", "chathistory", "#untitled"], tags: {}, prefix: "server" },
      { command: "BATCH", params: ["+inner", "draft/multiline", "#untitled"], tags: { batch: "hist" }, prefix: "server" },
      { command: "PRIVMSG", params: ["#untitled", "@remind in 1h historical"], tags: { batch: "inner" }, prefix: "bitbonsai!u@h" },
      { command: "BATCH", params: ["+deeper", "draft/event-playback", "#untitled"], tags: { batch: "inner" }, prefix: "server" },
      { command: "PRIVMSG", params: ["#untitled", "@remind in 2h deeper"], tags: { batch: "deeper" }, prefix: "bitbonsai!u@h" },
      { command: "BATCH", params: ["-deeper"], tags: {}, prefix: "server" },
      { command: "BATCH", params: ["-inner"], tags: {}, prefix: "server" },
      { command: "PRIVMSG", params: ["#untitled", "@remind in 3h flat replay"], tags: { batch: "hist" }, prefix: "bitbonsai!u@h" },
      { command: "BATCH", params: ["-hist"], tags: {}, prefix: "server" },
    ];
    for (const candidate of page) {
      if (!dropReplayMessage(candidate as never, replay)) reminderReply("remind", "bitbonsai", "#untitled", afterNick(candidate.params[1], "remind"));
    }
    expect(reminders.pendingReminders("bitbonsai")).toEqual([]);
    expect(replay.size).toBe(0);

    // A live multiline carries no replay ancestry and still runs.
    const live = [
      { command: "BATCH", params: ["+live", "draft/multiline", "#untitled"], tags: {}, prefix: "server" },
      { command: "PRIVMSG", params: ["#untitled", "@remind in 30m live one"], tags: { batch: "live" }, prefix: "bitbonsai!u@h" },
    ];
    for (const candidate of live) {
      if (!dropReplayMessage(candidate as never, replay)) reminderReply("remind", "bitbonsai", "#untitled", afterNick(candidate.params[1], "remind"));
    }
    expect(reminders.pendingReminders("bitbonsai").map((row) => row.text)).toEqual(["live one"]);
  });
});

describe("reminder cancellation", () => {
  test("only the owner can cancel, before dispatch and during uncertainty", () => {
    const id = reminders.addReminder("bitbonsai", "#untitled", past(), "tea");
    expect(reminders.cancelReminder("igor", id)).toBe(false);
    expect(reminders.cancelReminder("BitBonsai", id)).toBe(true);
    expect(reminders.dueReminders()).toEqual([]);
    expect(deliverDueReminders(transporter("cid-cancel-1"), joinedRoom(), "remind")).toBe(0);

    const claimId = reminders.addReminder("bitbonsai", "#untitled", past(), "coffee");
    expect(deliverDueReminders(transporter("cid-cancel-2"), joinedRoom(), "remind")).toBe(1);
    reminders.markSendingUncertain();
    expect(reminderReply("remind", "bitbonsai", "#untitled", "list")).toContain("may not have sent");
    const reply = reminderReply("remind", "bitbonsai", "#untitled", "cancel 1");
    expect(reply).toBe("Cancelled. It may already have been delivered; I can't retract it.");
    expect(claimId).toBeGreaterThan(0);
    const row = reminders.reminderByCid("cid-cancel-2")!;
    expect(row.state).toBe("cancelled");
    expect(reminders.pendingReminders("bitbonsai")).toEqual([]);
    expect(reminders.unresolvedReminders()).toEqual([]);
    // A late validated echo still settles a cancelled attempt without another send.
    expect(ackReminderEcho(echo("cid-cancel-2", "coffee"), "remind")).toBe(true);
    expect(reminders.reminderByCid("cid-cancel-2")!.state).toBe("delivered");
  });
});

describe("old reminder schema upgrade (isolated file)", () => {
  test("a one-time upgrade marks old past-due uncertain and never converts later new rows", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "slirc-reminder-legacy-"));
    const legacyDb = join(legacyDir, "chat.sqlite");
    try {
      // Build the pre-state schema with one due, one future and one stamped row, then let db.ts
      // upgrade the file and add a new-code pending row, all in one fresh process.
      const first = freshProcess(`
        const { Database } = await import('bun:sqlite');
        const legacy = new Database(process.env.DB_PATH);
        legacy.exec("CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT NOT NULL, channel TEXT NOT NULL, fire_at INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER)");
        const now = Date.now();
        legacy.query("INSERT INTO reminders (nick,channel,fire_at,text,created_at,delivered_at) VALUES ('b','#u',?, 'due', 1, NULL)").run(now - 1000);
        legacy.query("INSERT INTO reminders (nick,channel,fire_at,text,created_at,delivered_at) VALUES ('b','#u',?, 'future', 1, NULL)").run(now + 60000);
        legacy.query("INSERT INTO reminders (nick,channel,fire_at,text,created_at,delivered_at) VALUES ('b','#u',?, 'stamped', 1, ?)").run(now - 1000, now - 500);
        legacy.close();
        const { db } = await import('./src/db.ts');
        db.query("INSERT INTO reminders (nick,channel,fire_at,text,created_at) VALUES ('b','#u',?, 'newpending', ?)").run(now - 1000, now);
        console.log(JSON.stringify(db.query("SELECT text,state FROM reminders ORDER BY id").all()));
      `, legacyDb);
      expect(JSON.parse(first)).toEqual([
        { text: "due", state: "uncertain" },
        { text: "future", state: "pending" },
        { text: "stamped", state: "delivered" },
        { text: "newpending", state: "pending" },
      ]);
      // A later boot must not re-run the upgrade or convert the new-code pending row.
      const second = freshProcess(`const { db } = await import('./src/db.ts'); console.log(JSON.stringify(db.query("SELECT text,state FROM reminders ORDER BY id").all()));`, legacyDb);
      expect(JSON.parse(second)).toEqual([
        { text: "due", state: "uncertain" },
        { text: "future", state: "pending" },
        { text: "stamped", state: "delivered" },
        { text: "newpending", state: "pending" },
      ]);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  test("a backfill failure rolls the whole upgrade back and a later boot retries", () => {
    const faultDir = mkdtempSync(join(tmpdir(), "slirc-reminder-fault-"));
    const faultDb = join(faultDir, "chat.sqlite");
    try {
      // A trigger makes the classification UPDATE fail after the state column was added. The whole
      // reminder transaction must roll back: no state column, legacy rows unchanged.
      const faulted = JSON.parse(freshProcess(`
        const { Database } = await import('bun:sqlite');
        const legacy = new Database(process.env.DB_PATH);
        legacy.exec("CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT NOT NULL, channel TEXT NOT NULL, fire_at INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER)");
        const now = Date.now();
        legacy.query("INSERT INTO reminders (nick,channel,fire_at,text,created_at,delivered_at) VALUES ('b','#u',?, 'due', 1, NULL)").run(now - 1000);
        legacy.query("INSERT INTO reminders (nick,channel,fire_at,text,created_at,delivered_at) VALUES ('b','#u',?, 'future', 1, NULL)").run(now + 60000);
        legacy.query("INSERT INTO reminders (nick,channel,fire_at,text,created_at,delivered_at) VALUES ('b','#u',?, 'stamped', 1, ?)").run(now - 1000, now - 500);
        legacy.exec("CREATE TRIGGER block_backfill BEFORE UPDATE ON reminders BEGIN SELECT RAISE(ABORT, 'blocked'); END");
        legacy.close();
        let threw = false;
        try { await import('./src/db.ts'); } catch { threw = true; }
        const raw = new Database(process.env.DB_PATH);
        const cols = raw.query("PRAGMA table_info(reminders)").all().map((column) => column.name);
        const rows = raw.query("SELECT text, delivered_at FROM reminders ORDER BY id").all();
        console.log(JSON.stringify({ threw, cols, rows }));
      `, faultDb));
      expect(faulted.threw).toBe(true);
      expect(faulted.cols).not.toContain("state");
      expect(faulted.rows).toEqual([
        { text: "due", delivered_at: null },
        { text: "future", delivered_at: null },
        { text: "stamped", delivered_at: expect.any(Number) },
      ]);

      // Remove only the test trigger, then a fresh import completes the upgrade and adds a new row.
      const upgraded = JSON.parse(freshProcess(`
        const { Database } = await import('bun:sqlite');
        const raw = new Database(process.env.DB_PATH);
        raw.exec("DROP TRIGGER block_backfill");
        raw.close();
        const { db } = await import('./src/db.ts');
        db.query("INSERT INTO reminders (nick,channel,fire_at,text,created_at) VALUES ('b','#u',?, 'newpending', ?)").run(Date.now() - 1000, Date.now());
        console.log(JSON.stringify(db.query("SELECT text,state FROM reminders ORDER BY id").all()));
      `, faultDb));
      expect(upgraded).toEqual([
        { text: "due", state: "uncertain" },
        { text: "future", state: "pending" },
        { text: "stamped", state: "delivered" },
        { text: "newpending", state: "pending" },
      ]);
      const rebooted = freshProcess(`const { db } = await import('./src/db.ts'); console.log(JSON.stringify(db.query("SELECT text,state FROM reminders ORDER BY id").all()));`, faultDb);
      expect(JSON.parse(rebooted)).toEqual(upgraded);
    } finally {
      rmSync(faultDir, { recursive: true, force: true });
    }
  });
});
