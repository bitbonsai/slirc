// A local stack running as the public playground (MAGIC_LINK_LOG=true) still signs up through the
// link: the new account stays unverified until the link is opened, and /auth/me never verifies it.
import "./fixture.ts";

process.env.APP_ORIGIN = "http://localhost:9110";
process.env.MAGIC_LINK_LOG = "true";
process.env.OPEN_CHANNELS = "#open-chat,#help";

import { expect, mock, test } from "bun:test";

const grants = await import("../src/grants.ts");
mock.module("../src/grants.ts", () => ({ ...grants, createDirectChannel: async () => {}, readDirectChannelReady: async () => false }));

const { app } = await import("../src/server.ts");
const { accountByEmail } = await import("../src/accounts.ts");

test("a new address is unverified until its link opens", async () => {
  const response = await app.request("/auth/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "local@new.test", name: "Local" }) });
  expect(response.status).toBe(200);
  const { devLink } = await response.json() as { devLink: string };
  expect(accountByEmail("local@new.test")!.verifiedAt).toBeNull();
  expect(await (await app.request("/auth/me")).json()).toMatchObject({ authenticated: false });
  expect(accountByEmail("local@new.test")!.verifiedAt).toBeNull();
  const link = new URL(devLink);
  const verified = await app.request(link.pathname + link.search);
  expect(verified.headers.get("set-cookie") || "").toMatch(/slirc_session=[^;]/);
  expect(accountByEmail("local@new.test")!.verifiedAt).toBeTruthy();
  expect(accountByEmail("local@new.test")!.nick).toBe("local");
});
