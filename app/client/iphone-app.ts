import { inIosApp } from "@client/native-shell.ts";

// "Get the iPhone app" in More on a phone and in Devices → Add your phone on desktop. The TestFlight
// link comes from /api/apps once per account, after boot, when either opens, never inside the iOS app.
// An empty url hides the row: signed out, no link configured, or a failed request.
const JOIN = /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/;

export function createIphoneApp(state: { iphoneAppUrl: string }, win: unknown = globalThis) {
  let loadedFor = "";
  return {
    async load(account: string): Promise<void> {
      if (!account || account === loadedFor || inIosApp(win as never)) return;
      loadedFor = account;
      state.iphoneAppUrl = "";
      try {
        const response = await fetch("/api/apps", { cache: "no-store", credentials: "same-origin" });
        const body = response.ok ? await response.json() : null;
        const url = typeof body?.testflight === "string" && JOIN.test(body.testflight) ? body.testflight : "";
        if (loadedFor === account) state.iphoneAppUrl = url;
        if (!response.ok && loadedFor === account) loadedFor = "";
      } catch { if (loadedFor === account) loadedFor = ""; }
    },
    reset(): void { loadedFor = ""; state.iphoneAppUrl = ""; },
  };
}
