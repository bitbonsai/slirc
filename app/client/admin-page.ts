import { type ClientSession, type ClientState } from "@client/client-state.ts";

// Admin page: the ops-status.json a cron job on the host writes beside the database every five
// minutes, read through GET /api/admin/status. The public instance gets the whole file; a tenant
// gets only its own instance and certificates. statusView turns whatever is there into plain
// sections of label/value pairs and tables, so the markup stays a few x-for loops.
// Thresholds match the host status alert script where both check the same thing.
const CERT_BAD_DAYS = 14;
const CERT_WARN_DAYS = 21;
const BACKUP_BAD_HOURS = 26;
const LINKS_BAD_HOURS = 30;
const STALE_MINUTES = 15;

export type StatusTone = "" | "good" | "warn" | "bad" | "muted";
export interface StatusCell { text: string; tone: StatusTone }
export interface StatusTable { head: string[]; rows: StatusCell[][] }
export interface StatusSection {
  key: string;
  title: string;
  state: StatusCell | null;
  error: string;
  pairs: { term: string; value: StatusCell }[];
  tables: StatusTable[];
  notes: StatusCell[];
}
export interface StatusView { updated: StatusCell; sections: StatusSection[] }

type Raw = Record<string, any>;
type Series = Record<string, number> | undefined;

const cell = (text: unknown, tone: StatusTone = ""): StatusCell => ({ text: String(text), tone });
const failure = (part: unknown): string => part && typeof part === "object" && typeof (part as Raw).error === "string" ? (part as Raw).error : "";
const section = (key: string, title: string, rest: Partial<StatusSection> = {}): StatusSection =>
  ({ key, title, state: null, error: "", pairs: [], tables: [], notes: [], ...rest });

const hours = (h: number) => h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`;
const ago = (iso: unknown, now: number) => {
  const time = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(time)) return "never";
  const minutes = (now - time) / 60_000;
  return minutes < 60 ? `${Math.max(0, Math.round(minutes))} min ago` : `${hours(minutes / 60)} ago`;
};
const when = (iso: unknown) => typeof iso === "string" && iso ? iso.replace("T", " ").replace(/:\d\dZ$/, " UTC") : "unknown";
const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });
const dollars = (n: number) => !n ? "0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;

export function bytes(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`;
}

function dailyTable(days: string[], rows: [string, Series, ((n: number) => string)?, number?][]): StatusTable {
  return {
    head: ["UTC day", ...days.map(dayLabel), "7 days"],
    rows: rows.filter(([, series]) => series && typeof series === "object").map(([label, series, format = String, warnAbove]) => {
      const values = days.map((day) => Number(series![day]) || 0);
      const total = Object.values(series!).reduce((sum, value) => sum + (Number(value) || 0), 0);
      return [cell(label), ...values.map((value) => cell(format(value), warnAbove !== undefined && value > warnAbove ? "warn" : value ? "" : "muted")), cell(format(total))];
    }),
  };
}

function hostSection(host: Raw): StatusSection {
  const error = failure(host);
  if (error) return section("host", "Host", { error });
  const memUsed = host.mem_total - host.mem_available;
  const memShare = memUsed / host.mem_total;
  const diskShare = host.disk_used / host.disk_total;
  return section("host", "Host", { pairs: [
    { term: "Load", value: cell(`${(host.load ?? []).join(" ")} on ${host.cpus} CPUs`) },
    { term: "Memory", value: cell(`${bytes(memUsed)} of ${bytes(host.mem_total)} in use`, memShare > 0.9 ? "bad" : memShare > 0.75 ? "warn" : "") },
    { term: "Disk", value: cell(`${bytes(host.disk_used)} of ${bytes(host.disk_total)} (${Math.round(diskShare * 100)}%)`, diskShare > 0.9 ? "bad" : diskShare > 0.8 ? "warn" : "") },
    { term: "Up", value: cell(`${host.uptime_days} days`) },
  ] });
}

function certSection(certs: unknown, timer: unknown): StatusSection {
  const error = failure(certs);
  if (error || !Array.isArray(certs)) return section("certs", "Certificates", { error: error || "missing" });
  const rows = certs.map((cert: Raw) => {
    const where = cell(`${cert.host}:${cert.port}`);
    if (cert.error) return [where, cell(cert.error, "bad"), cell("")];
    const tone = cert.days_left < CERT_BAD_DAYS ? "bad" : cert.days_left < CERT_WARN_DAYS ? "warn" : "good";
    return [where, cell(String(cert.expires ?? "").slice(0, 10)), cell(`${Math.floor(cert.days_left)} days`, tone)];
  });
  const notes: StatusCell[] = [];
  if (timer && typeof timer === "object") {
    const timerError = failure(timer);
    const raw = timer as Raw;
    notes.push(timerError
      ? cell(`Ergo certificate copy unavailable: ${timerError}`, "bad")
      : cell(`Ergo certificate copy: ${raw.result || "unknown"}, last run ${raw.last_run || "never"}`, raw.result === "success" ? "good" : "bad"));
  }
  return section("certs", "Certificates", { tables: [{ head: ["Where", "Expires", "Left"], rows }], notes });
}

function jobsSection(status: Raw, now: number): StatusSection {
  const links = status.links_sync;
  let value = cell("no run recorded", "warn");
  if (failure(links)) value = cell(`unavailable: ${failure(links)}`, "bad");
  else if (links) value = cell(`${ago(links.last_run, now)}, ${links.found} links found`, links.age_hours > LINKS_BAD_HOURS ? "bad" : "good");
  const pairs: { term: string; value: StatusCell }[] = [{ term: "Links sync", value }];
  if (status.checkouts && !failure(status.checkouts) && typeof status.checkouts === "object") {
    for (const [name, rev] of Object.entries(status.checkouts as Record<string, unknown>)) {
      pairs.push({ term: `Checkout (${name})`, value: cell(rev || "unknown") });
    }
  }
  return section("jobs", "Jobs and checkouts", { pairs });
}

function backupValue(backup: Raw | null | undefined): StatusCell {
  if (!backup) return cell("no daily backup", "bad");
  if (failure(backup)) return cell(`unavailable: ${failure(backup)}`, "bad");
  if (typeof backup.age_hours !== "number") return cell("folder exists, no copy", "bad");
  return cell(`${hours(backup.age_hours)} ago, ${bytes(backup.newest_bytes)}; ${backup.copies} copies, ${bytes(backup.total_bytes)} in all`,
    backup.age_hours > BACKUP_BAD_HOURS ? "bad" : "good");
}

function instanceSection(instance: Raw, index: number, days: string[], now: number): StatusSection {
  const key = `instance-${index}`;
  const error = failure(instance);
  if (error) return section(key, instance.host || "Instance", { error });
  const up = instance.state === "running" && instance.healthy;
  const today = days[days.length - 1] ?? "";
  const mailToday = Number(instance.mail?.[today]) || 0;
  const mailTone = mailToday >= instance.mail_limit ? "bad" : mailToday >= instance.mail_warn ? "warn" : "";
  return section(key, instance.host || "Instance", {
    state: cell(up ? "up" : `down (${instance.state}${instance.healthy ? "" : ", health check failed"})`, up ? "good" : "bad"),
    pairs: [
      { term: "Commit", value: instance.commit ? cell(instance.commit) : cell("unknown", "warn") },
      { term: "Started", value: cell(`${when(instance.started)}, ${ago(instance.started, now)}`) },
      { term: "Members", value: cell(instance.members_total ?? "unknown") },
      { term: "Mail today", value: instance.mail ? cell(`${mailToday} of ${instance.mail_limit} (warning at ${instance.mail_warn})`, mailTone) : cell("not counted by this version", "muted") },
      { term: "Backup", value: backupValue(instance.backup) },
    ],
    tables: [dailyTable(days, [
      ["Messages by people", instance.messages],
      ["Active people", instance.members],
      ["Messages by helpers and agents", instance.bot_messages],
      ["Errors and warnings", instance.errors, String, 0],
      ["Mail sent", instance.mail],
      ["Mail refused", instance.mail_refused, String, 0],
      ["Helper spend", instance.help_usd, dollars],
    ])],
  });
}

function waitlistSection(waitlists: unknown, days: string[]): StatusSection {
  const error = failure(waitlists);
  if (error || !Array.isArray(waitlists)) return section("waitlists", "Waiting lists", { error: error || "missing" });
  const ok = waitlists.filter((list: Raw) => !list.error);
  return section("waitlists", "Waiting lists", {
    tables: ok.length ? [dailyTable(days, [
      ...ok.map((list: Raw): [string, Series] => [`${list.name} signups (${list.total} in all)`, list.signups]),
      ...ok.map((list: Raw): [string, Series, (n: number) => string, number] => [`${list.name} errors`, list.errors, String, 0]),
    ])] : [],
    notes: waitlists.filter((list: Raw) => list.error).map((list: Raw) => cell(`${list.name || "Waiting list"} unavailable: ${list.error}`, "bad")),
  });
}

function containersSection(containers: unknown, now: number): StatusSection {
  const error = failure(containers);
  if (error || !Array.isArray(containers)) return section("containers", "Containers", { error: error || "missing" });
  return section("containers", "Containers", { tables: [{
    head: ["Name", "State", "CPU", "Memory", "Started", "Restarts"],
    rows: containers.map((c: Raw) => [
      cell(c.name), cell(c.state, c.state === "running" ? "good" : "bad"), cell(c.cpu ?? "-"), cell(c.mem ?? "-"),
      cell(ago(c.started, now)), cell(c.restarts ?? 0, c.restarts ? "warn" : "muted"),
    ]),
  }] });
}

// Only what the file has is shown: a tenant file has no host, waiting lists, containers or jobs.
export function statusView(status: Raw, now = Date.now()): StatusView {
  const generated = typeof status.generated_at === "string" ? Date.parse(status.generated_at) : NaN;
  const stale = !Number.isFinite(generated) || (now - generated) / 60_000 > STALE_MINUTES;
  const updated = Number.isFinite(generated)
    ? cell(`Updated ${ago(status.generated_at, now)}, ${when(status.generated_at)}${stale ? ". The collector has stopped." : ""}`, stale ? "bad" : "muted")
    : cell("The status file has no update time.", "bad");
  const days: string[] = Array.isArray(status.days) ? status.days : [];
  const sections: StatusSection[] = [];
  if ("host" in status) sections.push(hostSection(status.host));
  if ("certs" in status) sections.push(certSection(status.certs, status.cert_timer));
  if ("links_sync" in status || "checkouts" in status) sections.push(jobsSection(status, now));
  if (failure(status.instances)) sections.push(section("instances", "Instances", { error: failure(status.instances) }));
  else if (Array.isArray(status.instances)) status.instances.forEach((instance: Raw, index: number) => sections.push(instanceSection(instance, index, days, now)));
  if ("waitlists" in status) sections.push(waitlistSection(status.waitlists, days));
  if ("containers" in status) sections.push(containersSection(status.containers, now));
  return { updated, sections };
}

// One agent as the admin agent list shows it: whose it is and where it can read.
export interface AdminAgent { nick: string; owner: string; name: string; harness: string; status: string; channels: string[] }

export function cleanAdminAgent(value: unknown): AdminAgent | null {
  const raw = (value ?? {}) as Raw;
  const text = (field: unknown) => (typeof field === "string" ? field.trim() : "");
  const nick = text(raw.nick);
  if (!nick) return null;
  return { nick, owner: text(raw.owner), name: text(raw.name) || nick, harness: text(raw.harness), status: raw.status === "ready" ? "ready" : "offline",
    channels: Array.isArray(raw.channels) ? raw.channels.filter((item: unknown): item is string => typeof item === "string") : [] };
}

export function adminAgentSubtitle(agent: AdminAgent): string {
  const where = agent.channels.length ? agent.channels.join(", ") : "DM only";
  return [agent.name !== agent.nick ? agent.nick : "", agent.owner ? `${agent.owner}'s` : "", where].filter(Boolean).join(" · ");
}

// One script bot as the admin Bots list shows it. The password is never part of the list: it
// comes back once from create or rotate and lives only in `credential` until Done.
export interface AdminBot { nick: string; lastSeen: number | null }
export interface BotCredential { nick: string; password: string; rotated: boolean }

export function cleanAdminBot(value: unknown): AdminBot | null {
  const raw = (value ?? {}) as Raw;
  const nick = typeof raw.nick === "string" ? raw.nick.trim() : "";
  return nick ? { nick, lastSeen: typeof raw.lastSeen === "number" ? raw.lastSeen : null } : null;
}

export function botSubtitle(bot: AdminBot, now = Date.now()): string {
  return `/invite @${bot.nick} · ${bot.lastSeen ? `last seen ${ago(new Date(bot.lastSeen).toISOString(), now)}` : "never connected"}`;
}

// The bot routes refuse writes without these, so a forged cross-site form cannot mint a password.
const BOT_WRITE = { credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Slirc-Bots": "1" } } as const;

async function botRequest(url: string, init: RequestInit, fallback: string): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body && typeof body.error === "string" ? body.error : fallback);
  return body;
}

export function createAdminPage(reactive: <T extends object>(value: T) => T, { core, session }: {
  core: Pick<ClientState, "authenticated" | "account">;
  session: ClientSession;
}) {
  let epoch = 0;
  const local = reactive({
    loading: false,
    loaded: false,
    error: "",
    view: null as StatusView | null,
    agents: [] as AdminAgent[],
    agentsLoaded: false,
    agentsError: "",
    removeTarget: null as AdminAgent | null,
    removing: false,
    bots: [] as AdminBot[],
    botsLoaded: false,
    botsError: "",
    botLimit: 3,
    botsUsed: 0,
    botName: "",
    botBusy: "",
    credential: null as BotCredential | null,
    copied: false,
    botRemoveTarget: null as AdminBot | null,
  });
  let botsEpoch = 0;
  let agentsEpoch = 0;
  let invoker: HTMLElement | null = null;

  async function loadAgents(): Promise<void> {
    const scope = session.scope();
    if (!scope || !core.authenticated || scope.account !== core.account) return;
    const revision = ++agentsEpoch;
    try {
      const response = await fetch("/api/admin/agents", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => null);
      if (revision !== agentsEpoch || core.account !== scope.account) return;
      if (!response.ok) throw new Error(body && typeof body.error === "string" ? body.error : `Request failed (${response.status}).`);
      local.agents = (Array.isArray(body) ? body : []).map(cleanAdminAgent).filter((agent): agent is AdminAgent => agent !== null);
      local.agentsLoaded = true; local.agentsError = "";
    } catch (error) {
      if (revision === agentsEpoch) local.agentsError = error instanceof Error ? error.message : "Could not load agents.";
    }
  }

  function askRemoveAgent(agent: AdminAgent, button: HTMLElement): void {
    invoker = button; local.agentsError = ""; local.removeTarget = agent;
  }

  function closeRemoveAgent(): void {
    local.removeTarget = null;
    void Promise.resolve().then(() => { if (invoker?.isConnected) invoker.focus(); invoker = null; });
  }

  async function confirmRemoveAgent(): Promise<void> {
    const target = local.removeTarget;
    if (!target || local.removing) return;
    local.removing = true; local.agentsError = "";
    try {
      const response = await fetch(`/api/admin/agents/${encodeURIComponent(target.nick)}`, { method: "DELETE", credentials: "same-origin", signal: AbortSignal.timeout(15_000) });
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : "Could not remove agent.");
      }
      local.agents = local.agents.filter((agent) => agent.nick !== target.nick);
      closeRemoveAgent();
    } catch (error) {
      local.agentsError = error instanceof Error ? error.message : "Could not remove agent.";
    } finally {
      local.removing = false;
    }
  }

  const botFailed = (error: unknown, fallback: string) => { local.botsError = error instanceof Error ? error.message : fallback; };

  async function loadBots(): Promise<void> {
    const scope = session.scope();
    if (!scope || !core.authenticated || scope.account !== core.account) return;
    const revision = ++botsEpoch;
    try {
      const body = await botRequest("/api/bots", { credentials: "same-origin", cache: "no-store" }, "Could not load bots.");
      if (revision !== botsEpoch || core.account !== scope.account) return;
      local.bots = (Array.isArray(body.bots) ? body.bots : []).map(cleanAdminBot).filter((bot: AdminBot | null): bot is AdminBot => bot !== null);
      local.botLimit = Number.isSafeInteger(body.limit) ? body.limit : 3;
      local.botsUsed = Number.isSafeInteger(body.used) ? body.used : 0;
      local.botsLoaded = true; local.botsError = "";
    } catch (error) {
      if (revision === botsEpoch) botFailed(error, "Could not load bots.");
    }
  }

  async function createBot(): Promise<void> {
    const name = local.botName.trim();
    if (!name || local.botBusy) return;
    local.botBusy = "create"; local.botsError = "";
    try {
      const body = await botRequest("/api/bots", { ...BOT_WRITE, method: "POST", body: JSON.stringify({ name }) }, "Could not create the bot.");
      local.botName = "";
      local.credential = { nick: body.nick, password: body.password, rotated: false };
      local.copied = false;
      await loadBots();
    } catch (error) { botFailed(error, "Could not create the bot."); } finally { local.botBusy = ""; }
  }

  async function rotateBot(bot: AdminBot): Promise<void> {
    if (local.botBusy) return;
    local.botBusy = `rotate:${bot.nick}`; local.botsError = "";
    try {
      const body = await botRequest(`/api/bots/${encodeURIComponent(bot.nick)}/rotate`, { ...BOT_WRITE, method: "POST" }, "Could not make a new password.");
      local.credential = { nick: body.nick, password: body.password, rotated: true };
      local.copied = false;
    } catch (error) { botFailed(error, "Could not make a new password."); } finally { local.botBusy = ""; }
  }

  async function copyCredential(): Promise<void> {
    if (!local.credential) return;
    try { await navigator.clipboard.writeText(local.credential.password); local.copied = true; } catch { /* the password stays selectable */ }
  }

  // Done forgets the password for good; the only way to see one again is a new password.
  function closeCredential(): void {
    local.credential = null; local.copied = false;
    void Promise.resolve().then(() => document.querySelector<HTMLInputElement>("#admin-bot-name")?.focus());
  }

  function askRemoveBot(bot: AdminBot, button: HTMLElement): void {
    invoker = button; local.botsError = ""; local.botRemoveTarget = bot;
  }

  function closeRemoveBot(): void {
    local.botRemoveTarget = null;
    void Promise.resolve().then(() => { if (invoker?.isConnected) invoker.focus(); invoker = null; });
  }

  async function confirmRemoveBot(): Promise<void> {
    const target = local.botRemoveTarget;
    if (!target || local.botBusy) return;
    local.botBusy = `remove:${target.nick}`; local.botsError = "";
    try {
      await botRequest(`/api/bots/${encodeURIComponent(target.nick)}`, { ...BOT_WRITE, method: "DELETE" }, "Could not remove the bot.").catch((error) => {
        if (!/not found/i.test(String(error?.message))) throw error;
      });
      local.bots = local.bots.filter((bot) => bot.nick !== target.nick);
      if (local.credential?.nick === target.nick) local.credential = null;
      // The row is gone, so focus lands on the name field instead of the removed button.
      invoker = document.querySelector<HTMLElement>("#admin-bot-name");
      closeRemoveBot();
      void loadBots();
    } catch (error) { botFailed(error, "Could not remove the bot."); } finally { local.botBusy = ""; }
  }

  async function load(): Promise<void> {
    // The button is disabled while a request runs, and that request always clears `loading` below.
    if (local.loading) return;
    const scope = session.scope();
    // Refresh never does nothing: without a live session for this account, say why.
    if (!scope || !core.authenticated || scope.account !== core.account || session.stopped() || session.signingOut()) {
      local.error = "Your session has ended. Reload the page to see the status.";
      return;
    }
    const revision = ++epoch, key = session.key();
    const current = () => epoch === revision && session.key() === key && core.authenticated && core.account === scope.account;
    local.loading = true; local.error = "";
    try {
      // The answer takes a few milliseconds; hold "Refreshing…" long enough to be seen.
      const [response] = await Promise.all([
        fetch("/api/admin/status", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) }),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
      const body = await response.json().catch(() => ({})) as { status?: unknown; error?: unknown };
      if (!current()) return;
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status}).`);
      local.view = body.status && typeof body.status === "object" ? statusView(body.status as Raw) : null;
      local.loaded = true;
      if (body.error === "unreadable") local.error = "The status file could not be read.";
    } catch (error) {
      if (current()) local.error = error instanceof Error ? error.message : "Could not load the status.";
    } finally {
      // The newest request clears `loading` even when the session changed under it, so the button
      // never stays on "Refreshing…". A reset already cleared it and bumped the epoch.
      if (epoch === revision) local.loading = false;
    }
  }

  function reset(): void {
    epoch += 1;
    local.loading = false; local.loaded = false; local.error = ""; local.view = null;
    agentsEpoch += 1; invoker = null;
    local.agents = []; local.agentsLoaded = false; local.agentsError = ""; local.removeTarget = null; local.removing = false;
    botsEpoch += 1;
    local.bots = []; local.botsLoaded = false; local.botsError = ""; local.botName = ""; local.botBusy = "";
    local.credential = null; local.copied = false; local.botRemoveTarget = null;
  }

  // Tab and Shift+Tab stay on the dialog's enabled controls.
  function dialogKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget as HTMLDialogElement;
    const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled)")].filter((control) => control.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  }

  function open(): void { void load(); void loadAgents(); void loadBots(); }

  return Object.assign(local, { load, loadAgents, loadBots, createBot, rotateBot, copyCredential, closeCredential, askRemoveBot, closeRemoveBot, confirmRemoveBot, botSubtitle: (bot: AdminBot) => botSubtitle(bot), askRemoveAgent, closeRemoveAgent, confirmRemoveAgent, dialogKeydown, agentSubtitle: adminAgentSubtitle, open, reset, destroy: reset });
}
