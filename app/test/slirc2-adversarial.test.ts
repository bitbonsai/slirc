import "./fixture.ts";
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";

process.chdir(new URL("..", import.meta.url).pathname);
const { db } = await import("../src/db.ts");
await import("../src/accounts.ts");
const { app } = await import("../src/server.ts");

// Preserve the server-side privacy regression after removing legacy-client probes.
test("a signed-in nonmember cannot fetch a secret-room upload", async () => {
  const nick = "h0-upload-nonmember";
  db.query("INSERT INTO accounts (nick,email,role,verified_at,created_at) VALUES (?,?,?,?,?)")
    .run(nick, `${nick}@h0.invalid`, "member", Date.now(), Date.now());
  const token = `h0-session-${nick}`;
  db.query("INSERT INTO sessions (token_hash,nick,created_at) VALUES (?,?,?)")
    .run(createHash("sha256").update(token).digest("hex"), nick, Date.now());
  db.query("INSERT INTO channels (channel,owner,visibility,created_at) VALUES (?,?,?,?)")
    .run("#h0-secret", "someone-else", "secret", Date.now());
  db.query("INSERT INTO uploads (id,nick,channel,kind,mime,data,created_at) VALUES (?,?,?,?,?,?,?)")
    .run("h0-upload", "someone-else", "#h0-secret", "image", "image/png", Buffer.from("private bytes"), Date.now());
  const response = await app.request("/uploads/h0-upload", { headers: { Cookie: `slirc_session=${token}` } });
  expect(response.status).toBe(403);
});
