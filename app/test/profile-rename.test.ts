// Display name edits on the You tab: PATCH /profile checks a changed name and leaves the nick alone.
import "./fixture.ts";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.env.SLIRC_HELPERS_ENABLED = "false";
const { db } = await import("../src/db.ts");
const { accountByNick, displayNameError } = await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
afterAll(() => db.close());

const add = (nick: string, role = "member", kind = "human") =>
  db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES (?, ?, ?, ?, 1, 1)")
    .run(nick, `${nick}@example.test`, role, kind);
add("ada");
add("ben");
add("carla", "admin");
add("ada-pi", "member", "agent");
add("gone", "admin");
db.query("UPDATE accounts SET removed_at = 1 WHERE nick = 'gone'").run();

const token = "rename-fixture-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'ada', ?)")
  .run(createHash("sha256").update(token).digest("hex"), Date.now());
db.query("INSERT INTO profiles (account, full_name) VALUES ('ada', 'Ada')").run();
const accountId = accountByNick("ada")!.id;
const headers = { "Content-Type": "application/json", Cookie: `slirc_session=${token}` };
const patch = (body: unknown) => app.request("/profile", { method: "PATCH", headers, body: JSON.stringify(body) });
const stored = () => (db.query("SELECT full_name FROM profiles WHERE account = 'ada'").get() as { full_name: string }).full_name;

test("a valid display name saves, trimmed and with whitespace collapsed, and the nick stays", async () => {
  const response = await patch({ accountId, fullName: "  Ada   Lovelace\t" });
  expect(response.status).toBe(200);
  expect((await response.json()).fullName).toBe("Ada Lovelace");
  expect(stored()).toBe("Ada Lovelace");
  expect(accountByNick("ada")!.nick).toBe("ada");
  for (const name of ["Ådá Ñúñez", "李小龍", "Ada (she/her)", "R2-D2", "ada"]) {
    expect((await patch({ accountId, fullName: name })).status).toBe(200);
    expect(stored()).toBe(name);
  }
});

test("empty, too long, symbol-only and hidden-character names are refused and nothing changes", async () => {
  expect((await patch({ accountId, fullName: "Ada" })).status).toBe(200);
  for (const name of ["", "   ", "a".repeat(81), "...", "!!", "Ada​L", "Ada‮L", "Ada\u0000", "Ada", 42, null]) {
    const response = await patch({ accountId, fullName: name, about: "should not save" });
    expect(response.status).toBe(400);
    expect(typeof (await response.json()).error).toBe("string");
  }
  expect(stored()).toBe("Ada");
  expect((db.query("SELECT about FROM profiles WHERE account = 'ada'").get() as { about: string }).about).toBe("");
  expect((await patch({ accountId, fullName: "a".repeat(80) })).status).toBe(200);
});

test("staff, service, helper, owner and Slirc names are reserved, however they are spelled", async () => {
  for (const name of ["Admin", "ADMIN", "Ad min", "Ádmin", "Nick Serv", "Support", "help", "Remind", "slirc", "Slirc Support", "Slirc-Team", "bitbonsai", "slirc-org", "Ergo"]) {
    const response = await patch({ accountId, fullName: name });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("That name is reserved.");
  }
});

test("a name cannot copy an admin's, agent's or bot's nick, but can match another member's", async () => {
  for (const [name, owner] of [["Carla", "carla"], ["ada pi", "ada-pi"], ["AdaPi", "ada-pi"]]) {
    const response = await patch({ accountId, fullName: name });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(`That name belongs to @${owner}.`);
  }
  expect((await patch({ accountId, fullName: "Ben" })).status).toBe(200);
  expect((await patch({ accountId, fullName: "Gone" })).status).toBe(200);
});

test("only a changed name is checked: an old name kept from signup never blocks other fields", async () => {
  db.query("UPDATE profiles SET full_name = 'Admin' WHERE account = 'ada'").run();
  expect((await patch({ accountId, fullName: "Admin", about: "hi" })).status).toBe(200);
  expect((await patch({ accountId, badge: "available" })).status).toBe(200);
  expect((await patch({ accountId, theme: "dark" })).status).toBe(200);
  expect(stored()).toBe("Admin");
});

test("a refused name writes no theme either", async () => {
  expect((await patch({ accountId, theme: "light" })).status).toBe(200);
  expect((await patch({ accountId, theme: "dark", fullName: "Support" })).status).toBe(400);
  expect((db.query("SELECT theme FROM accounts WHERE nick = 'ada'").get() as { theme: string }).theme).toBe("light");
});

test("the owner may use their own nick as a name; others may not", () => {
  expect(displayNameError("bitbonsai", "bitbonsai")).toBeNull();
  expect(displayNameError("Bit Bonsai", "ada")).toBe("That name is reserved.");
  expect(displayNameError("Carla", "carla")).toBeNull();
});
