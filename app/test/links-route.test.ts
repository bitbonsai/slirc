// The links routes: off unless the helper is on, members only, never cached, and a private
// channel's links stay inside it through search, suggestions and removal.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://guild.example.test";
process.env.SLIRC_HELPERS = "help,links";

import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "bun:test";

process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { recordShare } = await import("../src/links.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const ORIGIN = "https://guild.example.test";
const cookie = (token: string) => ({ Cookie: `slirc_session=${token}` });
const get = (path: string, token?: string) => app.request(path, { headers: token ? cookie(token) : {} });
const remove = (id: number, token: string, headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Links": "1" }) =>
  app.request(`/api/links/${id}/remove`, { method: "POST", headers: { ...cookie(token), ...headers }, body: "{}" });

function account(nick: string, kind = "human", role = "member"): string {
  const id = `acct-${nick}`;
  db.query(`INSERT INTO accounts (account_id, nick, email, role, kind, owner, verified_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, 1)
            ON CONFLICT(nick) DO UPDATE SET role = excluded.role, kind = excluded.kind, verified_at = 1`).run(id, nick, `${nick}@example.test`, role, kind);
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, ?, ?)").run(sha(`${nick}-token`), nick, Date.now());
  return (db.query("SELECT account_id FROM accounts WHERE nick = ?").get(nick) as { account_id: string }).account_id;
}

let adaId = "";
let secretId = 0;
let openId = 0;
beforeEach(() => {
  process.env.SLIRC_HELPERS = "help,links";
  db.exec("DELETE FROM links; DELETE FROM links_fts; DELETE FROM link_seen; DELETE FROM link_topic_edits; DELETE FROM sessions; DELETE FROM channel_members; DELETE FROM channels");
  db.exec("DELETE FROM accounts WHERE nick <> 'bitbonsai'");
  db.query("UPDATE accounts SET role = 'admin', verified_at = COALESCE(verified_at, 1) WHERE nick = 'bitbonsai'").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(sha("owner-token"), Date.now());
  adaId = account("ada");
  account("ben");
  account("robo", "agent");
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#vault', 'ada', 'secret', 1)").run();
  db.query("INSERT INTO channel_members (channel, nick) VALUES ('#vault', 'ada')").run();
  openId = recordShare({ url: "https://example.com/open", title: "Open roadmap", topics: ["tooling"], sharedAt: Date.UTC(2026, 2, 1), sharerName: "ada", sharerAccount: adaId, origin: "#general", enriched: true })!.id;
  secretId = recordShare({ url: "https://example.com/secret", title: "Zebra merger memo", topics: ["zebra-only"], scope: "#vault", origin: "#vault", sharedAt: Date.UTC(2026, 2, 2), sharerName: "Quiet Person", sharerAccount: adaId, enriched: true })!.id;
});

test("with the helper off every links route is missing", async () => {
  process.env.SLIRC_HELPERS = "help,remind";
  for (const path of ["/api/links", "/api/links/facets"]) expect((await get(path, "ada-token")).status).toBe(404);
  expect((await remove(openId, "ada-token")).status).toBe(404);
  delete process.env.SLIRC_HELPERS;
  expect((await get("/api/links", "ada-token")).status).toBe(404);
});

test("members only, and never cached", async () => {
  expect((await get("/api/links")).status).toBe(401);
  expect((await get("/api/links/facets")).status).toBe(401);
  expect((await get("/api/links", "robo-token")).status).toBe(403);
  const response = await get("/api/links", "ada-token");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

test("a member of the private channel sees its links; nobody else gets a row, a count or a name from it", async () => {
  const mine = await (await get("/api/links", "ada-token")).json();
  expect(mine.total).toBe(2);
  expect(mine.rows.map((row: any) => row.title)).toEqual(["Zebra merger memo", "Open roadmap"]);
  expect(mine.rows[0].private).toBe("#vault");
  expect(mine.rows[0].canRemove).toBe(true);
  // An account id never leaves the server.
  expect(JSON.stringify(mine)).not.toContain(adaId);

  for (const path of ["/api/links", "/api/links?q=zebra", "/api/links?q=merger", "/api/links?topic=zebra-only", "/api/links?origin=%23vault", "/api/links?channel=%23vault", "/api/links?sharer=Quiet%20Person", "/api/links/lookup?url=https%3A%2F%2Fexample.com%2Fsecret", "/api/links?site=example.com",
    "/api/links/facets", "/api/links/facets?q=zebra", "/api/links/facets?channel=%23vault", "/api/links/facets?topic=zebra-only"]) {
    const body = JSON.stringify(await (await get(path, "ben-token")).json());
    expect(body).not.toMatch(/zebra|vault|merger|Quiet/i);
  }
  const theirs = await (await get("/api/links", "ben-token")).json();
  expect([theirs.total, theirs.rows.length, theirs.rows[0].canRemove]).toEqual([1, 1, false]);
  const facets = await (await get("/api/links/facets", "ben-token")).json();
  expect(facets).toEqual({ total: 1, topics: [{ value: "tooling", count: 1 }], sources: [{ value: "web", count: 1 }], origins: [{ value: "#general", count: 1 }], sharers: [{ value: "ada", count: 1 }], years: [{ value: "2026", count: 1 }], week: 0, month: 0 });
  // The admin is not in the channel either.
  expect((await (await get("/api/links", "owner-token")).json()).total).toBe(1);
});

test("search parameters reach the query, and junk is refused quietly", async () => {
  expect((await (await get("/api/links?q=road", "ada-token")).json()).rows.map((row: any) => row.id)).toEqual([openId]);
  expect((await (await get("/api/links?topic=tooling&topic=zebra-only", "ada-token")).json()).total).toBe(0);
  expect((await (await get("/api/links?from=2026-03-02&to=2026-03-02", "ada-token")).json()).rows.map((row: any) => row.id)).toEqual([secretId]);
  expect((await (await get("/api/links?source=nope", "ada-token")).json()).total).toBe(0);
  expect((await (await get(`/api/links?q=${encodeURIComponent('" OR title:*')}&limit=abc&offset=-4`, "ada-token")).json()).total).toBe(0);
  expect((await (await get("/api/links?limit=1", "ada-token")).json()).more).toBe(true);
  expect((await (await get("/api/links?when=2026", "ada-token")).json()).total).toBe(2);
  expect((await (await get("/api/links?when=2025", "ada-token")).json()).total).toBe(0);
  expect((await (await get("/api/links?when=week", "ada-token")).json()).total).toBe(0);
});

test("lookup says whether an address is already saved, to the people who may see it", async () => {
  const mine = await (await get(`/api/links/lookup?url=${encodeURIComponent("http://www.example.com/secret/?utm_source=x")}`, "ada-token")).json();
  expect(mine.link.id).toBe(secretId);
  expect((await (await get(`/api/links/lookup?url=${encodeURIComponent("https://example.com/secret")}`, "ben-token")).json()).link).toBeNull();
  expect((await (await get(`/api/links/lookup?url=${encodeURIComponent("https://example.com/open")}`, "ben-token")).json()).link.id).toBe(openId);
  expect((await (await get("/api/links/lookup?url=javascript:alert(1)", "ben-token")).json()).link).toBeNull();
  expect((await get("/api/links/lookup?url=https://example.com/open")).status).toBe(401);
});

test("a site icon is served only for a host the member has a link on, and is kept once fetched", async () => {
  const { storeFavicon, storedFavicon } = await import("../src/links.ts");
  storeFavicon("example.com", "image/png", new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]));
  const mine = await get("/api/links/favicon?host=example.com", "ben-token");
  expect(mine.status).toBe(200);
  expect(mine.headers.get("content-type")).toBe("image/png");
  expect(mine.headers.get("x-content-type-options")).toBe("nosniff");
  expect(mine.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect((await mine.arrayBuffer()).byteLength).toBe(21);
  // A host with no link the member can see is never fetched, whatever is stored for it.
  storeFavicon("private-only.test", "image/png", new Uint8Array(32));
  expect((await get("/api/links/favicon?host=private-only.test", "ben-token")).status).toBe(404);
  expect((await get("/api/links/favicon?host=nowhere.example", "ben-token")).status).toBe(404);
  for (const host of ["", "localhost", "127.0.0.1:80", "example.com/x", "exa mple.com"]) expect((await get(`/api/links/favicon?host=${encodeURIComponent(host)}`, "ben-token")).status).toBe(404);
  expect((await get("/api/links/favicon?host=example.com")).status).toBe(401);
  // A host that gave no icon is remembered as such.
  storeFavicon("example.com", null, null);
  expect((await get("/api/links/favicon?host=example.com", "ben-token")).status).toBe(404);
  expect(storedFavicon("example.com")?.body).toBeNull();
});

test("topics: any member who sees the link edits them; outside a private channel the link is not there", async () => {
  const edit = (id: number, token: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN, "X-Slirc-Links": "1" }) =>
    app.request(`/api/links/${id}/topics`, { method: "POST", headers: { ...cookie(token), ...headers }, body: JSON.stringify(body) });
  const added = await edit(openId, "ben-token", { add: "Team Picks" });
  expect(added.status).toBe(200);
  const body = await added.json();
  expect(body.link.topics).toEqual(["tooling", "team-picks"]);
  expect(JSON.stringify(body)).not.toContain(adaId);
  expect((await (await edit(openId, "ben-token", { remove: "tooling" })).json()).link.topics).toEqual(["team-picks"]);
  expect((await (await get("/api/links/topics", "ben-token")).json()).topics).toEqual([{ value: "team-picks", count: 1 }]);

  // A non-member of the private channel cannot edit its link, or learn that it exists.
  expect((await edit(secretId, "ben-token", { add: "leak" })).status).toBe(404);
  expect((await edit(secretId, "ben-token", { remove: "zebra-only" })).status).toBe(404);
  expect((await edit(secretId, "owner-token", { add: "leak" })).status).toBe(404);
  expect((await edit(secretId, "ada-token", { add: "kept" })).status).toBe(200);
  expect((await (await get("/api/links/topics", "ada-token")).json()).topics.map((topic: any) => topic.value).sort()).toEqual(["kept", "team-picks", "zebra-only"]);
  expect(JSON.stringify(await (await get("/api/links/topics", "ben-token")).json())).not.toMatch(/zebra|kept/);

  expect((await edit(openId, "ben-token", { add: "!!!" })).status).toBe(400);
  expect((await edit(openId, "ben-token", {})).status).toBe(400);
  expect((await edit(openId, "ben-token", { add: ["a"] })).status).toBe(400);
  expect((await edit(openId, "robo-token", { add: "bot" })).status).toBe(403);
  expect((await app.request(`/api/links/${openId}/topics`, { method: "POST", body: "{}" })).status).toBe(401);
  expect((await edit(openId, "ben-token", { add: "csrf" }, { "Content-Type": "application/json", Origin: "https://evil.example", "X-Slirc-Links": "1" })).status).toBe(403);
  expect(db.query("SELECT nick, action, topic FROM link_topic_edits ORDER BY id").all()).toEqual([
    { nick: "ben", action: "add", topic: "team-picks" }, { nick: "ben", action: "remove", topic: "tooling" }, { nick: "ada", action: "add", topic: "kept" },
  ]);
});

test("a link's image is served to the members who may see the link, and to nobody else", async () => {
  const webp = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  for (const id of [openId, secretId]) db.query("INSERT INTO link_images (link_id, state, mime, body, width, height, fetched_at) VALUES (?, 'image', 'image/webp', ?, 320, 200, 1)").run(id, webp);
  const mine = await get(`/api/links/${secretId}/image`, "ada-token");
  expect(mine.status).toBe(200);
  expect(mine.headers.get("content-type")).toBe("image/webp");
  expect(mine.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await mine.arrayBuffer()).byteLength).toBe(8);
  // Outside the private channel the image does not exist, for a member or an admin.
  expect((await get(`/api/links/${secretId}/image`, "ben-token")).status).toBe(404);
  expect((await get(`/api/links/${secretId}/image`, "owner-token")).status).toBe(404);
  expect((await get(`/api/links/${secretId}/image`)).status).toBe(401);
  expect((await get(`/api/links/${openId}/image`, "ben-token")).status).toBe(200);
  expect((await get("/api/links/999999/image", "ben-token")).status).toBe(404);
  // The list says which rows have one, and only for rows the member sees.
  const rows = (await (await get("/api/links", "ben-token")).json()).rows;
  expect(rows.map((row: any) => [row.id, row.image])).toEqual([[openId, true]]);
  db.exec("DELETE FROM link_images");
  expect((await get(`/api/links/${openId}/image`, "ben-token")).status).toBe(404);
  expect((await (await get("/api/links", "ben-token")).json()).rows[0].image).toBe(false);
});

test("the reader view gives a saved copy as text to members who may see the link", async () => {
  const body = "First paragraph.\n\n<script>alert(1)</script> shown as characters.";
  for (const id of [openId, secretId]) db.query("INSERT INTO link_copies (link_id, state, title, byline, text, saved_at) VALUES (?, 'text', 'Saved title', 'A. Writer', ?, 77)").run(id, body);
  const mine = await get(`/api/links/${secretId}/copy`, "ada-token");
  expect(mine.status).toBe(200);
  expect(mine.headers.get("content-type")).toContain("application/json");
  expect(mine.headers.get("cache-control")).toBe("private, no-store");
  expect(await mine.json()).toEqual({ id: secretId, url: "https://example.com/secret", title: "Saved title", byline: "A. Writer", text: body, savedAt: 77, image: false, gone: false, imageWidth: null, imageHeight: null, kind: "page" });
  // Outside the private channel there is no copy, for a member or an admin.
  expect((await get(`/api/links/${secretId}/copy`, "ben-token")).status).toBe(404);
  expect((await get(`/api/links/${secretId}/copy`, "owner-token")).status).toBe(404);
  expect((await get(`/api/links/${secretId}/copy`)).status).toBe(401);
  expect((await get(`/api/links/${openId}/copy`, "ben-token")).status).toBe(200);
  // The list says which rows have one, and whether the original is gone.
  db.query("UPDATE link_copies SET gone_at = 99 WHERE link_id = ?").run(openId);
  const row = (await (await get("/api/links", "ben-token")).json()).rows[0];
  expect([row.copy, row.gone]).toEqual([true, true]);
  db.exec("DELETE FROM link_copies");
  expect((await get(`/api/links/${openId}/copy`, "ben-token")).status).toBe(404);
  expect((await (await get("/api/links", "ben-token")).json()).rows[0].copy).toBe(false);
});

// The stored preview carries the size it was made at, so the reader reserves its box instead of
// moving the text down when the picture arrives.
test("the reader view carries a stored preview's pixel size", async () => {
  for (const id of [openId, secretId]) db.query("INSERT INTO link_copies (link_id, state, title, byline, text, saved_at) VALUES (?, 'text', 'Saved', '', 'Words.', 7)").run(id);
  db.query("INSERT INTO link_images (link_id, state, mime, body, width, height, fetched_at) VALUES (?, 'image', 'image/webp', ?, 320, 180, 9)").run(openId, new Uint8Array([1, 2, 3]));
  const body = await (await get(`/api/links/${openId}/copy`, "ben-token")).json();
  expect([body.image, body.imageWidth, body.imageHeight]).toEqual([true, 320, 180]);
  db.exec("DELETE FROM link_images");
  db.exec("DELETE FROM link_copies");
  expect((await (await get("/api/links", "ben-token")).json()).rows[0].image).toBe(false);
});

test("removal: the adder and an admin may, another member may not, and an unseen link is missing", async () => {
  expect((await remove(openId, "ben-token")).status).toBe(403);
  expect((await remove(secretId, "ben-token")).status).toBe(404);
  expect((await remove(secretId, "owner-token")).status).toBe(404);
  expect((await remove(999_999, "ada-token")).status).toBe(404);
  expect((await remove(0, "ada-token")).status).toBe(404);
  // A form post from another site cannot remove anything.
  expect((await remove(openId, "ada-token", { "Content-Type": "application/json", Origin: "https://evil.example", "X-Slirc-Links": "1" })).status).toBe(403);
  expect((await remove(openId, "ada-token", { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN })).status).toBe(403);
  expect((await (await get("/api/links", "ben-token")).json()).total).toBe(1);

  expect((await remove(openId, "owner-token")).status).toBe(200);
  expect((await remove(secretId, "ada-token")).status).toBe(200);
  expect((await (await get("/api/links", "ada-token")).json()).total).toBe(0);
  expect((await remove(openId, "ada-token")).status).toBe(404);
});
