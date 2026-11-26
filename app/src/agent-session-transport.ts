import { IrcClient, type ParsedMessage } from "./irc.ts";
import { db } from "./db.ts";
import { accountByNick } from "./accounts.ts";
import { channelInfo, agentCanReadChannel, agentOwnerOnlyGrant, isMember, isOpenChannel, memberChannels, normalized } from "./rooms.ts";
import { readPrivateChannelMode } from "./grants.ts";
import { agentAudience, authorizedBindingById, bindingIrcPassword, MAX_CONTEXT, validLease, type Binding } from "./agent-session.ts";
import { publish } from "./live.ts";
import { configuredAppOrigin } from "./request-security.ts";
import { harnessInfoById as harnessById } from "../shared/harnesses.ts";
import { isConcat, wireParts } from "../shared/multiline.ts";

// Verified live state of one room the agent has joined. `verified` means Ergo reported +s and +i for
// a private channel (and every thread ancestor) before the JOIN was sent; a later MODE that drops
// either flag evicts it. `publicRoom` marks an open/workspace attachment, which carries no private
// proof and is usable only while its owner-only grant stands.
type RoomState = { secret: boolean; inviteOnly: boolean; verified: boolean; publicRoom: boolean; ownerOnly: boolean };
// One in-flight multiline echo. Lines are matched in order against the reserved text; only the
// matching closing BATCH with every line present may mark the reply terminal.
type EchoAssembly = { cid: string; destination: string; expected: string[]; received: string[]; lastMsgid: string; requestId: string };
type Typing = { target: string; timer: ReturnType<typeof setInterval> };
// One CHATHISTORY answer being collected. Queries run one at a time per runtime, so the batch is ours.
export type HistoryEntry = { messageId: string; nick: string; text: string; time: string };
// The reply_cid stays inside the transport: it is matched for resend dedupe, never returned as context.
type RawHistoryEntry = HistoryEntry & { cid: string };
type HistoryQuery = { channel: string; batch?: string; inner: Map<string, { entry: RawHistoryEntry; lines: string[] }>; items: RawHistoryEntry[]; complete: boolean; finish: () => void };
type Runtime = {
  client: IrcClient; joined: Set<string>; rooms: Map<string, RoomState>; dmReady: boolean; listeners: Set<() => void>; echoes: Map<string, EchoAssembly>;
  typing: Map<string, Typing>; history: HistoryQuery | null; historyQueue: Promise<unknown>; redacted: Set<string>;
  // Extra messages awaiting their echoed msgid, by cid, and agent deletions awaiting Ergo's answer, by msgid.
  posts: Map<string, (msgid: string) => void>; deletions: Map<string, (failure?: string) => void>;
};
const runtimes = new Map<string, Runtime>();
const connecting = new Map<string, Promise<void>>();

// Typing refresh, the wait for a write's echo before it turns uncertain, the IRC reconnect delay and
// the room-history read budget. Tests shorten these; production never changes them.
export const transportTimers = { typingRefreshMs: 3_000, echoTimeoutMs: 15_000, roomHoldMs: 5_000, reconnectMs: 5_000, historyTimeoutMs: 2_000, awayGraceMs: 120_000, awaySteadyMs: 10 * 60_000 };
export const ROOM_CONTEXT_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;
// Ergo answers CHATHISTORY in milliseconds; a silent server must not hold an accept for long.
const MAX_HISTORY_TEXT = 2_000;

// Route CHATHISTORY batch lines (including nested multiline batches) into the open query. They
// never reach request handling: history is context, not work.
function captureHistory(runtime: Runtime, message: { command: string; params: string[]; tags: Record<string, string>; prefix?: string }): boolean {
  const query = runtime.history;
  if (!query) return false;
  const ref = message.params[0] || "";
  if (message.command === "BATCH" && ref.startsWith("+") && message.params[1] === "chathistory" && !query.batch && normalized(message.params[2] || "") === query.channel) {
    query.batch = ref.slice(1);
    return true;
  }
  if (!query.batch) {
    if (message.command === "FAIL" && message.params[0] === "CHATHISTORY") { query.finish(); return true; }
    return false;
  }
  const entryFor = (): RawHistoryEntry => ({ messageId: message.tags.msgid || "", nick: message.prefix?.split("!", 1)[0] || "", text: "", time: message.tags.time || "", cid: message.tags["+slirc/cid"] || "" });
  if (message.command === "BATCH" && ref === `-${query.batch}`) { query.complete = true; query.finish(); return true; }
  if (message.command === "BATCH" && ref.startsWith("-") && query.inner.has(ref.slice(1))) {
    const { entry, lines } = query.inner.get(ref.slice(1))!;
    query.inner.delete(ref.slice(1));
    query.items.push({ ...entry, text: lines.join("\n").slice(0, MAX_HISTORY_TEXT) });
    return true;
  }
  if (message.tags.batch && query.inner.has(message.tags.batch)) {
    const inner = query.inner.get(message.tags.batch)!;
    if (message.command === "PRIVMSG") {
      const text = message.params[1] || "";
      if (isConcat(message.tags) && inner.lines.length) inner.lines[inner.lines.length - 1] += text;
      else inner.lines.push(text);
    }
    inner.entry.cid ||= message.tags["+slirc/cid"] || "";
    return true;
  }
  if (message.tags.batch !== query.batch) return false;
  if (message.command === "BATCH" && ref.startsWith("+") && message.params[1] === "draft/multiline") {
    if (query.inner.size < 32) query.inner.set(ref.slice(1), { entry: entryFor(), lines: [] });
  } else if (message.command === "PRIVMSG" && !/^histserv$/i.test(entryFor().nick)) {
    query.items.push({ ...entryFor(), text: (message.params[1] || "").slice(0, MAX_HISTORY_TEXT) });
  }
  return true;
}

// Ascending messages strictly before `before` (`msgid=…`, `timestamp=…` or `*`), as Ergo returns them.
// `complete` is true only when Ergo closed the history batch, not on a timeout or FAIL.
function queryHistory(runtime: Runtime, channel: string, before: string, limit: number, command: "BEFORE" | "AROUND" = "BEFORE"): Promise<{ items: RawHistoryEntry[]; complete: boolean }> {
  const run = runtime.historyQueue.then(() => new Promise<{ items: RawHistoryEntry[]; complete: boolean }>((resolve) => {
    const query: HistoryQuery = { channel: normalized(channel), inner: new Map(), items: [], complete: false, finish: () => {} };
    const timer = setTimeout(() => query.finish(), transportTimers.historyTimeoutMs);
    query.finish = () => {
      clearTimeout(timer);
      if (runtime.history === query) runtime.history = null;
      resolve({ items: query.items.filter((entry) => !runtime.redacted.has(entry.messageId)), complete: query.complete });
    };
    runtime.history = query;
    if (!runtime.client.send(`CHATHISTORY ${command} ${query.channel} ${before} ${limit}`)) query.finish();
  }));
  runtime.historyQueue = run.catch(() => []);
  return run;
}

async function roomHistory(runtime: Runtime, channel: string, before: string, limit: number): Promise<HistoryEntry[]> {
  return (await queryHistory(runtime, channel, before, limit)).items.map(({ cid: _cid, ...entry }) => entry);
}

// Whether a message with this reply_cid is in the room's latest history. `checked` is false when
// Ergo did not answer completely, so a caller never treats silence as "not sent".
async function historyByCid(runtime: Runtime, channel: string, cid: string): Promise<{ checked: boolean; msgid: string | null }> {
  const { items, complete } = await queryHistory(runtime, channel, "*", MAX_HISTORY_LIMIT);
  const hit = items.find((entry) => entry.cid === cid);
  return { checked: complete || !!hit, msgid: hit ? hit.messageId || cid : null };
}

// Room messages since the agent last spoke there, oldest first, bounded by count and stored size.
// A DM carries no extra context: the whole conversation is the owner talking to this agent.
async function requestContext(binding: Binding, channel: string, msgid: string): Promise<HistoryEntry[]> {
  const runtime = runtimes.get(binding.id);
  const room = normalized(channel);
  if (!runtime || room === normalized(binding.dm || "") || !msgid) return [];
  const entries = await roomHistory(runtime, room, `msgid=${msgid}`, ROOM_CONTEXT_LIMIT);
  let since = entries.length;
  while (since > 0 && entries[since - 1].nick.toLowerCase() !== binding.nick.toLowerCase()) since--;
  const context = entries.slice(since);
  while (context.length && JSON.stringify(context).length > MAX_CONTEXT) context.shift();
  return context;
}

// Agent-initiated history read: only a room this binding may deliver through right now, proved
// live again, and rechecked after the await before any content is returned.
export async function readRoomHistory(binding: Binding, leaseId: string, channel: string, before: string, limit: number): Promise<HistoryEntry[] | null> {
  const room = normalized(channel);
  const runtime = runtimes.get(binding.id);
  if (!runtime || !validLease(binding, leaseId) || !await deliveryChainLive(binding, room)) return null;
  const entries = await roomHistory(runtime, room, before, Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(limit) || ROOM_CONTEXT_LIMIT)));
  if (!validLease(binding, leaseId) || !authorizedBindingById(binding.id) || !validTarget(binding, room, room) || !deliveryAllowed(binding, room)) return null;
  return entries;
}

// IRCv3 typing while accepted work runs, refreshed until the request leaves `accepted` (reply, fail,
// uncertainty, eviction). Client-only tags need message-tags on this connection; otherwise silent.
function startTyping(binding: Binding, requestId: string, destination: string): void {
  const runtime = runtimes.get(binding.id);
  if (!runtime || runtime.typing.has(requestId) || !runtime.client.enabledCapabilities.has("message-tags")) return;
  const target = normalized(destination);
  const tick = () => {
    const row = db.query("SELECT status FROM agent_session_requests WHERE id=? AND binding_id=?").get(requestId, binding.id) as { status: string } | null;
    if (row?.status !== "accepted" || runtimes.get(binding.id) !== runtime || !deliveryAllowed(binding, target)) stopTyping(runtime, requestId);
    else runtime.client.send(`@+typing=active TAGMSG ${target}`);
  };
  const timer = setInterval(tick, transportTimers.typingRefreshMs);
  timer.unref?.();
  runtime.typing.set(requestId, { target, timer });
  tick();
}

function stopTyping(runtime: Runtime, requestId: string): void {
  const typing = runtime.typing.get(requestId);
  if (!typing) return;
  clearInterval(typing.timer);
  runtime.typing.delete(requestId);
  if (runtime.joined.has(typing.target)) runtime.client.send(`@+typing=done TAGMSG ${typing.target}`);
}

function clearTyping(runtime: Runtime): void {
  for (const { timer } of runtime.typing.values()) clearInterval(timer);
  runtime.typing.clear();
}

// ponytail: one bounded queue per binding; raise if the owner genuinely needs a larger backlog.
export const MAX_QUEUED_REQUESTS = 50;

// Owner-only, content-free snapshots. A live lease and the real private DM are required even
// for a queued label. Replacing the snapshot clears terminal, revoked and disconnected work.
export function ownerAgentRequestStates(nick: string) {
  const owner = accountByNick(nick);
  const requests: { channel: string; messageId: string; state: "Queued" | "Working" }[] = [];
  if (owner) {
    const rows = db.query(`SELECT r.binding_id,r.current_msgid,r.source_channel,r.started_at
      FROM agent_session_requests r JOIN agent_session_bindings b ON b.id=r.binding_id
      WHERE b.owner_account_id=? AND b.harness='pi' AND b.status='ready'
        AND b.lease_id IS NOT NULL AND b.lease_expires_at>?
        AND r.source_channel=b.dm AND r.reply_channel=b.dm
        AND r.status IN ('offered','accepted','replying','failing')
      ORDER BY r.created_at,r.id`).all(owner.id, Date.now()) as { binding_id: string; current_msgid: string; source_channel: string; started_at: number | null }[];
    for (const row of rows) {
      const binding = authorizedBindingById(row.binding_id);
      if (binding && validTarget(binding, row.source_channel, row.source_channel) && deliveryAllowed(binding, row.source_channel)) {
        requests.push({ channel: row.source_channel, messageId: row.current_msgid, state: row.started_at ? "Working" : "Queued" });
      }
    }
  }
  return { accountId: owner?.id || "", requests };
}

const announcedRequests = new Map<string, string>();
function syncAgentRequestStates(owner: string): void {
  const data = ownerAgentRequestStates(owner);
  const key = JSON.stringify(data);
  if (announcedRequests.get(owner) === key) return;
  announcedRequests.set(owner, key);
  publish(owner, "agent-requests", data);
}

export function wakeAgent(bindingId: string): void {
  const binding = db.query("SELECT owner_nick FROM agent_session_bindings WHERE id=?").get(bindingId) as { owner_nick: string } | null;
  if (binding) syncAgentRequestStates(binding.owner_nick);
  for (const wake of runtimes.get(bindingId)?.listeners || []) wake();
}

export function subscribeAgent(bindingId: string, wake: () => void): () => void {
  const runtime = runtimes.get(bindingId);
  if (!runtime) return () => {};
  runtime.listeners.add(wake);
  return () => runtime.listeners.delete(wake);
}

// Attachment is only real once the DM JOIN has been observed. A connected socket or a sent JOIN
// write is not proof, so readiness/introduction stays blocked until then.
export function agentRuntimeConnected(bindingId: string): boolean {
  const runtime = runtimes.get(bindingId);
  return !!runtime?.client && runtime.dmReady;
}

// Presence dot for an agent account: its bound session holds a live lease and the transport saw
// the DM JOIN. Legacy agents with no ready binding are never attached; IRC presence proves nothing.
export function agentAttached(nick: string, now = Date.now()): boolean {
  const binding = db.query("SELECT id FROM agent_session_bindings WHERE nick=? COLLATE NOCASE AND status='ready' AND lease_id IS NOT NULL AND lease_expires_at>?")
    .get(nick, now) as { id: string } | null;
  return !!binding && agentRuntimeConnected(binding.id);
}

// Last attachment announced per agent nick, so lease renewals and repeat syncs publish nothing.
const announcedPresence = new Map<string, boolean>();
// A sleeping laptop wakes for a minute or so every hour and its session reattaches each time. One
// notice covers the whole stretch: after a notice, the next drop owes another only once the session
// had stayed attached for awaySteadyMs. Binding id -> when it last attached; ids already told.
const attachedSince = new Map<string, number>();
const toldAway = new Set<string>();

// Tell the owner and everyone sharing a room with the agent when its attachment actually flips.
// Lease expiry has no event of its own, so the app entrypoint also runs this on a short timer.
export function syncAgentPresence(now = Date.now()): void {
  for (const { id, nick, owner_nick: owner, status } of db.query("SELECT id, nick, owner_nick, status FROM agent_session_bindings").all() as { id: string; nick: string; owner_nick: string; status: string }[]) {
    const key = nick.toLowerCase();
    if (status === "revoked" && !announcedPresence.has(key)) continue;
    const attached = agentAttached(nick, now);
    // Any attached sweep clears an owed notice, so a quick reconnect never leaves one behind.
    if (attached) clearAway(id);
    const before = announcedPresence.get(key);
    if (before === attached) continue;
    announcedPresence.set(key, attached);
    if (attached) attachedSince.set(id, now);
    // Only a drop this process saw starts a notice here. A restart's owed notices were marked in the database by resetAgentSessionState.
    if (!attached && before === true) {
      if (now - (attachedSince.get(id) ?? now) >= transportTimers.awaySteadyMs) toldAway.delete(id);
      if (!toldAway.has(id)) markAway(id, now);
    }
    for (const person of agentAudience(nick, owner)) publish(person, "agent-presence", { nick, attached });
  }
  tellAway(now);
  // Lease expiry has no callback; the same sweep removes stale execution labels.
  const owners = db.query("SELECT DISTINCT owner_nick FROM agent_session_bindings").all() as { owner_nick: string }[];
  for (const { owner_nick } of owners) syncAgentRequestStates(owner_nick);
}

// The offline notice is owed from `away_since` (epoch ms) in the database, so a restart keeps it.
function markAway(bindingId: string, now: number): void {
  db.query("UPDATE agent_session_bindings SET away_since=COALESCE(away_since, ?) WHERE id=? AND status='ready'").run(now, bindingId);
}

function clearAway(bindingId: string): void {
  db.query("UPDATE agent_session_bindings SET away_since=NULL WHERE id=? AND away_since IS NOT NULL").run(bindingId);
}

// What an agent says in its owner's DM once its session has been gone for the grace period: how
// to bring that exact session back, and where to delete the agent.
export function awayNotice(binding: Pick<Binding, "harness" | "session_id" | "session_file">, origin = configuredAppOrigin()): string {
  const name = harnessById(binding.harness)?.name;
  const id = /^[A-Za-z0-9_-]{1,128}$/.test(binding.session_id) ? binding.session_id : "";
  const quoted = (path: string) => /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
  // The command never ends a sentence, so copying it picks up no full stop.
  let back = "Resume it in the folder it ran in";
  if (binding.harness === "pi" && id) back = `Run pi --session ${id}`;
  if (binding.harness === "claude" && id) {
    // The Claude Code listener sends its folder as the session file.
    const folder = binding.session_file.startsWith("/") ? binding.session_file : "";
    back = folder ? `Run cd ${quoted(folder)} && claude --resume ${id}` : `Run claude --resume ${id} in the folder it ran in`;
  }
  // The agent itself is speaking, so it says "my" throughout.
  return `My ${name ? `${name} ` : ""}session went offline. ${back} to bring me back. To delete me, use Remove on ${origin}/agents`;
}

// The client-only tag lets Slirc draw the notice as a card; IRC clients read the same plain line.
function awayLine(binding: Binding): string {
  return `@+slirc/agent-offline=${binding.harness} PRIVMSG ${binding.dm} :${awayNotice(binding)}`;
}

function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); })])
    .finally(() => clearTimeout(timer));
}

// No live runtime: connect as the agent with the credentials its runtime uses, join the DM the same
// verified way, post the line and leave once the server echoes it back. Never a public channel.
async function postAwayDetached(binding: Binding): Promise<boolean> {
  const dm = normalized(binding.dm || "");
  if (!validTarget(binding, dm, dm) || !await verifyPrivateChain([dm])) return false;
  const line = awayLine(binding);
  const text = awayNotice(binding);
  const own = (message: ParsedMessage) => message.prefix?.split("!", 1)[0].toLowerCase() === binding.nick.toLowerCase();
  const client = new IrcClient({
    host: process.env.ERGO_HOST || "127.0.0.1", port: Number(process.env.ERGO_PORT || 6667),
    nick: binding.nick, realname: "Slirc session agent", saslUser: binding.nick, saslPass: bindingIrcPassword(binding),
    capabilities: ["message-tags", "echo-message"],
  });
  try {
    await within(client.connect());
    const joined = client.waitFor((m) => m.command === "JOIN" && own(m) && normalized(m.params.at(-1) || "") === dm);
    client.send(`JOIN ${dm}`);
    await within(joined);
    const echoed = client.waitFor((m) => m.command === "PRIVMSG" && own(m) && normalized(m.params[0] || "") === dm && m.params[1] === text);
    client.send(line);
    await within(echoed);
    return true;
  } catch {
    return false;
  } finally {
    client.quit();
  }
}

// Owed notices whose grace period has passed. A quick reconnect cleared its mark already; a revoked
// or removed agent says nothing and loses the mark. Each notice is posted once, then cleared.
const awayPosting = new Set<string>();
function tellAway(now: number): void {
  const due = db.query("SELECT * FROM agent_session_bindings WHERE away_since IS NOT NULL AND away_since <= ?")
    .all(now - transportTimers.awayGraceMs) as Binding[];
  for (const binding of due) {
    if (awayPosting.has(binding.id)) continue;
    if (binding.status !== "ready" || !binding.dm || agentAttached(binding.nick, now)) { clearAway(binding.id); continue; }
    const runtime = runtimes.get(binding.id);
    if (runtime?.dmReady && deliveryAllowed(binding, binding.dm)) {
      if (runtime.client.send(awayLine(binding))) { clearAway(binding.id); toldAway.add(binding.id); }
      continue;
    }
    awayPosting.add(binding.id);
    void postAwayDetached(binding)
      .then((sent) => { if (sent) { clearAway(binding.id); toldAway.add(binding.id); } })
      .finally(() => awayPosting.delete(binding.id));
  }
}

function agentRooms(binding: Binding): string[] {
  return memberChannels(binding.nick).filter((room) => agentCanReadChannel(binding.nick, room));
}

// The channel plus its thread ancestors; the live private-mode proof must cover all of them.
function roomChain(channel: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = normalized(channel);
  while (!seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const thread = db.query("SELECT parent FROM threads WHERE channel = ?").get(current) as { parent: string } | null;
    if (!thread) break;
    current = normalized(thread.parent);
  }
  return chain;
}

async function verifyPrivateChain(chain: string[]): Promise<boolean> {
  for (const channel of chain) {
    const mode = await readPrivateChannelMode(channel);
    if (!mode || !mode.secret || !mode.inviteOnly) return false;
  }
  return true;
}

// Verify, then JOIN. Private rooms never emit a JOIN without the live +s/+i proof; open and
// workspace rooms are joined plainly and carry the owner-only grant instead.
async function joinRoom(runtime: Runtime, binding: Binding, channel: string): Promise<boolean> {
  const room = normalized(channel);
  if (runtime.joined.has(room)) return true;
  if (!validTarget(binding, room, room)) return false;
  const ownerOnly = isOpenChannel(room) || agentOwnerOnlyGrant(binding.nick, room);
  if (isOpenChannel(room) || channelInfo(room)?.visibility === "workspace") {
    if (!ownerOnly) return false;
    runtime.rooms.set(room, { secret: false, inviteOnly: false, verified: false, publicRoom: true, ownerOnly: true });
    return runtime.client.send(`JOIN ${room}`);
  }
  if (!await verifyPrivateChain(roomChain(room))) {
    runtime.rooms.set(room, { secret: false, inviteOnly: false, verified: false, publicRoom: false, ownerOnly: false });
    return false;
  }
  runtime.rooms.set(room, { secret: true, inviteOnly: true, verified: true, publicRoom: false, ownerOnly });
  return runtime.client.send(`JOIN ${room}`);
}

// A channel the transport may deliver through: joined, and either a live-verified private room or
// an open/workspace room whose owner-only grant still stands.
function deliveryAllowed(binding: Binding, channel: string): boolean {
  const runtime = runtimes.get(binding.id);
  const room = normalized(channel);
  const state = runtime?.rooms.get(room);
  if (!runtime || !runtime.joined.has(room) || !state) return false;
  if (state.publicRoom) return state.ownerOnly && agentOwnerOnlyGrant(binding.nick, room);
  return state.verified && state.secret && state.inviteOnly;
}

// Stop using a room whose live private state is gone (MODE change, KICK, PART, revoked grant) and
// drop the cached request content that referred to it. Accepted work becomes uncertain, not rerunnable.
function evictRoom(runtime: Runtime, binding: Binding, channel: string, reason = "Private access changed"): void {
  const room = normalized(channel);
  if (!runtime.joined.has(room) && !runtime.rooms.has(room)) return;
  runtime.client.send(`PART ${room} :${reason}`);
  runtime.joined.delete(room);
  runtime.rooms.delete(room);
  if (room === normalized(binding.dm || "")) runtime.dmReady = false;
  const now = Date.now();
  db.query(`UPDATE agent_session_requests SET status='cancelled',text='',context='[]',confirm_revision=NULL,updated_at=?
    WHERE binding_id=? AND (source_channel=? OR reply_channel=?) AND status IN ('pending','offered','needs_confirmation')`)
    .run(now, binding.id, room, room);
  db.query(`UPDATE agent_session_requests SET status='uncertain',text='',context='[]',updated_at=?
    WHERE binding_id=? AND (source_channel=? OR reply_channel=?) AND status IN ('accepted','replying','failing')`)
    .run(now, binding.id, room, room);
  wakeAgent(binding.id);
}

// Narrow server hook: a new invite grant must be joined without waiting for a reconnect.
export async function joinAgentRoomForNick(nick: string, channel: string): Promise<void> {
  const binding = db.query("SELECT * FROM agent_session_bindings WHERE nick=? AND status='ready'").get(nick) as Binding | null;
  const runtime = binding && runtimes.get(binding.id);
  if (!binding || !runtime) return;
  await joinRoom(runtime, binding, normalized(channel));
}

// Narrow server hook: a removal/kick must stop delivery and clear revoked context immediately.
export function evictAgentRoomForNick(nick: string, channel: string): void {
  const binding = db.query("SELECT * FROM agent_session_bindings WHERE nick=? AND status='ready'").get(nick) as Binding | null;
  const runtime = binding && runtimes.get(binding.id);
  if (binding && runtime) evictRoom(runtime, binding, channel, "Removed from channel");
}

function ownerMention(binding: Binding, joined: Set<string>, message: { command: string; params: string[]; tags: Record<string,string> }): { room: string; text: string; msgid: string; context: unknown[] } | null {
  // CRITICAL: a channel trigger is always the owner's own authenticated account tag. An open or
  // workspace attachment is owner-only, so a stranger's message there, even one that mentions the
  // agent, is history and never work. slirc_history still lets the owner's agent read the room.
  if (message.command !== "PRIVMSG" || message.tags.account?.toLowerCase() !== binding.owner_nick.toLowerCase()) return null;
  const room = normalized(message.params[0] || "");
  if (!joined.has(room) || !message.tags.msgid) return null;
  const direct = room === normalized(binding.dm || "");
  if (direct && /^confirm [a-f0-9-]{36} \d{1,10}$/i.test(message.params[1] || "")) return null;
  const nick = binding.nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!direct && !new RegExp(`(?:^|[^a-z0-9_-])@?${nick}(?![a-z0-9_-])`, "i").test(message.params[1] || "")) return null;
  return { room, text: message.params[1] || "", msgid: message.tags.msgid, context: [] };
}

function notifyOffline(binding: Binding, id: string, revision: number, text = ""): void {
  const runtime = runtimes.get(binding.id);
  if (runtime && binding.dm && runtime.client.enabledCapabilities.has("echo-message")) {
    const preview = text.replace(/[\r\n]+/g, " ").slice(0, 120);
    runtime.client.send(`PRIVMSG ${binding.dm} :Slirc request ${id} is waiting for your confirmation (revision ${revision}).${preview ? ` Latest: ${preview}` : ""}`);
  }
}

function createRequest(binding: Binding, mention: { room: string; text: string; msgid: string; context: unknown[] }): string | null {
  const author = accountByNick(binding.owner_nick);
  if (!author || author.id !== binding.owner_account_id || mention.text.length > 8_000) return null;
  const source = normalized(mention.room);
  // Strict target (own DM, an explicit secret/thread grant, or an owner-only open/workspace room)
  // plus live delivery proof; a revoked or unproven room never creates work.
  if (!validTarget(binding, source, source) || !deliveryAllowed(binding, source)) return null;
  const queued = db.query(`SELECT COUNT(*) AS n FROM agent_session_requests
    WHERE binding_id=? AND status IN ('pending','offered','needs_confirmation')`).get(binding.id) as { n: number };
  if (queued.n >= MAX_QUEUED_REQUESTS) return null;
  const id = crypto.randomUUID();
  const now = Date.now();
  const attached = !!db.query(`SELECT 1 FROM agent_session_bindings WHERE id=? AND status='ready' AND lease_id IS NOT NULL AND lease_expires_at>?`).get(binding.id, now);
  const inserted = db.query(`INSERT OR IGNORE INTO agent_session_requests
    (id,binding_id,source_channel,reply_channel,original_msgid,current_msgid,author_account_id,revision,text,context,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?,?, ?,?)`).run(id, binding.id, source, source, mention.msgid, mention.msgid, author.id,
    mention.text.slice(0, 8_000), JSON.stringify(mention.context).slice(0, 20_000), attached ? "offered" : "needs_confirmation", now, now);
  if (!inserted.changes) return null;
  if (!attached) notifyOffline(binding, id, 1, mention.text);
  wakeAgent(binding.id);
  return id;
}

// Owner-only forward: the maintainer hands one message from a room they can read to their own
// agent with an optional note. The agent answers publicly in that same room. Only the binding's
// owner account may call this, and the agent must already be attached there.
export async function forwardToAgent(binding: Binding, ownerAccountId: string, channel: string, messageId: string, note = ""): Promise<{ id: string } | { error: string; status: number }> {
  if (binding.owner_account_id !== ownerAccountId || !authorizedBindingById(binding.id) || binding.status !== "ready") return { error: "agent not found", status: 404 };
  const room = normalized(channel);
  if (!/^[A-Za-z0-9=_\-]{1,64}$/.test(messageId)) return { error: "invalid message id", status: 400 };
  if (!isOpenChannel(room) && !isMember(binding.owner_nick, room)) return { error: "channel membership required", status: 403 };
  const runtime = runtimes.get(binding.id);
  if (!runtime || !validTarget(binding, room, room) || !deliveryAllowed(binding, room)) return { error: "attach the agent to this channel first", status: 409 };
  const { items } = await queryHistory(runtime, room, `msgid=${messageId}`, 3, "AROUND");
  const found = items.find((entry) => entry.messageId === messageId);
  if (!found) return { error: "message not found in this channel", status: 404 };
  const quoted = `Forwarded from ${found.nick} in ${room}:\n${found.text}`;
  const text = `${note.trim() ? `${note.trim()}\n\n` : ""}${quoted}`.slice(0, 8_000);
  const id = createRequest(binding, { room, text, msgid: messageId, context: [] });
  if (id) return { id };
  const existing = db.query("SELECT id FROM agent_session_requests WHERE binding_id=? AND source_channel=? AND original_msgid=?")
    .get(binding.id, room, messageId) as { id: string } | null;
  if (existing) return { id: existing.id };
  return { error: "could not queue that message", status: 409 };
}

export async function connectAgentTransport(binding: Binding): Promise<void> {
  if (runtimes.has(binding.id)) return;
  const pending = connecting.get(binding.id);
  if (pending) return pending;
  const task = connectTransport(binding).finally(() => connecting.delete(binding.id));
  connecting.set(binding.id, task);
  return task;
}

async function connectTransport(binding: Binding): Promise<void> {
  if (runtimes.has(binding.id)) return;
  const host = process.env.ERGO_HOST || "127.0.0.1";
  const port = Number(process.env.ERGO_PORT || 6667);
  const joined = new Set<string>();
  const rooms = new Map<string, RoomState>();
  const listeners = new Set<() => void>();
  const echoes = new Map<string, EchoAssembly>();
  const dm = normalized(binding.dm || "");
  const runtime: Runtime = { client: null as unknown as IrcClient, joined, rooms, dmReady: false, listeners, echoes, typing: new Map(), history: null, historyQueue: Promise.resolve(), redacted: new Set(), posts: new Map(), deletions: new Map() };
  const multiline = new Map<string, { target: string; tags: Record<string, string>; prefix: string; lines: string[]; bytes: number; rejected?: boolean; lastMsgid?: string }>();
  const confirmReplyRow = (row: any, msgid: string) => {
    const final = row.status === "failing" ? "failed" : "replied";
    db.query(`UPDATE agent_session_requests SET status=?,reply_msgid=?,reply_batch=NULL,updated_at=? WHERE binding_id=? AND id=? AND status IN ('replying','failing')`)
      .run(final, msgid, Date.now(), binding.id, row.id);
  };
  const markReplyUncertain = (requestId: string) => {
    db.query(`UPDATE agent_session_requests SET status='uncertain',text='',reply_batch=NULL,updated_at=? WHERE binding_id=? AND id=? AND status IN ('replying','failing')`)
      .run(Date.now(), binding.id, requestId);
    wakeAgent(binding.id);
  };
  // Authoritative echo of our own send. Only a matching destination, correlation, sender and exact
  // content may confirm; a multiline is terminal only on its matching closing BATCH with every line.
  const handleSelfEcho = (message: { command: string; params: string[]; tags: Record<string, string>; prefix?: string }): boolean => {
    const cid = message.tags["+slirc/cid"] || "";
    const batch = message.tags.batch || "";
    // An extra message (sendToRequest) learns its msgid from its echoed line or multiline opener.
    const post = cid && message.tags.msgid ? runtime.posts.get(cid) : undefined;
    if (post && (message.command === "PRIVMSG" || (message.command === "BATCH" && message.params[0]?.startsWith("+")))) post(message.tags.msgid);
    if (message.command === "BATCH" && message.params[0]?.startsWith("+") && message.params[1] === "draft/multiline") {
      const ref = message.params[0].slice(1);
      const target = normalized(message.params[2] || "");
      // Ergo assigns its own batch ref and strips the cid from the lines, keeping it on the echoed
      // opener. Correlate the opener by cid and key the assembly by the server-assigned ref.
      const row = cid ? db.query("SELECT id,reply_channel,reply_cid,reply_text FROM agent_session_requests WHERE binding_id=? AND reply_cid=? AND status IN ('replying','failing')").get(binding.id, cid) as any : null;
      if (row && target === normalized(row.reply_channel) && echoes.size < 32) {
        echoes.set(`${binding.id}:${ref}`, { cid: row.reply_cid, destination: target, expected: replyParts(String(row.reply_text ?? ""), row.reply_channel).map((part) => part.text), received: [], lastMsgid: message.tags.msgid || "", requestId: row.id });
      }
      return true;
    }
    if (message.command === "BATCH" && message.params[0]?.startsWith("-")) {
      const ref = message.params[0].slice(1);
      const assembly = echoes.get(`${binding.id}:${ref}`);
      if (assembly) {
        echoes.delete(`${binding.id}:${ref}`);
        const row = db.query("SELECT id,status FROM agent_session_requests WHERE binding_id=? AND id=? AND status IN ('replying','failing')").get(binding.id, assembly.requestId) as any;
        if (row && assembly.received.length === assembly.expected.length && assembly.received.every((line, index) => line === assembly.expected[index])) {
          confirmReplyRow(row, assembly.lastMsgid);
          wakeAgent(binding.id);
        }
      }
      return true;
    }
    if (message.command === "PRIVMSG" && (cid || batch)) {
      const target = normalized(message.params[0] || "");
      const text = message.params[1] || "";
      if (target === dm && cid) {
        const intro = db.query("SELECT intro_cid,intro_text,intro_state FROM agent_session_bindings WHERE id=?").get(binding.id) as any;
        if (intro?.intro_state === "sending" && message.tags.msgid && intro.intro_cid === cid && intro.intro_text === text) {
          const done = db.query("UPDATE agent_session_bindings SET intro_state='sent',intro_msgid=? WHERE id=? AND intro_cid=? AND intro_state='sending'").run(message.tags.msgid, binding.id, cid);
          if (done.changes) return true;
        }
      }
      if (batch) {
        // Ergo echoes multiline lines with only a server batch tag (no msgid, no cid): a line is
        // acknowledged only inside its echoed opener assembly.
        const assembly = echoes.get(`${binding.id}:${batch}`);
        if (assembly) {
          const index = assembly.received.length;
          if (index < assembly.expected.length && text === assembly.expected[index]) { assembly.received.push(text); assembly.lastMsgid ||= message.tags.msgid || ""; }
          else { echoes.delete(`${binding.id}:${batch}`); markReplyUncertain(assembly.requestId); }
        }
        return true;
      }
      if (!message.tags.msgid) return true;
      const resolved = cid ? db.query("SELECT id,status,reply_channel,reply_text FROM agent_session_requests WHERE binding_id=? AND reply_cid=? AND status IN ('replying','failing')").get(binding.id, cid) as any : null;
      if (resolved && target === normalized(resolved.reply_channel)) {
        const expected = replyParts(String(resolved.reply_text ?? ""), resolved.reply_channel);
        if (expected.length === 1 && text === expected[0].text) { confirmReplyRow(resolved, message.tags.msgid); wakeAgent(binding.id); }
        else markReplyUncertain(resolved.id);
      }
      return true;
    }
    return false;
  };
  const client = new IrcClient({
    // Same trusted container-network endpoint as the existing grants connection.
    host, port,
    nick: binding.nick, realname: "Slirc session agent", saslUser: binding.nick, saslPass: bindingIrcPassword(binding),
    capabilities: ["account-tag", "server-time", "message-tags", "batch", "draft/multiline", "draft/message-redaction", "echo-message"],
    onMessage: (message) => {
      if (captureHistory(runtime, message)) return;
      if (message.command === "FAIL" && (message.params[0] || "").toUpperCase() === "REDACT") {
        runtime.deletions.get(message.params[3] || "")?.(message.params[1] === "UNKNOWN_MSGID" ? "gone" : message.params.slice(1).join(" ") || "REDACT failed");
        return;
      }
      const self = message.prefix?.split("!", 1)[0].toLowerCase() === binding.nick.toLowerCase();
      if (self && handleSelfEcho(message)) return;
      if (message.command === "BATCH" && message.params[0]?.startsWith("+") && message.params[1] === "draft/multiline") {
        if (multiline.size < 32 && message.tags.account?.toLowerCase() === binding.owner_nick.toLowerCase()) {
          multiline.set(message.params[0].slice(1), { target: message.params[2] || "", tags: message.tags, prefix: message.prefix || "", lines: [], bytes: 0 });
        }
        return;
      }
      if (message.command === "PRIVMSG" && message.tags.batch && multiline.has(message.tags.batch)) {
        const batch = multiline.get(message.tags.batch)!;
        const text = message.params[1] || "";
        batch.bytes += Buffer.byteLength(text, "utf8");
        if (batch.rejected || batch.bytes > 8_000 || batch.lines.length >= 30) {
          batch.rejected = true;
          batch.lines = [];
        } else {
          // A concat part continues the line before it (a long line cut to fit Ergo's 512 bytes).
          if (isConcat(message.tags) && batch.lines.length) batch.lines[batch.lines.length - 1] += text;
          else batch.lines.push(text);
          batch.lastMsgid = message.tags.msgid;
        }
        return;
      }
      // Unknown/rejected batches must never turn their remaining lines into independent requests.
      if (message.command === "PRIVMSG" && message.tags.batch
        && message.prefix?.split("!", 1)[0].toLowerCase() !== binding.nick.toLowerCase()) return;
      if (message.command === "BATCH" && message.params[0]?.startsWith("-") && multiline.has(message.params[0].slice(1))) {
        const batch = multiline.get(message.params[0].slice(1))!;
        multiline.delete(message.params[0].slice(1));
        if (batch.rejected) return;
        const text = batch.lines.join("\n");
        const assembled = { command: "PRIVMSG", params: [batch.target, text], tags: { ...batch.tags }, prefix: batch.prefix };
        if (!batch.tags.msgid) assembled.tags.msgid = batch.lastMsgid || "";
        // Feed assembled requests, edits, and owner confirmations through the same guarded path below.
        message = assembled as typeof message;
      }
      if (message.command === "JOIN" && self) {
        const room = normalized(message.params.at(-1) || "");
        joined.add(room);
        if (room === dm) {
          runtime.dmReady = true;
          syncAgentPresence();
          // Readiness is now confirmed; deliver the one-time introduction that attach could not.
          const lease = db.query("SELECT lease_id FROM agent_session_bindings WHERE id=? AND status='ready' AND lease_id IS NOT NULL AND lease_expires_at>?")
            .get(binding.id, Date.now()) as { lease_id: string } | null;
          if (lease) { try { introduceAgent(binding, lease.lease_id); } catch {} sendPendingReview(binding, lease.lease_id); }
        }
      } else if (message.command === "PART" && self) {
        const room = normalized(message.params[0] || "");
        if (joined.has(room)) evictRoom(runtime, binding, room, "Left channel");
      } else if (message.command === "KICK") {
        const room = normalized(message.params[0] || "");
        const target = normalized(message.params[1] || "");
        if (target === binding.nick.toLowerCase() || self) evictRoom(runtime, binding, room, "Kicked from channel");
      } else if (message.command === "MODE" && message.params[0] && joined.has(normalized(message.params[0]))) {
        const room = normalized(message.params[0]);
        const state = rooms.get(room);
        if (state && !state.publicRoom) {
          let adding = true;
          for (const flag of message.params[1] || "") {
            if (flag === "+") adding = true;
            else if (flag === "-") adding = false;
            else if (flag === "s") state.secret = adding;
            else if (flag === "i") state.inviteOnly = adding;
          }
          // Unknown or changed private state fails closed: drop the room and its cached requests.
          if (!state.secret || !state.inviteOnly) evictRoom(runtime, binding, room, "Channel is no longer private");
        }
      }
      if (!message.tags["+draft/edit"] && message.command !== "REDACT") {
        const trigger = ownerMention(binding, joined, message);
        if (trigger) createRequest(binding, trigger);
      }
      const author = accountByNick(message.tags.account || "");
      if (message.command === "REDACT") {
        const channel = normalized(message.params[0] || "");
        const msgid = message.params[1] || "";
        if (self) runtime.deletions.get(msgid)?.();
        // Context fetched later must not bring deleted text back.
        runtime.redacted.add(msgid);
        if (runtime.redacted.size > 500) runtime.redacted.delete(runtime.redacted.values().next().value!);
        // A REDACT observed on the authoritative server connection is an authoritative deletion:
        // Ergo only emits it after validating author/moderation permission. Do not gate it on the
        // owner account tag, because a moderator or server redaction does not carry one; the event
        // itself is the proof, and a client tag is never trusted as one.
        const rows = db.query("SELECT id,current_msgid,status,context,text FROM agent_session_requests WHERE binding_id=? AND source_channel=?")
          .all(binding.id, channel) as { id: string; current_msgid: string; status: string; context: string; text: string }[];
        db.transaction(() => {
          for (const row of rows) {
            let context: any[] = [];
            try { context = JSON.parse(row.context); } catch {}
            const clean = context.filter((entry) => entry?.messageId !== msgid);
            const current = row.current_msgid === msgid;
            if (!current && clean.length === context.length) continue; // unrelated message
            const cancellable = ["pending","offered","needs_confirmation"].includes(row.status);
            // Unaccepted work is cancelled. Accepted/in-flight keeps its delivery/execution state
            // but loses the deleted source text. Terminal records only lose the deleted content.
            const status = current && cancellable ? "cancelled" : row.status;
            db.query(`UPDATE agent_session_requests SET status=?,text=?,context=?,updated_at=? WHERE id=? AND binding_id=?`)
              .run(status, current ? "" : row.text, JSON.stringify(clean), Date.now(), row.id, binding.id);
          }
        })();
        wakeAgent(binding.id);
        return;
      }
      if (message.command === "PRIVMSG" && author?.id === binding.owner_account_id) {
        const channel = normalized(message.params[0] || "");
        const confirm = message.params[1]?.match(/^confirm ([a-f0-9-]{36}) (\d{1,10})$/i);
        if (channel === dm && confirm) {
          confirmOfflineRequest(binding, confirm[1], Number(confirm[2]));
          wakeAgent(binding.id);
          return;
        }
        const editOf = message.tags["+draft/edit"];
        const msgid = message.tags.msgid;
        const editText = message.params[1];
        if (editOf && msgid && editText) {
          const outcome = db.transaction(() => {
            // Pre-acceptance: latest text and message ID, new revision, confirmation invalidated.
            const pending = db.query(`UPDATE agent_session_requests SET current_msgid=?,revision=revision+1,text=?,context='[]',status='needs_confirmation',confirm_revision=NULL,updated_at=?
              WHERE binding_id=? AND source_channel=? AND current_msgid=? AND author_account_id=? AND status IN ('pending','offered','needs_confirmation')`)
              .run(msgid, editText.slice(0, 8_000), Date.now(), binding.id, channel, editOf, binding.owner_account_id);
            // Post-acceptance: track the replacement ID/revision and clear source context, but never
            // cancel or requeue accepted/in-flight execution.
            const active = db.query(`UPDATE agent_session_requests SET current_msgid=?,revision=revision+1,text=?,context='[]',updated_at=?
              WHERE binding_id=? AND source_channel=? AND current_msgid=? AND author_account_id=? AND status IN ('accepted','replying','failing')`)
              .run(msgid, editText.slice(0, 8_000), Date.now(), binding.id, channel, editOf, binding.owner_account_id);
            return { pending: pending.changes, active: active.changes };
          })();
          if (outcome.pending || outcome.active) {
            if (outcome.pending) {
              const updated = db.query("SELECT id,revision,text FROM agent_session_requests WHERE binding_id=? AND current_msgid=?").get(binding.id, msgid) as { id: string; revision: number; text: string } | null;
              if (updated) notifyOffline(binding, updated.id, updated.revision, updated.text);
            }
            wakeAgent(binding.id); return;
          }
        }
      }
    },
    onClose: () => {
      clearTyping(runtime);
      runtime.history?.finish();
      joined.clear();
      rooms.clear();
      runtime.dmReady = false;
      db.query(`UPDATE agent_session_requests SET status='uncertain', text='', context='[]', updated_at=?
        WHERE binding_id=? AND status IN ('pending','offered','needs_confirmation','accepted','replying','failing')`).run(Date.now(), binding.id);
      wakeAgent(binding.id);
      runtimes.delete(binding.id);
      syncAgentPresence();
      const retry = setTimeout(() => {
        const latest = db.query("SELECT * FROM agent_session_bindings WHERE id=? AND status='ready'").get(binding.id) as Binding | null;
        if (latest) void connectAgentTransport(latest).catch(() => {});
      }, transportTimers.reconnectMs);
      retry.unref?.();
    },
  });
  await client.connect();
  runtime.client = client;
  runtimes.set(binding.id, runtime);
  for (const room of agentRooms(binding)) await joinRoom(runtime, binding, room);
}

// Owner review list for requests that arrived while no adapter was attached. Sent once per adapter
// lease (from attach, or from the DM JOIN when attach came first), bounded to five previews, and
// never an automatic replay: only an owner `confirm` in the DM authorizes work.
const reviewedLeases = new Map<string, string>();
export function sendPendingReview(binding: Binding, leaseId: string): boolean {
  const runtime = runtimes.get(binding.id);
  if (!runtime || !binding.dm || !validLease(binding, leaseId) || !deliveryAllowed(binding, binding.dm)) return false;
  if (reviewedLeases.get(binding.id) === leaseId) return false;
  const rows = db.query(`SELECT id,revision,text FROM agent_session_requests WHERE binding_id=? AND status='needs_confirmation' ORDER BY created_at LIMIT 5`).all(binding.id) as { id: string; revision: number; text: string }[];
  if (!rows.length) return false;
  reviewedLeases.set(binding.id, leaseId);
  const total = (db.query("SELECT COUNT(*) AS n FROM agent_session_requests WHERE binding_id=? AND status='needs_confirmation'").get(binding.id) as { n: number }).n;
  const detail = rows.map((row) => `${row.id} (rev ${row.revision}): ${row.text.replace(/[\r\n]+/g, " ").slice(0, 120)}`).join(" | ");
  return runtime.client.send(`PRIVMSG ${binding.dm} :Slirc has ${total} request(s) awaiting review. Reply here with confirm <request-id> <revision> to run the latest version. No work runs until you confirm. ${detail}`);
}

export function introduceAgent(binding: Binding, leaseId: string): string {
  if (!validLease(binding, leaseId)) throw new Error("agent session is not attached");
  const runtime = runtimes.get(binding.id);
  // Confirmed DM membership, not a socket or a JOIN write, is the readiness signal.
  if (!runtime?.dmReady || !deliveryAllowed(binding, binding.dm || "")) return "pending";
  const cid = crypto.randomUUID();
  const session = binding.session_name ? ` session "${binding.session_name.replace(/[\r\n]/g, " ").slice(0, 80)}"` : " session";
  const text = `Connected to your ${harnessById(binding.harness)?.name ?? binding.harness}${session}. Talk to me here, or use /invite @${binding.nick} in an invite-only channel to add me. Open channels are unsupported. Only you can give me instructions.`;
  const reserved = db.query(`UPDATE agent_session_bindings SET intro_state='sending',intro_cid=?,intro_text=?
    WHERE id=? AND intro_state='pending' AND lease_id=? AND lease_expires_at>?`).run(cid, text, binding.id, leaseId, Date.now());
  if (!reserved.changes) return (db.query("SELECT intro_state FROM agent_session_bindings WHERE id=?").get(binding.id) as { intro_state: string }).intro_state;
  if (!runtime.client.enabledCapabilities.has("echo-message") || !runtime.client.send(`@+slirc/cid=${cid} PRIVMSG ${binding.dm} :${text}`)) {
    db.query("UPDATE agent_session_bindings SET intro_state='uncertain' WHERE id=? AND intro_cid=?").run(binding.id, cid);
    return "uncertain";
  }
  setTimeout(() => db.query(`UPDATE agent_session_bindings SET intro_state='uncertain' WHERE id=? AND intro_cid=? AND intro_state='sending'`)
    .run(binding.id, cid), transportTimers.echoTimeoutMs).unref?.();
  return "sending";
}

export function disconnectAgentTransport(bindingId: string): void {
  const runtime = runtimes.get(bindingId);
  if (!runtime) return;
  runtimes.delete(bindingId);
  clearTyping(runtime);
  runtime.client.quit();
  syncAgentPresence();
}

export async function offeredRequests(binding: Binding): Promise<unknown[]> {
  const unsafe = await pruneUnsafeRequests(binding);
  const rows = db.query(`SELECT id,source_channel,reply_channel,current_msgid,revision,text,context,status FROM agent_session_requests
    WHERE binding_id=? AND status='offered' ORDER BY created_at LIMIT 50`).all(binding.id) as { source_channel: string; reply_channel: string }[];
  // Recheck current membership/room state on every read, and never expose a channel whose live
  // private proof failed even if the guarded DB transition skipped it for a newer revision.
  return rows.filter((row) => !unsafe.has(normalized(row.source_channel)) && !unsafe.has(normalized(row.reply_channel))
    && validTarget(binding, row.source_channel, row.reply_channel)
    && deliveryAllowed(binding, row.source_channel) && deliveryAllowed(binding, row.reply_channel));
}

// Terminal outcomes are never rewritten. A request whose room is no longer provably private has its
// cached content cleared: unaccepted work is cancelled, accepted/in-flight work becomes uncertain.
// The decision is applied in a transaction against the current row (status + revision), because an
// awaited probe lets an accept/reply/edit land first. Returns the channels proven unsafe this pass
// so the caller cannot expose them even when a newer revision skipped the write.
async function pruneUnsafeRequests(binding: Binding): Promise<Set<string>> {
  const rows = db.query(`SELECT id,source_channel,reply_channel,status,revision FROM agent_session_requests
    WHERE binding_id=? AND status IN ('pending','offered','needs_confirmation','accepted','replying','failing')`).all(binding.id) as { id: string; source_channel: string; reply_channel: string; status: string; revision: number }[];
  const unsafe = new Set<string>();
  if (!rows.length) return unsafe;
  const liveChecked = new Map<string, boolean>();
  const liveFailed = async (channel: string): Promise<boolean> => {
    const room = normalized(channel);
    if (liveChecked.has(room)) return liveChecked.get(room)!;
    const failed = runtimes.get(binding.id)?.rooms.get(room)?.publicRoom && deliveryAllowed(binding, room)
      ? false
      : !await verifyPrivateChain(roomChain(room));
    liveChecked.set(room, failed);
    return failed;
  };
  const syncUnsafe = (room: string) => !validTarget(binding, room, room) || !deliveryAllowed(binding, room);
  for (const row of rows) {
    const source = normalized(row.source_channel);
    const destination = normalized(row.reply_channel);
    if (syncUnsafe(source) || syncUnsafe(destination) || await liveFailed(source) || await liveFailed(destination)) {
      unsafe.add(source);
      unsafe.add(destination);
    }
  }
  if (unsafe.size) {
    let changed = false;
    db.transaction(() => {
      for (const row of rows) {
        const source = normalized(row.source_channel);
        const destination = normalized(row.reply_channel);
        if (!unsafe.has(source) && !unsafe.has(destination)) continue;
        const current = db.query("SELECT status,revision FROM agent_session_requests WHERE id=? AND binding_id=?").get(row.id, binding.id) as { status: string; revision: number } | null;
        // A newer revision means an edit landed during the probe: leave it for the next pass.
        if (!current || current.revision !== row.revision) continue;
        if (["replied","failed","cancelled","uncertain"].includes(current.status)) continue;
        // Re-evaluate synchronously: if the room is safe again and the live probe never failed it, skip.
        if (!syncUnsafe(source) && liveChecked.get(source) !== true && !syncUnsafe(destination) && liveChecked.get(destination) !== true) continue;
        const cancellable = ["pending","offered","needs_confirmation"].includes(current.status);
        const allowed = cancellable ? "('pending','offered','needs_confirmation')" : "('accepted','replying','failing')";
        const result = db.query(`UPDATE agent_session_requests SET status=?,text='',context='[]',confirm_revision=NULL,updated_at=?
          WHERE id=? AND binding_id=? AND revision=? AND status IN ${allowed}`)
          .run(cancellable ? "cancelled" : "uncertain", Date.now(), row.id, binding.id, current.revision);
        if (result.changes) changed = true;
      }
    })();
    if (changed) wakeAgent(binding.id);
  }
  return unsafe;
}

// Full live proof across the room and every thread ancestor. The transport's joined-room state is
// necessary but not sufficient: an ancestor mode change is only observable by re-probing Ergo.
async function deliveryChainLive(binding: Binding, channel: string): Promise<boolean> {
  const room = normalized(channel);
  if (!validTarget(binding, room, room) || !deliveryAllowed(binding, room)) return false;
  // An owner-only open/workspace room has no private flags to re-probe; its grant is rechecked in
  // deliveryAllowed above. Private rooms still need the full live +s/+i chain.
  return runtimes.get(binding.id)?.rooms.get(room)?.publicRoom ? true : verifyPrivateChain(roomChain(room));
}

export async function acceptRequest(binding: Binding, leaseId: string, id: string, revision: number): Promise<any | null> {
  if (!validLease(binding, leaseId)) return null;
  // One unresolved accepted/executing request per binding. Siblings bind to their own binding id
  // and are unaffected; additional work stays server-side offered until the active one is terminal.
  if (hasActiveRequest(binding.id)) return null;
  const probe = db.query("SELECT source_channel,current_msgid FROM agent_session_requests WHERE id=? AND binding_id=?").get(id, binding.id) as { source_channel: string; current_msgid: string } | null;
  if (!probe || !await deliveryChainLive(binding, probe.source_channel)) return null;
  // A mention in a room carries what was said there since the agent last replied. An edit during
  // this await bumps the revision, so the transaction below refuses the stale context.
  const context = await requestContext(binding, probe.source_channel, probe.current_msgid);
  const now = Date.now();
  const row = db.transaction(() => {
    // Revalidate after the awaited live probes: a lease that expired, was revoked, or was replaced
    // mid-check must not accept, and neither must a binding whose immutable accounts are gone.
    if (!validLease(binding, leaseId)) return null;
    if (!authorizedBindingById(binding.id)) return null;
    if (hasActiveRequest(binding.id)) return null;
    const request = db.query("SELECT * FROM agent_session_requests WHERE id=? AND binding_id=?").get(id,binding.id) as any;
    if (!request || request.revision !== revision || !["offered","needs_confirmation"].includes(request.status)) return null;
    if (request.status === "needs_confirmation" && request.confirm_revision !== revision) return null;
    if (!validTarget(binding, request.source_channel, request.reply_channel)) return null;
    if (!deliveryAllowed(binding, request.source_channel) || !deliveryAllowed(binding, request.reply_channel)) return null;
    if (request.current_msgid !== probe.current_msgid) return null;
    const result = db.query(`UPDATE agent_session_requests SET status='accepted',lease_id=?,context=?,updated_at=? WHERE id=? AND revision=? AND status=?`)
      .run(leaseId, JSON.stringify(context), now, id, revision, request.status);
    return result.changes ? request : null;
  })();
  if (!row) return null;
  startTyping(binding, row.id, row.reply_channel);
  // Only the owner can author a request, so the author is the owner's nick.
  return { id: row.id, revision, source: row.source_channel, destination: row.reply_channel, author: binding.owner_nick, text: row.text, context };
}

// Only the accepting live Pi lease may acknowledge a native start. This does not change the
// delivery state machine or make uncertain work eligible for replay.
export function startRequest(binding: Binding, leaseId: string, id: string): boolean {
  if (binding.harness !== "pi" || !validLease(binding, leaseId) || !authorizedBindingById(binding.id)) return false;
  const row = db.query("SELECT source_channel,reply_channel FROM agent_session_requests WHERE id=? AND binding_id=?").get(id, binding.id) as { source_channel: string; reply_channel: string } | null;
  if (!row || !validTarget(binding, row.source_channel, row.reply_channel) || !deliveryAllowed(binding, row.reply_channel)) return false;
  const result = db.query(`UPDATE agent_session_requests SET started_at=COALESCE(started_at,?),updated_at=?
    WHERE id=? AND binding_id=? AND lease_id=? AND status='accepted'`).run(Date.now(), Date.now(), id, binding.id, leaseId);
  if (result.changes) wakeAgent(binding.id);
  return !!result.changes;
}

// Active = accepted but not yet terminal (replied/failed/cancelled/uncertain).
function hasActiveRequest(bindingId: string): boolean {
  return !!db.query("SELECT 1 FROM agent_session_requests WHERE binding_id=? AND status IN ('accepted','replying','failing') LIMIT 1").get(bindingId);
}

// Classify a refused accept for the adapter so a busy sibling stays eligible instead of being
// poisoned as uncertain. This is advisory: the transaction above is the authoritative gate.
export function acceptRefusal(binding: Binding, id: string, revision: number): "busy" | "stale" {
  const request = db.query("SELECT status,revision FROM agent_session_requests WHERE id=? AND binding_id=?").get(id, binding.id) as { status: string; revision: number } | null;
  if (hasActiveRequest(binding.id) && request && request.revision === revision && ["offered", "needs_confirmation"].includes(request.status)) return "busy";
  return "stale";
}

// One explicit startup reset, called only from the app entrypoint. A new process is a continuity
// gap: leases are dropped and every unaccepted/in-flight request becomes a content-free uncertainty
// record. Never call this as an import side effect. Terminal rows are untouched.
export function resetAgentSessionState(now = Date.now()): void {
  db.transaction(() => {
    // A session attached when the process stopped is detached now: its offline notice is owed unless it reattaches within the grace period.
    db.query("UPDATE agent_session_bindings SET away_since=COALESCE(away_since, ?) WHERE status='ready' AND lease_id IS NOT NULL").run(now);
    db.query("UPDATE agent_session_bindings SET lease_id=NULL,lease_nonce=NULL,lease_expires_at=NULL WHERE status='ready'").run();
    db.query(`UPDATE agent_session_requests SET status='uncertain', text='', context='[]', confirm_revision=NULL, updated_at=?
      WHERE status IN ('pending','offered','needs_confirmation','accepted','replying','failing')`).run(now);
  })();
}

export function validTarget(binding: Binding, source: string, destination: string): boolean {
  const room = normalized(source);
  if (room !== normalized(destination)) return false;
  const info = channelInfo(room);
  if (!info && !isOpenChannel(room)) return false;
  // A direct room is only valid when it is this binding's real DM; a name starting `#dm-` proves nothing.
  if (info?.visibility === "direct" && room !== normalized(binding.dm || "")) return false;
  if (!agentCanReadChannel(binding.nick, room)) return false;
  // Owner-only attachments stay tied to the owner's own access: open rooms are readable by all,
  // workspace rooms need the owner's membership, and private rooms keep the agent's rules.
  if (isOpenChannel(room)) return true;
  if (info?.visibility === "workspace") return isMember(binding.owner_nick, room);
  return agentCanReadChannel(binding.owner_nick, room);
}

// Ergo's multiline max-bytes (4096 in every Slirc config): a larger batch is refused whole. Each
// reply line is cut to fit Ergo's 512-byte line (see shared/multiline.ts) and the echo is matched
// against those same parts.
export const MAX_REPLY_BYTES = 4_000;
export const replyParts = (text: string, target: string): { text: string; concat: boolean }[] => wireParts(text, target);

async function submitRequestText(binding: Binding, leaseId: string, id: string, text: string, failing = false, hold: (until: Promise<unknown>) => void = () => {}): Promise<string> {
  if (!validLease(binding, leaseId)) throw new Error("session lease expired");
  if (!text.trim() || /[\0\r]/.test(text)) throw new Error("reply text is invalid");
  // Validate wire shape before reserving so a reserved reply is exactly what will be sent.
  if (text.split("\n").length > 30 || Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES) throw new Error(`reply is too long: at most 30 lines and ${MAX_REPLY_BYTES} bytes`);
  const request = db.query("SELECT source_channel,reply_channel FROM agent_session_requests WHERE id=? AND binding_id=?").get(id, binding.id) as { source_channel: string; reply_channel: string } | null;
  if (!request) throw new Error("request is not accepted by this session");
  // Fixed destination: the recorded reply channel when still authorized, otherwise the owner DM for
  // an explicit failure. Every candidate is re-proved live (room plus ancestors) before sending.
  const replyOk = validTarget(binding, request.source_channel, request.reply_channel) && deliveryAllowed(binding, request.reply_channel);
  const destination = replyOk ? request.reply_channel : failing && binding.dm ? binding.dm : "";
  if (!destination || !await deliveryChainLive(binding, destination)) throw new Error("reply destination is no longer authorized");
  const runtime = runtimes.get(binding.id);
  // Capability and limits are enforced before any reservation or socket write.
  if (!runtime?.client.enabledCapabilities.has("echo-message")) throw new Error("reply transport unavailable");
  const parts = replyParts(text, destination);
  if (parts.length > 1 && !runtime.client.enabledCapabilities.has("draft/multiline")) throw new Error("multiline replies are not supported by this IRC connection");
  const batch = parts.length > 1 ? `m-${crypto.randomUUID().slice(0, 8)}` : "";
  // Before an uncertain reply is resent, look for the first send in the room by its reply_cid. Ergo
  // may have stored it while only the echo match failed; resending would post it twice.
  const prior = db.query("SELECT status,reply_cid,reply_text,reply_channel FROM agent_session_requests WHERE id=? AND binding_id=?").get(id, binding.id) as
    { status: string; reply_cid: string | null; reply_text: string | null; reply_channel: string } | null;
  if (prior?.status === "uncertain" && prior.reply_cid && prior.reply_text === text) {
    const found = await historyByCid(runtime, prior.reply_channel, prior.reply_cid);
    if (!found.checked) throw new Error("reply outcome is uncertain and room history could not be checked; try again");
    if (found.msgid) {
      const landed = db.query(`UPDATE agent_session_requests SET status=?,reply_msgid=?,reply_batch=NULL,updated_at=? WHERE id=? AND binding_id=? AND status='uncertain' AND reply_cid=?`)
        .run(failing ? "failed" : "replied", found.msgid, Date.now(), id, binding.id, prior.reply_cid);
      if (landed.changes) { wakeAgent(binding.id); return failing ? "failed" : "replied"; }
    }
  }
  const reserved = db.transaction(() => {
    // Same post-await revalidation as accept: no send for a stale/revoked/replaced lease or binding.
    if (!validLease(binding, leaseId)) throw new Error("session lease expired");
    if (!authorizedBindingById(binding.id)) throw new Error("binding is no longer authorized");
    const row = db.query("SELECT * FROM agent_session_requests WHERE id=? AND binding_id=?").get(id,binding.id) as any;
    if (!row) throw new Error("request is not accepted by this session");
    // An uncertain reply keeps its text and reply_cid. The same text is resent under that same cid,
    // from any current lease: the agent already answered, so it is not rerun.
    const retry = row.status === "uncertain" && !!row.reply_cid;
    if (row.reply_cid) {
      if (row.reply_text !== text) throw new Error("request already has a different reply");
      if (!retry) return { row, send: false };
    } else if (row.lease_id !== leaseId || row.status !== "accepted") throw new Error("request is not accepted by this session");
    const chosen = validTarget(binding, row.source_channel, row.reply_channel) ? row.reply_channel : failing && binding.dm ? binding.dm : "";
    if (chosen !== destination || !deliveryAllowed(binding, destination)) throw new Error("reply destination is no longer authorized");
    const cid = row.reply_cid || crypto.randomUUID();
    const result = db.query(`UPDATE agent_session_requests SET status=?,lease_id=?,reply_channel=?,reply_text=?,reply_cid=?,reply_batch=?,reply_line_count=?,reply_echo_count=0,reply_echo_msgids='[]',updated_at=? WHERE id=? AND status=?`)
      .run(failing ? "failing" : "replying", leaseId, destination, text, cid, batch || null, parts.length, Date.now(), id, row.status);
    if (!result.changes) throw new Error("request is not accepted by this session");
    return { row: { ...row, reply_channel: destination, reply_cid: cid, reply_batch: batch || null, reply_line_count: parts.length }, send: true };
  })();
  if (!reserved.send) return reserved.row.status;
  const { row } = reserved;
  stopTyping(runtime, id);
  // The room stays held until the echo, so a message queued after this one lands after it.
  hold(awaitEcho(runtime, row.reply_cid));
  let sent = true;
  if (batch) sent = runtime.client.send(`@+slirc/cid=${row.reply_cid} BATCH +${batch} draft/multiline ${row.reply_channel}`);
  for (const part of parts) {
    const tags = `+slirc/cid=${row.reply_cid}${batch ? `;batch=${batch}` : ""}${part.concat ? ";draft/multiline-concat" : ""}`;
    sent = runtime.client.send(`@${tags} PRIVMSG ${row.reply_channel} :${part.text}`) && sent;
  }
  if (batch) sent = runtime.client.send(`BATCH -${batch}`) && sent;
  if (!sent) {
    runtime.posts.get(row.reply_cid)?.("");
    db.query("UPDATE agent_session_requests SET status='uncertain',updated_at=? WHERE id=? AND status IN ('replying','failing')").run(Date.now(), id);
    wakeAgent(binding.id);
    throw new Error("reply outcome is uncertain; it will not be resent");
  }
  setTimeout(() => {
    const result = db.query(`UPDATE agent_session_requests SET status='uncertain',updated_at=? WHERE id=? AND status IN ('replying','failing')`).run(Date.now(), id);
    if (result.changes) wakeAgent(binding.id);
  }, transportTimers.echoTimeoutMs).unref?.();
  return failing ? "failing" : "replying";
}

// Messages from one binding to one room go out one at a time, in the order their calls arrived:
// each is written to IRC only after the one before it echoed or timed out. The room is read
// synchronously on arrival, before any await, so two HTTP calls at once keep their order.
const roomOutbox = new Map<string, Promise<void>>();
// A task may hold the room past its own return with `hold`: a reply answers its caller at once
// but keeps the room until its echo.
function inRoomOrder<T>(binding: Binding, id: string, task: (hold: (until: Promise<unknown>) => void) => Promise<T>): Promise<T> {
  const row = db.query("SELECT reply_channel FROM agent_session_requests WHERE id=? AND binding_id=?").get(id, binding.id) as { reply_channel: string } | null;
  const key = `${binding.id}\n${row ? normalized(row.reply_channel) : `request:${id}`}`;
  let held: Promise<unknown> = Promise.resolve();
  const run = (roomOutbox.get(key) ?? Promise.resolve()).then(() => task((until) => { held = until; }));
  const tail = run.then(() => held, () => held).then(() => {}, () => {});
  roomOutbox.set(key, tail);
  void tail.then(() => { if (roomOutbox.get(key) === tail) roomOutbox.delete(key); });
  return run;
}

// Resolves with the msgid of our own line or multiline opener carrying this cid once it echoes, or
// "" after a short timeout.
function awaitEcho(runtime: Runtime, cid: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(""), Math.min(transportTimers.roomHoldMs, transportTimers.echoTimeoutMs));
    runtime.posts.set(cid, (msgid) => { clearTimeout(timer); resolve(msgid); });
  }).finally(() => runtime.posts.delete(cid));
}

export function replyToRequest(binding: Binding, leaseId: string, id: string, text: string): Promise<string> {
  return inRoomOrder(binding, id, (hold) => submitRequestText(binding, leaseId, id, text, false, hold));
}

export function failRequest(binding: Binding, leaseId: string, id: string, reason: string): Promise<string> {
  const clean = reason.replace(/[\r\n\0]+/g, " ").slice(0, 500).trim() || "The agent could not complete this request.";
  return inRoomOrder(binding, id, (hold) => submitRequestText(binding, leaseId, id, `Slirc request failed: ${clean}`, true, hold));
}

export function confirmOfflineRequest(binding: Binding, id: string, revision: number): boolean {
  // Exact current revision and current source/destination/ancestor access, or no confirmation.
  const row = db.query(`SELECT source_channel,reply_channel,revision FROM agent_session_requests
    WHERE id=? AND binding_id=? AND author_account_id=? AND status='needs_confirmation'`)
    .get(id, binding.id, binding.owner_account_id) as { source_channel: string; reply_channel: string; revision: number } | null;
  if (!row || row.revision !== revision) return false;
  if (!validTarget(binding, row.source_channel, row.reply_channel)) return false;
  if (!deliveryAllowed(binding, row.source_channel) || !deliveryAllowed(binding, row.reply_channel)) return false;
  const result = db.query(`UPDATE agent_session_requests SET confirm_revision=?,status='offered',updated_at=?
    WHERE id=? AND binding_id=? AND status='needs_confirmation' AND revision=? AND author_account_id=?`)
    .run(revision, Date.now(), id, binding.id, revision, binding.owner_account_id);
  return result.changes > 0;
}

// The room of a request this session accepted, for extra messages and deletions. It is the
// request's fixed reply room, re-proved live like a reply; nothing else is reachable. An active
// request needs the lease that accepted it; an answered one stays open to follow-ups from the
// session's current lease.
async function requestRoom(binding: Binding, leaseId: string, id: string): Promise<{ room: string; runtime: Runtime }> {
  if (!validLease(binding, leaseId)) throw new Error("session lease expired");
  const row = db.query("SELECT source_channel,reply_channel,status,lease_id FROM agent_session_requests WHERE id=? AND binding_id=?").get(id, binding.id) as
    { source_channel: string; reply_channel: string; status: string; lease_id: string | null } | null;
  const open = !!row && ["accepted", "replying", "replied"].includes(row.status) && (row.status !== "accepted" || row.lease_id === leaseId);
  if (!row || !open) throw new Error("request is not accepted or answered by this session");
  if (!validTarget(binding, row.source_channel, row.reply_channel) || !deliveryAllowed(binding, row.reply_channel) || !await deliveryChainLive(binding, row.reply_channel)) {
    throw new Error("request room is no longer authorized");
  }
  if (!validLease(binding, leaseId) || !authorizedBindingById(binding.id)) throw new Error("session lease expired");
  const runtime = runtimes.get(binding.id);
  if (!runtime?.client.enabledCapabilities.has("echo-message")) throw new Error("message transport unavailable");
  return { room: row.reply_channel, runtime };
}

// One more message to a request's room: part of a long answer, before or after slirc_reply, or a
// follow-up once it is answered. It never changes the request's state. It waits its turn in the room
// (see inRoomOrder). Resolves with the echoed msgid, so the agent can delete it later.
export function sendToRequest(binding: Binding, leaseId: string, id: string, text: string): Promise<{ status: "sent" | "uncertain"; messageId: string | null }> {
  return inRoomOrder(binding, id, () => sendInRoom(binding, leaseId, id, text));
}

async function sendInRoom(binding: Binding, leaseId: string, id: string, text: string): Promise<{ status: "sent" | "uncertain"; messageId: string | null }> {
  if (!text.trim() || /[\0\r]/.test(text)) throw new Error("message text is invalid");
  if (text.split("\n").length > 30 || Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES) throw new Error(`message is too long: at most 30 lines and ${MAX_REPLY_BYTES} bytes`);
  const { room, runtime } = await requestRoom(binding, leaseId, id);
  const parts = replyParts(text, room);
  if (parts.length > 1 && !runtime.client.enabledCapabilities.has("draft/multiline")) throw new Error("multiline messages are not supported by this IRC connection");
  if (runtime.posts.size >= 8) throw new Error("too many messages waiting for Slirc; wait for the last one");
  const cid = crypto.randomUUID();
  const batch = parts.length > 1 ? `m-${cid.slice(0, 8)}` : "";
  const echoed = awaitEcho(runtime, cid);
  let sent = true;
  if (batch) sent = runtime.client.send(`@+slirc/cid=${cid} BATCH +${batch} draft/multiline ${room}`);
  for (const part of parts) {
    const tags = `+slirc/cid=${cid}${batch ? `;batch=${batch}` : ""}${part.concat ? ";draft/multiline-concat" : ""}`;
    sent = runtime.client.send(`@${tags} PRIVMSG ${room} :${part.text}`) && sent;
  }
  if (batch) sent = runtime.client.send(`BATCH -${batch}`) && sent;
  if (!sent) { runtime.posts.get(cid)?.(""); throw new Error("message outcome is uncertain; check slirc_history before sending it again"); }
  const messageId = await echoed;
  return { status: messageId ? "sent" : "uncertain", messageId: messageId || null };
}

// Deletes one of this agent's own messages in a request's room. Ergo's history must show the
// agent as the sender: an agent may hold op in its rooms, so Ergo's own check is not enough.
export async function deleteOwnMessage(binding: Binding, leaseId: string, id: string, messageId: string): Promise<"deleted" | "gone"> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(messageId)) throw new Error("invalid message id");
  const { room, runtime } = await requestRoom(binding, leaseId, id);
  const { items, complete } = await queryHistory(runtime, room, `msgid=${messageId}`, 3, "AROUND");
  const found = items.find((entry) => entry.messageId === messageId);
  if (!found) throw new Error(complete ? "no such message in this request's room" : "room history did not answer; try again");
  if (found.nick.toLowerCase() !== binding.nick.toLowerCase()) throw new Error("an agent can delete only its own messages");
  if (!validLease(binding, leaseId) || !authorizedBindingById(binding.id)) throw new Error("session lease expired");
  if (runtime.deletions.has(messageId)) throw new Error("this message is already being deleted");
  const outcome = new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve("REDACT was not confirmed"), Math.min(5_000, transportTimers.echoTimeoutMs));
    runtime.deletions.set(messageId, (failure) => { clearTimeout(timer); resolve(failure); });
  }).finally(() => runtime.deletions.delete(messageId));
  if (!runtime.client.send(`REDACT ${room} ${messageId}`)) runtime.deletions.get(messageId)?.("message transport unavailable");
  const failure = await outcome;
  if (failure === "gone") return "gone";
  if (failure) throw new Error(`could not delete the message: ${failure}`);
  return "deleted";
}
