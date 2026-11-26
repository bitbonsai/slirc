// A private workspace keeps its old behavior: an unknown address gets nothing, and there is no
// signed-out read of any channel.
import "./fixture.ts";

process.env.SLIRC_MODE = "private_workspace";
process.env.OPEN_CHANNELS = "";
process.env.APP_ORIGIN = "https://app.example.test";
process.env.RESEND_API_KEY = "test-key";
process.env.RESEND_FROM = "Slirc <noreply@example.test>";
delete process.env.MAGIC_LINK_LOG;

import { expect, mock, test } from "bun:test";

const mail: unknown[] = [];
let readerOpened = false;
const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, operClient: async () => { readerOpened = true; throw new Error("no reader in private mode"); } }));
mock.module("resend", () => ({ Resend: class { emails = { send: async (message: unknown) => { mail.push(message); return { data: { id: "test" }, error: null }; } }; } }));

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");

test("an unknown address gets no account and no mail", async () => {
  const response = await app.request("/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "stranger@example.test" }) });
  expect(response.status).toBe(204);
  expect(db.query("SELECT 1 FROM accounts WHERE email = 'stranger@example.test'").get()).toBeNull();
  expect(mail).toHaveLength(0);
});

test("peek is not found for every channel, signed in or not", async () => {
  db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES ('#team', 'bitbonsai', 'workspace', 1) ON CONFLICT DO NOTHING").run();
  for (const name of ["open-chat", "help", "team"]) {
    expect((await app.request(`/api/peek/${name}`)).status).toBe(404);
    expect((await app.request(`/api/peek/${name}`, { headers: { Cookie: "slirc_session=owner-session" } })).status).toBe(404);
  }
  expect(readerOpened).toBe(false);
});
