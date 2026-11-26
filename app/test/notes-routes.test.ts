// Notes routes: a private scratchpad per account. Only the signed-in owner lists, edits or deletes a
// note; another account's id answers 404 and changes nothing. /dm/<own nick> opens Notes.
import "./fixture.ts";

const ORIGIN = "https://slirc.test";
process.env.APP_ORIGIN = ORIGIN;

import { createHash } from "node:crypto";
import { beforeAll, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");

const tokens = { nora: "notes-nora-session", owen: "notes-owen-session" } as const;
type Who = keyof typeof tokens;
const headers = (who: Who, extra: Record<string, string> = {}) => ({
  Cookie: `slirc_session=${tokens[who]}`, "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Notes": "1", ...extra,
});
const list = async (who: Who) => (await (await app.request("/api/notes", { headers: headers(who) })).json() as { notes: { id: string; body: string }[] }).notes;
const add = async (who: Who, body: string) => (await (await app.request("/api/notes", { method: "POST", headers: headers(who), body: JSON.stringify({ body }) })).json() as { note: { id: string; body: string } }).note;
const edit = (who: Who, id: string, body: string, extra?: Record<string, string>) => app.request(`/api/notes/${id}`, { method: "PATCH", headers: headers(who, extra), body: JSON.stringify({ body }) });
const remove = (who: Who, id: string, extra?: Record<string, string>) => app.request(`/api/notes/${id}`, { method: "DELETE", headers: headers(who, extra) });
const stored = (id: string) => db.query("SELECT account_id, body FROM notes WHERE id = ?").get(id) as { account_id: string; body: string } | null;

beforeAll(() => {
  for (const nick of ["nora", "owen"] as const) {
    db.query("INSERT INTO accounts (nick, email, role, kind, verified_at, created_at) VALUES (?, ?, 'member', 'human', 1, 1)").run(nick, `${nick}@example.com`);
    db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(createHash("sha256").update(tokens[nick]).digest("hex"), nick, Date.now());
  }
});

test("signed-out, cross-site and empty writes are refused before anything is stored", async () => {
  expect((await app.request("/api/notes")).status).toBe(401);
  expect((await app.request("/api/notes", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Notes": "1" }, body: "{\"body\":\"x\"}" })).status).toBe(401);
  expect((await app.request("/api/notes", { method: "POST", headers: headers("nora", { Origin: "https://evil.test" }), body: "{\"body\":\"x\"}" })).status).toBe(403);
  expect((await app.request("/api/notes", { method: "POST", headers: headers("nora", { "X-Slirc-Notes": "" }), body: "{\"body\":\"x\"}" })).status).toBe(403);
  expect((await app.request("/api/notes", { method: "POST", headers: headers("nora"), body: "{\"body\":\"   \"}" })).status).toBe(400);
  expect((await app.request("/api/notes", { method: "POST", headers: headers("nora"), body: JSON.stringify({ body: "x".repeat(4001) }) })).status).toBe(400);
  expect((db.query("SELECT COUNT(*) n FROM notes").get() as { n: number }).n).toBe(0);
});

test("each account lists only its own notes, in the order written", async () => {
  const first = await add("nora", "buy milk");
  const second = await add("nora", "  read https://example.com/post  ");
  await add("owen", "owen's secret");
  expect(second.body).toBe("read https://example.com/post");
  expect((await list("nora")).map((note) => note.id)).toEqual([first.id, second.id]);
  expect((await list("owen")).map((note) => note.body)).toEqual(["owen's secret"]);
});

test("the owner edits a note in place; another account cannot", async () => {
  const note = await add("nora", "draft");
  const response = await edit("nora", note.id, "final");
  expect(response.status).toBe(200);
  expect((await response.json() as { note: { body: string } }).note.body).toBe("final");
  expect(stored(note.id)?.body).toBe("final");

  expect((await edit("owen", note.id, "hijacked")).status).toBe(404);
  expect((await edit("nora", note.id, "cross-site", { Origin: "https://evil.test" })).status).toBe(403);
  expect((await edit("nora", note.id, "   ")).status).toBe(400);
  expect((await edit("nora", "missing", "x")).status).toBe(404);
  expect(stored(note.id)?.body).toBe("final");
});

test("the owner deletes a note; another account cannot", async () => {
  const note = await add("nora", "temporary");
  expect((await remove("owen", note.id)).status).toBe(404);
  expect((await remove("nora", note.id, { Origin: "https://evil.test" })).status).toBe(403);
  expect(stored(note.id)?.body).toBe("temporary");
  expect((await remove("nora", note.id)).status).toBe(204);
  expect(stored(note.id)).toBeNull();
  expect((await remove("nora", note.id)).status).toBe(404);
});

test("/dm/<own nick> redirects to Notes; other DMs and signed-out visits get the app", async () => {
  for (const nick of ["nora", "NORA"]) {
    const response = await app.request(`/dm/${nick}`, { headers: { Cookie: `slirc_session=${tokens.nora}` } });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/notes");
  }
  expect((await app.request("/dm/owen", { headers: { Cookie: `slirc_session=${tokens.nora}` } })).status).toBe(200);
  expect((await app.request("/dm/nora")).status).toBe(200);
  expect((await app.request("/notes", { headers: { Cookie: `slirc_session=${tokens.nora}` } })).status).toBe(200);
});

test("removing an account deletes its notes and the images pasted into them", async () => {
  const { markRemoved } = await import("../src/accounts.ts");
  const own = (nick: Who) => (db.query("SELECT account_id FROM accounts WHERE nick = ?").get(nick) as { account_id: string }).account_id;
  const upload = (id: string, nick: Who) => db.query("INSERT INTO uploads (id, nick, channel, kind, mime, data, created_at) VALUES (?, ?, ?, 'image', 'image/jpeg', x'00', 1)").run(id, nick, `notes:${own(nick)}`);
  await add("owen", "keep me");
  upload("owen-note-image", "owen");
  upload("owen-other-image", "nora");
  markRemoved("owen");
  expect(db.query("SELECT COUNT(*) AS n FROM notes WHERE account_id = ?").get(own("owen"))).toEqual({ n: 0 });
  expect(db.query("SELECT id FROM uploads WHERE id IN ('owen-note-image', 'owen-other-image')").all()).toEqual([{ id: "owen-other-image" }]);
});
