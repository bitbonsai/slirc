// Admin page Refresh: it always reloads or says why it can't, and never stays on "Refreshing…".
import { afterEach, expect, test } from "bun:test";
import { createAdminPage } from "@client/admin-page.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function page(state: { scope?: { account: string } | null; key?: string; stopped?: boolean } = {}) {
  const live = { scope: { account: "ada" } as { account: string } | null, key: "ada", stopped: false, ...state };
  const core = { authenticated: true, account: "ada" };
  const session = { scope: () => live.scope, key: () => live.key, stopped: () => live.stopped, signingOut: () => false } as any;
  return { live, admin: createAdminPage((value) => value, { core, session }) };
}

const answer = (body: unknown) => { globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch; };

test("Refresh with an ended session says so instead of doing nothing", async () => {
  answer({ status: null });
  const { admin } = page({ scope: null });
  await admin.load();
  expect(admin.loading).toBe(false);
  expect(admin.error).toBe("Your session has ended. Reload the page to see the status.");

  const stopped = page({ stopped: true }).admin;
  await stopped.load();
  expect(stopped.error).toContain("Reload the page");
});

test("a request whose session changed mid-flight still clears Refreshing…", async () => {
  answer({ status: null });
  const { live, admin } = page();
  const pending = admin.load();
  expect(admin.loading).toBe(true);
  live.key = "ada-reconnected";
  await pending;
  expect(admin.loading).toBe(false);
  expect(admin.loaded).toBe(false);

  live.key = "ada";
  await admin.load();
  expect(admin.loaded).toBe(true);
  expect(admin.error).toBe("");
});
