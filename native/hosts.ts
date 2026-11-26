// HOSTS is the picker's host allowlist, written into www/hosts.js by write-hosts.ts. "*" allows
// any verified https Slirc workspace (checked against /api/version before opening). Capacitor's
// server.allowNavigation stays empty: ios/App/App/BridgeViewController.swift allows navigation
// only within the active workspace's origin so external links still open in Safari.
//
// SLIRC_DEV_HOST marks a simulator sync against a dev server. Never set it for an archive: the
// Xcode build phase "Refuse a dev host in Release" stops a Release build that has it.
import { join } from "node:path";

declare const __dirname: string;

const HOSTS = ["*"];
const devHost = process.env.SLIRC_DEV_HOST;
if (devHost !== undefined && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(devHost)) {
  throw new Error("SLIRC_DEV_HOST must be a plain hostname, such as dev.example.net");
}

export const hosts = HOSTS;
export const hostsPath = join(__dirname, "www", "hosts.js");
export const hostsScript =
  `window.SLIRC_HOSTS = ${JSON.stringify(hosts)};\n` + (devHost ? `window.SLIRC_DEV_HOST = ${JSON.stringify(devHost)};\n` : "");
