import "./fixture.ts";
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

const originalCwd = process.cwd();
process.chdir(join(import.meta.dir, ".."));
afterAll(() => process.chdir(originalCwd));

process.env.APP_ORIGIN = "http://localhost:9110";
process.env.MAGIC_LINK_LOG = "true";
process.env.SLIRC_CLIENT = "true";
const { app } = await import("../src/server.ts");

test("local HTTP serves the client at the root and its bundle", async () => {
  for (const path of ["/", "/client.js"]) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-type")).toContain(path.endsWith(".js") ? "javascript" : "html");
  }
});

test("local sign-in returns a usable link back to the client without email", async () => {
  const response = await app.request("http://localhost:9110/auth/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost:9110" },
    body: JSON.stringify({ email: "owner@example.com", next: "/" }),
  });
  expect(response.status).toBe(200);
  const { devLink } = await response.json();
  expect(new URL(devLink).origin).toBe("http://localhost:9110");
  const signedIn = await app.request(devLink);
  expect(signedIn.status).toBe(302);
  expect(signedIn.headers.get("location")).toBe("/");
  expect(signedIn.headers.get("set-cookie")).toContain("slirc_session=");
});
