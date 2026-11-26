import { type ClientSession, type ClientState } from "@client/client-state.ts";

// One owner-scoped page of sent email invitations. Read/resend/cancel only; membership and
// conversations are never torn down here. A transport failure on resend keeps its idempotency key
// so a retry replays the stored outcome rather than sending another email.
export interface InvitationRow {
  id: string;
  recipientEmail: string;
  destination: { type?: string; channel?: string | null };
  status: string;
  createdAt?: number;
  expiresAt?: number;
  sends?: number;
}

export function invitationStatusLabel(status: string): string {
  switch (status) {
    case "pending": return "Pending";
    case "sending": return "Sending…";
    case "accepted": return "Accepted";
    case "expired": return "Expired";
    case "cancelled": return "Cancelled";
    case "failed": return "Delivery failed";
    case "uncertain": return "Delivery uncertain";
    default: return status;
  }
}

export function invitationDestinationLabel(row: Pick<InvitationRow, "destination">): string {
  const type = row.destination?.type;
  if (type === "dm" || !row.destination?.channel) return "Direct message";
  return row.destination.channel;
}

export function canResendInvitation(status: string): boolean {
  // Sending/uncertain delivery must not be resent blindly; the server refuses and the UI hides it.
  return status !== "accepted" && status !== "cancelled" && status !== "sending" && status !== "uncertain";
}

export function canCancelInvitation(status: string): boolean {
  return status !== "accepted" && status !== "cancelled";
}

// A processing 409, malformed body or 5xx is ambiguous: keep the idempotency key so a retry only
// retrieves the original operation instead of sending a fresh invitation email.
export function resendOutcomeIsRecorded(status: number, body: unknown): boolean {
  const parsed = body && typeof body === "object" ? body as Record<string, unknown> : null;
  if (!parsed) return false;
  if (status >= 200 && status < 300) return true;
  if (status === 400 || status === 403 || status === 404 || status === 429) return true;
  if (status === 409) return !/still being recovered/i.test(String(parsed.error || ""));
  return false;
}

export function invitationDate(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch { return ""; }
}

// A join link, as the server lists it. url is null for links made before their token was kept,
// and once a link is revoked or expires.
export interface JoinLinkRow { id: string; channel: string; joins: number; maxJoins: number; expiresAt: number; revoked: boolean; state: "open" | "full" | "spent" | "closed"; url?: string | null }
const JOIN_HEADERS = { "Content-Type": "application/json", "X-Slirc-Join": "1" };

// Past items fold away behind "Show past": revoked or expired links, and invitations that were
// accepted, cancelled or expired (an expired one keeps its Resend and Cancel).
export function isPastJoinLink(link: JoinLinkRow): boolean { return link.revoked || link.state === "closed"; }
export function isPastInvitation(row: { status: string }): boolean { return row.status === "accepted" || row.status === "cancelled" || row.status === "expired"; }

const shortDate = (value: number) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function joinLinkDetail(link: JoinLinkRow): string {
  const joined = `${link.joins} of ${link.maxJoins} joined`;
  if (link.revoked) return joined;
  if (link.state === "closed") return `${joined} · closed ${shortDate(link.expiresAt)}`;
  if (link.state === "full") return `${joined} · full`;
  if (link.state === "spent") return `${joined} · mail limit reached, make a new link`;
  return `${joined} · closes ${shortDate(link.expiresAt)}`;
}

// Width of the places-taken bar, in percent.
export function joinLinkProgress(link: JoinLinkRow): number {
  return link.maxJoins > 0 ? Math.min(100, Math.round((link.joins / link.maxJoins) * 100)) : 0;
}

// What the fresh link reads as: the workspace and the start of the token, never cut mid-word.
// Copy puts the whole URL on the clipboard.
export function joinLinkDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    const token = parsed.pathname.split("/").pop() || "";
    return `${parsed.host}/j/${token.slice(0, 8)}…`;
  } catch { return url; }
}
// An open link from before tokens were kept: no Copy, and a hint to make a new one.
export function joinLinkUncopyable(link: JoinLinkRow): boolean { return !isPastJoinLink(link) && !link.url; }
export function joinLinkPill(link: JoinLinkRow): string { return link.revoked ? "Revoked" : link.state === "closed" ? "Expired" : ""; }

export function createInvitationsPage(reactive: <T extends object>(value: T) => T, { core, session }: {
  core: Pick<ClientState, "authenticated">;
  session: ClientSession;
}) {
  let pendingResend: { id: string; key: string } | null = null;
  const local = reactive({
    invitations: [] as InvitationRow[],
    remaining: 0,
    limit: 0,
    unlimited: false,
    loading: false,
    error: "",
    rowError: "",
    busyId: "",
    confirmId: "",
    shortcutDismissed: false,
    joinLinks: [] as JoinLinkRow[],
    joinChannel: "",
    joinBusy: false,
    joinError: "",
    // The fresh link's URL, shown in full under its row.
    joinUrl: "",
    // The row the fresh URL belongs to.
    joinNewId: "",
    joinCopied: false,
    // The clipboard refused: show the whole URL in a field to select by hand.
    joinCopyFailed: false,
    // The listed row whose Copy link just worked, for the short "Copied".
    joinCopiedId: "",
    showPastInvitations: false,
    showPastLinks: false,
  });

  const inScope = (key: string) => session.key() === key && !session.stopped() && core.authenticated;

  function reset(): void {
    pendingResend = null;
    local.invitations = []; local.remaining = 0; local.limit = 0; local.unlimited = false;
    local.loading = false; local.error = ""; local.rowError = ""; local.busyId = ""; local.confirmId = "";
    local.shortcutDismissed = false;
    local.joinLinks = []; local.joinChannel = ""; local.joinBusy = false; local.joinError = ""; local.joinUrl = ""; local.joinNewId = ""; local.joinCopied = false; local.joinCopiedId = "";
    local.showPastInvitations = false; local.showPastLinks = false;
  }

  async function loadJoinLinks(): Promise<void> {
    if (!core.authenticated) return;
    const key = session.key();
    try {
      const response = await fetch("/api/join-links", { credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (inScope(key) && response.ok && Array.isArray(body.links)) local.joinLinks = body.links;
    } catch { /* the section stays as it was */ }
  }

  async function makeJoinLink(): Promise<void> {
    if (local.joinBusy || !local.joinChannel) return;
    const key = session.key();
    local.joinBusy = true; local.joinError = ""; local.joinUrl = ""; local.joinNewId = ""; local.joinCopied = false; local.joinCopyFailed = false;
    try {
      const response = await fetch("/api/join-links", { method: "POST", credentials: "same-origin", headers: JOIN_HEADERS, body: JSON.stringify({ channel: local.joinChannel }) });
      const body = await response.json().catch(() => ({}));
      if (!inScope(key)) return;
      if (!response.ok) throw new Error(body.error || "Could not make the link.");
      local.joinUrl = typeof body.url === "string" ? body.url : "";
      local.joinNewId = typeof body.id === "string" ? body.id : "";
      await loadJoinLinks();
    } catch (error) {
      if (inScope(key)) local.joinError = error instanceof Error ? error.message : "Could not make the link.";
    } finally {
      if (inScope(key)) local.joinBusy = false;
    }
  }

  async function revokeJoinLink(link: JoinLinkRow): Promise<void> {
    if (local.joinBusy || link.revoked) return;
    const key = session.key();
    local.joinBusy = true; local.joinError = "";
    try {
      const response = await fetch(`/api/join-links/${encodeURIComponent(link.id)}`, { method: "DELETE", credentials: "same-origin", headers: JOIN_HEADERS });
      if (!inScope(key)) return;
      if (!response.ok && response.status !== 404) throw new Error("Could not revoke the link.");
      if (local.joinNewId === link.id) { local.joinUrl = ""; local.joinNewId = ""; }
      await loadJoinLinks();
    } catch (error) {
      if (inScope(key)) local.joinError = error instanceof Error ? error.message : "Could not revoke the link.";
    } finally {
      if (inScope(key)) local.joinBusy = false;
    }
  }

  async function copyJoinLink(): Promise<void> {
    if (!local.joinUrl) return;
    try { await navigator.clipboard.writeText(local.joinUrl); local.joinCopied = true; local.joinCopyFailed = false; }
    catch { local.joinCopied = false; local.joinCopyFailed = true; }
  }

  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyListedJoinLink(link: JoinLinkRow): Promise<void> {
    if (!link.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      local.joinCopiedId = link.id;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { if (local.joinCopiedId === link.id) local.joinCopiedId = ""; }, 2000);
    } catch {
      // The clipboard refused: open the row's full URL to select by hand.
      local.joinUrl = link.url; local.joinNewId = link.id; local.joinCopied = false; local.joinCopyFailed = true;
    }
  }

  async function load(): Promise<void> {
    if (!core.authenticated || local.loading) return;
    const key = session.key();
    local.loading = true; local.error = ""; local.rowError = ""; local.confirmId = "";
    try {
      const response = await fetch("/api/invitations", { credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (!inScope(key)) return;
      if (!response.ok) throw new Error(body.error || "Could not load invitations.");
      local.invitations = Array.isArray(body.invitations) ? body.invitations.filter((row: unknown): row is InvitationRow => !!row && typeof (row as InvitationRow).id === "string") : [];
      if (typeof body.remaining === "number") local.remaining = body.remaining;
      if (typeof body.limit === "number") local.limit = body.limit;
      if (typeof body.unlimited === "boolean") { local.unlimited = body.unlimited; if (body.unlimited) local.limit = 0; }
    } catch (error) {
      if (inScope(key)) local.error = error instanceof Error ? error.message : "Could not load invitations.";
    } finally {
      if (inScope(key)) local.loading = false;
    }
  }

  function dismissShortcut(): void { local.shortcutDismissed = true; }

  function open(): void { local.confirmId = ""; void load(); void loadJoinLinks(); }

  // Current items first; past ones join the list only when asked.
  function visibleInvitations(): InvitationRow[] {
    const current = local.invitations.filter((row) => !isPastInvitation(row));
    return local.showPastInvitations ? [...current, ...local.invitations.filter(isPastInvitation)] : current;
  }
  function pastInvitationCount(): number { return local.invitations.filter(isPastInvitation).length; }
  function visibleJoinLinks(): JoinLinkRow[] {
    const current = local.joinLinks.filter((link) => !isPastJoinLink(link));
    return local.showPastLinks ? [...current, ...local.joinLinks.filter(isPastJoinLink)] : current;
  }
  function pastJoinLinkCount(): number { return local.joinLinks.filter(isPastJoinLink).length; }

  function replaceRow(id: string, next: Partial<InvitationRow>): void {
    local.invitations = local.invitations.map((row) => row.id === id ? { ...row, ...next } : row);
  }

  async function resend(row: InvitationRow): Promise<void> {
    if (local.busyId || !canResendInvitation(row.status)) return;
    const key = session.key();
    const request = pendingResend && pendingResend.id === row.id ? pendingResend : (pendingResend = { id: row.id, key: crypto.randomUUID() });
    local.busyId = row.id; local.rowError = ""; local.confirmId = "";
    try {
      const response = await fetch(`/api/invitations/${encodeURIComponent(row.id)}/resend`, {
        method: "POST", credentials: "same-origin", headers: { "Idempotency-Key": request.key },
      });
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      if (!inScope(key)) return;
      const parsed = body && typeof body === "object" ? body as Record<string, any> : null;
      if (resendOutcomeIsRecorded(response.status, parsed)) pendingResend = null;
      if (parsed) {
        if (typeof parsed.remaining === "number") local.remaining = parsed.remaining;
        if (typeof parsed.limit === "number") local.limit = parsed.limit;
        if (typeof parsed.unlimited === "boolean") { local.unlimited = parsed.unlimited; if (parsed.unlimited) local.limit = 0; }
      }
      if (!response.ok) { local.rowError = parsed?.error || "Could not resend the invitation."; return; }
      if (parsed?.status === "added") replaceRow(row.id, { status: "accepted" });
      else replaceRow(row.id, { status: parsed?.status === "sent" ? "pending" : (parsed?.status || row.status), ...(typeof parsed?.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {}), sends: (row.sends || 0) + 1 });
    } catch {
      if (inScope(key)) local.rowError = "Could not reach the server. Retry resends the same request.";
    } finally {
      if (inScope(key)) local.busyId = "";
    }
  }

  async function cancel(row: InvitationRow): Promise<void> {
    if (local.busyId || !canCancelInvitation(row.status)) return;
    const key = session.key();
    local.busyId = row.id; local.rowError = ""; local.confirmId = "";
    try {
      const response = await fetch(`/api/invitations/${encodeURIComponent(row.id)}`, { method: "DELETE", credentials: "same-origin" });
      if (!inScope(key)) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        local.rowError = body.error || "Could not cancel the invitation.";
        return;
      }
      replaceRow(row.id, { status: "cancelled" });
    } catch {
      if (inScope(key)) local.rowError = "Could not reach the server. Try again.";
    } finally {
      if (inScope(key)) local.busyId = "";
    }
  }

  return Object.assign(local, {
    open, load, resend, cancel, reset, dismissShortcut, loadJoinLinks, makeJoinLink, revokeJoinLink, copyJoinLink, copyListedJoinLink,
    visibleInvitations, pastInvitationCount, visibleJoinLinks, pastJoinLinkCount, isPastJoinLink, joinLinkDetail, joinLinkPill, joinLinkUncopyable, joinLinkProgress, joinLinkDisplay,
    invitationStatusLabel, invitationDestinationLabel, invitationDate, canResendInvitation, canCancelInvitation,
    destroy: reset,
  });
}
