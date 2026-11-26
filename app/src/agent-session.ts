import { db } from "./db.ts";
import { accountByNick, ergo } from "./accounts.ts";
import { accountIrcPassword, ircPasswordFor } from "./irc-key.ts";
import { createDirectConversation, directChannelName, directConversation, normalized } from "./rooms.ts";
import { createDirectChannel, setAlwaysOn } from "./grants.ts";
import { publish } from "./live.ts";
import { acceptedHarness } from "./agent-connect.ts";
import { canonicalHarness } from "../agent/src/harnesses/index.ts";

export const LEASE_MS = 45_000;
export const MAX_REQUEST_TEXT = 8_000;
export const MAX_CONTEXT = 20_000;
export const hashAgentSecret = (secret: string) => new Bun.CryptoHasher("sha256").update(secret).digest("hex");
const randomBytes = (size: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(size)));

export type Binding = {
  id: string; instance_id: string; owner_account_id: string; owner_nick: string; harness: string;
  session_id: string; session_file: string; secret_hash: string; nick: string;
  dm: string | null; agent_account_id: string | null; status: "provisioning" | "ready" | "revoked"; machine: string; session_name: string;
  repo: string | null; model: string | null; provider: string | null; rename_pending: string | null; confirmed_at: number | null;
  lease_id: string | null; lease_nonce: string | null; lease_expires_at: number | null;
};

// `model` is the bare model id; `provider` is who serves it (e.g. openai-codex), never the harness.
export type AgentMetadata = { harness: string; name: string; repo: string | null; model: string | null; provider: string | null };
export type MetadataInput = { name?: unknown; repo?: unknown; model?: unknown; provider?: unknown };
type MetadataFields = "harness" | "session_name" | "repo" | "model" | "provider";

// Display text from the adapter: no control or bidi-override characters, single spaces, bounded.
function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

// Only the folder name is ever stored or shown; a full path would leak the owner's machine layout.
const cleanRepo = (value: unknown) => cleanText(typeof value === "string" ? value.split(/[\\/]/).filter(Boolean).at(-1) || "" : "", 80);

export function cleanMetadata(input: MetadataInput): { name?: string; repo?: string; model?: string; provider?: string } {
  const out: { name?: string; repo?: string; model?: string; provider?: string } = {};
  if (input.name !== undefined) out.name = cleanText(input.name, 80);
  if (input.repo !== undefined) out.repo = cleanRepo(input.repo);
  if (input.model !== undefined) out.model = cleanText(input.model, 80);
  if (input.provider !== undefined) out.provider = cleanText(input.provider, 80);
  return out;
}

export function bindingMetadata(binding: Pick<Binding, MetadataFields>): AgentMetadata {
  const repo = binding.repo || null;
  return { harness: binding.harness, name: binding.session_name || repo || binding.harness, repo, model: binding.model || null, provider: binding.provider || null };
}

// Metadata for an agent account row. Legacy agents with no session binding have none.
export function agentMetadata(nick: string): AgentMetadata | null {
  const binding = db.query("SELECT harness,session_name,repo,model,provider FROM agent_session_bindings WHERE nick=? COLLATE NOCASE AND status<>'revoked'")
    .get(nick) as Pick<Binding, MetadataFields> | null;
  return binding ? bindingMetadata(binding) : null;
}

// The owner and everyone sharing a room with the agent: the audience for its presence and metadata.
export function agentAudience(nick: string, owner: string): string[] {
  const roommates = db.query(`SELECT DISTINCT other.nick FROM channel_members mine JOIN channel_members other ON other.channel = mine.channel
    WHERE mine.nick = ? COLLATE NOCASE AND other.nick <> ? COLLATE NOCASE`).all(nick, nick) as { nick: string }[];
  return [...new Set([owner, ...roommates.map((row) => row.nick)])];
}

// Store reported metadata; publish `agent-updated` only when something visible changed. While an
// owner rename is pending, the adapter's name is ignored until it reports that exact name back.
export function updateBindingMetadata(binding: Binding, input: MetadataInput): AgentMetadata {
  const clean = cleanMetadata(input);
  const current = db.query("SELECT * FROM agent_session_bindings WHERE id=?").get(binding.id) as Binding;
  if (current.rename_pending !== null && clean.name !== undefined) {
    if (clean.name === current.rename_pending) db.query("UPDATE agent_session_bindings SET rename_pending=NULL WHERE id=? AND rename_pending=?").run(binding.id, clean.name);
    else delete clean.name;
  }
  const next = {
    session_name: clean.name ?? current.session_name, repo: clean.repo ?? current.repo ?? "",
    model: clean.model ?? current.model ?? "", provider: clean.provider ?? current.provider ?? "",
  };
  const before = bindingMetadata(current);
  db.query("UPDATE agent_session_bindings SET session_name=?, repo=?, model=?, provider=? WHERE id=?")
    .run(next.session_name, next.repo || null, next.model || null, next.provider || null, binding.id);
  const after = bindingMetadata({ ...current, ...next });
  if (JSON.stringify(before) !== JSON.stringify(after) && current.status === "ready") {
    for (const person of agentAudience(current.nick, current.owner_nick)) publish(person, "agent-updated", { nick: current.nick, agent: after });
  }
  return after;
}

// Owner rename from Slirc, harness-neutral: store it as the display name now and leave it pending
// for the adapter, which applies it to the live session (now or at its next attach) and acks it.
export function renameBinding(binding: Binding, name: unknown): AgentMetadata {
  const clean = cleanMetadata({ name }).name ?? "";
  db.query("UPDATE agent_session_bindings SET rename_pending=NULL WHERE id=?").run(binding.id);
  const agent = updateBindingMetadata(binding, { name: clean });
  db.query("UPDATE agent_session_bindings SET rename_pending=? WHERE id=?").run(clean, binding.id);
  return agent;
}

function instanceId(): string {
  let row = db.query("SELECT value FROM meta WHERE key = 'agent-session-instance'").get() as { value: string } | null;
  if (!row) {
    db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('agent-session-instance', ?)").run(randomBytes(16).toString("hex"));
    row = db.query("SELECT value FROM meta WHERE key = 'agent-session-instance'").get() as { value: string };
  }
  return row.value;
}

// Readable agent nick, `<harness>-<4 hex>`. The 6-hex form is used only when the short one is taken.
// Display names come from session metadata; the nick never changes after reservation.
function agentNick(harness: string): string {
  const taken = (nick: string) => !!db.query("SELECT 1 FROM accounts WHERE nick = ? COLLATE NOCASE").get(nick)
    || !!db.query("SELECT 1 FROM agent_session_bindings WHERE nick = ? COLLATE NOCASE").get(nick);
  for (const size of [2, 3, 3, 3, 3, 3, 3, 3]) {
    const nick = `${harness}-${randomBytes(size).toString("hex")}`;
    if (!taken(nick)) return nick;
  }
  throw new Error("could not reserve an agent nick");
}

// The binding for a session its owner just allowed. A session that was bound to this owner before
// (its local state was lost, say) keeps its agent and takes the new secret; a revoked one starts
// over with a new agent.
export function bindSession(input: {
  owner: string; ownerAccountId: string; harness: string; sessionId: string; sessionFile: string;
  machine: string; sessionName: string; repo?: string | null; model?: string | null; provider?: string | null; secretHash: string;
}, now = Date.now()): Binding {
  if (!acceptedHarness(input.harness)) throw new Error("unsupported adapter");
  const harness = canonicalHarness(input.harness);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId) || !input.sessionFile || input.sessionFile.length > 2048) throw new Error("invalid attachment");
  if (!/^[0-9a-f]{64}$/.test(input.secretHash)) throw new Error("invalid binding secret");
  return db.transaction(() => {
    const instance = instanceId();
    const existing = db.query(`SELECT * FROM agent_session_bindings WHERE instance_id = ? AND owner_account_id = ? AND harness = ? AND session_id = ?`)
      .get(instance, input.ownerAccountId, harness, input.sessionId) as Binding | null;
    if (existing && existing.status !== "revoked") {
      db.query("UPDATE agent_session_bindings SET secret_hash = ?, session_file = ?, confirmed_at = COALESCE(confirmed_at, ?), lease_id = NULL, lease_nonce = NULL, lease_expires_at = NULL WHERE id = ?")
        .run(input.secretHash, input.sessionFile, now, existing.id);
      return db.query("SELECT * FROM agent_session_bindings WHERE id = ?").get(existing.id) as Binding;
    }
    // A revoked binding keeps its row for its request history; it gives up the session slot.
    if (existing) db.query("UPDATE agent_session_bindings SET session_id = ? WHERE id = ?").run(`revoked:${existing.id}`, existing.id);
    const id = randomBytes(16).toString("hex");
    const nick = agentNick(harness);
    // The agent's account id is fixed here, so its IRC password derives from it before the account exists.
    const agentAccountId = randomBytes(16).toString("hex");
    const metadata = cleanMetadata({ name: input.sessionName, repo: input.repo ?? undefined, model: input.model ?? undefined, provider: input.provider ?? undefined });
    db.query(`INSERT INTO agent_session_bindings
      (id, instance_id, owner_account_id, owner_nick, harness, session_id, session_file, secret_hash, nick, agent_account_id, status, machine, session_name, repo, model, provider, created_at, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, instance, input.ownerAccountId, input.owner, harness, input.sessionId, input.sessionFile, input.secretHash, nick, agentAccountId, input.machine,
        metadata.name ?? "", metadata.repo || null, metadata.model || null, metadata.provider || null, now, now);
    return db.query("SELECT * FROM agent_session_bindings WHERE id = ?").get(id) as Binding;
  })();
}

// The agent's IRC password. Its accounts row decides once it exists; before that it derives from
// the binding's agent_account_id at counter 0.
export function bindingIrcPassword(binding: Binding): string {
  const row = db.query("SELECT account_id, irc_password_gen FROM accounts WHERE nick = ? COLLATE NOCASE AND kind = 'agent'")
    .get(binding.nick) as { account_id: string; irc_password_gen: number | null } | null;
  if (row) return accountIrcPassword(row);
  if (!binding.agent_account_id) throw new Error("agent binding has no account id");
  return ircPasswordFor(binding.agent_account_id, 0);
}

export async function provisionBinding(binding: Binding): Promise<Binding> {
  // Nothing is created for a session the owner has not allowed: no Ergo account, no DM.
  const pending = db.query("SELECT 1 FROM agent_session_bindings WHERE id=? AND status='provisioning' AND confirmed_at IS NULL").get(binding.id);
  if (pending) throw new Error("waiting for the owner to allow this session");
  const existing = accountByNick(binding.nick);
  if (existing) {
    if (existing.kind !== "agent" || existing.owner?.toLowerCase() !== binding.owner_nick.toLowerCase() ||
        (binding.agent_account_id && existing.id !== binding.agent_account_id)) throw new Error("reserved agent identity is unavailable");
    const checked = await ergo("/v1/check_auth", { accountName: binding.nick, passphrase: existing.ircPassword }).catch(() => ({ success: false }));
    if (!checked.success) throw new Error("reserved agent account needs recovery");
  } else {
    const registered = await ergo("/v1/ns/saregister", { accountName: binding.nick, passphrase: bindingIrcPassword(binding) });
    if (!registered.success) {
      // An ambiguous registration outcome: a prior attempt may have created the account whose
      // response was lost before the SQLite row. Verify the reserved credentials and finish;
      // never rotate the password or create a different identity.
      if (registered.errorCode !== "ACCOUNT_EXISTS") throw new Error(registered.error || "Ergo rejected agent registration");
      const checked = await ergo("/v1/check_auth", { accountName: binding.nick, passphrase: bindingIrcPassword(binding) }).catch(() => ({ success: false }));
      if (!checked.success) throw new Error("reserved agent account needs recovery");
    }
  }
  await setAlwaysOn(binding.nick, false);
  if (!accountByNick(binding.nick)) {
    const createdAt = Date.now();
    db.query(`INSERT INTO accounts (nick,email,irc_password_gen,account_id,role,kind,owner,machine,verified_at,provisional_expires_at,created_at)
      VALUES (?, ?, 0, ?, 'member', 'agent', ?, ?, ?, NULL, ?)
      ON CONFLICT(nick) DO NOTHING`).run(binding.nick, `${binding.nick}@agents.invalid`,
      binding.agent_account_id, binding.owner_nick, binding.machine, createdAt, createdAt);
  }
  let dm = directConversation(binding.owner_nick, binding.nick)?.channel;
  if (!dm) {
    dm = directChannelName(binding.owner_nick, binding.nick);
    await createDirectChannel(dm, binding.owner_nick, [binding.owner_nick, binding.nick]);
    createDirectConversation(binding.owner_nick, binding.nick, binding.owner_nick);
  }
  const agent = accountByNick(binding.nick);
  if (!agent || agent.kind !== "agent" || agent.owner?.toLowerCase() !== binding.owner_nick.toLowerCase()) throw new Error("agent account was not provisioned");
  const ready = db.query("UPDATE agent_session_bindings SET status = 'ready', dm = ?, agent_account_id = ? WHERE id = ? AND status = 'provisioning'")
    .run(dm, agent.id, binding.id);
  // Same live event a human DM fires, so the owner's open tabs list the new agent without a reload.
  if (ready.changes) publish(binding.owner_nick, "direct", { channel: normalized(dm) });
  return db.query("SELECT * FROM agent_session_bindings WHERE id = ?").get(binding.id) as Binding;
}

// Immutable binding authority: the stored owner account id still maps to the owner nick, and the
// agent account still exists with the same immutable id and owner. Nick reuse must not revive a
// revoked or replaced binding.
function bindingAuthorized(binding: Binding): boolean {
  // A removed owner's agents stop at once, even before their removal finishes tearing them down.
  const owner = db.query("SELECT account_id FROM accounts WHERE nick = ? COLLATE NOCASE AND removed_at IS NULL").get(binding.owner_nick) as { account_id: string } | null;
  const agent = db.query("SELECT account_id, kind, owner FROM accounts WHERE nick = ? COLLATE NOCASE").get(binding.nick) as { account_id: string; kind: string; owner: string } | null;
  return !!owner && owner.account_id === binding.owner_account_id && !!agent && agent.kind === "agent"
    && agent.owner?.toLowerCase() === binding.owner_nick.toLowerCase()
    && (!binding.agent_account_id || agent.account_id === binding.agent_account_id);
}

export function authorizedBindingById(id: string): Binding | null {
  const binding = db.query("SELECT * FROM agent_session_bindings WHERE id = ? AND status <> 'revoked'").get(id) as Binding | null;
  return binding && bindingAuthorized(binding) ? binding : null;
}

export function authenticateBinding(secret: string | undefined): Binding | null {
  if (!secret || secret.length > 128) return null;
  const binding = db.query("SELECT * FROM agent_session_bindings WHERE secret_hash = ? AND status <> 'revoked'")
    .get(hashAgentSecret(secret)) as Binding | null;
  if (!binding) return null;
  return bindingAuthorized(binding) ? binding : null;
}

export function bindLease(binding: Binding, nonce: string, now = Date.now()): { leaseId: string; expiresAt: number } | null {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(nonce)) return null;
  const current = db.query("SELECT lease_id, lease_nonce, lease_expires_at FROM agent_session_bindings WHERE id = ?").get(binding.id) as any;
  if (current?.lease_id && current.lease_expires_at > now) {
    return current.lease_nonce === nonce ? { leaseId: current.lease_id, expiresAt: current.lease_expires_at } : null;
  }
  const leaseId = randomBytes(24).toString("base64url");
  const expiresAt = now + LEASE_MS;
  db.transaction(() => {
    if (current?.lease_id) {
      db.query(`UPDATE agent_session_requests SET status='needs_confirmation',confirm_revision=NULL,updated_at=?
        WHERE binding_id=? AND status='offered'`).run(now, binding.id);
      // Only work the agent never answered. A reply or failure already on the IRC wire keeps its
      // text and reply_cid; its echo (or the echo timeout) decides it, not the lease.
      db.query(`UPDATE agent_session_requests SET status='uncertain',text='',context='[]',updated_at=?
        WHERE binding_id=? AND status='accepted'`).run(now, binding.id);
    }
    db.query("UPDATE agent_session_bindings SET lease_id = ?, lease_nonce = ?, lease_expires_at = ?, attached_at = ? WHERE id = ?")
      .run(leaseId, nonce, expiresAt, now, binding.id);
  })();
  return { leaseId, expiresAt };
}

export function renewLease(binding: Binding, leaseId: string, now = Date.now()): number | null {
  const expiresAt = now + LEASE_MS;
  const result = db.query("UPDATE agent_session_bindings SET lease_expires_at = ? WHERE id = ? AND lease_id = ? AND lease_expires_at > ? AND status = 'ready'")
    .run(expiresAt, binding.id, leaseId, now);
  return result.changes ? expiresAt : null;
}

export function validLease(binding: Binding, leaseId: string, now = Date.now()): boolean {
  return !!db.query("SELECT 1 FROM agent_session_bindings WHERE id = ? AND lease_id = ? AND lease_expires_at > ? AND status = 'ready'")
    .get(binding.id, leaseId, now);
}

export function invalidateLease(bindingId: string, leaseId: string): boolean {
  return db.transaction(() => {
    const changed = db.query("UPDATE agent_session_bindings SET lease_id = NULL, lease_nonce = NULL, lease_expires_at = NULL WHERE id = ? AND lease_id = ?")
      .run(bindingId, leaseId).changes > 0;
    if (!changed) return false;
    db.query(`UPDATE agent_session_requests SET status='needs_confirmation',confirm_revision=NULL,updated_at=?
      WHERE binding_id=? AND status='offered'`).run(Date.now(), bindingId);
    db.query(`UPDATE agent_session_requests SET status='uncertain',text='',context='[]',updated_at=?
      WHERE binding_id=? AND status='accepted'`).run(Date.now(), bindingId);
    return true;
  })();
}
