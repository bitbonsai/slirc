import { type ClientSession, type ClientState } from "@client/client-state.ts";

type WebSession = { id: string; device: string; createdAt: number; current: boolean };

export function createSettingsPage(reactive: <T extends object>(value: T) => T, { core, session, nextTick }: {
  core: Pick<ClientState, "authenticated" | "account" | "greeting">;
  session: ClientSession;
  nextTick: (callback?: () => void) => Promise<void>;
}) {
  let epoch = 0;
  let invoker: HTMLElement | null = null;
  const local = reactive({
    notificationLoading: false,
    notificationBusy: false,
    notificationReady: false,
    notificationError: "",
    permission: "unsupported" as NotificationPermission | "unsupported",
    subscribed: false,
    preference: "all" as "all" | "mentions" | "none",
    sessions: [] as WebSession[],
    sessionsLoaded: false,
    sessionsBusy: false,
    sessionsError: "",
    signOutTarget: null as { ids: string[]; label: string } | null,
    greetingBusy: false,
    greetingError: "",
  });

  function owner() {
    const scope = session.scope();
    if (!scope || !core.authenticated || scope.account !== core.account || session.stopped() || session.signingOut()) return null;
    const key = session.key(), revision = epoch;
    return { accountId: scope.accountId, current: () => epoch === revision && session.key() === key
      && session.scope()?.accountId === scope.accountId && core.authenticated && core.account === scope.account
      && !session.stopped() && !session.signingOut() };
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(path, { credentials: "same-origin", signal: AbortSignal.timeout(10_000), ...init });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${response.status}).`);
    }
    return response;
  }

  function readPermission(): void {
    local.permission = typeof window !== "undefined" && "Notification" in window && "PushManager" in window && "serviceWorker" in navigator
      ? window.Notification.permission : "unsupported";
  }

  async function registration(): Promise<ServiceWorkerRegistration> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Notifications need HTTPS and an active service worker. Reload and try again.")), 4000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function notificationsOn(): boolean {
    return local.permission === "granted" && local.subscribed && local.preference !== "none";
  }

  function notificationStatus(): string {
    if (local.notificationLoading) return "Checking…";
    if (local.permission === "unsupported") return "Unavailable";
    if (local.permission === "denied") return "Blocked";
    return notificationsOn() ? "On" : "Off";
  }

  async function loadNotifications(): Promise<void> {
    const scope = owner();
    if (!scope || local.notificationLoading || local.notificationBusy) return;
    local.notificationLoading = true; local.notificationError = ""; local.notificationReady = false;
    readPermission();
    try {
      const subscription = local.permission === "unsupported" ? null : await (await registration()).pushManager.getSubscription();
      if (!scope.current()) return;
      const digest = subscription ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subscription.endpoint)) : null;
      const fingerprint = digest ? [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") : "";
      if (!scope.current()) return;
      const body = await (await request(`/push/preference${fingerprint ? `?subscription=${fingerprint}` : ""}`)).json();
      if (!scope.current()) return;
      if (!["all", "mentions", "none"].includes(body.preference)) throw new Error("Could not read notification settings.");
      local.preference = body.preference;
      local.subscribed = !!subscription && body.subscribed === true;
      local.notificationReady = true;
    } catch (error) {
      if (scope.current()) local.notificationError = error instanceof Error ? error.message : "Could not load notifications.";
    } finally { if (scope.current()) local.notificationLoading = false; }
  }

  async function toggleNotifications(): Promise<void> {
    const scope = owner();
    if (!scope || !local.notificationReady || local.notificationBusy || local.notificationLoading) return;
    readPermission();
    const enable = !notificationsOn();
    if (enable && (local.permission === "unsupported" || local.permission === "denied")) return;
    local.notificationBusy = true; local.notificationError = "";
    let created: PushSubscription | null = null;
    try {
      if (enable) {
        // Request permission before any other await, while the click still supplies user activation.
        const permission = window.Notification.permission === "default" ? await window.Notification.requestPermission() : window.Notification.permission;
        if (!scope.current()) return;
        local.permission = permission;
        if (permission !== "granted") {
          if (permission === "default") local.notificationError = "Permission wasn't granted. Try again when you're ready.";
          return;
        }
        const worker = await registration();
        if (!scope.current()) return;
        let subscription = await worker.pushManager.getSubscription();
        if (!scope.current()) return;
        if (!subscription) {
          const { publicKey } = await (await request("/push/public-key")).json();
          if (!scope.current()) return;
          if (typeof publicKey !== "string" || !publicKey) throw new Error("Could not read notification key.");
          const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.length / 4) * 4, "="));
          subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (char) => char.charCodeAt(0)) });
          created = subscription;
        }
        if (!scope.current()) return;
        await request("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: scope.accountId, subscription: subscription.toJSON(), preference: "all" }) });
      } else {
        await request("/push/preference", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: scope.accountId, preference: "none" }) });
      }
      if (!scope.current()) return;
      local.preference = enable ? "all" : "none";
      if (enable) local.subscribed = true;
    } catch (error) {
      if (scope.current()) {
        if (created) await created.unsubscribe().catch(() => false);
        if (scope.current()) local.notificationError = error instanceof Error ? error.message : "Could not update notifications.";
      }
    } finally { if (scope.current()) local.notificationBusy = false; }
  }

  // Per account on the server, so it follows the person to every device; /auth/me reads it back.
  async function toggleGreeting(): Promise<void> {
    const scope = owner();
    if (!scope || local.greetingBusy) return;
    const next = !core.greeting;
    local.greetingBusy = true; local.greetingError = "";
    try {
      await request("/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: scope.accountId, greeting: next }) });
      if (scope.current()) core.greeting = next;
    } catch (error) {
      if (scope.current()) local.greetingError = error instanceof Error ? error.message : "Could not update the greeting.";
    } finally { if (scope.current()) local.greetingBusy = false; }
  }

  async function loadSessions(): Promise<void> {
    const scope = owner();
    if (!scope || local.sessionsBusy) return;
    local.sessionsBusy = true; local.sessionsError = "";
    try {
      const rows = await (await request("/api/sessions")).json();
      if (!scope.current()) return;
      if (!Array.isArray(rows) || rows.some((row) => !/^[a-f0-9]{64}$/.test(row?.id) || typeof row.device !== "string" || !Number.isFinite(row.createdAt) || typeof row.current !== "boolean")) throw new Error("Could not read sessions.");
      local.sessions = rows.sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt - a.createdAt);
      local.sessionsLoaded = true;
    } catch (error) {
      if (scope.current()) local.sessionsError = error instanceof Error ? error.message : "Could not load sessions.";
    } finally { if (scope.current()) local.sessionsBusy = false; }
  }

  function askSignOut(id: string | null, button: HTMLElement): void {
    if (!owner() || local.sessionsBusy) return;
    const targets = local.sessions.filter((item) => !item.current && (id === null || item.id === id));
    if (!targets.length) return;
    invoker = button;
    local.signOutTarget = { ids: targets.map((item) => item.id), label: id === null ? "other browsers" : targets[0]!.device };
  }

  function closeSignOut(): void {
    local.signOutTarget = null;
    void nextTick(() => {
      if (invoker?.isConnected && invoker.getClientRects().length) invoker.focus();
      else document.getElementById("settings-sessions-title")?.focus();
      invoker = null;
    });
  }

  function dialogKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget as HTMLDialogElement;
    const controls = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter((button) => button.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  }

  async function confirmSignOut(): Promise<void> {
    const scope = owner(), target = local.signOutTarget;
    if (!scope || !target || local.sessionsBusy) return;
    local.sessionsBusy = true; local.sessionsError = "";
    try {
      for (const id of target.ids) {
        if (!scope.current()) return;
        if (!local.sessions.some((item) => item.id === id && !item.current)) throw new Error("Sessions changed. Reload and try again.");
        await request(`/api/sessions/${encodeURIComponent(id)}?other=1`, { method: "DELETE" });
        if (!scope.current()) return;
        local.sessions = local.sessions.filter((item) => item.id !== id);
        target.ids = target.ids.filter((pending) => pending !== id);
      }
      if (scope.current()) closeSignOut();
    } catch (error) {
      if (scope.current()) local.sessionsError = error instanceof Error ? error.message : "Could not sign out browser.";
    } finally { if (scope.current()) local.sessionsBusy = false; }
  }

  function open(): void {
    void loadNotifications();
    void loadSessions();
  }

  function reset(): void {
    epoch += 1; invoker = null;
    local.sessions = []; local.sessionsLoaded = false; local.sessionsBusy = false; local.sessionsError = ""; local.signOutTarget = null;
    local.notificationLoading = false; local.notificationBusy = false; local.notificationReady = false; local.notificationError = "";
    local.permission = "unsupported"; local.preference = "all"; local.subscribed = false;
    local.greetingBusy = false; local.greetingError = "";
  }

  return Object.assign(local, { notificationsOn, notificationStatus, loadNotifications, toggleNotifications, toggleGreeting, loadSessions, askSignOut, closeSignOut, dialogKeydown, confirmSignOut, open, reset, destroy: reset,
    sessionDate: (timestamp: number) => new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
  });
}
