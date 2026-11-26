// A new address joining by invitation is signed in without waiting for the help DM, which takes
// seconds to prove private on Ergo. The DM still opens, the welcome is queued with its crash-safe
// pending row, and the member's open tab gets a "direct" event so the unread DM appears live.
import "./fixture.ts";

process.env.APP_ORIGIN = "https://app.example.test";

import { expect, mock, test } from "bun:test";

// createDirectChannel waits until the test lets it finish, like a slow Ergo proof.
let finishDm: () => void = () => {};
const dmStarted: string[] = [];
mock.module("../src/grants.ts", () => {
  const noop = async () => {};
  return {
    grantChannelOps: noop,
    operClient: noop, readPrivateChannelMode: async () => ({ secret: true, inviteOnly: true }), readDirectChannelReady: async () => true,
    serviceCommand: noop, setAlwaysOn: noop, transferChannel: noop, allowChannelAccess: noop,
    grantChannelAccess: noop, createChannel: noop, setChannelMode: noop, setChannelTopic: noop,
    revokeChannelAccess: noop, createThreadChannel: noop,
    createDirectChannel: (channel: string) => { dmStarted.push(channel); return new Promise<void>((resolve) => { finishDm = resolve; }); },
    NotAuthorizedError: class NotAuthorizedError extends Error {}, redactMessage: noop,
    kickChannelMember: noop, makeChannelSecret: noop, makeThreadChannelsSecret: noop, removeFromThreadChannels: noop, makeChannelOpen: noop, clearChannelAccess: noop,
    unregisterChannel: noop, purgeChannelHistory: noop, renameChannel: noop, removeMemberFromIrc: async () => ({ suspended: true }),
  };
});

const { db } = await import("../src/db.ts");
const { app } = await import("../src/server.ts");
const { accountByNick } = await import("../src/accounts.ts");
const { createEmailInvite } = await import("../src/email-invites.ts");
const { subscribe } = await import("../src/live.ts");

test("the invitation sign-in answers before the help DM opens, then the DM arrives live", async () => {
  db.query("UPDATE accounts SET verified_at = COALESCE(verified_at, 1) WHERE nick = 'bitbonsai'").run();
  db.query("INSERT INTO accounts (nick,email,role,kind,owner,verified_at,created_at) VALUES ('help','help@helpers.invalid','member','bot',NULL,1,1) ON CONFLICT(nick) DO NOTHING").run();
  const owner = accountByNick("bitbonsai")!;
  const invite = createEmailInvite({ inviter: owner.nick, inviterAccountId: owner.id, email: "newbie@example.test", destination: { type: "dm" } });

  const response = await app.request("/auth/invitation/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example.test", "X-Slirc-Invitation": "1" },
    body: JSON.stringify({ token: invite.token, name: "Newbie" }),
  });
  // Signed in while the DM is still being proved.
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.signedIn).toBe(true);
  expect(response.headers.get("set-cookie")).toContain("slirc_session=");
  await Bun.sleep(10);
  expect(dmStarted).toHaveLength(1);
  const events: [string, unknown][] = [];
  const stop = subscribe(body.nick, (event, data) => events.push([event, data]));
  expect((db.query("SELECT onboarded_at FROM accounts WHERE nick = ?").get(body.nick) as { onboarded_at: number | null }).onboarded_at).toBeNull();

  finishDm();
  for (let i = 0; i < 50 && !events.length; i++) await Bun.sleep(10);
  stop();
  expect(events).toEqual([["direct", { channel: dmStarted[0] }]]);
  // The welcome is queued with its pending row, so a crash before the bot sends it re-queues it.
  expect((db.query("SELECT onboarded_at FROM accounts WHERE nick = ?").get(body.nick) as { onboarded_at: number }).onboarded_at).toBeGreaterThan(0);
  expect(db.query("SELECT value FROM meta WHERE key = ?").get(`onboarding-pending:${String(body.nick).toLowerCase()}`)).toEqual({ value: dmStarted[0] });
});
