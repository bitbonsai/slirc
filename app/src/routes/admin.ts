import { currentUser, verifiedHuman } from "../http/session.ts";
import { accountByNick, validEmail, accountByEmail, markRemoved, rotateIrcPassword } from "../accounts.ts";
import { db } from "../db.ts";
import { openChannels } from "../rooms.ts";
import { removeAgentsOwnedBy, removeAgent } from "../http/agent-support.ts";
import { removeMemberFromIrc } from "../grants.ts";
import { serializeIrcDeviceChange } from "../http/irc-devices.ts";
import { listCertificates, removeCertificate } from "../irc-certificates.ts";
import { agents } from "./agents.ts";
import { type Binding, bindingMetadata } from "../agent-session.ts";
import { agentRuntimeConnected } from "../agent-session-transport.ts";
import { appError, text } from "../http/common.ts";
import { join, dirname } from "node:path";
import { Hono } from "hono";

export const admin = new Hono();

// Email is the identity that magic links verify, so people cannot change their own. An admin can
// fix a lost inbox with PATCH /api/admin/accounts/:nick.
admin.patch("/api/admin/accounts/:nick", async (c) => {
  const requester = currentUser(c);
  const admin = requester ? accountByNick(requester) : null;
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const target = accountByNick(c.req.param("nick"));
  if (!target) return c.json({ error: "account not found" }, 404);
  // Moving another admin's address to one you read would let you sign in as them.
  if (target.kind !== "human" || (target.role === "admin" && target.nick.toLowerCase() !== admin.nick.toLowerCase())) return c.json({ error: "You can't change this account's email." }, 403);
  const { email } = await c.req.json().catch(() => ({}));
  const next = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!validEmail(next)) return c.json({ error: "Enter a valid email address." }, 400);
  if (next !== target.email && accountByEmail(next)) return c.json({ error: "That email is already in use." }, 409);
  db.query("UPDATE accounts SET email = ? WHERE nick = ?").run(next, target.nick);
  // New address, new Gravatar lookup: drop the cached miss so the next profile load refetches.
  db.query("UPDATE profiles SET gravatar_checked_at = NULL WHERE account = ? AND avatar_path IS NULL").run(target.nick);
  return c.json({ nick: target.nick, email: next });
});

// Remove a person from this instance. The app half runs first so they are signed out and kept out
// even if Ergo is slow; repeating the call after a failure retries the IRC half. Their messages stay.
admin.delete("/api/admin/accounts/:nick", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const target = db.query("SELECT nick, role, kind, removed_at FROM accounts WHERE nick = ? COLLATE NOCASE").get(c.req.param("nick")) as
    { nick: string; role: string; kind: string; removed_at: number | null } | null;
  if (!target || target.kind !== "human") return c.json({ error: "person not found" }, 404);
  if (target.nick.toLowerCase() === admin.nick.toLowerCase()) return c.json({ error: "You can't remove yourself." }, 400);
  // Admins can't remove each other, so the last admin always stays too.
  if (target.role === "admin") return c.json({ error: "You can't remove another admin." }, 403);
  const targetAccountId = accountByNick(target.nick)?.id;
  const channels = [...new Set([...openChannels, ...markRemoved(target.nick)])];
  try {
    await removeAgentsOwnedBy(target.nick, targetAccountId);
    await removeMemberFromIrc(target.nick, channels);
    // Password and certificates go too, so no IRC client can log in as them again.
    await serializeIrcDeviceChange(async () => {
      const password = await rotateIrcPassword(target.nick);
      for (const fingerprint of await listCertificates(target.nick, password)) await removeCertificate(target.nick, password, fingerprint);
      db.query("DELETE FROM irc_devices WHERE account = ? COLLATE NOCASE").run(target.nick);
      db.query("DELETE FROM irc_certificates WHERE account = ? COLLATE NOCASE").run(target.nick);
    });
    return c.body(null, 204);
  } catch (error) {
    // 500, not 502: Cloudflare swaps an origin 502 for its own error page, and the dialog loses this message.
    return c.json({ error: error instanceof Error ? error.message : "Could not finish removing this person. Try again." }, 500);
  }
});

// Every agent on the instance, whoever owns it, for the admin People page.
admin.get("/api/admin/agents", (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const agents = db.query("SELECT nick, owner, created_at FROM accounts WHERE kind = 'agent' ORDER BY owner COLLATE NOCASE, nick COLLATE NOCASE").all() as { nick: string; owner: string; created_at: number }[];
  c.header("Cache-Control", "no-store");
  return c.json(agents.map((agent) => {
    const binding = db.query("SELECT * FROM agent_session_bindings WHERE nick = ? COLLATE NOCASE AND status = 'ready'").get(agent.nick) as Binding | null;
    const channels = (db.query("SELECT channel FROM channel_members WHERE nick = ? AND channel NOT LIKE '#dm-%' AND channel NOT LIKE '#t-%' ORDER BY channel").all(agent.nick) as { channel: string }[]).map((row) => row.channel);
    const online = !!binding && (binding.lease_expires_at || 0) > Date.now() && agentRuntimeConnected(binding.id);
    return { nick: agent.nick, owner: agent.owner, createdAt: agent.created_at, name: binding ? bindingMetadata(binding).name : agent.nick, harness: binding?.harness || null, status: online ? "ready" : "offline", channels };
  }));
});

admin.delete("/api/admin/agents/:nick", async (c) => {
  const admin = verifiedHuman(c);
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const agent = db.query("SELECT nick FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'agent'").get(c.req.param("nick")) as { nick: string } | null;
  if (!agent) return c.json({ error: "agent not found" }, 404);
  try {
    await removeAgent(agent.nick);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not remove agent.");
  }
});

admin.get("/api/admin/help-usage", (c) => {
  const requester = currentUser(c);
  const admin = requester ? accountByNick(requester) : null;
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  const rows = db.query(`SELECT model, COUNT(*) AS calls, SUM(CASE WHEN cached = 0 THEN 1 ELSE 0 END) AS model_calls,
                        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd,
                        SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cache_hits
                        FROM help_usage GROUP BY model ORDER BY model`).all();
  return c.json({ rows });
});

// Counts and states the host's cron job writes beside the database every five minutes.
admin.get("/api/admin/status", async (c) => {
  const requester = currentUser(c);
  const admin = requester ? accountByNick(requester) : null;
  if (!admin) return c.json({ error: "not signed in" }, 401);
  if (admin.role !== "admin") return c.json({ error: "admin required" }, 403);
  c.header("Cache-Control", "no-store");
  const text = await Bun.file(join(dirname(process.env.DB_PATH || "/data/chat.sqlite"), "ops-status.json")).text().catch(() => null);
  if (text === null) return c.json({ status: null });
  try { return c.json({ status: JSON.parse(text) }); } catch { return c.json({ status: null, error: "unreadable" }); }
});
