import { sameOriginJson, verifiedHuman } from "../http/session.ts";
import { db } from "../db.ts";
import { ergo, rotateIrcPassword } from "../accounts.ts";
import { botLimit, botCount, createBotAccount, BotError } from "../bot-accounts.ts";
import { appError } from "../http/common.ts";
import { clearIrcResetNotice, IRC_RESET_BOTS } from "../http/irc-devices.ts";
import { removeAgentAccount } from "../agent-accounts.ts";
import { accountIrcPassword } from "../irc-key.ts";
import { Hono } from "hono";

export const bots = new Hono();

// Bots are instance-managed IRC accounts: an admin mints the credentials, and
// talking to a bot happens over IRC like anyone else. Personal agents
// (`/api/agents`) are unaffected and remain owner-scoped.
// Writes mint or revoke a credential, so they refuse cross-site requests the way sign-in does:
// same Origin, a JSON body and a header a plain form cannot send. The admin check runs first.
const botsCsrf = (c: any) => sameOriginJson(c, "X-Slirc-Bots");

bots.get("/api/bots", async (c) => {
  c.header("Cache-Control", "no-store");
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  // Instance helpers (`owner IS NULL`) are not part of managed bots; list user-created bots only.
  const bots = db.query("SELECT nick, created_at FROM accounts WHERE kind = 'bot' AND owner IS NOT NULL ORDER BY nick").all() as { nick: string; created_at: number }[];
  return c.json({
    bots: await Promise.all(bots.map(async (bot) => {
      const details = await ergo("/v1/account_details", { accountName: bot.nick }).catch(() => null);
      return { nick: bot.nick, createdAt: bot.created_at, lastSeen: details?.success ? details.lastSeen ?? null : null };
    })),
    limit: botLimit(),
    // The list spans every admin's bots; the per-admin quota comes from botCount on the caller.
    used: botCount(admin.nick),
  });
});

bots.post("/api/bots", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!botsCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const body = await c.req.json().catch(() => null) as { name?: unknown } | null;
  try {
    // Admin gate runs inside createBotAccount before any Ergo saregister or DB write.
    return c.json(await createBotAccount(admin.nick, typeof body?.name === "string" ? body.name : ""), 201);
  } catch (error) {
    if (error instanceof BotError) return c.json({ error: error.message }, error.status as 400);
    return appError(c, error, "Could not create bot account.");
  }
});

bots.post("/api/bots/:nick/rotate", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!botsCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  // owner IS NOT NULL excludes instance helpers from the managed-bot APIs.
  const bot = db.query("SELECT nick FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'bot' AND owner IS NOT NULL").get(c.req.param("nick")) as { nick: string } | null;
  if (!bot) return c.json({ error: "bot not found" }, 404);
  try {
    const password = await rotateIrcPassword(bot.nick);
    clearIrcResetNotice(admin.nick, IRC_RESET_BOTS);
    return c.json({ nick: bot.nick, password });
  } catch (error) {
    return appError(c, error, "Could not rotate the bot password.");
  }
});

bots.delete("/api/bots/:nick", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!botsCsrf(c)) return c.json({ error: "same-origin request required" }, 403);
  const bot = db.query("SELECT nick, account_id, irc_password_gen FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'bot' AND owner IS NOT NULL").get(c.req.param("nick")) as
    { nick: string; account_id: string; irc_password_gen: number | null } | null;
  if (!bot) return c.json({ error: "bot not found" }, 404);
  const channels = (db.query("SELECT channel FROM channel_members WHERE nick = ?").all(bot.nick) as { channel: string }[]).map((row) => row.channel);
  try {
    await removeAgentAccount(bot.nick, accountIrcPassword(bot), channels);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not remove the bot account.");
  }
});
