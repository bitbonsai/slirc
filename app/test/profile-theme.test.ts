import "./fixture.ts";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.env.SLIRC_HELPERS_ENABLED = "false";
const { db } = await import("../src/db.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");
afterAll(() => db.close());
const accountId = accountByNick("bitbonsai")!.id;
const token = "theme-fixture-session";
db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)")
  .run(createHash("sha256").update(token).digest("hex"), Date.now());
const headers = { "Content-Type": "application/json", Cookie: `slirc_session=${token}` };
const patch = (body: unknown) => app.request("/profile", { method: "PATCH", headers, body: JSON.stringify(body) });
const me = () => app.request("/auth/me", { headers });

test("theme-only saves preserve profile fields and auth/me returns only the signed-in theme", async () => {
  expect((await (await me()).json()).theme).toBe("system");
  expect((await patch({ accountId, fullName: "Stored name", about: "Stored about", badge: "available" })).status).toBe(200);
  const before = db.query("SELECT * FROM profiles WHERE account = 'bitbonsai'").get();
  for (const theme of ["light", "dark", "system"]) {
    expect((await patch({ accountId, theme })).status).toBe(200);
    expect(db.query("SELECT * FROM profiles WHERE account = 'bitbonsai'").get()).toEqual(before);
    const result = await (await me()).json();
    expect(result.theme).toBe(theme);
    expect(result.profile).not.toHaveProperty("theme");
    for (const detail of Object.values(result.accountDetails)) expect(detail).not.toHaveProperty("theme");
  }
  expect(await (await app.request("/auth/me")).json()).not.toHaveProperty("theme");
});

test("invalid themes and changed or missing account ids cannot change preference", async () => {
  expect((await patch({ accountId, theme: "dark" })).status).toBe(200);
  for (const theme of [null, "", "auto", "LIGHT", 1, {}, ["light"]]) {
    expect((await patch({ accountId, theme })).status).toBe(400);
  }
  expect((await patch({ accountId: "previous-account", theme: "light" })).status).toBe(409);
  expect((await patch({ theme: "light" })).status).toBe(409);
  expect((await patch({ accountId, about: "Changed about" })).status).toBe(200);
  expect((await (await me()).json()).theme).toBe("dark");
});
