import { createLimiter } from "../request-security.ts";
import { type Binding, provisionBinding, hashAgentSecret, authenticateBinding, bindLease, updateBindingMetadata, invalidateLease, renewLease, validLease, authorizedBindingById, bindSession, agentMetadata, renameBinding } from "../agent-session.ts";
import { bodyLimit } from "hono/body-limit";
import { agentSessionCapabilities, bindingForRequest, leaseForRequest, AGENT_SSE_KEEPALIVE_MS, AGENT_POLL_MAX_WAIT_S, removeAgent } from "../http/agent-support.ts";
import { AGENT_VERSION, offeredHarnesses, acceptedHarness, connectCommands, instanceHost, requestForSecret, createConnectRequest, redeemTicket, tieRequest, openRequestById, requestCard, mintTicket, isBlocked, findOpenRequest, requestOwner, recordFailure, recordDecision } from "../agent-connect.ts";
import { pairingIp, text, appError } from "../http/common.ts";
import { publish } from "../live.ts";
import { appOrigin, currentUser, sameOriginJson, verifiedHuman } from "../http/session.ts";
import { db } from "../db.ts";
import { connectAgentTransport, agentRuntimeConnected, introduceAgent, sendPendingReview, syncAgentPresence, readRoomHistory, subscribeAgent, offeredRequests, acceptRequest, acceptRefusal, startRequest, replyToRequest, sendToRequest, deleteOwnMessage, failRequest, wakeAgent, forwardToAgent } from "../agent-session-transport.ts";
import { streamSSE } from "hono/streaming";
import { accountByNick, ergo } from "../accounts.ts";
import { memberChannels, agentCanReadChannel } from "../rooms.ts";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import { Hono } from "hono";
import { ownerDmBinding, ownerDms, readOwnerDm, setOwnerDmAccess } from "../owner-dms.ts";

export const agents = new Hono();

const sessionConnectLimit = createLimiter({ limit: 10, windowMs: 60_000 });

const sessionProvisioning = new Map<string, Promise<Binding>>();

const bindingJson = (binding: Binding) => ({
  instanceId: binding.instance_id, ownerAccountId: binding.owner_account_id, bindingId: binding.id,
  harness: binding.harness, sessionId: binding.session_id, sessionName: binding.session_name,
  nick: binding.nick, dm: binding.dm, status: binding.status,
});

async function provisionSessionBinding(binding: Binding): Promise<Binding> {
  const current = sessionProvisioning.get(binding.id);
  if (current) return current;
  const task = provisionBinding(binding).finally(() => sessionProvisioning.delete(binding.id));
  sessionProvisioning.set(binding.id, task);
  return task;
}

// Agent reply text is capped at 16,000 UTF-8 bytes; JSON escaping can roughly double it, so the
// body limit is set to accept any valid text while still bounding requests.
agents.use("/api/agent/session/*", bodyLimit({ maxSize: 48_000 }));

agents.use("/api/agent/session/*", async (c, next) => {
  if (!agentSessionCapabilities.enabled) {
    c.header("Cache-Control", "no-store");
    const status = c.req.path === "/api/agent/session/request" || c.req.path === "/api/agent/session/connect" ? 409 : 403;
    return c.json({ error: agentSessionCapabilities.reason, code: "disabled" }, status);
  }
  await next();
  // Session transport credentials and request contents must never enter HTTP caches.
  if (c.res.headers.has("Cache-Control")) return;
  const headers = new Headers(c.res.headers);
  headers.set("Cache-Control", "no-store");
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

const bearerSecret = (c: any) => c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] || "";

// Which slirc-agent this workspace expects. Public: the CLI asks before it changes anything.
agents.get("/api/agent/version", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ version: AGENT_VERSION, enabled: agentSessionCapabilities.enabled, ...(agentSessionCapabilities.enabled ? {} : { reason: agentSessionCapabilities.reason }), harnesses: offeredHarnesses() });
});

// A session asks to be paired. It gets a link and a code to show its owner, and then polls
// /connect with the same secret until someone allows or denies it.
agents.post("/api/agent/session/request", async (c) => {
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason, code: "disabled" }, 409);
  const secret = bearerSecret(c);
  const body = await c.req.json().catch(() => null);
  if (!secret || !body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid session connect request" }, 400);
  if (!acceptedHarness(body.harness) || body.protocol !== 1 || typeof body.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId) || typeof body.sessionFile !== "string" || !body.sessionFile || body.sessionFile.length > 2048) {
    return c.json({ error: "This agent can't connect to Slirc yet.", code: "unsupported" }, 400);
  }
  if (typeof body.version === "string" && body.version.split(".")[0] !== AGENT_VERSION.split(".")[0]) {
    const { npx } = connectCommands();
    return c.json({ error: `This Slirc extension is ${body.version} and ${instanceHost()} needs ${AGENT_VERSION}. Run ${npx} in a terminal to update it.`, code: "update" }, 426);
  }
  const ip = pairingIp(c);
  if (!sessionConnectLimit.check(ip)) return c.json({ error: "Too many connect attempts. Wait a minute, then type /slirc again.", code: "throttled" }, 429);
  const secretHash = hashAgentSecret(secret);
  if (authenticateBinding(secret) || requestForSecret(secretHash)?.decision === "allow") return c.json({ bound: true });
  const created = createConnectRequest(secretHash, {
    harness: body.harness, sessionId: body.sessionId, sessionFile: body.sessionFile,
    sessionName: text(body.sessionName, 120), repo: text(body.repo, 2048) || null, model: text(body.model, 200) || null,
    provider: text(body.provider, 200) || null, machine: text(body.machine, 120) || "unknown",
  });
  // A ticket (the connect code in the Agents page's command) names the person waiting there: their
  // page shows the Allow card at once. One that expired, another session holds, or Slirc doesn't
  // know is answered with connectCode: "expired" so the session can say so; the link and code
  // still work.
  const ticketOwner = redeemTicket(body.ticket, secretHash);
  if (ticketOwner) {
    tieRequest(created.id, ticketOwner, created.expiresAt);
    const open = openRequestById(created.id);
    if (open) publish(ticketOwner, "agent-connect-request", requestCard(open));
  }
  c.header("Cache-Control", "no-store");
  return c.json({ url: `${appOrigin(c.req.header("host"))}/agents#connect=${created.token}`, code: created.code, expiresAt: created.expiresAt,
    ...(body.ticket !== undefined && !ticketOwner ? { connectCode: "expired" } : {}) });
});

// The session polls here until its request is decided, then gets its binding.
agents.post("/api/agent/session/connect", async (c) => {
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason, code: "disabled" }, 409);
  const secret = bearerSecret(c);
  const body = await c.req.json().catch(() => ({}));
  if (!secret) return c.json({ error: "invalid session connect request" }, 400);
  // slirc-agent 2.x sends the six-digit code Slirc used to show.
  if (typeof body?.code === "string") {
    const { npx } = connectCommands();
    return c.json({ error: `Slirc changed how agents connect. Run ${npx} in a terminal, then type /slirc in your session.`, code: "gone" }, 410);
  }
  const secretHash = hashAgentSecret(secret);
  const request = requestForSecret(secretHash);
  if (request?.decision === "deny") return c.json({ error: "Denied in Slirc. Type /slirc again if that was a mistake.", code: "denied" }, 403);
  let binding = db.query("SELECT * FROM agent_session_bindings WHERE secret_hash = ? AND status <> 'revoked'").get(secretHash) as Binding | null;
  if (!binding) {
    if (request) return c.json({ error: "Waiting for Allow in Slirc.", code: "owner_confirmation" }, 409);
    return c.json({ error: "The link expired before anyone allowed it. Type /slirc again for a new one.", code: "expired" }, 404);
  }
  try {
    if (binding.status !== "ready") binding = await provisionSessionBinding(binding);
    await connectAgentTransport(binding);
    c.header("Cache-Control", "no-store");
    return c.json(bindingJson(binding));
  } catch (error) {
    return appError(c, error, "agent provisioning failed", { bindingId: binding.id });
  }
});

agents.get("/api/agent/session/binding", (c) => {
  const binding = bindingForRequest(c);
  if (!binding) return c.json({ error: "session binding required" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json(bindingJson(binding));
});

agents.post("/api/agent/session/attach", async (c) => {
  const binding = bindingForRequest(c);
  if (!binding) return c.json({ error: "session binding required" }, 401);
  if (binding.status === "provisioning") return c.json({ error: "agent is still provisioning" }, 409);
  const body = await c.req.json().catch(() => null);
  const lease = body && typeof body.nonce === "string" ? bindLease(binding, body.nonce) : null;
  if (!lease) return c.json({ error: "session already attached or invalid nonce" }, 409);
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) updateBindingMetadata(binding, body.metadata);
  try {
    await connectAgentTransport(binding);
    const connected = agentRuntimeConnected(binding.id);
    if (connected) {
      introduceAgent(binding, lease.leaseId);
      sendPendingReview(binding, lease.leaseId);
    }
    return c.json({ ...lease, connected });
  } catch (error) {
    invalidateLease(binding.id, lease.leaseId);
    return appError(c, error, "agent IRC transport could not attach");
  } finally {
    syncAgentPresence();
  }
});

agents.post("/api/agent/session/heartbeat", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && c.req.header("X-Slirc-Agent-Lease");
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const expiresAt = renewLease(binding, lease);
  return expiresAt ? c.json({ expiresAt }) : c.json({ error: "session lease expired" }, 409);
});

agents.post("/api/agent/session/detach", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && c.req.header("X-Slirc-Agent-Lease");
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  invalidateLease(binding.id, lease);
  syncAgentPresence();
  return c.body(null, 204);
});

// Session name, repo folder and model as the adapter sees them now. Lease-bound, so only the live
// runtime of this binding can change what the owner and roommates are shown.
agents.post("/api/agent/session/metadata", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "metadata object required" }, 400);
  return c.json({ agent: updateBindingMetadata(binding, body) });
});

// Read-only room history for the agent's own tool. Same access as delivery: its DM or a granted,
// live-verified secret room. Never a generic proxy: no other IRC command is reachable from here.
agents.get("/api/agent/session/history", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const channel = c.req.query("channel") || binding.dm || "";
  const before = c.req.query("before") || "";
  if (!/^#[^\s,:]{1,200}$/.test(channel)) return c.json({ error: "invalid channel" }, 400);
  const cursor = !before ? "*" : /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(before) ? `timestamp=${before}` : /^[A-Za-z0-9_.:-]{1,128}$/.test(before) ? `msgid=${before}` : "";
  if (!cursor) return c.json({ error: "invalid before cursor" }, 400);
  const messages = await readRoomHistory(binding, lease, channel, cursor, Number(c.req.query("limit") || 50));
  if (!messages) return c.json({ error: "this agent cannot read that room" }, 403);
  return c.json({ channel: channel.toLowerCase(), messages });
});

// The owner's DMs, read-only, while the owner has "Can read my DMs" on for this agent. Lease-bound
// like history. Nothing here can write: posting stays limited to the request routes below.
const ownerDmsOff = (c: any) => c.json({ error: "Your owner hasn't turned on Can read my DMs for this agent. They can on the Agents page in Slirc.", code: "off" }, 403);

agents.get("/api/agent/session/owner-dms", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const allowed = ownerDmBinding(binding.id);
  if (!allowed) return ownerDmsOff(c);
  return c.json({ owner: allowed.owner_nick, dms: ownerDms(allowed) });
});

agents.get("/api/agent/session/owner-dms/:nick", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  if (!ownerDmBinding(binding.id)) return ownerDmsOff(c);
  const nick = c.req.param("nick");
  const before = c.req.query("before") || "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(nick)) return c.json({ error: "invalid nick" }, 400);
  const cursor = !before ? "*" : /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(before) ? `timestamp=${before}` : /^[A-Za-z0-9_.:-]{1,128}$/.test(before) ? `msgid=${before}` : "";
  if (!cursor) return c.json({ error: "invalid before cursor" }, 400);
  const messages = await readOwnerDm(binding.id, nick, cursor, Number(c.req.query("limit") || 50));
  if (messages === "unavailable") return c.json({ error: "Slirc couldn't read that DM just now. Try again." }, 503);
  if (!messages) return ownerDmBinding(binding.id) ? c.json({ error: `Your owner has no DM with ${nick}.` }, 404) : ownerDmsOff(c);
  return c.json({ nick, messages });
});

agents.get("/api/agent/session/events", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  return streamSSE(c, async (stream) => {
    let open = true;
    let wake: (() => void) | undefined;
    const unsubscribe = subscribeAgent(binding.id, () => { wake?.(); wake = undefined; });
    stream.onAbort(() => { open = false; wake?.(); wake = undefined; });
    // Proxies and fetch clients drop a stream that stays silent; a comment line keeps it open. The
    // first one goes out at once so the response headers flush and the adapter sees the stream open.
    let lastWrite = 0;
    let sentRename: string | null = null;
    try {
      while (open && validLease(binding, lease)) {
        // An owner rename goes to the live session once per stream; the adapter acks via metadata.
        const pending = (db.query("SELECT rename_pending FROM agent_session_bindings WHERE id=?").get(binding.id) as { rename_pending: string | null } | null)?.rename_pending ?? null;
        if (pending !== null && pending !== sentRename) {
          try { await stream.writeSSE({ event: "rename", data: JSON.stringify({ name: pending }) }); lastWrite = Date.now(); sentRename = pending; }
          catch { break; }
        }
        if (Date.now() - lastWrite >= AGENT_SSE_KEEPALIVE_MS) {
          try { await stream.write(": keepalive\n\n"); lastWrite = Date.now(); }
          catch { break; }
        }
        const requests = await offeredRequests(binding);
        // The privacy probes above are awaited; recheck the stream, lease and immutable binding
        // authorization before any content write. A correct accept gate never excuses disclosure.
        if (!open || !validLease(binding, lease) || !authorizedBindingById(binding.id)) break;
        if (requests.length) {
          try { await stream.writeSSE({ event: "requests", data: JSON.stringify(requests) }); lastWrite = Date.now(); }
          catch { break; }
        }
        await Promise.race([new Promise<void>((resolve) => { wake = resolve; }), new Promise<void>((resolve) => setTimeout(resolve, Math.min(5_000, AGENT_SSE_KEEPALIVE_MS)))]);
        wake = undefined;
      }
    } finally {
      open = false;
      unsubscribe();
    }
  });
});

// Requests and renames already handed to a polling lease, so a poll returns early only for news.
const polled = new Map<string, { lease: string; rename: string | null; requests: string }>();

// Long-poll twin of the events stream for adapters that cannot hold one open (Claude Code caps a
// fetch at 30 s). Same auth, lease and event objects. Each poll renews the lease, so a polling
// adapter stays attached while it polls and goes offline once polls stop for longer than the lease.
agents.get("/api/agent/session/events/poll", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const asked = Number(c.req.query("wait") ?? AGENT_POLL_MAX_WAIT_S);
  const wait = Number.isFinite(asked) ? Math.max(0, Math.min(AGENT_POLL_MAX_WAIT_S, asked)) : AGENT_POLL_MAX_WAIT_S;
  const deadline = Date.now() + wait * 1000;
  const signal = c.req.raw.signal;
  const known = polled.get(binding.id);
  const seen = known?.lease === lease ? known : { lease, rename: null, requests: "" };
  let wake: (() => void) | undefined;
  const unsubscribe = subscribeAgent(binding.id, () => { wake?.(); wake = undefined; });
  const abort = () => { wake?.(); wake = undefined; };
  signal.addEventListener("abort", abort);
  renewLease(binding, lease);
  try {
    while (!signal.aborted && validLease(binding, lease)) {
      const events: { event: string; data: unknown }[] = [];
      const rename = (db.query("SELECT rename_pending FROM agent_session_bindings WHERE id=?").get(binding.id) as { rename_pending: string | null } | null)?.rename_pending ?? null;
      if (rename !== null && rename !== seen.rename) events.push({ event: "rename", data: { name: rename } });
      const requests = await offeredRequests(binding) as { id: string; revision: number }[];
      // Same recheck as the stream: the privacy probes are awaited, so no content after they lapse.
      if (signal.aborted || !validLease(binding, lease) || !authorizedBindingById(binding.id)) break;
      const key = JSON.stringify(requests.map((request) => [request.id, request.revision]));
      const last = Date.now() >= deadline;
      // New or changed requests return at once; ones this lease already has repeat once per window.
      if (requests.length && (key !== seen.requests || last)) events.push({ event: "requests", data: requests });
      if (events.length) {
        polled.set(binding.id, { lease, rename: rename ?? seen.rename, requests: key });
        renewLease(binding, lease);
        return c.json({ events });
      }
      seen.requests = key;
      if (last) break;
      await Promise.race([new Promise<void>((resolve) => { wake = resolve; }), new Promise<void>((resolve) => setTimeout(resolve, Math.min(5_000, Math.max(0, deadline - Date.now()))))]);
      wake = undefined;
    }
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", abort);
  }
  if (!validLease(binding, lease)) return c.json({ error: "session lease required" }, 401);
  renewLease(binding, lease);
  return c.body(null, 204);
});

agents.get("/api/agent/session/requests/:id", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const request = db.query("SELECT id,revision,status,reply_msgid,lease_id FROM agent_session_requests WHERE id=? AND binding_id=?").get(c.req.param("id"), binding.id) as { id: string; revision: number; status: string; reply_msgid: string | null; lease_id: string | null } | undefined;
  return request ? c.json({ id: request.id, revision: request.revision, status: request.status, reply_msgid: request.reply_msgid, acceptedByLease: request.lease_id === lease }) : c.json({ error: "request not found" }, 404);
});

agents.post("/api/agent/session/requests/:id/accept", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const revision = Number(body.revision);
  const result = await acceptRequest(binding, lease, c.req.param("id"), revision);
  if (result) return c.json(result);
  const reason = acceptRefusal(binding, c.req.param("id"), revision);
  return c.json({ error: reason === "busy" ? "another request is active" : "request is stale or no longer authorized", code: reason }, 409);
});

agents.post("/api/agent/session/requests/:id/started", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  return startRequest(binding, lease, c.req.param("id"))
    ? c.json({ status: "working" }) : c.json({ error: "request is not active in this session" }, 409);
});

agents.post("/api/agent/session/requests/:id/reply", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== "string") return c.json({ error: "reply text required" }, 400);
  try { return c.json({ status: await replyToRequest(binding, lease, c.req.param("id"), body.text) }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "reply failed" }, 409); }
});

// Another message to the request's room, before or after its reply. See sendToRequest.
agents.post("/api/agent/session/requests/:id/send", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== "string") return c.json({ error: "message text required" }, 400);
  try { return c.json(await sendToRequest(binding, lease, c.req.param("id"), body.text)); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "message failed" }, 409); }
});

// Deletes one of the agent's own messages in the request's room. See deleteOwnMessage.
agents.post("/api/agent/session/requests/:id/delete", async (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.messageId !== "string") return c.json({ error: "messageId required" }, 400);
  try { return c.json({ status: await deleteOwnMessage(binding, lease, c.req.param("id"), body.messageId) }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "delete failed" }, 409); }
});

agents.post("/api/agent/session/requests/:id/fail", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  return c.req.json().catch(() => ({})).then(async (value: any) => {
    const reason = typeof value.reason === "string" ? value.reason.slice(0, 500) : "Agent could not complete this request.";
    try { return c.json({ status: await failRequest(binding, lease, c.req.param("id"), reason) }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "request failure could not be reported" }, 409); }
  });
});

agents.post("/api/agent/session/requests/:id/confirm", (c) => {
  const binding = bindingForRequest(c);
  const lease = binding && leaseForRequest(c, binding);
  if (!binding || !lease) return c.json({ error: "session lease required" }, 401);
  return c.json({ error: "offline confirmation must come from the owner's authenticated DM" }, 403);
});

agents.get("/api/agents/capabilities", (c) => {
  if (!currentUser(c)) return c.json({ error: "not signed in" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json({ ...agentSessionCapabilities, harnesses: offeredHarnesses(), commands: connectCommands() });
});

// A ticket for the command the Agents page copies. See mintTicket.
const ticketLimit = createLimiter({ limit: 20, windowMs: 10 * 60_000 });

agents.post("/api/agents/connect-ticket", (c) => {
  if (!sameOriginJson(c, "X-Slirc-Connect")) return c.json({ error: "same-origin request required" }, 403);
  const person = verifiedHuman(c);
  if (!person) return c.json({ error: "Sign in to connect an agent." }, 401);
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason }, 409);
  if (!ticketLimit.check(`account:${person.nick.toLowerCase()}`)) return c.json({ error: "Too many tries. Wait a few minutes, then copy the command again." }, 429);
  c.header("Cache-Control", "no-store");
  return c.json(mintTicket(person.nick));
});

// The Allow card: a signed-in person opens a request by its link token or typed code. Wrong codes
// count against both the address and the account.
const requestOpenLimit = createLimiter({ limit: 30, windowMs: 60_000 });

agents.post("/api/agents/requests/open", async (c) => {
  const person = verifiedHuman(c);
  if (!person) return c.json({ error: "Sign in to allow an agent." }, 401);
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason }, 409);
  const ip = pairingIp(c);
  const accountKey = `account:${person.nick.toLowerCase()}`;
  if (!requestOpenLimit.check(ip) || isBlocked(ip) || isBlocked(accountKey)) return c.json({ error: "Too many tries. Wait ten minutes, then try again." }, 429);
  const body = await c.req.json().catch(() => null);
  const found = findOpenRequest({ token: body?.token, code: body?.code });
  const tied = found && requestOwner(found.id);
  const request = tied && tied.toLowerCase() !== person.nick.toLowerCase() ? null : found;
  if (!request) {
    if (body?.token === undefined) { recordFailure(ip); recordFailure(accountKey); }
    return c.json({ error: body?.token === undefined ? "No session is waiting with that code. Check it against your terminal." : "This link has expired or was already used. Type /slirc in your session for a new one." }, 404);
  }
  c.header("Cache-Control", "no-store");
  return c.json(requestCard(request));
});

agents.post("/api/agents/requests/:id", async (c) => {
  const person = verifiedHuman(c);
  if (!person?.id) return c.json({ error: "Sign in to allow an agent." }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.allow !== "boolean") return c.json({ error: "allow must be true or false" }, 400);
  const found = openRequestById(c.req.param("id"));
  const tied = found && requestOwner(found.id);
  const request = tied && tied.toLowerCase() !== person.nick.toLowerCase() ? null : found;
  if (!request) return c.json({ error: "This request has expired. Type /slirc in your session for a new one." }, 404);
  if (!body.allow) {
    recordDecision(request.id, "deny", null);
    return c.body(null, 204);
  }
  let binding: Binding;
  try {
    binding = db.transaction(() => {
      const made = bindSession({ owner: person.nick, ownerAccountId: person.id!, harness: request.harness, sessionId: request.sessionId, sessionFile: request.sessionFile,
        machine: request.machine, sessionName: request.sessionName, repo: request.repo, model: request.model, provider: request.provider, secretHash: request.secret_hash });
      if (!recordDecision(request.id, "allow", made.id)) throw new Error("This request was already decided.");
      return made;
    })();
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Could not allow this session." }, 409);
  }
  publish(person.nick, "agent-pending", { id: binding.id });
  // Provision now, so the session's next poll finds the agent ready.
  try { binding = await provisionSessionBinding(binding); } catch {}
  c.header("Cache-Control", "no-store");
  return c.json({ nick: binding.nick, dm: binding.dm, status: binding.status });
});

// Old clients must never mint a shared agent identity or receive IRC credentials.
agents.post("/api/agent/connect", (c) => c.json({
  error: agentSessionCapabilities.enabled ? "This connect command is from an older Slirc. Open Agents in Slirc for the new one." : agentSessionCapabilities.reason,
}, 409));

// Agents have no web session. They prove who they are with their IRC password (checked against
// Ergo) and get the rooms they belong to, so a listener can join rooms granted while it was offline.
async function agentFromBasicAuth(c: any) {
  const header = c.req.header("Authorization") || "";
  const decoded = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8") : "";
  const split = decoded.indexOf(":");
  const nick = split > 0 ? decoded.slice(0, split) : "";
  const password = split > 0 ? decoded.slice(split + 1) : "";
  const account = nick ? accountByNick(nick) : null;
  if (!account || account.kind !== "agent" || !password) return null;
  const check = await ergo("/v1/check_auth", { accountName: account.nick, passphrase: password }).catch(() => ({ success: false }));
  return check.success ? account : null;
}

agents.get("/api/agent/rooms", async (c) => {
  const account = await agentFromBasicAuth(c);
  if (!account) return c.json({ error: "agent credentials required" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json({ nick: account.nick, owner: account.owner, rooms: memberChannels(account.nick).filter((room) => agentCanReadChannel(account.nick, room)) });
});

agents.get("/api/agents", async (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  c.header("Cache-Control", "no-store");
  const agents = db.query("SELECT nick, machine FROM accounts WHERE kind = 'agent' AND owner = ? COLLATE NOCASE ORDER BY nick").all(owner) as { nick: string; machine: string }[];
  const ownerId = accountByNick(owner)?.id;
  return c.json(await Promise.all(agents.map(async (agent) => {
    const details = await ergo("/v1/account_details", { accountName: agent.nick }).catch(() => null);
    const binding = ownerId ? db.query(`SELECT id,harness,session_name,session_id,status,lease_expires_at,read_owner_dms FROM agent_session_bindings
      WHERE nick=? COLLATE NOCASE AND owner_account_id=? AND status='ready'`).get(agent.nick, ownerId) as any : null;
    // Legacy IRC presence never proves a coding session is attached.
    const status = binding ? binding.lease_expires_at > Date.now() && agentRuntimeConnected(binding.id) ? "ready" : "offline" : "unknown";
    return { ...agent, status, agent: agentMetadata(agent.nick), bindingId: binding?.id ?? null, ...(binding ? { harness: binding.harness, sessionName: binding.session_name, sessionId: binding.session_id, readDms: binding.read_owner_dms === 1 } : {}), lastSeen: details?.success ? details.lastSeen ?? null : null };
  })));
});

// Owner-only rename. The name shows in Slirc at once and reaches the session when it is attached.
agents.post("/api/agents/:nick/name", async (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  const ownerId = accountByNick(owner)?.id;
  const binding = ownerId ? db.query("SELECT * FROM agent_session_bindings WHERE nick=? COLLATE NOCASE AND owner_account_id=? AND status='ready'")
    .get(c.req.param("nick"), ownerId) as Binding | null : null;
  if (!binding) return c.json({ error: "agent not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== "string" || body.name.length > 500) return c.json({ error: "name required" }, 400);
  const agent = renameBinding(binding, body.name);
  wakeAgent(binding.id);
  c.header("Cache-Control", "no-store");
  return c.json({ agent });
});

// Owner-only "Can read my DMs". Off revokes at once: every read checks the flag again.
agents.post("/api/agents/:nick/read-dms", async (c) => {
  if (!sameOriginJson(c, "X-Slirc-Agent")) return c.json({ error: "same-origin request required" }, 403);
  const person = verifiedHuman(c);
  if (!person?.id) return c.json({ error: "not signed in" }, 401);
  const binding = db.query("SELECT * FROM agent_session_bindings WHERE nick=? COLLATE NOCASE AND owner_account_id=? AND status='ready'")
    .get(c.req.param("nick"), person.id) as Binding | null;
  if (!binding) return c.json({ error: "agent not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
  setOwnerDmAccess(binding.id, body.enabled);
  c.header("Cache-Control", "no-store");
  return c.json({ readDms: body.enabled });
});

// Maintainer forward: hand one message from a channel you can read to your own attached agent with
// an optional note. The agent answers publicly in that channel. Only the binding's owner account
// may use it, and the agent must already be attached to the room.
const agentForwardLimit = createLimiter({ limit: 30, windowMs: 60_000 });

agents.post("/api/agents/:bindingId/forward", bodyLimit({ maxSize: 8_192 }), async (c) => {
  if (!sameOriginJson(c, "X-Slirc-Agent")) return c.json({ error: "same-origin request required" }, 403);
  if (!agentSessionCapabilities.enabled) return c.json({ error: agentSessionCapabilities.reason }, 403);
  const person = verifiedHuman(c);
  if (!person?.id) return c.json({ error: "Sign in to forward a message." }, 401);
  if (!agentForwardLimit.check(person.id)) return c.json({ error: "Too many forwards. Try again in a minute." }, 429);
  const binding = db.query("SELECT * FROM agent_session_bindings WHERE id=? AND status='ready'")
    .get(c.req.param("bindingId")) as Binding | null;
  if (!binding) return c.json({ error: "agent not found" }, 404);
  if (binding.owner_account_id !== person.id) return c.json({ error: "only the owner can forward to this agent" }, 403);
  const body = await c.req.json().catch(() => ({})) as { channel?: unknown; messageId?: unknown; note?: unknown };
  if (typeof body.channel !== "string" || typeof body.messageId !== "string") return c.json({ error: "channel and messageId required" }, 400);
  const note = typeof body.note === "string" ? body.note.slice(0, 2_000) : "";
  const result = await forwardToAgent(binding, person.id, body.channel, body.messageId, note);
  if ("error" in result) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
  c.header("Cache-Control", "no-store");
  return c.json(result);
});

agents.delete("/api/agents/:nick", async (c) => {
  const owner = currentUser(c);
  if (!owner) return c.json({ error: "not signed in" }, 401);
  const agent = db.query("SELECT nick FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'agent' AND owner = ? COLLATE NOCASE").get(c.req.param("nick"), owner) as { nick: string } | null;
  if (!agent) return c.json({ error: "agent not found" }, 404);
  try {
    await removeAgent(agent.nick);
    return c.body(null, 204);
  } catch (error) {
    return appError(c, error, "Could not remove agent account.");
  }
});
