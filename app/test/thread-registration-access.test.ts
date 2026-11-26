// Old #t- thread creation is retired: both routes answer 410 and no row or channel is made.
import "./fixture.ts";

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";

const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const auth = (token: string) => ({ Cookie: `slirc_session=${token}`, "Content-Type": "application/json" });

beforeEach(() => {
  db.query("DELETE FROM sessions").run();
  db.query("INSERT INTO sessions (token_hash, nick, created_at) VALUES (?, 'bitbonsai', ?)").run(hash("owner-session"), Date.now());
});

describe("retired thread creation", () => {
  test("POST /api/threads answers 410 and creates nothing", async () => {
    const response = await app.request("/api/threads", { method: "POST", headers: auth("owner-session"), body: JSON.stringify({ parent: "#room", root: "msg-1", title: "New title" }) });
    expect(response.status).toBe(410);
    expect(db.query("SELECT count(*) AS n FROM threads").get()).toEqual({ n: 0 });
  });

  test("POST /api/dms/:nick/threads answers 410", async () => {
    const response = await app.request("/api/dms/someone/threads", { method: "POST", headers: auth("owner-session") });
    expect(response.status).toBe(410);
  });

  test("/auth/me lists no threads even when old rows remain", async () => {
    db.query("INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES ('#t-old111', '#room', 'm', 'Old', '', '', '', '', 'bitbonsai', 1, 1)").run();
    try {
      const me = await (await app.request("/auth/me", { headers: auth("owner-session") })).json();
      expect(me.threads).toEqual([]);
    } finally {
      db.query("DELETE FROM threads WHERE channel = '#t-old111'").run();
    }
  });
});
