// Shared test environment. Import this *first* in a test file:
//
//   import "./fixture.ts";
//
// Static imports are evaluated before the importing module's body, so a file that
// needs something different (a different owner, dev magic links) must set it in its
// body and load the app with `await import(...)` afterwards — which is the pattern
// these tests already use.
//
// Why the owner settings are pinned: the repo `.env` exports OWNER_NICK and USERS_JSON,
// and `bun test` loads it. Without a pin, accounts.ts seeds whoever that env names, so
// fixtures keyed to `bitbonsai` find no account and every session-authenticated call 404s.
process.env.DB_PATH = ":memory:";
// Agent code saves the last workspace and session state under XDG_STATE_HOME (or the real
// ~/.local/state) and ~/.pi/agent; a test that reaches it must never touch the owner's copies.
{
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const root = mkdtempSync(`${require("node:os").tmpdir()}/slirc-app-test-state-`);
  process.env.XDG_STATE_HOME = `${root}/state`;
  process.env.PI_CODING_AGENT_DIR = `${root}/pi`;
}
process.env.NODE_ENV = "test";
process.env.APP_ORIGIN = "https://app.example.test";
delete process.env.APP_HOST;
delete process.env.SLIRC_BRAND;
delete process.env.APPLE_APP_IDS;
delete process.env.WAITLIST_API_URL;
delete process.env.WAITLIST_ORIGIN;
delete process.env.VAPID_CONTACT;
process.env.OWNER_NICK = "bitbonsai";
process.env.ADMIN_NICK = "bitbonsai";
process.env.USERS_JSON = JSON.stringify({ bitbonsai: "owner@example.com" });
process.env.OPEN_CHANNELS = "#help, #support";
// Fixtures list open channels explicitly, so they select the mode that allows them.
process.env.SLIRC_MODE = "public_playground";
process.env.ERGO_API_MOCK = "true";
process.env.ERGO_OPER_USER = "slirc-org";
// A dev nick or a bot limit from the environment would change authenticated identity.
delete process.env.DEV_IRC_NICK;
delete process.env.BOT_LIMIT;
// Client-mode flags are set explicitly by the tests that need them, never inherited from a shell.
delete process.env.SLIRC_CLIENT;
delete process.env.SLIRC_CLIENT_V2;
// Tests must never use inherited live provider credentials. Routes still mint local fixtures;
// provider-specific tests must inject their own mock explicitly.
for (const key of ["RESEND_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "GIPHY_API_KEY", "ERGO_API_TOKEN", "ERGO_API_TOKEN_FILE"]) delete process.env[key];

export {};
