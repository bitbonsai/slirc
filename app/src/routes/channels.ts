import { currentUser, verifiedHuman, sameOriginJson } from "../http/session.ts";
import { accountByNick, ircChannelExists } from "../accounts.ts";
import { slircMode, ergoOperUser, inactiveHelper } from "../config.ts";
import { channelInfo, normalized, joinWorkspaceChannel, isOpenChannel, isMember, threadChildren, leaveChannel, defaultChannel, deleteChannelTree } from "../rooms.ts";
import { createChannel, renameChannel, setChannelTopic, setChannelMode, makeChannelSecret, makeThreadChannelsSecret, makeChannelOpen, allowChannelAccess, grantChannelAccess, kickChannelMember, revokeChannelAccess, redactMessage, NotAuthorizedError, unregisterChannel, purgeChannelHistory } from "../grants.ts";
import { db } from "../db.ts";
import { channelsChanged } from "../live.ts";
import { opAdmins } from "../admin-ops.ts";
import { appError } from "../http/common.ts";
import { renameLinksChannel, deleteScopedLinks } from "../links.ts";
import { listEmailInvites } from "../email-invites.ts";
import { normalizeProfileBadge } from "../../shared/profile-badges.ts";
import { avatarVersion } from "../http/profiles.ts";
import { agentAttached, joinAgentRoomForNick, evictAgentRoomForNick } from "../agent-session-transport.ts";
import { agentMetadata } from "../agent-session.ts";
import { memberAddDenial, belongsTo, canReadChannelForModeration } from "../http/authz.ts";
import { queueHelperCatchUp } from "../helper-bot.ts";
import { removeFromThreads, removeOwnerAgentsFromChannel } from "../http/agent-support.ts";
import { createLimiter } from "../request-security.ts";
import { bodyLimit } from "hono/body-limit";
import { editableBot, validEditText, editBotMessage, BotEditError } from "../bot-edit.ts";
import { replyThreadsFor } from "../reply-threads.ts";
import { Hono } from "hono";

export const channels = new Hono();

channels.post("/api/channels", async (c) => {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  if (account?.kind === "agent") return c.json({ error: "agents cannot manage channels" }, 403);
  if (!account?.verifiedAt) return c.json({ error: "verify your email before creating channels" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const channel = typeof body.name === "string" ? `#${body.name.trim().replace(/^#+/, "").toLowerCase()}` : "";
  // A private workspace creates secret channels unless the caller names `workspace` explicitly. An
  // explicit value we do not recognise is rejected before any mutation, so a typo cannot publish.
  const requested = body.visibility;
  const privateMode = slircMode() === "private_workspace";
  if (privateMode && requested !== undefined && requested !== "secret" && requested !== "workspace") {
    return c.json({ error: "Visibility must be secret or workspace." }, 400);
  }
  const visibility = requested === "secret" || (privateMode && requested === undefined) ? "secret" : "workspace";
  if (!/^#[a-z][a-z0-9_-]{1,31}$/.test(channel)) return c.json({ error: "Use 2–32 letters, numbers, dashes, or underscores." }, 400);
  // Thread, DM and group names are minted by the server; a plain channel under one would pass for them.
  if (/^#(?:t|dm|g)-/.test(channel)) return c.json({ error: "That name is reserved." }, 400);
  try {
    if (channelInfo(channel) || await ircChannelExists(channel)) return c.json({ error: "That channel already exists." }, 409);
    await createChannel(channel, account.nick, visibility);
    db.transaction(() => {
      db.query("INSERT INTO channels (channel, owner, visibility, created_at) VALUES (?, ?, ?, ?)").run(channel, account.nick, visibility, Date.now());
      db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(channel, account.nick);
    })();
    channelsChanged(channel, [account.nick], true);
    void opAdmins(channel);
    return c.json({ channel, owner: account.nick, visibility, topic: "", archived: false }, 201);
  } catch (error) {
    return appError(c, error, "Could not create channel.");
  }
});

channels.post("/api/channels/:channel/join", (c) => {
  const requester = verifiedHuman(c);
  if (!requester) return c.json({ error: "verified account required" }, currentUser(c) ? 403 : 401);
  const nick = requester.nick;
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  if (!joinWorkspaceChannel(nick, channel)) return c.json({ error: "channel is unavailable" }, 404);
  channelsChanged(channel, [nick], true);
  return c.json({ channel });
});

channels.patch("/api/channels/:channel", async (c) => {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const info = channelInfo(channel);
  if (account?.kind === "agent") return c.json({ error: "agents cannot manage channels" }, 403);
  if (!account || !info) return c.json({ error: "channel not found" }, 404);
  const { action, topic, source, name } = await c.req.json().catch(() => ({}));
  const manages = info.owner === account.nick || account.role === "admin";
  // A DM stays between its two people, and a thread follows its parent: neither can be opened,
  // closed or archived on its own, by anyone, admins included.
  const isThread = !!db.query("SELECT 1 FROM threads WHERE channel = ?").get(channel);
  if (["open", "secret", "archive", "unarchive"].includes(action) && (info.visibility === "direct" || isThread)) {
    return c.json({ error: info.visibility === "direct" ? "a DM cannot change visibility" : "a thread follows its channel" }, 403);
  }
  try {
    if (action === "rename" && manages) {
      if (info.visibility === "direct" || isOpenChannel(channel)) return c.json({ error: "this channel cannot be renamed" }, 400);
      const next = typeof name === "string" ? `#${name.trim().replace(/^#+/, "").toLowerCase()}` : "";
      if (!/^#[a-z][a-z0-9_-]{1,31}$/.test(next)) return c.json({ error: "Use 2–32 letters, numbers, dashes, or underscores." }, 400);
      if (next === channel) return c.json(info);
      // The app database is the source of truth for names it manages. Ergo keeps a channel in the
      // owner's registered list even after we unregister it, so a name we freed by an earlier rename
      // lingers there; trusting it would block renaming back. createChannel absorbs "already
      // registered", so a stale Ergo entry reconciles on the way through.
      if (channelInfo(next)) return c.json({ error: "That channel already exists." }, 409);
      const members = (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[]).map((row) => row.nick);
      await renameChannel(channel, next, info.owner, info.visibility === "secret" ? "secret" : "workspace", members, info.topic || "");
      db.transaction(() => {
        db.query("UPDATE channels SET channel = ? WHERE channel = ?").run(next, channel);
        db.query("UPDATE channel_members SET channel = ? WHERE channel = ?").run(next, channel);
        db.query("UPDATE invites SET channel = ? WHERE channel = ?").run(next, channel);
        db.query("UPDATE uploads SET channel = ? WHERE channel = ?").run(next, channel);
        renameLinksChannel(channel, next);
        db.query("UPDATE meta SET key = ? WHERE key = ?").run(`seeded:${next}`, `seeded:${channel}`);
        db.query("UPDATE threads SET parent = ? WHERE parent = ?").run(next, channel);
        db.query("UPDATE project_repos SET channel = ? WHERE channel = ?").run(next, channel);
      })();
      channelsChanged(next, members, true);
      void opAdmins(next);
      return c.json(channelInfo(next));
    }
    if (action === "topic") {
      if (!isMember(account.nick, channel)) return c.json({ error: "channel membership required" }, 403);
      if (typeof topic !== "string" || Buffer.byteLength(topic, "utf8") > 200) return c.json({ error: "Topic must fit within 200 bytes." }, 400);
      // No control characters: CR/LF would start a second IRC command, and the rest render as garbage.
      if (/[\x00-\x1f\x7f]/.test(topic)) return c.json({ error: "Topic can't contain control characters." }, 400);
      // The PWA sets the topic over the member's own IRC connection when it can (source "irc"), so the
      // change is attributed to the person. The oper path is the fallback for channels still carrying +t.
      if (source !== "irc") await setChannelTopic(channel, topic.trim());
      db.query("UPDATE channels SET topic = ? WHERE channel = ?").run(topic.trim(), channel);
    } else if ((action === "archive" || action === "unarchive") && manages) {
      if (source !== "irc") await setChannelMode(channel, action === "archive" ? "+m" : "-m");
      db.query("UPDATE channels SET archived_at = ? WHERE channel = ?").run(action === "archive" ? Date.now() : null, channel);
      // Members' open pages reload channel details, so the composer gives way to the read-only bar at once.
      channelsChanged(channel, (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[]).map((row) => row.nick), true);
    } else if (action === "secret" && manages) {
      const members = (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[]).map((row) => row.nick);
      await makeChannelSecret(channel, members);
      // Public threads go private with their parent: same +si and +I list, and only parent members
      // keep a child row. Anyone else sitting in one is kicked. Already private threads keep their
      // own, narrower grants.
      const children = threadChildren(channel).filter((child) => child.visibility === "workspace").map((child) => child.channel);
      await makeThreadChannelsSecret(children, members);
      db.transaction(() => {
        db.query("UPDATE channels SET visibility = 'secret' WHERE channel = ?").run(channel);
        for (const child of children) {
          db.query("UPDATE channels SET visibility = 'secret' WHERE channel = ?").run(child);
          db.query(`DELETE FROM channel_members WHERE channel = ? AND nick NOT IN (SELECT nick FROM channel_members WHERE channel = ?)`).run(child, channel);
          for (const member of members) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(child, member);
        }
      })();
    } else if (action === "open" && manages) {
      // Existing secret history never becomes workspace-readable in a private workspace. Deny before
      // any SAMODE or SQLite write so a failed conversion leaves the channel exactly as it was.
      if (slircMode() === "private_workspace" && info.visibility === "secret") return c.json({ error: "a secret channel cannot be opened in a private workspace" }, 403);
      if (info.isGroup) return c.json({ error: "private groups cannot be opened" }, 403);
      const agentGrant = db.query(`WITH RECURSIVE descendants(channel) AS (
          SELECT ? UNION SELECT threads.channel FROM threads JOIN descendants ON threads.parent = descendants.channel
        ) SELECT 1 FROM descendants d JOIN channel_members m ON m.channel = d.channel
          JOIN accounts a ON a.nick = m.nick COLLATE NOCASE WHERE a.kind = 'agent' LIMIT 1`).get(channel);
      if (agentGrant) return c.json({ error: "Remove agent access from this channel and its threads before opening it." }, 409);
      await makeChannelOpen(channel);
      db.query("UPDATE channels SET visibility = 'workspace' WHERE channel = ?").run(channel);
    } else {
      return c.json({ error: "channel owner required" }, 403);
    }
    return c.json(channelInfo(channel));
  } catch (error) {
    return appError(c, error, "Could not update channel.");
  }
});

// Everyone who belongs to a channel, for the members panel. Presence comes from IRC on the client.
channels.get("/api/channels/:channel/members", (c) => {
  const nick = currentUser(c);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const info = channelInfo(channel);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  // Public rooms have no membership list; the client shows whoever is present from NAMES.
  if (isOpenChannel(channel)) { c.header("Cache-Control", "no-store"); return c.json({ channel, owner: null, public: true, members: [] }); }
  if (!info || info.visibility === "direct") return c.json({ error: "channel not found" }, 404);
  if (!isMember(nick, channel)) return c.json({ error: "channel membership required" }, 403);
  const rows = db.query(`SELECT m.nick, a.kind, a.role, a.machine, p.availability, p.badge, p.avatar_path, p.avatar_version FROM channel_members m LEFT JOIN accounts a ON a.nick = m.nick COLLATE NOCASE
                         LEFT JOIN profiles p ON p.account = m.nick COLLATE NOCASE
                         WHERE m.channel = ? AND m.nick COLLATE NOCASE NOT IN ('slirc', ?) ORDER BY m.nick`).all(channel, ergoOperUser()) as { nick: string; kind: string | null; role: string | null; machine: string | null; availability: string | null; badge: string | null; avatar_path: string | null; avatar_version: number | null }[];
  c.header("Cache-Control", "no-store");
  const viewer = accountByNick(nick);
  const pendingInvitations = viewer ? [...new Map(listEmailInvites(viewer.id)
    .filter((row) => row.channel === channel && ["pending", "sending", "uncertain"].includes(row.status))
    .map((row) => [row.recipientEmail, { email: row.recipientEmail, status: row.status }])).values()] : [];
  return c.json({ channel, owner: info.owner, pendingInvitations, members: rows.map((row) => ({ nick: row.nick, kind: row.kind || "member", role: row.role || "member", machine: row.machine || null, availability: row.availability || "", badge: normalizeProfileBadge(row.badge), avatarVersion: avatarVersion(row), ...(row.kind === "agent" ? { attached: agentAttached(row.nick), agent: agentMetadata(row.nick) } : {}) })) });
});

// The inline Add prompt asks before it offers Add: is this nick here already, and may I add them?
// Unknown people, hidden people and other owners' agents get the same 404 as search would give.
channels.get("/api/channels/:channel/members/:nick", (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const lookedUp = accountByNick(c.req.param("nick").replace(/^@/, ""));
  // A helper this instance does not run is missing, so no Add note offers it.
  const found = lookedUp && !inactiveHelper(lookedUp.nick) ? lookedUp : null;
  const target = found?.kind === "agent" && found.owner?.toLowerCase() !== nick.toLowerCase() ? null : found;
  const denial = memberAddDenial(nick, channel, target);
  c.header("Cache-Control", "no-store");
  if (denial) return c.json({ error: denial.error }, denial.status);
  return c.json({ channel, nick: target!.nick, kind: target!.kind, member: belongsTo(target!, channel) });
});

channels.post("/api/channels/:channel/members", async (c) => {
  const nick = currentUser(c);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const { nick: rawTarget, invite, msgid } = await c.req.json().catch(() => ({}));
  const lookedUp = typeof rawTarget === "string" ? accountByNick(rawTarget.replace(/^@/, "")) : null;
  const found = lookedUp && !inactiveHelper(lookedUp.nick) ? lookedUp : null;
  // invite: "self" means the PWA will send INVITE over the member's own connection after we set +I;
  // "app" (default, and the fallback when Ergo refused the member) makes the oper send it.
  const inviteMode = invite === "self" ? "self" : "app";
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const denial = memberAddDenial(nick, channel, found);
  if (denial) return c.json({ error: denial.error }, denial.status);
  const target = found!;
  // Add on a helper prompt names the message that mentioned the helper; it answers that line once
  // it joins. Only a fresh add queues it, so a helper that was already here never answers twice.
  const catchUp = () => { if (typeof msgid === "string") queueHelperCatchUp(target.nick, channel, msgid, nick); };
  if (isOpenChannel(channel)) {
    const added = target.kind !== "human" && !db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ?").get(channel, target.nick);
    if (added) {
      db.query("INSERT INTO channel_members (channel, nick, owner_only) VALUES (?, ?, ?)").run(channel, target.nick, target.kind === "agent" ? 1 : 0);
      catchUp();
      // An owner's agent attaches to the open room and is woken only by that owner.
      if (target.kind === "agent") void joinAgentRoomForNick(target.nick, channel).catch(() => {});
    }
    return c.json({ channel, nick: target.nick, added });
  }
  const alreadyMember = isMember(target.nick, channel);
  if (alreadyMember && !(inviteMode === "app" && invite === "app")) return c.json({ channel, nick: target.nick, added: false });
  // A workspace attachment is owner-only too; the transport joins it plainly instead of via +I.
  const workspaceAgent = target.kind === "agent" && channelInfo(channel)?.visibility === "workspace";
  db.query("INSERT INTO channel_members (channel, nick, owner_only) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(channel, target.nick, workspaceAgent ? 1 : 0);
  try {
    if (workspaceAgent) void joinAgentRoomForNick(target.nick, channel).catch(() => {});
    else if (inviteMode === "self") await allowChannelAccess(channel, target.nick);
    else await grantChannelAccess(channel, target.nick);
  } catch (error) {
    console.error(`mention grant failed for ${target.nick} in ${channel}:`, error);
    return c.json({ error: "could not add to channel" }, 500);
  }
  // A freshly granted secret room is joined now; the transport re-proves live +s/+i before JOIN.
  if (target.kind === "agent" && !workspaceAgent) void joinAgentRoomForNick(target.nick, channel).catch(() => {});
  if (!alreadyMember) { catchUp(); channelsChanged(channel, [target.nick], true); }
  return c.json({ channel, nick: target.nick, added: true });
});

channels.post("/api/channels/:channel/kick", async (c) => {
  const nick = currentUser(c);
  const account = nick ? accountByNick(nick) : null;
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const info = channelInfo(channel);
  const { nick: target, reason, source } = await c.req.json().catch(() => ({}));
  if (account?.kind === "agent") return c.json({ error: "agents cannot manage channels" }, 403);
  if (!account || account.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!info || info.visibility === "direct") return c.json({ error: "channel not found" }, 404);
  if (typeof target !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(target) || target.toLowerCase() === account.nick.toLowerCase()) return c.json({ error: "invalid member" }, 400);
  if (!isMember(target, channel)) return c.json({ error: "member not found" }, 404);
  // Admins can't remove each other from channels, the same rule as removing a person.
  if (accountByNick(target)?.role === "admin") return c.json({ error: "You can't kick an admin." }, 403);
  if (typeof reason !== "string" || Buffer.byteLength(reason, "utf8") > 200 || /[\r\n]/.test(reason)) return c.json({ error: "Kick reason must fit within 200 bytes." }, 400);
  try {
    if (source !== "irc") await kickChannelMember(channel, target, reason.trim() || "Removed by an admin");
    if (info.visibility === "secret") await revokeChannelAccess(channel, target);
    // Threads before the parent row, so a failed IRC step leaves a kick that can be retried.
    await removeFromThreads(target, channel, reason.trim() || "Removed by an admin");
    db.query("DELETE FROM channel_members WHERE channel = ? AND nick = ?").run(channel, target);
    channelsChanged(channel, [target], false);
    // Stop any session transport using this room and clear its revoked cached context.
    evictAgentRoomForNick(target, channel);
    if (accountByNick(target)?.kind === "human") await removeOwnerAgentsFromChannel(target, channel);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not remove member.");
  }
});

// Server-enforced moderation delete. Admins are ops and may remove anyone's message, but the
// authorization is recomputed from current state, never from the request: the session account's
// verified admin role, its immutable account id, and live read access to the channel. An admin has
// no private-DM backdoor; a thread needs both parent access and child readability.
const REDACT_CHANNEL = /^#[a-z0-9][a-z0-9_-]{0,62}$/i;

const REDACT_BODY_LIMIT = 4_096;

const redactLimit = createLimiter({ limit: 30, windowMs: 60_000 });

channels.use("/api/messages/redact", bodyLimit({ maxSize: REDACT_BODY_LIMIT }));

channels.post("/api/messages/redact", async (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const account = accountByNick(nick);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (account.kind !== "human" || !account.verifiedAt || account.role !== "admin") return c.json({ error: "admin required" }, 403);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const channel = typeof body.channel === "string" ? normalized(body.channel) : "";
  const msgid = typeof body.msgid === "string" ? body.msgid : "";
  const accountId = typeof body.accountId === "string" ? body.accountId : null;
  const clientId = body.clientId === undefined ? undefined : typeof body.clientId === "string" ? body.clientId : null;
  if (!REDACT_CHANNEL.test(channel) || !/^[A-Za-z0-9_-]{1,64}$/.test(msgid)) return c.json({ error: "invalid channel or message id" }, 400);
  if (clientId === null || (clientId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(clientId))) return c.json({ error: "invalid correlation id" }, 400);
  // The account id is the immutable identity half; a stale id means the caller's session no longer
  // matches the account it claims to act as, so refuse rather than deleting from a moved identity.
  if (accountId === null) return c.json({ error: "accountId is required" }, 400);
  if (accountId !== account.id) return c.json({ error: "stale account" }, 409);
  // A channel the caller cannot read is reported as missing whether it never existed or is private.
  if (!canReadChannelForModeration(account.nick, channel)) return c.json({ error: "channel not found" }, 404);
  if (!redactLimit.check(account.nick)) return c.json({ error: "too many moderation attempts" }, 429);

  // Re-checked inside the helper immediately before REDACT, after the oper login, the channel
  // existence probe, and the join; a revoke during those awaits wins over the deletion.
  const stillAuthorized = () => {
    const current = accountByNick(account.nick);
    return !!current && current.kind === "human" && !!current.verifiedAt && current.role === "admin" && canReadChannelForModeration(current.nick, channel);
  };
  try {
    const result = await redactMessage(channel, msgid, clientId, stillAuthorized);
    return c.json(result === "gone" ? { ok: true, gone: true } : { ok: true });
  } catch (error) {
    if (error instanceof NotAuthorizedError) return c.json({ error: "moderation access changed" }, 403);
    console.error(`admin delete in ${channel} failed:`, error instanceof Error ? error.message : error);
    return appError(c, error, "could not redact message");
  }
});

// An admin edits a bot's message. The same admin, channel and rate checks as the moderation delete
// above; the edit itself goes out from the bot's own account (bot-edit.ts), which also proves from
// Ergo's history that the bot wrote the message. People's and agents' messages are refused.
channels.use("/api/messages/bot-edit", bodyLimit({ maxSize: 16_384 }));

channels.post("/api/messages/bot-edit", async (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  const account = accountByNick(nick);
  if (!account) return c.json({ error: "not signed in" }, 401);
  if (account.kind !== "human" || !account.verifiedAt || account.role !== "admin") return c.json({ error: "admin required" }, 403);
  if (!sameOriginJson(c, "X-Slirc-Edit")) return c.json({ error: "same-origin request required" }, 403);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const channel = typeof body.channel === "string" ? normalized(body.channel) : "";
  const msgid = typeof body.msgid === "string" ? body.msgid : "";
  const bot = typeof body.bot === "string" ? body.bot : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!REDACT_CHANNEL.test(channel) || !/^[A-Za-z0-9_-]{1,64}$/.test(msgid)) return c.json({ error: "invalid channel or message id" }, 400);
  if (body.accountId !== account.id) return c.json({ error: "stale account" }, 409);
  if (!editableBot(bot)) return c.json({ error: "only bot messages can be edited" }, 403);
  if (!validEditText(text)) return c.json({ error: "invalid text" }, 400);
  if (!canReadChannelForModeration(account.nick, channel)) return c.json({ error: "channel not found" }, 404);
  if (!redactLimit.check(account.nick)) return c.json({ error: "too many moderation attempts" }, 429);

  const stillAuthorized = () => {
    const current = accountByNick(account.nick);
    return !!current && current.kind === "human" && !!current.verifiedAt && current.role === "admin" && canReadChannelForModeration(current.nick, channel);
  };
  try {
    const result = await editBotMessage(bot, channel, msgid, text, stillAuthorized);
    return c.json({ ok: true, msgid: result.msgid });
  } catch (error) {
    if (error instanceof BotEditError) return c.json({ error: error.message }, error.status as 400);
    console.error(`bot edit in ${channel} failed:`, error instanceof Error ? error.message : error);
    return appError(c, error, "could not edit message");
  }
});

// Reply threads (IRCv3 +reply) this person started or replied to, in channels they can read now.
channels.get("/api/reply-threads", (c) => {
  const nick = currentUser(c);
  if (!nick) return c.json({ error: "not signed in" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json({ threads: replyThreadsFor(nick) });
});

// Creation is retired: reply threads need no channel.
channels.post("/api/threads", (c) => c.json({ error: "threads are now replies inside the conversation" }, 410));

channels.delete("/api/channels/:channel/membership", async (c) => {
  const nick = currentUser(c);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  const info = nick && channelInfo(channel);
  if (!nick || !info || !isMember(nick, channel)) return c.json({ error: "channel cannot be left" }, 403);
  if (info.isGroup && info.owner.toLowerCase() === nick.toLowerCase()) return c.json({ error: "group owner cannot leave; transfer or delete the group first" }, 409);
  try {
    // Owners keep their +I invite so they can come back through an invite link.
    if (info.visibility === "secret" && info.owner !== nick) await revokeChannelAccess(channel, nick);
    await removeFromThreads(nick, channel, "Left the channel", info.owner === nick);
    if (!leaveChannel(nick, channel)) return c.json({ error: "channel cannot be left" }, 403);
    channelsChanged(channel, [nick], false);
    await removeOwnerAgentsFromChannel(nick, channel);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not leave channel.");
  }
});

// Deleting a channel is admin-only and final: threads, members, invites, uploads and app rows go,
// Ergo history is purged, and the oper unregisters the room and kicks whoever is still in it.
// DMs, group DMs and threads have their own delete paths; the default and configured open
// channels are where people land, so they stay.
channels.delete("/api/channels/:channel", async (c) => {
  const nick = currentUser(c);
  const account = nick && accountByNick(nick);
  const channel = normalized(`#${c.req.param("channel").replace(/^#+/, "")}`);
  if (!account) return c.json({ error: "sign in required" }, 401);
  if (account.role !== "admin") return c.json({ error: "Only admins can delete channels." }, 403);
  const info = channelInfo(channel);
  if (!info) return c.json({ error: "channel not found" }, 404);
  if (info.visibility === "direct" || info.isGroup || /^#(?:t|dm)-/i.test(channel)) return c.json({ error: "Only channels can be deleted here." }, 400);
  if (channel === defaultChannel() || isOpenChannel(channel)) return c.json({ error: "The default channel can't be deleted." }, 409);
  const members = (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[]).map((row) => row.nick);
  try {
    // Same gap as DMs: unregister leaves Ergo history behind. deleteChannelTree clears each channel
    // (and every child thread) first, so a later room of the same name starts empty.
    await deleteChannelTree(channel, unregisterChannel, purgeChannelHistory);
    // Links kept for this channel's members alone go with it.
    deleteScopedLinks(channel);
    channelsChanged(channel, [...members, account.nick], false, { deleted: true });
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not delete channel.");
  }
});
