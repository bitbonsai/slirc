import { join, dirname } from "node:path";
import { accountByNick } from "../accounts.ts";
import { db } from "../db.ts";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { normalizeProfileBadge } from "../../shared/profile-badges.ts";
import { agentAttached } from "../agent-session-transport.ts";
import { agentMetadata } from "../agent-session.ts";

export const avatarDir = join(dirname(process.env.DB_PATH || "/data/chat.sqlite"), "avatars");

export function knownAccount(value: string) {
  return accountByNick(value)?.nick;
}

// 0 means no photo (the generated initial). Photos stored before versions existed count as 1.
export function avatarVersion(row: { avatar_path?: string | null; avatar_version?: number | null } | null | undefined) {
  return row?.avatar_path ? row.avatar_version || 1 : 0;
}

export function versionedAvatarUrl(account: string, version: number) {
  return version ? `/avatars/${encodeURIComponent(account)}?v=${version}` : "";
}

export async function cacheGravatar(account: string) {
  const record = accountByNick(account);
  const email = record?.email;
  if (!email || record.kind === "agent") return;
  const row = db.query("SELECT avatar_path, gravatar_checked_at FROM profiles WHERE account = ?").get(account) as { avatar_path: string | null; gravatar_checked_at: number | null } | null;
  if (row?.avatar_path || (row?.gravatar_checked_at && row.gravatar_checked_at > Date.now() - 7 * 86_400_000)) return;
  try {
    db.query("INSERT INTO profiles (account) VALUES (?) ON CONFLICT(account) DO NOTHING").run(account);
    const digest = createHash("md5").update(email).digest("hex");
    const response = await fetch(`https://www.gravatar.com/avatar/${digest}?d=404&s=320`, { signal: AbortSignal.timeout(5_000) });
    db.query("UPDATE profiles SET gravatar_checked_at = ? WHERE account = ?").run(Date.now(), account);
    const mime = response.headers.get("content-type")?.split(";", 1)[0] || "";
    if (!response.ok || !mime.startsWith("image/") || mime === "image/svg+xml") return;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2_000_000) return;
    await mkdir(avatarDir, { recursive: true });
    const path = join(avatarDir, account.toLowerCase());
    await Bun.write(path, bytes);
    db.query("UPDATE profiles SET avatar_path = ?, avatar_mime = ?, avatar_version = ? WHERE account = ?").run(path, mime, Date.now(), account);
  } catch (error) {
    console.error(`gravatar cache failed for ${account}:`, error instanceof Error ? error.message : error);
  }
}

export function profileJson(account: string) {
  const row = db.query("SELECT full_name, about, availability, badge, avatar_path, avatar_version FROM profiles WHERE account = ?").get(account) as { full_name: string; about: string; availability: string; badge: string; avatar_path: string | null; avatar_version: number | null } | null;
  const member = db.query("SELECT MIN(created_at) AS created_at FROM sessions WHERE nick = ?").get(account) as { created_at: number | null } | null;
  const identity = accountByNick(account);
  return {
    account,
    fullName: row?.full_name || "",
    about: row?.about || "",
    availability: row?.availability || "",
    badge: normalizeProfileBadge(row?.badge),
    avatarUrl: versionedAvatarUrl(account, avatarVersion(row)),
    avatarVersion: avatarVersion(row),
    memberSince: member?.created_at || null,
    role: identity?.role || "member",
    kind: identity?.kind || "human",
    owner: identity?.owner || null,
    machine: identity?.machine || null,
  };
}

export function accountDetails(nicks: string[]) {
  return [...new Set(nicks)].flatMap((nick) => {
    const account = accountByNick(nick);
    const profile = account ? db.query("SELECT availability, badge, avatar_path, avatar_version FROM profiles WHERE account = ?").get(account.nick) as { availability: string; badge: string; avatar_path: string | null; avatar_version: number | null } | null : null;
    return account ? [{ id: account.id, nick: account.nick, kind: account.kind, owner: account.owner, availability: profile?.availability || "", badge: normalizeProfileBadge(profile?.badge), avatarVersion: avatarVersion(profile), ...(account.kind === "agent" ? { attached: agentAttached(account.nick), agent: agentMetadata(account.nick) } : {}) }] : [];
  });
}
