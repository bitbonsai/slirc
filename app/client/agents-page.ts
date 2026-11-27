import { type ClientSession, type ClientState } from "@client/client-state.ts";
import { agentSubtitle as repoModel } from "@client/agent-roster.ts";

// Profile → Agents. The page shows one command to paste into a coding agent and the Allow card for
// a session that asked to pair: by itself when the session ran the copied command (its connect
// code, a ticket to the server, tells Slirc whose page to show it on), or opened from the session's link or typed code. State stays local to this component
// (never the central runtime), and every awaited update is checked against the current account scope
// so a response that lands after an account switch cannot paint into the next account's page.

// `terminal`: the command can't run pasted into this harness, so the page says to run it in a terminal.
export interface AgentHarness { id: string; name: string; terminal?: boolean }

export interface AgentCommands { workspace: string; npx: string; bunx: string; session: Record<string, string> }

export interface AgentCapability {
  enabled: boolean;
  reason: string;
  harnesses: AgentHarness[];
  commands: AgentCommands;
}

export interface AgentRow {
  nick: string;
  machine: string;
  lastSeen: string | number | null;
  harness?: string;
  name?: string;
  sessionName?: string;
  repo?: string;
  model?: string;
  worktree?: string;
  status?: string;
  /** Owner setting "Can read my DMs"; only session agents have it. */
  readDms?: boolean;
}

// A coding session asking to pair, as the Allow card shows it.
export interface ConnectCard { id: string; harnessName: string; sessionName: string; repo: string; model: string; machine: string; code: string; expiresAt: number }

export function parseCard(value: unknown): ConnectCard | null {
  const raw = (value ?? {}) as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" ? field.trim() : "");
  const id = text(raw.id);
  const expiresAt = normalizeExpiry(raw.expiresAt);
  return id && expiresAt ? { id, harnessName: text(raw.harnessName) || text(raw.harness), sessionName: text(raw.sessionName), repo: text(raw.repo), model: text(raw.model), machine: text(raw.machine), code: text(raw.code), expiresAt } : null;
}

// A link's token rides the URL fragment, so it never reaches a server log. It is kept briefly in
// this browser so it survives signing in, and goes as soon as the card has used it.
const TOKEN_KEY = "slirc.agentConnect";
const RUNNER_KEY = "slirc.agentRunner";
const storage = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

export function stashConnectToken(loc: Pick<Location, "hash" | "pathname" | "search"> = location, now = Date.now()): boolean {
  const match = loc.hash.match(/^#connect=([A-Za-z0-9_-]{43})$/);
  if (match) {
    storage()?.setItem(TOKEN_KEY, JSON.stringify({ token: match[1], at: now }));
    try { history.replaceState(history.state, "", `${loc.pathname}${loc.search}`); } catch {}
  }
  return !!peekConnectToken(now);
}

function peekConnectToken(now = Date.now()): string | null {
  try {
    const saved = JSON.parse(storage()?.getItem(TOKEN_KEY) || "null") as { token?: unknown; at?: unknown } | null;
    if (typeof saved?.token === "string" && typeof saved.at === "number" && now - saved.at < 10 * 60_000) return saved.token;
  } catch {}
  storage()?.removeItem(TOKEN_KEY);
  return null;
}

export type AgentStatusKey = "ready" | "working" | "input" | "offline" | "unverified";

// Attachment state comes only from an explicit status. An IRC lastSeen is never readiness proof, so
// a legacy row with no status is Offline (some past activity) or Attachment unverified (no evidence).
// Only an exact "ready" is Ready: a generic "connected" is not the same claim, so it falls through.
export function agentStatus(row: Pick<AgentRow, "status" | "lastSeen">): { key: AgentStatusKey; label: string } {
  const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
  if (status === "ready") return { key: "ready", label: "Ready" };
  if (status === "working") return { key: "working", label: "Working" };
  if (status === "needs-input") return { key: "input", label: "Needs input" };
  if (status === "offline") return { key: "offline", label: "Offline" };
  const seen = row.lastSeen !== null && row.lastSeen !== undefined && row.lastSeen !== "";
  return { key: seen ? "offline" : "unverified", label: seen ? "Offline" : "Attachment unverified" };
}

// The Agents page when SLIRC_AGENTS_ENABLED=false: what agents are, that they are off here, and who
// turns them on. Admins get the env line to delete and the setup guide; members are sent to an admin.
export interface AgentsOffCopy { title: string; about: string; action: string; line?: string; link?: { href: string; label: string } }

export function agentsOffCopy(isAdmin: boolean): AgentsOffCopy {
  const title = "Agents are off on this instance";
  const about = "Agents are coding sessions, like Pi or Claude Code, that join your channels and DMs so you can talk to them from anywhere.";
  if (!isAdmin) return { title, about, action: "Ask an admin to turn them on." };
  return {
    title, about,
    action: "To turn them on, run sudo slirc env on the host and delete this line:",
    line: "SLIRC_AGENTS_ENABLED=false",
    link: { href: "/docs/setup#optional-environment-variables", label: "Instance settings guide" },
  };
}

export function parseCapability(value: unknown): AgentCapability {
  const raw = (value ?? {}) as Record<string, unknown>;
  const harnesses = (Array.isArray(raw.harnesses) ? raw.harnesses : []).flatMap((item) => {
    const harness = (item ?? {}) as Record<string, unknown>;
    return typeof harness.id === "string" && typeof harness.name === "string" && harness.name.trim() ? [{ id: harness.id, name: harness.name.trim(), ...(harness.terminal === true ? { terminal: true } : {}) }] : [];
  });
  const commands = (raw.commands && typeof raw.commands === "object" ? raw.commands : {}) as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" ? field.trim() : "");
  const session = (commands.session && typeof commands.session === "object" ? commands.session : {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    reason: text(raw.reason),
    harnesses,
    commands: {
      workspace: text(commands.workspace), npx: text(commands.npx), bunx: text(commands.bunx),
      session: Object.fromEntries(harnesses.flatMap(({ id }) => text(session[id]) ? [[id, text(session[id])]] : [])),
    },
  };
}

// The server sends epoch milliseconds. A missing, malformed, or nonpositive value is not an expiry:
// callers must treat null as a failed mint rather than inventing a window the server never granted.
export function normalizeExpiry(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function cleanAgent(value: unknown): AgentRow | null {
  const raw = (value ?? {}) as Record<string, unknown>;
  const nick = typeof raw.nick === "string" ? raw.nick.trim() : "";
  if (!nick) return null;
  const text = (field: unknown): string | undefined => (typeof field === "string" && field.trim() ? field.trim() : undefined);
  const agent = (raw.agent && typeof raw.agent === "object" ? raw.agent : {}) as Record<string, unknown>;
  return {
    nick,
    machine: text(raw.machine) ?? "",
    lastSeen: typeof raw.lastSeen === "string" || typeof raw.lastSeen === "number" ? raw.lastSeen : null,
    harness: text(agent.harness) ?? text(raw.harness),
    name: text(agent.name),
    sessionName: text(raw.sessionName),
    repo: text(agent.repo) ?? text(raw.repo),
    model: text(agent.model),
    worktree: text(raw.worktree),
    status: text(raw.status),
    readDms: raw.readDms === true,
  };
}

export function createAgentsPage(reactive: <T extends object>(value: T) => T, { core, session, openDm, onRows = () => {}, onRemoved = () => {} }: {
  core: Pick<ClientState, "authenticated" | "account">;
  session: ClientSession;
  openDm: (nick: string) => void;
  /** The raw /api/agents rows, so the sidebar and avatars learn the same agents. */
  onRows?: (rows: unknown[]) => void;
  onRemoved?: (nick: string) => void;
}) {
  let epoch = 0;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let invoker: HTMLElement | null = null;
  const local = reactive({
    loading: false,
    loaded: false,
    busy: false,
    error: "",
    capabilityError: "",
    capability: null as AgentCapability | null,
    rows: [] as AgentRow[],
    runner: (storage()?.getItem(RUNNER_KEY) === "npx" ? "npx" : "bunx") as "npx" | "bunx",
    copied: "" as "" | "first",
    codeInput: "",
    // The ticket in the copied command, and whether the page waits for that agent's request.
    ticket: null as { value: string; expiresAt: number } | null,
    waiting: false,
    card: null as ConnectCard | null,
    cardError: "",
    deciding: false,
    connected: "",
    removeTarget: null as Pick<AgentRow, "nick"> | null,
    renameTarget: null as AgentRow | null,
    renameValue: "",
    readDmsValue: false,
  });

  function owner() {
    const scope = session.scope();
    if (!scope || !core.authenticated || scope.account !== core.account || session.stopped() || session.signingOut()) return null;
    const key = session.key(), revision = epoch;
    return {
      current: () => epoch === revision && session.key() === key
        && session.scope()?.account === scope.account && core.authenticated && core.account === scope.account
        && !session.stopped() && !session.signingOut(),
    };
  }

  async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(path, { credentials: "same-origin", signal: AbortSignal.timeout(15_000), ...init });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status}).`);
    }
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  // The adapter reports its harness when it pairs, so the page only names the ones that work.
  // The harnesses Slirc offers, from the server's registry (released ones only): "Pi",
  // "Pi and Claude Code", "Pi, Claude Code and Codex". Each new harness joins by itself.
  function harnessList(): string {
    const names = (local.capability?.harnesses ?? []).map((harness) => harness.name);
    return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }

  // The separator before the harness at `index` in "Pi, Codex or Claude Code", a list `count` long.
  function harnessJoin(index: number, count = local.capability?.harnesses.length ?? 0): string {
    return index === 0 ? "" : index === count - 1 ? " or " : ", ";
  }

  // Harnesses the command is pasted into, and those it runs beside in a terminal (Codex).
  const pasteHarnesses = () => (local.capability?.harnesses ?? []).filter((harness) => !harness.terminal);
  const terminalHarnesses = () => (local.capability?.harnesses ?? []).filter((harness) => harness.terminal);

  const liveTicket = (now = Date.now()) => local.ticket && local.ticket.expiresAt - 30_000 > now ? local.ticket : null;

  // The command as copied: with the connect code once there is one, so what shows is what was copied.
  function firstLine(): string {
    const base = local.capability?.commands[local.runner] ?? "";
    const ticket = liveTicket();
    return base && ticket ? `${base} ${ticket.value}` : base;
  }

  function toggleRunner(): void {
    local.runner = local.runner === "npx" ? "bunx" : "npx";
    local.copied = "";
    storage()?.setItem(RUNNER_KEY, local.runner);
  }

  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  // The spinner gives way to the Use npx and Guide links after this. The ticket lives longer on the server (a
  // first install needs a reload before the session asks), so a late Allow card still opens.
  const WAIT_MS = 2 * 60_000;
  function stopWaiting(): void {
    local.waiting = false;
    if (waitTimer !== null) { clearTimeout(waitTimer); waitTimer = null; }
  }

  // A live ticket, minted when there is none. Without one the command still works: the session
  // shows its link and code, as before.
  async function ensureTicket(scope: { current(): boolean }): Promise<void> {
    if (liveTicket()) return;
    try {
      const body = await request("/api/agents/connect-ticket", { method: "POST", headers: { "Content-Type": "application/json", "X-Slirc-Connect": "1" }, body: "{}" });
      const expiresAt = normalizeExpiry(body.expiresAt);
      if (scope.current() && typeof body.ticket === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.ticket) && expiresAt) local.ticket = { value: body.ticket, expiresAt };
    } catch {}
  }

  // The session's request arrived on this owner's event stream, sent because it carried this
  // page's ticket. The ticket is spent.
  function showRequest(data: unknown): void {
    if (!owner()) return;
    const card = parseCard(data);
    if (!card) return;
    local.card = card;
    local.ticket = null;
    local.cardError = ""; local.connected = "";
    stopWaiting();
  }

  async function loadCapability(): Promise<AgentCapability | null> {
    try {
      const response = await fetch("/api/agents/capabilities", { credentials: "same-origin", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return null;
      return parseCapability(await response.json().catch(() => ({})));
    } catch {
      // No confirmed capability means no minting. The CLI-side redemption is never touched from here.
      return null;
    }
  }

  async function load(): Promise<void> {
    const scope = owner();
    if (!scope || local.loading || local.busy) return;
    local.loading = true; local.error = ""; local.capabilityError = ""; local.loaded = false;
    try {
      const capability = await loadCapability();
      if (!scope.current()) return;
      local.capability = capability;
      local.capabilityError = capability === null ? "Could not check whether connecting agents is available." : "";
      const body = await request("/api/agents");
      if (!scope.current()) return;
      const rows = Array.isArray(body) ? body : Array.isArray((body as { agents?: unknown }).agents) ? (body as { agents: unknown[] }).agents : null;
      if (!rows) throw new Error("Could not read agents.");
      local.rows = rows.map(cleanAgent).filter((row): row is AgentRow => row !== null).map(withPresence);
      local.loaded = true;
      onRows(rows);
      const token = peekConnectToken();
      if (token && !local.card) void openCard({ token });
    } catch (error) {
      if (scope.current()) local.error = error instanceof Error ? error.message : "Could not read agents.";
    } finally {
      if (scope.current()) local.loading = false;
    }
  }

  // Opens the Allow card from a link token or a typed code.
  async function openCard(by: { token?: string; code?: string }): Promise<void> {
    const scope = owner();
    if (!scope || local.busy) return;
    local.busy = true; local.cardError = ""; local.connected = "";
    if (by.token) storage()?.removeItem(TOKEN_KEY);
    try {
      const body = await request("/api/agents/requests/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(by) });
      if (!scope.current()) return;
      const card = parseCard(body);
      if (!card) throw new Error("Could not read this request.");
      local.card = card;
      local.codeInput = "";
    } catch (error) {
      if (scope.current()) local.cardError = error instanceof Error ? error.message : "Could not open this request.";
    } finally {
      if (scope.current()) local.busy = false;
    }
  }

  function submitCode(): void {
    const code = local.codeInput.trim();
    if (!code) { local.cardError = "Enter the 8-character code your terminal shows."; return; }
    void openCard({ code });
  }

  function cardTitle(card: ConnectCard): string {
    return [card.harnessName, card.sessionName].filter(Boolean).join(" · ") || "A coding session";
  }

  function cardSubtitle(card: ConnectCard): string {
    // The model is left out: it is the one at pairing time, and the session can switch it before Allow.
    return [card.repo, card.machine && card.machine !== "unknown" ? `on ${card.machine}` : ""].filter(Boolean).join(" · ");
  }

  async function decide(allow: boolean): Promise<void> {
    const scope = owner();
    const card = local.card;
    if (!scope || !card || local.deciding) return;
    local.deciding = true; local.cardError = "";
    try {
      const response = await fetch(`/api/agents/requests/${encodeURIComponent(card.id)}`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allow }), signal: AbortSignal.timeout(30_000),
      });
      if (!scope.current()) return;
      const body = await response.json().catch(() => ({})) as { error?: unknown; nick?: unknown };
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not answer this request.");
      local.card = null;
      if (allow) {
        local.connected = typeof body.nick === "string" ? body.nick : "";
        await load();
      }
    } catch (error) {
      if (scope.current()) local.cardError = error instanceof Error ? error.message : "Could not answer this request.";
    } finally {
      if (scope.current()) local.deciding = false;
    }
  }

  function dismissCard(): void { local.card = null; local.cardError = ""; }

  async function copy(): Promise<void> {
    const scope = owner();
    if (!scope || !firstLine()) return;
    // Safari keeps the clipboard only inside the click, so the text goes in as a promise that
    // settles once the ticket is minted. Elsewhere the plain write after minting is fine.
    const text = ensureTicket(scope).then(() => firstLine());
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((line) => new Blob([line], { type: "text/plain" })) })]);
      } else await navigator.clipboard.writeText(await text);
      if (!scope.current()) return;
      local.copied = "first";
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyTimer = null; if (local.copied === "first") local.copied = ""; }, 2_200);
      const ticket = liveTicket();
      if (!ticket) return;
      local.waiting = true;
      if (waitTimer !== null) clearTimeout(waitTimer);
      waitTimer = setTimeout(() => { waitTimer = null; local.waiting = false; local.ticket = null; }, Math.max(0, Math.min(WAIT_MS, ticket.expiresAt - Date.now())));
    } catch {
      if (scope.current()) local.error = "Could not copy. Select the command and copy it manually.";
    }
  }

  function openAgent(row: AgentRow): void {
    if (!owner() || local.busy) return;
    openDm(row.nick);
  }

  function agentTitle(row: AgentRow): string {
    return row.name || row.sessionName || row.nick;
  }

  // `repo · model`; without either, the nick under a display name, else the machine.
  function agentSubtitle(row: AgentRow): string {
    return repoModel(row) || (agentTitle(row) !== row.nick ? row.nick : row.machine);
  }

  // Live `agent-updated`: patch a listed row in place; an agent this page has not listed yet reloads it.
  // Live attachment from the server's agent-presence event. The list is loaded right after Allow,
  // before the session attaches, so without this the new row stays Offline until a reload.
  // The event can land before the row exists or while a list read from before the attach is in
  // flight (right after Allow), so the latest one per nick is kept and applied to every load.
  const seenPresence = new Map<string, boolean>();
  function withPresence(row: AgentRow): AgentRow {
    const attached = seenPresence.get(row.nick.toLowerCase());
    if (attached === undefined) return row;
    const key = agentStatus(row).key;
    if (attached && (key === "offline" || key === "unverified")) return { ...row, status: "ready" };
    if (!attached && key !== "offline" && key !== "unverified") return { ...row, status: "offline" };
    return row;
  }
  function setPresence(nick: string, attached: boolean): void {
    seenPresence.set(nick.toLowerCase(), attached);
    const index = local.rows.findIndex((row) => row.nick.toLowerCase() === nick.toLowerCase());
    if (index >= 0) local.rows[index] = withPresence(local.rows[index]!);
  }

  // Removed elsewhere (another device, an admin): drop the row without a reload.
  function dropRow(nick: string): void {
    local.rows = local.rows.filter((row) => row.nick.toLowerCase() !== nick.toLowerCase());
  }

  function applyUpdate(data: { nick: string; agent?: unknown }): void {
    if (!local.loaded || !owner()) return;
    const index = local.rows.findIndex((row) => row.nick.toLowerCase() === data.nick.toLowerCase());
    if (index < 0) { void load(); return; }
    const fresh = cleanAgent({ ...local.rows[index], agent: data.agent });
    if (fresh) local.rows[index] = { ...local.rows[index]!, ...Object.fromEntries(Object.entries(fresh).filter(([, value]) => value !== undefined && value !== "")) };
  }

  // Owner rename. The server shows it at once and syncs it into the session when it is attached.
  function askRename(row: AgentRow, button: HTMLElement): void {
    if (!owner() || local.busy) return;
    invoker = button;
    local.error = "";
    local.renameValue = agentTitle(row);
    local.readDmsValue = row.readDms === true;
    local.renameTarget = row;
  }

  function closeRename(): void {
    local.renameTarget = null;
    void Promise.resolve().then(() => {
      if (invoker?.isConnected && invoker.getClientRects().length) invoker.focus();
      invoker = null;
    });
  }

  async function confirmRename(): Promise<void> {
    const scope = owner(), target = local.renameTarget;
    if (!scope || !target || local.busy) return;
    local.busy = true; local.error = "";
    try {
      // "Can read my DMs" first: turning it off must not wait on a rename.
      if (local.readDmsValue !== (target.readDms === true)) {
        await request(`/api/agents/${encodeURIComponent(target.nick)}/read-dms`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Slirc-Agent": "1" }, body: JSON.stringify({ enabled: local.readDmsValue }),
        });
        if (!scope.current()) return;
        const index = local.rows.findIndex((row) => row.nick === target.nick);
        if (index >= 0) local.rows[index] = { ...local.rows[index]!, readDms: local.readDmsValue };
        target.readDms = local.readDmsValue;
      }
      const name = local.renameValue.trim().slice(0, 80);
      if (name !== agentTitle(target)) {
        const body = await request(`/api/agents/${encodeURIComponent(target.nick)}/name`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
        });
        if (!scope.current()) return;
        applyUpdate({ nick: target.nick, agent: body.agent });
      }
      closeRename();
    } catch (error) {
      if (scope.current()) local.error = error instanceof Error ? error.message : "Could not save agent settings.";
    } finally {
      if (scope.current()) local.busy = false;
    }
  }

  function askRemove(row: Pick<AgentRow, "nick">, button: HTMLElement): void {
    if (!owner() || local.busy) return;
    invoker = button;
    local.removeTarget = row;
  }

  function closeRemove(): void {
    local.removeTarget = null;
    void Promise.resolve().then(() => {
      if (invoker?.isConnected && invoker.getClientRects().length) invoker.focus();
      invoker = null;
    });
  }

  async function confirmRemove(): Promise<void> {
    const scope = owner(), target = local.removeTarget;
    if (!scope || !target || local.busy) return;
    local.busy = true; local.error = "";
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(target.nick)}`, { method: "DELETE", credentials: "same-origin", signal: AbortSignal.timeout(15_000) });
      if (!scope.current()) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : "Could not remove agent.");
      }
      local.rows = local.rows.filter((row) => row.nick !== target.nick);
      onRemoved(target.nick);
      closeRemove();
    } catch (error) {
      if (scope.current()) local.error = error instanceof Error ? error.message : "Could not remove agent.";
    } finally {
      if (scope.current()) local.busy = false;
    }
  }

  function dialogKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget as HTMLDialogElement;
    const controls = [...dialog.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)")].filter((control) => control.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  }

  function reset(): void {
    epoch += 1;
    if (copyTimer !== null) { clearTimeout(copyTimer); copyTimer = null; }
    stopWaiting();
    seenPresence.clear();
    invoker = null;
    local.loading = false; local.loaded = false; local.busy = false; local.error = "";
    local.capabilityError = "";
    local.capability = null; local.rows = [];
    local.copied = ""; local.codeInput = ""; local.ticket = null; local.card = null; local.cardError = ""; local.deciding = false; local.connected = "";
    local.removeTarget = null;
    local.renameTarget = null; local.renameValue = ""; local.readDmsValue = false;
  }

  function open(): void { void load(); }

  return Object.assign(local, {
    offCopy: agentsOffCopy,
    load, openCard, submitCode, cardTitle, cardSubtitle, decide, dismissCard, harnessList, harnessJoin, pasteHarnesses, terminalHarnesses, firstLine, toggleRunner, showRequest, copy, openAgent, agentTitle, agentSubtitle, applyUpdate, setPresence, dropRow, askRename, closeRename, confirmRename, askRemove, closeRemove, confirmRemove, dialogKeydown, open, reset, destroy: reset,
    status: agentStatus,
  });
}
