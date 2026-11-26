import { createLimiter } from "../request-security.ts";
import { bodyLimit } from "hono/body-limit";
import { sameOriginJson, verifiedHuman, currentUser, appOrigin } from "../http/session.ts";
import { parseRepo, projectBinding, channelCandidates, bindProject, repoLabel, projectBindings, verifyGithubSignature, formatGithubEvent } from "../github-projects.ts";
import { isOpenChannel, channelInfo, memberChannels, openChannels } from "../rooms.ts";
import { ircChannelExists } from "../accounts.ts";
import { createChannel } from "../grants.ts";
import { db } from "../db.ts";
import { channelsChanged } from "../live.ts";
import { opAdmins } from "../admin-ops.ts";
import { appError, pairingIp } from "../http/common.ts";
import { postNote } from "../update-notes.ts";
import { Hono } from "hono";

export const projects = new Hono();

// OSS project channels: bind one GitHub repository to one Slirc channel. The creator becomes the
// maintainer, the channel is provisioned like any workspace channel, and the webhook secret is
// returned once here and never by the listing below.
const projectCreateLimit = createLimiter({ limit: 20, windowMs: 60_000 });

projects.post("/api/projects", bodyLimit({ maxSize: 8_192 }), async (c) => {
  if (!sameOriginJson(c, "X-Slirc-Projects")) return c.json({ error: "same-origin request required" }, 403);
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  if (!projectCreateLimit.check(account.id)) return c.json({ error: "Too many project bindings. Try again in a minute." }, 429);
  const body = await c.req.json().catch(() => ({}));
  const repo = parseRepo(body.repo);
  if (!repo) return c.json({ error: "Use a GitHub repository as owner/repo." }, 400);
  if (projectBinding(repo)) return c.json({ error: "That repository already has a channel." }, 409);

  const candidates = channelCandidates(repo).filter((candidate) => !/^#(?:t|dm|g)-/i.test(candidate) && !isOpenChannel(candidate));
  if (!candidates.length) return c.json({ error: "That repository cannot use a reserved or open channel name." }, 400);

  let channel = "";
  try {
    for (const candidate of candidates) {
      const info = channelInfo(candidate);
      // A room the caller already owns is adopted; anyone else's room is never taken over.
      if (info && info.owner === account.nick && info.visibility === "workspace") { channel = candidate; break; }
      if (info || await ircChannelExists(candidate)) continue;
      await createChannel(candidate, account.nick, "workspace");
      db.transaction(() => {
        db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, ?, ?)").run(candidate, account.nick, "workspace", Date.now());
        db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(candidate, account.nick);
      })();
      channelsChanged(candidate, [account.nick], true);
      void opAdmins(candidate);
      channel = candidate;
      break;
    }
    if (!channel) return c.json({ error: "No free channel name for that repository." }, 409);
    const binding = bindProject(channel, repo, account.nick);
    return c.json({
      channel,
      repo: repoLabel(repo),
      webhookUrl: `${appOrigin(c.req.header("Host"))}/api/webhooks/github/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      webhookSecret: binding.webhookSecret,
    }, 201);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error))) return c.json({ error: "That repository already has a channel." }, 409);
    return appError(c, error, "Could not create the project channel.");
  }
});

projects.get("/api/projects", (c) => {
  const account = verifiedHuman(c);
  if (!account) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const visible = new Set([...memberChannels(account.nick), ...openChannels]);
  return c.json({
    projects: projectBindings()
      .filter((binding) => visible.has(binding.channel))
      .map(({ channel, repo, creatorNick, createdAt }) => ({ channel, repo, creatorNick, createdAt })),
  });
});

// GitHub deliveries are signed with the binding's secret, so this route needs no session. Raw bytes
// are read before any JSON parse: the signature covers the exact bytes, not a re-serialized payload.
const githubWebhookIpLimit = createLimiter({ limit: 60, windowMs: 60_000 });

const githubWebhookRepoLimit = createLimiter({ limit: 30, windowMs: 60_000 });

const MAX_GITHUB_DELIVERIES = 2_000;

const seenGithubDeliveries = new Set<string>();

function claimGithubDelivery(key: string): boolean {
  if (!key) return true;
  if (seenGithubDeliveries.has(key)) return false;
  seenGithubDeliveries.add(key);
  if (seenGithubDeliveries.size > MAX_GITHUB_DELIVERIES) {
    const oldest = seenGithubDeliveries.values().next().value;
    if (oldest !== undefined) seenGithubDeliveries.delete(oldest);
  }
  return true;
}

projects.use("/api/webhooks/github/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));

projects.post("/api/webhooks/github/:owner/:repo", async (c) => {
  if (!githubWebhookIpLimit.check(pairingIp(c))) return c.json({ error: "Too many webhook deliveries." }, 429);
  const repo = parseRepo(`${c.req.param("owner")}/${c.req.param("repo")}`);
  const binding = repo ? projectBinding(repo) : null;
  if (!binding) return c.json({ error: "unknown repository" }, 404);
  if (!githubWebhookRepoLimit.check(binding.repo.toLowerCase())) return c.json({ error: "Too many webhook deliveries." }, 429);
  const rawBytes = Buffer.from(await c.req.arrayBuffer());
  if (!verifyGithubSignature(binding.webhookSecret, rawBytes, c.req.header("X-Hub-Signature-256") || "")) {
    return c.json({ error: "invalid signature" }, 401);
  }
  const deliveryId = (c.req.header("X-GitHub-Delivery") || "").trim();
  const deliveryKey = deliveryId ? `${binding.repo.toLowerCase()}:${deliveryId}` : "";
  if (deliveryKey && !claimGithubDelivery(deliveryKey)) {
    return c.json({ duplicate: true }, 200);
  }
  let payload: unknown = null;
  try { payload = JSON.parse(rawBytes.toString("utf8")); } catch {}
  const message = formatGithubEvent(c.req.header("X-GitHub-Event") || "", payload, binding.repo);
  if (!message) return c.json({ ignored: true }, 202);
  try {
    await postNote(binding.channel, message);
    return c.json({ posted: true, channel: binding.channel }, 202);
  } catch (error) {
    if (deliveryKey) seenGithubDeliveries.delete(deliveryKey);
    return appError(c, error, "Could not post the GitHub update.");
  }
});
