// Channel membership and invite links. Membership is the single dynamic
// source of truth for which rooms a user sees in the PWA; Ergo's ChanServ
// access list enforces it on the protocol side.

import { createHash } from "node:crypto";
import { configuredOpenChannels, contactHelpers } from "./config.ts";
import { HELPER_NICKS } from "../shared/service-bots.ts";
import { db } from "./db.ts";

// Channels open to every account — no membership row, no ChanServ access needed.
// Validation runs at module load, so a private instance with a public channel list fails on boot.
export const openChannels: string[] = configuredOpenChannels(process.env.OPEN_CHANNELS);

export function normalized(channel: string): string {
  return channel.trim().toLowerCase();
}

export function isOpenChannel(channel: string): boolean {
  return openChannels.includes(normalized(channel));
}

export function isMember(nick: string, channel: string): boolean {
  if (unreadyDirect(channel)) return false;
  if (isOpenChannel(channel)) return true;
  // A thread grant means nothing without the parent: someone kicked from or leaving a channel must
  // not keep reading its threads through a leftover child row.
  const thread = db.query("SELECT parent FROM threads WHERE channel = ?").get(normalized(channel)) as { parent: string } | null;
  if (thread && normalized(thread.parent) !== normalized(channel) && !isMember(nick, thread.parent)) return false;
  return !!db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ?")
    .get(normalized(channel), nick);
}

// Thread children of a channel with their own visibility, for cascading membership and mode changes.
export function threadChildren(parent: string): { channel: string; visibility: string }[] {
  return db.query(`SELECT t.channel, COALESCE(c.visibility, 'secret') AS visibility FROM threads t
    LEFT JOIN channels c ON c.channel = t.channel WHERE t.parent = ?`).all(normalized(parent)) as { channel: string; visibility: string }[];
}

export type ChannelInfo = { channel: string; owner: string; visibility: "workspace" | "secret" | "direct"; topic: string; archived: boolean; isGroup: boolean };
export type DirectConversation = { channel: string; nick: string };

function unreadyDirect(channel: string): boolean {
  return !!db.query("SELECT 1 FROM direct_conversations WHERE channel = ? AND provision_ready IS NOT 1").get(normalized(channel));
}

export function memberChannels(nick: string): string[] {
  const rows = db.query("SELECT channel FROM channel_members WHERE nick = ?").all(nick) as { channel: string }[];
  return [...new Set([...openChannels, ...rows.map((row) => row.channel)])].filter((channel) => !unreadyDirect(channel));
}

// An agent attached to an open or workspace room is owner-only; the attach routes always write this
// flag for those rooms, so a missing or cleared flag fails closed rather than opening a public trigger.
export function agentOwnerOnlyGrant(nick: string, channel: string): boolean {
  return !!db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ? AND owner_only = 1").get(normalized(channel), nick);
}

// Agent discovery is narrower than human discovery. Every thread ancestor must also be
// private and readable; a leftover child grant must not expose a now-public parent. Open and
// workspace rooms are readable only through an owner-only attachment, never through mere presence.
export function agentCanReadChannel(nick: string, channel: string): boolean {
  const seen = new Set<string>();
  let current = normalized(channel);
  while (!seen.has(current)) {
    seen.add(current);
    const info = channelInfo(current);
    if (isOpenChannel(current) || info?.visibility === "workspace") {
      if (!agentOwnerOnlyGrant(nick, current)) return false;
    } else if (!info || !["secret", "direct"].includes(info.visibility) || !isMember(nick, current)) return false;
    const thread = db.query("SELECT parent FROM threads WHERE channel = ?").get(current) as { parent: string } | null;
    if (!thread) return true;
    current = normalized(thread.parent);
  }
  return false;
}

export function directConversations(nick: string): DirectConversation[] {
  return db.query(`SELECT pair.channel, pair.nick FROM (
                     SELECT channel, CASE WHEN first_nick = ? THEN second_nick ELSE first_nick END AS nick
                     FROM direct_conversations WHERE provision_ready = 1 AND (first_nick = ? OR second_nick = ?)
                   ) pair JOIN accounts self ON self.nick = ? COLLATE NOCASE
                     JOIN accounts peer ON peer.nick = pair.nick COLLATE NOCASE
                     LEFT JOIN closed_direct_conversations closed ON closed.account_id = self.account_id AND closed.channel = pair.channel
                   WHERE closed.channel IS NULL ORDER BY pair.channel`)
    .all(nick, nick, nick, nick) as DirectConversation[];
}

// Close state belongs to one immutable account identity, never to the shared pair or channel.
export function closeDirectConversation(accountId: string, nick: string, other: string): boolean {
  const [first, second] = directPair(nick, other);
  const row = db.query("SELECT channel FROM direct_conversations WHERE first_nick = ? AND second_nick = ?").get(first, second) as { channel: string } | null;
  if (!row) return false;
  db.query("INSERT INTO closed_direct_conversations (account_id, channel) VALUES (?, ?) ON CONFLICT DO NOTHING").run(accountId, row.channel);
  return true;
}

export function reopenDirectConversation(accountId: string, channel: string): void {
  db.query("DELETE FROM closed_direct_conversations WHERE account_id = ? AND channel = ?").run(accountId, normalized(channel));
}

// A new message reopens a closed DM for both people, as in Slack. Returns the pair's nicks so their
// open tabs can refresh; a channel that is not a live pair returns none and changes nothing.
export function reopenDirectOnMessage(channel: string): string[] {
  const row = db.query("SELECT first_nick, second_nick FROM direct_conversations WHERE channel = ? AND provision_ready = 1")
    .get(normalized(channel)) as { first_nick: string; second_nick: string } | null;
  if (!row) return [];
  db.query("DELETE FROM closed_direct_conversations WHERE channel = ?").run(normalized(channel));
  return [row.first_nick, row.second_nick];
}

// Ergo runs `casemapping: ascii`, so fold only A-Z. A Unicode toLowerCase() would split a
// pair from the row it already owns on a non-ASCII nick.
export function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

// Canonical pair key: ASCII-folded, sorted, so (B,A) and (b,a) resolve to one row.
export function directPair(nick: string, other: string): [string, string] {
  return [asciiFold(nick), asciiFold(other)].sort() as [string, string];
}

// A DM channel must hold exactly its two people. Extra members mean a legacy row was shared
// (truncation or delimiter collision merged two pairs), so reuse would leak one pair's history
// to the other. Refuse and name the repair; never rename or delete history automatically.
function assertPairOnly(channel: string, first: string, second: string): void {
  const allowed = new Set([first, second]);
  const extras = (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[])
    .map((row) => row.nick).filter((nick) => !allowed.has(asciiFold(nick)));
  if (extras.length) throw new Error(
    `DM channel ${channel} belongs to ${first}/${second} but also has members: ${extras.join(", ")}. ` +
    `Refusing to reuse it, rename it, or delete history. Repair: remove the extra members from ${channel} ` +
    `(channel_members plus the Ergo +I list or a kick), then reopen the DM.`,
  );
}

export function directConversation(nick: string, other: string): DirectConversation | null {
  const [first, second] = directPair(nick, other);
  const row = db.query("SELECT channel FROM direct_conversations WHERE first_nick = ? AND second_nick = ?").get(first, second) as { channel: string } | null;
  if (!row) return null;
  assertPairOnly(row.channel, first, second);
  if (unreadyDirect(row.channel)) return null;
  return { channel: row.channel, nick: other };
}

export async function deleteDirectConversation(nick: string, other: string, unregister: (channel: string) => Promise<void>, clearHistory?: (channel: string) => Promise<void>): Promise<boolean> {
  // Raw lookup, not directConversation(): explicit deletion is the escape hatch for a
  // contaminated mapping, so it must not be blocked by the fail-closed reuse check.
  const [first, second] = directPair(nick, other);
  const row = db.query("SELECT channel FROM direct_conversations WHERE first_nick = ? AND second_nick = ?").get(first, second) as { channel: string } | null;
  if (!row) return false;
  // Drop the pair mapping before the slow channel teardown. The mapping is what /auth/me uses to
  // authorize the DM, so removing it first stops a reopen or reconnect from re-adding the row while
  // history is still being cleared. The channel name is already resolved, so the teardown does not
  // need the mapping.
  db.query("DELETE FROM direct_conversations WHERE channel = ?").run(row.channel);
  await deleteChannelTree(row.channel, unregister, clearHistory);
  return true;
}

// Already spoken for by another pair's stored row, or by a non-DM room whose name we must not
// graft onto. A leftover `direct` row without a pair mapping is this pair's own orphan (readable
// names are injective, hashed names pair-unique); it can be adopted, so it does not block.
function channelTaken(channel: string, first: string, second: string): boolean {
  const row = db.query("SELECT first_nick, second_nick FROM direct_conversations WHERE channel = ?").get(channel) as { first_nick: string; second_nick: string } | null;
  if (row) return row.first_nick !== first || row.second_nick !== second;
  const room = db.query("SELECT visibility FROM channels WHERE channel = ?").get(channel) as { visibility: string } | null;
  return !!room && room.visibility !== "direct";
}

// Readable `#dm-first-second` only when both nicks lack the `-` delimiter and the join fits IRC's
// 63 chars. Anything else goes to `#dm-` + 56 hex of JSON.stringify(sorted pair): no hyphen after
// the prefix, so the hashed namespace cannot collide with a readable name, and distinct pairs hash
// apart. The hash is only the wire name; SQLite still stores the pair.
function directChannelCandidate(first: string, second: string): string {
  const plain = `#dm-${first}-${second}`;
  if (!first.includes("-") && !second.includes("-") && plain.length <= 63 && !channelTaken(plain, first, second)) return plain;
  return `#dm-${hash(JSON.stringify([first, second])).slice(0, 56)}`;
}

export function directChannelName(nick: string, other: string): string {
  const [first, second] = directPair(nick, other);
  const existing = db.query("SELECT channel FROM direct_conversations WHERE first_nick = ? AND second_nick = ?").get(first, second) as { channel: string } | null;
  const channel = existing?.channel || directChannelCandidate(first, second);
  // Callers provision Ergo before inserting the mapping. Validate here too, before any grants.
  if (channelTaken(channel, first, second)) throw new Error(`DM channel ${channel} already exists for another room or pair; refusing access.`);
  assertPairOnly(channel, first, second);
  return channel;
}

// The default publishes metadata after the caller has confirmed Ergo provisioning. Reservations
// use false and stay unreadable, even though their stable pair and membership rows already exist.
export function createDirectConversation(nick: string, other: string, owner: string, provisioned = true): DirectConversation {
  const [first, second] = directPair(nick, other);
  const existing = db.query("SELECT channel FROM direct_conversations WHERE first_nick = ? AND second_nick = ?").get(first, second) as { channel: string } | null;
  if (existing) {
    assertPairOnly(existing.channel, first, second);
    if (provisioned) db.query("UPDATE direct_conversations SET provision_ready = 1 WHERE channel = ?").run(existing.channel);
    else db.query("UPDATE direct_conversations SET provision_ready = 0 WHERE channel = ? AND provision_ready IS NULL").run(existing.channel);
    return { channel: existing.channel, nick: other };
  }
  const channel = directChannelCandidate(first, second);
  // Every refusal happens before the transaction, so a failed call leaves no channel row and no
  // membership behind, and one pair's channel can never be inherited by another.
  if (db.query("SELECT 1 FROM direct_conversations WHERE channel = ?").get(channel)) {
    throw new Error(`DM channel ${channel} is already mapped to another pair; refusing to reuse it for ${first}/${second}.`);
  }
  const room = db.query("SELECT visibility FROM channels WHERE channel = ?").get(channel) as { visibility: string } | null;
  if (room && room.visibility !== "direct") throw new Error(`Channel ${channel} already exists as a ${room.visibility} room; refusing to reuse it for the ${first}/${second} DM. Repair: remove or rename that room first.`);
  // An orphan direct row is this pair's own channel (a crash between the Ergo grant and the row
  // write); adopt it only if it truly holds the pair and nobody else.
  if (room) assertPairOnly(channel, first, second);
  const createdAt = Date.now();
  db.transaction(() => {
    db.query("INSERT INTO direct_conversations (channel, first_nick, second_nick, provision_ready) VALUES (?, ?, ?, ?)").run(channel, first, second, provisioned ? 1 : 0);
    if (!room) db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES (?, ?, 'direct', ?, ?)")
      .run(channel, owner, `Direct message: ${first} ↔ ${second}`, createdAt);
    for (const member of [first, second]) {
      if (!db.query("SELECT 1 FROM channel_members WHERE channel = ? AND nick = ?").get(channel, member)) {
        db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?)").run(channel, member);
      }
    }
  })();
  return { channel, nick: other };
}

// Admins are public contacts for verified members; verified human admins can contact
// every verified human. This grants discovery, never access to someone else's rooms.
const ADMIN_DISCOVERY_SQL = `EXISTS (SELECT 1 FROM accounts sender
  WHERE sender.nick = ? COLLATE NOCASE AND sender.kind = 'human' AND sender.verified_at IS NOT NULL
    AND (sender.role = 'admin' OR a.role = 'admin'))`;

// Configured open channels (#open-chat, #help) keep no `channels` row, so the workspace join
// alone would miss the room newcomers actually meet in. Bind the names; evidence rows are only
// ever written for public channels, so this re-check stays cheap.
const OPEN_CHANNEL_EVIDENCE_SQL = openChannels.length
  ? `evidence.channel IN (${openChannels.map(() => "?").join(", ")})`
  : "0";

// Contacts are relationships. Sharing or posting in an open channel (#open-chat, #help) is only
// discovery: search and a deliberate DM still reach that person, but they never land in Contacts,
// where one tap opens a DM that the other side sees too. A live DM pair is a relationship in either
// direction and stays one after either side closes it, so the person can be messaged again later.
const NOT_OPEN_CHANNEL_SQL = (column: string) => openChannels.length
  ? `${column} NOT IN (${openChannels.map(() => "?").join(", ")})`
  : "1";

// Helper nicks are constants, never input. A shared channel never makes one a contact; help and
// remind are added for everyone, and only where they run.
const HELPER_LIST_SQL = HELPER_NICKS.map((helper) => `'${helper}'`).join(", ");
export function sharedContacts(nick: string): string[] {
  const helpers = contactHelpers();
  const helperUnion = helpers.length ? `UNION SELECT a.nick FROM accounts a WHERE a.kind = 'bot' AND a.nick COLLATE NOCASE IN (${helpers.map(() => "?").join(", ")})` : "";
  return (db.query(`SELECT DISTINCT other.nick
                    FROM channel_members mine
                    JOIN channel_members other ON other.channel = mine.channel
                    JOIN channels channel ON channel.channel = mine.channel
                    LEFT JOIN accounts account ON account.nick = other.nick COLLATE NOCASE
                    WHERE mine.nick = ? AND other.nick <> ? AND channel.visibility <> 'direct' AND ${NOT_OPEN_CHANNEL_SQL("channel.channel")}
                      AND lower(other.nick) NOT IN (${HELPER_LIST_SQL})
                    UNION SELECT author.nick FROM public_author_evidence evidence
                    JOIN channels public_room ON public_room.channel = evidence.channel
                    JOIN accounts author ON author.account_id = evidence.account_id
                    WHERE author.nick <> ? COLLATE NOCASE AND author.kind = 'human' AND author.verified_at IS NOT NULL
                      AND public_room.visibility = 'workspace' AND public_room.archived_at IS NULL AND ${NOT_OPEN_CHANNEL_SQL("public_room.channel")}
                    UNION SELECT a.nick FROM accounts a
                    WHERE a.nick <> ? COLLATE NOCASE AND a.kind = 'human' AND a.verified_at IS NOT NULL
                      AND ${ADMIN_DISCOVERY_SQL}
                    UNION SELECT peer.nick FROM direct_conversations d
                    JOIN channels dc ON dc.channel = d.channel AND dc.visibility = 'direct' AND dc.archived_at IS NULL
                    JOIN accounts peer ON peer.nick = (CASE WHEN d.first_nick = ? THEN d.second_nick ELSE d.first_nick END) COLLATE NOCASE
                    WHERE d.provision_ready = 1 AND (d.first_nick = ? OR d.second_nick = ?)
                      AND peer.kind = 'human' AND peer.verified_at IS NOT NULL
                      AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel = d.channel) = 2
                      AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel = d.channel AND m.nick IN (d.first_nick, d.second_nick)) = 2
                    ${helperUnion}
                    ORDER BY nick`).all(nick, nick, ...openChannels, nick, ...openChannels, nick, nick, ...Array(3).fill(asciiFold(nick)), ...helpers) as { nick: string }[]).map((row) => row.nick);
}

// --- People discovery policy ---
// Outside the admin contact policy above, verified humans need concrete membership evidence:
//   - explicit membership in a live workspace (public) channel,
//   - a shared non-direct channel the sender can read too, or
//   - an existing direct-conversation pair, but only while that pair is live and uncontaminated:
//     a non-archived direct channel with exactly the two members and both rows present. A bare
//     direct_conversations mapping, a missing/orphan channel, a removed half, or a third member
//     grants nothing (same safety semantics as assertPairOnly).
// Open channels keep no channel_members row, so isMember("#help") alone is never evidence; a
// secret-only membership in a room the sender cannot read grants nothing. Archived rooms, orphan
// membership rows, #t-* threads and #dm-* channels are excluded as discovery sources.
const HUMAN_DISCOVERY_SQL = `(
  ${ADMIN_DISCOVERY_SQL}
  OR EXISTS (SELECT 1 FROM channel_members cm JOIN channels c ON c.channel = cm.channel
    WHERE cm.nick = a.nick COLLATE NOCASE AND c.visibility = 'workspace' AND c.archived_at IS NULL
      AND c.channel NOT LIKE '#t-%' AND c.channel NOT LIKE '#dm-%')
  OR EXISTS (SELECT 1 FROM channel_members mine
    JOIN channel_members other ON other.channel = mine.channel
    JOIN channels c ON c.channel = mine.channel
    WHERE mine.nick = ? COLLATE NOCASE AND other.nick = a.nick COLLATE NOCASE
      AND c.visibility <> 'direct' AND c.archived_at IS NULL
      AND c.channel NOT LIKE '#t-%' AND c.channel NOT LIKE '#dm-%')
  OR EXISTS (SELECT 1 FROM public_author_evidence evidence
    LEFT JOIN channels public_room ON public_room.channel = evidence.channel
    WHERE evidence.account_id = a.account_id
      AND ((public_room.visibility = 'workspace' AND public_room.archived_at IS NULL
        AND public_room.channel NOT LIKE '#t-%' AND public_room.channel NOT LIKE '#dm-%')
        OR ${OPEN_CHANNEL_EVIDENCE_SQL}))
  OR EXISTS (SELECT 1 FROM direct_conversations d
    JOIN channels dc ON dc.channel = d.channel AND dc.visibility = 'direct' AND dc.archived_at IS NULL AND d.provision_ready = 1
    WHERE ((d.first_nick = ? AND d.second_nick = LOWER(a.nick))
        OR (d.first_nick = LOWER(a.nick) AND d.second_nick = ?))
      AND EXISTS (SELECT 1 FROM channel_members m1 WHERE m1.channel = d.channel AND m1.nick = ? COLLATE NOCASE)
      AND EXISTS (SELECT 1 FROM channel_members m2 WHERE m2.channel = d.channel AND m2.nick = LOWER(a.nick) COLLATE NOCASE)
      AND (SELECT COUNT(*) FROM channel_members m3 WHERE m3.channel = d.channel) = 2)
)`;

// The one discovery predicate shared by the people search and the explicit-recipient path. The
// candidate column is `a.nick` (FROM accounts a); bind params in order, or spread the tuple below.
export function humanDiscovery(senderNick: string): { sql: string; params: string[] } {
  const folded = asciiFold(senderNick);
  return { sql: HUMAN_DISCOVERY_SQL, params: [senderNick, senderNick, ...openChannels, folded, folded, folded] };
}

// The verified-human row behind `accountId`, only when the sender may discover them. Unknown,
// unverified, bot/agent and hidden targets all return null, so callers answer one generic result.
// Call only after the IRC server validates an authenticated PRIVMSG account tag. Persist no
// message text; account_id prevents nick changes or reuse from transferring contact evidence.
export function recordValidatedPublicAuthorMessage(accountId: string, channel: string, msgid: string): boolean {
  const room = channelInfo(channel);
  const isPublic = isOpenChannel(channel) || (room?.visibility === "workspace" && !room.archived);
  const author = db.query("SELECT 1 FROM accounts WHERE account_id = ? AND kind = 'human' AND verified_at IS NOT NULL").get(accountId);
  if (!author || !isPublic || !msgid) return false;
  db.query(`INSERT INTO public_author_evidence (account_id, channel, msgid, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(accountId, room?.channel || normalized(channel), msgid, Date.now());
  return true;
}

export function discoverableHuman(senderNick: string, accountId: string): { id: string; nick: string } | null {
  const { sql, params } = humanDiscovery(senderNick);
  const row = db.query(`SELECT a.account_id AS id, a.nick FROM accounts a
    WHERE a.account_id = ? AND a.kind = 'human' AND a.verified_at IS NOT NULL AND ${sql}`)
    .get(accountId, ...params) as { id: string; nick: string } | null;
  return row ?? null;
}

export function channelInfo(channel: string): ChannelInfo | null {
  const row = db.query("SELECT channel, owner, visibility, topic, archived_at, is_group FROM channels WHERE channel = ?").get(normalized(channel)) as any;
  return row ? { channel: row.channel, owner: row.owner, visibility: row.visibility, topic: row.topic, archived: !!row.archived_at, isGroup: !!row.is_group } : null;
}

export function visibleChannels(nick: string): ChannelInfo[] {
  return (db.query(`SELECT c.channel, c.owner, c.visibility, c.topic, c.archived_at, c.is_group
                    FROM channels c
                    WHERE c.visibility <> 'direct' AND ((c.visibility = 'workspace' AND c.channel NOT LIKE '#t-%') OR EXISTS (
                      SELECT 1 FROM channel_members m WHERE m.channel = c.channel AND m.nick = ?
                    )) ORDER BY c.channel`).all(nick) as any[])
    .map((row) => ({ channel: row.channel, owner: row.owner, visibility: row.visibility, topic: row.topic, archived: !!row.archived_at, isGroup: !!row.is_group }));
}

export function leaveChannel(nick: string, channel: string): boolean {
  if (isOpenChannel(channel)) return false;
  const info = channelInfo(channel);
  if (!info || !isMember(nick, channel)) return false;
  db.transaction(() => {
    db.query("DELETE FROM channel_members WHERE channel = ? AND nick = ?").run(info.channel, nick);
    // Their reply threads in this channel leave their list; the other participants keep theirs.
    db.query("DELETE FROM reply_thread_people WHERE nick = ? AND root_msgid IN (SELECT root_msgid FROM reply_threads WHERE channel = ?)").run(nick.toLowerCase(), info.channel);
    db.query("DELETE FROM channel_members WHERE nick = ? AND channel IN (SELECT channel FROM threads WHERE parent = ?)").run(nick, info.channel);
  })();
  return true;
}

export function joinWorkspaceChannel(nick: string, channel: string): boolean {
  const info = channelInfo(channel);
  const account = db.query("SELECT kind FROM accounts WHERE nick = ? COLLATE NOCASE").get(nick) as { kind: string } | null;
  // Threads are reached through their parent, never joined on their own.
  if (account?.kind === "agent" || !info || info.visibility !== "workspace" || info.archived || /^#t-/.test(info.channel)) return false;
  db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(info.channel, nick);
  return true;
}

// Channels the slirc service nick should relay notifications for.
export function watchedChannels(): string[] {
  const rows = db.query("SELECT DISTINCT channel FROM channel_members").all() as { channel: string }[];
  const threads = db.query("SELECT channel FROM threads").all() as { channel: string }[];
  const channels = new Set([...openChannels, ...rows.map((row) => row.channel), ...threads.map((row) => row.channel)]);
  if (channels.size === 0) channels.add(process.env.IRC_CHANNEL || "#untitled");
  return [...channels];
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Magic-link redirect target; guards against open redirects.
export function isValidNext(next: string | undefined): boolean {
  return typeof next === "string" && next.length <= 200
    && /^\/[a-zA-Z0-9._/-]*$/.test(next) && !next.startsWith("//");
}
export type ThreadRow = { channel: string; parent: string; root: string; title: string; url: string; rootNick: string; rootText: string; rootTime: string; lastActivity: number; createdBy: string };
const threadRow = (row: { channel: string; parent: string; root: string; title: string; url: string; root_nick: string; root_text: string; root_time: string; last_activity: number; created_by: string | null }): ThreadRow =>
  ({ channel: row.channel, parent: row.parent, root: row.root, title: row.title, url: row.url, rootNick: row.root_nick, rootText: row.root_text, rootTime: row.root_time, lastActivity: row.last_activity, createdBy: row.created_by ?? "" });

// A thread's child channel must be explicitly readable by the caller: workspace channels stay
// visible to parent members, secret and direct children require child membership, and a child with
// no `channels` row (legacy association) is treated as private so we fail closed. An open parent
// like `#help` does not make a DM or secret child public.
function canSeeThread(nick: string, child: string): boolean {
  const info = channelInfo(child);
  if (info && info.visibility === "workspace") return true;
  return isMember(nick, child);
}

// Threads under channels this person can see: rooms they belong to plus the public ones.
export function threadsFor(nick: string): ThreadRow[] {
  const parents = new Set([...memberChannels(nick), ...openChannels]);
  const rows = db.query("SELECT channel, parent, root, title, url, root_nick, root_text, root_time, last_activity, created_by FROM threads ORDER BY last_activity DESC").all() as Parameters<typeof threadRow>[0][];
  return rows.filter((row) => parents.has(row.parent) && canSeeThread(nick, row.channel)).map(threadRow);
}

export function threadsOf(parent: string, nick?: string): ThreadRow[] {
  const rows = db.query("SELECT channel, parent, root, title, url, root_nick, root_text, root_time, last_activity, created_by FROM threads WHERE parent = ? ORDER BY last_activity DESC").all(parent) as Parameters<typeof threadRow>[0][];
  if (!nick) return rows.map(threadRow);
  const rows_ = rows.filter((row) => canSeeThread(nick, row.channel));
  return rows_.map(threadRow);
}

// The instance's default channel (IRC_CHANNEL): everyone lands there, so it is never deleted.
export function defaultChannel(): string {
  return process.env.IRC_CHANNEL ? normalized(process.env.IRC_CHANNEL) : "";
}

// App rows that only mean something inside one channel: its uploads (custom emoji stay, they are
// global), reminders, polls and their votes, helper catch-ups and public-author evidence.
function forgetChannelRecords(channel: string): void {
  db.query("DELETE FROM uploads WHERE channel = ? AND id NOT IN (SELECT upload_id FROM custom_emoji)").run(channel);
  db.query("DELETE FROM reminders WHERE channel = ?").run(channel);
  db.query("DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE channel = ?)").run(channel);
  db.query("DELETE FROM polls WHERE channel = ?").run(channel);
  db.query("DELETE FROM helper_catchups WHERE channel = ?").run(channel);
  db.query("DELETE FROM public_author_evidence WHERE channel = ?").run(channel);
  for (const table of ["reply_thread_msgs", "reply_thread_people"]) db.query(`DELETE FROM ${table} WHERE root_msgid IN (SELECT root_msgid FROM reply_threads WHERE channel = ?)`).run(channel);
  db.query("DELETE FROM reply_threads WHERE channel = ?").run(channel);
  // A deleted project channel must not keep a repo bound: Ergo's room is gone, so the webhook has
  // nowhere to post and the repository could never be bound again.
  db.query("DELETE FROM project_repos WHERE channel = ?").run(channel);
}

export async function deleteChannelTree(channel: string, unregister: (channel: string) => Promise<void>, clearHistory?: (channel: string) => Promise<void>): Promise<void> {
  for (const thread of threadsOf(channel)) {
    // History first: unregistering leaves the transcript behind, and SAJOIN after unregister would
    // recreate an empty foreign room. clearHistory is best-effort: a throw is swallowed so the
    // unregister still runs and a failed purge can never resurrect the channel.
    if (clearHistory) await clearHistory(thread.channel).catch(() => {});
    await unregister(thread.channel);
    db.transaction(() => {
      db.query("DELETE FROM channel_members WHERE channel = ?").run(thread.channel);
      db.query("DELETE FROM channels WHERE channel = ?").run(thread.channel);
      db.query("DELETE FROM threads WHERE channel = ?").run(thread.channel);
      forgetChannelRecords(thread.channel);
    })();
  }
  if (clearHistory) await clearHistory(channel).catch(() => {});
  await unregister(channel);
  db.transaction(() => {
    db.query("DELETE FROM invites WHERE channel = ?").run(channel);
    db.query("DELETE FROM channel_members WHERE channel = ?").run(channel);
    db.query("DELETE FROM channels WHERE channel = ?").run(channel);
    forgetChannelRecords(channel);
  })();
}
