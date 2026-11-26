import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRoute, routeUrl } from "@client/navigation.ts";

const root = join(import.meta.dir, "..");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const runtime = readFileSync(join(root, "client/runtime.ts"), "utf8");
const ORIGIN = "https://app.slirc.org";

// The markup between one element's opening tag and the next page wrapper at the same indent.
function page(name: string): string {
  const start = html.indexOf(`<div x-data="${name}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("\n  <div x-data=", start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}

describe("IRC clients tab", () => {
  test("every account tab bar lists You, Devices, People, Agents, IRC, Admin in that order", () => {
    const bars = [...html.matchAll(/<nav class="profile-tabs account-tabs"[^>]*>([\s\S]*?)<\/nav>/g)].map((m) => m[1]);
    expect(bars.length).toBeGreaterThanOrEqual(6);
    for (const bar of bars) {
      expect([...bar.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1])).toEqual(["You", "Devices", "People", "Agents", "IRC", "Admin"]);
      expect(bar).toContain(`<a href="/clients" :class="ircRoute && 'active'" :aria-current="ircRoute ? 'page' : null" x-on:click.prevent="openIrc()">IRC</a>`);
    }
  });

  test("the IRC page is its own screen and Devices no longer carries it", () => {
    const irc = page("ircPage");
    expect(irc).toContain(`data-phone-screen="irc"`);
    expect(irc).toContain(`x-show="authenticated && ircRoute"`);
    for (const part of ["Client guide", "Use a password", "Use a certificate", "irc-device-list", "irc-remove-title"]) expect(irc).toContain(part);
    expect(irc).toContain("authenticated && ircRoute && irc.removeTarget");
    const devices = page("settingsPage");
    expect(devices).toContain("Add your phone");
    expect(devices).toContain("settings-sessions-title");
    expect(devices).not.toContain("irc-settings");
    expect(devices).not.toContain("irc.");
  });

  test("the phone Profile page opens IRC clients from its own row after Devices", () => {
    const devices = html.indexOf(`<a class="mobile-row" href="/settings" x-on:click.prevent="openSettings()">`);
    const irc = html.indexOf(`<a class="mobile-row" href="/clients" x-on:click.prevent="openIrc()">`);
    expect(devices).toBeGreaterThan(-1);
    expect(irc).toBeGreaterThan(devices);
    expect(html).not.toContain("Sessions and IRC clients");
  });

  test("an old /clients link, which used to show Devices, now opens the IRC tab", () => {
    expect(parseRoute("/clients", ORIGIN)).toEqual({ kind: "irc" });
    expect(parseRoute(ORIGIN + "/clients/", ORIGIN)).toEqual({ kind: "irc" });
    expect(routeUrl({ kind: "irc" })).toBe("/clients");
    expect(parseRoute("/settings", ORIGIN)).toEqual({ kind: "settings" });
    // The router sets one page flag per screen: /clients no longer folds into Devices.
    expect(runtime).toContain(`ui.ircRoute = screen.kind === "irc";`);
    expect(runtime).toContain(`ui.settingsRoute = screen.kind === "settings";`);
    expect(runtime).toContain("if (enteringIrc && ui.authenticated) irc.open();");
    expect(runtime).not.toMatch(/devices \? "settings"/);
  });
});
