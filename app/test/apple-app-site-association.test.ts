import "./fixture.ts";
import { afterAll, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

const previousCwd = process.cwd();
process.chdir(join(import.meta.dir, ".."));
const quiet = spyOn(console, "log").mockImplementation(() => {});
afterAll(() => { process.chdir(previousCwd); quiet.mockRestore(); });
const { app } = await import("../src/server.ts");

test("apple-app-site-association returns 404 when APPLE_APP_IDS is unset or empty", async () => {
  const saved = process.env.APPLE_APP_IDS;
  try {
    delete process.env.APPLE_APP_IDS;
    expect((await app.request("/.well-known/apple-app-site-association")).status).toBe(404);
    process.env.APPLE_APP_IDS = " ,  ";
    expect((await app.request("/.well-known/apple-app-site-association")).status).toBe(404);
  } finally {
    if (saved === undefined) delete process.env.APPLE_APP_IDS;
    else process.env.APPLE_APP_IDS = saved;
  }
});

test("apple-app-site-association names the configured iOS app IDs and link paths, with no redirect", async () => {
  const saved = process.env.APPLE_APP_IDS;
  try {
    process.env.APPLE_APP_IDS = " TEAM1.com.example.app , TEAM2.com.example.chat ";
    const response = await app.request("/.well-known/apple-app-site-association", { headers: { Host: "ai-guild.slirc.app" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toStartWith("application/json");
    const body = await response.json();
    const [detail] = body.applinks.details;
    expect(detail.appIDs).toEqual(["TEAM1.com.example.app", "TEAM2.com.example.chat"]);
    const paths = detail.components.map((component: { "/": string }) => component["/"]);
    for (const path of ["/", "/dm/*", "/pair", "/pair/*", "/j/*", "/join/*", "/auth/verify", "/admission"]) expect(paths).toContain(path);
    expect(paths.some((path: string) => path.startsWith("/docs") || path === "*" || path === "/*")).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.APPLE_APP_IDS;
    else process.env.APPLE_APP_IDS = saved;
  }
});
