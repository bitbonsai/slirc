import { createHash, randomBytes, randomInt } from "node:crypto";
import { db } from "./db.ts";
import { configuredAppOrigin } from "./request-security.ts";
import { canonicalHarness, harnessInfoById as harnessById, releasedHarnessInfos as releasedHarnesses } from "../shared/harnesses.ts";
import { workspaceArg } from "../shared/workspace.ts";
// The published slirc-agent version. package.json is the one file the image takes from agent/.
import agentPackage from "../agent/package.json" with { type: "json" };

const AGENT_VERSION: string = agentPackage.version;

// Pairing a coding session. The session asks (POST /api/agent/session/request) and gets a link and
// an 8-character code that only its owner sees, in the harness UI. Whoever opens the link or types
// the code, signed in, sees what is asking and allows or denies it. Nothing is owned, created or
// guessable from Slirc's side until that Allow.

export { AGENT_VERSION };
export const REQUEST_TTL_MS = 10 * 60_000;
// Code alphabet: Crockford base32 without I, L, O, U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Harnesses the connect routes accept (every registered module, so unreleased ones can be tried on
// dev) and harnesses people are offered (released only). Both come from the agent package's registry.
export const acceptedHarness = (id: unknown) => typeof id === "string" && !!harnessById(id);
export const offeredHarnesses = () => releasedHarnesses().map((harness) => ({ id: harness.id, name: harness.name, ...(harness.terminalOnly ? { terminal: true } : {}) }));

export function instanceHost(): string {
  const host = process.env.APP_HOST?.trim();
  if (host) return host;
  return new URL(configuredAppOrigin()).host;
}

// The two lines the Agents page shows, for this instance.
export function connectCommands(host = instanceHost()) {
  const workspace = workspaceArg(host);
  // The copied command always spells out the workspace, app.slirc.org included, so the connect
  // code after it can't be read as one.
  const tail = ` ${workspace || host.toLowerCase()}`;
  return {
    workspace,
    npx: `npx slirc-agent@latest${tail}`,
    bunx: `bunx slirc-agent@latest${tail}`,
    session: Object.fromEntries(releasedHarnesses().map((harness) => [harness.id, harness.sessionCommand(workspace)])),
  };
}

// Failed code guesses per IP and per account: five per minute, then blocked for ten minutes.
// ponytail: in-memory throttle fits one app process; move to shared storage if Slirc scales out.
const failures = new Map<string, number[]>();
const blocked = new Map<string, number>();
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 60_000;
const BLOCK_MS = 10 * 60_000;

export function resetConnectThrottleForTests(): void {
  failures.clear();
  blocked.clear();
}

export function isBlocked(key: string, now = Date.now()): boolean {
  const until = blocked.get(key) || 0;
  if (until > now) return true;
  if (until) blocked.delete(key);
  return false;
}

export function recordFailure(key: string, now = Date.now()): void {
  const recent = (failures.get(key) || []).filter((time) => time > now - FAILURE_WINDOW_MS);
  recent.push(now);
  failures.set(key, recent);
  if (recent.length >= FAILURE_LIMIT) {
    blocked.set(key, now + BLOCK_MS);
    failures.delete(key);
  }
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

// XXXX-XXXX for people; stored without the dash.
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : null;
}

export type SessionDetails = {
  harness: string; sessionId: string; sessionFile: string; sessionName: string;
  repo: string | null; model: string | null; provider: string | null; machine: string;
};

export type ConnectRequest = SessionDetails & {
  id: string; code: string; secret_hash: string; created_at: number; expires_at: number;
  decision: "allow" | "deny" | null; binding_id: string | null;
};

type Row = {
  id: string; code: string; secret_hash: string; harness: string; session_id: string; session_file: string; session_name: string;
  repo: string | null; model: string | null; provider: string | null; machine: string; created_at: number; expires_at: number;
  decision: "allow" | "deny" | null; binding_id: string | null;
};

const fromRow = (row: Row): ConnectRequest => ({
  id: row.id, code: row.code, secret_hash: row.secret_hash, harness: row.harness, sessionId: row.session_id, sessionFile: row.session_file,
  sessionName: row.session_name, repo: row.repo, model: row.model, provider: row.provider, machine: row.machine,
  created_at: row.created_at, expires_at: row.expires_at, decision: row.decision, binding_id: row.binding_id,
});

// Undecided requests go when they expire; decided ones are kept a day so a late poll still learns
// the outcome.
function sweep(now: number): void {
  db.query("DELETE FROM agent_connect_requests WHERE (decision IS NULL AND expires_at <= ?) OR created_at <= ?").run(now, now - 24 * 3_600_000);
}

// A new request for the session holding `secretHash`. Its earlier undecided request, if any, is
// replaced, so only the newest link and code work.
export function createConnectRequest(secretHash: string, details: SessionDetails, now = Date.now()): { id: string; token: string; code: string; expiresAt: number } {
  return db.transaction(() => {
    sweep(now);
    db.query("DELETE FROM agent_connect_requests WHERE secret_hash = ?").run(secretHash);
    const token = randomBytes(32).toString("base64url");
    let code = "";
    for (let attempt = 0; attempt < 10 && !code; attempt++) {
      const candidate = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      if (!db.query("SELECT 1 FROM agent_connect_requests WHERE code = ?").get(candidate)) code = candidate;
    }
    if (!code) throw new Error("could not create a connect code");
    const expiresAt = now + REQUEST_TTL_MS;
    const id = randomBytes(16).toString("hex");
    db.query(`INSERT INTO agent_connect_requests (id, token_hash, code, secret_hash, harness, session_id, session_file, session_name, repo, model, provider, machine, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, sha(token), code, secretHash, canonicalHarness(details.harness), details.sessionId,
      details.sessionFile, details.sessionName, details.repo, details.model, details.provider, details.machine, now, expiresAt);
    return { id, token, code: formatCode(code), expiresAt };
  })();
}

export function requestForSecret(secretHash: string, now = Date.now()): ConnectRequest | null {
  const row = db.query("SELECT * FROM agent_connect_requests WHERE secret_hash = ?").get(secretHash) as Row | null;
  if (!row || (row.decision === null && row.expires_at <= now)) return null;
  return fromRow(row);
}

// An undecided, live request by its link token or typed code.
export function findOpenRequest(by: { token?: unknown; code?: unknown }, now = Date.now()): ConnectRequest | null {
  let row: Row | null = null;
  if (typeof by.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(by.token)) row = db.query("SELECT * FROM agent_connect_requests WHERE token_hash = ?").get(sha(by.token)) as Row | null;
  else {
    const code = normalizeCode(by.code);
    if (code) row = db.query("SELECT * FROM agent_connect_requests WHERE code = ?").get(code) as Row | null;
  }
  if (!row || row.decision !== null || row.expires_at <= now) return null;
  return fromRow(row);
}

export function openRequestById(id: string, now = Date.now()): ConnectRequest | null {
  const row = db.query("SELECT * FROM agent_connect_requests WHERE id = ?").get(id) as Row | null;
  if (!row || row.decision !== null || row.expires_at <= now) return null;
  return fromRow(row);
}

export function recordDecision(id: string, decision: "allow" | "deny", bindingId: string | null): boolean {
  return db.query("UPDATE agent_connect_requests SET decision = ?, binding_id = ? WHERE id = ? AND decision IS NULL").run(decision, bindingId, id).changes > 0;
}

// What the Allow card shows. Never the token or the session file path.
export function requestCard(request: ConnectRequest) {
  return {
    id: request.id, harness: request.harness, harnessName: harnessById(request.harness)?.name ?? request.harness,
    sessionName: request.sessionName, repo: request.repo, model: request.model, machine: request.machine,
    code: formatCode(request.code), expiresAt: request.expires_at,
  };
}

// Connect tickets: the Agents page mints one when someone copies its command, and the command
// carries it to the session's pairing request. A valid ticket only says which signed-in person is
// waiting, so the Allow card can open on their page by itself; it allows nothing. Ten minutes, as
// long as a request and the CLI's arm file: a first install waits for the owner to reload their
// agent before the session asks, which often took longer than the two minutes this used to be.
// Bound to the person who minted it, and to the session that presents it first: that session can
// ask again (a lost response, a retry), any other one is ignored.
// ponytail: in-memory like the code throttle above; a restart just drops back to link and code.
export const TICKET_TTL_MS = 10 * 60_000;
const tickets = new Map<string, { owner: string; expiresAt: number; holder?: string }>();
// Requests a ticket tied to a person: request id -> that person's nick.
const requestOwners = new Map<string, { owner: string; expiresAt: number }>();

const forget = (map: Map<string, { expiresAt: number }>, now: number) => { for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key); };

export function mintTicket(owner: string, now = Date.now()): { ticket: string; expiresAt: number } {
  forget(tickets, now);
  const ticket = randomBytes(9).toString("base64url");
  const expiresAt = now + TICKET_TTL_MS;
  tickets.set(sha(ticket), { owner, expiresAt });
  return { ticket, expiresAt };
}

// The owner a ticket names, for the session `holder` (its secret's hash). The first session to
// present a ticket holds it. Unknown, expired or held by another session: null.
export function redeemTicket(ticket: unknown, holder: string, now = Date.now()): string | null {
  if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(ticket)) return null;
  const found = tickets.get(sha(ticket));
  if (!found || found.expiresAt <= now) return null;
  if (found.holder !== undefined && found.holder !== holder) return null;
  found.holder = holder;
  return found.owner;
}

export function tieRequest(requestId: string, owner: string, expiresAt: number, now = Date.now()): void {
  forget(requestOwners, now);
  requestOwners.set(requestId, { owner, expiresAt });
}

// The person a ticket tied this request to, if any. Others can't open or decide it.
export function requestOwner(requestId: string, now = Date.now()): string | null {
  const found = requestOwners.get(requestId);
  return found && found.expiresAt > now ? found.owner : null;
}

export function resetTicketsForTests(): void {
  tickets.clear();
  requestOwners.clear();
}
