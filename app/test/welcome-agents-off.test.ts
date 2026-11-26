import "./fixture.ts";

import { expect, test } from "bun:test";

// The agent card goes when the instance turns agents off. The flag is read at import.
process.chdir(new URL("..", import.meta.url).pathname);
process.env.SLIRC_AGENTS_ENABLED = "false";
const { app } = await import("../src/server.ts");

test("/welcome has no agent card when agents are off on this instance", async () => {
  const body = await (await app.request("/welcome")).text();
  expect(body).not.toContain("data-agents");
  expect(body).not.toContain('href="/agents"');
  expect(body).not.toContain("{{");
});
