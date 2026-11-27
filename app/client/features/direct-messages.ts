import { conversationId, foldIdentifier, scopeKey } from "@client/model.ts";
import { ClientDatabase } from "@client/db.ts";
import { cachedDirectIsAuthorized } from "@client/access.ts";
import { isAgentNick } from "@client/agent-roster.ts";
import type { createNavigation } from "@client/navigation.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface DirectMessagesDeps {
  state: Pick<RuntimeState, "authorized" | "currentScope" | "db" | "directories" | "navIntent" | "pendingDms" | "roomId" | "scope" | "stopped">;
  ui: Pick<ClientState, "account" | "accountIds" | "agentProfiles" | "contacts" | "directBusy" | "directs" | "error" | "pendingDm" | "pendingDmError" | "pendingDmState" | "pendingDmVersion">;
  nav: ReturnType<typeof createNavigation>;
  connect: () => Promise<void>;
  openNotes: () => void;
  refreshDrafts: (expectedDb?: ClientDatabase | null) => Promise<void>;
}

export function createDirectMessages(deps: DirectMessagesDeps) {
  const { state: rs, ui, nav, connect, openNotes, refreshDrafts } = deps;

  const dmPeerIds = new Map<string, string>();

  // A first-contact DM the server has not authorized yet, keyed by the account-scoped conversation
  // id. Declared before any navigation subscriber can run; pending is local enqueue permission
  // only and never enters `authorized`.
  const provisioning = new Map<string, Promise<void>>();

  // --- Optimistic first-contact DMs -------------------------------------------------------------
  // A brand-new 1:1 DM needs a slow Ergo createDirectChannel before it is server-authorized, so
  // the click otherwise looks like a no-op for seconds. The click instead opens a pending
  // conversation at once, keyed by the peer's immutable account id — the same id the authorized DM
  // will use — so drafts and queued text map onto the final conversation with no duplicate or loss.
  // Pending is local enqueue permission only: it never enters `authorized`, and the outbox still
  // requires sync readiness (a recovered, joined, membership-authorized conversation) to transmit.
  function peerAccountIdFor(nick: string): string | undefined {
    return dmPeerIds.get(foldIdentifier(nick)) ?? ui.accountIds[foldIdentifier(nick)];
  }

  function pendingIdForNick(nick: string): string | null {
    for (const [id, entry] of rs.pendingDms) if (foldIdentifier(entry.nick) === foldIdentifier(nick)) return id;
    return null;
  }

  // Pending rows for the DMs list. An id the server already authorized is dropped, so the row is
  // never shown twice during the hand-off from pending to authorized.
  function pendingDirectRows(): { nick: string; channel: string; conversationId: string; pending: true }[] {
    const rows: { nick: string; channel: string; conversationId: string; pending: true }[] = [];
    for (const [id, entry] of rs.pendingDms) {
      if (rs.directories.has(id)) { rs.pendingDms.delete(id); continue; }
      rows.push({ nick: entry.nick, channel: "", conversationId: id, pending: true });
    }
    return rows;
  }

  // Contacts drop a nick the moment its DM is pending or authorized, and the DMs list picks it up,
  // so the row visibly moves instead of lingering for the whole provisioning round trip.
  function contactList(): string[] {
    void ui.pendingDmVersion;
    const moved = new Set([...rs.pendingDms.values()].map((entry) => foldIdentifier(entry.nick)));
    return ui.contacts.filter((nick: string) => !moved.has(foldIdentifier(nick)) && !isAgentNick(ui.agentProfiles, nick));
  }

  // Local write permission, deliberately separate from network delivery authority. A pending
  // conversation accepts a durable enqueue; only sync readiness lets the outbox transmit it.
  function isLocallyEnqueueable(id: string): boolean {
    return rs.directories.has(id) || rs.pendingDms.has(id);
  }

  function refreshPendingUi(): void {
    for (const id of [...rs.pendingDms.keys()]) if (rs.directories.has(id)) rs.pendingDms.delete(id);
    ui.pendingDmVersion += 1;
    const entry = rs.roomId ? rs.pendingDms.get(rs.roomId) : undefined;
    ui.pendingDm = !!entry;
    ui.pendingDmState = entry?.state ?? "";
    ui.pendingDmError = entry?.error ?? "";
  }

  function ensurePendingDirect(nick: string): string | null {
    const accountId = peerAccountIdFor(nick);
    if (!accountId) return null;
    const id = conversationId("dm", accountId);
    if (rs.directories.has(id)) return null;
    if (!rs.pendingDms.has(id)) rs.pendingDms.set(id, { nick, accountId, state: "provisioning" });
    refreshPendingUi();
    return id;
  }

  async function restorePendingDirects(targetDb: ClientDatabase): Promise<void> {
    const nickById = new Map(Object.entries(ui.accountIds).map(([nick, id]: [string, any]) => [String(id), nick]));
    const contacts = new Set((ui.contacts as string[]).map((nick) => foldIdentifier(nick)));
    try {
      const [drafts, operations] = await Promise.all([targetDb.drafts.toArray(), targetDb.operations.toArray()]);
      if (rs.db !== targetDb || rs.stopped || !rs.scope || rs.currentScope !== scopeKey(targetDb.scope)) return;
      const candidates = new Set([...drafts.filter((draft) => !!draft.text.trim()).map((draft) => draft.conversationId),
        ...operations.filter((operation) => operation.kind === "text" && operation.state !== "confirmed").map((operation) => operation.conversationId)]);
      for (const id of candidates) {
        if (rs.directories.has(id)) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(id); } catch { continue; }
        if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== "dm" || typeof parsed[1] !== "string") continue;
        const nick = nickById.get(parsed[1]);
        if (!nick || !contacts.has(foldIdentifier(nick))) continue;
        if (!rs.pendingDms.has(id)) rs.pendingDms.set(id, { nick, accountId: parsed[1], state: "provisioning" });
      }
      refreshPendingUi();
      await refreshDrafts(targetDb);
    } catch { /* Durable messages and drafts remain available; a later scope open retries. */ }
  }

  function retryPendingDirect(): void {
    const id = rs.roomId;
    const entry = id ? rs.pendingDms.get(id) : undefined;
    if (!id || !entry || entry.state !== "failed") return;
    entry.state = "provisioning"; entry.error = undefined;
    refreshPendingUi();
    void provisionDirect(entry.nick, id);
  }

  // Server-side pair creation runs in the background. It never navigates: a newer navigation wins,
  // and the authorized conversation shares the pending id, so the open view simply stops pending.
  function provisionDirect(nick: string, id: string): Promise<void> {
    const active = provisioning.get(id);
    if (active) return active;
    const request = runProvisionDirect(nick, id);
    provisioning.set(id, request);
    void request.finally(() => { if (provisioning.get(id) === request) provisioning.delete(id); });
    return request;
  }

  async function runProvisionDirect(nick: string, id: string): Promise<void> {
    const requestingScope = rs.currentScope;
    ui.directBusy = ui.directBusy || nick;
    try {
      const response = await fetch(`/api/dms/${encodeURIComponent(nick)}`, { method: "POST", credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (rs.currentScope !== requestingScope || rs.stopped) return;
      if (!response.ok) throw new Error(body.error || `Could not open DM (${response.status})`);
      await connect();
      if (rs.currentScope !== requestingScope || rs.stopped) return;
      const available = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
      if (!available) throw new Error("The server did not authorize this direct message.");
      rs.pendingDms.delete(id);
    } catch (error) {
      if (rs.currentScope !== requestingScope || rs.stopped) return;
      const entry = rs.pendingDms.get(id);
      if (entry) { entry.state = "failed"; entry.error = error instanceof Error ? error.message : "Could not open DM."; }
    } finally {
      if (ui.directBusy === nick) ui.directBusy = "";
      refreshPendingUi();
    }
  }

  // `deliberate` is a person pressing Message on someone's card. Open-channel posters are not
  // Contacts, so that press skips the optimistic path and lets the server's discovery gate decide.
  async function openDirect(nick: string, deliberate = false): Promise<void> {
    if (ui.account && foldIdentifier(nick) === foldIdentifier(ui.account)) { openNotes(); return; }
    const direct = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
    // Only a direct the server still authorizes may short-circuit. A local row whose conversation
    // is absent from the last authoritative set is stale (e.g. just deleted) and must not be
    // reopened from cache; fall through to a fresh POST plus reconnect.
    if (direct && cachedDirectIsAuthorized(direct, rs.authorized)) { rs.navIntent += 1; nav.open({ kind: "dm", nick: direct.nick }); return; }
    const known = !!direct || ui.contacts.some((contact: string) => foldIdentifier(contact) === foldIdentifier(nick));
    if (!known && !deliberate) return;
    // A pending first-contact DM is already open-able; navigate to it and only restart a failed try.
    const existing = pendingIdForNick(nick);
    if (existing) {
      rs.navIntent += 1;
      nav.open({ kind: "dm", nick });
      const entry = rs.pendingDms.get(existing)!;
      if (entry.state === "failed") {
        entry.state = "provisioning"; entry.error = undefined;
        refreshPendingUi();
      }
      if (entry.state === "provisioning") {
        return provisionDirect(entry.nick, existing);
      }
      return;
    }
    // Optimistic path: a contact whose immutable peer id is already known opens immediately.
    if (!direct && known) {
      const accountId = peerAccountIdFor(nick);
      if (accountId) {
        const id = ensurePendingDirect(nick);
        if (id) {
          rs.navIntent += 1;
          nav.open({ kind: "dm", nick });
          return provisionDirect(nick, id);
        }
      }
    }
    if (ui.directBusy) return;
    const intent = ++rs.navIntent;
    const requestingScope = rs.currentScope;
    ui.directBusy = nick; ui.error = "";
    try {
      const response = await fetch(`/api/dms/${encodeURIComponent(nick)}`, { method: "POST", credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not open DM (${response.status})`);
      if (rs.currentScope !== requestingScope || rs.stopped) return;
      // Refresh the authoritative list even when a newer navigation already superseded this open,
      // so the Contact moves to DMs after success instead of lingering until reload. connect()
      // re-selects the current route, so it never yanks a reader who navigated away.
      await connect();
      if (rs.currentScope !== requestingScope || rs.stopped) return;
      const available = ui.directs.find((item: { nick: string }) => foldIdentifier(item.nick) === foldIdentifier(nick));
      if (!available) throw new Error("The server did not authorize this direct message.");
      // A newer navigation (another conversation, a back/forward) keeps the reader where they are.
      if (rs.navIntent !== intent) return;
      nav.open({ kind: "dm", nick: available.nick });
    } catch (error) {
      if (rs.navIntent === intent && rs.currentScope === requestingScope && !rs.stopped) ui.error = error instanceof Error ? error.message : "Could not open DM.";
    } finally { if (ui.directBusy === nick) ui.directBusy = ""; }
  }

  return { dmPeerIds, provisioning, peerAccountIdFor, pendingIdForNick, pendingDirectRows, contactList, isLocallyEnqueueable, ensurePendingDirect, restorePendingDirects, retryPendingDirect, provisionDirect, openDirect };
}
