// Home, DMs and More share one glass head that their lists scroll under.
import { expect, test } from "bun:test";

test("Home, DMs and More heads all use the shared glass tab head", async () => {
  const mobile = await Bun.file(new URL("../partials/mobile-navigation.html", import.meta.url)).text();
  for (const screen of ["home", "dms", "more"]) {
    const markup = mobile.split(`data-phone-screen="${screen}"`)[1]!;
    expect(markup.match(/class="mobile-screen-head[^"]*"/)![0]).toBe('class="mobile-screen-head tab-screen-head"');
  }
  const css = await Bun.file(new URL("../public/style.css", import.meta.url)).text();
  expect(css).toContain(".mobile-screen-head.tab-screen-head { position: absolute;");
  expect(css).toContain(".tab-screen-head + .mobile-screen-body { padding-top:");
  // Blur only, from the one rule every head shares: a darkening or saturating filter shows as a band over the plain page.
  expect(css).toContain(".mobile-screen-head.tab-screen-head { position: absolute; inset: 0 0 auto; }");
  expect(css).toContain("header, .mobile-screen-head { background: transparent; backdrop-filter: var(--head-glass); -webkit-backdrop-filter: var(--head-glass); }");
  expect(css).not.toContain("home-screen-head");
});
