import { PRESENCE_EVERY_MS, SLIRC_RPC, type Notice } from "./shared.ts";

// TUI half of the OpenCode plugin. OpenCode loads it from the package's "./tui" entry inside each
// TUI process. It tells the server half which sessions this TUI has open (the current one and any
// tabs), shows the server half's notices as toasts, and starts the one pairing a `slirc-agent`
// launch armed with SLIRC_CONNECT. It imports only shared.ts, so the server half never runs here.

async function setup(api: any): Promise<(() => Promise<void>) | undefined> {
  if (typeof api?.client?.rpc !== "function") return undefined;
  const rpc = api.client.rpc(SLIRC_RPC);
  const tui = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  // Armed by `slirc-agent <workspace>` for this launch only. Paired with the first session opened.
  let armed = process.env.SLIRC_CONNECT;
  const ticket = process.env.SLIRC_CONNECT_TICKET;
  delete process.env.SLIRC_CONNECT;
  delete process.env.SLIRC_CONNECT_TICKET;

  const open = (): string[] => {
    const sessions = new Set<string>();
    try { const route = api.ui.router.current(); if (route?.type === "session" && route.sessionID) sessions.add(route.sessionID); } catch {}
    try { if (api.ui.tabs?.enabled?.()) for (const tab of api.ui.tabs.list()) if (tab?.sessionID) sessions.add(tab.sessionID); } catch {}
    return [...sessions];
  };

  // Only a TUI that has shown a session reports, so a TUI on its home screen wakes nothing.
  let sent = "";
  let reported = false;
  const report = async (force: boolean) => {
    const sessions = open();
    const key = sessions.join(",");
    if (!force && key === sent) return;
    if (!sessions.length && !reported) return;
    sent = key;
    reported = sessions.length > 0;
    try { await rpc.presence({ tui, sessions }); } catch { sent = ""; }
    if (armed && sessions.length) {
      const workspace = armed;
      armed = undefined;
      try { await rpc.connect({ sessionID: sessions[0], workspace, ...(ticket ? { ticket } : {}) }); } catch {}
    }
  };
  const quick = setInterval(() => { void report(false); }, 1_000);
  const steady = setInterval(() => { void report(true); }, PRESENCE_EVERY_MS);

  // Every TUI on the service hears each notice; only one showing that session toasts it.
  const off = rpc.events.on("notify", (event: any) => {
    const notice = event?.data as Notice | undefined;
    if (!notice?.sessionID || typeof notice.message !== "string" || !open().includes(notice.sessionID)) return;
    api.ui.toast.show({ sessionID: notice.sessionID, title: "Slirc", message: notice.message, variant: notice.variant, duration: notice.duration ?? 6_000 });
  });

  return async () => {
    clearInterval(quick);
    clearInterval(steady);
    off?.();
    // Closing the TUI takes its sessions offline now, not after the presence timeout.
    if (reported) await Promise.race([rpc.presence({ tui, sessions: [] }).catch(() => {}), new Promise((done) => setTimeout(done, 1_000))]);
  };
}

export default { id: "slirc", setup };
