// M1 (security audit 18 Nov 2026): every page the app serves carries a Content-Security-Policy
// that refuses inline scripts, and no page the app serves still depends on one.
import "./fixture.ts";

import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Pages read "./public" from the cwd.
process.chdir(new URL("..", import.meta.url).pathname);

const { app, contentSecurityPolicy } = await import("../src/server.ts");

test("the policy allows only this origin's scripts, plus the eval Alpine needs", () => {
  const policy = contentSecurityPolicy();
  const script = policy.split("; ").find((part) => part.startsWith("script-src "))!;
  expect(script).toBe("script-src 'self' 'unsafe-eval'");
  for (const part of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) expect(policy).toContain(part);
  expect(policy).toContain("https://www.youtube-nocookie.com");
});

test("HTML pages carry the policy; untrusted media keeps its own sandbox policy", async () => {
  for (const path of ["/", "/welcome", "/j/missing-token", "/docs", "/docs/messages", "/open-chat"]) {
    const response = await app.request(path);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy());
  }
  const { untrustedMediaHeaders } = await import("../src/server.ts");
  expect(untrustedMediaHeaders("image/png", "x")["Content-Security-Policy"]).toBe("default-src 'none'; sandbox");
});

// An inline <script> or on*= attribute would be blocked by the policy, so the page would break.
const inline = /<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+="/i;
test("no served page has an inline script or event-handler attribute", async () => {
  for (const path of ["/", "/welcome", "/j/missing-token"]) expect(await (await app.request(path)).text()).not.toMatch(inline);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".html")) files.push(path);
    }
  };
  walk("./public");
  expect(files.length).toBeGreaterThan(10);
  for (const file of files) expect({ file, inline: inline.test(await Bun.file(file).text()) }).toEqual({ file, inline: false });
});
