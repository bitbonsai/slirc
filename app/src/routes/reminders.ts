import { createLimiter } from "../request-security.ts";
import { bodyLimit } from "hono/body-limit";
import { verifiedHuman, currentUser, sameOriginJson } from "../http/session.ts";
import { enabledHelpers } from "../config.ts";
import { directConversation } from "../rooms.ts";
import { openDirectConversation } from "../direct.ts";
import { scheduleReminder, reminderOutcome, helperSay } from "../helper-bot.ts";
import { accountByNick } from "../accounts.ts";
import { validTimeZone, setUserTimeZone } from "../reminders.ts";
import { Hono } from "hono";

export const reminders = new Hono();

// /remind from the app: set the reminder directly and answer with the confirmation, so it shows as a
// notice where the person typed instead of a message in the remind DM. The reminder still fires in
// that DM, the same as an @remind mention. A list is several lines, so remind posts it in the DM and
// `open` tells the app to go there instead of showing a notice.
const remindLimit = createLimiter({ limit: 20, windowMs: 60_000 });

reminders.use("/api/reminders", bodyLimit({ maxSize: 2_048 }));

reminders.post("/api/reminders", async (c) => {
  c.header("Cache-Control", "no-store");
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!sameOriginJson(c, "X-Slirc-Remind")) return c.json({ error: "same-origin request required" }, 403);
  if (!enabledHelpers().includes("remind")) return c.json({ error: "Reminders are off on this server." }, 503);
  const body = await c.req.json().catch(() => ({})) as { text?: unknown; fireAt?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 500) return c.json({ error: "When should I remind you? Try /remind in 20m stretch." }, 400);
  // Remind me → Custom… sends the picked time as epoch ms and the text is only what to remember. It
  // must be ahead of this server's clock, with no skew allowance: the client already refuses past
  // picks by its own clock, so a client clock running behind only bounces picks closer than the skew.
  // At most a year out.
  const now = Date.now();
  const fireAt = body.fireAt;
  if (fireAt !== undefined && (typeof fireAt !== "number" || !Number.isFinite(fireAt) || fireAt <= now)) return c.json({ error: "Pick a time in the future." }, 400);
  if (typeof fireAt === "number" && fireAt > now + 365 * 86_400_000) return c.json({ error: "Pick a time within a year." }, 400);
  if (!remindLimit.check(requester.nick)) return c.json({ error: "Too many reminders at once. Try again in a minute." }, 429);
  try {
    const direct = directConversation(requester.nick, "remind") ?? await openDirectConversation(requester.nick, "remind");
    if (typeof fireAt === "number") return c.json({ reply: scheduleReminder(requester.nick, direct.channel, Math.round(fireAt), text) });
    const answer = await reminderOutcome("remind", requester.nick, direct.channel, text);
    if (!answer.list) return c.json({ reply: answer.text });
    helperSay("remind", direct.channel, [answer.text]);
    return c.json({ reply: answer.text, open: "remind" });
  } catch (error) {
    console.error(`reminder failed for ${requester.nick}:`, error instanceof Error ? error.message : error);
    return c.json({ error: "Could not set the reminder. Try again." }, 500);
  }
});

// The browser reports its IANA zone so @remind reads "tomorrow 9:00" and words confirmations on the
// asker's clock. Same-origin JSON only; the zone is validated before it is stored.
reminders.put("/api/time-zone", async (c) => {
  c.header("Cache-Control", "no-store");
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  if (!account || account.kind !== "human") return c.json({ error: "sign in required" }, 401);
  if (!sameOriginJson(c, "X-Slirc-Time-Zone")) return c.json({ error: "same-origin request required" }, 403);
  const body = await c.req.json().catch(() => ({})) as { timeZone?: unknown };
  if (!validTimeZone(body.timeZone) || !setUserTimeZone(account.id, body.timeZone)) return c.json({ error: "valid time zone required" }, 400);
  return c.json({ timeZone: body.timeZone });
});
