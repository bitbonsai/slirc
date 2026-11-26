// Real thread creation behind POST /api/threads.
//
// The new contract is a single call: the server picks the #t- name, creates the child channel in
// Ergo with the parent's visibility policy, records every membership/settings row, and only then
// returns the normal thread row. The old "client joins a guessed channel, then registers metadata"
// flow stays available only when the caller supplies an explicit `channel` (legacy PWA).
//
// Authorization is always derived from the parent: the caller's current membership (or the DM
// mapping), never from client-supplied root/nick text. Parent membership is re-checked after the
// async Ergo provisioning, so a revoke that lands mid-create fails the request instead of granting
// a child outside the parent.

import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { ircChannelExists } from "./accounts.ts";
import { channelInfo, directConversation, isMember, isOpenChannel, normalized, threadsOf, asciiFold, type ThreadRow } from "./rooms.ts";
import { createThreadChannel, unregisterChannel } from "./grants.ts";
import { threadUrl } from "./request-security.ts";

export const THREAD_NAME = /^#t-[a-z0-9]{6}$/i;

export type ThreadProvisioner = {
  channelExists: (channel: string) => Promise<boolean>;
  createThreadChannel: (channel: string, owner: string, visibility: "workspace" | "secret", members: string[]) => Promise<void>;
  unregisterChannel: (channel: string) => Promise<void>;
};

// The unit seam: production uses the real grants helpers, tests inject observers/failures.
const defaultProvisioner: ThreadProvisioner = { channelExists: ircChannelExists, createThreadChannel, unregisterChannel };

export type ThreadInput = {
  parent?: unknown;
  root?: unknown;
  title?: unknown;
  url?: unknown;
  rootNick?: unknown;
  rootText?: unknown;
  rootTime?: unknown;
};

export type ThreadResult = { status: number; error?: string; thread?: ThreadRow };

// Child half of the thread read boundary: a workspace child is readable by parent members, anything
// else (secret, direct, or a legacy child with no channels row) needs an explicit child grant.
export function canSeeThreadChannel(nick: string, channel: string): boolean {
  const info = channelInfo(channel);
  if (info && info.visibility === "workspace") return true;
  return isMember(nick, channel);
}

// The server msgid is only an idempotency key scoped to a parent the caller can already see; it is
// never treated as proof that the caller authored or saw the root message. A root that is missing
// or forged from history simply creates a thread the caller is allowed to create.
function cleanRoot(value: unknown): string {
  if (typeof value !== "string") return "";
  const root = value.trim();
  if (!root || Buffer.byteLength(root, "utf8") > 512 || /[\u0000-\u001f\u007f]/.test(root)) return "";
  return root;
}

function cleanTitle(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

function parentMemberNicks(channel: string): string[] {
  return (db.query("SELECT nick FROM channel_members WHERE channel = ?").all(channel) as { nick: string }[]).map((row) => row.nick);
}

function directPairNicks(channel: string): string[] {
  const row = db.query("SELECT first_nick, second_nick FROM direct_conversations WHERE channel = ?").get(channel) as { first_nick: string; second_nick: string } | null;
  return row ? [row.first_nick, row.second_nick] : [];
}

// One creation runs at a time. Thread creation is rare, and a single chain also closes the
// generated-name race between two different roots choosing the same #t- suffix.
// ponytail: process-global lock; move to a per-(parent,root) lock or a DB constraint if creation ever contends.
let threadChain: Promise<unknown> = Promise.resolve();
function withThreadLock<T>(run: () => Promise<T>): Promise<T> {
  const result = threadChain.then(run, run);
  threadChain = result.then(() => {}, () => {});
  return result;
}

async function provisionThread(nick: string, input: ThreadInput, deps: ThreadProvisioner, reserve?: () => boolean): Promise<ThreadResult> {
  const rawParent = typeof input.parent === "string" ? input.parent.trim() : "";
  if (!rawParent) return { status: 400, error: "parent, root, and title are required" };
  const root = cleanRoot(input.root);
  const title = cleanTitle(input.title);
  if (!root || !title) return { status: 400, error: "parent, root, and title are required" };

  // Parent: a canonical wire channel (room or an existing #dm-* mapping), or an existing DM display
  // nick. A #dm-* channel is resolved only through direct_conversations for this requestor; a
  // #t-* channel is never a parent. No nickname is ever parsed into a channel name.
  let parent = "";
  let direct = null as ReturnType<typeof directConversation>;
  if (rawParent.startsWith("#")) {
    parent = normalized(rawParent);
    if (parent === "#" || /^#t-/.test(parent)) return { status: 404, error: "channel not found" };
    if (/^#dm-/.test(parent)) {
      const row = db.query("SELECT channel, first_nick, second_nick FROM direct_conversations WHERE channel = ?").get(parent) as { channel: string; first_nick: string; second_nick: string } | null;
      const folded = asciiFold(nick);
      const other = row ? (row.first_nick === folded ? row.second_nick : row.second_nick === folded ? row.first_nick : "") : "";
      if (!row || !other) return { status: 404, error: "direct message not found" };
      try {
        direct = directConversation(nick, other);
      } catch {
        return { status: 404, error: "direct message not found" };
      }
      if (!direct || direct.channel !== parent) return { status: 404, error: "direct message not found" };
      parent = direct.channel;
    } else if (!isOpenChannel(parent)) {
      const info = channelInfo(parent);
      if (!info || info.visibility === "direct") return { status: 404, error: "channel not found" };
      if (!isMember(nick, parent)) return { status: 403, error: "channel membership required" };
    }
  } else {
    direct = directConversation(nick, rawParent);
    if (!direct) return { status: 404, error: "direct message not found" };
    parent = direct.channel;
  }

  // Visibility captured at resolution time. Re-checked after every await below: a deleted/reopened
  // DM must not retarget the captured parent, and a room that changed kind is no longer compatible.
  const parentVisibility = direct ? "direct" : isOpenChannel(parent) ? "open" : channelInfo(parent)!.visibility;
  const parentIntact = () => {
    if (direct) {
      try {
        const now = directConversation(nick, direct.nick);
        return !!now && now.channel === direct.channel;
      } catch {
        return false;
      }
    }
    if (parentVisibility === "open") return isOpenChannel(parent);
    const info = channelInfo(parent);
    return !!info && info.visibility === parentVisibility && !info.archived && isMember(nick, parent);
  };

  const reservationKey = `thread-provision:${parent}:${root}`;
  const reservation = () => db.query("SELECT value FROM meta WHERE key = ?").get(reservationKey) as { value: string } | null;
  const clearReservation = () => { db.query("DELETE FROM meta WHERE key = ?").run(reservationKey); };

  return withThreadLock(async () => {
    // Parent access is re-checked before any existing-row return: a caller queued behind another
    // request must not receive a child after losing the parent, including a repointed DM mapping.
    if (!parentIntact()) return { status: 403, error: "channel membership required" };
    // Deterministic idempotency: at most one row for this (parent, root). More than one is a
    // contaminated association and must fail closed rather than guessing which child is "the" one.
    const matches = threadsOf(parent).filter((row) => row.root === root);
    if (matches.length > 1) return { status: 409, error: "thread conflict" };
    if (matches.length === 1) {
      const row = matches[0];
      // Never echo a legacy metadata-only row: without a channels association we cannot prove the
      // child exists, and the caller must not receive a "usable" room that was never provisioned.
      if (!THREAD_NAME.test(row.channel) || !channelInfo(row.channel) || !canSeeThreadChannel(nick, row.channel)) {
        return { status: 403, error: "thread not found" };
      }
      return { status: 201, thread: row };
    }

    // The idempotent lookup above is free; only a real provisioning run spends an account's budget.
    if (reserve && !reserve()) return { status: 429, error: "too many threads; try again later" };

    // A durable reservation keyed by parent/root is written before Ergo is touched. An uncertain
    // earlier attempt leaves it behind, so the next call either recovers the row, reuses a channel
    // that provably never got created, or fails closed instead of minting a second orphan.
    let channel = "";
    const prior = reservation();
    if (prior?.value) {
      const row = threadsOf(parent).find((item) => item.channel === prior.value && item.root === root);
      if (row && channelInfo(prior.value) && canSeeThreadChannel(nick, prior.value)) return { status: 201, thread: row };
      // A channels row without a thread row is a partial DB state we cannot safely adopt; and an Ergo
      // channel under the reserved name means the outcome is unknown. Fail closed in both cases.
      if (channelInfo(prior.value)) return { status: 503, error: "thread creation outcome unknown; retry later" };
      if (await deps.channelExists(prior.value).catch(() => true)) return { status: 503, error: "thread creation outcome unknown; retry later" };
      channel = prior.value;
    } else {
      for (let attempt = 0; attempt < 5 && !channel; attempt++) {
        const candidate = `#t-${randomBytes(4).toString("hex").slice(0, 6)}`;
        if (db.query("SELECT 1 FROM threads WHERE channel = ?").get(candidate) || channelInfo(candidate)) continue;
        // Same collision check the channel-create route uses: never adopt a name that already has an
        // IRC channel (registered or merely occupied). A failed check skips the candidate, never adopts.
        if (await deps.channelExists(candidate).catch(() => true)) continue;
        channel = candidate;
      }
      if (!channel) return { status: 503, error: "could not allocate a thread channel" };
      db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(reservationKey, channel);
    }

    const visibility: "workspace" | "secret" = direct || (!isOpenChannel(parent) && channelInfo(parent)?.visibility === "secret") ? "secret" : "workspace";
    // Child grants come from the parent's own rows, never from the request body.
    const members = visibility !== "secret" ? [nick] : [...new Set(direct ? directPairNicks(parent) : parentMemberNicks(parent))];
    if (!members.some((member) => member.toLowerCase() === nick.toLowerCase())) members.push(nick);

    let created = false;
    const dropRows = () => db.transaction(() => {
      db.query("DELETE FROM channel_members WHERE channel = ?").run(channel);
      db.query("DELETE FROM channels WHERE channel = ?").run(channel);
      db.query("DELETE FROM threads WHERE channel = ?").run(channel);
    })();
    // true = the child is gone (or was never ours); false = cleanup could not be confirmed.
    const removePartial = async (): Promise<boolean> => {
      let cleaned = true;
      if (created) cleaned = await deps.unregisterChannel(channel).then(() => true, () => false);
      dropRows();
      return cleaned;
    };
    const uncertain = () => ({ status: 503, error: "thread creation outcome unknown; retry later" });
    try {
      await deps.createThreadChannel(channel, nick, visibility, members);
      created = true;
      // The awaits above can outlive the caller's parent access; a revoke wins over a half-made child.
      if (!parentIntact()) {
        if (!await removePartial()) return uncertain();
        clearReservation();
        return { status: 403, error: "channel membership required" };
      }
      // A member revoked while we awaited must not keep +I to the new private child. Compare the
      // exact parent set captured before the awaits; any drift fails closed and tears the child down.
      if (visibility === "secret" && !direct) {
        const current = new Set(parentMemberNicks(parent).map((member) => member.toLowerCase()));
        const captured = new Set(members.map((member) => member.toLowerCase()));
        if (current.size !== captured.size || [...captured].some((member) => !current.has(member))) {
          if (!await removePartial()) return uncertain();
          clearReservation();
          return { status: 409, error: "channel membership changed; try again" };
        }
      }
      const now = Date.now();
      db.transaction(() => {
        db.query("INSERT INTO channels (channel, owner, visibility, topic, created_at) VALUES (?, ?, ?, '', ?)").run(channel, nick, visibility, now);
        for (const member of members) db.query("INSERT INTO channel_members (channel, nick) VALUES (?, ?) ON CONFLICT DO NOTHING").run(channel, member);
        db.query("INSERT INTO threads (channel, parent, root, title, url, root_nick, root_text, root_time, created_by, created_at, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(channel, parent, root, title, threadUrl(input.url), typeof input.rootNick === "string" ? input.rootNick.trim().slice(0, 32) : "", typeof input.rootText === "string" ? input.rootText.replace(/\r\n/g, "\n").slice(0, 4096) : title, typeof input.rootTime === "string" && !Number.isNaN(Date.parse(input.rootTime)) ? input.rootTime : "", nick, now, now);
      })();
      const row = threadsOf(parent).find((item) => item.channel === channel);
      if (!row) {
        if (!await removePartial()) return uncertain();
        clearReservation();
        return { status: 500, error: "thread registration failed" };
      }
      clearReservation();
      return { status: 201, thread: row };
    } catch (error) {
      console.error(`thread creation failed for ${channel}:`, error);
      // The helper marks "registered" only after our own REGISTER succeeded, so that is the one
      // failure we may safely unregister; "already registered" leaves the room untouched. "uncertain"
      // means a service round trip timed out, so the reservation stays and we fail closed.
      const marked = error as { registered?: boolean; uncertain?: boolean };
      let cleaned = !marked.registered;
      if (marked.registered) cleaned = await deps.unregisterChannel(channel).then(() => true, () => false);
      dropRows();
      if (marked.uncertain || !cleaned) return uncertain();
      clearReservation();
      return { status: 500, error: "could not create thread" };
    }
  });
}

export function createThread(nick: string, input: ThreadInput, deps: ThreadProvisioner = defaultProvisioner, reserve?: () => boolean): Promise<ThreadResult> {
  return provisionThread(nick, input, deps, reserve);
}
