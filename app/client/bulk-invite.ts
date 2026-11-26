// "Invite many" for admins: paste a list or drop a CSV, check what each row will do, then send in
// batches. The server sorts every row (POST /api/invites/bulk with preview: true) and owns every
// rule; this file only reads the list, keeps names for display and shows progress.
import { type ClientSession, type ClientState } from "@client/client-state.ts";

export const BULK_MAX = 1000;
export const BULK_BATCH = 25;

export type BulkStatus = "invalid" | "duplicate" | "self" | "existing" | "add" | "pending" | "new"
  | "invited" | "added" | "failed" | "uncertain" | "held" | "waiting";
export type BulkEntry = { email: string; name: string };
export type BulkRow = BulkEntry & { status: BulkStatus; nick?: string; error?: string };

const EMAILISH = /[^\s<>"',;]+@[^\s<>"',;]+/;

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === "," || char === ";" || char === "\t") { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

// Reads pasted text or a CSV file. Any cell with an @ is an address ("Ada <ada@x.io>" works too);
// the first other cell on the same line is the name. Several addresses on one line each get a row,
// without a name. A first line with no @ is a header and is skipped; any later line with no @ is
// kept as typed, so the server marks it "Not an email" instead of it vanishing. Blank lines go.
export function parseInviteList(text: string): BulkEntry[] {
  const entries: BulkEntry[] = [];
  let first = true;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.replace(/[,;\t"\s]/g, "")) continue;
    const header = first;
    first = false;
    if (!line.includes("@")) {
      if (!header) entries.push({ email: line.trim().slice(0, 254), name: "" });
      continue;
    }
    const cells = splitCsvLine(line).flatMap((cell) => cell.includes("@") && /\s/.test(cell) && !/<[^>]+>/.test(cell) ? cell.split(/\s+/) : [cell]).filter(Boolean);
    const addresses: Array<{ email: string; name: string }> = [];
    const names: string[] = [];
    for (const cell of cells) {
      const angle = cell.match(/^(.*?)<([^>]+)>\s*$/);
      if (angle) { addresses.push({ email: angle[2].trim(), name: angle[1].replace(/^["'\s]+|["'\s]+$/g, "") }); continue; }
      if (cell.includes("@")) addresses.push({ email: (cell.match(EMAILISH)?.[0] || cell).replace(/^mailto:/i, ""), name: "" });
      else names.push(cell);
    }
    const lineName = addresses.length === 1 ? names[0] || "" : "";
    for (const address of addresses) entries.push({ email: address.email, name: (address.name || lineName).slice(0, 80) });
  }
  return entries;
}

export function bulkStatusLabel(status: BulkStatus, channel: string): string {
  return ({
    new: "Gets an invite", add: `Added to ${channel}`, existing: `Already in ${channel}`, pending: "Already invited",
    duplicate: "Listed twice", invalid: "Not an email", self: "That's you",
    invited: "Invite sent", added: `Added to ${channel}`, failed: "Didn't send", uncertain: "May have sent",
    held: "Held for tomorrow", waiting: "Waiting",
  } as Record<BulkStatus, string>)[status];
}

export const bulkStatusTone = (status: BulkStatus) =>
  status === "new" || status === "invited" ? "go" : status === "add" || status === "added" ? "add"
    : status === "invalid" || status === "failed" || status === "uncertain" ? "bad" : status === "held" ? "held" : "quiet";

// Counts for the status bar, in a fixed order so the bar never reshuffles while sending.
const ORDER: BulkStatus[] = ["new", "invited", "add", "added", "held", "failed", "uncertain", "pending", "existing", "duplicate", "self", "invalid", "waiting"];
export function bulkCounts(rows: readonly BulkRow[]): Array<{ status: BulkStatus; count: number }> {
  return ORDER.map((status) => ({ status, count: rows.filter((row) => row.status === status).length })).filter((item) => item.count);
}

const actionable = (row: BulkRow) => row.status === "new" || row.status === "add";
const key = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
const HEADERS = { "Content-Type": "application/json", "X-Slirc-Invitation": "1" };

export function createBulkInvite(reactive: <T extends object>(value: T) => T, { core, session, nextTick }: {
  core: Pick<ClientState, "authenticated" | "isAdmin" | "defaultChannel" | "channels" | "openRooms">;
  session: ClientSession;
  nextTick: (callback?: () => void) => Promise<void>;
}) {
  let invoker: HTMLElement | null = null;
  const local = reactive({
    step: "list" as "list" | "preview" | "sending" | "done",
    destination: "",
    text: "",
    fileName: "",
    dragging: false,
    rows: [] as BulkRow[],
    channel: "",
    mailRoom: 0,
    busy: false,
    error: "",
    sent: 0,
    total: 0,
    copied: false,
  });
  const dialog = () => typeof document === "undefined" ? null : document.querySelector<HTMLDialogElement>("#bulk-invite-dialog");
  const inScope = (scope: string) => session.key() === scope && !session.stopped() && core.authenticated;

  function reset(): void {
    if (dialog()?.open) dialog()!.close();
    local.step = "list"; local.destination = ""; local.text = ""; local.fileName = ""; local.dragging = false;
    local.rows = []; local.channel = ""; local.mailRoom = 0; local.busy = false; local.error = ""; local.sent = 0; local.total = 0; local.copied = false;
  }

  // channel: preselect it; empty means the workspace's default channel when there is one.
  function open(event?: Event, channel = ""): void {
    if (!core.authenticated || !core.isAdmin) return;
    invoker = (event?.currentTarget as HTMLElement | null) ?? (typeof document !== "undefined" ? document.activeElement as HTMLElement | null : null);
    reset();
    // A channel from the caller only if it can take invites here; otherwise the workspace's default
    // channel, or the first channel when there is no default.
    const known = destinations().some((item) => item.wireTarget.toLowerCase() === channel.toLowerCase());
    local.destination = known ? channel : core.defaultChannel ? "" : destinations()[0]?.wireTarget || "";
    void nextTick(() => {
      dialog()?.showModal();
      document.querySelector<HTMLTextAreaElement>("#bulk-invite-text")?.focus();
    });
  }

  function close(): void {
    if (local.busy) return;
    reset();
    if (invoker?.isConnected) invoker.focus();
    invoker = null;
  }

  // Channels an admin can invite into: not open channels (anyone can join those), groups, DMs or threads.
  // The default channel is the workspace option, so it is not listed a second time.
  const destinations = () => (core.channels as Array<{ wireTarget: string }>)
    .filter((item) => item.wireTarget?.startsWith("#") && !core.openRooms[item.wireTarget] && !/^#(dm-|t-|g-)/i.test(item.wireTarget)
      && item.wireTarget.toLowerCase() !== core.defaultChannel.toLowerCase());
  // The picker shows only with a real choice: the workspace and at least one channel, or several channels.
  const choosesDestination = () => (core.defaultChannel ? 1 : 0) + destinations().length > 1;
  const entries = () => parseInviteList(local.text);
  const entryCount = () => entries().length;
  const destinationBody = () => local.destination ? { channel: local.destination } : { workspace: true };

  async function readFile(file: File | null | undefined): Promise<void> {
    if (!file) return;
    if (file.size > 2_000_000) { local.error = "That file is too big. Use a CSV under 2 MB."; return; }
    local.error = "";
    const text = await file.text();
    local.fileName = file.name;
    // Added below a pasted list, the file's header row would no longer be the first line: drop it.
    const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const body = local.text.trim() && rows[0] && !rows[0].includes("@") ? rows.slice(1).join("\n") : text;
    local.text = local.text.trim() ? `${local.text.trim()}\n${body}` : body;
  }

  function drop(event: DragEvent): void {
    local.dragging = false;
    void readFile(event.dataTransfer?.files?.[0]);
  }

  async function check(): Promise<void> {
    const list = entries();
    if (local.busy) return;
    if (!list.length) { local.error = "Paste at least one email address."; return; }
    if (list.length > BULK_MAX) { local.error = `Up to ${BULK_MAX} addresses at a time. This list has ${list.length}.`; return; }
    const scope = session.key();
    local.busy = true; local.error = "";
    try {
      const response = await fetch("/api/invites/bulk", { method: "POST", credentials: "same-origin", headers: HEADERS,
        body: JSON.stringify({ preview: true, destination: destinationBody(), emails: list.map((entry) => entry.email) }) });
      const body = await response.json().catch(() => ({}));
      if (!inScope(scope)) return;
      if (!response.ok || !Array.isArray(body.rows)) throw new Error(body.error || "Could not check the list.");
      local.channel = body.channel;
      local.mailRoom = Number(body.mailRoom) || 0;
      local.rows = body.rows.map((row: any, index: number) => ({ ...row, name: list[index]?.name || "" }));
      local.step = "preview";
    } catch (error) {
      if (inScope(scope)) local.error = error instanceof Error ? error.message : "Could not check the list.";
    } finally {
      if (inScope(scope)) local.busy = false;
    }
  }

  const toSend = () => local.rows.filter(actionable);
  const newCount = () => local.rows.filter((row) => row.status === "new").length;
  const addCount = () => local.rows.filter((row) => row.status === "add").length;
  const heldAhead = () => Math.max(0, newCount() - local.mailRoom);

  function sendLabel(): string {
    const invites = Math.min(newCount(), local.mailRoom);
    const parts = [invites ? `${invites} invite${invites === 1 ? "" : "s"}` : "", addCount() ? `add ${addCount()}` : ""].filter(Boolean);
    return parts.length ? `Send ${parts.join(", ")}` : "Nothing to send";
  }

  async function send(): Promise<void> {
    if (local.busy) return;
    const pending = toSend();
    if (!pending.length) return;
    const scope = session.key();
    local.busy = true; local.error = ""; local.step = "sending"; local.sent = 0; local.total = pending.length;
    const before = new Map(pending.map((row) => [row, row.status]));
    for (const row of pending) row.status = "waiting";
    try {
      for (let start = 0; start < pending.length; start += BULK_BATCH) {
        const batch = pending.slice(start, start + BULK_BATCH);
        const response = await fetch("/api/invites/bulk", { method: "POST", credentials: "same-origin", headers: { ...HEADERS, "Idempotency-Key": key() },
          body: JSON.stringify({ destination: destinationBody(), emails: batch.map((row) => row.email) }) });
        const body = await response.json().catch(() => ({}));
        if (!inScope(scope)) return;
        if (!response.ok || !Array.isArray(body.rows)) throw new Error(body.error || "Sending stopped.");
        body.rows.forEach((result: any, index: number) => {
          const row = batch[index];
          if (!row) return;
          row.status = result.status; row.nick = result.nick; row.error = result.error;
        });
        local.mailRoom = Number(body.mailRoom) || 0;
        local.sent = Math.min(pending.length, start + batch.length);
      }
    } catch (error) {
      if (inScope(scope)) {
        local.error = error instanceof Error ? error.message : "Sending stopped.";
        // Whatever never reached the server goes back to what it was, so Send picks it up again.
        for (const row of pending) if (row.status === "waiting") row.status = before.get(row)!;
      }
    } finally {
      if (inScope(scope)) { local.busy = false; local.step = "done"; }
    }
  }

  const leftover = () => local.rows.filter((row) => ["failed", "uncertain", "held", "new", "add"].includes(row.status));
  async function copyLeftover(): Promise<void> {
    try { await navigator.clipboard.writeText(leftover().map((row) => row.email).join("\n")); local.copied = true; }
    catch { local.copied = false; }
  }

  function back(): void {
    if (local.busy) return;
    local.step = "list"; local.rows = []; local.error = "";
    void nextTick(() => document.querySelector<HTMLTextAreaElement>("#bulk-invite-text")?.focus());
  }

  const progress = () => local.total ? Math.round((local.sent / local.total) * 100) : 0;
  const counts = () => bulkCounts(local.rows);
  const label = (status: BulkStatus) => bulkStatusLabel(status, local.channel);
  const tone = bulkStatusTone;

  return Object.assign(local, {
    destinations, choosesDestination, open, close, reset, destroy: reset, readFile, drop, check, send, back, copyLeftover,
    entryCount, toSend, newCount, addCount, heldAhead, sendLabel, leftover, progress, counts, label, tone,
  });
}
