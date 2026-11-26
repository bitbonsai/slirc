import "./fixture.ts";

import { describe, expect, test } from "bun:test";

// serveStatic and the candidate shell resolve "./public" from the cwd.
process.chdir(new URL("..", import.meta.url).pathname);
// Production defaults: no client-selection flag, dev profile or magic-link logging.
process.env.APP_ORIGIN = "https://app.slirc.test";
delete process.env.MAGIC_LINK_LOG;
delete process.env.SLIRC_CLIENT;
delete process.env.SLIRC_CLIENT_V2;

const { app, clientVersion, buildClient } = await import("../src/server.ts");
const { localDevLinks } = await import("../src/config.ts");

const CLIENT_MARK = 'x-data="client()"';

describe("candidate client at the canonical root", () => {
  // A guest /open-chat must return HTML without waiting for IRC; /index.html keeps installed
  // clients' bootstrap URL on the current shell.
  test("root paths serve the candidate document directly, with manifest and worker hook injected", async () => {
    for (const path of ["/", "/dms", "/more", "/open-chat", "/help", "/dm/eve", "/profile", "/invitations", "/join/tok", "/index.html"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const body = await response.text();
      expect(body).toContain(CLIENT_MARK);
      expect(body).not.toContain('x-data="chat()"');
      expect(body).not.toContain("__slirc_boot");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
    const root = await (await app.request("/")).text();
    expect(root).toContain('rel="manifest"');
    expect(root).toContain('<script src="/sw-register.js?v=');
  });

  test("the production bundle is built once per process", async () => {
    expect(buildClient()).toBe(buildClient());
  });

  test("pairing lands on the root query, and the old boot document redirects to the root", async () => {
    const response = await app.request("/pair/482917");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/?pair=482917");
    expect((await app.request("/boot.html")).status).toBe(302);
  });

  test("the candidate worker is served at /sw.js and revalidates", async () => {
    const response = await app.request("/sw.js");
    expect(await response.text()).toContain("LEGACY_CACHE_PREFIX");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("version is the hash of the served client bundle and moves with it", async () => {
    const bundle = await (await app.request("/client.js")).text();
    expect(bundle.length).toBeGreaterThan(0);
    const { version } = await (await app.request("/api/version")).json();
    expect(version).toMatch(/^[0-9a-f]{8}$/);
    expect(version).toBe(clientVersion(bundle));
    expect(clientVersion(`${bundle} `)).not.toBe(version);
  });

  test("default client never enables dev login shortcuts", async () => {
    expect(localDevLinks()).toBe(false);
    const response = await app.request("/auth/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com" }),
    });
    expect(response.status).toBe(204);
  });
});
