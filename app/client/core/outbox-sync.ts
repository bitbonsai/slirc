import { conversationId, type Operation } from "@client/model.ts";
import type { IrcMessage } from "@client/irc.ts";
import type { AuthorizedConversation } from "@client/sync.ts";
import { SendRefusedError, createOutbox, type OutboxTransport } from "@client/outbox.ts";
import { clientAccess, recoveryTargets, type ThreadGrant, wireTargetForOperation } from "@client/access.ts";
import { serializeOperation } from "@client/protocol.ts";
import { typingAccount, type createTypingIndicators } from "@client/typing.ts";
import type { createConnectionNotice } from "@client/connection-notice.ts";
import type { createAutoRefresh } from "@client/auto-refresh.ts";
import type { createFounderWelcome } from "@client/founder-welcome.ts";
import type { createPeopleCard } from "@client/people-card.ts";
import type { createReminderNotice } from "@client/reminder-notice.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface OutboxSyncDeps {
  state: Pick<RuntimeState, "authorized" | "bridge" | "capsOk" | "currentScope" | "db" | "directories" | "outbox" | "scope" | "serverMarkers" | "signingOut" | "socket" | "stopped" | "suspended" | "sync">;
  ui: Pick<ClientState, "error" | "note" | "phase" | "readyVersion" | "sendEnabled" | "sendOwner" | "sendReason" | "threads">;
  instance: string;
  connectionNotice: () => ReturnType<typeof createConnectionNotice>;
  autoRefresh: () => ReturnType<typeof createAutoRefresh>;
  welcome: () => ReturnType<typeof createFounderWelcome>;
  people: () => ReturnType<typeof createPeopleCard>;
  typing: () => ReturnType<typeof createTypingIndicators>;
  reminderNotice: () => ReturnType<typeof createReminderNotice>;
  seedReadMarker: (conversation: AuthorizedConversation) => Promise<void>;
  scheduleMarkRead: () => void;
  applyServerMarker: (conversation: AuthorizedConversation, time: string) => Promise<void>;
  drainWelcome: () => Promise<void>;
  forgetThread: (thread: ThreadGrant) => void;
  resetReconnectBackoff: () => void;
}

export function createOutboxSync(deps: OutboxSyncDeps) {
  const { state: rs, ui, instance, connectionNotice, autoRefresh, welcome, people, typing, reminderNotice, seedReadMarker, scheduleMarkRead, applyServerMarker, drainWelcome, forgetThread, resetReconnectBackoff } = deps;

  const transport: OutboxTransport = {
    sendText(operation: Operation): void {
      if (!rs.socket || rs.socket.readyState !== WebSocket.OPEN) throw new Error("socket not open");
      if (!rs.capsOk) throw new SendRefusedError("required IRC capabilities missing");
      const target = wireTargetForOperation(operation, rs.authorized);
      if (!target) throw new SendRefusedError("conversation is no longer authorized");
      // The tag carries the client correlation id; for multiline the batch id must ride every
      // constituent PRIVMSG (serializeOperation), or Ergo stores the lines as separate messages.
      for (const line of serializeOperation(operation, target, !!rs.bridge?.enabled.has("draft/multiline"))) {
        rs.socket.send(`${line}\r\n`);
      }
    },
    sendRedact(operation: Operation): void {
      if (!rs.socket || rs.socket.readyState !== WebSocket.OPEN) throw new Error("socket not open");
      if (!rs.capsOk) throw new SendRefusedError("required IRC capabilities missing");
      if (!rs.bridge?.enabled.has("draft/message-redaction")) throw new SendRefusedError("message redaction not supported by this server");
      if (!operation.redactId) throw new SendRefusedError("redact target missing");
      const target = wireTargetForOperation(operation, rs.authorized);
      if (!target) throw new SendRefusedError("conversation is no longer authorized");
      rs.socket.send(`@+slirc/cid=${operation.id} REDACT ${target} ${operation.redactId} :${operation.reason ?? ""}\r\n`);
    },
    async sendAdminRedact(operation: Operation): Promise<void> {
      if (!rs.scope) throw new SendRefusedError("no session");
      if (!operation.redactId) throw new SendRefusedError("redact target missing");
      const target = wireTargetForOperation(operation, rs.authorized);
      if (!target) throw new SendRefusedError("conversation is no longer authorized");
      // The server rechecks admin authority and only answers ok after the native REDACT ack.
      const response = await fetch("/api/messages/redact", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: target, msgid: operation.redactId, accountId: rs.scope.accountId, clientId: operation.id }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: unknown; gone?: unknown; error?: unknown };
      if (!response.ok || body.ok !== true) {
        throw new SendRefusedError(typeof body.error === "string" ? body.error : `Delete failed (${response.status})`);
      }
      // The server no longer has the message, so no REDACT echo will come: remove it here.
      if (body.gone === true && rs.db) {
        await rs.db.applyBatch({ conversationId: operation.conversationId, events: [{ type: "redaction", conversationId: operation.conversationId, serverId: operation.redactId }], complete: true });
      }
    },
  };

  function hooks() {
    return {
      onReady: (conversation: AuthorizedConversation) => {
        if (rs.stopped || rs.signingOut) return;
        ui.phase = "live";
        resetReconnectBackoff();
        ui.readyVersion += 1;
        // Only connection notes end here; a confirmation set just before a refresh stays.
        if (ui.note === "Reconnecting…") ui.note = "";
        connectionNotice().reset();
        void seedReadMarker(conversation);
        scheduleMarkRead();
        void rs.outbox?.notifyReady();
        void autoRefresh().check();
        // Readiness is the point at which a queued welcome DM can actually reach the wire.
        void drainWelcome();
        void welcome().load();
      },
      onRedactRefused: (msgid: string, reason: string) => {
        void rs.outbox?.rejectRedact(msgid, reason).catch(() => {});
      },
      onKicked: (conversation: AuthorizedConversation) => {
        if (rs.stopped || conversation.kind !== "thread") return;
        const thread = ui.threads.find((item: ThreadGrant) => item.conversationId === conversation.conversationId);
        if (thread) forgetThread(thread);
      },
      onUnready: () => {
        if (rs.stopped) return;
        ui.phase = "connecting";
        ui.readyVersion += 1;
      },
      onError: (_conversation: AuthorizedConversation | undefined, error: Error) => {
        if (!rs.stopped) ui.error = error.message;
      },
      onWhois: (message: IrcMessage) => {
        if (!rs.stopped) people().applyWhois(message);
      },
      onLive: (conversation: AuthorizedConversation, message: IrcMessage) => {
        if (rs.stopped || rs.signingOut) return;
        // Live only: history pages never reach this hook, so replay cannot invent typing state.
        if (message.command === "TAGMSG") typing().observeMessage(conversation.conversationId, message);
        else if (message.command === "PRIVMSG") typing().clear(conversation.conversationId, typingAccount(message));
        reminderNotice().observe(conversation, message);
      },
      onReadMarker: (conversation: AuthorizedConversation, timestamp: string) => {
        if (rs.stopped || rs.signingOut) return;
        rs.serverMarkers.set(conversation.conversationId, timestamp);
        void applyServerMarker(conversation, timestamp);
      },
    };
  }

  function wireSend(line: string): boolean {
    if (rs.socket?.readyState !== WebSocket.OPEN) return false;
    rs.socket.send(`${line}\r\n`);
    return true;
  }

  function startSender(): void {
    if (!rs.db) return;
    const senderDb = rs.db;
    const senderScope = rs.currentScope;
    const scopedTransport: OutboxTransport = {
      sendText(operation): void {
        if (rs.db !== senderDb || rs.currentScope !== senderScope) throw new SendRefusedError("account scope changed");
        transport.sendText(operation);
      },
      sendRedact(operation): void {
        if (rs.db !== senderDb || rs.currentScope !== senderScope) throw new SendRefusedError("account scope changed");
        transport.sendRedact?.(operation);
      },
      sendAdminRedact(operation): Promise<void> {
        if (rs.db !== senderDb || rs.currentScope !== senderScope) throw new SendRefusedError("account scope changed");
        if (!transport.sendAdminRedact) throw new SendRefusedError("admin delete is not available");
        return Promise.resolve(transport.sendAdminRedact(operation));
      },
    };
    rs.outbox = createOutbox({
      db: senderDb,
      transport: scopedTransport,
      isReady: (id) => rs.sync?.isReady(id) ?? false,
      // Any tab may queue; only the lock owner sends. A queued op for a conversation this tab
      // never opened stalls here, so ask the page to discover and join it.
      onStalled: (conversationIds) => { void recoverQueuedTargets(conversationIds); },
    });
    // Do not await start(): a second tab may hold the sender lock, and waiting for acquisition
    // would stall the socket. Enqueueing is still allowed while this tab waits for the lock.
    void rs.outbox.start().then(applyOutboxStatus);
    applyOutboxStatus();
  }

  function applyOutboxStatus(): void {
    if (rs.stopped) return;
    const status = rs.outbox?.status();
    if (!status) return;
    // Sending is enabled for every tab: a follower commits durably and the lock owner transmits.
    ui.sendEnabled = status.sendingEnabled;
    ui.sendOwner = status.owner;
    ui.sendReason = status.sendingEnabled ? "" : (status.reason ?? "sending unavailable");
  }

  // The lock owner has queued work for a conversation it never opened (a new DM or thread a
  // follower created). Re-read the authoritative access list, adopt newly authorized
  // conversations into sync, and let the sender re-check. Never trust a DB row or BroadcastChannel
  // payload for a wire target, never rebuild the visible route, and never reconnect.
  let targetRefreshEpoch = 0;

  let targetRefreshing = false;

  let targetRefreshKey = "";

  let targetRefreshAt = 0;

  let targetRefreshBackoff = 2_000;

  async function recoverQueuedTargets(conversationIds: string[]): Promise<void> {
    if (rs.stopped || rs.suspended || rs.signingOut || !rs.outbox || !rs.sync || !rs.db || !rs.scope) return;
    const key = [...conversationIds].sort().join("|");
    if (targetRefreshing) return; // one refresh in flight; the next sweep re-signals any remaining target
    // A target the server keeps refusing must not turn every sweep into an endless /auth/me
    // loop: back off per unchanged target set, and reset as soon as the set changes.
    if (key === targetRefreshKey) {
      if (Date.now() - targetRefreshAt < targetRefreshBackoff) return;
      targetRefreshBackoff = Math.min(targetRefreshBackoff * 2, 30_000);
    } else {
      targetRefreshBackoff = 2_000;
    }
    const epoch = ++targetRefreshEpoch;
    const ownerScope = rs.currentScope;
    const ownerDb = rs.db;
    const ownerSync = rs.sync;
    const ownerOutbox = rs.outbox;
    targetRefreshing = true;
    targetRefreshKey = key;
    // Everything below must be re-checked after every await: identity, socket/scope epoch, and
    // lock ownership. Fetch directly so an explicit 401/403 can fail closed instead of being
    // treated as a transient error that leaves the old authorization in place.
    const current = (): boolean =>
      epoch === targetRefreshEpoch && !rs.stopped && !rs.suspended && !rs.signingOut &&
      rs.db === ownerDb && rs.sync === ownerSync && rs.outbox === ownerOutbox && rs.currentScope === ownerScope &&
      ownerOutbox.status().owner;
    try {
      let response: Response;
      try {
        response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
      } catch {
        return; // no answer: transient, the next sweep retries
      }
      if (!current()) return;
      if (response.status === 401 || response.status === 403) {
        // Session revoked/expired: fail closed rather than retrying with the old grants.
        ownerSync.ensure([]);
        return;
      }
      if (!response.ok) return;
      const me = await response.json().catch(() => null);
      if (!current()) return;
      const next = recoveryTargets(clientAccess(me, instance), ownerScope);
      if (!next) {
        // Denied, or the cookie moved to another account without this tab reconnecting. Never
        // adopt another scope's grants; unready so nothing queued reaches the wire.
        ownerSync.ensure([]);
        return;
      }
      rs.authorized = next;
      rs.directories.clear();
      for (const item of next) rs.directories.set(item.conversationId, item);
      ownerSync.ensure(next);
      void ownerOutbox.notifyReady();
    } catch {
      // Transient failure: the next sweep retries without disturbing the visible session.
    } finally {
      targetRefreshing = false;
      targetRefreshAt = Date.now();
    }
  }

  return { hooks, wireSend, startSender };
}
