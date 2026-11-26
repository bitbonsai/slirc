import type { CapacitorConfig } from "@capacitor/cli";
import { existsSync, readFileSync } from "node:fs";
import { hostsPath, hostsScript } from "./hosts";

// The shell bundles only the workspace picker in www/. Once a workspace is verified via
// /api/version and chosen, the picker hands it to SlircShell.openWorkspace, which tracks that
// workspace's origin and loads it in the web view. server.allowNavigation stays empty so
// Capacitor never lets arbitrary external links stay in-app; SlircShellPlugin.shouldOverrideLoad
// allows navigation only within the active workspace's origin, and everything else opens in Safari.
//
// The picker reads window.SLIRC_HOSTS from www/hosts.js, which `bun run sync` writes first. A plain
// cap command after a fresh clone or a change to SLIRC_DEV_HOST stops here instead of shipping a
// stale hosts.js or a dev host the Release guard can't see.
if (!existsSync(hostsPath) || readFileSync(hostsPath, "utf8") !== hostsScript) {
  throw new Error("www/hosts.js is missing or out of date. Run `bun run sync` in native/ instead of cap sync.");
}

const config: CapacitorConfig = {
  appId: process.env.SLIRC_IOS_APP_ID || "com.example.slirc.app",
  appName: "Slirc",
  webDir: "www",
  server: {
    allowNavigation: [],
    // Shown when a page fails to load, such as a saved workspace that is unreachable.
    errorPath: "unreachable.html",
  },
  ios: {
    contentInset: "never",
  },
};

export default config;
