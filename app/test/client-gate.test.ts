import "./fixture.ts";
import { expect, test } from "bun:test";

process.chdir(new URL("..", import.meta.url).pathname);
process.env.APP_ORIGIN = "https://app.slirc.test";
process.env.MAGIC_LINK_LOG = "true";
delete process.env.SLIRC_CLIENT;
delete process.env.SLIRC_CLIENT_V2;
delete process.env.SLIRC_DEV_PROFILE;
const { app } = await import("../src/server.ts");
const { localDevLinks } = await import("../src/config.ts");

test("production serves the default client without enabling local auth shortcuts", async () => {
  expect(localDevLinks()).toBe(false);
  expect((await app.request("/client.js")).status).toBe(200);
  expect(await (await app.request("/")).text()).toContain('x-data="client()"');
  expect((await app.request("/auth/request", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "new@example.test" }),
  })).status).toBe(204);
});
