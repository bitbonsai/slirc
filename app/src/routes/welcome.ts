import { verifiedHuman } from "../http/session.ts";
import { isFounder, welcomeEnabled, welcomeJobs, setWelcomeEnabled, claimWelcomeJob, markWelcomeDelivered, releaseWelcomeJob } from "../founder-welcome.ts";
import { Hono } from "hono";

export const welcome = new Hono();

// Founder-only welcome control and queue. Everyone else gets 404, so the setting and the queue
// are invisible and unusable to them; the opt-in is never inferred from role alone.
welcome.get("/api/welcome", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  return c.json({ enabled: welcomeEnabled(), pending: welcomeJobs(account!).length });
});

welcome.put("/api/welcome", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
  setWelcomeEnabled(account!, body.enabled);
  return c.json({ enabled: welcomeEnabled() });
});

welcome.get("/api/welcome/jobs", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  // `enabled` lets the founder's client ack an already-sent row while refusing to claim or send
  // once the switch is off.
  return c.json({ enabled: welcomeEnabled(), jobs: welcomeJobs(account!) });
});

welcome.post("/api/welcome/jobs/:id/claim", (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  if (!welcomeEnabled()) return c.json({ error: "welcomes are off" }, 409);
  const claimId = claimWelcomeJob(account!, c.req.param("id"));
  if (!claimId) return c.json({ error: "already claimed" }, 409);
  return c.json({ claimId });
});

welcome.post("/api/welcome/jobs/:id/delivered", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { claimId?: unknown; msgid?: unknown };
  const claimId = typeof body.claimId === "string" ? body.claimId : "";
  const msgid = typeof body.msgid === "string" && body.msgid ? body.msgid : null;
  if (!claimId) return c.json({ error: "claimId required" }, 400);
  if (!markWelcomeDelivered(account!, c.req.param("id"), claimId, msgid)) return c.json({ error: "not the claim owner" }, 409);
  return c.json({ ok: true });
});

// Only a refused or never-enqueued delivery returns a job to pending. An uncertain send keeps its
// claim, so another device cannot silently re-send a message that may already exist.
welcome.post("/api/welcome/jobs/:id/release", async (c) => {
  c.header("Cache-Control", "no-store");
  const account = verifiedHuman(c);
  if (!isFounder(account)) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({})) as { claimId?: unknown };
  const claimId = typeof body.claimId === "string" ? body.claimId : "";
  if (!claimId) return c.json({ error: "claimId required" }, 400);
  if (!releaseWelcomeJob(account!, c.req.param("id"), claimId)) return c.json({ error: "not the claim owner" }, 409);
  return c.json({ ok: true });
});
