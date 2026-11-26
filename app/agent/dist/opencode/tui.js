// src/harnesses/opencode/shared.ts
var any = { "~standard": { version: 1, vendor: "slirc", validate: (value) => ({ value }) } };
var SLIRC_RPC = {
  id: "slirc",
  methods: { presence: { input: any, output: any }, connect: { input: any, output: any } },
  events: { notify: { schema: any } }
};
var PRESENCE_EVERY_MS = 5000;

// src/harnesses/opencode/tui.ts
async function setup(api) {
  if (typeof api?.client?.rpc !== "function")
    return;
  const rpc = api.client.rpc(SLIRC_RPC);
  const tui = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  let armed = process.env.SLIRC_CONNECT;
  const ticket = process.env.SLIRC_CONNECT_TICKET;
  delete process.env.SLIRC_CONNECT;
  delete process.env.SLIRC_CONNECT_TICKET;
  const open = () => {
    const sessions = new Set;
    try {
      const route = api.ui.router.current();
      if (route?.type === "session" && route.sessionID)
        sessions.add(route.sessionID);
    } catch {}
    try {
      if (api.ui.tabs?.enabled?.()) {
        for (const tab of api.ui.tabs.list())
          if (tab?.sessionID)
            sessions.add(tab.sessionID);
      }
    } catch {}
    return [...sessions];
  };
  let sent = "";
  let reported = false;
  const report = async (force) => {
    const sessions = open();
    const key = sessions.join(",");
    if (!force && key === sent)
      return;
    if (!sessions.length && !reported)
      return;
    sent = key;
    reported = sessions.length > 0;
    try {
      await rpc.presence({ tui, sessions });
    } catch {
      sent = "";
    }
    if (armed && sessions.length) {
      const workspace = armed;
      armed = undefined;
      try {
        await rpc.connect({ sessionID: sessions[0], workspace, ...ticket ? { ticket } : {} });
      } catch {}
    }
  };
  const quick = setInterval(() => {
    report(false);
  }, 1000);
  const steady = setInterval(() => {
    report(true);
  }, PRESENCE_EVERY_MS);
  const off = rpc.events.on("notify", (event) => {
    const notice = event?.data;
    if (!notice?.sessionID || typeof notice.message !== "string" || !open().includes(notice.sessionID))
      return;
    api.ui.toast.show({ sessionID: notice.sessionID, title: "Slirc", message: notice.message, variant: notice.variant, duration: notice.duration ?? 6000 });
  });
  return async () => {
    clearInterval(quick);
    clearInterval(steady);
    off?.();
    if (reported)
      await Promise.race([rpc.presence({ tui, sessions: [] }).catch(() => {}), new Promise((done) => setTimeout(done, 1000))]);
  };
}
var tui_default = { id: "slirc", setup };
export {
  tui_default as default
};
