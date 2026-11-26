import { conversationId } from "@client/model.ts";
import { RelayBridge, saslToken } from "@client/protocol.ts";
import type { createPresence } from "@client/presence.ts";
import type { createTypingIndicators } from "@client/typing.ts";
import type { createConnectionNotice } from "@client/connection-notice.ts";
import type { RuntimeState } from "@client/core/runtime-state.ts";
import type { ClientState } from "@client/client-state.ts";

export interface ConnectionDeps {
  state: Pick<RuntimeState, "authorized" | "bridge" | "capsOk" | "connectEpoch" | "outbox" | "roomId" | "serverMarkers" | "signingOut" | "socket" | "stopped" | "suspended" | "sync">;
  ui: Pick<ClientState, "authenticated" | "capsNote" | "error" | "mobileNav" | "note" | "phase">;
  url: string;
  presence: () => ReturnType<typeof createPresence>;
  typing: () => ReturnType<typeof createTypingIndicators>;
  connectionNotice: () => ReturnType<typeof createConnectionNotice>;
  connect: () => Promise<void>;
  wireSend: (line: string) => boolean;
  refreshPresence: () => void;
  clearRoomMembers: () => void;
}

export function createConnection(deps: ConnectionDeps) {
  const { state: rs, ui, url, presence, typing, connectionNotice, connect, wireSend, refreshPresence, clearRoomMembers } = deps;

  let reconnectTimer: number | null = null;

  // A dropped socket retries almost at once, then backs off. The delay resets only when a room goes
  // live, so a socket that opens and is refused still backs off instead of looping every 250 ms.
  const RECONNECT_FIRST_MS = 250;

  let reconnectDelay = RECONNECT_FIRST_MS;

  // The socket is opened while /auth/me is still in flight, so the WebSocket upgrade overlaps it
  // (one round trip through a proxy like Cloudflare). Registration waits for /auth/me to name the
  // account. Only a browser that was signed in before pre-opens, so a sign-in page never knocks.
  let earlySocket: WebSocket | null = null;

  const SIGNED_IN_HINT = "slirc2-signed-in";

  function signedInHint(on?: boolean): boolean {
    try {
      if (on === true) localStorage.setItem(SIGNED_IN_HINT, "1");
      else if (on === false) localStorage.removeItem(SIGNED_IN_HINT);
      return localStorage.getItem(SIGNED_IN_HINT) === "1";
    } catch { return false; }
  }

  // Start the upgrade early for a browser that was signed in before, while /auth/me is in flight.
  function preopenSocket(): void {
    if (!rs.socket && !earlySocket && signedInHint()) earlySocket = new WebSocket(url);
  }

  function dropEarlySocket(): void {
    earlySocket?.close();
    earlySocket = null;
  }

  function reconnect(): void {
    if (rs.stopped || rs.signingOut || rs.suspended) return;
    ui.note = "Reconnecting…";
    reconnectDelay = RECONNECT_FIRST_MS;
    closeSocket();
    void connect();
  }

  // Pull-to-refresh (pull-refresh.ts). A socket can look open after the phone slept while the
  // server has long gone, so a PING round trip is what proves the link; without an answer, reconnect
  // (which re-syncs every conversation). With one, page anything newer for the open conversation.
  // Unread counts follow from the live stream the round trip just proved.
  const pongWaiters = new Map<string, () => void>();

  let pingSeq = 0;

  function notePong(line: string): void {
    if (!pongWaiters.size || !/^(?:@\S+ )?(?::\S+ )?PONG /.test(line)) return;
    const token = line.trimEnd().split(" ").at(-1)?.replace(/^:/, "") ?? "";
    pongWaiters.get(token)?.();
  }

  function pingServer(ms: number): Promise<boolean> {
    if (rs.socket?.readyState !== WebSocket.OPEN || !rs.sync?.isAuthenticated()) return Promise.resolve(false);
    const token = `slirc-pull-${++pingSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pongWaiters.delete(token); resolve(false); }, ms);
      pongWaiters.set(token, () => { clearTimeout(timer); pongWaiters.delete(token); resolve(true); });
      if (!wireSend(`PING ${token}`)) { clearTimeout(timer); pongWaiters.delete(token); resolve(false); }
    });
  }

  async function waitLive(ms: number, conversation: string | null): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (rs.stopped || rs.signingOut) return false;
      if (ui.phase === "live" && rs.socket?.readyState === WebSocket.OPEN && rs.sync?.isAuthenticated() && (!conversation || rs.sync.isReady(conversation))) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async function pullRefresh(): Promise<"current" | "offline" | "failed"> {
    if (rs.stopped || rs.signingOut || rs.suspended || !ui.authenticated) return "failed";
    if (navigator.onLine === false) return "offline";
    const open = ui.mobileNav === null && rs.roomId && rs.authorized.some((item) => item.conversationId === rs.roomId) ? rs.roomId : null;
    if (!(await pingServer(4_000))) {
      reconnect();
      if (await waitLive(10_000, open)) return "current";
      return navigator.onLine === false ? "offline" : "failed";
    }
    if (!open || !rs.sync) return "current";
    const caught = await Promise.race([rs.sync.catchUp([open]), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000))]);
    return caught ? "current" : "failed";
  }

  // The delay resets only when a room goes live (see the comment on RECONNECT_FIRST_MS).
  function resetReconnectBackoff(): void { reconnectDelay = RECONNECT_FIRST_MS; }

  function registerBridge(nick: string): void {
    rs.bridge = new RelayBridge({
      nick,
      saslToken: saslToken(nick),
      send: (line) => {
        if (rs.socket?.readyState === WebSocket.OPEN) rs.socket.send(`${line}\r\n`);
      },
      push: (line) => { notePong(line); presence().feed(line); rs.sync?.push(line); },
      onCaps: (_enabled, missing) => {
        rs.capsOk = missing.length === 0;
        ui.capsNote = rs.capsOk ? "" : `Missing capabilities: ${missing.join(", ")}`;
      },
      onAuthFailed: (reason) => {
        ui.error = reason;
      },
    });
  }

  function scheduleReconnect(): void {
    if (rs.stopped || rs.suspended || rs.signingOut || reconnectTimer !== null) return;
    ui.phase = "connecting";
    const wait = reconnectDelay;
    reconnectDelay = Math.min(Math.max(reconnectDelay * 2, 2_000), 30_000);
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, wait) as unknown as number;
  }

  function openSocket(user: string): void {
    if (rs.socket) {
      const previous = rs.socket;
      rs.socket = null;
      previous.close();
    }
    presence().start(user);
    refreshPresence();
    rs.serverMarkers.clear();
    const early = earlySocket;
    earlySocket = null;
    if (early && early.readyState > WebSocket.OPEN) early.close();
    const ws = early && early.readyState <= WebSocket.OPEN ? early : new WebSocket(url);
    rs.socket = ws;
    registerBridge(user);
    ws.onopen = () => {
      if (rs.socket !== ws) return;
      rs.bridge?.onOpen();
    };
    if (ws.readyState === WebSocket.OPEN) rs.bridge?.onOpen();
    ws.onmessage = (event) => {
      if (rs.socket !== ws) return;
      rs.bridge?.feed(typeof event.data === "string" ? event.data : "");
    };
    ws.onclose = () => {
      if (rs.socket !== ws) return;
      rs.socket = null;
      typing().reset();
      clearRoomMembers();
      presence().disconnect();
      rs.sync?.onDisconnect();
      void rs.outbox?.onDisconnected();
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (rs.socket === ws && !rs.stopped && !rs.signingOut) connectionNotice().failed();
    };
  }

  function closeSocket(): void {
    rs.connectEpoch += 1;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = rs.socket;
    rs.socket = null;
    ws?.close();
    dropEarlySocket();
    typing().reset();
    clearRoomMembers();
    presence().disconnect();
    rs.sync?.onDisconnect();
  }

  return { signedInHint, preopenSocket, dropEarlySocket, reconnect, pullRefresh, resetReconnectBackoff, scheduleReconnect, openSocket, closeSocket };
}
