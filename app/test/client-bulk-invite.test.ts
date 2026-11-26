// Invite many: reading pasted lists and CSVs, and sending the checked rows in batches. No browser.
import { expect, test } from "bun:test";
import { bulkCounts, createBulkInvite, parseInviteList } from "@client/bulk-invite.ts";

test("reads one address per line, CSV columns in any order, and Name <email>", () => {
  expect(parseInviteList("ada@example.com\nBen Ortiz, ben@example.com\nEve Lind <eve@example.com>\n")).toEqual([
    { email: "ada@example.com", name: "" }, { email: "ben@example.com", name: "Ben Ortiz" }, { email: "eve@example.com", name: "Eve Lind" },
  ]);
  const csv = '﻿email,first name,team\r\n"ivy@example.com","Ivy",design\r\nmax@example.com;Max;ops\r\n';
  expect(parseInviteList(csv)).toEqual([{ email: "ivy@example.com", name: "Ivy" }, { email: "max@example.com", name: "Max" }]);
});

test("several addresses on a line each get a row; headers and blanks are skipped; typos stay in", () => {
  expect(parseInviteList("name,email\n\na@example.com, b@example.com c@example.com\nmailto:d@example.com\nbroken@\n")).toEqual([
    { email: "a@example.com", name: "" }, { email: "b@example.com", name: "" }, { email: "c@example.com", name: "" },
    { email: "d@example.com", name: "" }, { email: "broken@", name: "" },
  ]);
});

test("only the first line may be a header; a later line without an @ stays as a row to be marked", () => {
  expect(parseInviteList("ada@example.com\nnot-an-email\n\n,,\nbob@example.com")).toEqual([
    { email: "ada@example.com", name: "" }, { email: "not-an-email", name: "" }, { email: "bob@example.com", name: "" },
  ]);
  expect(parseInviteList("not-an-email\nada@example.com")).toEqual([{ email: "ada@example.com", name: "" }]);
  expect(parseInviteList("email,name\nada@example.com,Ada\nBob Smith,bob.example.com")).toEqual([
    { email: "ada@example.com", name: "Ada" }, { email: "Bob Smith,bob.example.com", name: "" },
  ]);
});

test("a CSV added below a pasted list loses its header row, not a typo", async () => {
  const bulk = createBulkInvite((value) => value, { core: { authenticated: true, isAdmin: true, defaultChannel: "", channels: [], openRooms: {} } as any,
    session: { key: () => "s", stopped: () => false } as any, nextTick: async () => {} });
  bulk.text = "ada@example.com";
  await bulk.readFile(new File(["name,email\nBen,ben@example.com\nnope\n"], "team.csv"));
  expect(parseInviteList(bulk.text).map((entry) => entry.email)).toEqual(["ada@example.com", "ben@example.com", "nope"]);
});

test("counts keep a fixed order", () => {
  expect(bulkCounts([{ email: "a", name: "", status: "invalid" }, { email: "b", name: "", status: "new" }, { email: "c", name: "", status: "new" }]))
    .toEqual([{ status: "new", count: 2 }, { status: "invalid", count: 1 }]);
});

test("send posts only new and add rows, 25 per batch, each with its own key", async () => {
  const calls: Array<{ body: any; key: string | null }> = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ body, key: new Headers(init.headers).get("Idempotency-Key") });
    if (body.preview) return Response.json({ channel: "#team", mailRoom: 90, rows: body.emails.map((email: string, n: number) => ({ email, status: n === 0 ? "invalid" : n === 1 ? "add" : "new", ...(n === 1 ? { nick: "igor" } : {}) })) });
    return Response.json({ channel: "#team", mailRoom: 40, rows: body.emails.map((email: string) => ({ email, status: email.startsWith("igor") ? "added" : "invited" })) });
  }) as typeof fetch;
  try {
    const bulk = createBulkInvite((value) => value, { core: { authenticated: true, isAdmin: true, defaultChannel: "#lobby", channels: [], openRooms: {} } as any,
      session: { key: () => "s", stopped: () => false } as any, nextTick: async () => {} });
    bulk.text = ["bad", "igor@example.com", ...Array.from({ length: 30 }, (_, n) => `p${n}@example.com`)].map((line) => line.includes("@") ? line : `${line}@`).join("\n");
    await bulk.check();
    expect(bulk.step).toBe("preview");
    expect(calls[0].body.destination).toEqual({ workspace: true });
    expect(bulk.sendLabel()).toBe("Send 30 invites, add 1");
    await bulk.send();
    const sends = calls.slice(1);
    expect(sends.map((call) => call.body.emails.length)).toEqual([25, 6]);
    expect(new Set(sends.map((call) => call.key)).size).toBe(2);
    expect(sends[0].body.emails).not.toContain("bad@");
    expect(bulk.step).toBe("done");
    expect(bulk.counts()).toEqual([{ status: "invited", count: 30 }, { status: "added", count: 1 }, { status: "invalid", count: 1 }]);
  } finally { globalThis.fetch = saved; }
});

test("the destination picker hides when the workspace is the only choice", async () => {
  const make = (channels: Array<{ wireTarget: string }>, openRooms: Record<string, boolean> = {}, defaultChannel = "#calango") =>
    createBulkInvite((value) => value, { core: { authenticated: true, isAdmin: true, defaultChannel, channels, openRooms } as any,
      session: { key: () => "s", stopped: () => false } as any, nextTick: async () => {} });
  const only = make([{ wireTarget: "#open" }, { wireTarget: "#dm-ada" }], { "#open": true });
  only.open();
  expect(only.choosesDestination()).toBe(false);
  expect(only.destination).toBe("");
  const several = make([{ wireTarget: "#team" }]);
  several.open();
  expect(several.choosesDestination()).toBe(true);
  const oneChannel = make([{ wireTarget: "#team" }], {}, "");
  oneChannel.open();
  expect(oneChannel.choosesDestination()).toBe(false);
  expect(oneChannel.destination).toBe("#team");
  const partial = await Bun.file(new URL("../partials/bulk-invite.html", import.meta.url)).text();
  expect(partial).toContain('class="bulk-invite-field" x-show="bulkInvite.choosesDestination()"');
  expect(partial).toContain("Invites go to");
});

test("the default channel is the workspace option, not also a channel, so the picker hides", () => {
  const bulk = createBulkInvite((value) => value, { core: { authenticated: true, isAdmin: true, defaultChannel: "#calango",
    channels: [{ wireTarget: "#Calango" }, { wireTarget: "#dm-ada" }], openRooms: {} } as any,
    session: { key: () => "s", stopped: () => false } as any, nextTick: async () => {} });
  bulk.open(undefined, "#calango");
  expect(bulk.destinations()).toEqual([]);
  expect(bulk.choosesDestination()).toBe(false);
  expect(bulk.destination).toBe("");
});
