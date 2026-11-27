import { vapidKeys, db } from "../db.ts";
import { currentUser, verifiedHuman, hash } from "../http/session.ts";
import { accountByNick } from "../accounts.ts";
import { Hono } from "hono";
import { isApnsEnvironment, isApnsToken } from "../apns.ts";
import { apnsConfig } from "../config.ts";

export const push = new Hono();

push.get("/push/public-key", (c) => c.json({ publicKey: vapidKeys().publicKey }));

push.post("/push/subscribe", async (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => ({}));
  if (body.accountId !== undefined && body.accountId !== accountByNick(nick)?.id) return c.json({ error: "Account changed. Reload before updating notifications." }, 409);
  const sub = body.subscription;
  const preference = ["all", "mentions", "none"].includes(body.preference) ? body.preference : "all";
  if (typeof sub?.endpoint !== "string" || typeof sub?.keys?.p256dh !== "string" || typeof sub?.keys?.auth !== "string") {
    return c.json({ error: "invalid subscription" }, 400);
  }
  db.query(`INSERT INTO subscriptions (endpoint, nick, p256dh, auth, preference, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET nick=excluded.nick, p256dh=excluded.p256dh,
              auth=excluded.auth, preference=excluded.preference, updated_at=excluded.updated_at`)
    .run(sub.endpoint, nick, sub.keys.p256dh, sub.keys.auth, preference, Date.now());
  // The toggle is per person, not per device: one switch, every browser.
  db.query("INSERT INTO notification_prefs (nick, preference) VALUES (?, ?) ON CONFLICT(nick) DO UPDATE SET preference = excluded.preference")
    .run(nick, preference);
  return c.body(null, 204);
});

// The iPhone app's device token, per account like a browser's subscription. Turning on from the
// app stores it and sets the person's preference to all, as /push/subscribe does.
push.post("/push/native", async (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => ({}));
  if (body.accountId !== accountByNick(nick)?.id) return c.json({ error: "Account changed. Reload before updating notifications." }, 409);
  if (!isApnsToken(body.token) || !isApnsEnvironment(body.environment)) return c.json({ error: "invalid device" }, 400);
  if (!apnsConfig()) return c.json({ error: "iPhone notifications aren't set up on this workspace yet." }, 503);
  db.query(`INSERT INTO native_devices (token, nick, environment, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(token) DO UPDATE SET nick=excluded.nick, environment=excluded.environment, updated_at=excluded.updated_at`)
    .run(body.token.toLowerCase(), nick, body.environment, Date.now());
  db.query("INSERT INTO notification_prefs (nick, preference) VALUES (?, ?) ON CONFLICT(nick) DO UPDATE SET preference = excluded.preference")
    .run(nick, "all");
  return c.body(null, 204);
});

push.post("/push/preference", async (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "not signed in" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || !["all", "mentions", "none"].includes(body.preference)) return c.json({ error: "invalid preference" }, 400);
  if (body.accountId !== account.id) return c.json({ error: "Account changed. Reload before updating notifications." }, 409);
  db.query("INSERT INTO notification_prefs (nick, preference) VALUES (?, ?) ON CONFLICT(nick) DO UPDATE SET preference = excluded.preference")
    .run(account.nick, body.preference);
  return c.body(null, 204);
});

push.get("/push/preference", (c) => {
  c.header("Cache-Control", "no-store");
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const row = db.query("SELECT preference FROM notification_prefs WHERE nick = ?").get(nick) as { preference: string } | null;
  const fingerprint = c.req.query("subscription");
  const subscribed = fingerprint ? (db.query("SELECT endpoint FROM subscriptions WHERE nick = ?").all(nick) as { endpoint: string }[]).some((row) => hash(row.endpoint) === fingerprint) : undefined;
  // ?device= is the iPhone app asking about its own token, by its SHA-256 like ?subscription=.
  const device = c.req.query("device");
  if (device !== undefined) {
    const registered = (db.query("SELECT token FROM native_devices WHERE nick = ?").all(nick) as { token: string }[]).some((row) => hash(row.token) === device);
    return c.json({ preference: row?.preference || "all", subscribed: registered, apns: !!apnsConfig() });
  }
  return c.json({ preference: row?.preference || "all", ...(fingerprint ? { subscribed } : {}) });
});
