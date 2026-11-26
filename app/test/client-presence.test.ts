import { expect, test } from "bun:test";
import { createPresence } from "@client/presence.ts";

function fixture(limit = 100, caps = "") {
  const sent: string[] = [];
  const presence = createPresence((value) => value, (line) => { sent.push(line); return true; });
  presence.start("eve");
  presence.watch(["Ada", "ada", "ben", "bad\r\nQUIT", "#help"]);
  expect(sent).toEqual([]);
  if (caps) presence.feed(`:ergo CAP eve ACK :${caps}`);
  presence.feed(":ergo 001 eve :Welcome");
  presence.feed(`:ergo 005 eve MONITOR=${limit} :supported`);
  return { presence, sent };
}

test("live MONITOR presence is case-insensitive, bounded and safe to serialize", () => {
  const { presence, sent } = fixture();
  expect(sent).toEqual(["MONITOR + ada,ben"]);
  expect(presence.status("Ada")).toBe(""); // Membership is not evidence of presence.
  expect(presence.status("eve")).toBe("online");
  presence.feed(":ergo 730 eve :Ada!user@host");
  presence.feed(":ergo 731 eve :ben\r\n");
  expect(presence.status("ADA")).toBe("online");
  expect(presence.status("ben")).toBe("offline");
  expect(presence.label("ben")).toBe("Offline");
  presence.feed(":ergo 730 eve :ben!user@host");
  expect(presence.status("ben")).toBe("online");
  presence.watch(["ben"]);
  expect(sent.at(-1)).toBe("MONITOR - ada");
  presence.feed(":ergo 730 eve :ada!user@host");
  expect(presence.status("ada")).toBe("");
});

test("Busy is an explicit saved status; offline takes precedence", () => {
  const { presence } = fixture();
  presence.setAvailability([{ nick: "Ada", availability: " Busy " }, { nick: "ben", availability: "not busy" }]);
  presence.feed(":ergo 730 eve :ada!user@host,ben!user@host");
  expect(presence.status("ada")).toBe("busy");
  expect(presence.label("ada")).toBe("Busy");
  expect(presence.status("ben")).toBe("online");
  expect(presence.status("eve", "Busy")).toBe("busy");
  presence.feed(":ergo 731 eve :ada");
  expect(presence.status("ada")).toBe("offline");
  presence.disconnect();
  expect(presence.status("eve", "Busy")).toBe("offline");
  expect(presence.status("ada")).toBe(""); // Cannot infer others' presence while disconnected.
});

test("selected colors and emojis are independent of text and never override offline or unknown presence", () => {
  const { presence } = fixture();
  for (const badge of ["away", "focus", "break", "resting", "vacation"] as const) {
    presence.setAvailability([{ nick: "Ada", availability: "Out of office", badge }]);
    expect(presence.status("ada")).toBe("");
    presence.feed(":ergo 730 eve :ada!user@host");
    expect(presence.status("ada")).toBe(badge);
    presence.feed(":ergo 731 eve :ada");
    expect(presence.status("ada")).toBe("offline");
    presence.watch(["ben"]); presence.watch(["ada", "ben"]);
  }
  expect(presence.status("eve", "Busy", "available")).toBe("online");
  expect(presence.status("eve", "On holiday", "busy")).toBe("busy");
  expect(presence.label("eve", "", "vacation")).toBe("Vacation");
  presence.disconnect();
  expect(presence.status("eve", "", "vacation")).toBe("offline");
  expect(presence.status("ada")).toBe("");
  presence.reset();
  expect(presence.badges).toEqual({});
});

test("reconnect restores subscriptions without stale presence; account reset clears metadata", () => {
  const { presence, sent } = fixture();
  presence.setAvailability([{ nick: "ada", availability: "Busy" }]);
  presence.feed(":ergo 730 eve :ada!user@host");
  presence.start("eve");
  expect(presence.status("ada")).toBe("");
  presence.feed(":ergo 001 eve :Welcome");
  presence.feed(":ergo 005 eve MONITOR=100 :supported");
  expect(sent.at(-1)).toBe("MONITOR + ada,ben");
  expect(presence.status("ada")).toBe("");
  presence.feed(":ergo 730 eve :ada!user@host");
  expect(presence.status("ada")).toBe("busy");
  presence.reset();
  expect(presence.status("eve")).toBe("");
  expect(presence.availability).toEqual({});
});

test("server limits and unavailable MONITOR leave unknown users unbadged", () => {
  const { presence } = fixture(1);
  presence.feed(":ergo 730 eve :ada!user@host,ben!user@host");
  expect(presence.status("ada")).toBe("online");
  expect(presence.status("ben")).toBe("");
  presence.feed(":ergo 734 eve 1 ada :Monitor list is full");
  expect(presence.status("ada")).toBe("");
  presence.start("eve");
  presence.feed(":ergo 001 eve :Welcome");
  presence.feed(":ergo 005 eve NETWORK=Ergo :supported");
  presence.feed(":ergo 730 eve :ada!user@host");
  expect(presence.status("ada")).toBe("");
});

test("history and message activity never become live presence", () => {
  const { presence } = fixture();
  presence.feed("@batch=history :ergo 730 eve :ada!user@host");
  presence.feed(":ada!user@host PRIVMSG #dev-test :hi");
  expect(presence.status("ada")).toBe("");
  expect(presence.status(undefined as unknown as string)).toBe("");
});

test("AWAY marks an online nick Away until a bare AWAY or going offline clears it", () => {
  const { presence } = fixture(100, "away-notify extended-monitor");
  presence.feed(":ergo 730 eve :ada!user@host,ben!user@host");
  presence.feed(":Ada!user@host AWAY :Gone fishing");
  expect(presence.status("ada")).toBe("away");
  expect(presence.label("ada")).toBe("Away");
  expect(presence.status("ben")).toBe("online");
  presence.feed(":ada!user@host AWAY");
  expect(presence.status("ada")).toBe("online");
  presence.feed(":ada!user@host AWAY brb");
  presence.feed(":ergo 731 eve :ada");
  expect(presence.status("ada")).toBe("offline");
  presence.feed(":ergo 730 eve :ada!user@host");
  expect(presence.status("ada")).toBe("online"); // Old away never survives a reconnect.
  presence.feed(":ergo 301 eve ben :In a meeting");
  expect(presence.status("ben")).toBe("away");
  presence.feed(":eve!user@host AWAY :self");
  presence.feed(":carl!user@host AWAY :not watched");
  expect(presence.status("eve")).toBe("online");
  expect(presence.away).toEqual({ ben: true });
  presence.disconnect();
  expect(presence.away).toEqual({});
});

test("a picked profile badge outranks auto-away; available and Busy text do not", () => {
  const { presence } = fixture(100, "away-notify");
  presence.setAvailability([{ nick: "ada", badge: "focus" }, { nick: "ben", availability: "Busy", badge: "available" }]);
  presence.feed(":ergo 730 eve :ada!user@host,ben!user@host");
  presence.feed(":ada!user@host AWAY :Auto-away");
  presence.feed(":ben!user@host AWAY :Auto-away");
  expect(presence.status("ada")).toBe("focus");
  expect(presence.status("ben")).toBe("away");
  expect(presence.status("ben", "Busy")).toBe("away");
});

test("newly online nicks get one batched USERHOST for their existing away state", () => {
  const { presence, sent } = fixture(100, "away-notify extended-monitor");
  const nicks = ["ada", "ben", "cy", "dee", "eli", "fay", "gus", "hal", "ivy", "jo", "kit"];
  presence.watch(nicks);
  sent.length = 0;
  presence.feed(`:ergo 730 eve :${nicks.map((nick) => `${nick}!u@h`).join(",")}`);
  expect(sent).toEqual(["USERHOST ada ben cy dee eli fay gus hal ivy jo", "USERHOST kit"]);
  presence.feed(":ergo 730 eve :ada!u@h");
  expect(sent.length).toBe(2); // Already online, no repeat query.
  presence.feed(":ergo 302 eve :ada=-~u@h Ben*=-~u@h cy=+~u@h zed=-~u@h");
  expect(presence.status("ada")).toBe("away");
  expect(presence.status("ben")).toBe("away");
  expect(presence.status("cy")).toBe("online");
  expect(presence.away).toEqual({ ada: true, ben: true });
});

test("without away-notify there is no USERHOST probe", () => {
  const { presence, sent } = fixture();
  presence.feed(":ergo 730 eve :ada!user@host");
  expect(sent).toEqual(["MONITOR + ada,ben"]);
});

test("service bots and bot accounts get no presence; agents get no MONITOR watch", () => {
  const { presence, sent } = fixture(100, "away-notify");
  presence.watch(["ada", "Slirc", "remind", "help", "poll", "welcome", "pushy", "claude-mbp"]);
  expect(sent.at(-1)).toBe("MONITOR + pushy,claude-mbp");
  presence.feed(":ergo 730 eve :pushy!u@h,claude-mbp!u@h,ada!u@h");
  expect(presence.status("claude-mbp")).toBe("online");
  presence.setAvailability([{ nick: "pushy", kind: "bot" }, { nick: "Claude-MBP", kind: "agent" }, { nick: "ada", kind: "human" }]);
  expect(sent.at(-1)).toBe("MONITOR - pushy,claude-mbp");
  for (const nick of ["slirc", "REMIND", "help", "poll", "welcome", "pushy"]) {
    expect(presence.status(nick)).toBe("");
    expect(presence.label(nick)).toBe("Status unavailable");
  }
  expect(presence.status("ada")).toBe("online");
  const count = sent.length;
  presence.watch(["ada", "pushy", "claude-mbp"]);
  expect(sent.length).toBe(count); // Known bots are never re-added.
  presence.reset();
  expect(presence.bots).toEqual({});
  expect(presence.agents).toEqual({});
});

test("an agent dot follows the server's harness attachment, never IRC presence", () => {
  const { presence, sent } = fixture(100);
  presence.watch(["ada", "claude-mbp", "legacy-agent"]);
  presence.setAvailability([{ nick: "Claude-MBP", kind: "agent", attached: true }, { nick: "legacy-agent", kind: "agent" }]);
  expect(sent.at(-1)).toBe("MONITOR - claude-mbp,legacy-agent");
  expect(presence.status("claude-mbp")).toBe("online");
  expect(presence.label("claude-mbp")).toBe("Online");
  // Unknown attachment is offline, even while IRC says the always-on nick is connected.
  presence.feed(":ergo 730 eve :legacy-agent!u@h");
  expect(presence.status("legacy-agent")).toBe("offline");
  presence.setAvailability([{ nick: "claude-mbp", kind: "agent", attached: false }]);
  expect(presence.status("claude-mbp")).toBe("offline");
  // A dropped IRC socket leaves humans unknown, but the attachment snapshot still stands.
  presence.disconnect();
  expect(presence.status("ada")).toBe("");
  expect(presence.status("legacy-agent")).toBe("offline");
  presence.setAvailability([{ nick: "pushy", kind: "bot", attached: true }]);
  expect(presence.status("pushy")).toBe("");
});

test("a live agent-presence event flips the dot and drops any MONITOR watch", () => {
  const { presence, sent } = fixture(100);
  presence.watch(["ada", "claude-mbp"]);
  presence.feed(":ergo 730 eve :claude-mbp!u@h");
  presence.setAgentAttached("Claude-MBP", true);
  expect(sent.at(-1)).toBe("MONITOR - claude-mbp");
  expect(presence.status("claude-mbp")).toBe("online");
  presence.setAgentAttached("claude-mbp", false);
  expect(presence.status("claude-mbp")).toBe("offline");
  const count = sent.length;
  presence.setAgentAttached("claude-mbp", true);
  expect(sent.length).toBe(count);
});
