// Hono before 4.13.16 (GHSA-h7mg-cq63-vhpq) let RegExpRouter, the default for `new Hono()`,
// skip wildcard middleware. server.ts hangs body limits and the pair Origin check on wildcard
// paths, so this pins the router behaviour the app relies on.
import { expect, test } from "bun:test";
import { Hono } from "hono";

function appWith(middlewarePath: string, routePath: string) {
  const app = new Hono();
  const seen: string[] = [];
  app.use(middlewarePath, async (c, next) => {
    seen.push(c.req.path);
    await next();
  });
  app.get(routePath, (c) => c.text("ok"));
  return { app, seen };
}

test("wildcard middleware runs for paths with an encoded line terminator", async () => {
  const { app, seen } = appWith("/api/agent/session/*", "/api/agent/session/poll");
  for (const path of ["/api/agent/session/x%0A", "/api/agent/session/x%0D", "/api/agent/session/x%E2%80%A8", "/api/agent/session/x%E2%80%A9"]) {
    await app.request(path);
  }
  expect(seen.length).toBe(4);
});

test("/prefix/* middleware covers a /prefix* route", async () => {
  const { app, seen } = appWith("/api/pair/*", "/api/pair*");
  const res = await app.request("/api/pair/abc");
  expect(res.status).toBe(200);
  expect(seen).toEqual(["/api/pair/abc"]);
});
