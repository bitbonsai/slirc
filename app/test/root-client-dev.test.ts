import "./fixture.ts";

import { describe, expect, test } from "bun:test";

// Local dev links mode: the candidate client is served, but the bundle must not be memoized for the
// process, because edits under app/client/ are not necessarily Bun --watch dependencies.
process.chdir(new URL("..", import.meta.url).pathname);
process.env.APP_ORIGIN = "http://localhost:8080";
process.env.MAGIC_LINK_LOG = "true";
delete process.env.SLIRC_CLIENT;
delete process.env.SLIRC_CLIENT_V2;

const { app, buildClient } = await import("../src/server.ts");
const { localDevLinks } = await import("../src/config.ts");

describe("candidate client in local dev links mode", () => {
  test("the bundle is rebuilt on each request", async () => {
    expect(localDevLinks()).toBe(true);
    expect(buildClient()).not.toBe(buildClient());
  });
});
