// The iPhone beta's public TestFlight link, from env TESTFLIGHT_URL. Only an
// https://testflight.apple.com/join/<code> link counts; anything else, or unset, means no link.
export function testflightUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  const ok = url.protocol === "https:" && url.hostname === "testflight.apple.com" && !url.port
    && !url.username && !url.password && !url.search && !url.hash && /^\/join\/[A-Za-z0-9]+$/.test(url.pathname);
  return ok ? url.href : null;
}
