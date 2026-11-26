// Phone pairing by QR, client side. A signed-in desktop shows a one-time offer as a QR code
// (createPhoneOffer); a phone redeems it, either by opening the link from the Camera app
// (landOffer) or by scanning inside the installed app (qr-scanner.ts).

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const REDEEM_FAILED = "That code is no longer valid. Show a new one and scan again.";
const OFFER_HEADERS = { "X-Slirc-Pair": "1" };

// The token of a pair link, or null. A scanned QR code is untrusted input: only a link on this
// exact origin, at /pair, carrying a well-formed token in its fragment counts. Nothing else is
// ever sent anywhere.
export function offerToken(text: unknown, origin: string): string | null {
  if (typeof text !== "string" || !text || text.length > 512) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.origin !== origin || url.pathname !== "/pair" || url.username || url.password) return null;
  const token = new URLSearchParams(url.hash.slice(1)).get("o");
  return token && TOKEN.test(token) ? token : null;
}

// A pair link that belongs to another workspace: https, at /pair, with a well-formed token, on any
// origin but this one. This page never spends it. The scanner names that workspace and offers to
// open the link there, where the token belongs.
export function otherWorkspacePairLink(text: unknown, origin: string): string | null {
  if (typeof text !== "string" || !text || text.length > 512) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== "https:" || url.origin === origin || url.pathname !== "/pair" || url.username || url.password || url.port) return null;
  const token = new URLSearchParams(url.hash.slice(1)).get("o");
  return token && TOKEN.test(token) ? url.href : null;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

// Spends an offer for this browser. Resolves to "" when signed in, otherwise the message to show.
export async function redeemOffer(token: string, fetcher: Fetcher = fetch): Promise<string> {
  try {
    const response = await fetcher("/api/pair/offer/redeem", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...OFFER_HEADERS },
      body: JSON.stringify({ token }),
    });
    if (response.ok) return "";
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    return typeof body.error === "string" && body.error ? body.error : REDEEM_FAILED;
  } catch {
    return "Could not reach Slirc. Check your connection and scan again.";
  }
}

// Opened from a scanned link: /pair#o=<token>. The fragment leaves the address bar and history
// before anything else happens, then the token is spent. Resolves to null when this is not a pair
// link, otherwise "" (signed in) or the message to show.
export async function landOffer(
  place: { href: string; origin: string; pathname: string },
  history: { replaceState(data: unknown, unused: string, url: string): void },
  fetcher: Fetcher = fetch,
): Promise<string | null> {
  if (place.pathname !== "/pair") return null;
  const token = offerToken(place.href, place.origin);
  history.replaceState(null, "", "/");
  return token ? redeemOffer(token, fetcher) : REDEEM_FAILED;
}

// "Add your phone" in the sidebar can be dismissed for good. Kept per account in this browser.
const shortcutKey = (accountId: string) => `slirc:phone-shortcut-dismissed:${accountId}`;
export function phoneShortcutDismissed(accountId: string, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try { return !!accountId && storage?.getItem(shortcutKey(accountId)) === "1"; } catch { return false; }
}
export function dismissPhoneShortcut(accountId: string, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { if (accountId) storage?.setItem(shortcutKey(accountId), "1"); } catch { /* private mode: dismissed for this page only */ }
}

export type PhoneOfferDeps = {
  fetcher?: Fetcher;
  // A phone (iOS or Android) redeemed this card's offer.
  onPhone?: () => void;
  now?: () => number;
  // Resolves false when the page is hidden; the card never mints into a background tab.
  visible?: () => boolean;
};

const MAX_REFRESHES = 5;
const CLOSE_AFTER_MS = 12_000;

// The "Add your phone" card on the desktop Devices page.
export function createPhoneOffer(reactive: <T extends object>(value: T) => T, deps: PhoneOfferDeps = {}) {
  const fetcher: Fetcher = deps.fetcher ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const visible = deps.visible ?? (() => typeof document === "undefined" || !document.hidden);
  let epoch = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshes = 0;
  const local = reactive({
    open: false,
    busy: false,
    url: "",
    id: "",
    expiresAt: 0,
    secondsLeft: 0,
    stale: false,
    error: "",
    device: "",
    signOutBusy: false,
    signedOut: false,
  });

  function clearTimers(): void {
    if (timer !== null) clearInterval(timer);
    if (closeTimer !== null) clearTimeout(closeTimer);
    timer = null; closeTimer = null;
  }

  async function mint(): Promise<void> {
    const current = ++epoch;
    local.busy = true; local.error = ""; local.url = ""; local.id = ""; local.stale = false;
    try {
      const response = await fetcher("/api/pair/offer", { method: "POST", credentials: "same-origin", headers: OFFER_HEADERS });
      const body = (await response.json().catch(() => ({}))) as { id?: unknown; url?: unknown; expiresAt?: unknown; error?: unknown };
      if (current !== epoch) return;
      if (!response.ok || typeof body.url !== "string" || typeof body.id !== "string" || typeof body.expiresAt !== "number") {
        throw new Error(typeof body.error === "string" && body.error ? body.error : "Could not show a code. Try again.");
      }
      local.url = body.url; local.id = body.id; local.expiresAt = body.expiresAt;
      local.secondsLeft = Math.max(0, Math.ceil((body.expiresAt - now()) / 1000));
    } catch (error) {
      if (current !== epoch) return;
      local.error = error instanceof Error ? error.message : "Could not show a code. Try again.";
      local.stale = true;
    } finally {
      if (current === epoch) local.busy = false;
    }
  }

  // Once a second while the card is open: count down, and replace an expired code a few times
  // before asking the person to show it again.
  function tick(): void {
    if (!local.open || local.device || !local.url) return;
    if (!visible()) { close(); return; }
    local.secondsLeft = Math.max(0, Math.ceil((local.expiresAt - now()) / 1000));
    if (now() < local.expiresAt) return;
    local.url = ""; local.id = "";
    if (refreshes < MAX_REFRESHES) { refreshes += 1; void mint(); }
    else local.stale = true;
  }

  async function show(): Promise<void> {
    if (local.open) return;
    if (!visible()) return;
    local.open = true; local.device = ""; local.signedOut = false; local.signOutBusy = false;
    refreshes = 0;
    clearTimers();
    timer = setInterval(tick, 1000);
    await mint();
  }

  async function again(): Promise<void> {
    if (!local.open || local.busy) return;
    refreshes = 0;
    await mint();
  }

  // Dismissed, page hidden, or route left: the unused offer is cancelled, not left to expire.
  function close(): void {
    if (!local.open) return;
    const pending = !!local.url || local.busy;
    epoch += 1;
    clearTimers();
    local.open = false; local.busy = false; local.url = ""; local.id = ""; local.stale = false; local.error = "";
    local.device = ""; local.signedOut = false; local.signOutBusy = false; local.secondsLeft = 0;
    if (pending) void fetcher("/api/pair/offer", { method: "DELETE", credentials: "same-origin", headers: OFFER_HEADERS, keepalive: true }).catch(() => {});
  }

  function toggle(): void {
    if (local.open) close(); else void show();
  }

  // Live event: an offer of this account was redeemed. Only the card that minted it reacts.
  function redeemed(data: unknown): void {
    const event = (data ?? {}) as { id?: unknown; browser?: unknown; os?: unknown };
    if (!local.open || !local.id || event.id !== local.id) return;
    const part = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : fallback;
    epoch += 1;
    local.device = `${part(event.browser, "A browser")} on ${part(event.os, "an unknown system")}`;
    if (event.os === "iOS" || event.os === "Android") deps.onPhone?.();
    local.url = ""; local.busy = false; local.stale = false; local.error = "";
    clearTimers();
    closeTimer = setTimeout(close, CLOSE_AFTER_MS);
  }

  async function signOut(): Promise<void> {
    if (!local.device || !local.id || local.signOutBusy || local.signedOut) return;
    const id = local.id;
    local.signOutBusy = true; local.error = "";
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = null;
    try {
      const response = await fetcher(`/api/pair/offer/${encodeURIComponent(id)}/session`, { method: "DELETE", credentials: "same-origin", headers: OFFER_HEADERS });
      if (local.id !== id) return;
      if (!response.ok && response.status !== 404) throw new Error("failed");
      local.signedOut = true;
      closeTimer = setTimeout(close, 4000);
    } catch {
      if (local.id === id) local.error = "Could not sign it out. Sign it out under Sessions below.";
    } finally {
      if (local.id === id) local.signOutBusy = false;
    }
  }

  return Object.assign(local, { show, again, close, toggle, tick, redeemed, signOut, destroy: close });
}
