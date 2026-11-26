import { expect, test } from "bun:test";

// The phone's More tab: three cards near the tab bar (you, the workspace, help).
const read = (name: string) => Bun.file(new URL(`../partials/${name}.html`, import.meta.url)).text();
const markup = await read("mobile-navigation");
const more = markup.split('data-phone-screen="more"')[1] ?? "";
const cards = more.split('<div class="more-card">').slice(1);
const profile = await read("profile-page");

test("More has no section titles, just profile, workspace and help cards", () => {
  expect(more).not.toContain("mobile-section-label");
  expect(cards).toHaveLength(3);
  expect(cards[0]).toContain('x-on:click="openProfile()"');
  expect(cards[0]).toContain("avatarUrl(account)");
  expect(cards[0]).toContain("<small>Profile, devices, sign out</small>");
  for (const opener of ["openWorkspaces()", "openInvitations()", "openAgents()", "openAdmin()"]) expect(cards[1]).toContain(opener);
  expect(cards[1].indexOf("workspace-row-more")).toBeLessThan(cards[1].indexOf("openInvitations()"));
  expect(cards[1]).toMatch(/<a class="mobile-row" href="\/admin" x-show="isAdmin"/);
  expect(cards[1]).toMatch(/<a\s+class="mobile-row"\s+x-show="iphoneAppUrl"/);
});

test("Devices, IRC clients and Sign out live on the phone Profile page, not on More", () => {
  for (const opener of ["openSettings()", "openIrc()", "logout()"]) expect(more).not.toContain(opener);
  const rows = profile.match(/<div class="more-card profile-account-rows" x-show="!isDesktop">.*?<\/div>/s)?.[0] ?? "";
  expect(rows.indexOf("openSettings()")).toBeGreaterThan(-1);
  expect(rows.indexOf("openIrc()")).toBeGreaterThan(rows.indexOf("openSettings()"));
  expect(rows.indexOf("logout()")).toBeGreaterThan(rows.indexOf("openIrc()"));
});

test("Devices and IRC clients go back to Profile on a phone", async () => {
  for (const name of ["settings-page", "irc-page"]) {
    const page = await read(name);
    expect(page).toContain('href="/profile" aria-label="Back to Profile" x-on:click.prevent="openProfile()"');
    expect(page).not.toContain("Back to More");
  }
});

test("help is the last card, with the build as its caption", () => {
  const help = cards[2] ?? "";
  expect(help).toContain('<a class="mobile-row" href="/docs">');
  expect(help).toContain("lucideIcon('info')");
  expect(help).toContain("<strong>Help &amp; docs</strong>");
  expect(help).toContain('<small x-text="aboutLabel">');
  expect(more).not.toContain("more-foot");
  expect(more).not.toMatch(/\bserver\b|\broom\b/i);
});

test("pages opened from More sit above the tab bar through one shared rule, not per-page spacers", async () => {
  for (const name of ["agents-page", "invitations-page", "settings-page", "irc-page", "profile-page", "admin-page"]) {
    const page = await read(name);
    expect(page).toContain("'mobile-screen profile-screen'");
    expect(page).not.toContain("mobile-spacer");
  }
  const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  expect(css).toContain('.profile-screen > .mobile-screen-body::before { content: ""; flex: 1 0 2rem; }');
});
